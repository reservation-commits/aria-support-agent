import { test } from "node:test";
import assert from "node:assert/strict";
import { motivoDeBloqueio, outboundGate } from "../src/format.js";

const INCIDENTE_29_09 =
  "Bonjour Madame Martin, j'ai relancé le restaurant ce matin et nous sommes en attente de réponse. " +
  "Je reviens vers vous d'ici vendredi 3 octobre en fin de journée avec une alternative. Bien à vous, Aria";

test("29/09: prazo prometido em francês é barrado", () => {
  const m = motivoDeBloqueio(INCIDENTE_29_09);
  assert.ok(m, "deveria barrar");
  assert.match(m!, /processo|prazo/);
});

test("prazo/data prometidos em pt, en, fr, es e it são barrados", () => {
  const casos = [
    "Olá Ana, volto a você até sexta-feira com alternativas. Aria",
    "Olá Ana, respondo em até 24 horas. Aria",
    "Hello Anna, I will get back to you by Friday with options. Aria",
    "Hello Anna, you will hear from us within 48 hours. Aria",
    "Bonjour Anna, je vous réponds avant le 3 octobre. Aria",
    "Hola Ana, le respondo dentro de 2 días. Aria",
    "Buongiorno Anna, le rispondo entro venerdì. Aria",
  ];
  for (const c of casos) assert.match(motivoDeBloqueio(c) ?? "", /prazo/, c);
});

test("processo interno exposto em pt, en e fr é barrado", () => {
  const casos = [
    "Olá Ana, já relancei o restaurante e estou aguardando a resposta do restaurante. Aria",
    "Hello Anna, I have registered your request and we are waiting for the restaurant's reply. Aria",
    "Hello Anna, this requires a human step on our side. Aria",
    "Bonjour Anna, nous avons relancé la maison et sommes en attente d'un retour. Aria",
  ];
  for (const c of casos) assert.match(motivoDeBloqueio(c) ?? "", /processo/, c);
});

test("data da reserva e horários do cliente NÃO são barrados (não é promessa nossa)", () => {
  const legitimos = [
    "Bonjour Anna, votre table chez Le Tobsil est confirmée pour le vendredi 3 octobre à 20h. Tout est en place. Aria",
    "Hello Anna, your table at Sri Trat is confirmed for Friday 3 October at 8:00 PM. Enjoy your evening. Aria",
    "Olá Ana, a sua mesa no Don Sebastião está confirmada para sexta-feira, 3 de outubro, às 20h. Aria",
    "Hello Anna, the restaurant opens at 7 PM and the kitchen closes at 11 PM. Would you like the 8 PM seating? Aria",
  ];
  for (const c of legitimos) assert.equal(motivoDeBloqueio(c), null, c);
});

test("porta única continua verificando idioma", () => {
  assert.equal(outboundGate("Hello Anna, your table is confirmed for Friday 3 October at 8 PM. Aria", "Hi, is my table confirmed?").ok, true);
  assert.equal(outboundGate("Olá Ana, a sua mesa no restaurante está confirmada para sexta-feira às 20h. Você não precisa fazer mais nada. Obrigada, Aria", "Hi, is my table confirmed for Friday? Thank you, Anna").ok, false);
});
