import { test } from "node:test";
import assert from "node:assert/strict";
import { assertReadOnlySql } from "../src/sqlGuard.js";

test("aceita um SELECT simples e remove o ; final", () => {
  assert.equal(
    assertReadOnlySql("SELECT name, url_page_twk FROM public.db_restaurants WHERE name ILIKE '%contraste%';"),
    "SELECT name, url_page_twk FROM public.db_restaurants WHERE name ILIKE '%contraste%'",
  );
});

test("aceita CTE (WITH ... SELECT)", () => {
  const q = "WITH x AS (SELECT 1 AS n) SELECT n FROM x";
  assert.equal(assertReadOnlySql(q), q);
});

test("bloqueia escrita e DDL", () => {
  for (const q of [
    "UPDATE reservations SET people = 9",
    "DELETE FROM db_restaurants",
    "DROP TABLE db_restaurants",
    "INSERT INTO x VALUES (1)",
    "SELECT 1; DROP TABLE x",
    "TRUNCATE reservations",
  ]) {
    assert.throws(() => assertReadOnlySql(q), undefined, `deveria bloquear: ${q}`);
  }
});

test("bloqueia múltiplas instruções", () => {
  assert.throws(() => assertReadOnlySql("SELECT 1; SELECT 2"));
});

test("bloqueia acesso a dados sensíveis de clientes", () => {
  for (const q of [
    'SELECT * FROM nextauth."User"',
    "SELECT * FROM aria_customer_profiles",
    "SELECT * FROM aria_messages",
    "SELECT password FROM x",
    "SELECT * FROM aria_contact_consent",
  ]) {
    assert.throws(() => assertReadOnlySql(q), undefined, `deveria bloquear: ${q}`);
  }
});

test("permite ler restaurantes, reservas e horários", () => {
  assert.ok(assertReadOnlySql("SELECT reservation_code, booking_status FROM public.reservations"));
  assert.ok(assertReadOnlySql("SELECT weekday, open_time FROM public.opening_hours WHERE restaurant_id = 'r1'"));
});
