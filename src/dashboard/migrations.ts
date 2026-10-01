import { pool } from "../db.js";

/**
 * Auto-create the dashboard's auxiliary tables on startup. Idempotent.
 * All tables are prefixed with `aria_` so they never collide with the
 * core TWK schema.
 */
export async function runDashboardMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        push_name TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        wa_message_id TEXT,
        content TEXT,
        has_media BOOLEAN DEFAULT false,
        media_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_messages_chat_idx
        ON public.aria_messages (chat_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_messages_created_idx
        ON public.aria_messages (created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_tool_calls (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT,
        tool_name TEXT NOT NULL,
        input_json JSONB,
        output_summary TEXT,
        success BOOLEAN NOT NULL,
        error_message TEXT,
        latency_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_tool_calls_tool_idx
        ON public.aria_tool_calls (tool_name, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_tool_calls_created_idx
        ON public.aria_tool_calls (created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_customer_profiles (
        id            BIGSERIAL PRIMARY KEY,
        customer_phone TEXT NOT NULL UNIQUE,
        allergies            TEXT[]      NOT NULL DEFAULT '{}',
        dietary_restrictions TEXT[]      NOT NULL DEFAULT '{}',
        cuisine_preferences  TEXT[]      NOT NULL DEFAULT '{}',
        cuisine_dislikes     TEXT[]      NOT NULL DEFAULT '{}',
        price_range          TEXT,
        special_needs        TEXT,
        notes                TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_customer_profiles_phone_idx
        ON public.aria_customer_profiles (customer_phone);
    `);

    // Checkpoints de sessão — permite reconstruir o histórico após restart.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_session_checkpoints (
        chat_id    TEXT PRIMARY KEY,
        messages   JSONB        NOT NULL,
        updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    // Health checks periódicos — DB + WhatsApp a cada 5 min.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_health_checks (
        id                   BIGSERIAL PRIMARY KEY,
        checked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        db_ok                BOOLEAN     NOT NULL,
        db_latency_ms        INTEGER,
        whatsapp_ok          BOOLEAN     NOT NULL,
        whatsapp_latency_ms  INTEGER,
        anthropic_ok         BOOLEAN,
        overall_ok           BOOLEAN     NOT NULL
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_health_checks_at_idx
        ON public.aria_health_checks (checked_at DESC);
    `);

    // Resultados de testes automáticos (diários).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_test_results (
        id            BIGSERIAL PRIMARY KEY,
        run_id        UUID        NOT NULL,
        run_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        test_name     TEXT        NOT NULL,
        description   TEXT,
        passed        BOOLEAN     NOT NULL,
        error_message TEXT,
        duration_ms   INTEGER     NOT NULL
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_test_results_run_idx
        ON public.aria_test_results (run_at DESC, run_id);
    `);

    // Sugestões geradas pelo motor de análise IA.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_suggestions (
        id          BIGSERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        category    TEXT        NOT NULL,
        priority    TEXT        NOT NULL,
        title       TEXT        NOT NULL,
        description TEXT        NOT NULL,
        status      TEXT        NOT NULL DEFAULT 'pending',
        updated_at  TIMESTAMPTZ
      );
    `);

    // Dedup persistida de mensagens recebidas — sobrevive a restart/múltiplas
    // réplicas. Evita resposta duplicada quando a Meta reentrega um webhook.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_processed_messages (
        wa_message_id TEXT PRIMARY KEY,
        processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_processed_messages_at_idx
        ON public.aria_processed_messages (processed_at);
    `);

    // Lembretes proativos enviados — garante envio único por reserva+tipo.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_reminders_sent (
        id               BIGSERIAL PRIMARY KEY,
        reservation_code TEXT        NOT NULL,
        kind             TEXT        NOT NULL,
        phone            TEXT,
        sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (reservation_code, kind)
      );
    `);

    // Escalações para humano — tabela própria (a legada update_events tem schema
    // variável e a gravação falhava em silêncio). Esta é a fonte de verdade do painel.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_escalations (
        id               BIGSERIAL PRIMARY KEY,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tag              TEXT NOT NULL,
        summary          TEXT,
        phone            TEXT,
        reservation_code TEXT,
        status           TEXT NOT NULL DEFAULT 'open'
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_escalations_at_idx
        ON public.aria_escalations (created_at DESC);
    `);

    // Handoff humano persistido — após restart a Aria continua em silêncio nos
    // chats assumidos por um atendente (src/handoff.ts consulta em miss).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_handoffs (
        phone    TEXT PRIMARY KEY,
        operator TEXT,
        until    TIMESTAMPTZ NOT NULL
      );
    `);

    // Consentimento de outbound — opt-out de lembretes/avaliações (WhatsApp/LGPD).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_contact_consent (
        phone              TEXT PRIMARY KEY,
        outbound_opted_out BOOLEAN NOT NULL DEFAULT false,
        source             TEXT,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Opt-in de WhatsApp de reservas (decisão do fundador, 2026-09-25): só recebe quem
    // está marcado. `tipo` = cliente | estabelecimento; `restaurant_id` quando for casa.
    await client.query(`
      ALTER TABLE public.aria_contact_consent
        ADD COLUMN IF NOT EXISTS whatsapp_reservas BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS tipo              TEXT    NOT NULL DEFAULT 'cliente',
        ADD COLUMN IF NOT EXISTS restaurant_id     TEXT,
        ADD COLUMN IF NOT EXISTS motivo            TEXT,
        ADD COLUMN IF NOT EXISTS idioma            TEXT;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_contact_consent_optin_idx
        ON public.aria_contact_consent (whatsapp_reservas) WHERE whatsapp_reservas;
    `);

    // Avaliações de experiência (pós-visita). Guardadas até serem publicadas
    // na página do estabelecimento na plataforma (posted_to_platform).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_experience_reviews (
        id                   BIGSERIAL PRIMARY KEY,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        customer_phone       TEXT,
        reservation_code     TEXT UNIQUE,
        restaurant_id        TEXT,
        platform_rating      INTEGER,
        establishment_rating INTEGER,
        establishment_tags   TEXT[] NOT NULL DEFAULT '{}',
        platform_tags        TEXT[] NOT NULL DEFAULT '{}',
        feedback             TEXT,
        language             TEXT,
        posted_to_platform   BOOLEAN NOT NULL DEFAULT false,
        posted_at            TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_experience_reviews_restaurant_idx
        ON public.aria_experience_reviews (restaurant_id, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_experience_reviews_unposted_idx
        ON public.aria_experience_reviews (posted_to_platform, created_at DESC);
    `);

    // Consumo de tokens da API Anthropic por turno do agente — dá visão de
    // custo por conversa/dia/modelo no painel.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_llm_usage (
        id                    BIGSERIAL PRIMARY KEY,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        chat_id               TEXT,
        model                 TEXT NOT NULL,
        api_calls             INTEGER NOT NULL DEFAULT 1,
        input_tokens          BIGINT  NOT NULL DEFAULT 0,
        output_tokens         BIGINT  NOT NULL DEFAULT 0,
        cache_creation_tokens BIGINT  NOT NULL DEFAULT 0,
        cache_read_tokens     BIGINT  NOT NULL DEFAULT 0
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_llm_usage_at_idx
        ON public.aria_llm_usage (created_at DESC);
    `);

    // Mensagens IGNORADAS por estarem fora de escopo (newsletter, marketing,
    // relatório automático). Registro para o operador auditar e pegar eventual
    // falso positivo — a Aria nunca respondeu a estes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_scope_blocks (
        id         BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        chat_id    TEXT,
        channel    TEXT NOT NULL,
        sender     TEXT,
        subject    TEXT,
        layer      TEXT NOT NULL,
        reason     TEXT,
        snippet    TEXT
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_scope_blocks_at_idx
        ON public.aria_scope_blocks (created_at DESC);
    `);

    // Emails aceitos e ainda não respondidos (modo n8n) — à prova de restart.
    // Inserido ao receber, removido quando o turno completa; no boot os
    // pendentes são reenfileirados. Sem isso, um restart no meio do turno
    // descartava o email em silêncio.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_pending_emails (
        id         BIGSERIAL PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        payload    JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_pending_emails_chat_idx
        ON public.aria_pending_emails (chat_id, created_at DESC);
    `);

    // Metadados de conversa para o inbox do painel: estado do atendimento,
    // operador responsável, notas internas e tags. A conversa em si continua
    // em aria_messages — isto é a camada de workflow por cima.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_conversation_meta (
        chat_id     TEXT PRIMARY KEY,
        status      TEXT NOT NULL DEFAULT 'open',
        assigned_to TEXT,
        notes       TEXT,
        tags        TEXT[] NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Respostas prontas (canned responses) do composer do painel.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_canned_responses (
        id         BIGSERIAL PRIMARY KEY,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Workflow de escalações: responsável, resolução e retorno ao cliente.
    for (const col of [
      "assigned_to TEXT",
      "resolved_at TIMESTAMPTZ",
      "resolved_by TEXT",
      "resolution_note TEXT",
      "chat_id TEXT",
    ]) {
      await client
        .query(`ALTER TABLE public.aria_escalations ADD COLUMN IF NOT EXISTS ${col}`)
        .catch(() => {});
    }

    // Embeddings (descoberta semântica + memória de longo prazo). Tabelas
    // comuns (JSONB) — sem dependência de pgvector; a similaridade roda em
    // memória no processo (src/embeddings.ts).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_restaurant_embeddings (
        restaurant_id TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        embedding     JSONB NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_memory_embeddings (
        id          BIGSERIAL PRIMARY KEY,
        profile_key TEXT NOT NULL,
        note        TEXT NOT NULL,
        embedding   JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_memory_embeddings_key_idx
        ON public.aria_memory_embeddings (profile_key, created_at DESC);
    `);

    // Busca full-text no histórico de mensagens do painel (idioma-agnóstica).
    await client
      .query(`
        CREATE INDEX IF NOT EXISTS aria_messages_fts_idx
          ON public.aria_messages
          USING GIN (to_tsvector('simple', coalesce(content, '')));
      `)
      .catch(() => {});

    // Normalização de acentos na busca textual. Best-effort: se não houver
    // privilégio para criar a extensão, a busca segue sem ela (sem quebrar).
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    } catch {
      console.warn(
        "[dashboard] extensão 'unaccent' indisponível (sem privilégio?) — busca seguirá sem normalização de acentos",
      );
    }

    // ─── Rastreamento da campanha de fundadores ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_campaign_sends (
        id BIGSERIAL PRIMARY KEY,
        gmail_id TEXT NOT NULL UNIQUE,
        restaurant_id TEXT NOT NULL,
        restaurant_name TEXT,
        campaign TEXT NOT NULL,
        wave TEXT NOT NULL,
        touch_no INTEGER NOT NULL DEFAULT 1,
        recipient TEXT NOT NULL,
        language TEXT,
        sent_at DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'enviado',
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_campaign_sends_rest_idx
        ON public.aria_campaign_sends (restaurant_id);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_campaign_clicks (
        id BIGSERIAL PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        campaign TEXT NOT NULL,
        restaurant_id TEXT NOT NULL,
        clicked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_campaign_clicks_rest_idx
        ON public.aria_campaign_clicks (restaurant_id, clicked_at DESC);
    `);
    // ── Log de SAÍDA proativa (lembretes, briefing, avaliação e eventos) ────
    // Sem isto, o desfecho de cada envio só existia no console e num buffer em
    // memória que morre no deploy — e não se avalia um canário com isso.
    // Registra TODO desfecho, inclusive os que não enviaram nada: "não enviei
    // porque o telefone é ambíguo" é o dado mais valioso da fase de canário.
    // Não guarda telefone: a referência é o código da reserva (mesma decisão de
    // minimização de PII tomada em aria_phone_quality).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_outbound_log (
        id                 BIGSERIAL PRIMARY KEY,
        canal              TEXT NOT NULL DEFAULT 'whatsapp',
        origem             TEXT NOT NULL,
        evento             TEXT,
        reservation_code   TEXT,
        desfecho           TEXT NOT NULL,
        motivo             TEXT,
        qualidade_telefone TEXT,
        pais               TEXT,
        locale             TEXT,
        template           TEXT,
        trace_id           TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_outbound_log_created_idx
        ON public.aria_outbound_log (created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_outbound_log_desfecho_idx
        ON public.aria_outbound_log (desfecho, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_outbound_log_reserva_idx
        ON public.aria_outbound_log (reservation_code);
    `);

    // ── v18: rastreio de entrega ──────────────────────────────────────────────
    // "Enviado" é a Cloud API aceitar. Se a casa RECEBEU e LEU vem depois, pelo
    // webhook de status, citando o wamid. Uma linha por template enviado; o status
    // só avança (sent → delivered → read; failed é terminal). Sem telefone.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_delivery_status (
        wa_message_id    TEXT PRIMARY KEY,
        reservation_code TEXT,
        template         TEXT,
        locale           TEXT,
        destinatario     TEXT NOT NULL DEFAULT 'cliente',
        evento           TEXT,
        status           TEXT NOT NULL DEFAULT 'sent',
        error_title      TEXT,
        sent_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status_at        TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_delivery_status_sent_idx
        ON public.aria_delivery_status (sent_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_delivery_status_reserva_idx
        ON public.aria_delivery_status (reservation_code);
    `);

    // ── Fila de replay do WHATSAPP ────────────────────────────────────────────
    // O e-mail tinha fila (aria_pending_emails); o WhatsApp não. Em 19/09/2026 uma
    // mensagem de cliente chegou com o modelo fora do ar (conta sem crédito) e foi
    // perdida para sempre: a Meta já tinha recebido o 200, a fila em memória
    // descartou, ninguém soube. Agora um turno que falha no modelo grava aqui e é
    // reprocessado a cada 10 min pelo mesmo caminho da conversa.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_pending_whatsapp (
        id         BIGSERIAL PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        push_name  TEXT,
        blocks     JSONB NOT NULL,
        tentativas INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_pending_whatsapp_chat_idx
        ON public.aria_pending_whatsapp (chat_id, created_at);
    `);

    // Notas do Juiz de Conversa (juiz.ts): uma linha por resposta enviada, seis critérios
    // do ADR-015 em `notas` (0/1) e a soma em `nota`. Nunca guarda o texto da conversa.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_quality_scores (
        id         BIGSERIAL PRIMARY KEY,
        judged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        message_id BIGINT NOT NULL UNIQUE,
        chat_id    TEXT,
        channel    TEXT,
        model      TEXT,
        notas      JSONB NOT NULL,
        nota       INTEGER NOT NULL,
        motivo     TEXT
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_quality_scores_at_idx
        ON public.aria_quality_scores (judged_at DESC);
    `);

    // Revisão ANTES do envio (revisao.ts): uma linha por tentativa, aprovada ou não.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_prechecks (
        id         BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        chat_id    TEXT,
        channel    TEXT,
        tentativa  INTEGER NOT NULL DEFAULT 1,
        aprovado   BOOLEAN NOT NULL,
        origem     TEXT,
        motivos    JSONB NOT NULL DEFAULT '[]'::jsonb,
        snippet    TEXT
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_prechecks_at_idx
        ON public.aria_prechecks (created_at DESC);
    `);

    // Compromissos de retorno com data (ADR-015): a Aria registra e cumpre (compromissos.ts).
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_commitments (
        id               BIGSERIAL PRIMARY KEY,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        chat_id          TEXT NOT NULL,
        channel          TEXT NOT NULL,
        due_at           DATE NOT NULL,
        o_que            TEXT,
        reservation_code TEXT,
        status           TEXT NOT NULL DEFAULT 'aberto',
        email_ctx        JSONB,
        nudged_at        TIMESTAMPTZ,
        fulfilled_at     TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS aria_commitments_due_idx
        ON public.aria_commitments (status, due_at);
    `);

    // Foto das reservas para o vigia (watcher.ts): último status visto por código.
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.aria_reservation_watch (
        reservation_code TEXT PRIMARY KEY,
        status           TEXT NOT NULL,
        first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_change      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Semeia o histórico do ledger (idempotente; ON CONFLICT DO NOTHING).
    try {
      const { seedCampaignSends } = await import("./campaign.js");
      await seedCampaignSends(client);
    } catch (e) {
      console.warn("[dashboard] seed da campanha falhou (segue sem semear):", e);
    }

    console.log("[dashboard] migrations ok");
  } catch (err) {
    console.error("[dashboard] migration failed:", err);
    throw err;
  } finally {
    client.release();
  }
}
