import { test } from "node:test";
import assert from "node:assert/strict";
import { cartaPendencia, idiomaDaCarta, IDIOMAS_CARTA, type TipoCartaPendencia } from "../src/pendenciaEmail.js";
import { outboundGate, motivoDeBloqueio } from "../src/format.js";

const dados = { nome: "Marie", restaurante: "MONAK", data: "sábado, 25 de outubro de 2026", hora: "20:30" };
const tipos: TipoCartaPendencia[] = ["pending_nudge", "pending_close"];

test("as doze cartas (6 idiomas × 2 momentos) passam na porta de saída do ADR-015", () => {
  for (const idioma of IDIOMAS_CARTA) {
    for (const tipo of tipos) {
      const c = cartaPendencia(tipo, idioma, dados);
      const g = outboundGate(c.corpo);
      assert.ok(g.ok, `${idioma}/${tipo} barrada: ${g.ok ? "" : g.motivo}`);
      assert.equal(motivoDeBloqueio(c.corpo), null, `${idioma}/${tipo}: ${motivoDeBloqueio(c.corpo)}`);
      assert.ok(c.corpo.includes("MONAK") && c.corpo.includes("20:30") && c.corpo.includes("Marie"), `${idioma}/${tipo} sem os dados da reserva`);
      assert.ok(c.assunto.includes("MONAK"));
      assert.ok(/Aria · The World Keys$/.test(c.corpo.trim()));
    }
  }
});

test("nunca promete mesa, confirmação nem prazo de terceiro; nunca expõe processo", () => {
  const proibido = [/confirm(ed|ada|ée|ata|iert)\b.*\bsoon|shortly|em breve|bientôt|pronto\b/i, /24 ?h/, /restaurant (will|has not|didn't|did not)/i, /não respondeu|n'a pas répondu|no respondió|non ha risposto/i, /escal|registered|registrei|flagged/i, /SLA|ticket|fila|queue/i];
  for (const idioma of IDIOMAS_CARTA) {
    for (const tipo of tipos) {
      const c = cartaPendencia(tipo, idioma, dados).corpo;
      for (const re of proibido) assert.doesNotMatch(c, re, `${idioma}/${tipo} contém ${re}`);
    }
  }
});

test("sem primeiro nome, a saudação fica genérica e a carta continua válida", () => {
  const c = cartaPendencia("pending_close", "fr", { ...dados, nome: "" });
  assert.ok(c.corpo.startsWith("Bonjour,"));
  assert.ok(outboundGate(c.corpo).ok);
});

test("idioma da carta: preferência registrada > país do telefone (só com +) > inglês; nunca o país do restaurante", () => {
  assert.equal(idiomaDaCarta({ idiomaPreferido: "Français", phone: "+5521999990000" }), "fr");
  assert.equal(idiomaDaCarta({ phone: "+5521999990000" }), "pt");
  assert.equal(idiomaDaCarta({ phone: "+33612345678" }), "fr");
  assert.equal(idiomaDaCarta({ phone: "+4915112345678" }), "de");
  assert.equal(idiomaDaCarta({ phone: "21999990000" }), "en", "sem + o país é incerto: inglês");
  assert.equal(idiomaDaCarta({ phone: null }), "en");
});

test("idioma desconhecido degrada para inglês em vez de falhar", () => {
  const c = cartaPendencia("pending_nudge", "xx" as never, dados);
  assert.equal(c.idioma, "en");
  assert.ok(c.corpo.includes("Hello Marie,"));
});
