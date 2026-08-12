/**
 * Temporal context builder.
 *
 * An LLM has no inherent knowledge of "today". To make Aria surgically
 * accurate with dates, we compute the real current date/time on every request
 * and inject it into the system prompt. Brazil time is the primary reference
 * (customer base); Paris is included because TWK is HQ'd there and restaurant
 * confirmations run on local time.
 */

const TZ_BR = "America/Sao_Paulo";
const TZ_PARIS = "Europe/Paris";

function isoDate(now: Date, tz: string): string {
  // en-CA locale yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function clockTime(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function weekday(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "long",
  }).format(now);
}

function longDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);
}

/**
 * Returns the temporal-context block appended to the system prompt on every
 * request. Includes the real values plus explicit rules for resolving relative
 * dates ("amanhã", "sexta que vem", etc.).
 */
export function buildTemporalContext(now: Date = new Date()): string {
  const brIso = isoDate(now, TZ_BR);
  const brWeekday = weekday(now, TZ_BR);
  const brTime = clockTime(now, TZ_BR);
  const brLong = longDate(now, TZ_BR);
  const parisIso = isoDate(now, TZ_PARIS);
  const parisTime = clockTime(now, TZ_PARIS);
  const year = brIso.slice(0, 4);

  const lines = [
    "## CONTEXTO TEMPORAL — FONTE ÚNICA DE VERDADE SOBRE DATAS",
    "",
    "O sistema injeta estes valores reais a CADA mensagem. São a única fonte de verdade sobre o tempo. Nunca estime, nunca presuma, nunca contradiga, nunca use conhecimento prévio sobre datas.",
    "",
    `- HOJE é ${brLong} (Horário de Brasília).`,
    `- Data de hoje em formato ISO: ${brIso}`,
    `- Hora agora (Brasília): ${brTime}`,
    `- Em Paris (sede The World Keys): ${parisIso}, ${parisTime}`,
    `- Carimbo UTC absoluto: ${now.toISOString()}`,
    `- Ano atual: ${year}`,
    "",
    "### Regras de cálculo de datas (CIRÚRGICO — sem erros)",
    "",
    `1. "Hoje" = ${brIso}. "Amanhã" = o dia seguinte a ${brIso}. "Ontem" = o dia anterior. Sempre calcule a partir de ${brIso}.`,
    `2. Datas relativas ("sexta que vem", "próximo sábado", "daqui a 3 dias", "semana que vem", "fim de semana") devem ser convertidas para a data ISO exata (YYYY-MM-DD), usando ${brIso} como ponto de partida e sabendo que hoje é ${brWeekday}.`,
    "3. Ao mencionar qualquer data para o cliente, sempre inclua o dia da semana por extenso junto da data (exemplo: \"sábado, 24 de maio\"). Isso elimina ambiguidade e deixa claro que você acertou.",
    "4. Se o cliente informar uma data que já passou para uma reserva futura, aponte o engano com gentileza e peça a data correta. Nunca aceite silenciosamente uma data no passado para um evento futuro.",
    "5. Se o cliente for vago (\"esses dias\", \"qualquer dia\"), peça uma data específica antes de prosseguir.",
    "6. Horários de funcionamento e confirmações do restaurante usam o fuso LOCAL do restaurante. Se o restaurante fica em outra cidade ou país, considere a diferença de fuso e, se for relevante para o cliente, mencione-a.",
    "7. Nunca invente o ano. Se o cliente disser só dia e mês, assuma o próximo ano em que essa data ainda é futura (geralmente o ano atual; se a data já passou neste ano, o ano seguinte) — e confirme com o cliente.",
    "8. Em datas de reservas existentes vindas do banco, apresente exatamente o que o banco retornou — não recalcule nem ajuste.",
  ];

  return lines.join("\n");
}
