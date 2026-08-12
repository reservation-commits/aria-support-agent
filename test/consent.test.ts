import { test } from "node:test";
import assert from "node:assert/strict";
import { detectConsentIntent, consentConfirmation } from "../src/consent.js";

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
