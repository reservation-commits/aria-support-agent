/**
 * alerts.ts — alertas que SAEM do navegador.
 *
 * O painel toca um beep quando chega escalação — mas se ninguém estiver com a
 * aba aberta, o alerta morre ali. Este módulo assina o pub-sub de eventos e
 * envia EMAIL para a equipe (via canal de email já configurado) quando algo
 * crítico acontece:
 *
 *   • escalação URGENTE (SLA 15 min) — imediato;
 *   • demais escalações — agrupadas pelo throttle;
 *   • health check reprovado (DB/WhatsApp fora);
 *   • teto diário de custo atingido (evento "error" do costGuard);
 *   • falhas em testes automáticos.
 *
 * Throttle por tipo (ALERT_MIN_INTERVAL_MIN, padrão 30 min) para não virar
 * spam. DESLIGADO por padrão — liga com ALERTS_ENABLED=true + ALERT_EMAIL_TO
 * (requer o canal de email ativo para o envio).
 */

import { config } from "./config.js";
import { events, type AriaEvent } from "./dashboard/events.js";
import { sendOperatorEmail } from "./emailChannel.js";

const _lastSent = new Map<string, number>();

function throttled(key: string, minMs: number): boolean {
  const last = _lastSent.get(key) ?? 0;
  if (Date.now() - last < minMs) return true;
  _lastSent.set(key, Date.now());
  return false;
}

function describe(ev: AriaEvent): { key: string; urgent: boolean; text: string } | null {
  switch (ev.kind) {
    case "escalation":
      return {
        key: `escalation:${ev.tag}`,
        urgent: ev.tag === "URGENTE",
        text: `Escalação ${ev.tag}\nConversa: ${ev.chat ?? "?"}\n${ev.summary}`,
      };
    case "health_check":
      if (ev.overall_ok) return null;
      return {
        key: "health",
        urgent: true,
        text: `Health check reprovado — DB ok: ${ev.db_ok} · WhatsApp ok: ${ev.whatsapp_ok}`,
      };
    case "error":
      return { key: `error:${ev.where}`, urgent: false, text: `Erro em ${ev.where}: ${ev.message}` };
    case "test_run":
      if (ev.failed === 0) return null;
      return { key: "tests", urgent: false, text: `Testes automáticos: ${ev.failed}/${ev.total} falharam` };
    default:
      return null;
  }
}

export function startAlerts(): void {
  if (!config.alerts.enabled || !config.alerts.emailTo) {
    console.log("[alerts] desativado (ALERTS_ENABLED=false ou sem ALERT_EMAIL_TO)");
    return;
  }
  if (!config.email.enabled) {
    console.warn("[alerts] ALERTS_ENABLED=true mas o canal de email está desligado — alertas não sairão");
    return;
  }
  const minMs = Math.max(1, config.alerts.minIntervalMin) * 60_000;

  events.on("event", (ev: AriaEvent) => {
    const d = describe(ev);
    if (!d) return;
    // Urgente fura o throttle; o resto respeita o intervalo mínimo por tipo.
    if (!d.urgent && throttled(d.key, minMs)) return;
    if (d.urgent && throttled(`${d.key}:urgent`, 5 * 60_000)) return; // anti-loop mesmo p/ urgente
    const body =
      `Alerta da Aria — ${new Date().toISOString()}\n\n${d.text}\n\n` +
      `Painel: acesse /dashboard para agir.`;
    void sendOperatorEmail(config.alerts.emailTo, body).then((ok) => {
      if (!ok) console.warn("[alerts] falha ao enviar alerta por email");
    });
  });

  console.log(`[alerts] ativos → ${config.alerts.emailTo} (throttle ${config.alerts.minIntervalMin} min)`);
}
