/**
 * runEval.ts — eval de comportamento da Aria contra o modelo REAL.
 *
 * Roda cada conversa-golden (eval/cases.ts) com as tools mockadas e verifica as
 * asserções estruturais. Importa só prompt + schemas + SDK — NÃO sobe banco nem
 * WhatsApp. Precisa apenas de ANTHROPIC_API_KEY (use um .env).
 *
 *   npm run eval
 *
 * Sai com código 1 se alguma asserção `hard` falhar (útil em CI/pré-deploy).
 * Asserções `soft` apenas alertam (o modelo é não-determinístico).
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../src/systemPrompt.js";
import { buildTemporalContext } from "../src/datetime.js";
import { tools } from "../src/toolSchemas.js";
import { cases, type Case, type ToolCall } from "./cases.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("\n✗ Defina ANTHROPIC_API_KEY (ex.: num arquivo .env) para rodar o eval.\n");
  process.exit(2);
}
const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const client = new Anthropic({ apiKey: key });

const system: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT },
  { type: "text", text: buildTemporalContext() },
];

const SEED = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "[Sistema: contato via WhatsApp. Telefone: +5511999999999. Nome no perfil: Cliente Teste.]" }],
};

function mockResult(c: Case, name: string, input: Record<string, unknown>): string {
  const m = c.mocks?.[name];
  const data = typeof m === "function" ? (m as (i: unknown) => unknown)(input) : m ?? [];
  return JSON.stringify({ ok: true, data });
}

async function runCase(c: Case): Promise<{ reply: string; calls: ToolCall[] }> {
  const messages: Anthropic.MessageParam[] = [SEED];
  const calls: ToolCall[] = [];

  for (const turn of c.turns) {
    messages.push({ role: "user", content: [{ type: "text", text: turn }] });
    for (let i = 0; i < 8; i++) {
      const resp = await client.messages.create({ model, max_tokens: 1024, system, tools, messages });
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "tool_use") {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const b of resp.content) {
          if (b.type === "tool_use") {
            calls.push({ name: b.name, input: b.input as Record<string, unknown> });
            results.push({ type: "tool_result", tool_use_id: b.id, content: mockResult(c, b.name, b.input as Record<string, unknown>) });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      break;
    }
  }

  const reply = [...messages].reverse().find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === "text"));
  const text = reply && Array.isArray(reply.content)
    ? reply.content.filter((b) => (b as { type: string }).type === "text").map((b) => (b as { text: string }).text).join("\n")
    : "";
  return { reply: text, calls };
}

async function main() {
  console.log(`\n  Aria · eval de comportamento — modelo ${model}\n  ${"─".repeat(54)}`);
  let hardFail = 0;
  let softFail = 0;

  for (const c of cases) {
    let reply = "", calls: ToolCall[] = [];
    try {
      ({ reply, calls } = await runCase(c));
    } catch (err) {
      console.log(`\n  ■ ${c.name}\n    ✗ ERRO ao executar: ${err instanceof Error ? err.message : err}`);
      hardFail++;
      continue;
    }
    console.log(`\n  ■ ${c.name}`);
    console.log(`    tools: ${calls.map((x) => x.name).join(", ") || "—"}`);
    for (const a of c.asserts) {
      let ok = false;
      try { ok = a.check(reply, calls); } catch { ok = false; }
      if (ok) {
        console.log(`    ✓ ${a.desc}`);
      } else if (a.sev === "hard") {
        hardFail++;
        console.log(`    ✗ [HARD] ${a.desc}`);
      } else {
        softFail++;
        console.log(`    ~ [soft] ${a.desc}`);
      }
    }
    console.log(`    resposta: ${reply.slice(0, 160).replace(/\n/g, " ")}${reply.length > 160 ? "…" : ""}`);
  }

  console.log(`\n  ${"─".repeat(54)}`);
  console.log(`  ${hardFail === 0 ? "✓ PASSOU" : "✗ FALHOU"} · hard fails: ${hardFail} · soft warns: ${softFail}\n`);
  process.exit(hardFail === 0 ? 0 : 1);
}

void main();
