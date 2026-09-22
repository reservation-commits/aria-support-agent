import { test } from "node:test";
import assert from "node:assert/strict";
import { avaliarTelefone, podeReceberWhatsApp } from "../src/phoneQuality.js";

test("aceita celular internacional bem formatado", () => {
  for (const [numero, pais] of [
    ["+5521967841007", "BR"],
    ["+33612345678", "FR"],
    // 07400… é faixa móvel britânica de verdade. Cuidado ao trocar: 07911 é
    // alocada a Guernsey (GG), não ao Reino Unido.
    ["+447400123456", "GB"],
  ] as const) {
    const a = avaliarTelefone(numero);
    assert.equal(a.qualidade, "ENVIAVEL", `${numero} deveria ser enviável`);
    assert.equal(a.pais, pais);
    assert.equal(a.e164, numero);
    assert.ok(podeReceberWhatsApp(a));
  }
});

test("tolera lixo de formatação sem mudar o veredito", () => {
  const a = avaliarTelefone(" +55 (21) 96784-1007 ");
  assert.equal(a.qualidade, "ENVIAVEL");
  assert.equal(a.e164, "+5521967841007");
});

test("linha fixa é válida mas não recebe WhatsApp", () => {
  const a = avaliarTelefone("+551133334444"); // fixo em São Paulo
  assert.equal(a.qualidade, "ENVIAVEL_NAO_MOVEL");
  assert.equal(a.e164, null, "não pode expor um destino que não entrega");
  assert.equal(podeReceberWhatsApp(a), false);
});

test("celular brasileiro sem o código do país NÃO vira destino", () => {
  // 11 dígitos, DDD 21 + 9 dígitos. A leitura ingênua ("+" + dígitos) daria
  // +21…, que é o Egito. É exatamente o caso que vazaria dados a um estranho.
  const a = avaliarTelefone("21967841007");
  assert.equal(a.qualidade, "CORRIGIVEL_BR");
  assert.equal(a.e164, null);
  assert.equal(podeReceberWhatsApp(a), false);
});

test("número com duas leituras válidas fica em quarentena", () => {
  // 10 dígitos: lê como fixo brasileiro no DDD 65 e também como número de
  // Singapura. Não se adivinha.
  const a = avaliarTelefone("+6532345678");
  assert.equal(a.qualidade, "AMBIGUO_BR");
  assert.equal(podeReceberWhatsApp(a), false);
});

test("prefixo de tronco nacional não vira E.164", () => {
  const a = avaliarTelefone("021967841007"); // começa com 0
  assert.notEqual(a.qualidade, "ENVIAVEL");
  assert.equal(podeReceberWhatsApp(a), false);
});

test("comprimento fora do E.164 é rejeitado", () => {
  for (const n of ["12345", "1234567890123456789", "+1"]) {
    const a = avaliarTelefone(n);
    assert.equal(a.qualidade, "INVALIDO", `${n} deveria ser inválido`);
    assert.equal(podeReceberWhatsApp(a), false);
  }
});

test("vazio e nulo não explodem", () => {
  for (const n of [null, undefined, "", "   ", "abc"]) {
    const a = avaliarTelefone(n);
    assert.ok(["VAZIO", "INVALIDO"].includes(a.qualidade));
    assert.equal(podeReceberWhatsApp(a), false);
  }
});

test("só ENVIAVEL abre a porta — nenhum outro veredito passa", () => {
  const vereditos = [
    avaliarTelefone("+551133334444"), // não móvel
    avaliarTelefone("21967841007"),   // corrigível
    avaliarTelefone("+6532345678"),   // ambíguo
    avaliarTelefone("12345"),         // inválido
    avaliarTelefone(""),              // vazio
  ];
  for (const a of vereditos) {
    assert.equal(podeReceberWhatsApp(a), false, `${a.qualidade} não pode passar`);
  }
});
