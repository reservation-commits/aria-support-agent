/**
 * tetoRegra.ts — o teto diário de notificações (RESERVATION_EVENTS_DAILY_CAP), uma regra só.
 *
 * Levantamento de 27/10/2026: o cliente (reservationEvents.ts) só aplicava o teto quando
 * `dailyCap > 0`; a casa (venueEvents.ts) comparava direto. Com o padrão 0 ("sem teto"),
 * TODO envio à casa virava `teto_diario` sem ninguém perceber. Pura, testável, usada pelos dois.
 */

/** 0 (ou negativo) = sem teto configurado. */
export function temTeto(cap: number): boolean {
  return Number.isFinite(cap) && cap > 0;
}

/** Verdadeiro quando há teto e ele já foi atingido hoje. Sem teto, nunca bloqueia. */
export function tetoAtingido(enviadosHoje: number, cap: number): boolean {
  return temTeto(cap) && enviadosHoje >= cap;
}
