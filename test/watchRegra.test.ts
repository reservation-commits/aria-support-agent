import { test } from "node:test";
import assert from "node:assert/strict";
import { eventoPorStatus, normalizarStatusReserva, pedidoRecente } from "../src/watchRegra.js";

test("vigia: linha nova em pending é pedido recebido; nova em outro status não é nada", () => {
  assert.equal(eventoPorStatus(null, "Pending"), "pedido_recebido");
  assert.equal(eventoPorStatus(null, " pending "), "pedido_recebido");
  assert.equal(eventoPorStatus(null, "Accept"), null);
  assert.equal(eventoPorStatus(null, "declined (client)"), null);
});

test("vigia: transições viram os eventos certos", () => {
  assert.equal(eventoPorStatus("pending", "accept"), "aceito");
  assert.equal(eventoPorStatus("pending", "Decline"), "recusado");
  assert.equal(eventoPorStatus("pending", "Declined (client)"), "cancelado");
  assert.equal(eventoPorStatus("accept", "declined (client)"), "cancelado");
});

test("vigia: sem mudança ou status desconhecido → nada", () => {
  assert.equal(eventoPorStatus("pending", "pending"), null);
  assert.equal(eventoPorStatus("accept", "accept"), null);
  assert.equal(eventoPorStatus("pending", "in treatment"), null);
  assert.equal(eventoPorStatus("accept", "pending"), null);
});

test("vigia: só pedidos recentes são anunciados", () => {
  const agora = new Date("2026-09-30T12:00:00Z");
  assert.equal(pedidoRecente("2026-09-30T09:30:00Z", agora, 6), true);
  assert.equal(pedidoRecente("2026-09-30T05:00:00Z", agora, 6), false);
  assert.equal(pedidoRecente("2026-10-02T12:00:00Z", agora, 6), false); // data futura estranha
  assert.equal(pedidoRecente("lixo", agora, 6), false);
});

test("normalizarStatusReserva", () => {
  assert.equal(normalizarStatusReserva("  Declined (Client) "), "declined (client)");
  assert.equal(normalizarStatusReserva(null), "");
});
