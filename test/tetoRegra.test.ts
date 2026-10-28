import { test } from "node:test";
import assert from "node:assert/strict";
import { temTeto, tetoAtingido } from "../src/tetoRegra.js";

test("teto 0 significa sem teto: nunca bloqueia (bug da casa, 27/10)", () => {
  assert.equal(temTeto(0), false);
  assert.equal(tetoAtingido(0, 0), false);
  assert.equal(tetoAtingido(999, 0), false);
  assert.equal(tetoAtingido(5, -1), false);
  assert.equal(tetoAtingido(5, Number.NaN), false);
});

test("com teto, bloqueia ao atingir e não antes", () => {
  assert.equal(temTeto(50), true);
  assert.equal(tetoAtingido(49, 50), false);
  assert.equal(tetoAtingido(50, 50), true);
  assert.equal(tetoAtingido(51, 50), true);
});
