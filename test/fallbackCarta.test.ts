import { test } from "node:test";
import assert from "node:assert/strict";
import { cartaFallback, dataPorExtenso, proximoDiaUtil, IDIOMAS_FALLBACK } from "../src/fallbackCarta.js";
import { outboundGate, idiomaProvavel } from "../src/format.js";

test("próximo dia útil pula o fim de semana (Europe/Paris)", () => {
  assert.equal(proximoDiaUtil(new Date("2026-10-28T10:00:00Z")), "2026-10-29"); // quarta → quinta
  assert.equal(proximoDiaUtil(new Date("2026-10-30T10:00:00Z")), "2026-11-02"); // sexta → segunda
  assert.equal(proximoDiaUtil(new Date("2026-10-31T23:30:00Z")), "2026-11-02"); // sábado (já domingo em Paris) → segunda
});

test("data por extenso no idioma, com dia da semana", () => {
  assert.equal(dataPorExtenso("2026-10-29", "pt"), "quinta-feira, 29 de outubro de 2026");
  assert.match(dataPorExtenso("2026-10-29", "en"), /Thursday,? 29 October 2026/);
  assert.match(dataPorExtenso("2026-10-29", "fr"), /jeudi 29 octobre 2026/);
});

test("toda carta de espera passa pela porta de saída com o compromisso registrado, nos 6 idiomas e para os dois destinatários", () => {
  const data = "2026-10-29";
  for (const idioma of IDIOMAS_FALLBACK) {
    const ext = dataPorExtenso(data, idioma);
    for (const carta of [
      cartaFallback("cliente", idioma, { data: ext }),
      cartaFallback("estabelecimento", idioma, { data: ext }),
      cartaFallback("estabelecimento", idioma, { data: ext, pedido: "GPG32S3S", link: "https://theworldkeys.com/r/GPG32S3S" }),
    ]) {
      const porta = outboundGate(carta, undefined, { prazoPermitido: true });
      assert.equal(porta.ok, true, `${idioma}: ${porta.ok ? "" : porta.motivo} · ${carta}`);
      assert.match(carta, /Aria · The World Keys$/);
      assert.ok(carta.includes(ext), `${idioma}: data por extenso presente`);
    }
    // O idioma da carta é reconhecível pela própria porta (não vai carta em inglês a quem escreveu em francês).
    const detectado = idiomaProvavel(cartaFallback("cliente", idioma, { data: ext }));
    assert.ok(detectado === idioma || detectado === null, `${idioma}: detectado ${detectado}`);
  }
});

test("sem o compromisso, a carta é retida (a data só vale porque foi registrada)", () => {
  const carta = cartaFallback("cliente", "en", { data: dataPorExtenso("2026-10-29", "en") });
  assert.equal(outboundGate(carta).ok, false);
});
