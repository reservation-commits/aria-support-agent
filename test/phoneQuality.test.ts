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
  // v12: o E.164 fica disponível (casa marcada pode receber no fixo), mas o portão do CLIENTE continua fechado.
  assert.equal(a.e164, "+551133334444");
  assert.equal(podeReceberWhatsApp(a), false, "cliente em linha fixa nunca recebe");
});

test("celular brasileiro sem o código do país NÃO vira destino", () => {
  // 11 dígitos, DDD 21 + 9 dígitos. A leitura ingênua ("+" + dígitos) daria
  // +21…, que é o Egito. É exatamente o caso que vazaria dados a um estranho.
  const a = avaliarTelefone("21967841007");
  assert.equal(a.qualidade, "CORRIGIVEL_BR");
  assert.equal(a.e164, null);
  assert.equal(podeReceberWhatsApp(a), false);
});

test("número SEM '+' com duas leituras válidas fica em quarentena", () => {
  // 10 dígitos: lê como fixo brasileiro no DDD 65 e também como número de
  // Singapura. Sem o "+", não se adivinha.
  const a = avaliarTelefone("6532345678");
  assert.equal(a.qualidade, "AMBIGUO_BR");
  assert.equal(podeReceberWhatsApp(a), false);
});

test("v18: o '+' declara o país e desfaz a ambiguidade brasileira", () => {
  // Caso real de 30/09: as casas marcadas pelo fundador têm o número em E.164 e mesmo
  // assim ficaram 57 vezes em "ambíguo" — "+33 9…" lido como DDD 33, "+66 2…" como DDD 66.
  for (const [numero, pais] of [
    ["+33987654321", "FR"], // La Cucina: faixa 09 francesa
    ["+6620123456", "TH"],  // Sri Trat: fixo de Bangkok
    ["+6532345678", "SG"],  // o mesmo número do teste acima, agora com "+"
  ] as const) {
    const a = avaliarTelefone(numero);
    assert.notEqual(a.qualidade, "AMBIGUO_BR", `${numero} não pode ser ambíguo com o "+"`);
    assert.equal(a.pais, pais);
    assert.equal(a.e164, numero, "o E.164 fica disponível para a casa marcada");
  }
});

test("v18: '+' na frente de um celular brasileiro SEM o 55 não vira destino", () => {
  // "+21 9…" não é DDD 21: é um código de país inexistente. Sem leitura brasileira
  // de reserva, cai em inválido — e não no Egito.
  const a = avaliarTelefone("+21967841007");
  assert.equal(a.qualidade, "INVALIDO");
  assert.equal(a.e164, null);
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
    avaliarTelefone("6532345678"),    // ambíguo (sem "+")
    avaliarTelefone("12345"),         // inválido
    avaliarTelefone(""),              // vazio
  ];
  for (const a of vereditos) {
    assert.equal(podeReceberWhatsApp(a), false, `${a.qualidade} não pode passar`);
  }
});
