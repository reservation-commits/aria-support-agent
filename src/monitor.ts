/**
 * monitor.ts
 *
 * Verifica a saúde dos componentes críticos a cada 5 minutos:
 *   • Banco PostgreSQL (ping SELECT 1)
 *   • WhatsApp Graph API (GET /phoneNumberId)
 *   • Modelo da Anthropic (1 token no Haiku — v4, depois do apagão de crédito de 18/09)
 *   • Ferramentas quebradas nas últimas 24 h (aria_tool_calls — v5)
 *
 * Resultados são persistidos em aria_health_checks e publicados como
 * eventos SSE para o painel ao vivo.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logEscalation, pool } from "./db.js";
import { publish } from "./dashboard/events.js";

const INTERVAL_MS = 5 * 60_000;

// ─── Checadores individuais ───────────────────────────────────────────────────

async function checkDB(): Promise<{ ok: boolean; latency_ms: number }> {
  const t0 = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch {
    return { ok: false, latency_ms: Date.now() - t0 };
  }
}

async function checkWhatsApp(): Promise<{ ok: boolean; latency_ms: number }> {
  const t0 = Date.now();
  try {
    const url =
      `https://graph.facebook.com/${config.whatsapp.graphVersion}` +
      `/${config.whatsapp.phoneNumberId}` +
      `?fields=id&access_token=${config.whatsapp.accessToken}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    return { ok: res.ok, latency_ms: Date.now() - t0 };
  } catch {
    return { ok: false, latency_ms: Date.now() - t0 };
  }
}

// ─── Ciclo principal ──────────────────────────────────────────────────────────

/**
 * O MODELO agora entra na saúde. Entre 18 e 22/09/2026 a conta da Anthropic ficou sem
 * crédito: a Aria não respondeu ninguém por quatro dias enquanto este monitor gravava
 * 8.646 checagens "100% ok" — porque `anthropic_ok` nunca era medido (ficava NULL) e o
 * teste diário que falhava não alertava ninguém. Uma chamada de 1 token ao Haiku a cada
 * 5 minutos custa fração de centavo por dia; sem crédito ela falha de graça — e é
 * exatamente aí que precisa falhar alto.
 */
async function checkAnthropic(): Promise<{ ok: boolean; latency_ms: number; erro?: string }> {
  const t0 = Date.now();
  try {
    const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 8_000, maxRetries: 0 });
    const res = await client.messages.create({
      model: config.cost.fallbackModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "1" }],
    });
    return { ok: !!res.id, latency_ms: Date.now() - t0 };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    return { ok: false, latency_ms: Date.now() - t0, erro: `${e.status ?? "rede"}: ${String(e.message ?? err).slice(0, 160)}` };
  }
}

let ultimoAlertaModelo = 0;
const ultimoAlertaFerramenta = new Map<string, number>();

/**
 * Ferramenta quebrada = a Aria responde sem o dado e ninguém percebe. Em set/2026 quatro
 * tools falharam em 100% das chamadas por semanas (coluna renomeada, id sem valor) e o
 * único lugar que registrava isso era uma sugestão semanal do analista, num painel que
 * ninguém abria. Regra determinística: ≥3 chamadas em 24 h e metade ou mais falhando →
 * escalação ALTA, uma por ferramenta por dia.
 */
async function checkFerramentasQuebradas(): Promise<void> {
  let rows: Array<{ tool_name: string; calls: number; failures: number; erro: string | null }> = [];
  try {
    ({ rows } = await pool.query(
      `SELECT tool_name,
              COUNT(*)::int AS calls,
              SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int AS failures,
              (ARRAY_AGG(error_message ORDER BY created_at DESC) FILTER (WHERE NOT success))[1] AS erro
         FROM public.aria_tool_calls
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY tool_name
       HAVING COUNT(*) >= 3 AND SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) * 2 >= COUNT(*)`,
    ));
  } catch (err) {
    console.warn("[monitor] leitura de aria_tool_calls falhou:", err instanceof Error ? err.message : err);
    return;
  }
  for (const r of rows) {
    if (Date.now() - (ultimoAlertaFerramenta.get(r.tool_name) ?? 0) < 24 * 3_600_000) continue;
    ultimoAlertaFerramenta.set(r.tool_name, Date.now());
    console.warn(`[monitor] ferramenta quebrada: ${r.tool_name} falhou ${r.failures}/${r.calls} em 24h`);
    await logEscalation({
      tag: "ALTA",
      summary:
        `[monitor] ferramenta ${r.tool_name} falhou ${r.failures} de ${r.calls} vezes nas últimas 24h — ` +
        `a Aria está respondendo SEM esse dado. Último erro: ${String(r.erro ?? "?").slice(0, 160)}`,
      phone: "",
    }).catch(() => {});
  }
}

async function runHealthCheck(): Promise<void> {
  const [dbRes, waRes, aiRes] = await Promise.allSettled([checkDB(), checkWhatsApp(), checkAnthropic()]);

  const db = dbRes.status === "fulfilled" ? dbRes.value : { ok: false, latency_ms: null };
  const wa = waRes.status === "fulfilled" ? waRes.value : { ok: false, latency_ms: null };
  const ai = aiRes.status === "fulfilled" ? aiRes.value : { ok: false, latency_ms: null, erro: "checagem lançou" };
  const overall_ok = db.ok && wa.ok && ai.ok;

  try {
    await pool.query(
      `INSERT INTO public.aria_health_checks
         (db_ok, db_latency_ms, whatsapp_ok, whatsapp_latency_ms, anthropic_ok, overall_ok)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [db.ok, db.latency_ms ?? null, wa.ok, wa.latency_ms ?? null, ai.ok, overall_ok],
    );
  } catch (err) {
    console.warn("[monitor] falha ao salvar health check:", err instanceof Error ? err.message : err);
  }

  publish({
    kind: "health_check",
    overall_ok,
    db_ok: db.ok,
    whatsapp_ok: wa.ok,
    anthropic_ok: ai.ok,
    at: new Date().toISOString(),
  });

  if (!overall_ok) {
    console.warn("[monitor] FALHA:", { db: db.ok, whatsapp: wa.ok, modelo: ai.ok, erro: ai.erro });
  }

  await checkFerramentasQuebradas();

  // Modelo inacessível = a Aria está muda. Escalação URGENTE (dedup 1h) — é o que faltou em 18/09.
  if (!ai.ok && Date.now() - ultimoAlertaModelo > 3_600_000) {
    ultimoAlertaModelo = Date.now();
    await logEscalation({
      tag: "URGENTE",
      summary: `[monitor] modelo da Anthropic inacessível — a Aria NÃO responde a ninguém enquanto isto durar. Erro: ${ai.erro ?? "desconhecido"}. Se for crédito, recarregar em console.anthropic.com.`,
      phone: "",
    }).catch(() => {});
  }
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

export function startMonitor(): void {
  void runHealthCheck(); // imediatamente
  setInterval(() => void runHealthCheck(), INTERVAL_MS).unref();
  console.log("[monitor] saúde monitorada a cada 5 min");
}
