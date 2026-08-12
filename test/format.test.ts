import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeReply } from "../src/format.js";

test("converte markdown padrão para markup do WhatsApp", () => {
  assert.equal(sanitizeReply("**reserva confirmada**"), "*reserva confirmada*");
  assert.equal(sanitizeReply("__The World Keys__"), "_The World Keys_");
  assert.equal(sanitizeReply("~~antigo~~"), "~antigo~");
});

test("remove emojis e pictogramas", () => {
  const out = sanitizeReply("Reserva confirmada 🎉👍🏽");
  assert.ok(!/\p{Extended_Pictographic}/u.test(out), "não deve restar emoji");
  assert.ok(out.includes("Reserva confirmada"));
});

test("colapsa linhas em branco excessivas", () => {
  assert.equal(sanitizeReply("a\n\n\n\nb"), "a\n\nb");
});

test("faz trim e nunca devolve espaços duplos", () => {
  const out = sanitizeReply("  olá    mundo  ");
  assert.equal(out, "olá mundo");
});

// ─── Nota interna / silêncio deliberado (incidente bucamario, ago/2026) ──────

import { looksLikeInternalNote } from "../src/format.js";

test("looksLikeInternalNote: pega o marcador [[SILENCIO]] e variações", () => {
  assert.ok(looksLikeInternalNote("[[SILENCIO]]"));
  assert.ok(looksLikeInternalNote("[silêncio]"));
  assert.ok(looksLikeInternalNote("SILENCIO"));
  assert.ok(looksLikeInternalNote(""));
  assert.ok(looksLikeInternalNote("   "));
});

test("looksLikeInternalNote: pega a nota exata do incidente bucamario", () => {
  assert.ok(
    looksLikeInternalNote("[Resposta vazia — mensagem automática repetida, sem novo conteúdo a atender.]"),
  );
});

test("looksLikeInternalNote: pega notas internas em prosa (casos reais do CSV)", () => {
  assert.ok(
    looksLikeInternalNote(
      "Esta mensagem é um recibo automático de cobrança (Stripe / Anthropic Ireland) e não contém nenhuma solicitação de um cliente da The World Keys.\n\nNenhuma resposta será enviada.",
    ),
  );
  assert.ok(
    looksLikeInternalNote(
      "Este email é um relatório automático de DMARC (autenticação de domínio) enviado pelo sistema do Google — não é uma mensagem de cliente.",
    ),
  );
  assert.ok(
    looksLikeInternalNote(
      "Este email não requer ação de atendimento ao cliente. Trata-se de uma notificação automática de nota de crédito.",
    ),
  );
});

test("looksLikeInternalNote: qualquer resposta que seja só um bloco [entre colchetes]", () => {
  assert.ok(looksLikeInternalNote("[Sem ação necessária — notificação de sistema.]"));
});

test("looksLikeInternalNote: NUNCA barra mensagens reais a clientes", () => {
  assert.ok(!looksLikeInternalNote("Prezado Ricardo,\n\nSua reserva TWK-AB12CD34 está confirmada.\n\nCom prazer em servir,\nAria · The World Keys"));
  assert.ok(!looksLikeInternalNote("Gentile Team del Ristorante Al Moro,\n\ngrazie per la vostra pronta risposta.\n\nCon piacere,\nAria"));
  assert.ok(!looksLikeInternalNote("Dear guest, your reservation [TWK-XX] is confirmed. With pleasure, Aria"));
  // Cliente citando um recibo/relatório: a frase-gatilho só conta no INÍCIO.
  assert.ok(
    !looksLikeInternalNote(
      "Prezado cliente, obrigada pelo retorno. Sobre a sua dúvida: aquele aviso que você recebeu é apenas um lembrete da plataforma. ".repeat(3) +
        "Não há ação de atendimento pendente do seu lado.",
    ),
  );
});
