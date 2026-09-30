/**
 * venueIdentityRegra.ts — o aviso de sistema quando quem escreve no WhatsApp é um ESTABELECIMENTO (puro).
 *
 * Desde a v12 as casas marcadas recebem os pedidos de mesa no WhatsApp. Quando respondem por texto
 * ("ok", "não temos mesa", "pode ser às 20h?"), a mensagem cai na Aria como se fosse um cliente.
 * Este aviso muda o papel do turno: a Aria fala com um parceiro, não com um hóspede — não oferece
 * mesas nem alternativas, não altera a reserva (reservas são da plataforma), e entrega o link da
 * página de resposta do pedido certo: https://theworldkeys.com/r/<código>.
 */

export interface CasaIdentificada {
  restaurantId: string;
  nome: string;
  cidade: string | null;
}

export interface PedidoPendente {
  reservation_code: string;
  booking_date: string | Date;
  reservation_time: string | null;
  people: number | string | null;
}

export const LINK_RESPOSTA = "https://theworldkeys.com/r/";

function ymd(v: string | Date): string {
  const s = typeof v === "string" ? v : v.toISOString();
  return s.slice(0, 10);
}

export function montarAvisoEstabelecimento(casa: CasaIdentificada, pendentes: PedidoPendente[]): string {
  const lista = pendentes.length
    ? pendentes
        .slice(0, 5)
        .map((p) => `${p.reservation_code} · ${ymd(p.booking_date)} ${String(p.reservation_time ?? "").slice(0, 5)} · ${p.people ?? "?"} pessoas → ${LINK_RESPOSTA}${p.reservation_code}`)
        .join("; ")
    : "nenhum pedido pendente neste momento";
  return (
    `[Sistema: contato via WhatsApp de ESTABELECIMENTO — ${casa.nome}${casa.cidade ? ` (${casa.cidade})` : ""}, ` +
    "número marcado para receber pedidos de mesa. Você fala com um PARCEIRO, não com um hóspede: não ofereça mesas, " +
    "casas alternativas nem serviços de concierge. Você NÃO aceita, recusa nem reagenda a reserva por ele: a casa decide " +
    `na página de resposta. Pedidos pendentes desta casa: ${lista}. ` +
    "Se a casa responder ao pedido por texto (aceita, sem mesa, outro horário), agradeça e envie o link do pedido certo " +
    "para ela confirmar com um toque; se citar um código, use o link daquele código. Responda no idioma em que a casa escreveu.]"
  );
}
