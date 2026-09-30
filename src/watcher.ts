/**
 * watcher.ts — o vigia de reservas: a Aria descobre sozinha o que mudou.
 *
 * Pergunta do fundador (30/09): "podemos estruturar de fato notificações para estabelecimentos
 * que não visualizam e-mails?" Sim — e sem depender do n8n (cujo gatilho ainda está aberto)
 * nem de a plataforma avisar. A cada 2 minutos este módulo lê as reservas recentes, compara com
 * a foto anterior (`aria_reservation_watch`) e dispara, pelo MESMO caminho do webhook
 * (`tratarEventoReserva` para o cliente, `notificarEstabelecimento` para a casa), os eventos:
 * pedido recebido, aceito, recusado, cancelado. Todas as travas continuam valendo: canal
 * ligado, template configurado, telefone, opt-in, teto diário, dedup por reserva.
 *
 * Primeira varredura: fotografa tudo e só anuncia pedidos das últimas 6 horas — nunca reanuncia
 * o passado. O webhook do n8n continua aceito: a dedup garante que o mesmo evento não sai duas vezes.
 */

import { config } from "./config.js";
import { getReservationForEvent, pool } from "./db.js";
import { parsePayloadEvento, type EventoReserva } from "./eventFormat.js";
import { tratarEventoReserva } from "./reservationEvents.js";
import { notificarEstabelecimento } from "./venueEvents.js";
import { eventoPorStatus, normalizarStatusReserva, pedidoRecente } from "./watchRegra.js";

const HORAS_PEDIDO_NOVO = 6;
const MAX_EVENTOS_POR_TICK = 30;

type Linha = { reservation_code: string; status: string; created_date: Date };

async function lerRecentes(): Promise<Linha[]> {
  const { rows } = await pool.query<Linha>(
    `SELECT reservation_code, lower(btrim(coalesce(booking_status, ''))) AS status, created_date
       FROM public.reservations
      WHERE reservation_code IS NOT NULL
        AND (created_date > NOW() - INTERVAL '30 days' OR booking_date >= CURRENT_DATE)`,
  );
  return rows;
}

async function lerFoto(codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const { rows } = await pool.query<{ reservation_code: string; status: string }>(
    `SELECT reservation_code, status FROM public.aria_reservation_watch WHERE reservation_code = ANY($1::text[])`,
    [codes],
  );
  return new Map(rows.map((r) => [r.reservation_code, r.status]));
}

async function fotoVazia(): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.aria_reservation_watch`);
  return Number(rows[0]?.n ?? 0) === 0;
}

async function gravar(code: string, status: string, mudou: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO public.aria_reservation_watch (reservation_code, status, first_seen, last_change)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (reservation_code) DO UPDATE SET status = EXCLUDED.status, last_change = CASE WHEN $3 THEN NOW() ELSE aria_reservation_watch.last_change END`,
    [code, status, mudou],
  );
}

async function disparar(evento: EventoReserva, code: string): Promise<void> {
  const body = { event: evento, reservation_code: code, trace_id: `watch-${Date.now().toString(36)}` };
  const cliente = await tratarEventoReserva(body);
  let casa = "—";
  const p = parsePayloadEvento(body);
  if (p) {
    const linha = await getReservationForEvent(p.reservationCode).catch(() => null);
    const r = await notificarEstabelecimento(p, linha).catch((err) => {
      console.error("[watch] estabelecimento falhou:", err instanceof Error ? err.message : err);
      return { acao: "falha_envio", detalhe: "falha interna" };
    });
    casa = `${r.acao}${r.detalhe ? ` (${r.detalhe})` : ""}`;
  }
  console.log(`[watch] ${evento} · reserva ${code} · cliente: ${cliente.acao} · casa: ${casa}`);
}

export async function varrerReservas(): Promise<{ eventos: number }> {
  let recentes: Linha[];
  try {
    recentes = await lerRecentes();
  } catch (err) {
    console.warn("[watch] leitura de reservas falhou:", err instanceof Error ? err.message : err);
    return { eventos: 0 };
  }
  const primeira = await fotoVazia().catch(() => false);
  const foto = await lerFoto(recentes.map((r) => r.reservation_code)).catch(() => null);
  if (!foto) return { eventos: 0 };

  const agora = new Date();
  let eventos = 0;
  for (const r of recentes) {
    const anterior = foto.has(r.reservation_code) ? foto.get(r.reservation_code)! : null;
    const atual = normalizarStatusReserva(r.status);
    if (anterior !== null && anterior === atual) continue;

    let evento = eventoPorStatus(anterior, atual);
    // Linha nova: só anuncia se o pedido é recente (e nunca na primeira varredura de uma linha antiga).
    if (evento === "pedido_recebido" && !pedidoRecente(r.created_date, agora, HORAS_PEDIDO_NOVO)) evento = null;
    if (primeira && evento !== "pedido_recebido") evento = null; // primeira foto: só pedidos das últimas horas

    await gravar(r.reservation_code, atual, anterior !== null && anterior !== atual).catch((err) =>
      console.warn("[watch] gravação falhou:", err instanceof Error ? err.message : err),
    );
    if (!evento) continue;
    if (eventos >= MAX_EVENTOS_POR_TICK) continue; // o resto sai na próxima varredura (a foto já mudou; a dedup protege)
    eventos++;
    try {
      await disparar(evento, r.reservation_code);
    } catch (err) {
      console.error(`[watch] falha ao disparar ${evento} para ${r.reservation_code}:`, err instanceof Error ? err.message : err);
    }
  }
  if (primeira) console.log(`[watch] primeira foto: ${recentes.length} reserva(s) registradas · ${eventos} pedido(s) recente(s) anunciado(s)`);
  return { eventos };
}

export function startReservationWatch(): void {
  if (!config.reservationEvents.enabled) {
    console.log("[watch] desligado (RESERVATION_EVENTS_ENABLED=false)");
    return;
  }
  if (!config.reservationWatch.enabled) {
    console.log("[watch] desligado (RESERVATION_WATCH_ENABLED=false)");
    return;
  }
  const ms = Math.max(1, config.reservationWatch.intervalMinutes) * 60_000;
  setTimeout(() => {
    void varrerReservas();
    setInterval(() => void varrerReservas(), ms).unref();
  }, 75_000).unref();
  console.log(`[watch] vigia de reservas ativo (a cada ${config.reservationWatch.intervalMinutes} min): pedido recebido, aceito, recusado, cancelado → cliente e casa`);
}
