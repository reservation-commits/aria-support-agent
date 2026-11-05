import { test } from "node:test";
import assert from "node:assert/strict";
import { montarParametrosEstabelecimento, ehEventoEstabelecimento, eventoDaCasa } from "../src/venueFormat.js";

const base = { customer_name: "  Anna   Lee ", restaurant_name: "Le Tobsil", booking_date: "2026-10-03", reservation_time: "20:00:00", people: 2 };

test("casa: ordem dos parâmetros = restaurante, data, hora, pessoas, nome completo", () => {
  const p = montarParametrosEstabelecimento(base, "FR");
  assert.ok(p);
  assert.equal(p.length, 5);
  assert.equal(p[0], "Le Tobsil");
  assert.match(p[1], /2026/);
  assert.equal(p[2], "8:00 PM"); // v25: AM/PM em todo país
  assert.equal(p[3], "2");
  assert.equal(p[4], "Anna Lee");
});

test("casa: hora em AM/PM também para número americano", () => {
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
  assert.equal(ehEventoEstabelecimento("confirmada"), true); // v25
});

test("casa v25: reserva nova já aceita (confirmação automática) vira 'confirmada'; aceite da própria casa não avisa", () => {
  assert.equal(eventoDaCasa("aceito", true), "confirmada");
  assert.equal(eventoDaCasa("aceito", false), null); // pending → accept: foi a casa que aceitou
  assert.equal(eventoDaCasa("aceito"), null); // webhook do n8n não sabe se é nova
  assert.equal(eventoDaCasa("pedido_recebido"), "pedido_recebido");
  assert.equal(eventoDaCasa("cancelado", true), "cancelado");
  assert.equal(eventoDaCasa("recusado", true), null);
  assert.equal(eventoDaCasa("reagendamento_proposto"), null);
});
