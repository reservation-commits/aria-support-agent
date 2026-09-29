/**
 * compromissosDb.ts — persistência dos compromissos de retorno (só banco, sem ciclos de import).
 */

import { pool } from "./db.js";

export type ContextoEmail = {
  to: string;
  subject: string | null;
  gmailMessageId: string | null;
  threadId: string | null;
  mailbox: string;
  messageIdHeader?: string | null;
  references?: string | null;
};

export type Compromisso = {
  id: number;
  chat_id: string;
  channel: "whatsapp" | "email";
  due_at: string;
  o_que: string | null;
  reservation_code: string | null;
  status: string;
  email_ctx: ContextoEmail | null;
};

export async function registrarCompromisso(p: {
  chatId: string;
  channel: "whatsapp" | "email";
  due: string;
  oQue: string;
  reservationCode: string | null;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO public.aria_commitments (chat_id, channel, due_at, o_que, reservation_code)
     VALUES ($1, $2, $3::date, $4, $5) RETURNING id::text AS id`,
    [p.chatId, p.channel, p.due, p.oQue, p.reservationCode],
  );
  return Number(rows[0].id);
}

/** Compromisso aberto registrado há poucos minutos nesta conversa — é o que libera a data na carta. */
export async function compromissoDesteTurno(chatId: string): Promise<{ id: number; due: string } | null> {
  try {
    const { rows } = await pool.query<{ id: string; due: string }>(
      `SELECT id::text AS id, to_char(due_at, 'YYYY-MM-DD') AS due FROM public.aria_commitments
        WHERE chat_id = $1 AND status = 'aberto' AND created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [chatId],
    );
    return rows[0] ? { id: Number(rows[0].id), due: rows[0].due } : null;
  } catch {
    return null;
  }
}

export async function anexarContextoEmail(chatId: string, ctx: ContextoEmail): Promise<void> {
  await pool.query(
    `UPDATE public.aria_commitments SET email_ctx = $2::jsonb
      WHERE chat_id = $1 AND status = 'aberto' AND email_ctx IS NULL`,
    [chatId, JSON.stringify(ctx)],
  );
}

export async function compromissosVencendo(limite = 20): Promise<Compromisso[]> {
  const { rows } = await pool.query<Compromisso & { id: string }>(
    `SELECT id::text AS id, chat_id, channel, to_char(due_at, 'YYYY-MM-DD') AS due_at, o_que, reservation_code, status, email_ctx
       FROM public.aria_commitments
      WHERE status = 'aberto' AND due_at <= CURRENT_DATE AND nudged_at IS NULL
      ORDER BY due_at ASC, created_at ASC LIMIT $1`,
    [limite],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Reivindica o compromisso para este processo (evita duas execuções). true = é nosso. */
export async function reivindicar(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE public.aria_commitments SET nudged_at = NOW() WHERE id = $1 AND nudged_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function concluir(id: number, status: "cumprido" | "retido" | "sem_canal"): Promise<void> {
  await pool.query(
    `UPDATE public.aria_commitments SET status = $2, fulfilled_at = CASE WHEN $2 = 'cumprido' THEN NOW() ELSE fulfilled_at END WHERE id = $1`,
    [id, status],
  );
}

export async function ultimaEntrada(chatId: string): Promise<{ content: string; created_at: Date } | null> {
  const { rows } = await pool.query<{ content: string | null; created_at: Date }>(
    `SELECT content, created_at FROM public.aria_messages WHERE chat_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    [chatId],
  );
  return rows[0] ? { content: rows[0].content ?? "", created_at: rows[0].created_at } : null;
}
