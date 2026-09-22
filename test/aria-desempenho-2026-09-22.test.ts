import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicOutOfScope } from "../src/scopeGuard.js";
import { compactToolResults, TOOL_RESULT_MAX_CHARS } from "../src/historyTrim.js";

// Regressões da auditoria de desempenho da Aria (2026-09-22).

test("DMARC da Microsoft com prefixo [Preview] cai na camada estrutural (custo zero)", () => {
  // 40 relatórios escaparam para o classificador pago porque o assunto começava com "[Preview] ".
  const r = deterministicOutOfScope({ from: "dmarcreport@microsoft.com", subject: "[Preview] Report Domain: theworldkeys.com Submitter: microsoft.com" });
  assert.ok(r, "deveria bloquear");
  assert.equal(r?.layer, "structural");
});

test("DMARC 'Report-ID:' também é estrutural", () => {
  const r = deterministicOutOfScope({ from: "noreply-dmarc-support@google.com", subject: "Report-ID: 123456789 for theworldkeys.com" });
  assert.equal(r?.layer, "structural");
});

test("assunto legítimo com a palavra 'report' não é bloqueado pela regra nova", () => {
  const r = deterministicOutOfScope({ from: "chef@restaurante.fr", subject: "Report about my reservation tonight" });
  assert.equal(r, null);
});

test("compactToolResults corta só tool_result acima do teto e preserva a estrutura", () => {
  const grande = "x".repeat(TOOL_RESULT_MAX_CHARS + 500);
  const historico = [
    { role: "user" as const, content: "quero uma mesa em Paris" },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "search_restaurants", input: {} }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: grande }, { type: "tool_result" as const, tool_use_id: "t2", content: "curto" }] },
    { role: "assistant" as const, content: "Aqui estão três opções." },
  ];
  const out = compactToolResults(historico);
  assert.equal(out.length, 4, "não perde mensagens");
  assert.equal(out[0], historico[0], "mensagem de texto do usuário intacta (mesma referência)");
  assert.equal(out[1], historico[1], "tool_use intacto");
  const blocos = out[2].content as Array<{ type: string; tool_use_id: string; content: string }>;
  assert.equal(blocos[0].tool_use_id, "t1", "pareamento tool_use/tool_result preservado");
  assert.ok(blocos[0].content.length < grande.length, "grande foi compactado");
  assert.match(blocos[0].content, /compactado no histórico/);
  assert.equal(blocos[1].content, "curto", "pequeno fica igual");
  assert.equal(out[3], historico[3]);
});

test("compactToolResults é idempotente", () => {
  const grande = "y".repeat(TOOL_RESULT_MAX_CHARS * 2);
  const h = [{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t", content: grande }] }];
  const uma = compactToolResults(h);
  const duas = compactToolResults(uma);
  assert.deepEqual(duas, uma);
});
