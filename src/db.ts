import pg from "pg";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { assertReadOnlySql } from "./sqlGuard.js";
import { tzForRestaurant, nowInTz, isOpenNow, type HourRange } from "./tz.js";
import { randomUUID } from "node:crypto";

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

export type CreateReservationInput = {
  bookingDate: string;
  reservationTime: string;
  people: number;
  bookingDetails: string;
  restaurantId: string;
  customerId: string;
};

export async function createReservation(input: CreateReservationInput) {
  const code = generateReservationCode();
  const { rows } = await pool.query(
    `INSERT INTO public.reservations
       (reservation_code, booking_date, reservation_time, people, booking_status,
        booking_details, restaurant_id, customer_id, customer_stage, created_date)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, 'new', NOW())
     RETURNING reservation_id, reservation_code`,
    [
      code,
      input.bookingDate,
      input.reservationTime,
      input.people,
      input.bookingDetails,
      input.restaurantId,
      input.customerId,
    ],
  );
  return rows[0];
}

export type UpdateReservationInput = {
  code: string;
  status?: string;
  bookingDate?: string;
  reservationTime?: string;
  people?: number;
  bookingDetails?: string;
};

export async function updateReservation(input: UpdateReservationInput) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (input.status !== undefined) { sets.push(`booking_status = $${i++}`); values.push(input.status); }
  if (input.bookingDate !== undefined) { sets.push(`booking_date = $${i++}`); values.push(input.bookingDate); }
  if (input.reservationTime !== undefined) { sets.push(`reservation_time = $${i++}`); values.push(input.reservationTime); }
  if (input.people !== undefined) { sets.push(`people = $${i++}`); values.push(input.people); }
  if (input.bookingDetails !== undefined) { sets.push(`booking_details = $${i++}`); values.push(input.bookingDetails); }

  if (sets.length === 0) {
    throw new Error("update_reservation: nothing to update");
  }

  values.push(input.code);
  const { rows } = await pool.query(
    `UPDATE public.reservations
        SET ${sets.join(", ")}
      WHERE reservation_code = $${i}
      RETURNING reservation_id, reservation_code, booking_status, booking_date, reservation_time, people`,
    values,
  );
  return rows[0] ?? null;
}

export async function cancelReservation(code: string) {
  const { rows } = await pool.query(
    `UPDATE public.reservations
        SET booking_status = 'cancelled',
            modified_by = 'aria_whatsapp'
      WHERE reservation_code = $1
      RETURNING reservation_id, reservation_code, booking_status`,
    [code],
  );
  return rows[0] ?? null;
}

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
  await pool.query(
    `INSERT INTO public.update_events
       (created_date, establishment_id, name, representative_actions, reservation_id)
     VALUES (NOW(), $1, $2, $3, $4)`,
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
    `SELECT restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk
       FROM public.db_restaurants
      WHERE ${conditions.join(" AND ")}
      ORDER BY name
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
      `SELECT restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk,
              ts_rank(${ftsDoc}, ${ftsQuery}) AS rank
         FROM public.db_restaurants
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
    `SELECT restaurant_id, name, city, country, slug, price_range_id, site_url, url_page_twk
       FROM public.db_restaurants
      WHERE published = true
        AND ($2::text IS NULL OR city ILIKE $2)
        AND ($3::text IS NULL OR country ILIKE $3)
        AND ($1::text IS NULL OR ${u("name")} ILIKE ${u("$1")}
                              OR ${u("coalesce(about_text,'')")} ILIKE ${u("$1")})
      ORDER BY name ASC
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
       SELECT restaurant_id, name, city, country, slug, address,
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
    `SELECT restaurant_id, name, city, country, slug, address,
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
      `SELECT restaurant_id, name, city, country, slug, address, latitude, longitude,
              telephone_of_the_establishment, email_for_reservations, site_url,
              about_text, url_page_twk
         FROM public.db_restaurants
        WHERE restaurant_id = $1 AND published = true`,
      [restaurantId],
    );
    return rows[0] ?? null;
  } catch (err) {
    // Resiliência a schema diferente (ex.: sem coluna `address`): tenta só o
    // essencial para a reserva (url_page_twk) sem derrubar o fluxo.
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
  restaurant_name: string | null;
  city: string | null;
  booking_date: string | Date;
  reservation_time: string | null;
  people: number | null;
  customer_phone: string | null;
  customer_name: string | null;
};

/**
 * Reservas cujo horário cai dentro da janela [now+windowFromH, now+windowToH],
 * com booking_status em `statuses`, e que ainda não receberam um lembrete do
 * tipo `kind`. Usada pelo scheduler de lembrete (ex: "2h antes", só aceitas).
 */
export async function getReservationsForReminder(
  kind: string,
  windowFromHours: number,
  windowToHours: number,
  statuses: string[] = ["confirmed"],
): Promise<ReminderRow[]> {
  const { rows } = await pool.query(
    `SELECT r.reservation_code, d.name AS restaurant_name, d.city,
            r.booking_date, r.reservation_time, r.people,
            u.phone AS customer_phone, u.name AS customer_name
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       JOIN nextauth."User" u       ON r.customer_id = u.id
       LEFT JOIN public.aria_reminders_sent s
              ON s.reservation_code = r.reservation_code AND s.kind = $1
      WHERE r.booking_status = ANY($4::text[])
        AND u.phone IS NOT NULL
        AND s.id IS NULL
        AND (r.booking_date::timestamp + COALESCE(r.reservation_time, '00:00')::time)
              BETWEEN NOW() + ($2 || ' hours')::interval
                  AND NOW() + ($3 || ' hours')::interval
      ORDER BY r.booking_date ASC
      LIMIT 200`,
    [kind, String(windowFromHours), String(windowToHours), statuses],
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

/**
 * Reservas paradas em aprovação há `hours`+ horas (watchdog PENDENTE_12H).
 * Só reservas cuja data ainda está no futuro e que ainda não geraram escalação
 * automática (dedup via aria_reminders_sent, kind = 'pending_watch').
 */
export async function getStalePendingReservations(
  hours: number,
  status: string,
): Promise<ReminderRow[]> {
  const { rows } = await pool.query(
    `SELECT r.reservation_code, d.name AS restaurant_name, d.city,
            r.booking_date, r.reservation_time, r.people,
            u.phone AS customer_phone, u.name AS customer_name
       FROM public.reservations r
       JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       LEFT JOIN nextauth."User" u  ON r.customer_id = u.id
       LEFT JOIN public.aria_reminders_sent s
              ON s.reservation_code = r.reservation_code AND s.kind = 'pending_watch'
      WHERE r.booking_status = $2
        AND s.id IS NULL
        AND r.created_date < NOW() - ($1 || ' hours')::interval
        AND r.booking_date >= CURRENT_DATE
      ORDER BY r.created_date ASC
      LIMIT 100`,
    [String(hours), status],
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
  await pool
    .query(`DELETE FROM public.aria_pending_emails WHERE created_at < now() - ($1 || ' days')::interval`, [
      String(Math.max(1, maxAgeDays)),
    ])
    .catch(() => {});
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (chat_id) chat_id, payload
       FROM public.aria_pending_emails
      ORDER BY chat_id, created_at DESC`,
  );
  return rows.map((r) => ({ chatId: String(r.chat_id), record: r.payload as PendingEmailRecord }));
}

// ─────────────────────────────────────────────────────────────────────────────

function generateReservationCode(): string {
  // Short opaque code; collision-resistant enough for human use.
  const uuid = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `TWK-${uuid}`;
}
