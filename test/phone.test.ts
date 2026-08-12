import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../src/phone.js";

test("adiciona o + quando ausente", () => {
  assert.equal(normalizePhone("5511999999999"), "+5511999999999");
});

test("mantém número já em E.164", () => {
  assert.equal(normalizePhone("+5511999999999"), "+5511999999999");
});

test("limpa formatação humana", () => {
  assert.equal(normalizePhone("+55 (11) 99999-9999"), "+5511999999999");
});
