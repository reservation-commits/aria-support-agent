/**
 * consent.ts
 *
 * Detecção de intenção de opt-out / opt-in de mensagens proativas (lembretes e
 * convites de avaliação). Exigência do WhatsApp e boa prática de LGPD: o cliente
 * pode pedir para parar de receber, e isso deve ser honrado.
 *
 * A detecção é DETERMINÍSTICA e conservadora: só dispara em mensagens curtas e
 * diretas (ex.: "PARAR", "stop", "quero parar os lembretes"), para não sequestrar
 * uma conversa real de suporte. Pedidos conversacionais ("ah, e não quero mais
 * lembretes") são tratados pela própria Aria via tool set_outbound_consent.
 */

import { languageForPhone, type BaseLang } from "./locale.js";

export type ConsentIntent = "opt_out" | "opt_in" | null;

// "cancelar" foi deixado de fora de propósito: é ambíguo com cancelar reserva.
const OPT_OUT = ["parar", "pare", "sair", "stop", "unsubscribe", "baja", "arreter"];
const OPT_IN = ["voltar", "iniciar", "start", "reativar", "volver", "reprendre"];

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!,;:?]+$/g, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos (arrêter → arreter)
}

export function detectConsentIntent(text: string): ConsentIntent {
  const t = normalize(text);
  if (!t) return null;
  if (t.split(/\s+/).length > 4) return null; // só mensagens curtas e diretas

  const has = (list: string[]) =>
    list.some((k) => t === k || t.startsWith(k + " ") || t.endsWith(" " + k) || t.includes(" " + k + " "));

  if (has(OPT_OUT)) return "opt_out";
  if (has(OPT_IN)) return "opt_in";
  return null;
}

const MSG_OUT: Record<BaseLang, string> = {
  pt: "Pronto. Você não receberá mais lembretes nem convites de avaliação. Seguimos à disposição sempre que precisar — é só nos escrever. Aria · The World Keys",
  en: "Done. You will no longer receive reminders or review invitations. We remain at your service whenever you need — just message us. Aria · The World Keys",
  es: "Listo. Ya no recibirá recordatorios ni invitaciones de valoración. Seguimos a su disposición cuando lo necesite — solo escríbanos. Aria · The World Keys",
  fr: "C'est noté. Vous ne recevrez plus de rappels ni d'invitations à évaluer. Nous restons à votre disposition — écrivez-nous quand vous le souhaitez. Aria · The World Keys",
  it: "Fatto. Non riceverà più promemoria né inviti a lasciare una recensione. Restiamo a sua disposizione — ci scriva quando vuole. Aria · The World Keys",
  de: "Erledigt. Sie erhalten keine Erinnerungen und Bewertungseinladungen mehr. Wir sind weiterhin für Sie da — schreiben Sie uns jederzeit. Aria · The World Keys",
};
const MSG_IN: Record<BaseLang, string> = {
  pt: "Perfeito. Você voltará a receber nossos lembretes e convites. É um prazer tê-lo de volta. Aria · The World Keys",
  en: "Perfect. You will receive our reminders and invitations again. A pleasure to have you back. Aria · The World Keys",
  es: "Perfecto. Usted volverá a recibir nuestros recordatorios e invitaciones. Es un placer tenerle de vuelta. Aria · The World Keys",
  fr: "Parfait. Vous recevrez à nouveau nos rappels et invitations. Ravis de vous retrouver. Aria · The World Keys",
  it: "Perfetto. Lei riceverà di nuovo i nostri promemoria e inviti. È un piacere riaverla con noi. Aria · The World Keys",
  de: "Perfekt. Sie erhalten unsere Erinnerungen und Einladungen wieder. Schön, Sie wieder bei uns zu haben. Aria · The World Keys",
};

// v23 (levantamento 27/10): "VOLTAR" só limpa o PARAR. Os lembretes de reserva exigem a marcação
// `whatsapp_reservas` (opt-in por código). Para quem nunca a teve, prometer "voltará a receber
// nossos lembretes" era falso — a confirmação diz o que é verdade e aponta o gesto que liga o canal.
const MSG_IN_SEM_RESERVAS: Record<BaseLang, string> = {
  pt: "Pronto. Seu número voltou a poder receber nossas mensagens. Para acompanhar um pedido por aqui, envie o código dele. Aria · The World Keys",
  en: "Done. Your number can receive our messages again. To follow a request here, send us its code. Aria · The World Keys",
  es: "Listo. Su número vuelve a poder recibir nuestros mensajes. Para seguir una solicitud por aquí, envíenos su código. Aria · The World Keys",
  fr: "C'est noté. Votre numéro peut à nouveau recevoir nos messages. Pour suivre une demande ici, envoyez-nous son code. Aria · The World Keys",
  it: "Fatto. Il suo numero può di nuovo ricevere i nostri messaggi. Per seguire una richiesta qui, ci invii il suo codice. Aria · The World Keys",
  de: "Erledigt. Ihre Nummer kann unsere Nachrichten wieder empfangen. Um eine Anfrage hier zu verfolgen, senden Sie uns ihren Code. Aria · The World Keys",
};

export type OpcoesConfirmacao = {
  /** Só para opt_in: o número está marcado para receber WhatsApp de reservas? Ausente = sim (compatível). */
  recebeReservas?: boolean;
};

export function consentConfirmation(intent: "opt_out" | "opt_in", phone: string, opts: OpcoesConfirmacao = {}): string {
  const lang = languageForPhone(phone);
  if (intent === "opt_out") return MSG_OUT[lang];
  return opts.recebeReservas === false ? MSG_IN_SEM_RESERVAS[lang] : MSG_IN[lang];
}
