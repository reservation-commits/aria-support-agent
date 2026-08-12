/**
 * costGuard.ts — teto diário de custo do modelo principal.
 *
 * Sem isso, um cliente dentro do rate limit poderia disparar turnos do modelo
 * mais caro continuamente sem nenhum limite de gasto. Regra: ao atingir o teto
 * diário de tokens (COST_DAILY_TOKEN_BUDGET, dia UTC), a Aria NÃO para — passa
 * a responder com o modelo de fallback (mais barato) até a virada do dia, e o
 * evento aparece no painel. Teto 0 (default) = desligado, comportamento igual
 * ao anterior.
 *
 * O contador vive em memória e é SEMEADO do banco (aria_llm_usage) no boot,
 * então restarts no meio do dia não zeram o gasto já feito.
 */

import { config } from "./config.js";
import { pool } from "./db.js";
import { publish } from "./dashboard/events.js";

let _day = "";
let _tokens = 0;
let _alerted = false;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollover(): void {
  const d = utcDay();
  if (d !== _day) {
    _day = d;
    _tokens = 0;
    _alerted = false;
  }
}

/** Semeia o gasto de hoje a partir do banco (best-effort). Chamar no boot. */
export async function seedCostGuard(): Promise<void> {
  rollover();
  if (config.cost.dailyTokenBudget <= 0) return;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS spent
         FROM aria_llm_usage
        WHERE model = $1
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')`,
      [config.anthropic.model],
    );
    rollover();
    _tokens = Number(rows[0]?.spent ?? 0);
    console.log(`[custo] teto diário ${config.cost.dailyTokenBudget} tokens · já gasto hoje: ${_tokens}`);
  } catch (err) {
    console.warn("[custo] seed falhou (segue contando do zero):", err instanceof Error ? err.message : err);
  }
}

/** Registra tokens gastos num turno do modelo principal. */
export function recordSpend(tokens: number): void {
  rollover();
  _tokens += Math.max(0, tokens);
  const budget = config.cost.dailyTokenBudget;
  if (budget > 0 && _tokens >= budget && !_alerted) {
    _alerted = true;
    const msg =
      `Teto diário de tokens atingido (${_tokens}/${budget}). ` +
      `Degradando para ${config.cost.fallbackModel} até a virada do dia (UTC).`;
    console.warn(`[custo] ${msg}`);
    publish({ kind: "error", where: "custo", message: msg, at: new Date().toISOString() });
  }
}

/** Modelo a usar AGORA: o principal, ou o fallback se o teto do dia estourou. */
export function effectiveModel(): string {
  rollover();
  const budget = config.cost.dailyTokenBudget;
  if (budget > 0 && _tokens >= budget) return config.cost.fallbackModel;
  return config.anthropic.model;
}

/** Estado para o painel (aba Custo & tokens). */
export function costStatus(): { budget: number; spentToday: number; degraded: boolean } {
  rollover();
  const budget = config.cost.dailyTokenBudget;
  return { budget, spentToday: _tokens, degraded: budget > 0 && _tokens >= budget };
}
