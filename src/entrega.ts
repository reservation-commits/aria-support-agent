/**
 * entrega.ts — o caminho ÚNICO entre "o modelo escreveu" e "o cliente recebe".
 *
 * Os dois canais (WhatsApp e e-mail) passam por aqui:
 *   escreve → revisa (regras + leitura semântica) → se reprovou, REESCREVE com os motivos → revisa de
 *   novo → se ainda reprovou, uma TERCEIRA tentativa em modo estrito (carta curta, estrutura fixa) →
 *   se ainda assim reprovou, a CARTA DE ESPERA determinística com compromisso registrado (ADR-019) →
 *   só se nem ela passar pela porta, RETÉM: nada sai, o painel recebe o rascunho e abre escalação.
 *   Carta errada em nome da marca é pior que carta atrasada (ADR-015, fail-closed) — e carta nenhuma
 *   em nome da marca é pior que uma carta de espera honesta (ADR-019, 28/10/2026).
 *
 * v24 (ADR-019): a decisão de SILÊNCIO do modelo ([[SILENCIO]]) é silêncio, não resposta retida —
 * até 27/10 virava escalação RESPONDER com o motivo "marcador de silêncio" (caso Pierluigi, 28/10).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./claude.js";
import type { AgentIdentity } from "./identity.js";
import { logEscalationAcionavel } from "./db.js";
import { donoPadrao, prefixoResponder, resumoResponder } from "./escalacaoRegra.js";
import { logScopeBlock } from "./dashboard/logger.js";
import { registrarPrecheck, revisarResposta } from "./revisao.js";
import type { Destinatario } from "./juizRegua.js";
import { anexarContextoEmail, compromissoDesteTurno, registrarCompromisso, type ContextoEmail } from "./compromissosDb.js";
import { containsSilenceMarker, idiomaProvavel, outboundGate } from "./format.js";
import { languageForPhone, type BaseLang } from "./locale.js";
import { cartaFallback, dataPorExtenso, proximoDiaUtil } from "./fallbackCarta.js";

export type ResultadoEntrega = {
  reply: string | null;
  updatedHistory: Anthropic.MessageParam[];
  retida?: { motivos: string[]; tentativas: number };
  reescrita?: boolean;
  /** v24: o modelo decidiu não responder (ruído) — não é retenção. */
  silencio?: boolean;
  /** v24: saiu a carta de espera determinística com compromisso registrado para `due`. */
  fallback?: { due: string; motivos: string[] };
};

const IDIOMAS: BaseLang[] = ["pt", "en", "es", "fr", "it", "de"];

function idiomaBase(entrada: string, chatId: string, channel: "whatsapp" | "email"): BaseLang {
  const d = idiomaProvavel(entrada);
  if (d && (IDIOMAS as string[]).includes(d)) return d as BaseLang;
  return channel === "whatsapp" ? languageForPhone(`+${chatId.replace(/\D/g, "")}`) : "en";
}

function pedidoDeReescrita(motivos: string[], compromisso: string | null, destinatario: Destinatario = "cliente"): Anthropic.MessageParam {
  if (destinatario === "estabelecimento") {
    return {
      role: "user",
      content: [{
        type: "text",
        text:
          "[Sistema: revisão interna antes do envio — a sua resposta anterior ao ESTABELECIMENTO não foi enviada. " +
          `Motivos (com os trechos exatos): ${motivos.join("; ")}. ` +
          "Reescreva a carta à casa corrigindo isso: sem nomes de ferramenta ou sistema; sem telefone ou e-mail do cliente; " +
          "diga o estado da reserva, o que acontece com o cliente agora e como a casa age (o link do pedido); no idioma em que a casa escreveu. " +
          "Responda SÓ com a carta final.]",
      }],
    };
  }
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "[Sistema: revisão interna antes do envio — a sua resposta anterior NÃO foi enviada ao cliente. " +
          `Motivos (com os trechos exatos): ${motivos.join("; ")}. ` +
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

/** v24: terceira e última tentativa do modelo — estrutura fixa e curta, sem espaço para o erro voltar. */
function pedidoEstrito(motivos: string[], compromisso: string | null, destinatario: Destinatario): Anthropic.MessageParam {
  const alvo = destinatario === "estabelecimento" ? "a casa" : "o cliente";
  return {
    role: "user",
    content: [{
      type: "text",
      text:
        "[Sistema: TERCEIRA revisão interna — as duas versões anteriores não foram enviadas. " +
        `Motivos acumulados: ${motivos.join("; ")}. ` +
        `Escreva agora uma carta CURTA (no máximo 5 frases) para ${alvo}, com esta estrutura obrigatória: ` +
        "(1) saudação; (2) o que já está feito, só fatos; (3) o que o destinatário recebe automaticamente ou o estado atual do pedido; (4) fecho cordial. " +
        (compromisso ? `A única data permitida é ${compromisso}. ` : "PROIBIDO: qualquer data, prazo ou 'em breve'. ") +
        "PROIBIDO: processo, fila, equipe, sistema, 'registrei', 'escalei', nomes de ferramenta, pedido de desculpas em série. " +
        "No idioma exato da mensagem recebida. Responda SÓ com a carta.]",
    }],
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
  /** cliente (padrão) ou estabelecimento — muda a régua da revisão e a instrução de reescrita. */
  destinatario?: Destinatario;
}): Promise<ResultadoEntrega> {
  const destinatario: Destinatario = p.destinatario ?? "cliente";
  const primeiro = await runAgent([...p.history, ...p.seed], p.userMsg, p.identity);
  let historico = primeiro.updatedHistory;

  // v24 (ADR-019): silêncio é decisão, não resposta retida. Fica registrado no painel (camada semântica),
  // com o que o modelo escreveu depois do marcador — nada disso vai ao destinatário.
  if (containsSilenceMarker(primeiro.reply)) {
    const resto = primeiro.reply.replace(/\[{0,2}\s*sil[êe]ncio\s*\]{0,2}/gi, "").replace(/\s+/g, " ").trim();
    void logScopeBlock({
      chatId: p.chatId,
      channel: p.channel,
      sender: p.sender,
      subject: p.subject ?? null,
      layer: "semantic",
      reason: `silêncio decidido pelo modelo${resto ? `: ${resto.slice(0, 220)}` : ""}`.slice(0, 500),
      snippet: p.entrada.slice(0, 300),
    }).catch(() => {});
    return { reply: null, updatedHistory: historico, silencio: true };
  }

  let clean = p.sanitize(primeiro.reply);
  if (!clean) return { reply: null, updatedHistory: historico };

  // Compromisso registrado neste turno (tool registrar_compromisso) libera a data NOSSA na carta.
  const comp = await compromissoDesteTurno(p.chatId);
  if (comp && p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
  const rev1 = await revisarResposta({ resposta: clean, entrada: p.entrada, channel: p.channel, chatId: p.chatId, tentativa: 1, compromisso: comp?.due ?? null, destinatario });
  if (rev1.ok) return { reply: clean, updatedHistory: historico };

  console.warn(`[entrega] ${p.channel} ${p.chatId}: reprovada (${rev1.origem}) — ${rev1.motivos.join("; ")} → reescrevendo`);
  const segundo = await runAgent(historico, pedidoDeReescrita(rev1.motivos, comp?.due ?? null, destinatario), p.identity);
  let compAtual = comp ?? (await compromissoDesteTurno(p.chatId));
  if (compAtual && !comp && p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
  historico = segundo.updatedHistory;
  clean = p.sanitize(segundo.reply);
  if (clean) {
    const rev2 = await revisarResposta({ resposta: clean, entrada: p.entrada, channel: p.channel, chatId: p.chatId, tentativa: 2, compromisso: compAtual?.due ?? null, destinatario });
    if (rev2.ok) return { reply: clean, updatedHistory: historico, reescrita: true };
    rev1.motivos.push(...rev2.motivos.map((m) => `2ª: ${m}`));
  } else {
    rev1.motivos.push("2ª: resposta vazia");
  }

  // v24: terceira tentativa, em modo estrito.
  console.warn(`[entrega] ${p.channel} ${p.chatId}: reprovada de novo → terceira tentativa (modo estrito)`);
  const terceiro = await runAgent(historico, pedidoEstrito(rev1.motivos, compAtual?.due ?? null, destinatario), p.identity);
  compAtual = compAtual ?? (await compromissoDesteTurno(p.chatId));
  if (compAtual && !comp && p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
  historico = terceiro.updatedHistory;
  clean = p.sanitize(terceiro.reply);
  if (clean) {
    const rev3 = await revisarResposta({ resposta: clean, entrada: p.entrada, channel: p.channel, chatId: p.chatId, tentativa: 3, compromisso: compAtual?.due ?? null, destinatario });
    if (rev3.ok) return { reply: clean, updatedHistory: historico, reescrita: true };
    rev1.motivos.push(...rev3.motivos.map((m) => `3ª: ${m}`));
  } else {
    rev1.motivos.push("3ª: resposta vazia");
  }
  const motivos = rev1.motivos;

  // v24 (ADR-019): carta de espera determinística, com a data registrada como compromisso — a Aria volta
  // no dia (compromissos.ts) com a resposta de verdade. O destinatário nunca fica sem carta por culpa nossa.
  try {
    const idioma = idiomaBase(p.entrada, p.chatId, p.channel);
    const due = proximoDiaUtil(new Date());
    const carta = cartaFallback(destinatario, idioma, { data: dataPorExtenso(due, idioma) });
    const porta = outboundGate(carta, p.entrada, { prazoPermitido: true });
    if (porta.ok) {
      await registrarCompromisso({
        chatId: p.chatId,
        channel: p.channel,
        due,
        oQue: `responder ${destinatario === "estabelecimento" ? "à casa" : "ao cliente"} de verdade (carta de espera automática após 3 revisões reprovadas)`,
        reservationCode: null,
      });
      if (p.emailCtx) await anexarContextoEmail(p.chatId, p.emailCtx).catch(() => {});
      await registrarPrecheck({ chatId: p.chatId, channel: p.channel, tentativa: 4, aprovado: true, origem: "fallback", motivos, snippet: carta });
      void logScopeBlock({
        chatId: p.chatId,
        channel: p.channel,
        sender: p.sender,
        subject: p.subject ?? null,
        layer: "outbound",
        reason: `3 rascunhos reprovados; carta de espera enviada com compromisso para ${due}: ${motivos.join("; ")}`.slice(0, 500),
        snippet: (clean || primeiro.reply).slice(0, 300),
      }).catch(() => {});
      console.warn(`[entrega] ${p.channel} ${p.chatId}: carta de espera (${idioma}) com compromisso para ${due} — ${motivos.join("; ")}`);
      return { reply: carta, updatedHistory: historico, fallback: { due, motivos } };
    }
    motivos.push(`carta de espera retida pela porta: ${porta.motivo}`);
  } catch (err) {
    motivos.push(`carta de espera falhou: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Retida: fail-closed com registro e escalação — nunca silêncio.
  console.warn(`[entrega] ${p.channel} ${p.chatId}: RETIDA após três tentativas e carta de espera — ${motivos.join("; ")}`);
  void logScopeBlock({
    chatId: p.chatId,
    channel: p.channel,
    sender: p.sender,
    subject: p.subject ?? null,
    layer: "outbound",
    reason: `retida após reescrita: ${motivos.join("; ")}`.slice(0, 500),
    snippet: (clean || primeiro.reply).slice(0, 300),
  }).catch(() => {});
  // v22 (plano B4): escalação ACIONÁVEL, com dono e uma por conversa — o destinatário ficou sem resposta
  // e alguém precisa responder pelo painel. Os motivos completos estão em aria_scope_blocks (acima).
  await logEscalationAcionavel({
    tag: "RESPONDER",
    summary: resumoResponder(p.chatId, p.channel, `resposta ${destinatario === "estabelecimento" ? "ao ESTABELECIMENTO" : "ao cliente"} retida três vezes na revisão e a carta de espera não passou (${motivos.slice(0, 2).join("; ").slice(0, 120)})`),
    prefixo: prefixoResponder(p.chatId),
    dono: donoPadrao("RESPONDER"),
    phone: p.channel === "whatsapp" ? p.chatId : "",
  }).catch(() => {});
  return { reply: null, updatedHistory: historico, retida: { motivos, tentativas: 3 } };
}
