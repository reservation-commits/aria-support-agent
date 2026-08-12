import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { trimHistory, isCleanUserStart } from "../src/historyTrim.js";

type M = Anthropic.MessageParam;

const systemHint: M = {
  role: "user",
  content: [{ type: "text", text: "[Sistema: contato via WhatsApp. Telefone: +5511999999999.]" }],
};

// Gera N rodadas completas com tool calling:
//   user(text) → assistant(tool_use) → user(tool_result) → assistant(text)
function buildConversation(rounds: number): M[] {
  const msgs: M[] = [systemHint];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: [{ type: "text", text: `pergunta ${i}` }] });
    msgs.push({
      role: "assistant",
      content: [{ type: "tool_use", id: `t${i}`, name: "find_x", input: {} }],
    });
    msgs.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }],
    });
    msgs.push({ role: "assistant", content: [{ type: "text", text: `resposta ${i}` }] });
  }
  return msgs;
}

test("não altera histórico abaixo do limite", () => {
  const msgs = buildConversation(1); // 5 mensagens
  const out = trimHistory(msgs, 50);
  assert.equal(out, msgs);
});

test("nunca começa com um tool_result órfão", () => {
  const msgs = buildConversation(20); // 81 mensagens
  for (const max of [4, 5, 6, 7, 10, 15]) {
    const out = trimHistory(msgs, max);
    // primeira mensagem após o head (systemHint) deve ser um início de usuário limpo
    const firstReal = out[0] === systemHint ? out[1] : out[0];
    assert.ok(firstReal, `max=${max}: resultado vazio`);
    assert.ok(
      isCleanUserStart(firstReal),
      `max=${max}: janela começa em mensagem que não é user-limpa`,
    );
    // nenhum tool_result pode aparecer como PRIMEIRO bloco real (órfão)
    assert.notEqual(
      (firstReal.content as Anthropic.ContentBlockParam[])[0].type,
      "tool_result",
      `max=${max}: tool_result órfão no início`,
    );
  }
});

test("preserva o systemHint no topo", () => {
  const msgs = buildConversation(20);
  const out = trimHistory(msgs, 6);
  assert.equal(out[0], systemHint, "systemHint deveria estar preservado no topo");
});

test("respeita aproximadamente o teto de tamanho", () => {
  const msgs = buildConversation(20);
  const out = trimHistory(msgs, 8);
  // head(1) + janela; nunca deve explodir muito além do teto
  assert.ok(out.length <= 8 + 4, `tamanho ${out.length} acima do esperado`);
});

test("toda janela aparada é internamente consistente (tool_use antes de tool_result)", () => {
  const msgs = buildConversation(15);
  const out = trimHistory(msgs, 7);
  const openToolUses = new Set<string>();
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Anthropic.ContentBlockParam[]) {
      if (b.type === "tool_use") openToolUses.add(b.id);
      if (b.type === "tool_result") {
        assert.ok(
          openToolUses.has(b.tool_use_id),
          `tool_result ${b.tool_use_id} sem tool_use correspondente na janela`,
        );
      }
    }
  }
});
