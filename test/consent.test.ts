import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConsentIntent, consentConfirmation } from "../src/consent.js";
import { outboundGate } from "../src/format.js";

const TELEFONES = ["+5511999999999", "+14155550123", "+34911223344", "+33612345678", "+393331234567", "+491701234567"];

test("v23: VOLTAR sem opt-in de reservas não promete lembretes — aponta o código do pedido", () => {
  for (const tel of TELEFONES) {
    const sem = consentConfirmation("opt_in", tel, { recebeReservas: false });
    const com = consentConfirmation("opt_in", tel, { recebeReservas: true });
    assert.notEqual(sem, com, tel);
    assert.doesNotMatch(sem, /lembretes|reminders|recordatorios|rappels|promemoria|Erinnerungen/i, tel);
    assert.match(sem, /c[oó]d(igo|e|ice)/i, tel);
  }
  // sem a opção, mantém o texto antigo (compatível)
  assert.match(consentConfirmation("opt_in", "+34911223344"), /Volverá a recibir/i);
});

test("v23: toda confirmação de consentimento passa pela porta de saída", () => {
  for (const tel of TELEFONES) {
    for (const msg of [
      consentConfirmation("opt_out", tel),
      consentConfirmation("opt_in", tel, { recebeReservas: true }),
      consentConfirmation("opt_in", tel, { recebeReservas: false }),
    ]) {
      const porta = outboundGate(msg);
      assert.equal(porta.ok, true, `${tel}: ${porta.ok ? "" : porta.motivo} · ${msg}`);
    }
  }
});

test("detecta opt-out em mensagens curtas e diretas", () => {
  assert.equal(detectConsentIntent("PARAR"), "opt_out");
  assert.equal(detectConsentIntent("parar."), "opt_out");
  assert.equal(detectConsentIntent("stop"), "opt_out");
  assert.equal(detectConsentIntent("quero parar os lembretes"), "opt_out");
  assert.equal(detectConsentIntent("arrêter"), "opt_out"); // com acento
});

test("detecta opt-in", () => {
  assert.equal(detectConsentIntent("voltar"), "opt_in");
  assert.equal(detectConsentIntent("START"), "opt_in");
});

test("não confunde com conversa real de suporte", () => {
  assert.equal(detectConsentIntent("cancelar minha reserva do restaurante"), null); // 'cancelar' não é gatilho
  assert.equal(detectConsentIntent("qual o endereço do restaurante?"), null);
  assert.equal(detectConsentIntent("não consigo parar de pensar nesse lugar incrível"), null); // frase longa
  assert.equal(detectConsentIntent(""), null);
});

test("confirmação respeita o idioma do país", () => {
  assert.match(consentConfirmation("opt_out", "+5511999999999"), /não receberá mais/i);
  assert.match(consentConfirmation("opt_out", "+14155550123"), /no longer receive/i);
  assert.match(consentConfirmation("opt_in", "+34911223344"), /Volverá a recibir/i);
  assert.match(consentConfirmation("opt_out", "+33612345678"), /plus de rappels/i);
});
