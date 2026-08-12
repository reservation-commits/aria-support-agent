/**
 * phone.ts — normalização centralizada de números de telefone.
 *
 * O WhatsApp Cloud API entrega o `from` sem o "+". Internamente usamos
 * sempre o formato E.164 com "+", que é o padrão salvo no banco.
 * Usar esta função em todos os pontos de entrada garante consistência.
 */

/**
 * Normaliza qualquer string de telefone para E.164 com "+".
 * Exemplos:
 *   "5511999999999"   → "+5511999999999"
 *   "+5511999999999"  → "+5511999999999"
 *   "+55 (11) 99999-9999" → "+5511999999999"
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return `+${digits}`;
}
