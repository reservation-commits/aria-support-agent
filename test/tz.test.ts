import { test } from "node:test";
import assert from "node:assert/strict";
import { tzForRestaurant, nowInTz, isOpenNow } from "../src/tz.js";

test("tzForRestaurant: países dos mercados principais", () => {
  assert.equal(tzForRestaurant("Brazil", "Rio de Janeiro"), "America/Sao_Paulo");
  assert.equal(tzForRestaurant("Brasil", null), "America/Sao_Paulo");
  assert.equal(tzForRestaurant("France", "Paris"), "Europe/Paris");
  assert.equal(tzForRestaurant("França", "Paris"), "Europe/Paris");
  assert.equal(tzForRestaurant("Italy", "Milano"), "Europe/Rome");
  assert.equal(tzForRestaurant("Portugal", "Lisboa"), "Europe/Lisbon");
});

test("tzForRestaurant: cidade desambigua país multi-fuso", () => {
  assert.equal(tzForRestaurant("United States", "New York"), "America/New_York");
  assert.equal(tzForRestaurant("United States", "Los Angeles"), "America/Los_Angeles");
  assert.equal(tzForRestaurant("USA", "Chicago"), "America/Chicago");
  assert.equal(tzForRestaurant("Brazil", "Manaus"), "America/Manaus");
});

test("tzForRestaurant: desconhecido retorna null (fallback é do chamador)", () => {
  assert.equal(tzForRestaurant("Atlantis", "Cidade Perdida"), null);
  assert.equal(tzForRestaurant(null, null), null);
});

test("nowInTz: fusos diferentes divergem de forma coerente", () => {
  // Meio-dia UTC de uma quarta-feira fixa.
  const at = new Date("2026-07-22T12:00:00Z"); // quarta
  const paris = nowInTz("Europe/Paris", at); // UTC+2 (verão) → 14:00
  const sp = nowInTz("America/Sao_Paulo", at); // UTC-3 → 09:00
  assert.equal(paris.weekday, 3);
  assert.equal(sp.weekday, 3);
  assert.equal(paris.minutes, 14 * 60);
  assert.equal(sp.minutes, 9 * 60);
});

test("nowInTz: fuso inválido não lança (cai no configurado)", () => {
  const r = nowInTz("Not/AZone", new Date("2026-07-22T12:00:00Z"));
  assert.equal(typeof r.minutes, "number");
  assert.ok(r.weekday >= 0 && r.weekday <= 6);
});

test("isOpenNow: faixa normal", () => {
  const ranges = [{ open: "12:00", close: "15:00" }, { open: "19:00", close: "23:00" }];
  assert.equal(isOpenNow(ranges, 13 * 60), true);
  assert.equal(isOpenNow(ranges, 17 * 60), false);
  assert.equal(isOpenNow(ranges, 22 * 60), true);
});

test("isOpenNow: overnight (fecha depois da meia-noite)", () => {
  const ranges = [{ open: "19:00", close: "02:00" }];
  assert.equal(isOpenNow(ranges, 23 * 60), true);
  assert.equal(isOpenNow(ranges, 1 * 60), true);
  assert.equal(isOpenNow(ranges, 12 * 60), false);
});
