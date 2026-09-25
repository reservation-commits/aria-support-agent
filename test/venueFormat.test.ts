import { test } from "node:test";
import assert from "node:assert/strict";
import { montarParametrosEstabelecimento, ehEventoEstabelecimento } from "../src/venueFormat.js";

const base = { customer_name: "  Anna   Lee ", restaurant_name: "Le Tobsil", booking_date: "2026-10-03", reservation_time: "20:00:00", people: 2 };

test("casa: ordem dos parâmetros = restaurante, data, hora, pessoas, nome completo", () => {
  const p = montarParametrosEstabelecimento(base, "FR");
  assert.ok(p);
  assert.equal(p.length, 5);
  assert.equal(p[0], "Le Tobsil");
  assert.match(p[1], /2026/);
  assert.equal(p[2], "20:00");
  assert.equal(p[3], "2");
  assert.equal(p[4], "Anna Lee");
});

test("casa: hora no costume do país do número da casa", () => {
  assert.equal(montarParametrosEstabelecimento(base, "US")?.[2], "8:00 PM");
});

test("casa: qualquer campo vazio bloqueia (nome, pessoas, hora)", () => {
  assert.equal(montarParametrosEstabelecimento({ ...base, customer_name: null }, "FR"), null);
  assert.equal(montarParametrosEstabelecimento({ ...base, people: 0 }, "FR"), null);
  assert.equal(montarParametrosEstabelecimento({ ...base, reservation_time: null }, "FR"), null);
  assert.equal(montarParametrosEstabelecimento({ ...base, restaurant_name: " " }, "FR"), null);
});

test("casa: só três etapas existem", () => {
  assert.equal(ehEventoEstabelecimento("pedido_recebido"), true);
  assert.equal(ehEventoEstabelecimento("cancelado"), true);
  assert.equal(ehEventoEstabelecimento("vespera"), true);
  assert.equal(ehEventoEstabelecimento("aceito"), false);
});
