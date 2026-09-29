/**
 * entrega.ts — o caminho ÚNICO entre "o modelo escreveu" e "o cliente recebe".
 *
 * Os dois canais (WhatsApp e e-mail) passam por aqui:
 *   escreve → revisa (regras + leitura semântica) → se reprovou, REESCREVE uma vez com os
 *   motivos → revisa de novo → se ainda reprovou, RETÉM: nada sai, o painel recebe o
 *   rascunho e o motivo, e abre escalação ALTA. Carta errada em nome da marca é pior que
 *   carta atrasada (ADR-015, fail-closed).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./claude.js";
import type { AgentIdentity } from "./identity.js";
import { logEscalation } from "./db.js";
import { logScopeBlock } from "./dashboard/logger.js";
import { revisarResposta } from "./revisao.js";
import { anexarContextoEmail, compromissoDesteTurno, type ContextoEmail } from "./compromissosDb.js";

export type ResultadoEntrega = {
  reply: string | null;
  updatedHistory: Anthropic.MessageParam[];
  retida?: { motivos: string[]; tentativas: number };
  reescrita?: boolean;
};

function pedidoDeReescrita(motivos: string[], compromisso: string | null): Anthropic.MessageParam {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "[Sistema: revisão interna antes do envio — a sua resposta anterior NÃO foi enviada ao cliente. " +
          `Motivos: ${motivos.join("; ")}. ` +
          (compromisso
            ? `Reescreva a carta inteira corrigindo isso. A única data permitida é a do seu compromisso registrado (${compromisso}); `
            : "Reescreva a carta inteira corrigindo isso: nenhum prazo, data ou 'até sexta/by Friday/d'ici vendredi' (se quiser dar uma data de retorno, registre antes com registrar_compromisso); ") +
          "nada sobre processo, fila, espera por terceiros ou o que você fez internamente; nenhum vocabulário de sistema; " +
          "no idioma exato da mensagem do cliente. Diga o que já está feito e o que ele recebe automaticamente. " +
          "Responda SÓ com a carta final, sem comentar esta revisão.]",
      },
    ],
  };
}

export async function responderComRevisao(p: {
  history: Anthropic.MessageParam[];
  seed: Anthropic.MessageParam[];
  userMsg: Anthropic.MessageParam;
  identity: AgentIdentity | null;
  entrada: string;
  channel: "whatsapp" | "email";
  chatId: string;
  sender: string;
  subject?: string | null;
  sanitize: (s: string) => string;
  /** E-mail: contexto de thread, guardado no compromisso para a Aria voltar na mesma conversa. */
  emailCtx?: ContextoEmail;
}): Promise<ResultadoEntrega> {
  const primeiro = await runAgent([...p.history, ...p.seed], p.userMsg, p.identity);
  let historico = primeiro.updatedHistory;
  let clean = p.sanitize(primeiro.reply);
  if (!clean) return { reply: null, updatedHistory: historico };

  // Compromisso registrado neste turno (tool registrar_compromisso) libera a data NOSSA na carta.
  const comp = await compromissoDesteTurno(p.chatId);
  if (comp && p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
  const rev1 = await revisarResposta({ resposta: clean, entrada: p.entrada, channel: p.channel, chatId: p.chatId, tentativa: 1, compromisso: comp?.due ?? null });
  if (rev1.ok) return { reply: clean, updatedHistory: historico };

  console.warn(`[entrega] ${p.channel} ${p.chatId}: reprovada (${rev1.origem}) — ${rev1.motivos.join("; ")} → reescrevendo`);
  const segundo = await runAgent(historico, pedidoDeReescrita(rev1.motivos, comp?.due ?? null), p.identity);
  const comp2 = comp ?? (await compromissoDesteTurno(p.chatId));
  if (comp2 && !comp && p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
  historico = segundo.updatedHistory;
  clean = p.sanitize(segundo.reply);
  if (clean) {
    const rev2 = await revisarResposta({ resposta: clean, entrada: p.entrada, channel: p.channel, chatId: p.chatId, tentativa: 2, compromisso: comp2?.due ?? null });
    if (rev2.ok) return { reply: clean, updatedHistory: historico, reescrita: true };
    rev1.motivos.push(...rev2.motivos.map((m) => `2ª: ${m}`));
  } else {
    rev1.motivos.push("2ª: resposta vazia");
  }

  // Retida: fail-closed com registro e escalação — nunca silêncio.
  const motivos = rev1.motivos;
  console.warn(`[entrega] ${p.channel} ${p.chatId}: RETIDA após reescrita — ${motivos.join("; ")}`);
  void logScopeBlock({
    chatId: p.chatId,
    channel: p.channel,
    sender: p.sender,
    subject: p.subject ?? null,
    layer: "outbound",
    reason: `retida após reescrita: ${motivos.join("; ")}`.slice(0, 500),
    snippet: (clean || primeiro.reply).slice(0, 300),
  }).catch(() => {});
  await logEscalation({
    tag: "ALTA",
    summary: `[revisao] resposta ao cliente RETIDA no canal ${p.channel} após reescrita — ${motivos.slice(0, 3).join("; ").slice(0, 200)}. O cliente NÃO recebeu resposta: responder pelo painel.`,
    phone: p.channel === "whatsapp" ? p.chatId : "",
  }).catch(() => {});
  return { reply: null, updatedHistory: historico, retida: { motivos, tentativas: 2 } };
}
