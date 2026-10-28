/**
 * fallbackCarta.ts — a carta de espera determinística (lógica pura, sem I/O).
 *
 * POR QUE EXISTE (v24, ADR-019, 2026-10-28)
 * Quando três rascunhos do modelo são reprovados na revisão, a saída até aqui era RETER e abrir uma
 * escalação RESPONDER para um humano — e o destinatário ficava sem nada (6K9UTC47 venceu assim; o
 * Marriott esperou três dias). O fundador quer o atendimento comum resolvido sem humano. A solução
 * que não mente nem expõe processo: uma carta curta, fixa, no idioma do destinatário, que diz o que
 * é verdade (a mensagem está com a Aria) e dá a data em que ELA volta — data registrada como
 * compromisso (aria_commitments), que o módulo compromissos.ts cumpre no dia. Nada de terceiros,
 * nada de prazo humano: é a fórmula do ADR-015 com a única data permitida, a nossa.
 */

import type { BaseLang } from "./locale.js";

export type DestinatarioCarta = "cliente" | "estabelecimento";

const LOCALE: Record<BaseLang, string> = { pt: "pt-BR", en: "en-GB", es: "es-ES", fr: "fr-FR", it: "it-IT", de: "de-DE" };

/** Próximo dia útil (seg–sex) em Europe/Paris, a partir de `agora`, como AAAA-MM-DD. */
export function proximoDiaUtil(agora: Date, tz = "Europe/Paris"): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  let d = new Date(agora.getTime());
  for (let i = 0; i < 7; i++) {
    d = new Date(d.getTime() + 24 * 3_600_000);
    const ymd = f.format(d);
    const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return ymd;
  }
  return f.format(d);
}

/** "2026-10-29" → "quinta-feira, 29 de outubro de 2026" (no idioma). */
export function dataPorExtenso(ymd: string, idioma: BaseLang): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat(LOCALE[idioma], { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}

type Textos = Record<BaseLang, (d: { data: string; pedido: string | null; link: string | null }) => string>;

const CLIENTE: Textos = {
  en: (d) => `Hello,\n\nThank you for your message. It is with me and I am looking after it for you. You will have my answer by ${d.data}, with everything that is in place by then.\n\nWith pleasure,\nAria · The World Keys`,
  pt: (d) => `Olá,\n\nObrigada pela sua mensagem. Ela está comigo e eu estou cuidando dela. Você terá a minha resposta até ${d.data}, com tudo o que estiver em vigor até lá.\n\nCom prazer,\nAria · The World Keys`,
  es: (d) => `Hola,\n\nGracias por su mensaje. Lo tengo conmigo y me estoy ocupando de ello. Usted tendrá mi respuesta antes de ${d.data}, con todo lo que esté en marcha hasta entonces.\n\nCon mucho gusto,\nAria · The World Keys`,
  fr: (d) => `Bonjour,\n\nMerci pour votre message. Il est entre mes mains et je m'en occupe. Vous aurez ma réponse d'ici ${d.data}, avec tout ce qui sera en place d'ici là.\n\nAvec plaisir,\nAria · The World Keys`,
  it: (d) => `Buongiorno,\n\nGrazie per il suo messaggio. È nelle mie mani e me ne sto occupando. Lei avrà la mia risposta entro ${d.data}, con tutto ciò che sarà in atto fino ad allora.\n\nCon piacere,\nAria · The World Keys`,
  de: (d) => `Guten Tag,\n\nvielen Dank für Ihre Nachricht. Sie liegt bei mir und ich kümmere mich darum. Sie erhalten meine Antwort bis ${d.data}, mit allem, was bis dahin feststeht.\n\nMit Freude,\nAria · The World Keys`,
};

const CASA: Textos = {
  en: (d) => `Hello,\n\nThank you for your message${d.pedido ? ` about request ${d.pedido}` : ""}. It is with me. You will have my answer by ${d.data}.${d.link ? ` The request page remains the quickest way to accept or decline: ${d.link}` : ""}\n\nKind regards,\nAria · The World Keys`,
  pt: (d) => `Olá,\n\nObrigada pela sua mensagem${d.pedido ? ` sobre o pedido ${d.pedido}` : ""}. Ela está comigo. Você terá a minha resposta até ${d.data}.${d.link ? ` A página do pedido continua sendo o caminho mais rápido para aceitar ou recusar: ${d.link}` : ""}\n\nCordialmente,\nAria · The World Keys`,
  es: (d) => `Hola,\n\nGracias por su mensaje${d.pedido ? ` sobre la solicitud ${d.pedido}` : ""}. Lo tengo conmigo. Usted tendrá mi respuesta antes de ${d.data}.${d.link ? ` La página de la solicitud sigue siendo la vía más rápida para aceptar o rechazar: ${d.link}` : ""}\n\nCordialmente,\nAria · The World Keys`,
  fr: (d) => `Bonjour,\n\nMerci pour votre message${d.pedido ? ` au sujet de la demande ${d.pedido}` : ""}. Il est entre mes mains. Vous aurez ma réponse d'ici ${d.data}.${d.link ? ` La page de la demande reste le moyen le plus rapide d'accepter ou de refuser : ${d.link}` : ""}\n\nCordialement,\nAria · The World Keys`,
  it: (d) => `Buongiorno,\n\nGrazie per il suo messaggio${d.pedido ? ` sulla richiesta ${d.pedido}` : ""}. È nelle mie mani. Lei avrà la mia risposta entro ${d.data}.${d.link ? ` La pagina della richiesta resta il modo più rapido per accettare o rifiutare: ${d.link}` : ""}\n\nCordiali saluti,\nAria · The World Keys`,
  de: (d) => `Guten Tag,\n\nvielen Dank für Ihre Nachricht${d.pedido ? ` zur Anfrage ${d.pedido}` : ""}. Sie liegt bei mir. Sie erhalten meine Antwort bis ${d.data}.${d.link ? ` Die Anfrageseite bleibt der schnellste Weg, um anzunehmen oder abzulehnen: ${d.link}` : ""}\n\nMit freundlichen Grüßen,\nAria · The World Keys`,
};

export function cartaFallback(
  destinatario: DestinatarioCarta,
  idioma: BaseLang,
  p: { data: string; pedido?: string | null; link?: string | null },
): string {
  const t = destinatario === "estabelecimento" ? CASA : CLIENTE;
  return t[idioma]({ data: p.data, pedido: p.pedido ?? null, link: p.link ?? null });
}

export const IDIOMAS_FALLBACK = Object.keys(CLIENTE) as BaseLang[];
