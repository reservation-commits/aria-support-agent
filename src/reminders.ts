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
  getReservationsForReminder,
  getStalePendingReservations,
  logEscalation,
  markReminderSent,
  isOptedOut,
  type ReminderRow,
} from "./db.js";
import { sendTemplate } from "./whatsapp.js";
import { normalizePhone } from "./phone.js";
import { languageForPhone } from "./locale.js";
import { publish } from "./dashboard/events.js";

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

  let sent = 0;
  for (const r of rows) {
    if (!r.customer_phone) continue;
    const to = normalizePhone(r.customer_phone);
    if (await isOptedOut(to)) continue; // respeita opt-out
    const locale = localeForPhone(to, config.reminders.defaultLocale);
    const ok = await sendTemplate({
      to,
      template: config.reminders.template,
      locale,
      bodyParams: [
        firstName(r.customer_name),
        r.restaurant_name ?? "",
        (r.reservation_time ?? "").slice(0, 5),
      ],
    });
    if (ok) {
      await markReminderSent(r.reservation_code, KIND, to).catch(() => {});
      sent++;
      publish({
        kind: "tool_call",
        chat: to,
        tool: `reminder_${KIND}_${locale}`,
        success: true,
        latency_ms: 0,
        at: new Date().toISOString(),
      });
    }
  }
  if (sent > 0) console.log(`[reminders] ${sent} lembrete(s) ${KIND} enviado(s)`);
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

  let sent = 0;
  for (const r of rows) {
    if (!r.customer_phone) continue;
    const to = normalizePhone(r.customer_phone);
    if (await isOptedOut(to)) continue; // respeita opt-out
    const locale = localeForPhone(to, config.reminders.defaultLocale);
    const dateStr = String(r.booking_date ?? "").slice(0, 10).split("-").reverse().slice(0, 2).join("/");
    const ok = await sendTemplate({
      to,
      template: config.briefing.template,
      locale,
      bodyParams: [
        firstName(r.customer_name),
        r.restaurant_name ?? "",
        dateStr,
        (r.reservation_time ?? "").slice(0, 5),
      ],
    });
    if (ok) {
      await markReminderSent(r.reservation_code, KIND_BRIEFING, to).catch(() => {});
      sent++;
      publish({ kind: "tool_call", chat: to, tool: `briefing_${locale}`, success: true, latency_ms: 0, at: new Date().toISOString() });
    }
  }
  if (sent > 0) console.log(`[briefing] ${sent} briefing(s) de véspera enviado(s)`);
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

  let sent = 0;
  for (const r of rows) {
    if (!r.customer_phone) continue;
    const to = normalizePhone(r.customer_phone);
    if (await isOptedOut(to)) continue; // respeita opt-out
    const locale = localeForPhone(to, config.reminders.defaultLocale);
    const ok = await sendTemplate({
      to,
      template: config.review.template,
      locale,
      bodyParams: [firstName(r.customer_name), r.restaurant_name ?? ""],
    });
    if (ok) {
      await markReminderSent(r.reservation_code, KIND_REVIEW, to).catch(() => {});
      sent++;
      publish({ kind: "tool_call", chat: to, tool: `review_invite_${locale}`, success: true, latency_ms: 0, at: new Date().toISOString() });
    }
  }
  if (sent > 0) console.log(`[review] ${sent} convite(s) de avaliação enviado(s)`);
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
