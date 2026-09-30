/**
 * venueFormat.ts — parâmetros dos templates enviados ao ESTABELECIMENTO (puro, testável).
 *
 * Contrato com os templates `twk_venue_*` na Meta (docs/notificacoes/templates-meta-2026-09-25.md):
 *   {{1}} restaurante · {{2}} data · {{3}} hora · {{4}} pessoas · {{5}} nome do cliente
 * O botão de URL do template "pedido recebido" recebe o código da reserva:
 *   https://theworldkeys.com/r/{{1}}  — a mesma página em que a casa já aceita ou recusa pelo e-mail.
 *
 * Mesma disciplina do lado do cliente: qualquer campo vazio → null → não envia → finding.
 * A casa precisa do nome completo do cliente para registrar a mesa; é o mesmo dado que
 * o e-mail da plataforma já leva.
 */

import { formatarData, formatarHora, formatarPessoas, type DadosEvento } from "./eventFormat.js";

// v16: "pedido_lembrete" (24 h sem resposta) e "agenda" (mesas de amanhã, uma mensagem por casa).
export const EVENTOS_ESTABELECIMENTO = ["pedido_recebido", "cancelado", "vespera", "pedido_lembrete", "agenda"] as const;
export type EventoEstabelecimento = (typeof EVENTOS_ESTABELECIMENTO)[number];

export function ehEventoEstabelecimento(v: string): v is EventoEstabelecimento {
  return (EVENTOS_ESTABELECIMENTO as readonly string[]).includes(v);
}

export function montarParametrosEstabelecimento(d: DadosEvento, pais: string | null): string[] | null {
  const casa = (d.restaurant_name ?? "").trim();
  const data = formatarData(d.booking_date, pais);
  const hora = formatarHora(d.reservation_time, pais);
  const pessoas = formatarPessoas(d.people);
  const cliente = (d.customer_name ?? "").replace(/\s+/g, " ").trim();
  const params = [casa, data, hora, pessoas, cliente];
  return params.every((p) => p.length > 0) ? params : null;
}
