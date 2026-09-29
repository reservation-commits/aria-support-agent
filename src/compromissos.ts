/**
 * compromissos.ts — a Aria cumpre a data que prometeu.
 *
 * Fecha o ciclo do ADR-015: a carta só pode dizer "volto a você até sexta" se a data foi
 * registrada (tool registrar_compromisso) — e, nesse dia, ESTE módulo abre a conversa e a
 * Aria escreve ao cliente com o que existe: confirmação, alternativas de casas que
 * confirmam pedidos, ou o que já está feito. A resposta passa pelo mesmo caminho de
 * entrega (revisão dupla, reescrita, retenção). Nada é enviado sem revisão.
 *
 * Canal: e-mail responde na mesma thread (contexto guardado no registro). WhatsApp só se
 * a janela de 24 h estiver aberta; fechada, vira escalação ALTA para envio humano —
 * mensagem fora da janela exige template, e não existe template de "voltei a você".
 */

import { config } from "./config.js";
import { logEscalation } from "./db.js";
import { logMessage } from "./dashboard/logger.js";
import { isBusy } from "./conversationQueue.js";
import { enviarEmailProativo } from "./emailChannel.js";
import { responderComRevisao } from "./entrega.js";
import { sanitizeEmailReply, sanitizeReply, idiomaProvavel } from "./format.js";
import { emailIdentity, whatsappIdentity, EMAIL_CHAT_PREFIX } from "./identity.js";
import { getOrRestoreHistory, setHistory } from "./sessions.js";
import { sendText } from "./whatsapp.js";
import { compromissosVencendo, concluir, reivindicar, ultimaEntrada, type Compromisso } from "./compromissosDb.js";

const JANELA_WHATSAPP_MS = 23 * 3_600_000; // folga de 1h sobre as 24h da Meta

function mensagemDoSistema(c: Compromisso): string {
  return (
    `[Sistema: COMPROMISSO COM O CLIENTE VENCE HOJE (${c.due_at}). Você prometeu: "${c.o_que ?? "voltar com uma resposta"}"` +
    (c.reservation_code ? ` (reserva ${c.reservation_code})` : "") +
    ". Consulte o estado atual pelas ferramentas e escreva ao cliente AGORA, no idioma dele, com o que existe: " +
    "confirmação se houver; senão, o que já está feito e alternativas concretas em casas que confirmam pedidos. " +
    "Não conte o que fez por dentro. Só cite nova data se registrar novo compromisso. Responda só com a carta.]"
  );
}

async function cumprir(c: Compromisso): Promise<void> {
  const chatId = c.chat_id;
  const entrada = await ultimaEntrada(chatId);
  const identity = c.channel === "email" ? emailIdentity(chatId.replace(EMAIL_CHAT_PREFIX, "")) : whatsappIdentity(chatId);
  const history = await getOrRestoreHistory(chatId);

  const r = await responderComRevisao({
    history,
    seed: [],
    userMsg: { role: "user", content: [{ type: "text", text: mensagemDoSistema(c) }] },
    identity,
    entrada: entrada?.content ?? "",
    channel: c.channel,
    chatId,
    sender: c.channel === "email" ? (c.email_ctx?.to ?? chatId.replace(EMAIL_CHAT_PREFIX, "")) : chatId,
    subject: c.email_ctx?.subject ?? null,
    sanitize: c.channel === "email" ? sanitizeEmailReply : sanitizeReply,
  });
  setHistory(chatId, r.updatedHistory);

  if (!r.reply) {
    await concluir(c.id, "retido");
    await logEscalation({
      tag: "ALTA",
      summary: `[compromisso] vence hoje (${c.due_at}) e a resposta foi RETIDA na revisão — o cliente espera o retorno prometido. Responder pelo painel.`,
      phone: c.channel === "whatsapp" ? chatId : "",
      reservationCode: c.reservation_code,
    }).catch(() => {});
    return;
  }

  let ok = false;
  if (c.channel === "email") {
    const to = c.email_ctx?.to ?? chatId.replace(EMAIL_CHAT_PREFIX, "");
    ok = await enviarEmailProativo(
      {
        to,
        subject: c.email_ctx?.subject ?? null,
        threadId: c.email_ctx?.threadId ?? null,
        messageIdHeader: c.email_ctx?.messageIdHeader ?? null,
        references: c.email_ctx?.references ?? null,
        gmailMessageId: c.email_ctx?.gmailMessageId ?? null,
        mailbox: c.email_ctx?.mailbox ?? config.email.address,
      },
      r.reply,
      idiomaProvavel(entrada?.content ?? "") ?? undefined,
    );
  } else {
    const aberta = !!entrada && Date.now() - new Date(entrada.created_at).getTime() < JANELA_WHATSAPP_MS;
    if (!aberta) {
      await concluir(c.id, "sem_canal");
      await logEscalation({
        tag: "ALTA",
        summary: `[compromisso] vence hoje (${c.due_at}) mas a janela de 24h do WhatsApp está fechada — enviar manualmente. Carta pronta no histórico da conversa.`,
        phone: chatId,
        reservationCode: c.reservation_code,
      }).catch(() => {});
      return;
    }
    ok = await sendText(chatId, r.reply);
  }

  if (ok) {
    await concluir(c.id, "cumprido");
    void logMessage({ chatId, pushName: null, direction: "outbound", content: r.reply }).catch(() => {});
    console.log(`[compromisso] cumprido · ${c.channel} · ${c.due_at}${c.reservation_code ? ` · reserva ${c.reservation_code}` : ""}`);
  } else {
    await logEscalation({ tag: "ALTA", summary: `[compromisso] vence hoje (${c.due_at}) e o envio falhou no canal ${c.channel}`, phone: c.channel === "whatsapp" ? chatId : "", reservationCode: c.reservation_code }).catch(() => {});
  }
}

export async function sweepCompromissos(): Promise<void> {
  let lista: Compromisso[] = [];
  try {
    lista = await compromissosVencendo();
  } catch (err) {
    console.warn("[compromisso] leitura falhou:", err instanceof Error ? err.message : err);
    return;
  }
  for (const c of lista) {
    if (isBusy(c.chat_id)) continue; // conversa em andamento: tenta na próxima varredura
    if (!(await reivindicar(c.id))) continue;
    try {
      await cumprir(c);
    } catch (err) {
      console.error("[compromisso] falha ao cumprir:", err instanceof Error ? err.message : err);
      await logEscalation({ tag: "ALTA", summary: `[compromisso] vence hoje (${c.due_at}) e a execução falhou: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`, phone: "", reservationCode: c.reservation_code }).catch(() => {});
    }
  }
}

export function startCompromissos(): void {
  setTimeout(() => {
    void sweepCompromissos();
    setInterval(() => void sweepCompromissos(), 30 * 60_000).unref();
  }, 90_000).unref();
  console.log("[compromisso] cumprimento de compromissos com data ativo (varredura a cada 30 min)");
}
