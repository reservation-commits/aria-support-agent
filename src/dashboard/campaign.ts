/**
 * campaign.ts — rastreamento da campanha de fundadores no painel.
 *
 * Três fontes, um retrato:
 *   • ENVIOS: aria_campaign_sends (semeada do ledger oficial; novos lotes
 *     entram via POST /api/campaign/import — upsert por gmail_id).
 *   • CLIQUES: execuções do workflow de redirecionamento no n8n (webhook /go).
 *     Sincronizadas sob demanda (throttle) e PERSISTIDAS em aria_campaign_clicks,
 *     porque o n8n poda execuções antigas — o histórico local é o que dura.
 *   • ATIVAÇÕES: restaurant_users (conta profissional criada = conversão).
 *
 * ABERTURAS não são rastreáveis: os e-mails da campanha saem sem imagens
 * (sem pixel). Clique é a métrica de engajamento; abertura fica indisponível.
 */

import axios from "axios";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { config } from "../config.js";
import { CAMPAIGN_SEED } from "./campaignSeed.js";

// ─── Semeadura (chamada pelas migrações; idempotente) ────────────────────────

export async function seedCampaignSends(client: PoolClient): Promise<void> {
  for (const r of CAMPAIGN_SEED) {
    await client.query(
      `INSERT INTO public.aria_campaign_sends
         (gmail_id, restaurant_id, restaurant_name, campaign, wave, touch_no,
          recipient, language, sent_at, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (gmail_id) DO NOTHING`,
      [r.gmail_id, r.restaurant_id, r.restaurant_name, r.campaign, r.wave,
       r.touch_no, r.recipient, r.language, r.sent_at, r.status, r.note],
    );
  }
}

// ─── Import incremental (novos lotes, sem redeploy) ─────────────────────────

export interface CampaignSendInput {
  gmail_id: string;
  restaurant_id: string;
  restaurant_name: string;
  campaign?: string;
  wave: string;
  touch_no?: number;
  recipient: string;
  language?: string;
  sent_at: string;
  status?: string;
  note?: string;
}

export async function importCampaignSends(rows: CampaignSendInput[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    if (!r.gmail_id || !r.restaurant_id || !r.recipient || !r.sent_at || !r.wave) continue;
    const res = await pool.query(
      `INSERT INTO public.aria_campaign_sends
         (gmail_id, restaurant_id, restaurant_name, campaign, wave, touch_no,
          recipient, language, sent_at, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (gmail_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note`,
      [r.gmail_id, r.restaurant_id, r.restaurant_name ?? "",
       r.campaign ?? "conta_profissional_fundadores_2026_08", r.wave,
       r.touch_no ?? 1, r.recipient, r.language ?? "", r.sent_at,
       r.status ?? "enviado", (r.note ?? "").slice(0, 200)],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

// ─── Sincronização de cliques a partir do n8n ────────────────────────────────

let _lastSync = 0;
const SYNC_MIN_INTERVAL_MS = 120_000;

interface N8nExecMeta { id: string; status?: string; startedAt?: string }

/**
 * Busca execuções do workflow de clique e grava as inéditas.
 * Best-effort: sem N8N_API_URL/KEY configurados, retorna sem erro (o painel
 * mostra o aviso de "cliques não configurados").
 */
export async function syncClicksFromN8n(force = false): Promise<{ synced: number; configured: boolean }> {
  const { apiUrl, apiKey, clickWorkflowId } = config.n8nApi;
  if (!apiUrl || !apiKey) return { synced: 0, configured: false };
  const now = Date.now();
  if (!force && now - _lastSync < SYNC_MIN_INTERVAL_MS) return { synced: 0, configured: true };
  _lastSync = now;

  const headers = { "X-N8N-API-KEY": apiKey, accept: "application/json" };
  const list = await axios.get<{ data: N8nExecMeta[] }>(
    `${apiUrl}/api/v1/executions`,
    { headers, params: { workflowId: clickWorkflowId, limit: 250 }, timeout: 15_000 },
  );
  const execs = list.data?.data ?? [];
  if (!execs.length) return { synced: 0, configured: true };

  const { rows: known } = await pool.query<{ execution_id: string }>(
    `SELECT execution_id FROM public.aria_campaign_clicks WHERE execution_id = ANY($1::text[])`,
    [execs.map((e) => e.id)],
  );
  const seen = new Set(known.map((k) => k.execution_id));
  let synced = 0;

  for (const e of execs) {
    if (seen.has(e.id)) continue;
    try {
      const det = await axios.get(`${apiUrl}/api/v1/executions/${e.id}`, {
        headers, params: { includeData: "true" }, timeout: 15_000,
      });
      const runData = det.data?.data?.resultData?.runData ?? {};
      let q: { c?: string; rid?: string } | null = null;
      for (const runs of Object.values(runData) as unknown[][]) {
        const json = (runs as { data?: { main?: { json?: { query?: { c?: string; rid?: string } } }[][] } }[])
          ?.[0]?.data?.main?.[0]?.[0]?.json;
        if (json?.query?.c && json.query.rid) { q = json.query; break; }
      }
      if (!q) continue; // execução sem clique rastreável (ex.: teste manual sem params)
      await pool.query(
        `INSERT INTO public.aria_campaign_clicks (execution_id, campaign, restaurant_id, clicked_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (execution_id) DO NOTHING`,
        [e.id, q.c, q.rid, e.startedAt ?? new Date().toISOString()],
      );
      synced++;
    } catch (err) {
      console.error(`[campaign] falha ao ler execução ${e.id} do n8n:`, err instanceof Error ? err.message : err);
    }
  }
  return { synced, configured: true };
}

// ─── Visão consolidada ───────────────────────────────────────────────────────

export async function getCampaignOverview(): Promise<unknown> {
  const [kpis, byWave, restaurants, recentClicks] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM public.aria_campaign_sends)                         AS sends,
        (SELECT COUNT(DISTINCT restaurant_id) FROM public.aria_campaign_sends)    AS restaurants,
        (SELECT COUNT(*) FROM public.aria_campaign_sends WHERE status='bounce')   AS bounces,
        (SELECT COUNT(*) FROM public.aria_campaign_clicks WHERE campaign <> 'teste') AS clicks,
        (SELECT COUNT(DISTINCT restaurant_id) FROM public.aria_campaign_clicks WHERE campaign <> 'teste') AS clickers,
        (SELECT MAX(clicked_at) FROM public.aria_campaign_clicks WHERE campaign <> 'teste') AS last_click,
        (SELECT COUNT(DISTINCT s.restaurant_id) FROM public.aria_campaign_sends s
           WHERE EXISTS (SELECT 1 FROM public.restaurant_users ru WHERE ru.restaurant_id = s.restaurant_id)) AS activated
    `),
    pool.query(`
      SELECT wave, COUNT(*) AS sends, MIN(sent_at) AS first_sent, MAX(sent_at) AS last_sent,
             COUNT(*) FILTER (WHERE status='bounce') AS bounces
      FROM public.aria_campaign_sends GROUP BY wave ORDER BY MIN(sent_at), wave
    `),
    pool.query(`
      SELECT s.restaurant_id,
             MAX(s.restaurant_name)                      AS name,
             COUNT(*)                                    AS sends,
             MAX(s.sent_at)                              AS last_sent,
             STRING_AGG(DISTINCT s.wave, ' · ')          AS waves,
             MAX(s.recipient)                            AS recipient,
             BOOL_OR(s.status = 'bounce')                AS bounced,
             COALESCE(k.clicks, 0)                       AS clicks,
             k.last_click,
             EXISTS (SELECT 1 FROM public.restaurant_users ru
                     WHERE ru.restaurant_id = s.restaurant_id) AS activated
      FROM public.aria_campaign_sends s
      LEFT JOIN (
        SELECT restaurant_id, COUNT(*) AS clicks, MAX(clicked_at) AS last_click
        FROM public.aria_campaign_clicks WHERE campaign <> 'teste' GROUP BY restaurant_id
      ) k ON k.restaurant_id = s.restaurant_id
      GROUP BY s.restaurant_id, k.clicks, k.last_click
      ORDER BY (EXISTS (SELECT 1 FROM public.restaurant_users ru
                        WHERE ru.restaurant_id = s.restaurant_id)) DESC,
               COALESCE(k.clicks, 0) DESC, MAX(s.sent_at) DESC
    `),
    pool.query(`
      SELECT c.restaurant_id, c.campaign, c.clicked_at, s.name
      FROM public.aria_campaign_clicks c
      LEFT JOIN (SELECT restaurant_id, MAX(restaurant_name) AS name
                 FROM public.aria_campaign_sends GROUP BY restaurant_id) s
        ON s.restaurant_id = c.restaurant_id
      WHERE c.campaign <> 'teste'
      ORDER BY c.clicked_at DESC LIMIT 20
    `),
  ]);
  return {
    kpis: kpis.rows[0],
    by_wave: byWave.rows,
    restaurants: restaurants.rows,
    recent_clicks: recentClicks.rows,
  };
}
