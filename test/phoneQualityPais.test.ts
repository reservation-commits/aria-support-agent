import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarTelefone, podeReceberWhatsApp } from "../src/phoneQuality.js";

// v22 (plano C3): o país do cadastro do restaurante desempata o número ambíguo.
// "33 9 12 34 56 78" sem "+" lê como França (+33 9…, linha não geográfica válida) E como
// celular brasileiro (DDD 33, 9 1234-5678) — o caso real da La Cucina (Nice), 57 vezes em quarentena.
const AMBIGUO = "33912345678";

test("o número de teste é de fato ambíguo: sem país esperado fica em quarentena", () => {
  const a = avaliarTelefone(AMBIGUO);
  assert.equal(a.qualidade, "AMBIGUO_BR");
  assert.equal(a.e164, null);
  assert.ok(!podeReceberWhatsApp(a));
});

test("país do cadastro = FR → leitura internacional vence e o E.164 é o francês", () => {
  const a = avaliarTelefone(AMBIGUO, "FR");
  assert.ok(["ENVIAVEL", "ENVIAVEL_NAO_MOVEL"].includes(a.qualidade), a.qualidade);
  assert.equal(a.e164, "+33912345678");
  assert.equal(a.pais, "FR");
  assert.match(a.motivo, /país do cadastro \(FR\)/);
});

test("país do cadastro = br (qualquer caixa) → leitura nacional brasileira vence e é celular", () => {
  const a = avaliarTelefone(AMBIGUO, "br");
  assert.equal(a.qualidade, "ENVIAVEL");
  assert.equal(a.pais, "BR");
  assert.equal(a.e164, "+5533912345678");
  assert.ok(podeReceberWhatsApp(a));
});

test("país do cadastro que não casa com nenhuma leitura não desempata (nunca adivinha)", () => {
  const a = avaliarTelefone(AMBIGUO, "TH");
  assert.equal(a.qualidade, "AMBIGUO_BR");
  assert.equal(a.e164, null);
});

test("com o '+' declarado o país esperado não muda nada (v18 continua valendo)", () => {
  const a = avaliarTelefone("+33612345678", "BR");
  assert.equal(a.qualidade, "ENVIAVEL");
  assert.equal(a.e164, "+33612345678");
});

test("número que só tem uma leitura ignora o país esperado", () => {
  const a = avaliarTelefone("33612345678", "TH"); // +33 6… é celular francês; (33) 61234-5678 não é celular no Brasil
  assert.equal(a.qualidade, "ENVIAVEL");
  assert.equal(a.e164, "+33612345678");
});
