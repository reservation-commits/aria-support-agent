import { test } from "node:test";
import assert from "node:assert/strict";
import { emailDomainMatches, parseInitialReservation, validateManage } from "../src/platformReservation.js";

const HTML_NEXT = String.raw`<script>self.__next_f.push([1,"...\"initialReservation\":{\"id\":\"abc\",\"date\":\"2026-09-26\",\"time\":\"21:30\",\"people\":4,\"status\":\"Pending\",\"details\":\"\",\"restaurant\":{\"name\":\"GIGI\",\"restaurant_id\":\"14458\",\"email_for_reservations\":\"contact@gigi-restaurant.com\"},\"user\":{\"name\":\"A\"}},\"reservationCode\":\"VK6BEDL6\""])</script>`;

test("parseInitialReservation extrai o objeto com aspas escapadas do Next", () => {
  const r = parseInitialReservation(HTML_NEXT);
  assert.equal(r.id, "abc");
  assert.equal(r.time, "21:30");
  assert.equal(r.people, 4);
  assert.equal(r.restaurant.restaurant_id, "14458");
});

test("parseInitialReservation falha alto quando a página não traz a reserva", () => {
  assert.throws(() => parseInitialReservation("<html>nada</html>"), /sem initialReservation/);
});

test("emailDomainMatches: domínio próprio bate por domínio; genérico só por endereço inteiro", () => {
  assert.equal(emailDomainMatches("Contact gigi <contact@gigi-restaurant.com>", "reservas@gigi-restaurant.com"), true);
  assert.equal(emailDomainMatches("alguem@outro.com", "contact@gigi-restaurant.com"), false);
  assert.equal(emailDomainMatches("casa@gmail.com", "casa@gmail.com"), true);
  assert.equal(emailDomainMatches("impostor@gmail.com", "casa@gmail.com"), false);
  assert.equal(emailDomainMatches(null, "casa@x.com"), false);
});

const base = { id: "1", date: "2026-12-01", time: "20:00", people: 2, status: "Pending", restaurant: {}, user: {} };

test("validateManage: só Pending/In Treatment, só data futura, reschedule exige HH:MM", () => {
  assert.equal(validateManage(base, "accept", undefined, "2026-09-10"), null);
  assert.match(validateManage({ ...base, status: "Accepted" }, "accept", undefined, "2026-09-10")!.error, /status/);
  assert.match(validateManage({ ...base, date: "2026-09-01" }, "decline", undefined, "2026-09-10")!.error, /já passou/);
  assert.match(validateManage(base, "reschedule", "22h", "2026-09-10")!.error, /HH:MM/);
  assert.equal(validateManage(base, "reschedule", "22:00", "2026-09-10"), null);
  assert.match(validateManage(base, "delete", undefined, "2026-09-10")!.error, /inválida/);
});
