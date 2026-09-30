/**
 * watchRegra.ts — que evento nasce de uma mudança de status da reserva (puro, testável).
 *
 * A plataforma não avisa ninguém quando uma reserva muda (update_events tem 1 linha em 14 dias;
 * o audit só vê o pg_cron). Então a Aria observa a tabela `reservations` e deduz o evento:
 *   linha nova em pending            → pedido_recebido
 *   pending → accept                 → aceito
 *   pending → decline                → recusado
 *   qualquer → declined (client)     → cancelado
 * Tudo o mais (pending→pending, accept→accept, status desconhecido) não gera evento.
 */

import type { EventoReserva } from "./eventFormat.js";

export function normalizarStatusReserva(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

export function eventoPorStatus(anterior: string | null, atual: string | null | undefined): EventoReserva | null {
  const a = anterior === null ? null : normalizarStatusReserva(anterior);
  const b = normalizarStatusReserva(atual);
  if (a === b) return null;
  if (a === null) return b === "pending" ? "pedido_recebido" : null; // linha nova: só o pedido conta
  if (b === "accept") return "aceito";
  if (b === "decline") return "recusado";
  if (b === "declined (client)" || b === "cancelled" || b === "canceled") return "cancelado";
  return null;
}

/** Linha nova só vira "pedido recebido" se for recente — na primeira varredura não se reanuncia o passado. */
export function pedidoRecente(createdAt: Date | string, agora: Date, horas: number): boolean {
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && agora.getTime() - t <= horas * 3_600_000 && t <= agora.getTime() + 5 * 60_000;
}
