import { test } from "node:test";
import assert from "node:assert/strict";
import { montarAvisoEstabelecimento, LINK_RESPOSTA } from "../src/venueIdentityRegra.js";

const casa = { restaurantId: "70105", nome: "Don Sebastião", cidade: "Lagos" };

test("aviso de estabelecimento: identifica a casa, o papel e os links dos pendentes", () => {
  const txt = montarAvisoEstabelecimento(casa, [
    { reservation_code: "ABC12345", booking_date: "2026-10-03", reservation_time: "20:00:00", people: 2 },
    { reservation_code: "XYZ98765", booking_date: new Date("2026-10-04T00:00:00Z"), reservation_time: null, people: null },
  ]);
  assert.match(txt, /^\[Sistema: contato via WhatsApp de ESTABELECIMENTO — Don Sebastião \(Lagos\)/);
  assert.match(txt, /PARCEIRO/);
  assert.match(txt, /NÃO aceita, recusa nem reagenda/);
  assert.ok(txt.includes(`${LINK_RESPOSTA}ABC12345`));
  assert.ok(txt.includes("ABC12345 · 2026-10-03 20:00 · 2 pessoas"));
  assert.ok(txt.includes("XYZ98765 · 2026-10-04  · ? pessoas"));
});

test("aviso de estabelecimento: sem pendentes diz isso, e limita a 5", () => {
  assert.match(montarAvisoEstabelecimento(casa, []), /nenhum pedido pendente/);
  const muitos = Array.from({ length: 8 }, (_, i) => ({ reservation_code: `C${i}`, booking_date: "2026-10-03", reservation_time: "19:00", people: 2 }));
  const txt = montarAvisoEstabelecimento(casa, muitos);
  assert.equal((txt.match(/theworldkeys\.com\/r\//g) || []).length, 5);
});
