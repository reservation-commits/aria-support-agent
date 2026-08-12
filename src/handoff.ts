/**
 * handoff.ts
 *
 * "Modo humano" por conversa. Quando um atendente do time assume um chat
 * (pelo painel), a Aria para de responder àquele número por um tempo, para não
 * atravessar a conversa do humano com o cliente. Após o TTL, a Aria volta
 * automaticamente.
 *
 * Estado em memória (instância única, consistente com sessions/rate-limit).
 * Para múltiplas réplicas, migrar para Redis/Postgres.
 */

type HandoffEntry = { until: number; agent: string | null };

const handoffs = new Map<string, HandoffEntry>();

const DEFAULT_MINUTES = 60;

/** Coloca a conversa sob controle humano por `minutes` (a Aria silencia). */
export function takeOver(chatId: string, minutes = DEFAULT_MINUTES, agent: string | null = null): void {
  handoffs.set(chatId, { until: Date.now() + minutes * 60_000, agent });
}

/** Devolve a conversa para a Aria imediatamente. */
export function release(chatId: string): void {
  handoffs.delete(chatId);
}

/** True se a Aria deve ficar em silêncio (humano no controle e TTL válido). */
export function isHumanControlled(chatId: string): boolean {
  const e = handoffs.get(chatId);
  if (!e) return false;
  if (Date.now() > e.until) {
    handoffs.delete(chatId);
    return false;
  }
  return true;
}

/** Lista as conversas atualmente em modo humano (para o painel). */
export function listHandoffs(): Array<{ chatId: string; until: string; agent: string | null }> {
  const now = Date.now();
  const out: Array<{ chatId: string; until: string; agent: string | null }> = [];
  for (const [chatId, e] of handoffs) {
    if (now > e.until) {
      handoffs.delete(chatId);
      continue;
    }
    out.push({ chatId, until: new Date(e.until).toISOString(), agent: e.agent });
  }
  return out;
}
