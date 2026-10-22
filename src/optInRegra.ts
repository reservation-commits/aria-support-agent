/**
 * optInRegra.ts — o cliente pede, ele mesmo, para acompanhar o pedido pelo WhatsApp (v20).
 *
 * Em 05/10/2026 nenhum cliente tinha opt-in: toda notificação a cliente morria em `sem_opt_in`.
 * O caminho escolhido pelo fundador: o e-mail "solicitação enviada" leva um botão que abre o
 * WhatsApp com uma mensagem pronta contendo o código da reserva. O cliente envia; essa mensagem
 * É o consentimento (dele, datado, guardado em aria_messages) e prova que o número tem WhatsApp —
 * 9 dos 25 pedidos das duas semanas anteriores tinham telefone inválido ou fixo na conta.
 *
 * Lógica pura, sem banco nem modelo: o opt-in funciona mesmo com a IA fora do ar.
 * A detecção é conservadora, para não sequestrar uma conversa de atendimento: mensagem curta,
 * que cita o WhatsApp e traz exatamente um código de reserva. Tudo o mais segue para a Aria.
 */

import type { BaseLang } from "./locale.js";

const MAX_CARACTERES = 220;
const MAX_PALAVRAS = 30;

/** Código de reserva: 8 caracteres, maiúsculas e dígitos (2.958 de 3.224 em 2026 misturam os dois; há só letras e só dígitos). */
const FORMATO_CODIGO = /^[A-Z0-9]{8}$/;

/** Palavras que só aparecem na mensagem pronta de cada idioma (minúsculas, sem acento). */
const MARCAS: Array<[BaseLang, string[]]> = [
  ["de", ["verfolgen", "anfrage", "mochte"]],
  ["it", ["seguire", "richiesta", "desidero"]],
  ["fr", ["suivre", "demande", "souhaite", "bonjour"]],
  ["es", ["seguir", "solicitud", "quiero", "hola"]],
  ["pt", ["acompanhar", "pedido", "quero", "ola"]],
  ["en", ["follow", "request", "hello", "would"]],
];

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export type PedidoAcompanhamento = { codigo: string; idioma: BaseLang | null };

export function detectarPedidoAcompanhamento(texto: string | null | undefined): PedidoAcompanhamento | null {
  const t = (texto ?? "").trim();
  if (!t || t.length > MAX_CARACTERES) return null;
  const palavras = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (palavras.length === 0 || palavras.length > MAX_PALAVRAS) return null;
  if (!/whats\s?app/i.test(t)) return null;

  // O código vale como está escrito: maiúsculas. "WHATSAPP" tem 8 letras e não é código.
  const codigos = [...new Set(palavras.filter((p) => FORMATO_CODIGO.test(p) && p !== "WHATSAPP"))];
  if (codigos.length !== 1) return null;

  const minusculas = new Set(palavras.map((p) => semAcento(p.toLowerCase())));
  let idioma: BaseLang | null = null;
  for (const [lang, marcas] of MARCAS) {
    if (marcas.some((m) => minusculas.has(m))) { idioma = lang; break; }
  }
  return { codigo: codigos[0], idioma };
}

/**
 * Idioma a gravar como PREFERÊNCIA do cliente para as próximas mensagens (templates).
 * O e-mail de onde o botão sai é em inglês para todos: a mensagem pronta em inglês diz qual é o
 * idioma do NOSSO e-mail, não o do cliente. Só um idioma diferente do inglês é sinal dele;
 * com inglês (ou nada), fica vazio e o template sai pelo país do telefone — ADR-015: a carta vai
 * no idioma do cliente. A confirmação imediata, essa sim, responde no idioma da mensagem.
 */
export function idiomaPreferidoDoOptIn(detectado: BaseLang | null): BaseLang | null {
  return detectado && detectado !== "en" ? detectado : null;
}

/** A mensagem que o botão do e-mail deixa escrita no WhatsApp do cliente (ele só toca em enviar). */
const PRONTA: Record<BaseLang, (codigo: string) => string> = {
  pt: (c) => `Olá! Quero acompanhar meu pedido ${c} pelo WhatsApp.`,
  en: (c) => `Hello! I would like to follow my request ${c} on WhatsApp.`,
  es: (c) => `¡Hola! Quiero seguir mi solicitud ${c} por WhatsApp.`,
  fr: (c) => `Bonjour ! Je souhaite suivre ma demande ${c} sur WhatsApp.`,
  it: (c) => `Buongiorno! Desidero seguire la mia richiesta ${c} su WhatsApp.`,
  de: (c) => `Guten Tag! Ich möchte meine Anfrage ${c} per WhatsApp verfolgen.`,
};

export function mensagemProntaOptIn(idioma: BaseLang, codigo: string): string {
  return PRONTA[idioma](codigo);
}

/** Link do botão: abre a conversa com o número da TWK e a mensagem pronta. `numero` só com dígitos. */
export function linkOptIn(numero: string, idioma: BaseLang, codigo: string): string {
  return `https://wa.me/${numero.replace(/\D/g, "")}?text=${encodeURIComponent(mensagemProntaOptIn(idioma, codigo))}`;
}

/**
 * Resposta ao cliente, em texto livre (ele acabou de escrever: a janela de 24 h está aberta).
 * ADR-015: só promete o que existe — as atualizações saem do vigia de reservas e dos lembretes;
 * nenhuma palavra sobre prazo, mesa ou confirmação. A palavra de saída é a que `consent.ts` reconhece.
 */
const CONFIRMACAO: Record<BaseLang, { texto: string; casa: string; sair: string }> = {
  pt: { texto: "Pronto. A partir de agora, as atualizações do seu pedido chegam por aqui.", casa: "Restaurante", sair: "Para parar, escreva PARAR." },
  en: { texto: "Done. From now on, updates on your request will arrive here.", casa: "Restaurant", sair: "To stop, reply STOP." },
  es: { texto: "Listo. A partir de ahora, las novedades de su solicitud llegarán por aquí.", casa: "Restaurante", sair: "Para dejar de recibirlas, escriba BAJA." },
  fr: { texto: "C'est noté. Désormais, les nouvelles de votre demande arriveront ici.", casa: "Restaurant", sair: "Pour ne plus les recevoir, écrivez STOP." },
  it: { texto: "Fatto. D'ora in poi, gli aggiornamenti sulla sua richiesta arriveranno qui.", casa: "Ristorante", sair: "Per non riceverli più, scriva STOP." },
  de: { texto: "Erledigt. Ab sofort senden wir Ihnen die Neuigkeiten zu Ihrer Anfrage hierher.", casa: "Restaurant", sair: "Zum Beenden schreiben Sie STOP." },
};

export function confirmacaoOptIn(idioma: BaseLang, casa: string | null | undefined): string {
  const c = CONFIRMACAO[idioma];
  const nome = (casa ?? "").replace(/\s+/g, " ").trim();
  const ficha = nome ? `\n\n*${c.casa}:* ${nome}` : "";
  return `${c.texto}${ficha}\n\n${c.sair}\nAria · The World Keys`;
}

/**
 * O número que escreveu é o mesmo da conta? Só informa o registro — o opt-in vale nos dois casos
 * (o código chega apenas ao e-mail do cliente; quem o tem é tratado como o cliente).
 */
export function mesmoNumero(e164Remetente: string, e164Conta: string | null | undefined): boolean {
  const d = (s: string) => s.replace(/\D/g, "");
  return !!e164Conta && d(e164Remetente) === d(e164Conta);
}
