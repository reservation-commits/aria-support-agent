/**
 * compromissoRegra.ts — regra pura do compromisso de retorno (ADR-015).
 *
 * "A data em que NÓS voltamos com alternativas" só pode ser dita ao cliente se existir
 * processo que a cumpra. O processo é: a Aria registra a data (tool registrar_compromisso)
 * e, nesse dia, ela mesma volta ao cliente (compromissos.ts). Sem registro, a data é
 * barrada pela porta de saída. Aqui vive só a validação da data.
 */

export const MAX_DIAS_COMPROMISSO = 7;

export type ValidacaoData = { ok: true; due: string } | { ok: false; motivo: string };

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function validarDataCompromisso(bruto: string, hoje: Date = new Date()): ValidacaoData {
  const s = (bruto ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, motivo: "data deve estar no formato AAAA-MM-DD" };
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || ymd(d) !== s) return { ok: false, motivo: "data inválida" };
  const h = new Date(ymd(hoje) + "T00:00:00Z");
  const dias = Math.round((d.getTime() - h.getTime()) / 86_400_000);
  if (dias < 0) return { ok: false, motivo: "data no passado" };
  if (dias > MAX_DIAS_COMPROMISSO) return { ok: false, motivo: `no máximo ${MAX_DIAS_COMPROMISSO} dias à frente` };
  return { ok: true, due: s };
}
