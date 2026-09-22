import { pool } from "../db.js";
import { publish } from "./events.js";

export type MessageDirection = "inbound" | "outbound";

export type LogMessageInput = {
  chatId: string;
  pushName?: string | null;
  direction: MessageDirection;
  waMessageId?: string | null;
  content: string;
  hasMedia?: boolean;
  mediaType?: string | null;
};

export async function logMessage(input: LogMessageInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.aria_messages
         (chat_id, push_name, direction, wa_message_id, content, has_media, media_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.chatId,
        input.pushName ?? null,
        input.direction,
        input.waMessageId ?? null,
        truncate(input.content, 8000),
        input.hasMedia ?? false,
        input.mediaType ?? null,
      ],
    );
  } catch (err) {
    // Logging is best-effort — never break the flow.
    console.warn("[logger.logMessage]", err instanceof Error ? err.message : err);
  }

  publish(
    input.direction === "inbound"
      ? {
          kind: "message_in",
          chat: input.chatId,
          name: input.pushName ?? null,
          text: truncate(input.content, 280),
          at: new Date().toISOString(),
        }
      : {
          kind: "message_out",
          chat: input.chatId,
          text: truncate(input.content, 280),
          at: new Date().toISOString(),
        },
  );
}

export type LogToolCallInput = {
  chatId?: string | null;
  toolName: string;
  input: unknown;
  outputSummary: string;
  success: boolean;
  errorMessage?: string | null;
  latencyMs: number;
};

export async function logToolCall(input: LogToolCallInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.aria_tool_calls
         (chat_id, tool_name, input_json, output_summary, success, error_message, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.chatId ?? null,
        input.toolName,
        safeJson(input.input),
        truncate(input.outputSummary, 2000),
        input.success,
        input.errorMessage ?? null,
        Math.max(0, Math.round(input.latencyMs)),
      ],
    );
  } catch (err) {
    console.warn("[logger.logToolCall]", err instanceof Error ? err.message : err);
  }

  publish({
    kind: "tool_call",
    chat: input.chatId ?? null,
    tool: input.toolName,
    success: input.success,
    latency_ms: Math.round(input.latencyMs),
    at: new Date().toISOString(),
  });
}

export type LogScopeBlockInput = {
  chatId: string;
  channel: string;
  sender?: string | null;
  subject?: string | null;
  // "outbound" = barrado na SAÍDA (nota interna, idioma divergente, dump de tool).
  // As duas primeiras barram na entrada; esta protege o cliente do que a Aria escreveu.
  layer: "structural" | "semantic" | "outbound";
  reason: string;
  snippet?: string | null;
};

/**
 * Registra uma mensagem IGNORADA por estar fora de escopo (newsletter, marketing,
 * relatório automático). Persiste para auditoria e emite evento ao vivo para o
 * painel — a Aria não respondeu, mas o operador vê (e pega falso positivo).
 * Best-effort: nunca quebra o fluxo.
 */
export async function logScopeBlock(input: LogScopeBlockInput): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.aria_scope_blocks
         (chat_id, channel, sender, subject, layer, reason, snippet)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.chatId,
        input.channel,
        input.sender ?? null,
        input.subject ?? null,
        input.layer,
        truncate(input.reason, 500),
        truncate(input.snippet ?? "", 2000),
      ],
    );
  } catch (err) {
    console.warn("[logger.logScopeBlock]", err instanceof Error ? err.message : err);
  }

  publish({
    kind: "scope_blocked",
    chat: input.chatId,
    channel: input.channel,
    sender: input.sender ?? null,
    subject: input.subject ?? null,
    reason: input.reason,
    layer: input.layer,
    at: new Date().toISOString(),
  });
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return "null";
  }
}
