import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmailHtml } from "../src/emailTemplate.js";

test("renderEmailHtml: embala o texto com a marca TWK", () => {
  const html = renderEmailHtml("Prezado Ricardo,\n\nSua reserva está confirmada.");
  assert.ok(html.includes("THE&nbsp;WORLD&nbsp;KEYS"), "wordmark presente");
  assert.ok(html.includes("#c9a96e"), "ouro da marca presente");
  assert.ok(html.includes("#070b10"), "ink da marca presente");
  assert.ok(html.includes("Prezado Ricardo,"));
  assert.ok(html.includes("Sua reserva está confirmada."));
  assert.ok(/<p[^>]*>Prezado Ricardo,<\/p>/.test(html), "parágrafos separados");
});

test("renderEmailHtml: escapa HTML do corpo (anti-injeção)", () => {
  const html = renderEmailHtml('Olá <script>alert("x")</script> & "aspas"');
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp; &quot;aspas&quot;"));
});

test("renderEmailHtml: transforma URLs em links dourados", () => {
  const html = renderEmailHtml(
    "Reserve aqui:\n\nhttps://theworldkeys.com/hospitality/contraste-milano/\n\nOu gerencie em theworldkeys.com/users/reservations",
  );
  assert.ok(html.includes('href="https://theworldkeys.com/hospitality/contraste-milano/"'));
  assert.ok(html.includes('href="https://theworldkeys.com/users/reservations"'), "domínio sem protocolo vira link");
  assert.ok(html.includes("#9e7c48"), "links no gold-dark");
});

test("renderEmailHtml: quebra simples vira <br/>, dupla vira parágrafo", () => {
  const html = renderEmailHtml("Linha um\nLinha dois\n\nOutro parágrafo");
  assert.ok(html.includes("Linha um<br/>Linha dois"));
  assert.ok((html.match(/<p /g) || []).length >= 2);
});

test("renderEmailHtml: preheader usa a primeira linha", () => {
  const html = renderEmailHtml("Sua mesa no Belcanto está garantida.\n\nDetalhes abaixo.");
  assert.ok(html.includes("Sua mesa no Belcanto está garantida."));
});

// ─── Idioma do "chrome" do email ──────────────────────────────────────────────

import { detectLang } from "../src/emailTemplate.js";

test("detectLang: reconhece PT/EN/ES/FR pelo fecho + saudação do concierge", () => {
  assert.equal(detectLang("Prezado Ricardo, sua reserva está confirmada. Com prazer em servir, Aria"), "pt");
  assert.equal(detectLang("Dear Marlon, your reservation is confirmed. With pleasure, Aria"), "en");
  assert.equal(detectLang("Estimado señor, su reserva está confirmada. Con mucho gusto, Aria"), "es");
  assert.equal(detectLang("Cher Marlon, votre réservation est confirmée. Avec plaisir, Aria"), "fr");
});

test("detectLang: reconhece italiano (cenário Ristorante Al Moro)", () => {
  assert.equal(
    detectLang("Gentile Team del Ristorante Al Moro, grazie per il vostro messaggio. Con piacere, Aria"),
    "it",
  );
  assert.equal(
    detectLang("Buongiorno, la prenotazione è confermata. Restiamo a disposizione. Grazie."),
    "it",
  );
});

test("detectLang: italiano não é confundido com espanhol nem francês", () => {
  assert.equal(detectLang("Estimado señor, su reserva está confirmada. Con mucho gusto, Aria"), "es");
  assert.equal(detectLang("Cher Marlon, votre réservation est confirmée. Avec plaisir, Aria"), "fr");
});

test("detectLang: default PT quando ambíguo/vazio", () => {
  assert.equal(detectLang(""), "pt");
  assert.equal(detectLang("TWK-9F2K11AB"), "pt");
});

test("renderEmailHtml: nota de resposta segue o idioma do corpo", () => {
  const en = renderEmailHtml("Dear Marlon, your table is confirmed.\n\nWith pleasure,\nAria");
  assert.ok(en.includes("reply to this email"), "rodapé em inglês");
  assert.ok(!en.includes("responder este email"), "sem português no rodapé de email inglês");

  const fr = renderEmailHtml("Cher Marlon, votre table est confirmée.\n\nAvec plaisir,\nAria");
  assert.ok(fr.includes("cet email"), "rodapé em francês");

  const pt = renderEmailHtml("Prezado Marlon, sua mesa está confirmada.\n\nCom prazer em servir,\nAria");
  assert.ok(pt.includes("responder este email"));

  const it = renderEmailHtml("Gentile Team, la prenotazione è confermata.\n\nCon piacere,\nAria");
  assert.ok(it.includes("rispondere a questa email"), "rodapé em italiano");
  assert.ok(it.includes("PRENOTAZIONI"), "tagline em italiano");
});

test("renderEmailHtml: override de idioma explícito vence a detecção", () => {
  const html = renderEmailHtml("texto ambíguo qualquer", "fr");
  assert.ok(html.includes("cet email"));
});

test("renderEmailHtml: ícones de contato hospedados quando há iconBaseUrl", () => {
  const html = renderEmailHtml("Prezado cliente, com prazer em servir, Aria", "pt", "https://aria.example.com/");
  assert.ok(html.includes('src="https://aria.example.com/icons/whatsapp.png"'), "ícone WhatsApp");
  assert.ok(html.includes('src="https://aria.example.com/icons/email.png"'));
  assert.ok(html.includes('src="https://aria.example.com/icons/site.png"'));
  assert.ok(html.includes('src="https://aria.example.com/icons/reservas.png"'));
  assert.ok(html.includes('href="https://wa.me/5521967841007"'), "link WhatsApp");
  assert.ok(html.includes('href="mailto:support@theworldkeys.com"'), "link email");
  assert.ok(html.includes('href="https://theworldkeys.com/"'), "link site");
  assert.ok(html.includes('href="https://theworldkeys.com/users/reservations"'), "link reservas");
  assert.ok(html.includes('alt="Reservas"'), "alt localizado pt");
  assert.ok(!html.includes("Explorar restaurantes"), "botões antigos removidos");
});

test("renderEmailHtml: fallback de emoji quando não há iconBaseUrl", () => {
  const html = renderEmailHtml("Dear guest, with pleasure, Aria");
  assert.ok(!html.includes("/icons/whatsapp.png"), "sem <img> quando não hospedado");
  assert.ok(html.includes('href="https://wa.me/5521967841007"'), "link WhatsApp presente");
  assert.ok(html.includes('href="mailto:support@theworldkeys.com"'));
  assert.ok(html.includes("Reservations"), "rótulo alt/emoji em inglês");
});

test("autolink: não transforma o domínio dentro de um endereço de email", () => {
  const html = renderEmailHtml("Fale conosco: support@theworldkeys.com\n\nOu acesse theworldkeys.com/users");
  assert.ok(html.includes("support@theworldkeys.com"), "email intacto");
  assert.ok(!/support@<a/.test(html), "não linkou o domínio do email");
  assert.ok(html.includes('href="https://theworldkeys.com/users"'), "URL solta continua virando link");
});
