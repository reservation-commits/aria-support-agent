import { test } from "node:test";
import assert from "node:assert/strict";
import { splitForWhatsApp, clampText, WA_TEXT_MAX } from "../src/waLimits.js";

test("splitForWhatsApp: texto curto passa intacto em uma parte", () => {
  const parts = splitForWhatsApp("olá, tudo bem?");
  assert.deepEqual(parts, ["olá, tudo bem?"]);
});

test("splitForWhatsApp: texto longo é dividido sem parte acima do limite", () => {
  const paragraph = "Uma linha razoavelmente longa sobre restaurantes premium. ".repeat(20).trim();
  const text = Array.from({ length: 8 }, () => paragraph).join("\n\n");
  assert.ok(text.length > WA_TEXT_MAX, "cenário precisa exceder o limite");

  const parts = splitForWhatsApp(text);
  assert.ok(parts.length >= 2, "deveria dividir em 2+ partes");
  for (const p of parts) {
    assert.ok(p.length <= WA_TEXT_MAX, `parte excede o limite (${p.length})`);
    assert.ok(p.trim().length > 0, "nenhuma parte vazia");
  }
  // Nada se perde: o conteúdo reagrupado equivale ao original (modulo espaços de corte).
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
});

test("splitForWhatsApp: prefere cortar em quebra de parágrafo", () => {
  const a = "A".repeat(3000);
  const b = "B".repeat(3000);
  const parts = splitForWhatsApp(`${a}\n\n${b}`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], a);
  assert.equal(parts[1], b);
});

test("clampText: respeita o máximo e adiciona reticências", () => {
  assert.equal(clampText("Le Bernardin", 24), "Le Bernardin");
  const long = "Restaurante Gastronômico Extremamente Sofisticado de Paris";
  const clamped = clampText(long, 24);
  assert.ok(clamped.length <= 24, `estourou o limite: ${clamped.length}`);
  assert.ok(clamped.endsWith("…"));
});

test("clampText: apara espaços antes de medir", () => {
  assert.equal(clampText("  oi  ", 10), "oi");
});
