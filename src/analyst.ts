/**
 * analyst.ts
 *
 * Motor de análise autônomo. Coleta métricas reais do banco, passa para o
 * Claude Haiku e gera sugestões de otimização estruturadas. Roda:
 *   • Na startup se não houver sugestões pendentes nos últimos 7 dias
 *   • Automaticamente a cada 7 dias
 *   • Sob demanda via endpoint POST /api/analysis/run
 *
 * Sugestões são salvas em aria_suggestions e exibidas no painel.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { pool } from "./db.js";
import { publish } from "./dashboard/events.js";

const INTERVAL_MS = 7 * 24 * 60 * 60_000; // 7 dias
const ANALYSIS_MODEL = "claude-haiku-4-5";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── Coleta de métricas ───────────────────────────────────────────────────────

async function gatherMetrics(): Promise<string> {
  const [toolStats, toolErrors, healthStats, testStats, msgVolume, profileCount] =
    await Promise.allSettled([
      pool.query(`
        SELECT tool_name,
               COUNT(*)::int                                            AS calls,
               SUM(CASE WHEN NOT success THEN 1 ELSE 0 END)::int       AS failures,
               ROUND(AVG(latency_ms)::numeric,0)::int                  AS avg_ms,
               MAX(latency_ms)::int                                     AS max_ms
          FROM public.aria_tool_calls
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY tool_name
         ORDER BY failures DESC, calls DESC`),

      pool.query(`
        SELECT tool_name, error_message, COUNT(*)::int AS n
          FROM public.aria_tool_calls
         WHERE NOT success AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY tool_name, error_message
         ORDER BY n DESC
         LIMIT 10`),

      pool.query(`
        SELECT overall_ok,
               COUNT(*)::int AS n,
               ROUND(AVG(db_latency_ms)::numeric,0)::int AS avg_db_ms
          FROM public.aria_health_checks
         WHERE checked_at >= NOW() - INTERVAL '7 days'
         GROUP BY overall_ok`),

      pool.query(`
        SELECT passed, COUNT(*)::int AS n, test_name
          FROM public.aria_test_results
         WHERE run_at >= NOW() - INTERVAL '7 days'
         GROUP BY passed, test_name
         ORDER BY passed ASC`),

      pool.query(`
        SELECT direction, COUNT(*)::int AS n
          FROM public.aria_messages
         WHERE created_at >= NOW() - INTERVAL '7 days'
         GROUP BY direction`),

      pool.query(`SELECT COUNT(*)::int AS n FROM public.aria_customer_profiles`),
    ]);

  const safe = <T>(r: PromiseSettledResult<{ rows: T[] }>) =>
    r.status === "fulfilled" ? r.value.rows : [];

  return JSON.stringify({
    tool_stats:     safe(toolStats),
    tool_errors:    safe(toolErrors),
    health_stats:   safe(healthStats),
    test_stats:     safe(testStats),
    msg_volume_7d:  safe(msgVolume),
    customer_profiles_total: safe<{n:number}>(profileCount)[0]?.n ?? 0,
  }, null, 2);
}

// ─── Geração de sugestões ─────────────────────────────────────────────────────

type RawSuggestion = {
  category: "performance" | "reliability" | "ux" | "cost" | "security";
  priority:  "high" | "medium" | "low";
  title:     string;
  description: string;
};

async function generateSuggestions(metrics: string): Promise<RawSuggestion[]> {
  const response = await client.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 1024,
    system:
      "Você é um engenheiro sênior de IA analisando métricas de um agente WhatsApp de luxo " +
      "(Aria, da The World Keys). Com base nos dados fornecidos, gere entre 3 e 6 sugestões " +
      "de otimização acionáveis e específicas. " +
      "Retorne APENAS um array JSON válido, sem markdown, sem texto fora do JSON. " +
      "Formato exato de cada item: " +
      '{"category":"performance|reliability|ux|cost|security","priority":"high|medium|low",' +
      '"title":"título direto em até 8 palavras",' +
      '"description":"2-3 frases: qual é o problema nos dados, o que a sugestão resolve e qual o impacto esperado."}',
    messages: [
      {
        role: "user",
        content: `Métricas dos últimos 7 dias:\n\n${metrics}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Extrai o JSON mesmo que venha com texto ao redor (salvaguarda).
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Resposta não contém JSON array");

  const raw = JSON.parse(match[0]) as RawSuggestion[];
  if (!Array.isArray(raw)) throw new Error("JSON não é array");
  return raw;
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function saveSuggestions(suggestions: RawSuggestion[]): Promise<number> {
  // Busca títulos existentes e pendentes para evitar duplicatas.
  const { rows: existing } = await pool.query(
    `SELECT LOWER(title) AS t FROM public.aria_suggestions WHERE status = 'pending'`,
  );
  const existingTitles = new Set(existing.map((r: { t: string }) => r.t));

  let saved = 0;
  for (const s of suggestions) {
    if (existingTitles.has(s.title.toLowerCase())) continue;

    const validCategories = ["performance", "reliability", "ux", "cost", "security"];
    const validPriorities  = ["high", "medium", "low"];
    const category = validCategories.includes(s.category) ? s.category : "reliability";
    const priority  = validPriorities.includes(s.priority)  ? s.priority  : "medium";

    await pool.query(
      `INSERT INTO public.aria_suggestions (category, priority, title, description)
       VALUES ($1, $2, $3, $4)`,
      [category, priority, s.title.slice(0, 120), s.description.slice(0, 600)],
    );

    publish({
      kind: "suggestion_new",
      title: s.title,
      category,
      priority,
      at: new Date().toISOString(),
    });

    saved++;
  }
  return saved;
}

// ─── Ponto de entrada ─────────────────────────────────────────────────────────

export async function runAnalysis(): Promise<{ saved: number }> {
  console.log("[analyst] iniciando análise de métricas...");
  try {
    const metrics = await gatherMetrics();
    const suggestions = await generateSuggestions(metrics);
    const saved = await saveSuggestions(suggestions);
    console.log(`[analyst] ${saved} sugestão(ões) salva(s)`);
    return { saved };
  } catch (err) {
    console.error("[analyst] falhou:", err instanceof Error ? err.message : err);
    return { saved: 0 };
  }
}

async function shouldRunOnStartup(): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM public.aria_suggestions
        WHERE created_at >= NOW() - INTERVAL '7 days'`,
    );
    return (rows[0]?.n ?? 0) === 0;
  } catch {
    return false;
  }
}

export function startAnalyst(): void {
  setTimeout(async () => {
    if (await shouldRunOnStartup()) {
      await runAnalysis();
    }
    setInterval(() => void runAnalysis(), INTERVAL_MS).unref();
  }, 60_000); // aguarda 60s para as migrations e dados iniciais
  console.log("[analyst] motor de sugestões iniciado (semanal)");
}
