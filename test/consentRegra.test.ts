import { test } from "node:test";
import assert from "node:assert/strict";
import { decidirEnvioWhatsApp } from "../src/consentRegra.js";

test("opt-in: sem linha no banco → não recebe", () => {
  assert.deepEqual(decidirEnvioWhatsApp(null), { ok: false, motivo: "sem_opt_in" });
  assert.deepEqual(decidirEnvioWhatsApp(undefined), { ok: false, motivo: "sem_opt_in" });
});

test("opt-in: linha existe mas não está marcada → não recebe", () => {
  assert.deepEqual(decidirEnvioWhatsApp({ whatsapp_reservas: false, outbound_opted_out: false }), { ok: false, motivo: "sem_opt_in" });
});

test("opt-in: marcada → recebe", () => {
  assert.deepEqual(decidirEnvioWhatsApp({ whatsapp_reservas: true, outbound_opted_out: false }), { ok: true, motivo: "ok", idioma: null });
});

test("PARAR vence a marcação: marcada mas pediu para parar → não recebe", () => {
  assert.deepEqual(decidirEnvioWhatsApp({ whatsapp_reservas: true, outbound_opted_out: true }), { ok: false, motivo: "opt_out" });
});

test("opt-in: idioma marcado viaja na decisão", () => {
  const d = decidirEnvioWhatsApp({ whatsapp_reservas: true, outbound_opted_out: false, idioma: "it" });
  assert.equal(d.ok && d.idioma, "it");
});

test("estabelecimento segue a mesma regra", () => {
  assert.equal(decidirEnvioWhatsApp({ whatsapp_reservas: true, outbound_opted_out: false, tipo: "estabelecimento" }).ok, true);
  assert.equal(decidirEnvioWhatsApp({ whatsapp_reservas: false, outbound_opted_out: false, tipo: "estabelecimento" }).ok, false);
});
