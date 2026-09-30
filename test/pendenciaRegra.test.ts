import test from "node:test";
import assert from "node:assert/strict";
import { montarListaAgenda, consultaMapa, enderecoParaFicha } from "../src/pendenciaRegra.js";

test("agenda: lista das mesas num parâmetro só, sem quebra de linha", () => {
  const s = montarListaAgenda([
    { hora: "19:30", cliente: "Anna Lee", pessoas: "2" },
    { hora: "20:00", cliente: "Marc Dupont", pessoas: "4" },
  ]);
  assert.equal(s, "19:30 Anna Lee (2) · 20:00 Marc Dupont (4)");
  assert.doesNotMatch(s, /[\n\t]/);
});

test("agenda: o que não cabe em 250 vira ' · +N'", () => {
  const mesas = Array.from({ length: 12 }, (_, i) => ({ hora: `2${i % 4}:00`, cliente: `Cliente Número ${i + 1} Sobrenome`, pessoas: String(i + 2) }));
  const s = montarListaAgenda(mesas);
  assert.ok(s.length <= 250, `tamanho ${s.length}`);
  assert.match(s, / · \+\d+$/);
});

test("agenda: nome ausente não quebra a ficha", () => {
  assert.equal(montarListaAgenda([{ hora: "20:00", cliente: "", pessoas: "2" }]), "20:00 — (2)");
  assert.equal(montarListaAgenda([]), "");
});

test("mapa: nome + cidade codificados; nunca o endereço inteiro", () => {
  assert.equal(consultaMapa("Le Tobsil", "Marrakesh"), "Le%20Tobsil%20Marrakesh");
  assert.equal(consultaMapa("  Casa do  Prego ", null), "Casa%20do%20Prego");
  assert.equal(consultaMapa(null, null), "");
});

test("endereço: uma linha, ou vazio quando não presta", () => {
  assert.equal(enderecoParaFicha(" 1 Derb Abdellah,\n Bab Ksour "), "1 Derb Abdellah, Bab Ksour");
  assert.equal(enderecoParaFicha("Paris"), "");
  assert.equal(enderecoParaFicha(null), "");
});
