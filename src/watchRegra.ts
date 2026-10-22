/**
 * watchRegra.ts — que evento nasce de uma mudança de status da reserva (puro, testável).
 *
 * A plataforma não avisa ninguém quando uma reserva muda (update_events tem 1 linha em 14 dias;
 * o audit só vê o pg_cron). Então a Aria observa a tabela `reservations` e deduz o evento:
 *   linha nova em pending            → pedido_recebido
 *   linha nova já em accept/decline  → aceito / recusado (v20; só se a linha for recente)
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
  if (a === null) {
    // Linha nova. v20: a reserva pode ser respondida ANTES da primeira foto (confirmação automática,
    // casa rápida) — em 02/10/2026 um pedido aceito em menos de 2 minutos não avisou ninguém.
    // Vista pela primeira vez já aceita ou recusada, o cliente recebe o desfecho; cancelamento do
    // próprio cliente antes da primeira foto não tem a quem avisar.
    if (b === "pending") return "pedido_recebido";
    if (b === "accept") return "aceito";
    if (b === "decline") return "recusado";
    return null;
  }
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
