/**
 * avisoOperacional.ts — avisos de SISTEMAS DE RESERVA de restaurantes (SevenRooms, TheFork, OpenTable…)
 * sobre uma reserva concreta. Lógica pura, sem I/O.
 *
 * POR QUE EXISTE (v24, ADR-019, 2026-10-28)
 * Em 28/10 o SevenRooms avisou que a mesa de Kristy Swanson no Pierluigi (24/11, 6 pessoas) exigia
 * cartão de crédito até 18:17 do mesmo dia. A Aria leu "notificação automática de serviço" e ficou em
 * silêncio — e a retenção virou escalação com o motivo errado. Um aviso desses não é ruído nem conversa:
 * é uma ação com prazo. Cartão/pagamento é sempre humano (tabela de escalonamento); o resto segue o fluxo.
 */

export type TipoAviso = "cartao_exigido" | "cancelamento_sistema" | "confirmacao_sistema";

export interface AvisoOperacional {
  tipo: TipoAviso;
  sistema: string;
  casa: string | null;
  cliente: string | null;
  dataMesa: string | null;
  prazo: string | null;
}

const SISTEMAS: Array<[RegExp, string]> = [
  [/sevenrooms/i, "SevenRooms"],
  [/thefork|lafourchette|eltenedor/i, "TheFork"],
  [/opentable/i, "OpenTable"],
  [/\bresy\b/i, "Resy"],
  [/zenchef/i, "Zenchef"],
  [/tablecheck/i, "TableCheck"],
  [/quandoo/i, "Quandoo"],
  [/bookatable/i, "Bookatable"],
  [/exploretock|\btock\b/i, "Tock"],
  [/covermanager/i, "CoverManager"],
  [/guestonline/i, "Guestonline"],
];

const CARTAO = /credit card (?:is )?required|card (?:is )?required|carte (?:bancaire|de cr[ée]dit) (?:est )?requise|tarjeta de cr[ée]dito|carta di credito|kreditkarte|cart[ãa]o de cr[ée]dito/i;
const CANCEL = /\b(?:cancell?ed|annul[ée]e?|cancelad[ao]|cancellat[ao]|storniert)\b/i;
const CONFIRM = /\b(?:confirmed|confirm[ée]e?|confirmad[ao]|confermat[ao]|best[äa]tigt)\b/i;

function sistemaDe(sender: string, subject: string, text: string): string | null {
  for (const [re, nome] of SISTEMAS) if (re.test(sender)) return nome;
  // Sem remetente conhecido, só o assunto ou o rodapé nomeando o sistema vale (fail-closed: sem sistema, não é aviso).
  for (const [re, nome] of SISTEMAS) if (re.test(subject) || re.test(text.slice(-600))) return nome;
  return null;
}

/** "Credit Card required at Pierluigi | Kristy Swanson on 24/11/2026" → casa, cliente, data. */
function lerAssunto(subject: string): { casa: string | null; cliente: string | null; dataMesa: string | null } {
  const casa = subject.match(/\b(?:at|chez|en|da|presso|bei)\s+([^|\n]+?)\s*(?:\||$)/i)?.[1]?.trim() ?? null;
  const cliente = subject.match(/\|\s*([^|\n]+?)\s+(?:on|le|el|il|am)\s+\d/i)?.[1]?.trim() ?? null;
  const dataMesa = subject.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/)?.[1] ?? null;
  return { casa, cliente, dataMesa };
}

/** "A credit card is required by 18:17 on 28 October" → "18:17 28 October". */
function lerPrazo(text: string): string | null {
  const m = text.match(/\b(?:by|before|until|avant(?: le)?|antes de(?: las?)?|entro(?: le)?|bis)\s+(\d{1,2}[:h]\d{2})\s*(?:on|le|el|del|il|am)?\s*(\d{1,2}(?:\s+(?:de\s+)?[a-zéû]+|\/\d{1,2})(?:(?:\s+(?:de\s+)?|\/)\d{2,4})?)?/i);
  if (!m) return null;
  return [m[1].replace("h", ":"), m[2]].filter(Boolean).join(" ").trim();
}

export function detectarAvisoOperacional(p: { sender?: string | null; subject?: string | null; text?: string | null }): AvisoOperacional | null {
  const sender = String(p.sender ?? "");
  const subject = String(p.subject ?? "");
  const text = String(p.text ?? "");
  const sistema = sistemaDe(sender, subject, text);
  if (!sistema) return null;
  const alvo = `${subject}\n${text.slice(0, 2000)}`;
  let tipo: TipoAviso | null = null;
  if (CARTAO.test(alvo)) tipo = "cartao_exigido";
  else if (CANCEL.test(subject)) tipo = "cancelamento_sistema";
  else if (CONFIRM.test(subject)) tipo = "confirmacao_sistema";
  if (!tipo) return null;
  return { tipo, sistema, ...lerAssunto(subject), prazo: tipo === "cartao_exigido" ? lerPrazo(alvo) : null };
}

/** Prefixo de dedup: um aviso por casa+cliente+data enquanto a escalação estiver aberta. */
export function prefixoAviso(a: AvisoOperacional): string {
  return `[aviso-operacional] ${a.tipo} ${a.casa ?? "?"} ${a.dataMesa ?? "?"}`.slice(0, 120);
}

export function resumoAviso(a: AvisoOperacional): string {
  const partes = [
    prefixoAviso(a),
    `— ${a.sistema} avisa que a reserva${a.cliente ? ` de ${a.cliente}` : ""}${a.casa ? ` no ${a.casa}` : ""}${a.dataMesa ? ` (${a.dataMesa})` : ""} exige ${a.tipo === "cartao_exigido" ? "cartão de crédito" : a.tipo}`,
    a.prazo ? `até ${a.prazo}` : "sem prazo legível",
    ". Ação: cartão/pagamento é humano — abrir o e-mail original na caixa de reservas, decidir com o cliente e registrar aqui.",
  ];
  return partes.join(" ").replace(/\s+/g, " ").trim();
}
