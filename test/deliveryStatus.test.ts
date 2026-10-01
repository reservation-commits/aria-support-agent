import { test } from "node:test";
import assert from "node:assert/strict";
import { avancaStatus, motivoBloqueio, META_UNDELIVERABLE } from "../src/deliveryStatus.js";

test("v19: só 'undeliverable' põe o número na lista de bloqueio", () => {
  assert.equal(motivoBloqueio({ status: "failed", errorCode: META_UNDELIVERABLE, errorTitle: "Message undeliverable" }), "meta:undeliverable");
  // Sem código (payload antigo), o título decide.
  assert.equal(motivoBloqueio({ status: "failed", errorCode: null, errorTitle: "Message Undeliverable" }), "meta:undeliverable");
});

test("v19: outras falhas são do envio, não do número — não bloqueiam", () => {
  assert.equal(motivoBloqueio({ status: "failed", errorCode: 131047, errorTitle: "Re-engagement message" }), null);
  assert.equal(motivoBloqueio({ status: "failed", errorCode: 131049, errorTitle: "This message was not delivered to maintain healthy ecosystem engagement." }), null);
  assert.equal(motivoBloqueio({ status: "failed", errorCode: 132001, errorTitle: "Template name does not exist in the translation" }), null);
  // Código presente e diferente vence um título parecido.
  assert.equal(motivoBloqueio({ status: "failed", errorCode: 131053, errorTitle: "Message undeliverable" }), null);
  assert.equal(motivoBloqueio({ status: "delivered", errorCode: null, errorTitle: null }), null);
  assert.equal(motivoBloqueio({ status: "read", errorCode: META_UNDELIVERABLE, errorTitle: null }), null);
});

test("status de entrega só anda para a frente", () => {
  assert.equal(avancaStatus(null, "sent"), true);
  assert.equal(avancaStatus("sent", "delivered"), true);
  assert.equal(avancaStatus("delivered", "read"), true);
  assert.equal(avancaStatus("sent", "read"), true, "lido pode chegar antes do entregue");
});

test("um status atrasado nunca apaga um mais avançado", () => {
  assert.equal(avancaStatus("read", "delivered"), false);
  assert.equal(avancaStatus("read", "sent"), false);
  assert.equal(avancaStatus("delivered", "delivered"), false, "repetição do mesmo status não conta");
});

test("falha é terminal e vence qualquer outro", () => {
  assert.equal(avancaStatus("read", "failed"), true);
  assert.equal(avancaStatus("failed", "read"), false);
  assert.equal(avancaStatus("failed", "delivered"), false);
});

test("status desconhecido da Meta é ignorado", () => {
  assert.equal(avancaStatus("sent", "warning"), false);
  assert.equal(avancaStatus(null, ""), false);
});
