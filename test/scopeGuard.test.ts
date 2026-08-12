import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicOutOfScope, parseScopeVerdict } from "../src/scopeGuard.js";

test("bloqueia remetentes de plataformas de email em massa", () => {
  assert.ok(deterministicOutOfScope({ from: "campaign@mailchimp.com" }));
  assert.ok(deterministicOutOfScope({ from: "bounce@bounce.sendgrid.net" })); // subdomínio
  assert.ok(deterministicOutOfScope({ from: "no-reply@e.rdstation.com.br" }));
  assert.ok(deterministicOutOfScope({ from: "x@mail.beehiiv.com" }));
});

test("bloqueia caixas de marketing/notificação pelo localpart", () => {
  assert.ok(deterministicOutOfScope({ from: "newsletter@algumsite.com" }));
  assert.ok(deterministicOutOfScope({ from: "marketing@fornecedor.com.br" }));
  assert.ok(deterministicOutOfScope({ from: "promocoes@loja.com" }));
  assert.ok(deterministicOutOfScope({ from: "notifications@saas.io" }));
  assert.ok(deterministicOutOfScope({ from: "news2@portal.com" }));
});

test("bloqueia corpo com rodapé de email em massa mesmo sem headers", () => {
  assert.ok(
    deterministicOutOfScope({ from: "hi@startup.com", text: "Confira nossas novidades!\n\nClique aqui para cancelar sua inscrição." }),
  );
  assert.ok(deterministicOutOfScope({ text: "To unsubscribe click here" }));
  assert.ok(deterministicOutOfScope({ text: "View this email in your browser" }));
  assert.ok(deterministicOutOfScope({ text: "Para deixar de receber estes emails, acesse o link." }));
});

test("bloqueia relatórios automáticos de serviço pelo assunto", () => {
  assert.ok(deterministicOutOfScope({ from: "x@google.com", subject: "Report domain: theworldkeys.com Submitter: google.com Report-ID: 123" }));
  assert.ok(deterministicOutOfScope({ subject: "DMARC Aggregate Report" }));
  assert.ok(deterministicOutOfScope({ subject: "SMTP TLS Report for theworldkeys.com" }));
  assert.ok(deterministicOutOfScope({ subject: "Delivery Status Notification (Failure)" }));
  assert.ok(deterministicOutOfScope({ subject: "Seu relatório automático semanal" }));
});

test("NÃO bloqueia clientes e restaurantes legítimos (sem falso positivo)", () => {
  // Caixas ambíguas de estabelecimento não são bloqueadas na camada determinística.
  assert.equal(deterministicOutOfScope({ from: "contato@restaurantecontraste.com" }), null);
  assert.equal(deterministicOutOfScope({ from: "reservas@trattoria.it" }), null);
  assert.equal(deterministicOutOfScope({ from: "info@bistro.fr" }), null);
  assert.equal(deterministicOutOfScope({ from: "financeiro@parceiro.com" }), null);
  assert.equal(
    deterministicOutOfScope({ from: "maria@gmail.com", subject: "Reserva para sábado", text: "Olá, gostaria de reservar uma mesa para 4 pessoas no sábado." }),
    null,
  );
  // Cliente falando de "marketing" do restaurante dele — palavra sensível no
  // corpo, mas sem marcador de massa → NÃO bloqueia (decide o classificador).
  assert.equal(
    deterministicOutOfScope({ from: "dono@meurestaurante.com", text: "Quero entender como funciona o marketing da minha página na plataforma." }),
    null,
  );
  // Restaurante respondendo à notificação de reserva — JAMAIS bloquear.
  assert.equal(
    deterministicOutOfScope({
      from: "lucasrooftop@gmail.com",
      subject: "Re: Pending Request - Reservation TAR50HQX",
      text: "Hi! Thank you for your reservation. Would it be possible to move it to 6:00 PM or 8:00 PM instead?",
    }),
    null,
  );
});

test("parseScopeVerdict: interpreta JSON e falha em ABERTO", () => {
  assert.deepEqual(parseScopeVerdict('{"in_scope": false, "reason": "newsletter"}'), { inScope: false, reason: "newsletter" });
  assert.equal(parseScopeVerdict('{"in_scope": true}').inScope, true);
  // JSON cercado de texto/código
  assert.equal(parseScopeVerdict('Claro:\n```json\n{"in_scope": false, "reason": "marketing"}\n```').inScope, false);
  // Respostas inválidas → mantém no escopo (não cala cliente por erro)
  assert.equal(parseScopeVerdict("").inScope, true);
  assert.equal(parseScopeVerdict("não sei dizer").inScope, true);
  assert.equal(parseScopeVerdict('{"foo": 1}').inScope, true);
});
