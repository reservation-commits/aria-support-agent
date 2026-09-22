/**
 * handoff.ts
 *
 * "Modo humano" por conversa. Quando um atendente do time assume um chat
 * (pelo painel), a Aria para de responder àquele número por um tempo, para não
 * atravessar a conversa do humano com o cliente. Após o TTL, a Aria volta
 * automaticamente.
 *
 * Estado em memória + PERSISTÊNCIA em public.aria_handoffs: após um restart a
 * Aria continua em silêncio nos chats assumidos por humano. O check consulta a
 * memória primeiro e, em miss, o banco (com cache negativo de TTL curto). Toda
 * escrita/leitura de banco é best-effort — falha de banco nunca derruba o
 * atendimento.
 */

import { pool } from "./db.js";

type HandoffEntry = { until: number; agent: string | null };

const handoffs = new Map<string, HandoffEntry>();

// Cache negativo: chats confirmados SEM handoff no banco, para não consultar
// o banco a cada mensagem. TTL curto para enxergar takeover de outra réplica.
const dbMissUntil = new Map<string, number>();
const DB_MISS_TTL_MS = 30_000;

const DEFAULT_MINUTES = 60;

/** Coloca a conversa sob controle humano por `minutes` (a Aria silencia). */
export function takeOver(chatId: string, minutes = DEFAULT_MINUTES, agent: string | null = null): void {
  const until = Date.now() + minutes * 60_000;
  handoffs.set(chatId, { until, agent });
  dbMissUntil.delete(chatId);
  void pool
    .query(
      `INSERT INTO public.aria_handoffs (phone, operator, until)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET operator = EXCLUDED.operator, until = EXCLUDED.until`,
      [chatId, agent, new Date(until)],
    )
    .catch((e) => console.error("[handoff] falha ao persistir takeover (segue em memória):", e));
}

/** Devolve a conversa para a Aria imediatamente. */
export function release(chatId: string): void {
  handoffs.delete(chatId);
  dbMissUntil.delete(chatId);
  void pool
    .query(`DELETE FROM public.aria_handoffs WHERE phone = $1`, [chatId])
    .catch((e) => console.error("[handoff] falha ao persistir release (segue em memória):", e));
}

/** True se a Aria deve ficar em silêncio (humano no controle e TTL válido). */
export async function isHumanControlled(chatId: string): Promise<boolean> {
  const e = handoffs.get(chatId);
  if (e) {
    if (Date.now() <= e.until) return true;
    handoffs.delete(chatId);
  }

  // Miss em memória → banco (a menos que já saibamos que não há handoff).
  const missUntil = dbMissUntil.get(chatId);
  if (missUntil !== undefined && Date.now() < missUntil) return false;
  try {
    const { rows } = await pool.query(
      `SELECT operator, until FROM public.aria_handoffs
        WHERE phone = $1 AND until > NOW()`,
      [chatId],
    );
    if (rows.length > 0) {
      const until = new Date(rows[0].until as string).getTime();
      handoffs.set(chatId, { until, agent: (rows[0].operator as string | null) ?? null });
      return true;
    }
    dbMissUntil.set(chatId, Date.now() + DB_MISS_TTL_MS);
    return false;
  } catch (err) {
    // Best-effort: sem banco, vale só a memória — não derrubar o atendimento.
    console.error("[handoff] consulta ao banco falhou (usando só memória):", err);
    return false;
  }
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
