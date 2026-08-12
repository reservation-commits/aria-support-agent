/**
 * tester.ts
 *
 * Testa automaticamente todas as funções de leitura do sistema uma vez por dia.
 * Apenas operações seguras e sem efeito colateral (SELECT, sem writes em dados reais).
 * Inclui um check da Anthropic API (1 token) uma vez ao dia.
 *
 * Resultados salvos em aria_test_results e publicados como eventos SSE.
 */

import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { pool, findReservationByCode, searchRestaurants, getCustomerProfile } from "./db.js";
import { publish } from "./dashboard/events.js";

const INTERVAL_MS = 24 * 60 * 60_000; // a cada 24h

type TestDef = { name: string; description: string; fn: () => Promise<void> };

// ─── Definição dos testes ─────────────────────────────────────────────────────

const TESTS: TestDef[] = [
  {
    name: "banco:ping",
    description: "Conectividade básica com PostgreSQL (SELECT 1)",
    fn: async () => { await pool.query("SELECT 1"); },
  },
  {
    name: "banco:reservas_query",
    description: "Query na tabela reservations — código inexistente retorna array vazio sem erro",
    fn: async () => {
      const rows = await findReservationByCode("ARIA-HEALTHTEST-000");
      if (!Array.isArray(rows)) throw new Error("Retorno não é array");
    },
  },
  {
    name: "banco:restaurantes_query",
    description: "Query na tabela db_restaurants com limit 1",
    fn: async () => {
      const rows = await searchRestaurants({ limit: 1 });
      if (!Array.isArray(rows)) throw new Error("Retorno não é array");
    },
  },
  {
    name: "banco:perfil_cliente",
    description: "Query na tabela aria_customer_profiles — número inexistente retorna null sem erro",
    fn: async () => {
      const result = await getCustomerProfile("+00000000000");
      if (result !== null && typeof result !== "object") throw new Error("Retorno inesperado");
    },
  },
  {
    name: "banco:aria_messages",
    description: "Acesso à tabela aria_messages",
    fn: async () => { await pool.query("SELECT COUNT(*)::int FROM public.aria_messages"); },
  },
  {
    name: "banco:aria_tool_calls",
    description: "Acesso à tabela aria_tool_calls",
    fn: async () => { await pool.query("SELECT COUNT(*)::int FROM public.aria_tool_calls"); },
  },
  {
    name: "banco:aria_session_checkpoints",
    description: "Acesso à tabela aria_session_checkpoints",
    fn: async () => { await pool.query("SELECT COUNT(*)::int FROM public.aria_session_checkpoints"); },
  },
  {
    name: "banco:aria_health_checks",
    description: "Acesso à tabela aria_health_checks",
    fn: async () => { await pool.query("SELECT COUNT(*)::int FROM public.aria_health_checks"); },
  },
  {
    name: "banco:aria_customer_profiles",
    description: "Acesso à tabela aria_customer_profiles",
    fn: async () => { await pool.query("SELECT COUNT(*)::int FROM public.aria_customer_profiles"); },
  },
  {
    name: "anthropic:api_reachable",
    description: "Anthropic API acessível e API key válida (1 token, modelo haiku)",
    fn: async () => {
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const res = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "1" }],
      });
      if (!res.id) throw new Error("Resposta sem ID");
    },
  },
];

// ─── Execução ─────────────────────────────────────────────────────────────────

export async function runAllTests(): Promise<{ passed: number; failed: number; total: number }> {
  const runId = randomUUID();
  const runAt = new Date().toISOString();
  let passed = 0;
  let failed = 0;

  const rows: Array<{
    run_id: string; run_at: string; test_name: string; description: string;
    passed: boolean; error_message: string | null; duration_ms: number;
  }> = [];

  for (const test of TESTS) {
    const t0 = Date.now();
    try {
      await test.fn();
      rows.push({ run_id: runId, run_at: runAt, test_name: test.name, description: test.description, passed: true, error_message: null, duration_ms: Date.now() - t0 });
      passed++;
    } catch (err) {
      rows.push({ run_id: runId, run_at: runAt, test_name: test.name, description: test.description, passed: false, error_message: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - t0 });
      failed++;
      console.warn(`[tester] FALHOU: ${test.name} — ${err instanceof Error ? err.message : err}`);
    }
  }

  // Persiste todos os resultados
  try {
    const placeholders = rows.map((_, i) => {
      const base = i * 7;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`;
    }).join(",");
    const values = rows.flatMap(r => [r.run_id, r.run_at, r.test_name, r.description, r.passed, r.error_message, r.duration_ms]);
    await pool.query(
      `INSERT INTO public.aria_test_results
         (run_id, run_at, test_name, description, passed, error_message, duration_ms)
       VALUES ${placeholders}`,
      values,
    );
  } catch (err) {
    console.warn("[tester] falha ao salvar resultados:", err instanceof Error ? err.message : err);
  }

  const total = passed + failed;
  publish({ kind: "test_run", passed, failed, total, at: new Date().toISOString() });
  console.log(`[tester] ${passed}/${total} testes passaram`);

  return { passed, failed, total };
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

export function startTester(): void {
  // Aguarda 30s para que as migrations terminem antes do primeiro run.
  setTimeout(() => {
    void runAllTests();
    setInterval(() => void runAllTests(), INTERVAL_MS).unref();
  }, 30_000);
  console.log("[tester] testes automáticos diários iniciados");
}
