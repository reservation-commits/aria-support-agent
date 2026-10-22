import { test } from "node:test";
import assert from "node:assert/strict";
import { classificarEscalacao, donoPadrao, prefixoResponder, resumoResponder, TAGS_ACIONAVEIS } from "../src/escalacaoRegra.js";

test("avisos do juiz e do revisor indisponível são telemetria, não escalação", () => {
  assert.equal(classificarEscalacao({ tag: "ALTA", summary: "[juiz] 2 de 7 respostas das últimas 24h reprovaram na régua do ADR-015." }), "telemetria");
  assert.equal(classificarEscalacao({ tag: "ALTA", summary: "[revisao] revisor semântico indisponível (timeout) — respostas saindo só com a porta de regras" }), "telemetria");
});

test("o que pede uma pessoa é acionável: remoção, resposta retida, compromisso sem canal, modelo fora", () => {
  assert.equal(classificarEscalacao({ tag: "REMOCAO_LISTAGEM", summary: "LOFOTEN (31607) — estabelecimento solicita REMOÇÃO" }), "acionavel");
  assert.equal(classificarEscalacao({ tag: "RESPONDER", summary: resumoResponder("5521999990000", "whatsapp", "retida duas vezes") }), "acionavel");
  assert.equal(classificarEscalacao({ tag: "ALTA", summary: "[revisao] resposta ao cliente RETIDA no canal whatsapp após reescrita — … O cliente NÃO recebeu resposta: responder pelo painel." }), "acionavel");
  assert.equal(classificarEscalacao({ tag: "ALTA", summary: "[compromisso] vence hoje (2026-10-19) mas a janela de 24h do WhatsApp está fechada — enviar manualmente." }), "acionavel");
  assert.equal(classificarEscalacao({ tag: "URGENTE", summary: "[monitor] modelo sem resposta há 20 min" }), "acionavel");
});

test("ALTA genérica sem ação explícita no resumo é telemetria", () => {
  assert.equal(classificarEscalacao({ tag: "ALTA", summary: "qualquer aviso interno sem pedido de ação" }), "telemetria");
});

test("dono padrão: atendimento é do MAESTRO (ADR-016); infraestrutura sobe ao fundador", () => {
  assert.equal(donoPadrao("RESPONDER"), "MAESTRO");
  assert.equal(donoPadrao("REMOCAO_LISTAGEM"), "MAESTRO");
  assert.equal(donoPadrao("URGENTE"), "fundador");
});

test("RESPONDER: prefixo de dedup estável por conversa e resumo com a ação", () => {
  const chat = "email:cliente@exemplo.com";
  const r = resumoResponder(chat, "email", "a janela fechou");
  assert.ok(r.startsWith(prefixoResponder(chat)), "o resumo começa pelo prefixo de dedup");
  assert.match(r, /Ação: responder/);
  assert.equal(prefixoResponder(chat), prefixoResponder(chat));
  assert.ok((TAGS_ACIONAVEIS as readonly string[]).includes("RESPONDER"));
});
