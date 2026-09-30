/**
 * venueEvents.ts — as etapas do ESTABELECIMENTO por WhatsApp.
 *
 * Pedido do fundador (2026-09-25): "não tô vendo mensagem para o estabelecimento".
 * Três etapas, todas só para casas MARCADAS no identificador de opt-in
 * (`aria_contact_consent` com tipo = 'estabelecimento' e restaurant_id):
 *
 *   1. pedido_recebido → "chegou um pedido", com botão para a página /r/<código>,
 *      a mesma em que a casa já aceita ou recusa pelo e-mail. A Aria NÃO aceita nem
 *      recusa nada: reservas são da plataforma (ADR-004).
 *   2. cancelado       → "o cliente cancelou".
 *   3. vespera         → lembrete na véspera com nome, hora e pessoas.
 *
 * O envio ao estabelecimento é INDEPENDENTE do envio ao cliente: telefone inválido
 * do cliente não impede o aviso à casa, e vice-versa. Mesmas travas: template
 * configurado (senão finding), trava de telefone, opt-in, teto diário compartilhado,
 * dedup por reserva+destinatário, registro de todo desfecho em aria_outbound_log.
 */

import { config } from "./config.js";
import {
  getReservationsForReminder,
  liberarEnvio,
  logEscalation,
  markReminderSent,
  pool,
  reservarEnvio,
  type EventReservationRow,
  type ReminderRow,
} from "./db.js";
import { publish } from "./dashboard/events.js";
import type { PayloadEvento } from "./eventFormat.js";
import { contarEnviosHoje, registrarSaida, type RegistroSaida } from "./outboundLog.js";
import { avaliarTelefone, podeReceberWhatsApp } from "./phoneQuality.js";
import { escolherLocale } from "./templateLocale.js";
import { montarParametrosEstabelecimento, type EventoEstabelecimento } from "./venueFormat.js";
import { sendTemplate } from "./whatsapp.js";

export type ResultadoEstabelecimento = {
  acao:
    | "nao_se_aplica"
    | "canal_desligado"
    | "sem_template"
    | "sem_destinatario"
    | "reserva_nao_encontrada"
    | "dados_insuficientes"
    | "teto_diario"
    | "enviado"
    | "parcial"
    | "falha_envio";
  detalhe: string;
  destinatarios?: number;
};

type Destinatario = { phone: string; idioma: string | null };

/**
 * Números da casa marcados para receber (máx. 3), já em E.164 e sem opt-out.
 * Registro de Opt-out de Listagem (constituição): casa com pedido de remoção não recebe NADA;
 * registro ilegível = nenhum contato (fail-closed).
 */
export async function getVenueRecipients(restaurantId: string): Promise<Destinatario[]> {
  try {
    const optout = await pool.query(`SELECT 1 FROM public.v_listing_consent_atual WHERE restaurant_id = $1 LIMIT 1`, [restaurantId]);
    if ((optout.rowCount ?? 0) > 0) return [];
  } catch (err) {
    console.warn("[evento-estabelecimento] registro de opt-out ilegível — nenhum contato:", err instanceof Error ? err.message : err);
    return [];
  }
  const { rows } = await pool.query<Destinatario>(
    `SELECT phone, idioma FROM public.aria_contact_consent
      WHERE tipo = 'estabelecimento' AND restaurant_id = $1
        AND whatsapp_reservas = true AND outbound_opted_out = false
      ORDER BY updated_at DESC LIMIT 3`,
    [restaurantId],
  );
  return rows;
}

async function finding(resumo: string, code: string | null): Promise<void> {
  console.error(`[evento-estabelecimento] ${resumo}`);
  publish({ kind: "error", where: "evento-estabelecimento", message: resumo, at: new Date().toISOString() });
  await logEscalation({ tag: "URGENTE", summary: `[evento-estabelecimento] ${resumo}`, phone: "", reservationCode: code }).catch(() => {});
}

/**
 * Envia um template da casa a todos os destinatários marcados. Devolve quantos saíram.
 * `marca` é a chave de dedup (por reserva + número).
 */
async function enviarParaCasa(p: {
  evento: EventoEstabelecimento;
  template: string;
  r: ReminderRow;
  origem: RegistroSaida["origem"];
  traceId?: string;
  botaoUrlParam?: string;
}): Promise<ResultadoEstabelecimento> {
  const code = p.r.reservation_code;
  const base: Partial<RegistroSaida> = { origem: p.origem, evento: `${p.evento}:estabelecimento`, reservationCode: code, template: p.template, traceId: p.traceId ?? null };
  const anotar = (desfecho: string, extra: Partial<RegistroSaida> = {}) =>
    registrarSaida({ ...base, ...extra, desfecho } as RegistroSaida);

  if (!p.r.restaurant_id) {
    await anotar("dados_insuficientes", { motivo: "reserva sem restaurant_id" });
    return { acao: "dados_insuficientes", detalhe: "reserva sem restaurant_id" };
  }
  const destinatarios = await getVenueRecipients(p.r.restaurant_id);
  if (destinatarios.length === 0) {
    await anotar("sem_destinatario", { motivo: "nenhum número da casa marcado para receber" });
    return { acao: "sem_destinatario", detalhe: "casa não marcada para WhatsApp", destinatarios: 0 };
  }

  let enviados = 0;
  let falhas = 0;
  for (const d of destinatarios) {
    const tel = avaliarTelefone(d.phone);
    // Casa marcada de propósito: aceita também linha fixa (muitos restaurantes têm WhatsApp Business no fixo).
    // Número inválido ou ambíguo continua barrado; se o fixo não tiver WhatsApp, a Meta recusa e fica registrado.
    const fixoMarcado = tel.qualidade === "ENVIAVEL_NAO_MOVEL" && !!tel.e164;
    if (!podeReceberWhatsApp(tel) && !fixoMarcado) {
      await anotar("telefone_nao_enviavel", { qualidadeTelefone: tel.qualidade, pais: tel.pais, motivo: tel.motivo });
      continue;
    }
    const numero = tel.e164 as string;
    const params = montarParametrosEstabelecimento(p.r, tel.pais);
    if (!params) {
      await anotar("dados_insuficientes", { pais: tel.pais, motivo: "faltam campos (casa, data, hora, pessoas ou nome do cliente)" });
      await finding(`'${p.evento}' para a casa: reserva ${code} sem dados suficientes — nada enviado`, code);
      return { acao: "dados_insuficientes", detalhe: "faltam campos", destinatarios: destinatarios.length };
    }

    // Teto diário compartilhado com o cliente: um teto é um teto.
    let hoje: number;
    try {
      hoje = await contarEnviosHoje();
    } catch {
      await anotar("teto_diario", { motivo: "contagem do teto indisponível" });
      return { acao: "teto_diario", detalhe: "contagem do teto indisponível" };
    }
    if (hoje >= config.reservationEvents.dailyCap) {
      await anotar("teto_diario", { motivo: `${hoje}/${config.reservationEvents.dailyCap} hoje` });
      return { acao: "teto_diario", detalhe: `${hoje}/${config.reservationEvents.dailyCap} hoje` };
    }

    const marca = `evt_${p.evento}_venue:${numero}`;
    if (!(await reservarEnvio(code, marca, numero))) {
      await anotar("duplicado", { pais: tel.pais, motivo: "já enviado a este número" });
      continue;
    }
    const locale = escolherLocale({ idiomaPreferido: d.idioma, phone: numero, aprovados: config.reminders.locales, defaultLocale: config.reminders.defaultLocale }).locale;
    const ok = await sendTemplate({ to: numero, template: p.template, locale, bodyParams: params, buttonUrlParam: p.botaoUrlParam });
    if (!ok) {
      falhas++;
      await liberarEnvio(code, marca).catch(() => {});
      await anotar("falha_envio", { locale, pais: tel.pais, qualidadeTelefone: tel.qualidade, motivo: "Cloud API recusou o envio" });
      continue;
    }
    enviados++;
    await anotar("enviado", { locale, pais: tel.pais, qualidadeTelefone: tel.qualidade });
    publish({ kind: "tool_call", chat: numero, tool: `venue_${p.evento}_${locale}`, success: true, latency_ms: 0, at: new Date().toISOString() });
    console.log(`[evento-estabelecimento] ${p.evento} enviado · reserva ${code} · ${tel.pais} · ${locale}`);
  }

  if (falhas > 0) {
    await finding(`envio de '${p.evento}' à casa falhou ${falhas}x na Cloud API (reserva ${code}, template '${p.template}') — conferir aprovação do template no idioma`, code);
  }
  if (enviados === 0) return { acao: "falha_envio", detalhe: `0 de ${destinatarios.length}`, destinatarios: destinatarios.length };
  if (enviados < destinatarios.length) return { acao: "parcial", detalhe: `${enviados} de ${destinatarios.length}`, destinatarios: destinatarios.length };
  return { acao: "enviado", detalhe: `${enviados} número(s)`, destinatarios: destinatarios.length };
}

/** Etapas 1 e 2 — chamadas pelo webhook de evento, ao lado do envio ao cliente. */
export async function notificarEstabelecimento(p: PayloadEvento, r: EventReservationRow | null): Promise<ResultadoEstabelecimento> {
  if (!config.reservationEvents.enabled) return { acao: "canal_desligado", detalhe: "RESERVATION_EVENTS_ENABLED=false" };
  if (p.event !== "pedido_recebido" && p.event !== "cancelado") return { acao: "nao_se_aplica", detalhe: `'${p.event}' não vai para a casa` };
  const template = config.reservationEvents.venueTemplates[p.event] ?? "";
  if (!template) {
    // Sem template para a casa NÃO é finding: a etapa da casa pode estar desligada de propósito.
    return { acao: "sem_template", detalhe: `template da casa para '${p.event}' não configurado` };
  }
  if (!r) return { acao: "reserva_nao_encontrada", detalhe: p.reservationCode };
  return enviarParaCasa({
    evento: p.event,
    template,
    r,
    origem: "evento",
    traceId: p.traceId,
    botaoUrlParam: p.event === "pedido_recebido" ? r.reservation_code : undefined,
  });
}

// ─── Etapa 3: véspera para a casa ─────────────────────────────────────────────

const KIND_VENUE_BRIEFING = "venue_briefing";

export async function sweepVesperaEstabelecimento(): Promise<void> {
  const h = config.venueBriefing.hoursBefore;
  let rows: ReminderRow[] = [];
  try {
    rows = await getReservationsForReminder(KIND_VENUE_BRIEFING, h - 0.5, h + 0.5, [config.reminders.status]);
  } catch (err) {
    console.warn("[vespera-casa] falha ao buscar reservas:", err instanceof Error ? err.message : err);
    return;
  }
  for (const r of rows) {
    if (r.tz_valido === false) continue; // sem fuso confiável não se lembra ninguém (mesma regra do cliente)
    const res = await enviarParaCasa({ evento: "vespera", template: config.venueBriefing.template, r, origem: "briefing" });
    // Marca a reserva como tratada quando houve destinatário (enviado, parcial ou falha definitiva);
    // sem destinatário marcado, não gasta a marca — a casa pode ser marcada até a véspera.
    if (res.acao !== "sem_destinatario" && res.acao !== "teto_diario") {
      await markReminderSent(r.reservation_code, KIND_VENUE_BRIEFING, r.restaurant_id ?? "").catch(() => {});
    }
  }
  if (rows.length) console.log(`[vespera-casa] ${rows.length} reserva(s) avaliada(s)`);
}

export function startVenueReminders(): void {
  if (!config.venueBriefing.enabled) return;
  if (!config.venueBriefing.template) {
    console.warn("[vespera-casa] VENUE_BRIEFING_ENABLED=true porém VENUE_BRIEFING_TEMPLATE vazio — não iniciado");
    return;
  }
  const intervalMs = config.reminders.sweepMinutes * 60_000;
  setTimeout(() => {
    void sweepVesperaEstabelecimento();
    setInterval(() => void sweepVesperaEstabelecimento(), intervalMs).unref();
  }, 60_000).unref();
  console.log(`[vespera-casa] lembrete à casa ${config.venueBriefing.hoursBefore}h antes ativo`);
}
