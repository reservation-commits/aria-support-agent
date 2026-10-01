/**
 * consentRegra.ts — a regra de quem recebe notificação de reserva por WhatsApp.
 *
 * Decisão do fundador (2026-09-25): o WhatsApp de reservas é OPT-IN. Só recebe quem
 * está marcado no banco (`aria_contact_consent.whatsapp_reservas = true`). Desmarcar,
 * ou o cliente escrever "PARAR", elimina a possibilidade de envio. Sem linha na tabela
 * = não recebe. Vale para cliente e para estabelecimento (coluna `tipo`).
 *
 * Lógica pura, sem banco: testável e a mesma para os dois remetentes
 * (reservationEvents.ts por evento, reminders.ts por tempo).
 */

export interface LinhaConsentimento {
  whatsapp_reservas: boolean;
  outbound_opted_out: boolean;
  /** v19: a Meta devolveu "undeliverable" — o número não tem WhatsApp. Lista de bloqueio junto com o PARAR. */
  whatsapp_indisponivel?: boolean | null;
  tipo?: string | null;
  idioma?: string | null;
}

export type MotivoConsentimento = "sem_opt_in" | "opt_out" | "indisponivel";
export type DecisaoConsentimento = { ok: true; motivo: "ok"; idioma: string | null } | { ok: false; motivo: MotivoConsentimento };

export function decidirEnvioWhatsApp(linha: LinhaConsentimento | null | undefined): DecisaoConsentimento {
  if (!linha) return { ok: false, motivo: "sem_opt_in" };
  if (linha.outbound_opted_out) return { ok: false, motivo: "opt_out" };
  if (!linha.whatsapp_reservas) return { ok: false, motivo: "sem_opt_in" };
  if (linha.whatsapp_indisponivel) return { ok: false, motivo: "indisponivel" };
  return { ok: true, motivo: "ok", idioma: linha.idioma ?? null };
}

export const DETALHE_CONSENTIMENTO: Record<MotivoConsentimento, string> = {
  sem_opt_in: "não está marcado para receber WhatsApp de reservas",
  opt_out: "pediu para não receber",
  indisponivel: "número sem WhatsApp (a Meta devolveu 'undeliverable') — bloqueado até correção",
};
