/**
 * monitor.ts
 *
 * Verifica a saúde dos componentes críticos a cada 5 minutos:
 *   • Banco PostgreSQL (ping SELECT 1)
 *   • WhatsApp Graph API (GET /phoneNumberId)
 *
 * O check da Anthropic API é feito pelo tester (diário) para não gerar
 * custo de tokens a cada 5 minutos.
 *
 * Resultados são persistidos em aria_health_checks e publicados como
 * eventos SSE para o painel ao vivo.
 */

import { config } from "./config.js";
import { pool } from "./db.js";
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

async function runHealthCheck(): Promise<void> {
  const [dbRes, waRes] = await Promise.allSettled([checkDB(), checkWhatsApp()]);

  const db = dbRes.status === "fulfilled" ? dbRes.value : { ok: false, latency_ms: null };
  const wa = waRes.status === "fulfilled" ? waRes.value : { ok: false, latency_ms: null };
  const overall_ok = db.ok && wa.ok;

  try {
    await pool.query(
      `INSERT INTO public.aria_health_checks
         (db_ok, db_latency_ms, whatsapp_ok, whatsapp_latency_ms, overall_ok)
       VALUES ($1, $2, $3, $4, $5)`,
      [db.ok, db.latency_ms ?? null, wa.ok, wa.latency_ms ?? null, overall_ok],
    );
  } catch (err) {
    console.warn("[monitor] falha ao salvar health check:", err instanceof Error ? err.message : err);
  }

  publish({
    kind: "health_check",
    overall_ok,
    db_ok: db.ok,
    whatsapp_ok: wa.ok,
    at: new Date().toISOString(),
  });

  if (!overall_ok) {
    console.warn("[monitor] FALHA:", { db: db.ok, whatsapp: wa.ok });
  }
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

export function startMonitor(): void {
  void runHealthCheck(); // imediatamente
  setInterval(() => void runHealthCheck(), INTERVAL_MS).unref();
  console.log("[monitor] saúde monitorada a cada 5 min");
}
