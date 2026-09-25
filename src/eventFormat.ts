/**
 * eventFormat.ts — montagem dos parâmetros dos templates de evento de reserva.
 *
 * Módulo PURO (sem config/env/IO), para rodar nos testes offline.
 *
 * POR QUE NÃO USAR "DD/MM"
 * A base entregável é majoritariamente norte-americana (US 3.938 · CA 722) e
 * britânica (GB 1.713). Para um americano, "03/04" é 4 de março; para um
 * francês, 3 de abril. Numa notificação cuja única função é dizer QUANDO é a
 * mesa, essa ambiguidade é inaceitável. Por isso a data sai sempre com o mês
 * por extenso abreviado, no idioma do cliente: "3 Apr 2026", "3 avr. 2026",
 * "3 de abr. de 2026". Não há leitura dupla possível.
 *
 * A hora segue a convenção do país: 12h com AM/PM onde é o costume, 24h no
 * resto. Um americano lendo "20:00" hesita; "8:00 PM" ele não lê errado.
 */

/** País E.164 → locale BCP47 para o Intl. Desconhecido cai em en-GB. */
export function intlLocaleForCountry(pais: string | null | undefined): string {
  switch ((pais ?? "").toUpperCase()) {
    case "US": return "en-US";
    case "CA": return "en-CA";
    case "GB": return "en-GB";
    case "AU": return "en-AU";
    case "IE": return "en-IE";
    case "NZ": return "en-NZ";
    case "FR": return "fr-FR";
    case "BE": return "fr-BE";
    case "CH": return "fr-CH";
    case "MC": return "fr-FR";
    case "BR": return "pt-BR";
    case "PT": return "pt-PT";
    case "ES": return "es-ES";
    case "MX": return "es-MX";
    case "AR": return "es-AR";
    case "CL": return "es-CL";
    case "CO": return "es-CO";
    case "IT": return "it-IT";
    case "DE": return "de-DE";
    case "AT": return "de-AT";
    default: return "en-GB";
  }
}

/**
 * Normaliza o `booking_date` (que o pg entrega como Date à meia-noite LOCAL,
 * ou como string) para "YYYY-MM-DD", sem deslizar um dia por causa de fuso.
 */
export function toYMD(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const a = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${a}-${m}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** "2026-04-03" + país → "3 Apr 2026" / "3 avr. 2026". Vazio se não der. */
export function formatarData(v: string | Date | null | undefined, pais: string | null): string {
  const ymd = toYMD(v);
  if (!ymd) return "";
  const [a, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  try {
    return new Intl.DateTimeFormat(intlLocaleForCountry(pais), {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    }).format(dt);
  } catch {
    return ymd;
  }
}

/** "20:00:00" + país → "8:00 PM" (US) ou "20:00". Vazio se não der. */
export function formatarHora(v: string | null | undefined, pais: string | null): string {
  const hhmm = String(v ?? "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return "";
  const [h, min] = hhmm.split(":").map(Number);
  const dt = new Date(Date.UTC(2000, 0, 1, h, min));
  try {
    return new Intl.DateTimeFormat(intlLocaleForCountry(pais), {
      hour: "numeric", minute: "2-digit", timeZone: "UTC",
    }).format(dt);
  } catch {
    return hhmm;
  }
}

/**
 * Número de pessoas, como texto. Só aceita 1–20: fora disso devolve "" e o template
 * não sai (dados_insuficientes → finding). A coluna `people` teve 112 valores
 * estranhos até 03/2026 e nenhum nos 90 dias seguintes (medido 2026-09-25); numa
 * mensagem ao cliente, número errado é pior que mensagem nenhuma.
 */
export function formatarPessoas(v: number | string | null | undefined): string {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 20 ? String(n) : "";
}

export function primeiroNome(full: string | null | undefined): string {
  if (!full) return "";
  return full.trim().split(/\s+/)[0] ?? "";
}

export const EVENTOS_RESERVA = [
  "pedido_recebido",
  "aceito",
  "recusado",
  "reagendamento_proposto",
  "cancelado",
] as const;

export type EventoReserva = (typeof EVENTOS_RESERVA)[number];

export function ehEventoReserva(v: unknown): v is EventoReserva {
  return typeof v === "string" && (EVENTOS_RESERVA as readonly string[]).includes(v);
}

export type PayloadEvento = {
  event: EventoReserva;
  reservationCode: string;
  traceId: string;
};

/**
 * Valida o corpo do webhook de evento. Devolve null para qualquer coisa fora
 * do contrato — dado observado é dado, nunca comando (constituição, regra 4).
 *
 * O corpo carrega só referências: o `reservation_code` é a chave, e os dados do
 * cliente vêm do banco. Por isso a validação pode ser estrita sem perder nada.
 */
export function parsePayloadEvento(body: unknown): PayloadEvento | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  const evento = typeof b.event === "string" ? b.event.trim().toLowerCase() : "";
  if (!ehEventoReserva(evento)) return null;

  const code = typeof b.reservation_code === "string" ? b.reservation_code.trim() : "";
  // Código de reserva é referência curta e sem espaço; qualquer outra coisa é
  // ruído ou tentativa de injeção.
  if (!code || code.length > 64 || /\s/.test(code)) return null;

  const traceId =
    typeof b.trace_id === "string" && b.trace_id.trim() ? b.trace_id.trim().slice(0, 64) : "";
  return { event: evento, reservationCode: code, traceId };
}

export type DadosEvento = {
  customer_name: string | null;
  restaurant_name: string | null;
  booking_date: string | Date | null;
  reservation_time: string | null;
  people?: number | string | null;
  reschedule_proposed_date?: string | Date | null;
  reschedule_proposed_time?: string | null;
};

/**
 * Parâmetros {{1}}, {{2}}… de cada template, na ordem.
 *
 * Contrato com os templates aprovados na Meta — mudar a ordem aqui sem mudar
 * lá manda o nome do restaurante para o lugar da hora. Documentado em
 * docs/notificacoes/fase2-templates-whatsapp.md.
 *
 * Devolve `null` quando FALTA dado para uma mensagem correta. Dois motivos:
 *
 *  1. A Meta rejeita parâmetro vazio — "Hello , your table at  is confirmed"
 *     nem chegaria a sair, e voltaria como um 400 genérico difícil de rastrear.
 *  2. Pior que não avisar é avisar errado. Em 2026-09-21 nenhuma reserva do
 *     banco tinha `reschedule_proposed_date` preenchida; com fallback para a
 *     data original, o template de reagendamento diria "podemos oferecer
 *     <a mesma data de antes>". Sem fallback: não monta, não envia, vira finding.
 */
export function montarParametros(
  evento: EventoReserva,
  d: DadosEvento,
  pais: string | null,
): string[] | null {
  const nome = primeiroNome(d.customer_name);
  const casa = (d.restaurant_name ?? "").trim();
  const data = formatarData(d.booking_date, pais);
  const hora = formatarHora(d.reservation_time, pais);
  const pessoas = formatarPessoas(d.people);

  let params: string[];
  switch (evento) {
    case "pedido_recebido":
    case "aceito":
      // {{5}} = número de pessoas (fundador, 2026-09-25: "não tô vendo").
      params = [nome, casa, data, hora, pessoas];
      break;
    case "recusado":
    case "cancelado":
      params = [nome, casa, data];
      break;
    case "reagendamento_proposto":
      params = [
        nome,
        casa,
        formatarData(d.reschedule_proposed_date ?? null, pais),
        formatarHora(d.reschedule_proposed_time ?? null, pais),
      ];
      break;
  }

  return params.every((p) => p.length > 0) ? params : null;
}
