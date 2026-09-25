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
import { languageForPhone } from "./locale.js";
import { publish } from "./dashboard/events.js";
import { registrarSaida, type OrigemSaida, type RegistroSaida } from "./outboundLog.js";
import { avaliarTelefone, podeReceberWhatsApp } from "./phoneQuality.js";

const KIND = "2h";
const KIND_REVIEW = "6h_review";
const KIND_BRIEFING = "briefing_24h";

// Idioma base (pt/en/es/fr) → código de idioma do template no WhatsApp.
const BASE_TO_TEMPLATE: Record<string, string> = { pt: "pt_BR", en: "en", es: "es", fr: "fr" };

/**
 * Idioma do template para um telefone. Só retorna um idioma que esteja entre os
 * APROVADOS (config.reminders.locales) — caso contrário cai no fallback. Evita
 * tentar enviar numa tradução que ainda não existe no template (envio falharia).
 */
function localeForPhone(phone: string, fallback: string): string {
  const allowed = config.reminders.locales;
  const inAllowed = (lang: string) => allowed.length === 0 || allowed.includes(lang);
  const safeFallback = inAllowed(fallback) ? fallback : allowed[0] ?? fallback;
  const lang = BASE_TO_TEMPLATE[languageForPhone(phone)] ?? fallback;
  return inAllowed(lang) ? lang : safeFallback;
}

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
  template: string;
  /** Nome do evento no painel — preservado por varredura para não mudar o log. */
  evento: (locale: string) => string;
  corpo: (r: ReminderRow) => string[];
}): Promise<void> {
  let enviados = 0;
  let falhas = 0;
  const semFuso: string[] = [];

  // Todo desfecho é registrado, inclusive o não-envio: é ele que diz, no
  // canário, se a trava está calibrada ou engolindo cliente legítimo.
  const anotar = (desfecho: string, r: ReminderRow, extra: Partial<RegistroSaida> = {}) =>
    registrarSaida({
      origem: p.origem,
      evento: p.kind,
      reservationCode: r.reservation_code,
      template: p.template,
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

    const locale = localeForPhone(to, config.reminders.defaultLocale);
    const ok = await sendTemplate({ to, template: p.template, locale, bodyParams: p.corpo(r) });
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
        `verificar aprovação do template '${p.template}' nos idiomas em uso e a validade do número de destino.`,
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
    corpo: (r) => [
      firstName(r.customer_name),
      r.restaurant_name ?? "",
      (r.reservation_time ?? "").slice(0, 5),
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

  await enviarLote({
    kind: KIND_BRIEFING,
    rotulo: "briefing",
    origem: "briefing",
    rows,
    template: config.briefing.template,
    evento: (locale) => `briefing_${locale}`,
    corpo: (r) => [
      firstName(r.customer_name),
      r.restaurant_name ?? "",
      String(r.booking_date ?? "").slice(0, 10).split("-").reverse().slice(0, 2).join("/"),
      (r.reservation_time ?? "").slice(0, 5),
    ],
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

  if (config.reminders.enabled && !config.reminders.template)
    console.warn("[reminders] REMINDERS_ENABLED=true porém REMINDERS_TEMPLATE vazio — lembrete 2h não iniciado");
  if (config.review.enabled && !config.review.template)
    console.warn("[review] REVIEW_ENABLED=true porém REVIEW_TEMPLATE vazio — convite de avaliação não iniciado");
  if (config.briefing.enabled && !config.briefing.template)
    console.warn("[briefing] BRIEFING_ENABLED=true porém BRIEFING_TEMPLATE vazio — briefing de véspera não iniciado");

  if (!remindersOn && !reviewOn && !pendingOn && !briefingOn) {
    console.log("[reminders] outbound desativado (lembrete 2h, briefing 24h, avaliação 6h e pending-watch off)");
    return;
  }

  const intervalMs = config.reminders.sweepMinutes * 60_000;
  const tick = () => {
    if (remindersOn) void sweep();
    if (briefingOn) void sweepBriefing();
    if (reviewOn) void sweepReview();
    if (pendingOn) void sweepPending();
  };
  setTimeout(() => {
    const esperados = [
      ...(remindersOn || briefingOn ? [config.reminders.status] : []),
      ...(reviewOn ? [config.review.status] : []),
      ...(pendingOn ? [config.pendingWatch.status] : []),
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
}
