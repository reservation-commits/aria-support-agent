import { pool } from "../db.js";

export async function getOverview() {
  const [
    { rows: msgsTodayRows },
    { rows: msgs7dRows },
    { rows: convRows },
    { rows: toolRows },
    { rows: latencyRows },
    { rows: reservationsTodayRows },
    { rows: reservationsStatusRows },
    { rows: channelsTodayRows },
  ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS n FROM public.aria_messages
        WHERE created_at >= NOW() - INTERVAL '1 day'`,
    ),
    pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS n
         FROM public.aria_messages
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY day ORDER BY day ASC`,
    ),
    pool.query(
      `SELECT COUNT(DISTINCT chat_id)::int AS n FROM public.aria_messages
        WHERE created_at >= NOW() - INTERVAL '7 days'`,
    ),
    pool.query(
      `SELECT tool_name, COUNT(*)::int AS n,
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS ok,
              ROUND(AVG(latency_ms)::numeric, 0)::int AS avg_ms
         FROM public.aria_tool_calls
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY tool_name
        ORDER BY n DESC
        LIMIT 12`,
    ),
    pool.query(
      `SELECT ROUND(AVG(latency_ms)::numeric, 0)::int AS avg_ms
         FROM public.aria_tool_calls
        WHERE created_at >= NOW() - INTERVAL '1 day'`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM public.reservations
        WHERE created_date >= NOW() - INTERVAL '1 day'`,
    ),
    pool.query(
      `SELECT booking_status AS status, COUNT(*)::int AS n
         FROM public.reservations
        WHERE created_date >= NOW() - INTERVAL '30 days'
        GROUP BY booking_status
        ORDER BY n DESC`,
    ),
    // Tráfego de hoje por canal (WhatsApp × email) e direção — a chave de
    // conversa do canal email é prefixada com 'email:'.
    pool.query(
      `SELECT (chat_id LIKE 'email:%') AS is_email, direction, COUNT(*)::int AS n
         FROM public.aria_messages
        WHERE created_at >= NOW() - INTERVAL '1 day'
        GROUP BY 1, 2`,
    ),
  ]);

  return {
    messages_today: msgsTodayRows[0]?.n ?? 0,
    messages_7d: msgs7dRows,
    active_conversations_7d: convRows[0]?.n ?? 0,
    tool_calls_top: toolRows,
    avg_tool_latency_today_ms: latencyRows[0]?.avg_ms ?? 0,
    reservations_today: reservationsTodayRows[0]?.n ?? 0,
    reservations_by_status_30d: reservationsStatusRows,
    channels_today: channelsTodayRows,
  };
}

export async function listConversations(limit = 50) {
  const { rows } = await pool.query(
    `WITH last AS (
       SELECT chat_id,
              MAX(created_at) AS last_at,
              COUNT(*)::int AS n_msgs,
              MAX(push_name) AS push_name
         FROM public.aria_messages
        GROUP BY chat_id
     )
     SELECT l.chat_id, l.last_at, l.n_msgs, l.push_name,
            (SELECT content FROM public.aria_messages
              WHERE chat_id = l.chat_id ORDER BY created_at DESC LIMIT 1) AS last_content,
            (SELECT direction FROM public.aria_messages
              WHERE chat_id = l.chat_id ORDER BY created_at DESC LIMIT 1) AS last_direction,
            COALESCE(m.status, 'open') AS conv_status,
            m.assigned_to, m.tags, (m.notes IS NOT NULL AND m.notes <> '') AS has_notes
       FROM last l
       LEFT JOIN public.aria_conversation_meta m ON m.chat_id = l.chat_id
      ORDER BY l.last_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

// ─── Inbox: metadados de conversa (status, responsável, notas, tags) ─────────

export async function getConversationMeta(chatId: string) {
  const { rows } = await pool.query(
    `SELECT chat_id, status, assigned_to, notes, tags, updated_at
       FROM public.aria_conversation_meta WHERE chat_id = $1`,
    [chatId],
  );
  return rows[0] ?? { chat_id: chatId, status: "open", assigned_to: null, notes: null, tags: [] };
}

export async function upsertConversationMeta(
  chatId: string,
  patch: { status?: string; assignedTo?: string | null; notes?: string | null; tags?: string[] },
) {
  const { rows } = await pool.query(
    `INSERT INTO public.aria_conversation_meta (chat_id, status, assigned_to, notes, tags, updated_at)
     VALUES ($1, COALESCE($2, 'open'), $3, $4, COALESCE($5, '{}'), NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       status      = COALESCE($2, aria_conversation_meta.status),
       assigned_to = CASE WHEN $6 THEN $3 ELSE aria_conversation_meta.assigned_to END,
       notes       = CASE WHEN $7 THEN $4 ELSE aria_conversation_meta.notes END,
       tags        = COALESCE($5, aria_conversation_meta.tags),
       updated_at  = NOW()
     RETURNING chat_id, status, assigned_to, notes, tags, updated_at`,
    [
      chatId,
      patch.status ?? null,
      patch.assignedTo ?? null,
      patch.notes ?? null,
      patch.tags ?? null,
      patch.assignedTo !== undefined,
      patch.notes !== undefined,
    ],
  );
  return rows[0];
}

// ─── Respostas prontas (canned responses) ────────────────────────────────────

export async function listCannedResponses() {
  const { rows } = await pool.query(
    `SELECT id, title, body, created_by, created_at
       FROM public.aria_canned_responses ORDER BY title ASC`,
  );
  return rows;
}

export async function addCannedResponse(title: string, body: string, createdBy: string) {
  const { rows } = await pool.query(
    `INSERT INTO public.aria_canned_responses (title, body, created_by)
     VALUES ($1, $2, $3) RETURNING id, title, body, created_by, created_at`,
    [title, body, createdBy],
  );
  return rows[0];
}

export async function deleteCannedResponse(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM public.aria_canned_responses WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ─── Busca full-text no histórico de mensagens ───────────────────────────────

export async function searchMessages(q: string, limit = 50) {
  // websearch_to_tsquery entende aspas e negação; fallback ILIKE cobre termos
  // que o parser 'simple' não indexa bem (códigos, emojis de terceiros etc.).
  const { rows } = await pool.query(
    `SELECT id, chat_id, push_name, direction, content, created_at
       FROM public.aria_messages
      WHERE to_tsvector('simple', coalesce(content,'')) @@ websearch_to_tsquery('simple', $1)
         OR content ILIKE '%' || $1 || '%'
      ORDER BY created_at DESC
      LIMIT $2`,
    [q, limit],
  );
  return rows;
}

export async function getConversationMessages(chatId: string, limit = 200) {
  const { rows } = await pool.query(
    `SELECT id, direction, content, has_media, media_type, created_at
       FROM public.aria_messages
      WHERE chat_id = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [chatId, limit],
  );
  return rows;
}

export async function listReservations(params: {
  status?: string;
  limit?: number;
  search?: string;
}) {
  const limit = Math.min(params.limit ?? 100, 500);
  const filters: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (params.status) {
    filters.push(`r.booking_status = $${i++}`);
    values.push(params.status);
  }
  if (params.search) {
    filters.push(
      `(r.reservation_code ILIKE $${i} OR d.name ILIKE $${i} OR u.name ILIKE $${i} OR u.email ILIKE $${i})`,
    );
    values.push(`%${params.search}%`);
    i++;
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT r.reservation_id, r.reservation_code, r.booking_date, r.reservation_time,
            r.people, r.booking_status, r.booking_details, r.created_date,
            d.name AS restaurant_name, d.city, d.country,
            u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM public.reservations r
       LEFT JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
       LEFT JOIN nextauth."User" u ON r.customer_id = u.id
       ${where}
      ORDER BY r.created_date DESC NULLS LAST
      LIMIT $${i}`,
    values,
  );
  return rows;
}

/**
 * Status de reserva que EXISTEM no banco, com contagem. O painel monta os
 * filtros a partir daqui — nunca de valores chumbados (que quebram quando a
 * plataforma usa outra nomenclatura de booking_status).
 */
export async function listReservationStatuses() {
  const { rows } = await pool.query(
    `SELECT booking_status AS status, COUNT(*)::int AS n
       FROM public.reservations
      GROUP BY booking_status
      ORDER BY n DESC`,
  );
  return rows;
}

export async function listEscalations(limit = 50) {
  // Fonte de verdade: tabela própria aria_escalations (a legada update_events
  // tinha schema variável e a gravação falhava em silêncio).
  const { rows } = await pool.query(
    `SELECT id, created_at AS created_date, tag, summary, phone,
            reservation_code AS reservation_id, status,
            assigned_to, resolved_at, resolved_by, resolution_note
       FROM public.aria_escalations
      ORDER BY (status = 'open') DESC, created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getEscalation(id: number) {
  const { rows } = await pool.query(
    `SELECT id, created_at, tag, summary, phone, reservation_code, status,
            assigned_to, resolved_at, resolved_by, resolution_note
       FROM public.aria_escalations WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Workflow de escalação: resolver (com nota), reabrir ou atribuir. */
export async function updateEscalation(
  id: number,
  action: "resolve" | "reopen" | "assign",
  operator: string,
  extra: { note?: string; assignee?: string } = {},
): Promise<boolean> {
  if (action === "resolve") {
    const { rowCount } = await pool.query(
      `UPDATE public.aria_escalations
          SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution_note = $3
        WHERE id = $1`,
      [id, operator, extra.note ?? null],
    );
    return (rowCount ?? 0) > 0;
  }
  if (action === "reopen") {
    const { rowCount } = await pool.query(
      `UPDATE public.aria_escalations
          SET status = 'open', resolved_at = NULL, resolved_by = NULL
        WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
  const { rowCount } = await pool.query(
    `UPDATE public.aria_escalations SET assigned_to = $2 WHERE id = $1`,
    [id, extra.assignee ?? operator],
  );
  return (rowCount ?? 0) > 0;
}

export async function getToolAnalytics(days = 7) {
  const { rows: byTool } = await pool.query(
    `SELECT tool_name,
            COUNT(*)::int AS calls,
            SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS ok,
            SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int AS fail,
            ROUND(AVG(latency_ms)::numeric, 0)::int AS avg_ms,
            MAX(latency_ms)::int AS max_ms,
            MIN(latency_ms)::int AS min_ms
       FROM public.aria_tool_calls
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY tool_name
      ORDER BY calls DESC`,
  );

  const { rows: byDay } = await pool.query(
    `SELECT DATE(created_at AT TIME ZONE 'UTC') AS day,
            COUNT(*)::int AS n
       FROM public.aria_tool_calls
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY day
      ORDER BY day ASC`,
  );

  const { rows: errors } = await pool.query(
    `SELECT tool_name, error_message, created_at
       FROM public.aria_tool_calls
      WHERE NOT success AND created_at >= NOW() - INTERVAL '${days} days'
      ORDER BY created_at DESC
      LIMIT 25`,
  );

  return { by_tool: byTool, by_day: byDay, recent_errors: errors };
}

export async function listRestaurants(limit = 100) {
  const { rows } = await pool.query(
    `SELECT restaurant_id, name, city, country, slug, price_range_id, published,
            (SELECT COUNT(*)::int FROM public.reservations WHERE restaurant_id = d.restaurant_id) AS n_reservations
       FROM public.db_restaurants d
      WHERE published = true
      ORDER BY n_reservations DESC NULLS LAST, name ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

// ─── Saúde ────────────────────────────────────────────────────────────────────

export async function getHealthHistory(limit = 96) {
  const { rows } = await pool.query(
    `SELECT id, checked_at, db_ok, db_latency_ms,
            whatsapp_ok, whatsapp_latency_ms, overall_ok
       FROM public.aria_health_checks
      ORDER BY checked_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getHealthSummary() {
  const { rows: summary24h } = await pool.query(
    `SELECT
       COUNT(*)::int                                          AS total,
       SUM(CASE WHEN overall_ok THEN 1 ELSE 0 END)::int      AS ok,
       ROUND(AVG(db_latency_ms)::numeric, 0)::int            AS avg_db_ms
      FROM public.aria_health_checks
     WHERE checked_at >= NOW() - INTERVAL '24 hours'`,
  );
  const { rows: summary7d } = await pool.query(
    `SELECT
       COUNT(*)::int                                          AS total,
       SUM(CASE WHEN overall_ok THEN 1 ELSE 0 END)::int      AS ok
      FROM public.aria_health_checks
     WHERE checked_at >= NOW() - INTERVAL '7 days'`,
  );
  const r24 = summary24h[0] ?? { total: 0, ok: 0, avg_db_ms: 0 };
  const r7  = summary7d[0]  ?? { total: 0, ok: 0 };
  return {
    uptime_24h_pct: r24.total > 0 ? Math.round((r24.ok / r24.total) * 100) : null,
    uptime_7d_pct:  r7.total  > 0 ? Math.round((r7.ok  / r7.total)  * 100) : null,
    avg_db_latency_ms: r24.avg_db_ms ?? null,
    checks_24h: r24.total,
  };
}

// ─── Testes ───────────────────────────────────────────────────────────────────

export async function getLatestTestRun() {
  const { rows: runRow } = await pool.query(
    `SELECT run_id, run_at FROM public.aria_test_results ORDER BY run_at DESC LIMIT 1`,
  );
  if (!runRow[0]) return { run_at: null, results: [], passed: 0, failed: 0 };

  const { run_id, run_at } = runRow[0] as { run_id: string; run_at: string };
  const { rows: results } = await pool.query(
    `SELECT test_name, description, passed, error_message, duration_ms
       FROM public.aria_test_results
      WHERE run_id = $1
      ORDER BY passed ASC, test_name ASC`,
    [run_id],
  );

  const passed = results.filter((r: { passed: boolean }) => r.passed).length;
  const failed = results.length - passed;
  return { run_at, results, passed, failed };
}

export async function getTestHistory(limit = 30) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (run_id)
            run_id, run_at,
            COUNT(*) OVER (PARTITION BY run_id)::int                                        AS total,
            SUM(CASE WHEN passed THEN 1 ELSE 0 END) OVER (PARTITION BY run_id)::int        AS passed
       FROM public.aria_test_results
      ORDER BY run_id, run_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

// ─── Sugestões ────────────────────────────────────────────────────────────────

export async function listSuggestions(status?: string) {
  const where = status ? `WHERE status = $1` : `WHERE status != 'dismissed'`;
  const values = status ? [status] : [];
  const { rows } = await pool.query(
    `SELECT id, created_at, category, priority, title, description, status, updated_at
       FROM public.aria_suggestions
       ${where}
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC`,
    values,
  );
  return rows;
}

export async function updateSuggestionStatus(
  id: number,
  status: "approved" | "dismissed",
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE public.aria_suggestions
        SET status = $1, updated_at = NOW()
      WHERE id = $2`,
    [status, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function listRecentReminders(limit = 50) {
  const { rows } = await pool.query(
    `SELECT reservation_code, kind, phone, sent_at
       FROM public.aria_reminders_sent
      ORDER BY sent_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countOptedOut(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM public.aria_contact_consent WHERE outbound_opted_out = true`,
  );
  return rows[0]?.n ?? 0;
}

/** v19: números na lista de bloqueio por indisponibilidade (a Meta devolveu "undeliverable"). */
export async function countIndisponiveis(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM public.aria_contact_consent WHERE whatsapp_indisponivel = true`,
  );
  return rows[0]?.n ?? 0;
}

// Mensagens ignoradas por estarem fora de escopo (newsletter/marketing/relatório).
export async function listScopeBlocks(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, created_at, chat_id, channel, sender, subject, layer, reason, snippet
       FROM public.aria_scope_blocks
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countScopeBlocksToday(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM public.aria_scope_blocks
      WHERE created_at >= date_trunc('day', NOW())`,
  );
  return rows[0]?.n ?? 0;
}

export async function listExperienceReviews(limit = 100) {
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, r.customer_phone, r.reservation_code, r.restaurant_id,
            r.platform_rating, r.establishment_rating, r.establishment_tags, r.platform_tags,
            r.feedback, r.language, r.posted_to_platform, r.posted_at,
            d.name AS restaurant_name, d.city
       FROM public.aria_experience_reviews r
       LEFT JOIN public.db_restaurants d ON r.restaurant_id = d.restaurant_id
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getReviewsSummary() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            ROUND(AVG(establishment_rating)::numeric,1) AS avg_establishment,
            ROUND(AVG(platform_rating)::numeric,1)      AS avg_platform,
            SUM(CASE WHEN NOT posted_to_platform THEN 1 ELSE 0 END)::int AS unposted
       FROM public.aria_experience_reviews`,
  );
  return rows[0] ?? { total: 0, avg_establishment: null, avg_platform: null, unposted: 0 };
}

export async function countPendingSuggestions(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM public.aria_suggestions WHERE status = 'pending'`,
  );
  return rows[0]?.n ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function getSystemHealth() {
  // DB latency check + identidade do banco (qual DB o agente REALMENTE usa)
  const t0 = Date.now();
  let dbOk = false;
  let dbLatency = 0;
  let dbCurrent: string | null = null;
  try {
    const { rows } = await pool.query("SELECT current_database() AS db");
    dbOk = true;
    dbLatency = Date.now() - t0;
    dbCurrent = rows[0]?.db ?? null;
  } catch {
    dbOk = false;
  }

  const memory = process.memoryUsage();
  return {
    db: {
      ok: dbOk,
      latency_ms: dbLatency,
      // Confirma a qual banco o agente está conectado (diagnóstico de mismatch).
      host: process.env.PGHOST ?? null,
      database: process.env.PGDATABASE ?? null,
      current_database: dbCurrent,
    },
    process: {
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      heap_used_mb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
      node_version: process.version,
    },
    config: {
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
      graph_version: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
      reply_delay_seconds: Number(process.env.RESPONSE_MIN_DELAY_SECONDS ?? 3),
      whisper_enabled: Boolean(process.env.OPENAI_API_KEY),
      maps_enabled: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      signature_verification: Boolean(process.env.WHATSAPP_APP_SECRET),
    },
  };
}

// ─── Uso de tokens / custo (aria_llm_usage) ──────────────────────────────────

export async function getUsageSummary(days: number) {
  const [{ rows: totals }, { rows: byDay }, { rows: byModel }, { rows: topChats }] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int                       AS turns,
                COALESCE(SUM(api_calls),0)::int     AS api_calls,
                COALESCE(SUM(input_tokens),0)::bigint          AS input_tokens,
                COALESCE(SUM(output_tokens),0)::bigint         AS output_tokens,
                COALESCE(SUM(cache_creation_tokens),0)::bigint AS cache_creation_tokens,
                COALESCE(SUM(cache_read_tokens),0)::bigint     AS cache_read_tokens
           FROM public.aria_llm_usage
          WHERE created_at >= NOW() - ($1 || ' days')::interval`,
        [String(days)],
      ),
      pool.query(
        `SELECT DATE(created_at AT TIME ZONE 'UTC') AS day,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens,
                SUM(cache_read_tokens)::bigint AS cache_read_tokens,
                COUNT(*)::int AS turns
           FROM public.aria_llm_usage
          WHERE created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY day ORDER BY day ASC`,
        [String(days)],
      ),
      pool.query(
        `SELECT model,
                COUNT(*)::int AS turns,
                SUM(input_tokens)::bigint  AS input_tokens,
                SUM(output_tokens)::bigint AS output_tokens
           FROM public.aria_llm_usage
          WHERE created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY model ORDER BY turns DESC`,
        [String(days)],
      ),
      pool.query(
        `SELECT chat_id,
                COUNT(*)::int AS turns,
                SUM(input_tokens + output_tokens)::bigint AS total_tokens
           FROM public.aria_llm_usage
          WHERE created_at >= NOW() - ($1 || ' days')::interval AND chat_id IS NOT NULL
          GROUP BY chat_id ORDER BY total_tokens DESC
          LIMIT 10`,
        [String(days)],
      ),
    ]);

  return { days, totals: totals[0] ?? null, by_day: byDay, by_model: byModel, top_chats: topChats };
}

// ─── Qualidade do catálogo (dados que geram escalação evitável) ──────────────

export async function getCatalogQuality() {
  const [{ rows: counts }, { rows: noLink }, { rows: noHours }, { rows: noAbout }] =
    await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN url_page_twk IS NULL OR url_page_twk = '' THEN 1 ELSE 0 END)::int AS missing_link,
                SUM(CASE WHEN about_text IS NULL OR about_text = '' THEN 1 ELSE 0 END)::int    AS missing_about,
                SUM(CASE WHEN latitude IS NULL OR longitude IS NULL THEN 1 ELSE 0 END)::int    AS missing_coords
           FROM public.db_restaurants WHERE published = true`,
      ),
      pool.query(
        `SELECT restaurant_id, name, city, country,
                (SELECT COUNT(*)::int FROM public.reservations r WHERE r.restaurant_id = d.restaurant_id) AS n_reservations
           FROM public.db_restaurants d
          WHERE published = true AND (url_page_twk IS NULL OR url_page_twk = '')
          ORDER BY n_reservations DESC NULLS LAST, name ASC
          LIMIT 100`,
      ),
      pool.query(
        `SELECT d.restaurant_id, d.name, d.city, d.country
           FROM public.db_restaurants d
          WHERE d.published = true
            AND NOT EXISTS (SELECT 1 FROM public.opening_hours o WHERE o.restaurant_id = d.restaurant_id)
          ORDER BY d.name ASC
          LIMIT 100`,
      ),
      pool.query(
        `SELECT restaurant_id, name, city, country
           FROM public.db_restaurants
          WHERE published = true AND (about_text IS NULL OR about_text = '')
          ORDER BY name ASC
          LIMIT 100`,
      ),
    ]);
  const c = counts[0] ?? { total: 0, missing_link: 0, missing_about: 0, missing_coords: 0 };
  return {
    totals: { ...c, missing_hours: noHours.length },
    missing_link: noLink,
    missing_hours: noHours,
    missing_about: noAbout,
  };
}

// ─── Tendência de satisfação (CSAT) por semana ───────────────────────────────

export async function getReviewsTrend(weeks = 26) {
  const { rows } = await pool.query(
    `SELECT date_trunc('week', created_at)::date AS week,
            COUNT(*)::int AS n,
            ROUND(AVG(establishment_rating)::numeric, 2) AS avg_establishment,
            ROUND(AVG(platform_rating)::numeric, 2)      AS avg_platform
       FROM public.aria_experience_reviews
      WHERE created_at >= NOW() - ($1 || ' weeks')::interval
      GROUP BY week ORDER BY week ASC`,
    [String(weeks)],
  );
  return rows;
}

// ─── Heatmap de volume (dia da semana × hora) ────────────────────────────────

export async function getMessageHeatmap(days = 30) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(DOW  FROM created_at AT TIME ZONE 'UTC')::int AS dow,
            EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour,
            COUNT(*)::int AS n
       FROM public.aria_messages
      WHERE created_at >= NOW() - ($1 || ' days')::interval
        AND direction = 'inbound'
      GROUP BY dow, hour`,
    [String(days)],
  );
  return rows;
}
