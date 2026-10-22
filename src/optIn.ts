/**
 * optIn.ts — executa o opt-in pedido pelo próprio cliente (regra em optInRegra.ts).
 *
 * Chamado antes da fila do agente: se a mensagem é o pedido de acompanhamento de uma reserva
 * viva, grava o consentimento no número que escreveu, liga o número ao cliente, reabre os
 * lembretes que estavam fechados por falta de opt-in e confirma em texto livre. Qualquer dúvida
 * (código desconhecido, reserva antiga, número de estabelecimento, erro de banco) devolve false
 * e a mensagem segue para a Aria como conversa normal — nada se perde.
 */

import { getConsentRow, getReservaParaOptIn, logEscalation, reabrirLembretesDoCliente, registrarOptInCliente } from "./db.js";
import { outboundGate } from "./format.js";
import { languageForPhone } from "./locale.js";
import { confirmacaoOptIn, detectarPedidoAcompanhamento, idiomaPreferidoDoOptIn, mesmoNumero } from "./optInRegra.js";
import { registrarSaida } from "./outboundLog.js";
import { normalizePhone } from "./phone.js";
import { avaliarTelefone } from "./phoneQuality.js";

export type ResultadoOptIn = { tratado: false } | { tratado: true; resposta: string | null };

export async function tratarPedidoAcompanhamento(chatId: string, texto: string): Promise<ResultadoOptIn> {
  const pedido = detectarPedidoAcompanhamento(texto);
  if (!pedido) return { tratado: false };

  const phone = normalizePhone(chatId);
  try {
    const reserva = await getReservaParaOptIn(pedido.codigo);
    if (!reserva || !reserva.customer_id || !reserva.viva) return { tratado: false };

    const linha = await getConsentRow(phone);
    if (linha?.tipo === "estabelecimento") return { tratado: false };

    // Responde no idioma da mensagem; a preferência gravada para os templates é outra pergunta
    // (o e-mail do botão é em inglês para todos — ver idiomaPreferidoDoOptIn).
    const idioma = pedido.idioma ?? languageForPhone(phone);
    const daConta = mesmoNumero(phone, avaliarTelefone(reserva.account_phone).e164);
    const gravou = await registrarOptInCliente({
      phone,
      customerId: reserva.customer_id,
      idioma: idiomaPreferidoDoOptIn(pedido.idioma),
      motivo: `pediu o acompanhamento do pedido ${reserva.reservation_code} pelo WhatsApp`,
    });
    if (!gravou) return { tratado: false };

    const reabertos = await reabrirLembretesDoCliente({ customerId: reserva.customer_id, phone }).catch(() => 0);
    await registrarSaida({
      origem: "evento",
      evento: "opt_in_cliente",
      desfecho: "opt_in",
      reservationCode: reserva.reservation_code,
      locale: idioma,
      motivo: `${daConta ? "número igual ao da conta" : "número diferente do da conta"}${reabertos ? ` · ${reabertos} lembrete(s) reaberto(s)` : ""}`,
    });
    console.log(`[opt-in] cliente pediu o acompanhamento · reserva ${reserva.reservation_code} · ${idioma} · ${daConta ? "número da conta" : "número novo"}`);

    // Texto fixo e testado, mas a porta de saída é uma só: nada vai ao cliente sem passar por ela.
    const resposta = confirmacaoOptIn(idioma, reserva.restaurant_name);
    const porta = outboundGate(resposta);
    if (!porta.ok) {
      await logEscalation({ tag: "ALTA", summary: `[opt-in] confirmação retida pela porta de saída (${porta.motivo}) — o opt-in da reserva ${reserva.reservation_code} foi gravado, o cliente não recebeu a confirmação`, phone: "", reservationCode: reserva.reservation_code }).catch(() => {});
      return { tratado: true, resposta: null };
    }
    return { tratado: true, resposta };
  } catch (err) {
    console.warn("[opt-in] falha ao tratar o pedido de acompanhamento — segue como conversa:", err instanceof Error ? err.message : err);
    return { tratado: false };
  }
}
