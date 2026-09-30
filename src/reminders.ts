/**
 * reminders.ts
 *
 * Outbound proativo: lembrete da reserva ~2h antes, via template aprovado pela
 * Meta (única forma de enviar fora da janela de 24h).
 *
 * Regras do negócio:
 *   • Só envia para reservas com booking_status = "accept" (config.reminders.status).
 *     Pendentes e recusadas (decline) NÃO recebem.
 *   • O idioma do template é escolhido pelo CÓDIGO DO PAÍS do telefone do cliente
 *     (pt_BR / es / fr / en), com fallback configurável.
 *   • Cada reserva recebe o lembrete no máximo uma vez (aria_reminders_sent).
 *
 * DESLIGADO por padrão. Liga com REMINDERS_ENABLED=true + REMINDERS_TEMPLATE
 * (um template aprovado, com as traduções de idioma que você for usar).
 *
 * O template deve ter, no corpo, os placeholders nesta ordem:
 *   {{1}} primeiro nome · {{2}} restaurante · {{3}} horário (HH:MM)
 */

import { config } from "./config.js";
import {
  getDistinctBookingStatuses,
  getPendingForClose,
  getPendingForNudge,
  getReservationsForReminder,
  getStalePendingReservations,
  logEscalation,
  markReminderSent,
  type ReminderRow,
  podeReceberWhatsAppReservas,
} from "./db.js";
import { DETALHE_CONSENTIMENTO } from "./consentRegra.js";
import { sendTemplate } from "./whatsapp.js";
import { normalizePhone } from "./phone.js";
import { escolherLocale } from "./templateLocale.js";
import { formatarData, formatarHora, formatarPessoas } from "./eventFormat.js";
import { consultaMapa, enderecoParaFicha } from "./pendenciaRegra.js";
import { publish } from "./dashboard/events.js";
import { registrarSaida, type OrigemSaida, type RegistroSaida } from "./outboundLog.js";
import { avaliarTelefone, podeReceberWhatsApp } from "./phoneQuality.js";

const KIND = "2h";
const KIND_REVIEW = "6h_review";
const KIND_BRIEFING = "briefing_24h";

// Idioma base (pt/en/es/fr) → código de idioma do template no WhatsApp.
function firstName(full: string | null): string {
  if (!full) return "";
  return full.trim().split(/\s+/)[0] ?? "";
}

/**
 * Registra um problema da varredura de forma ALTA: console de erro, evento no
 * painel e escalação persistida. Constituição, regra 6: checagem que não rodou
 * é finding, nunca "ok" silencioso. Envio que não saiu é a mesma coisa.
 */
async function reportarFalha(rotulo: string, resumo: string): Promise<void> {
  console.error(`[${rotulo}] ${resumo}`);
  publish({ kind: "error", where: rotulo, message: resumo, at: new Date().toISOString() });
  await logEscalation({ tag: "URGENTE", summary: `[${rotulo}] ${resumo}`, phone: "" }).catch(() => {});
}

/**
 * Envio de um lote de templates proativos. Centralizado para que as três
 * varreduras (lembrete, briefing, avaliação) compartilhem exatamente as mesmas
 * travas: opt-out, fuso válido, dedup e contabilidade de falhas.
 */
async function enviarLote(p: {
  kind: string;
  rotulo: string;
  origem: OrigemSaida;
  rows: ReminderRow[];
  /** Nome do template, fixo ou escolhido por reserva (v16: véspera com mapa quando há endereço). */
  template: string | ((r: ReminderRow) => string);
  /** Nome do evento no painel — preservado por varredura para não mudar o log. */
  evento: (locale: string) => string;
  corpo: (r: ReminderRow, pais: string | null) => string[];
  /** Sufixo do botão de URL do template (v16: consulta do mapa). */
  botaoUrl?: (r: ReminderRow) => string | undefined;
}): Promise<void> {
  let enviados = 0;
  let falhas = 0;
  const semFuso: string[] = [];
  const nomeTemplate = (r: ReminderRow) => (typeof p.template === "function" ? p.template(r) : p.template);

  // Todo desfecho é registrado, inclusive o não-envio: é ele que diz, no
  // canário, se a trava está calibrada ou engolindo cliente legítimo.
  const anotar = (desfecho: string, r: ReminderRow, extra: Partial<RegistroSaida> = {}) =>
    registrarSaida({
      origem: p.origem,
      evento: p.kind,
      reservationCode: r.reservation_code,
      template: nomeTemplate(r),
      desfecho,
      ...extra,
    });

  for (const r of p.rows) {
    if (!r.customer_phone) {
      await anotar("sem_telefone", r, { motivo: "cliente sem telefone cadastrado" });
      continue;
    }

    // Fuso desconhecido = não sabemos a que horas a reserva acontece. Mandar o
    // lembrete na hora errada é pior do que não mandar: vira finding.
    if (r.tz_valido === false) {
      semFuso.push(r.reservation_code);
      await anotar("sem_fuso", r, { motivo: `fuso não reconhecido no restaurante` });
      continue;
    }

    // A MESMA trava de telefone do caminho por evento (Fase 0): só E.164 inequívoco e linha
    // móvel. Sem isto, um número gravado sem "+" ou ambíguo (DDD brasileiro na posição do país)
    // seria "normalizado" e entregue a um estranho — com nome, restaurante e data do cliente.
    const tel = avaliarTelefone(r.customer_phone);
    if (!podeReceberWhatsApp(tel)) {
      await anotar("telefone_nao_enviavel", r, { qualidadeTelefone: tel.qualidade, pais: tel.pais, motivo: tel.motivo });
      continue;
    }
    const to = tel.e164;
    const consent = await podeReceberWhatsAppReservas(to); // opt-in (2026-09-25)
    if (!consent.ok) {
      await anotar(consent.motivo, r, { qualidadeTelefone: tel.qualidade, pais: tel.pais, motivo: DETALHE_CONSENTIMENTO[consent.motivo] });
      continue;
    }

    const locale = escolherLocale({ idiomaPreferido: consent.idioma, phone: to, aprovados: config.reminders.locales, defaultLocale: config.reminders.defaultLocale }).locale;
    const bodyParams = p.corpo(r, tel.pais);
    if (bodyParams.some((x) => x.length === 0)) {
      // A Meta rejeita parâmetro vazio, e mensagem com dado faltando é pior que silêncio.
      await anotar("dados_insuficientes", r, { locale, qualidadeTelefone: tel.qualidade, pais: tel.pais, motivo: "parâmetro vazio (nome, casa, data, hora ou pessoas)" });
      continue;
    }
    const ok = await sendTemplate({ to, template: nomeTemplate(r), locale, bodyParams, buttonUrlParam: p.botaoUrl?.(r) });
    if (!ok) {
      falhas++;
      await anotar("falha_envio", r, { locale, qualidadeTelefone: tel.qualidade, pais: tel.pais, motivo: "Cloud API recusou o envio" });
      continue;
    }

    await markReminderSent(r.reservation_code, p.kind, to).catch(() => {});
    enviados++;
    await anotar("enviado", r, { locale, qualidadeTelefone: tel.qualidade, pais: tel.pais });
    publish({
      kind: "tool_call",
      chat: to,
      tool: p.evento(locale),
      success: true,
      latency_ms: 0,
      at: new Date().toISOString(),
    });
  }

  if (enviados > 0) console.log(`[${p.rotulo}] ${enviados} envio(s) '${p.kind}' concluído(s)`);

  if (falhas > 0) {
    await reportarFalha(
      p.rotulo,
      `${falhas} de ${p.rows.length} envios '${p.kind}' falharam na Cloud API — ` +
        `verificar aprovação do template '${nomeTemplate(p.rows[0])}' nos idiomas em uso e a validade do número de destino.`,
    );
  }
  if (semFuso.length > 0) {
    await reportarFalha(
      p.rotulo,
      `${semFuso.length} reserva(s) sem fuso válido no restaurante — nada enviado, para não avisar na hora errada. ` +
        `Códigos: ${semFuso.slice(0, 10).join(", ")}${semFuso.length > 10 ? "…" : ""}`,
    );
  }
}

async function sweep(): Promise<void> {
  const h = config.reminders.hoursBefore;
  let rows: ReminderRow[] = [];
  try {
    // Janela de 1h em torno do alvo (h±0.5) — com varredura < 1h, cada reserva
    // é vista ao menos uma vez na janela e enviada uma única vez (dedup).
    rows = await getReservationsForReminder(KIND, h - 0.5, h + 0.5, [config.reminders.status]);
  } catch (err) {
    console.warn("[reminders] falha ao buscar reservas:", err instanceof Error ? err.message : err);
    return;
  }
  if (rows.length === 0) return;

  await enviarLote({
    kind: KIND,
    rotulo: "reminders",
    origem: "reminder",
    rows,
    template: config.reminders.template,
    evento: (locale) => `reminder_${KIND}_${locale}`,
    corpo: (r, pais) => [
      firstName(r.customer_name),
      r.restaurant_name ?? "",
      formatarHora(r.reservation_time, pais),
    ],
  });
}

/**
 * Briefing de VÉSPERA (~24h antes): antecipa a experiência com restaurante,
 * data e horário. Quando o cliente responde, cai na janela de 24h e a Aria
 * conduz como concierge: rota e hora de sair, dress code, observações da
 * reserva. Template: {{1}} nome · {{2}} restaurante · {{3}} data · {{4}} hora.
 */
async function sweepBriefing(): Promise<void> {
  const h = config.briefing.hoursBefore;
  let rows: ReminderRow[] = [];
  try {
    rows = await getReservationsForReminder(KIND_BRIEFING, h - 0.5, h + 0.5, [config.reminders.status]);
  } catch (err) {
    console.warn("[briefing] falha ao buscar reservas:", err instanceof Error ? err.message : err);
    return;
  }
  if (rows.length === 0) return;

  // v16: com endereço na ficha, vai a variante com {{6}} endereço e botão "Ver no mapa".
  const comMapa = (r: ReminderRow) => !!config.briefing.templateMap && enderecoParaFicha(r.address).length > 0;
  await enviarLote({
    kind: KIND_BRIEFING,
    rotulo: "briefing",
    origem: "briefing",
    rows,
    template: (r) => (comMapa(r) ? config.briefing.templateMap : config.briefing.template),
    evento: (locale) => `briefing_${locale}`,
    // {{1}} nome · {{2}} restaurante · {{3}} data por extenso · {{4}} hora · {{5}} pessoas · [{{6}} endereço].
    // Antes a data saía "03/10" — para um americano, 10 de março (corrigido 2026-09-25).
    corpo: (r, pais) => [
      firstName(r.customer_name),
      r.restaurant_name ?? "",
      formatarData(r.booking_date, pais),
      formatarHora(r.reservation_time, pais),
      formatarPessoas(r.people),
      ...(comMapa(r) ? [enderecoParaFicha(r.address)] : []),
    ],
    botaoUrl: (r) => (comMapa(r) ? consultaMapa(r.restaurant_name, r.city) : undefined),
  });
}

// ─── v16: pendência viva merece uma palavra ao cliente ────────────────────────

const KIND_PENDING_NUDGE = "pending_nudge";
const KIND_PENDING_CLOSE = "pending_close";

/** Parâmetros comuns das duas mensagens de pendência: {{1}} nome · {{2}} casa · {{3}} data · {{4}} hora. */
function corpoPendencia(r: ReminderRow, pais: string | null): string[] {
  return [firstName(r.customer_name), r.restaurant_name ?? "", formatarData(r.booking_date, pais), formatarHora(r.reservation_time, pais)];
}

/**
 * "Seu pedido segue conosco": 24 h depois do pedido, se ainda pendente e a mesa a mais de 24 h.
 * Não diz que a casa não respondeu (discrição, ADR-015); oferece procurar alternativa — o botão
 * volta como texto e a Aria conduz (FLUXO 4B do prompt).
 */
async function sweepPendingNudge(): Promise<void> {
  let rows: ReminderRow[] = [];
  try {
    rows = await getPendingForNudge(KIND_PENDING_NUDGE, config.pendingNudge.hours, config.pendingNudge.minHoursAhead, config.pendingStatuses);
  } catch (err) {
    console.warn("[pendente-cliente] falha ao buscar pedidos:", err instanceof Error ? err.message : err);
    return;
  }
  if (rows.length === 0) return;
  await enviarLote({
    kind: KIND_PENDING_NUDGE,
    rotulo: "pendente-cliente",
    origem: "reminder",
    rows,
    template: config.pendingNudge.template,
    evento: (locale) => `pending_nudge_${locale}`,
    corpo: corpoPendencia,
  });
}

/**
 * Encerramento honesto: faltam ≤ 20 h para a mesa e o pedido segue pendente. O cliente não pode
 * aparecer no restaurante contando com uma mesa que ninguém confirmou. Se a casa aceitar depois,
 * o evento "aceito" manda a confirmação normalmente.
 */
async function sweepPendingClose(): Promise<void> {
  let rows: ReminderRow[] = [];
  try {
    rows = await getPendingForClose(KIND_PENDING_CLOSE, config.pendingClose.hoursBefore, config.pendingClose.minAgeHours, config.pendingStatuses);
  } catch (err) {
    console.warn("[pendente-encerrar] falha ao buscar pedidos:", err instanceof Error ? err.message : err);
    return;
  }
  if (rows.length === 0) return;
  await enviarLote({
    kind: KIND_PENDING_CLOSE,
    rotulo: "pendente-encerrar",
    origem: "reminder",
    rows,
    template: config.pendingClose.template,
    evento: (locale) => `pending_close_${locale}`,
    corpo: corpoPendencia,
  });
}

/**
 * Pós-experiência: ~6h DEPOIS da reserva, agradece e convida a avaliar.
 * Janela negativa (passado). A coleta da avaliação é conduzida pela Aria quando
 * o cliente responder (tool save_experience_review).
 */
async function sweepReview(): Promise<void> {
  const h = config.review.hoursAfter;
  let rows: ReminderRow[] = [];
  try {
    // Reserva que ocorreu ~h horas atrás → janela [-h-0.5, -h+0.5].
    rows = await getReservationsForReminder(KIND_REVIEW, -h - 0.5, -h + 0.5, [config.review.status]);
  } catch (err) {
    console.warn("[review] falha ao buscar reservas:", err instanceof Error ? err.message : err);
    return;
  }
  if (rows.length === 0) return;

  await enviarLote({
    kind: KIND_REVIEW,
    rotulo: "review",
    origem: "review",
    rows,
    template: config.review.template,
    evento: (locale) => `review_invite_${locale}`,
    corpo: (r) => [firstName(r.customer_name), r.restaurant_name ?? ""],
  });
}

/**
 * Watchdog PENDENTE_12H: reservas paradas em aprovação há N horas geram uma
 * escalação automática no painel (uma única vez por reserva, dedup em
 * aria_reminders_sent kind='pending_watch'). NÃO envia nada ao cliente — é o
 * time da TWK que age antes de o cliente precisar reclamar.
 */
async function sweepPending(): Promise<void> {
  let rows: ReminderRow[] = [];
  try {
    rows = await getStalePendingReservations(config.pendingWatch.hours, config.pendingWatch.status);
  } catch (err) {
    console.warn("[pending-watch] falha ao buscar reservas:", err instanceof Error ? err.message : err);
    return;
  }

  for (const r of rows) {
    const phone = r.customer_phone ? normalizePhone(r.customer_phone) : "";
    try {
      await logEscalation({
        tag: "PENDENTE_12H",
        summary:
          `Watchdog: reserva ${r.reservation_code} no ${r.restaurant_name ?? "?"} ` +
          `(${String(r.booking_date).slice(0, 10)} ${(r.reservation_time ?? "").slice(0, 5)}, ${r.people ?? "?"} pax) ` +
          `aguardando aprovação há ${config.pendingWatch.hours}h+.`,
        phone,
        reservationCode: r.reservation_code,
      });
      await markReminderSent(r.reservation_code, "pending_watch", phone).catch(() => {});
      publish({
        kind: "escalation",
        chat: phone || null,
        tag: "PENDENTE_12H",
        summary: `Watchdog: ${r.reservation_code} pendente há ${config.pendingWatch.hours}h+`,
        at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[pending-watch] falha ao escalar:", err instanceof Error ? err.message : err);
    }
  }
  if (rows.length > 0) console.log(`[pending-watch] ${rows.length} escalação(ões) PENDENTE_12H criada(s)`);
}

/**
 * Confere, no boot, se os `booking_status` configurados existem de verdade em
 * `reservations`. É a trava contra a classe de bug que manteve este módulo
 * inerte: configuração que não casa com o banco fazia a varredura rodar,
 * anunciar "ativo" e enviar ZERO para sempre, sem nenhum sinal.
 *
 * Não derruba o boot — a varredura pode ser o único aviso de que o banco mudou.
 * Mas registra alto, para virar item de painel no mesmo dia.
 */
async function conferirStatusConfigurados(esperados: string[]): Promise<void> {
  let existentes: string[];
  try {
    existentes = await getDistinctBookingStatuses();
  } catch (err) {
    console.warn("[reminders] não foi possível conferir os status do banco:", err instanceof Error ? err.message : err);
    return;
  }

  const faltando = [...new Set(esperados.map((s) => s.trim().toLowerCase()))].filter(
    (s) => !existentes.includes(s),
  );
  if (faltando.length === 0) return;

  await reportarFalha(
    "reminders.config",
    `booking_status configurado não existe em reservations: ${faltando.join(", ")}. ` +
      `Valores presentes no banco: ${existentes.join(", ")}. ` +
      `Enquanto não casar, a varredura correspondente não encontra nenhuma reserva.`,
  );
}

export function startReminders(): void {
  const remindersOn = config.reminders.enabled && !!config.reminders.template;
  const reviewOn = config.review.enabled && !!config.review.template;
  const pendingOn = config.pendingWatch.enabled;
  const briefingOn = config.briefing.enabled && !!config.briefing.template;
  const nudgeOn = !!config.pendingNudge.template; // v16
  const closeOn = !!config.pendingClose.template; // v16

  if (config.reminders.enabled && !config.reminders.template)
    console.warn("[reminders] REMINDERS_ENABLED=true porém REMINDERS_TEMPLATE vazio — lembrete 2h não iniciado");
  if (config.review.enabled && !config.review.template)
    console.warn("[review] REVIEW_ENABLED=true porém REVIEW_TEMPLATE vazio — convite de avaliação não iniciado");
  if (config.briefing.enabled && !config.briefing.template)
    console.warn("[briefing] BRIEFING_ENABLED=true porém BRIEFING_TEMPLATE vazio — briefing de véspera não iniciado");

  if (!remindersOn && !reviewOn && !pendingOn && !briefingOn && !nudgeOn && !closeOn) {
    console.log("[reminders] outbound desativado (lembrete 2h, briefing 24h, avaliação 6h e pending-watch off)");
    return;
  }

  const intervalMs = config.reminders.sweepMinutes * 60_000;
  const tick = () => {
    if (remindersOn) void sweep();
    if (briefingOn) void sweepBriefing();
    if (reviewOn) void sweepReview();
    if (pendingOn) void sweepPending();
    if (nudgeOn) void sweepPendingNudge();
    if (closeOn) void sweepPendingClose();
  };
  setTimeout(() => {
    const esperados = [
      ...(remindersOn || briefingOn ? [config.reminders.status] : []),
      ...(reviewOn ? [config.review.status] : []),
      ...(pendingOn ? [config.pendingWatch.status] : []),
      ...(nudgeOn || closeOn ? config.pendingStatuses : []),
    ];
    void conferirStatusConfigurados(esperados);
    tick();
    setInterval(tick, intervalMs).unref();
  }, 45_000); // aguarda migrations + boot

  if (remindersOn)
    console.log(`[reminders] lembrete ${config.reminders.hoursBefore}h antes ativo · status='${config.reminders.status}'`);
  if (briefingOn)
    console.log(`[briefing] briefing de véspera ${config.briefing.hoursBefore}h antes ativo`);
  if (reviewOn)
    console.log(`[review] convite de avaliação ${config.review.hoursAfter}h após ativo · status='${config.review.status}'`);
  if (pendingOn)
    console.log(`[pending-watch] escalação automática após ${config.pendingWatch.hours}h em '${config.pendingWatch.status}'`);
  if (nudgeOn)
    console.log(`[pendente-cliente] "seu pedido segue conosco" ${config.pendingNudge.hours}h depois do pedido · template '${config.pendingNudge.template}'`);
  if (closeOn)
    console.log(`[pendente-encerrar] encerramento honesto a ${config.pendingClose.hoursBefore}h da mesa · template '${config.pendingClose.template}'`);
  if (briefingOn && config.briefing.templateMap)
    console.log(`[briefing] véspera com endereço e mapa · template '${config.briefing.templateMap}'`);
}
