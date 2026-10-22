import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmacaoOptIn, detectarPedidoAcompanhamento, linkOptIn, mensagemProntaOptIn, mesmoNumero } from "../src/optInRegra.js";
import { detectConsentIntent } from "../src/consent.js";
import { outboundGate } from "../src/format.js";
import type { BaseLang } from "../src/locale.js";

const IDIOMAS: BaseLang[] = ["pt", "en", "es", "fr", "it", "de"];

test("v20 opt-in: a mensagem pronta de cada idioma é reconhecida, com o código e o idioma certos", () => {
  for (const l of IDIOMAS) {
    assert.deepEqual(detectarPedidoAcompanhamento(mensagemProntaOptIn(l, "BCW4FKAW")), { codigo: "BCW4FKAW", idioma: l }, l);
  }
});

test("v20 opt-in: códigos reais — só letras, só dígitos, misto", () => {
  assert.equal(detectarPedidoAcompanhamento("Olá! Quero acompanhar meu pedido XCYPHYAB pelo WhatsApp.")?.codigo, "XCYPHYAB");
  assert.equal(detectarPedidoAcompanhamento("Olá! Quero acompanhar meu pedido 27530174 pelo WhatsApp.")?.codigo, "27530174");
  assert.equal(detectarPedidoAcompanhamento("Hello! I would like to follow my request 9R8NRF48 on WhatsApp.")?.codigo, "9R8NRF48");
});

test("v20 opt-in: 'WHATSAPP' em maiúsculas tem 8 letras e não é código", () => {
  assert.equal(detectarPedidoAcompanhamento("QUERO ACOMPANHAR PELO WHATSAPP"), null);
  assert.deepEqual(detectarPedidoAcompanhamento("QUERO ACOMPANHAR MEU PEDIDO BCW4FKAW PELO WHATSAPP"), { codigo: "BCW4FKAW", idioma: "pt" });
});

test("v20 opt-in: conservador — sem WhatsApp, sem código, com dois códigos ou conversa longa não é opt-in", () => {
  assert.equal(detectarPedidoAcompanhamento("Olá! Quero acompanhar meu pedido BCW4FKAW."), null);
  assert.equal(detectarPedidoAcompanhamento("Olá! Quero acompanhar meu pedido pelo WhatsApp."), null);
  assert.equal(detectarPedidoAcompanhamento("Pedidos BCW4FKAW e 9R8NRF48 pelo WhatsApp"), null);
  assert.equal(detectarPedidoAcompanhamento("pedido bcw4fkaw pelo whatsapp"), null); // código só vale como foi enviado: maiúsculas
  assert.equal(detectarPedidoAcompanhamento(""), null);
  assert.equal(detectarPedidoAcompanhamento(null), null);
  const longa = "Olá, fiz o pedido BCW4FKAW e queria saber pelo WhatsApp se o restaurante aceita crianças, se tem estacionamento, se posso levar bolo, se a mesa é na varanda e se dá para mudar o horário para mais cedo porque o voo chega tarde.";
  assert.equal(detectarPedidoAcompanhamento(longa), null);
});

test("v20 opt-in: idioma desconhecido não impede o opt-in (o chamador cai no país do telefone)", () => {
  assert.deepEqual(detectarPedidoAcompanhamento("BCW4FKAW WhatsApp"), { codigo: "BCW4FKAW", idioma: null });
});

test("v20 opt-in: PARAR e VOLTAR continuam sendo comandos de consentimento, não opt-in", () => {
  for (const t of ["PARAR", "stop", "VOLTAR"]) {
    assert.equal(detectarPedidoAcompanhamento(t), null);
    assert.notEqual(detectConsentIntent(t), null);
  }
  // e a mensagem pronta não é confundida com PARAR/VOLTAR
  for (const l of IDIOMAS) assert.equal(detectConsentIntent(mensagemProntaOptIn(l, "BCW4FKAW")), null, l);
});

test("v20 opt-in: a confirmação de cada idioma passa pela porta de saída, no idioma da mensagem recebida", () => {
  for (const l of IDIOMAS) {
    const entrada = mensagemProntaOptIn(l, "BCW4FKAW");
    const resposta = confirmacaoOptIn(l, "MONAK");
    assert.deepEqual(outboundGate(resposta, entrada), { ok: true }, `${l}: ${resposta}`);
    assert.match(resposta, /\*[^*]+:\* MONAK/);
    assert.match(resposta, /Aria · The World Keys$/);
  }
});

test("v20 opt-in: a palavra de saída anunciada na confirmação é reconhecida como opt-out", () => {
  for (const l of IDIOMAS) {
    const palavra = confirmacaoOptIn(l, "MONAK").match(/\b(PARAR|STOP|BAJA)\b/)?.[1];
    assert.ok(palavra, l);
    assert.equal(detectConsentIntent(palavra!), "opt_out", `${l}: ${palavra}`);
  }
});

test("v20 opt-in: confirmação sem nome de casa não deixa rótulo vazio; nada de prazo, mesa ou confirmação", () => {
  for (const l of IDIOMAS) {
    const semCasa = confirmacaoOptIn(l, "  ");
    assert.doesNotMatch(semCasa, /\*/);
    const texto = confirmacaoOptIn(l, "MONAK").toLowerCase();
    for (const proibido of ["confirm", "garant", "guarant", "mesa ", "table", "tavolo", "tisch", "horas", "hours", "heures", "stunden", "ore "]) {
      assert.ok(!texto.includes(proibido), `${l} contém "${proibido}": ${texto}`);
    }
  }
});

test("v20 opt-in: link do botão — número só com dígitos e mensagem codificada que volta inteira", () => {
  const link = linkOptIn("+55 21 90000-0000", "fr", "BCW4FKAW");
  assert.ok(link.startsWith("https://wa.me/5521900000000?text="));
  const texto = decodeURIComponent(link.split("?text=")[1]);
  assert.deepEqual(detectarPedidoAcompanhamento(texto), { codigo: "BCW4FKAW", idioma: "fr" });
});

test("v20 opt-in: mesmo número da conta, com ou sem formatação", () => {
  assert.equal(mesmoNumero("+351912345678", "+351 912 345 678"), true);
  assert.equal(mesmoNumero("+351912345678", "+351912345679"), false);
  assert.equal(mesmoNumero("+351912345678", null), false);
});

test("v20 opt-in: preferência de idioma — inglês é o idioma do NOSSO e-mail, não do cliente", async () => {
  const { idiomaPreferidoDoOptIn } = await import("../src/optInRegra.js");
  assert.equal(idiomaPreferidoDoOptIn("en"), null); // o template sai pelo país do telefone
  assert.equal(idiomaPreferidoDoOptIn(null), null);
  assert.equal(idiomaPreferidoDoOptIn("fr"), "fr");
  assert.equal(idiomaPreferidoDoOptIn("pt"), "pt");
});
