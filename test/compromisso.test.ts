import { test } from "node:test";
import assert from "node:assert/strict";
import { validarDataCompromisso, MAX_DIAS_COMPROMISSO } from "../src/compromissoRegra.js";
import { motivoDeBloqueio, outboundGate } from "../src/format.js";

const hoje = new Date("2026-09-29T15:00:00Z");

test("compromisso: aceita hoje até 7 dias à frente, formato AAAA-MM-DD", () => {
  assert.deepEqual(validarDataCompromisso("2026-09-29", hoje), { ok: true, due: "2026-09-29" });
  assert.deepEqual(validarDataCompromisso("2026-10-06", hoje), { ok: true, due: "2026-10-06" });
  assert.equal(MAX_DIAS_COMPROMISSO, 7);
});

test("compromisso: recusa passado, longe demais e formato errado", () => {
  assert.equal(validarDataCompromisso("2026-09-28", hoje).ok, false);
  assert.equal(validarDataCompromisso("2026-10-07", hoje).ok, false);
  assert.equal(validarDataCompromisso("03/10/2026", hoje).ok, false);
  assert.equal(validarDataCompromisso("2026-02-30", hoje).ok, false);
  assert.equal(validarDataCompromisso("", hoje).ok, false);
});

test("porta: com compromisso registrado, a data de retorno NOSSA passa; sem registro, é barrada", () => {
  const carta = "Bonjour Anna, votre demande est bien chez le restaurant. Si je n'ai pas de confirmation, je reviens vers vous d'ici vendredi avec deux tables du même niveau. Aria";
  assert.match(motivoDeBloqueio(carta) ?? "", /prazo/);
  assert.equal(motivoDeBloqueio(carta, { prazoPermitido: true }), null);
  assert.equal(outboundGate(carta, "Bonjour, avez-vous des nouvelles de ma réservation ?", { prazoPermitido: true }).ok, true);
});

test("porta: compromisso registrado NÃO libera processo exposto nem prazo de terceiro", () => {
  const carta = "Bonjour Anna, j'ai relancé le restaurant et nous sommes en attente de réponse ; je reviens vers vous d'ici vendredi. Aria";
  assert.match(motivoDeBloqueio(carta, { prazoPermitido: true }) ?? "", /processo/);
});
