import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTemporalContext } from "../src/datetime.js";

test("injeta a data ISO e o ano corretos (horário de Brasília)", () => {
  // 2026-06-18T12:00Z → Brasília (-03) = 2026-06-18 09:00, mesma data ISO.
  const ctx = buildTemporalContext(new Date("2026-06-18T12:00:00Z"));
  assert.ok(ctx.includes("2026-06-18"), "deve conter a data ISO em Brasília");
  assert.ok(ctx.includes("Ano atual: 2026"));
  assert.ok(ctx.includes("FONTE ÚNICA DE VERDADE"));
});

test("vira o dia corretamente perto da meia-noite UTC", () => {
  // 2026-06-18T02:00Z → Brasília (-03) = 2026-06-17 23:00 → data ISO é dia 17.
  const ctx = buildTemporalContext(new Date("2026-06-18T02:00:00Z"));
  assert.ok(ctx.includes("2026-06-17"), "deve respeitar o fuso de Brasília na virada do dia");
});

test("inclui o carimbo UTC absoluto", () => {
  const ctx = buildTemporalContext(new Date("2026-06-18T12:00:00Z"));
  assert.ok(ctx.includes("2026-06-18T12:00:00.000Z"));
});
