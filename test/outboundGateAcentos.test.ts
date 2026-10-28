import { test } from "node:test";
import assert from "node:assert/strict";
import { outboundGate } from "../src/format.js";

// v23 (27/10): "você" termina em letra acentuada e o `\b` ASCII não fechava depois do "ê" —
// uma confirmação curta em português que fala com o cliente era retida como "anotação".
test("texto curto que fala com o cliente por 'você' não é anotação", () => {
  const r = outboundGate("Pronto. Você não receberá mais lembretes nem convites de avaliação. Seguimos à disposição sempre que precisar — é só nos escrever. Aria · The World Keys");
  assert.equal(r.ok, true, r.ok ? "" : r.motivo);
  assert.equal(outboundGate("Perfeito. Vocês voltarão a receber nossos lembretes. Aria · The World Keys").ok, true);
});

test("texto curto sem saudação nem segunda pessoa continua retido", () => {
  const r = outboundGate("Reserva confirmada para sábado às 20h. Nada mais a fazer.");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.motivo, /parece anotação/);
});
