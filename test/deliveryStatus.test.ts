import { test } from "node:test";
import assert from "node:assert/strict";
import { avancaStatus } from "../src/deliveryStatus.js";

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
