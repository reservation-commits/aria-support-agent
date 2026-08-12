import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { summarizeAndSaveSession } from "./summarizer.js";
import { trimHistory } from "./historyTrim.js";
import {
  saveSessionCheckpoint,
  loadSessionCheckpoint,
  deleteSessionCheckpoint,
} from "./db.js";

type Session = {
  messages: Anthropic.MessageParam[];
  updatedAt: number;
};

const sessions = new Map<string, Session>();
const TTL_MS = config.session.ttlMinutes * 60_000;

export function getHistory(chatId: string): Anthropic.MessageParam[] {
  const s = sessions.get(chatId);
  if (!s) return [];
  if (Date.now() - s.updatedAt > TTL_MS) {
    void summarizeAndSaveSession(chatId, s.messages);
    void deleteSessionCheckpoint(chatId).catch(() => {});
    sessions.delete(chatId);
    return [];
  }
  return s.messages;
}

/**
 * Tenta recuperar o histórico do banco quando não está em memória.
 * Chamado na primeira mensagem de cada conversa após um restart.
 */
export async function getOrRestoreHistory(chatId: string): Promise<Anthropic.MessageParam[]> {
  const inMemory = getHistory(chatId);
  if (inMemory.length > 0) return inMemory;

  try {
    const restored = await loadSessionCheckpoint(chatId);
    if (restored && restored.length > 0) {
      // Reativa a sessão em memória sem disparar sumarização.
      sessions.set(chatId, { messages: restored, updatedAt: Date.now() });
      console.log(`[sessions] sessão restaurada do banco para ${chatId} (${restored.length} msgs)`);
      return restored;
    }
  } catch (err) {
    console.warn("[sessions] falha ao restaurar checkpoint:", err instanceof Error ? err.message : err);
  }

  return [];
}

export function setHistory(chatId: string, messages: Anthropic.MessageParam[]): void {
  const maxMessages = config.session.maxHistoryTurns * 2;
  const trimmed = trimHistory(messages, maxMessages);

  sessions.set(chatId, { messages: trimmed, updatedAt: Date.now() });

  // Persiste no banco de forma assíncrona e best-effort — nunca bloqueia.
  void saveSessionCheckpoint(chatId, trimmed).catch((err) =>
    console.warn("[sessions] falha ao salvar checkpoint:", err instanceof Error ? err.message : err),
  );
}

export function clearSession(chatId: string): void {
  sessions.delete(chatId);
  void deleteSessionCheckpoint(chatId).catch(() => {});
}

/**
 * Retorna uma cópia de todas as sessões ativas em memória.
 * Usado pelo graceful shutdown para sumarizar antes de encerrar.
 */
export function getAllActiveSessions(): Array<{ chatId: string; messages: Anthropic.MessageParam[] }> {
  return [...sessions.entries()].map(([chatId, s]) => ({ chatId, messages: s.messages }));
}

// Limpeza periódica de sessões expiradas.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > TTL_MS) {
      void summarizeAndSaveSession(id, s.messages);
      void deleteSessionCheckpoint(id).catch(() => {});
      sessions.delete(id);
    }
  }
}, 5 * 60_000).unref();
