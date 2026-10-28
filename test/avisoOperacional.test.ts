import { test } from "node:test";
import assert from "node:assert/strict";
import { detectarAvisoOperacional, prefixoAviso, resumoAviso } from "../src/avisoOperacional.js";

const PIERLUIGI = {
  sender: "r+1g605pzd7uo@message.sevenrooms.com",
  subject: "Credit Card required at Pierluigi | Kristy Swanson on 24/11/2026",
  text: "Your reservation is not complete. A credit card is required by 18:17 on 28 October for this reservation. ADD CREDIT CARD Tuesday, 24 November 2026 6 guests · 19:30 Contact Piazza De' Ricci, 144",
};

test("aviso de cartão do SevenRooms (caso de 28/10) vira aviso operacional com casa, cliente, data e prazo", () => {
  const a = detectarAvisoOperacional(PIERLUIGI);
  assert.ok(a);
  assert.equal(a.tipo, "cartao_exigido");
  assert.equal(a.sistema, "SevenRooms");
  assert.equal(a.casa, "Pierluigi");
  assert.equal(a.cliente, "Kristy Swanson");
  assert.equal(a.dataMesa, "24/11/2026");
  assert.equal(a.prazo, "18:17 28 October");
  assert.match(resumoAviso(a), /cartão de crédito até 18:17 28 October/);
  assert.match(resumoAviso(a), /humano/);
  assert.equal(prefixoAviso(a), "[aviso-operacional] cartao_exigido Pierluigi 24/11/2026");
});

test("sem sistema de reservas conhecido não é aviso (fail-closed: segue o fluxo normal)", () => {
  assert.equal(detectarAvisoOperacional({ sender: "cliente@gmail.com", subject: "Credit card required?", text: "Do you need my card?" }), null);
  assert.equal(detectarAvisoOperacional({ sender: "noreply@sevenrooms.com", subject: "Weekly digest", text: "Your stats this week" }), null);
});

test("cancelamento e confirmação pelo sistema são reconhecidos, sem prazo", () => {
  const c = detectarAvisoOperacional({ sender: "no-reply@thefork.com", subject: "Reservation cancelled at Le Bistrot | John Doe on 02/12/2026", text: "" });
  assert.equal(c?.tipo, "cancelamento_sistema");
  assert.equal(c?.prazo, null);
  const k = detectarAvisoOperacional({ sender: "reservations@opentable.com", subject: "Your reservation is confirmed at Nobu", text: "" });
  assert.equal(k?.tipo, "confirmacao_sistema");
});
