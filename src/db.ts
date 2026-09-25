import pg from "pg";
import { decidirEnvioWhatsApp, type DecisaoConsentimento, type LinhaConsentimento } from "./consentRegra.js";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { assertReadOnlySql } from "./sqlGuard.js";
import { tzForRestaurant, nowInTz, isOpenNow, type HourRange } from "./tz.js";

const { Pool } = pg;

export const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  ssl: config.pg.ssl ? { rejectUnauthorized: config.pg.sslRejectUnauthorized } : false,
  // 10 conexões: conversas paralelas + monitor + analyst + reminders competem
  // pelo pool; 5 virava gargalo sob carga real.
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("[pg] idle client error", err);
});

export async function findReservationByCode(code: string) {
  // Be tolerant about code format: customers may send the suffix only
  // ("RGSRQNJ4"), the full code ("TWK-RGSRQNJ4"), with lowercase, with extra
  // spaces, or with similar prefixes. We try exact match first (case-
  // insensitive), then with/without "TWK-", then a final suffix LIKE match.
  const normalized = code.trim().toUpperCase();
  const withoutPrefix = normalized.replace(/^TWK-/, "");
  const withPrefix = `TWK-${withoutPrefix}`;

  const { rows } = await pool.query(
    `SELECT r.reservation_id, r.reservation_code, r.booking_date, r.reservation_time,
            r.people, r.booking_status, r.booking_details, r.customer_stage,
            r.restaurant_id,
            d.name AS restaurant_name, d.city, d.country,
            d.email_for_reservations, d.telephone_of_the_establishment
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
      WHERE UPPER(r.reservation_code) = $1
         OR UPPER(r.reservation_code) = $2
         OR UPPER(r.reservation_code) = $3
         OR UPPER(r.reservation_code) LIKE $4
      ORDER BY r.booking_date DESC NULLS LAST
      LIMIT 5`,
    [normalized, withPrefix, withoutPrefix, `%${withoutPrefix}`],
  );
  return rows;
}

export async function findReservationsByEmail(email: string) {
  const { rows } = await pool.query(
    `SELECT r.reservation_id, r.reservation_code, r.booking_date, r.reservation_time,
            r.people, r.booking_status, r.customer_stage,
            d.name AS restaurant_name, d.city, d.country
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       JOIN nextauth."User" u ON r.customer_id = u.id
      WHERE u.email = $1
      ORDER BY r.booking_date DESC
      LIMIT 25`,
    [email],
  );
  return rows;
}

export async function findReservationsByPhone(phone: string) {
  const { rows } = await pool.query(
    `SELECT r.reservation_id, r.reservation_code, r.booking_date, r.reservation_time,
            r.people, r.booking_status, d.name AS restaurant_name, d.city
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       JOIN nextauth."User" u ON r.customer_id = u.id
      WHERE u.phone = $1
      ORDER BY r.booking_date DESC
      LIMIT 25`,
    [phone],
  );
  return rows;
}

export async function getRestaurantOpeningHours(params: { restaurantId?: string; slug?: string }) {
  if (!params.restaurantId && !params.slug) {
    throw new Error("get_restaurant_opening_hours: informe restaurant_id ou slug");
  }
  const { rows } = await pool.query(
    `SELECT oh.weekday, oh.open_time, oh.close_time, d.name
       FROM public.opening_hours oh
       JOIN public.db_restaurants d ON oh.restaurant_id = d.restaurant_id
      WHERE ($1::text IS NOT NULL AND d.restaurant_id = $1)
         OR ($2::text IS NOT NULL AND d.slug = $2)
      ORDER BY oh.weekday`,
    [params.restaurantId ?? null, params.slug ?? null],
  );
  return rows;
}

export async function getRestaurantInfo(restaurantId: string) {
  const { rows } = await pool.query(
    `SELECT name, city, country, about_text, telephone_of_the_establishment,
            email_for_reservations, price_range_id, site_url
       FROM public.db_restaurants
      WHERE restaurant_id = $1 AND published = true`,
    [restaurantId],
  );
  return rows;
}

// Escrita direta em `reservations` (createReservation / updateReservation /
// cancelReservation) foi REMOVIDA em 2026-09-21. Eram funções sem chamador —
// código morto com poder de escrita numa tabela que, pelo ADR-004, só a
// plataforma altera. A Aria aplica decisões pela API do site
// (platformReservation.ts → POST /api/reservations/manage), nunca por SQL.

export async function findUser(params: { email?: string; phone?: string }) {
  const { rows } = await pool.query(
    `SELECT id, name, email, phone, role
       FROM nextauth."User"
      WHERE ($1::text IS NOT NULL AND email = $1)
         OR ($2::text IS NOT NULL AND phone = $2)
      LIMIT 5`,
    [params.email ?? null, params.phone ?? null],
  );
  return rows;
}

export async function logAttendanceEvent(params: {
  restaurantId: string | null;
  reservationId: string | null;
  description: string;
}) {
  // `update_events.id` é varchar SEM default: sem gerar o id aqui, o INSERT falhava
  // 100% das vezes ("null value in column id") e o registro do atendimento — que o
  // system prompt manda fazer — era perdido em silêncio (auditoria de 2026-09-22:
  // 10 chamadas, 0 sucessos).
  await pool.query(
    `INSERT INTO public.update_events
       (id, created_date, establishment_id, name, representative_actions, reservation_id)
     VALUES ('aria-' || gen_random_uuid()::text, NOW(), $1, $2, $3, $4)`,
    [params.restaurantId, "Atendimento Aria WhatsApp", params.description, params.reservationId],
  );
  return { ok: true };
}

export type SearchReservationsInput = {
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  reservationCode?: string;
  restaurantName?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  limit?: number;
};

export async function searchReservations(input: SearchReservationsInput) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (input.reservationCode) {
    conditions.push(`r.reservation_code ILIKE $${i++}`);
    values.push(`%${input.reservationCode}%`);
  }
  if (input.customerEmail) {
    conditions.push(`u.email ILIKE $${i++}`);
    values.push(`%${input.customerEmail}%`);
  }
  if (input.customerPhone) {
    conditions.push(`u.phone ILIKE $${i++}`);
    values.push(`%${input.customerPhone}%`);
  }
  if (input.customerName) {
    conditions.push(`u.name ILIKE $${i++}`);
    values.push(`%${input.customerName}%`);
  }
  if (input.restaurantName) {
    conditions.push(`d.name ILIKE $${i++}`);
    values.push(`%${input.restaurantName}%`);
  }
  if (input.dateFrom) {
    conditions.push(`r.booking_date >= $${i++}`);
    values.push(input.dateFrom);
  }
  if (input.dateTo) {
    conditions.push(`r.booking_date <= $${i++}`);
    values.push(input.dateTo);
  }
  if (input.status) {
    conditions.push(`r.booking_status = $${i++}`);
    values.push(input.status);
  }

  if (conditions.length === 0) {
    throw new Error("search_reservations: at least one filter is required");
  }

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT r.reservation_id, r.reservation_code, r.booking_date, r.reservation_time,
            r.people, r.booking_status, r.booking_details, r.customer_stage,
            d.restaurant_id, d.name AS restaurant_name, d.city, d.country,
            u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       LEFT JOIN nextauth."User" u ON r.customer_id = u.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.booking_date DESC, r.reservation_time DESC
      LIMIT $${i}`,
    values,
  );
  return rows;
}

export type SearchRestaurantsInput = {
  city?: string;
  country?: string;
  nameQuery?: string;
  cuisine?: string;
  limit?: number;
};

// Histórico de resposta (90 dias), exposto ao modelo em toda busca de restaurante. Em 11/09 a Aria
// ofereceu a um cliente irritado três casas "com disponibilidade imediata" que nunca tinham confirmado
// um único pedido pela plataforma. Critério idêntico ao do Guardião da Reserva: ≥4 pedidos em 90 dias
// e ≥50% aceitos. Aritmética inteira (aceitos*2 >= pedidos): nada de float.
const HISTORICO_90D = `SELECT restaurant_id, count(*)::int AS pedidos_90d,
         count(*) FILTER (WHERE booking_status ILIKE 'accept%')::int AS aceitos_90d
    FROM public.reservations
   WHERE created_date >= now() - interval '90 days'
   GROUP BY 1`;
const CAMPOS_HISTORICO = `coalesce(h.pedidos_90d, 0) AS pedidos_90d, coalesce(h.aceitos_90d, 0) AS aceitos_90d,
       (coalesce(h.pedidos_90d, 0) >= 4 AND coalesce(h.aceitos_90d, 0) * 2 >= coalesce(h.pedidos_90d, 0)) AS confirma_pedidos`;

export async function searchRestaurants(input: SearchRestaurantsInput) {
  const conditions: string[] = ["published = true"];
  const values: unknown[] = [];
  let i = 1;

  if (input.city) {
    conditions.push(`city ILIKE $${i++}`);
    values.push(`%${input.city}%`);
  }
  if (input.country) {
    conditions.push(`country ILIKE $${i++}`);
    values.push(`%${input.country}%`);
  }
  if (input.nameQuery) {
    conditions.push(`name ILIKE $${i++}`);
    values.push(`%${input.nameQuery}%`);
  }
  if (input.cuisine) {
    // Defensive: not all schemas have a cuisine column; fall back to about_text.
    conditions.push(`(about_text ILIKE $${i} OR name ILIKE $${i})`);
    values.push(`%${input.cuisine}%`);
    i++;
  }

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  values.push(limit);

  const { rows } = await pool.query(
    `WITH h AS (${HISTORICO_90D})
     SELECT r.restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk,
            ${CAMPOS_HISTORICO}
       FROM public.db_restaurants r
       LEFT JOIN h ON h.restaurant_id = r.restaurant_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY confirma_pedidos DESC, name
      LIMIT $${i}`,
    values,
  );
  return rows;
}

export type DiscoverRestaurantsInput = {
  query: string;
  city?: string;
  country?: string;
  limit?: number;
};

// Se a extensão `unaccent` estiver disponível, a busca normaliza acentos
// ("São Paulo" casa com "sao paulo"). Detectado uma vez no startup
// (detectUnaccent), com fallback transparente para busca sem normalização.
let _unaccentAvailable = false;

export async function detectUnaccent(): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'unaccent'`,
    );
    _unaccentAvailable = rows.length > 0;
  } catch {
    _unaccentAvailable = false;
  }
  console.log(
    `[db] busca textual ${_unaccentAvailable ? "COM" : "sem"} normalização de acentos (unaccent ${_unaccentAvailable ? "disponível" : "indisponível"})`,
  );
}

/**
 * Descoberta por RELEVÂNCIA usando full-text search nativo do Postgres
 * (websearch_to_tsquery + ts_rank) sobre nome + about_text + cidade + país.
 * Entende consultas em linguagem natural / "vibe" ("lugar romântico com vista",
 * "izakaya animada", "bom para fechar negócio") — não só keyword exata.
 *
 * Não exige nenhuma extensão (config 'simple'); usa `unaccent` automaticamente
 * se disponível. Se o full-text não casar nada, cai para um ILIKE tolerante,
 * para nunca regredir em relação à busca antiga.
 */
export async function discoverRestaurants(input: DiscoverRestaurantsInput) {
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);
  const q = input.query?.trim() ?? "";
  const u = (expr: string) => (_unaccentAvailable ? `unaccent(${expr})` : expr);

  const textExpr =
    `coalesce(name,'') || ' ' || coalesce(about_text,'') || ' ' || ` +
    `coalesce(city,'') || ' ' || coalesce(country,'')`;
  const ftsDoc = `to_tsvector('simple', ${u(textExpr)})`;
  const ftsQuery = `websearch_to_tsquery('simple', ${u("$1")})`;

  if (q) {
    const { rows } = await pool.query(
      `WITH h AS (${HISTORICO_90D})
       SELECT r.restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk,
              ts_rank(${ftsDoc}, ${ftsQuery}) AS rank, ${CAMPOS_HISTORICO}
         FROM public.db_restaurants r
         LEFT JOIN h ON h.restaurant_id = r.restaurant_id
        WHERE published = true
          AND ($2::text IS NULL OR city ILIKE $2)
          AND ($3::text IS NULL OR country ILIKE $3)
          AND ${ftsDoc} @@ ${ftsQuery}
        ORDER BY rank DESC, name ASC
        LIMIT $4`,
      [q, input.city ? `%${input.city}%` : null, input.country ? `%${input.country}%` : null, limit],
    );
    if (rows.length > 0) return rows;
  }

  // Fallback ILIKE (também usado quando query vem vazia — só filtros).
  const { rows } = await pool.query(
    `WITH h AS (${HISTORICO_90D})
     SELECT r.restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk,
            ${CAMPOS_HISTORICO}
       FROM public.db_restaurants r
       LEFT JOIN h ON h.restaurant_id = r.restaurant_id
      WHERE published = true
        AND ($2::text IS NULL OR city ILIKE $2)
        AND ($3::text IS NULL OR country ILIKE $3)
        AND ($1::text IS NULL OR ${u("name")} ILIKE ${u("$1")}
                              OR ${u("coalesce(about_text,'')")} ILIKE ${u("$1")})
      ORDER BY confirma_pedidos DESC, name ASC
      LIMIT $4`,
    [q ? `%${q}%` : null, input.city ? `%${input.city}%` : null, input.country ? `%${input.country}%` : null, limit],
  );
  return rows;
}

export type NearbyRestaurantsInput = {
  latitude: number;
  longitude: number;
  city?: string;
  cuisine?: string;
  maxDistanceKm?: number;
  onlyOpen?: boolean;
  limit?: number;
};

/**
 * Restaurantes ordenados por distância (Haversine) das coordenadas do cliente,
 * já anotados com os HORÁRIOS DE HOJE e um flag `open_now` ("aberto agora").
 *
 * open_now/today_hours são calculados NO FUSO DO PRÓPRIO RESTAURANTE
 * (inferido de país/cidade em tz.ts; fallback: config.localTz) — um bistrô em
 * Paris às 20h locais aparece aberto mesmo com o servidor em São Paulo.
 * opening_hours.weekday segue a convenção do Postgres (0=domingo … 6=sábado).
 * O array today_hours é sempre devolvido para o agente apresentar os horários
 * mesmo quando o open_now não puder ser determinado.
 */
export async function findRestaurantsNear(input: NearbyRestaurantsInput) {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const maxKm = input.maxDistanceKm ?? null;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await queryNearbyWithHours(input, limit);
    annotateOpenNow(rows);
  } catch (err) {
    // Fallback robusto: se a junção de horários falhar (schema diferente etc.),
    // devolve só a proximidade — a Aria NUNCA fica sem resultado por isso.
    console.warn("[findRestaurantsNear] hours join falhou, usando fallback:", err instanceof Error ? err.message : err);
    rows = await queryNearbyBasic(input, limit);
  }

  let out = rows;
  if (maxKm !== null) out = out.filter((r) => Number(r.distance_km) <= maxKm);
  // onlyOpen só filtra quando temos o sinal open_now (no fallback ele vem undefined).
  if (input.onlyOpen && rows.some((r) => r.open_now !== undefined)) {
    out = out.filter((r) => r.open_now === true);
  }
  return out;
}

/**
 * Converte o week_hours agregado (todos os dias) em today_hours + open_now no
 * fuso do restaurante. Mutates rows in place; remove o week_hours do payload.
 */
function annotateOpenNow(rows: Array<Record<string, unknown>>): void {
  for (const r of rows) {
    const week = (r.week_hours ?? []) as Array<{ weekday: number; open: string; close: string }>;
    delete r.week_hours;
    const tz = tzForRestaurant(r.country as string | null, r.city as string | null) ?? config.localTz;
    const now = nowInTz(tz);
    const today: HourRange[] = week
      .filter((h) => Number(h.weekday) === now.weekday && h.open && h.close)
      .map((h) => ({ open: h.open, close: h.close }));
    r.today_hours = today.map((h) => `${h.open}–${h.close}`);
    r.open_now = today.length > 0 ? isOpenNow(today, now.minutes) : false;
  }
}

async function queryNearbyWithHours(input: NearbyRestaurantsInput, limit: number) {
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT restaurant_id, name, city, country, slug, address_of_establishment AS address,
              latitude, longitude, price_range_id, site_url, about_text, url_page_twk,
              (2 * 6371 * asin(sqrt(
                power(sin(radians((latitude::float8 - $1::float8) / 2)), 2) +
                cos(radians($1::float8)) * cos(radians(latitude::float8)) *
                power(sin(radians((longitude::float8 - $2::float8) / 2)), 2)
              ))) AS distance_km
         FROM public.db_restaurants
        WHERE published = true AND latitude IS NOT NULL AND longitude IS NOT NULL
          AND ($3::text IS NULL OR LOWER(city) = LOWER($3))
          AND ($4::text IS NULL OR
               LOWER(COALESCE(about_text, '')) LIKE '%' || LOWER($4) || '%'
               OR LOWER(name) LIKE '%' || LOWER($4) || '%')
        ORDER BY distance_km ASC
        LIMIT $5
     )
     SELECT b.restaurant_id, b.name, b.city, b.country, b.slug, b.address,
            b.latitude, b.longitude, b.price_range_id, b.site_url, b.url_page_twk,
            b.distance_km,
            COALESCE(json_agg(json_build_object(
              'weekday', o.weekday::int,
              'open',    to_char(o.open_time::time,  'HH24:MI'),
              'close',   to_char(o.close_time::time, 'HH24:MI')
            ) ORDER BY o.weekday::int, o.open_time::time)
              FILTER (WHERE o.open_time IS NOT NULL AND o.close_time IS NOT NULL), '[]') AS week_hours
       FROM base b
       LEFT JOIN public.opening_hours o
         ON o.restaurant_id = b.restaurant_id
      GROUP BY b.restaurant_id, b.name, b.city, b.country, b.slug, b.address,
               b.latitude, b.longitude, b.price_range_id, b.site_url, b.url_page_twk, b.distance_km
      ORDER BY b.distance_km ASC`,
    [input.latitude, input.longitude, input.city ?? null, input.cuisine ?? null, limit],
  );
  return rows;
}

async function queryNearbyBasic(input: NearbyRestaurantsInput, limit: number) {
  const { rows } = await pool.query(
    `SELECT restaurant_id, name, city, country, slug, address_of_establishment AS address,
            latitude, longitude, price_range_id, site_url, url_page_twk,
            (2 * 6371 * asin(sqrt(
              power(sin(radians((latitude::float8 - $1::float8) / 2)), 2) +
              cos(radians($1::float8)) * cos(radians(latitude::float8)) *
              power(sin(radians((longitude::float8 - $2::float8) / 2)), 2)
            ))) AS distance_km
       FROM public.db_restaurants
      WHERE published = true AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND ($3::text IS NULL OR LOWER(city) = LOWER($3))
        AND ($4::text IS NULL OR
             LOWER(COALESCE(about_text, '')) LIKE '%' || LOWER($4) || '%'
             OR LOWER(name) LIKE '%' || LOWER($4) || '%')
      ORDER BY distance_km ASC
      LIMIT $5`,
    [input.latitude, input.longitude, input.city ?? null, input.cuisine ?? null, limit],
  );
  return rows;
}

/**
 * Leitura livre do banco para o agente (tool run_sql_read). Blindada:
 *  - valida com assertReadOnlySql (só 1 SELECT/WITH, sem escrita, sem PII);
 *  - roda numa transação READ ONLY com statement_timeout curto;
 *  - limita o número de linhas retornadas.
 * Dá ao agente poder para localizar o que precisar (ex: url_page_twk de um
 * restaurante por nome) sem abrir mão de segurança.
 */
export async function runReadOnlyQuery(sql: string, maxRows = 50): Promise<unknown[]> {
  const safe = assertReadOnlySql(sql);
  const client = await pool.connect();
  try {
    await client.query("START TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await client.query(safe);
    return rows.slice(0, Math.max(1, Math.min(maxRows, 200)));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/**
 * Achar o LINK DE RESERVA (url_page_twk) de um restaurante pelo NOME aproximado.
 * À prova de descasamento de idioma na cidade (cliente diz "Milão", banco tem
 * "Milano"): se o filtro de cidade não casar, refaz a busca só por nome.
 * Resultados com url_page_twk preenchido vêm primeiro.
 */
export async function findBookingLinkByName(name: string, city?: string) {
  const run = async (useCity: boolean) => {
    const { rows } = await pool.query(
      `SELECT restaurant_id, name, city, country, slug, url_page_twk
         FROM public.db_restaurants
        WHERE published = true
          AND name ILIKE '%' || $1 || '%'
          AND ($2::text IS NULL OR city ILIKE '%' || $2 || '%')
        ORDER BY (url_page_twk IS NOT NULL AND url_page_twk <> '') DESC, name ASC
        LIMIT 8`,
      [name, useCity ? city ?? null : null],
    );
    return rows;
  };
  let rows = await run(Boolean(city));
  if (rows.length === 0 && city) rows = await run(false); // retry sem cidade (Milão vs Milano)
  return rows;
}

/**
 * Restaurantes por lista de IDs, preservando a ordem pedida. Usado pela tool
 * de lista interativa (send_restaurant_options) — o servidor resolve nome e
 * cidade direto do banco, nunca do que o modelo digitou.
 */
export async function getRestaurantsByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT restaurant_id, name, city, country, url_page_twk
       FROM public.db_restaurants
      WHERE restaurant_id = ANY($1::text[]) AND published = true
      ORDER BY array_position($1::text[], restaurant_id)
      LIMIT 10`,
    [ids],
  );
  return rows;
}

export async function getRestaurantWithLocation(restaurantId: string) {
  try {
    const { rows } = await pool.query(
      `SELECT restaurant_id, name, city, country, slug, address_of_establishment AS address, latitude, longitude,
              telephone_of_the_establishment, email_for_reservations, site_url,
              about_text, url_page_twk
         FROM public.db_restaurants
        WHERE restaurant_id = $1 AND published = true`,
      [restaurantId],
    );
    return rows[0] ?? null;
  } catch (err) {
    // A coluna real é `address_of_establishment` (corrigido em 2026-09-22: o nome
    // `address` derrubava get_restaurant_location, compute_route e o link de reserva
    // em 100% das chamadas — o fallback abaixo salvava o fluxo, mas sem endereço).
    console.warn("[getRestaurantWithLocation] select completo falhou, usando essencial:", err instanceof Error ? err.message : err);
    const { rows } = await pool.query(
      `SELECT restaurant_id, name, city, country, slug, site_url, url_page_twk
         FROM public.db_restaurants
        WHERE restaurant_id = $1 AND published = true`,
      [restaurantId],
    );
    return rows[0] ?? null;
  }
}

// ─── Session checkpoints ─────────────────────────────────────────────────────
// Persiste o histórico de mensagens no banco para sobreviver a restarts.
// Imagens (base64) são substituídas por placeholder antes de gravar — evita
// inflar o banco com dados binários grandes.

function sanitizeMessagesForStorage(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content)
      ? m.content.map((b) => {
          // Mídia em base64 (imagem ou PDF) é substituída por placeholder antes
          // de gravar — evita inflar o banco com binários grandes.
          const t = (b as { type?: string }).type;
          if (t === "image")
            return { type: "text", text: "[cliente enviou uma imagem]" } as Anthropic.TextBlockParam;
          if (t === "document")
            return { type: "text", text: "[cliente enviou um documento]" } as Anthropic.TextBlockParam;
          return b;
        })
      : m.content,
  }));
}

export async function saveSessionCheckpoint(
  chatId: string,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  const safe = sanitizeMessagesForStorage(messages);
  await pool.query(
    `INSERT INTO public.aria_session_checkpoints (chat_id, messages, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (chat_id) DO UPDATE
       SET messages = $2::jsonb, updated_at = NOW()`,
    [chatId, JSON.stringify(safe)],
  );
}

export async function loadSessionCheckpoint(
  chatId: string,
): Promise<Anthropic.MessageParam[] | null> {
  const { rows } = await pool.query(
    `SELECT messages FROM public.aria_session_checkpoints WHERE chat_id = $1`,
    [chatId],
  );
  if (!rows[0]) return null;
  return rows[0].messages as Anthropic.MessageParam[];
}

export async function deleteSessionCheckpoint(chatId: string): Promise<void> {
  await pool.query(
    `DELETE FROM public.aria_session_checkpoints WHERE chat_id = $1`,
    [chatId],
  );
}

// ─── Customer profiles ───────────────────────────────────────────────────────

export type CustomerProfile = {
  customer_phone: string;
  allergies: string[];
  dietary_restrictions: string[];
  cuisine_preferences: string[];
  cuisine_dislikes: string[];
  price_range: string | null;
  special_needs: string | null;
  notes: string | null;
  updated_at: Date;
};

export async function getCustomerProfile(phone: string): Promise<CustomerProfile | null> {
  const { rows } = await pool.query(
    `SELECT customer_phone, allergies, dietary_restrictions,
            cuisine_preferences, cuisine_dislikes,
            price_range, special_needs, notes, updated_at
       FROM public.aria_customer_profiles
      WHERE customer_phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

export type UpsertProfileInput = {
  customerPhone: string;
  allergies?: string[];
  dietaryRestrictions?: string[];
  cuisinePreferences?: string[];
  cuisineDislikes?: string[];
  priceRange?: string;
  specialNeeds?: string;
  notes?: string;
};

export async function upsertCustomerProfile(input: UpsertProfileInput): Promise<CustomerProfile> {
  // Build SET clause dynamically — only touch supplied fields, always merge arrays.
  const { rows } = await pool.query(
    `INSERT INTO public.aria_customer_profiles
       (customer_phone, allergies, dietary_restrictions,
        cuisine_preferences, cuisine_dislikes,
        price_range, special_needs, notes, updated_at)
     VALUES ($1,
       COALESCE($2::text[], '{}'),
       COALESCE($3::text[], '{}'),
       COALESCE($4::text[], '{}'),
       COALESCE($5::text[], '{}'),
       $6, $7, $8, NOW())
     ON CONFLICT (customer_phone) DO UPDATE SET
       allergies            = array(SELECT DISTINCT unnest(
                                aria_customer_profiles.allergies ||
                                COALESCE($2::text[], '{}'))),
       dietary_restrictions = array(SELECT DISTINCT unnest(
                                aria_customer_profiles.dietary_restrictions ||
                                COALESCE($3::text[], '{}'))),
       cuisine_preferences  = array(SELECT DISTINCT unnest(
                                aria_customer_profiles.cuisine_preferences ||
                                COALESCE($4::text[], '{}'))),
       cuisine_dislikes     = array(SELECT DISTINCT unnest(
                                aria_customer_profiles.cuisine_dislikes ||
                                COALESCE($5::text[], '{}'))),
       price_range   = COALESCE($6, aria_customer_profiles.price_range),
       special_needs = COALESCE($7, aria_customer_profiles.special_needs),
       -- Notes são acumulativas mas COM TETO: mantemos só os últimos ~6000
       -- caracteres (resumos mais recentes). Sem isso, o campo cresceria sem
       -- limite e inflaria custo/contexto a cada conversa.
       notes         = RIGHT(CASE
                         WHEN $8 IS NULL THEN aria_customer_profiles.notes
                         WHEN aria_customer_profiles.notes IS NULL THEN $8
                         ELSE aria_customer_profiles.notes || E'\n' || $8
                       END, 6000),
       updated_at = NOW()
     RETURNING customer_phone, allergies, dietary_restrictions,
               cuisine_preferences, cuisine_dislikes,
               price_range, special_needs, notes, updated_at`,
    [
      input.customerPhone,
      input.allergies ?? null,
      input.dietaryRestrictions ?? null,
      input.cuisinePreferences ?? null,
      input.cuisineDislikes ?? null,
      input.priceRange ?? null,
      input.specialNeeds ?? null,
      input.notes ?? null,
    ],
  );
  return rows[0];
}

// ─── Deduplicação persistida de mensagens ────────────────────────────────────
// O WhatsApp reentrega webhooks (às vezes minutos depois, após um deploy). A
// dedup em memória se perde no restart; esta camada no banco sobrevive a
// restart e a múltiplas réplicas, evitando resposta duplicada.

/**
 * Marca o wa_message_id como processado. Retorna `true` se é NOVO (deve
 * processar), `false` se já tinha sido visto (duplicado → descartar).
 */
export async function markMessageProcessed(waMessageId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO public.aria_processed_messages (wa_message_id)
     VALUES ($1)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [waMessageId],
  );
  return (rowCount ?? 0) > 0;
}

/** Remove registros antigos de dedup (evita crescimento infinito da tabela). */
export async function pruneProcessedMessages(olderThanHours = 48): Promise<void> {
  await pool.query(
    `DELETE FROM public.aria_processed_messages
      WHERE processed_at < NOW() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
}

// ─── Avaliações de experiência (pós-visita) ──────────────────────────────────

export type SaveReviewInput = {
  customerPhone: string;
  reservationCode?: string | null;
  restaurantId?: string | null;
  platformRating?: number | null;
  establishmentRating?: number | null;
  establishmentTags?: string[];
  platformTags?: string[];
  feedback?: string | null;
  language?: string | null;
};

/**
 * Persiste a avaliação da experiência do cliente. Upsert por reservation_code
 * (quando houver) — o cliente pode revisar antes de finalizar. Fica com
 * posted_to_platform=false até ser publicada na página do estabelecimento.
 */
export async function saveExperienceReview(input: SaveReviewInput) {
  const { rows } = await pool.query(
    `INSERT INTO public.aria_experience_reviews
       (customer_phone, reservation_code, restaurant_id,
        platform_rating, establishment_rating,
        establishment_tags, platform_tags, feedback, language, updated_at)
     VALUES ($1,$2,$3,$4,$5,
        COALESCE($6::text[],'{}'), COALESCE($7::text[],'{}'), $8, $9, NOW())
     ON CONFLICT (reservation_code) DO UPDATE SET
        restaurant_id        = COALESCE(EXCLUDED.restaurant_id, aria_experience_reviews.restaurant_id),
        platform_rating      = COALESCE(EXCLUDED.platform_rating, aria_experience_reviews.platform_rating),
        establishment_rating = COALESCE(EXCLUDED.establishment_rating, aria_experience_reviews.establishment_rating),
        establishment_tags   = CASE WHEN array_length(EXCLUDED.establishment_tags,1) IS NULL
                                    THEN aria_experience_reviews.establishment_tags ELSE EXCLUDED.establishment_tags END,
        platform_tags        = CASE WHEN array_length(EXCLUDED.platform_tags,1) IS NULL
                                    THEN aria_experience_reviews.platform_tags ELSE EXCLUDED.platform_tags END,
        feedback             = COALESCE(EXCLUDED.feedback, aria_experience_reviews.feedback),
        language             = COALESCE(EXCLUDED.language, aria_experience_reviews.language),
        updated_at           = NOW()
     RETURNING id, reservation_code, platform_rating, establishment_rating,
               establishment_tags, platform_tags, feedback, posted_to_platform`,
    [
      input.customerPhone,
      input.reservationCode ?? null,
      input.restaurantId ?? null,
      input.platformRating ?? null,
      input.establishmentRating ?? null,
      input.establishmentTags ?? null,
      input.platformTags ?? null,
      input.feedback ?? null,
      input.language ?? null,
    ],
  );
  return rows[0];
}

// ─── Escalações para humano ───────────────────────────────────────────────────

export async function logEscalation(p: {
  tag: string;
  summary: string;
  phone: string;
  reservationCode?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_escalations (tag, summary, phone, reservation_code)
     VALUES ($1, $2, $3, $4)`,
    [p.tag, p.summary, p.phone, p.reservationCode ?? null],
  );
}

// ─── Consentimento de outbound (opt-out de lembretes/avaliações) ──────────────

export async function setOutboundConsent(
  phone: string,
  optedOut: boolean,
  source: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_contact_consent (phone, outbound_opted_out, source, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET outbound_opted_out = $2, source = $3, updated_at = NOW()`,
    [phone, optedOut, source],
  );
}

/** Linha de consentimento do número (E.164), ou null se nunca foi marcado. */
export async function getConsentRow(phone: string): Promise<LinhaConsentimento | null> {
  const { rows } = await pool.query<LinhaConsentimento>(
    `SELECT whatsapp_reservas, outbound_opted_out, tipo, idioma FROM public.aria_contact_consent WHERE phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

/** Regra única de envio de WhatsApp de reservas (opt-in). Erro de banco = não envia. */
export async function podeReceberWhatsAppReservas(phone: string): Promise<DecisaoConsentimento> {
  try {
    return decidirEnvioWhatsApp(await getConsentRow(phone));
  } catch (err) {
    console.warn("[consent] leitura falhou — tratando como sem opt-in:", err instanceof Error ? err.message : err);
    return { ok: false, motivo: "sem_opt_in" };
  }
}

/** Marca (ou desmarca) um número para receber WhatsApp de reservas. Nunca mexe no opt-out do cliente. */
export async function setWhatsAppReservas(p: {
  phone: string;
  ligado: boolean;
  tipo: "cliente" | "estabelecimento";
  restaurantId?: string | null;
  source: string;
  motivo?: string | null;
  idioma?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_contact_consent (phone, whatsapp_reservas, tipo, restaurant_id, source, motivo, idioma, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (phone) DO UPDATE
       SET whatsapp_reservas = EXCLUDED.whatsapp_reservas, tipo = EXCLUDED.tipo,
           restaurant_id = COALESCE(EXCLUDED.restaurant_id, aria_contact_consent.restaurant_id),
           source = EXCLUDED.source, motivo = EXCLUDED.motivo,
           idioma = COALESCE(EXCLUDED.idioma, aria_contact_consent.idioma), updated_at = NOW()`,
    [p.phone, p.ligado, p.tipo, p.restaurantId ?? null, p.source, p.motivo ?? null, p.idioma ?? null],
  );
}

export async function isOptedOut(phone: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM public.aria_contact_consent WHERE phone = $1 AND outbound_opted_out = true`,
    [phone],
  );
  return rows.length > 0;
}

// ─── Lembretes proativos (outbound) ──────────────────────────────────────────

export type ReminderRow = {
  reservation_code: string;
  restaurant_id?: string | null;
  restaurant_name: string | null;
  city: string | null;
  booking_date: string | Date;
  reservation_time: string | null;
  people: number | null;
  customer_phone: string | null;
  customer_name: string | null;
  /** false = o fuso do restaurante não é um nome IANA que o Postgres reconheça. */
  tz_valido?: boolean;
  /** Fuso efetivamente usado para situar a reserva no tempo. */
  tz_usado?: string;
};

/**
 * Normaliza um valor de booking_status para comparação.
 *
 * O banco grava com inicial maiúscula ('Accept', 'Pending', 'Decline',
 * 'Declined (client)', 'In Treatment'); a configuração usa minúsculas. A
 * comparação antiga era `=`, sensível a caixa — o filtro não casava com nada e
 * as varreduras enviavam ZERO em silêncio. A normalização acontece aqui dentro,
 * nos dois lados da comparação, para que nenhum chamador possa errar de novo.
 */
function normalizarStatus(s: string): string {
  return s.trim().toLowerCase();
}

/** Status distintos realmente presentes em `reservations`, normalizados. */
export async function getDistinctBookingStatuses(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT lower(btrim(booking_status)) AS s
       FROM public.reservations
      WHERE coalesce(btrim(booking_status), '') <> ''`,
  );
  return rows.map((r: { s: string }) => r.s);
}

/**
 * Reservas cujo horário cai dentro da janela [now+windowFromH, now+windowToH],
 * com booking_status em `statuses`, e que ainda não receberam um lembrete do
 * tipo `kind`. Usada pelo scheduler de lembrete (ex: "2h antes", só aceitas).
 *
 * FUSO: `booking_date` + `reservation_time` são hora LOCAL do restaurante, sem
 * fuso. O servidor roda em UTC. Comparar os dois direto (o que era feito antes)
 * errava o lembrete pela diferença entre UTC e o fuso da casa — em Paris, 2h,
 * que é exatamente a antecedência do lembrete: ele sairia na hora da reserva.
 * Agora a hora local é situada no fuso do próprio restaurante
 * (`db_restaurants.timezone`, preenchido em 100% dos publicados).
 * O LEFT JOIN em `pg_timezone_names` valida o fuso: nome desconhecido não
 * derruba a consulta (que `AT TIME ZONE` faria), vem marcado em `tz_valido`
 * para o chamador tratar em vez de enviar na hora errada.
 */
export async function getReservationsForReminder(
  kind: string,
  windowFromHours: number,
  windowToHours: number,
  statuses: string[] = ["confirmed"],
): Promise<ReminderRow[]> {
  const { rows } = await pool.query(
    `SELECT r.reservation_code, r.restaurant_id, d.name AS restaurant_name, d.city,
            r.booking_date, r.reservation_time, r.people,
            u.phone AS customer_phone, u.name AS customer_name,
            (z.name IS NOT NULL) AS tz_valido,
            COALESCE(z.name, 'UTC') AS tz_usado
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       JOIN nextauth."User" u       ON r.customer_id = u.id
       LEFT JOIN pg_timezone_names z ON z.name = btrim(d.timezone)
       LEFT JOIN public.aria_reminders_sent s
              ON s.reservation_code = r.reservation_code AND s.kind = $1
      WHERE lower(btrim(r.booking_status)) = ANY($4::text[])
        AND u.phone IS NOT NULL
        AND s.id IS NULL
        AND ((r.booking_date + COALESCE(r.reservation_time, '00:00'::time))
               AT TIME ZONE COALESCE(z.name, 'UTC'))
              BETWEEN NOW() + ($2 || ' hours')::interval
                  AND NOW() + ($3 || ' hours')::interval
      ORDER BY r.booking_date ASC
      LIMIT 200`,
    [kind, String(windowFromHours), String(windowToHours), statuses.map(normalizarStatus)],
  );
  return rows;
}

export async function markReminderSent(
  reservationCode: string,
  kind: string,
  phone: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_reminders_sent (reservation_code, kind, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (reservation_code, kind) DO NOTHING`,
    [reservationCode, kind, phone],
  );
}

export type EventReservationRow = ReminderRow & {
  booking_status: string | null;
  reschedule_proposed_date: string | Date | null;
  reschedule_proposed_time: string | null;
};

/**
 * Uma reserva pelo código, com o que o template precisa. Usada pelo gatilho por
 * EVENTO (o n8n avisa "mudou de status" e a Aria lê aqui os dados) — o webhook
 * recebe apenas referências, nunca dados do cliente.
 */
export async function getReservationForEvent(
  reservationCode: string,
): Promise<EventReservationRow | null> {
  const { rows } = await pool.query(
    `SELECT r.reservation_code, r.restaurant_id, d.name AS restaurant_name, d.city,
            r.booking_date, r.reservation_time, r.people, r.booking_status,
            r.reschedule_proposed_date, r.reschedule_proposed_time,
            u.phone AS customer_phone, u.name AS customer_name,
            (z.name IS NOT NULL) AS tz_valido,
            COALESCE(z.name, 'UTC') AS tz_usado
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       LEFT JOIN nextauth."User" u  ON r.customer_id = u.id
       LEFT JOIN pg_timezone_names z ON z.name = btrim(d.timezone)
      WHERE r.reservation_code = $1
      LIMIT 1`,
    [reservationCode],
  );
  return rows[0] ?? null;
}

/**
 * Reserva o direito de enviar, de forma ATÔMICA (claim antes do envio).
 *
 * Retorna `true` se esta chamada ganhou o direito, `false` se outra já tinha
 * ganhado. O `UNIQUE (reservation_code, kind)` é quem decide, no servidor —
 * dois webhooks simultâneos do n8n para a mesma reserva não viram duas
 * mensagens ao cliente, e isso continua valendo se um dia houver mais de uma
 * réplica da Aria (uma trava em memória não sobreviveria a isso).
 */
export async function reservarEnvio(
  reservationCode: string,
  kind: string,
  phone: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO public.aria_reminders_sent (reservation_code, kind, phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (reservation_code, kind) DO NOTHING
     RETURNING id`,
    [reservationCode, kind, phone],
  );
  return rows.length > 0;
}

/**
 * Devolve o direito de enviar quando o envio FALHOU — sem isso, uma falha
 * transitória da Cloud API queimaria a notificação para sempre.
 * Só remove a própria marca de controle da Aria; não toca em dado de negócio.
 */
export async function liberarEnvio(reservationCode: string, kind: string): Promise<void> {
  await pool.query(
    `DELETE FROM public.aria_reminders_sent WHERE reservation_code = $1 AND kind = $2`,
    [reservationCode, kind],
  );
}

// ─── Fila de replay do WhatsApp (turno que falhou no modelo) ─────────────────

/** Guarda a mensagem cujo turno falhou. Blocos de mídia grandes são reduzidos ao texto. */
export async function savePendingWhatsApp(chatId: string, pushName: string | null, blocks: unknown[]): Promise<void> {
  let payload = blocks;
  if (JSON.stringify(blocks).length > 200_000) {
    payload = blocks.filter((b) => (b as { type?: string })?.type === "text");
    if (payload.length === 0) payload = [{ type: "text", text: "[mídia recebida enquanto o atendimento estava indisponível]" }];
  }
  await pool.query(
    `INSERT INTO public.aria_pending_whatsapp (chat_id, push_name, blocks) VALUES ($1, $2, $3::jsonb)`,
    [chatId, pushName, JSON.stringify(payload)],
  );
}

export type PendingWhatsApp = { id: number; chat_id: string; push_name: string | null; blocks: unknown[]; tentativas: number; created_at: Date };

/** Pendentes com até `maxAgeDays` dias e menos de `maxTentativas` tentativas, mais antigos primeiro. */
export async function loadPendingWhatsApp(maxAgeDays: number, maxTentativas: number): Promise<PendingWhatsApp[]> {
  const { rows } = await pool.query(
    `SELECT id, chat_id, push_name, blocks, tentativas, created_at
       FROM public.aria_pending_whatsapp
      WHERE created_at > NOW() - ($1 || ' days')::interval AND tentativas < $2
      ORDER BY created_at ASC LIMIT 50`,
    [String(maxAgeDays), maxTentativas],
  );
  return rows;
}

/** Reivindica a linha para uma tentativa (remove da fila; se falhar de novo, é regravada com tentativas+1). */
export async function claimPendingWhatsApp(id: number): Promise<PendingWhatsApp | null> {
  const { rows } = await pool.query(
    `DELETE FROM public.aria_pending_whatsapp WHERE id = $1 RETURNING id, chat_id, push_name, blocks, tentativas, created_at`,
    [id],
  );
  return rows[0] ?? null;
}

export async function requeuePendingWhatsApp(p: PendingWhatsApp): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_pending_whatsapp (chat_id, push_name, blocks, tentativas, created_at) VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [p.chat_id, p.push_name, JSON.stringify(p.blocks), p.tentativas + 1, p.created_at],
  );
}

/**
 * Reservas paradas em aprovação há `hours`+ horas (watchdog PENDENTE_12H).
 * Só reservas cuja data ainda está no futuro e que ainda não geraram escalação
 * automática (dedup via aria_reminders_sent, kind = 'pending_watch').
 *
 * Só pendência VIVA: `expired_at IS NULL`. As 13.162 reservas vencidas de
 * 11/2024 a 08/2026 mantiveram o `booking_status = 'Pending'` de propósito
 * (para não quebrar site, n8n e painéis) — sem este filtro o watchdog abriria
 * escalação para todas elas. Comparação de status insensível a caixa: o banco
 * grava 'Pending', a configuração diz 'pending'.
 */
export async function getStalePendingReservations(
  hours: number,
  status: string,
): Promise<ReminderRow[]> {
  const { rows } = await pool.query(
    `SELECT r.reservation_code, r.restaurant_id, d.name AS restaurant_name, d.city,
            r.booking_date, r.reservation_time, r.people,
            u.phone AS customer_phone, u.name AS customer_name
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       LEFT JOIN nextauth."User" u  ON r.customer_id = u.id
       LEFT JOIN public.aria_reminders_sent s
              ON s.reservation_code = r.reservation_code AND s.kind = 'pending_watch'
      WHERE lower(btrim(r.booking_status)) = $2
        AND s.id IS NULL
        AND r.expired_at IS NULL
        AND r.created_date < NOW() - ($1 || ' hours')::interval
        AND r.booking_date >= CURRENT_DATE
      ORDER BY r.created_date ASC
      LIMIT 100`,
    [String(hours), normalizarStatus(status)],
  );
  return rows;
}

// ─── Uso de tokens / custo por turno ─────────────────────────────────────────

export type LlmUsageInput = {
  chatId: string | null;
  model: string;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

/** Persiste o consumo de tokens de um turno do agente (observabilidade de custo). */
export async function recordLlmUsage(u: LlmUsageInput): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_llm_usage
       (chat_id, model, api_calls, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      u.chatId,
      u.model,
      u.apiCalls,
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
    ],
  );
}

// ─── Emails pendentes (à prova de restart) ──────────────────────────────────
// No modo n8n o webhook responde 200 na hora e o turno fica só em memória —
// um restart no meio descartava o email em silêncio. Cada email aceito é
// persistido aqui e removido quando o turno completa; no boot, os pendentes
// são reenfileirados. Payload compacto (texto + contexto de resposta, sem
// anexos) — perder um anexo num restart é aceitável; perder o email, não.

export type PendingEmailRecord = {
  pushName: string | null;
  text: string;
  ctx: Record<string, unknown>; // ReplyContext serializado (emailChannel.ts)
};

export async function savePendingEmail(chatId: string, record: PendingEmailRecord): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_pending_emails (chat_id, payload) VALUES ($1, $2::jsonb)`,
    [chatId, JSON.stringify(record)],
  );
}

export async function clearPendingEmails(chatId: string): Promise<void> {
  await pool.query(`DELETE FROM public.aria_pending_emails WHERE chat_id = $1`, [chatId]);
}

export async function loadPendingEmails(
  maxAgeDays: number,
): Promise<Array<{ chatId: string; record: PendingEmailRecord }>> {
  // Descarta os velhos demais (não responder backlog antigo) e devolve, por
  // conversa, apenas o registro MAIS RECENTE (o contexto de resposta certo).
  // Nada sai da fila em silêncio (ADR-014): o que passou do prazo vira escalação ATRASADO,
  // com a idade e o remetente, para um humano responder — só então é removido.
  try {
    const dias = String(Math.max(1, maxAgeDays));
    const { rows: velhos } = await pool.query(
      `SELECT chat_id, MAX(created_at) AS ultimo, COUNT(*)::int AS n
         FROM public.aria_pending_emails
        WHERE created_at < now() - ($1 || ' days')::interval
        GROUP BY chat_id`,
      [dias],
    );
    for (const v of velhos) {
      const horas = Math.round((Date.now() - new Date(v.ultimo).getTime()) / 3600000);
      await pool
        .query(
          `INSERT INTO public.aria_escalations (tag, summary, phone, reservation_code)
           VALUES ('ATRASADO', $1, $2, NULL)`,
          [`E-mail sem resposta há ${horas}h (${v.n} mensagem(ns)) — a Aria não processou a tempo; responder por humano`, String(v.chat_id)],
        )
        .catch(() => {});
      console.warn(`[email] pendente atrasado escalado (ATRASADO): ${String(v.chat_id).replace(/^(email:.{2})[^@]*/, "$1***")} · ${horas}h`);
    }
    await pool.query(`DELETE FROM public.aria_pending_emails WHERE created_at < now() - ($1 || ' days')::interval`, [dias]);
  } catch {
    /* fila indisponível: replay segue com o que der */
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (chat_id) chat_id, payload
       FROM public.aria_pending_emails
      ORDER BY chat_id, created_at DESC`,
  );
  return rows.map((r) => ({ chatId: String(r.chat_id), record: r.payload as PendingEmailRecord }));
}

// ─────────────────────────────────────────────────────────────────────────────

// generateReservationCode() removida em 2026-09-21 junto com createReservation:
// a Aria não cria reservas — só a plataforma o faz.
