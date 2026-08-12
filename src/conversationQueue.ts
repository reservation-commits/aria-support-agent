/**
 * conversationQueue.ts
 *
 * Serializa e agrupa as mensagens de cada conversa.
 *
 * Problema que resolve: no WhatsApp o cliente costuma escrever em rajada
 * ("oi" / "queria reservar" / "em Paris" em três balões seguidos). Sem
 * controle, cada webhook dispararia um runAgent em paralelo — três leituras
 * do mesmo histórico, três escritas com last-write-wins (corrompendo o
 * histórico) e três respostas desencontradas.
 *
 * Estratégia:
 *   1. DEBOUNCE — ao chegar uma mensagem, ela entra num buffer por chatId e um
 *      timer curto é (re)armado. Mensagens que chegam dentro da janela são
 *      acumuladas e processadas como UM único turno do agente.
 *   2. SERIALIZAÇÃO — nunca há dois turnos do mesmo chatId rodando ao mesmo
 *      tempo. Se chegar mensagem durante o processamento, ela é bufferizada e
 *      processada logo depois, em sequência.
 *
 * Conversas diferentes seguem rodando em paralelo normalmente.
 */

import type { AriaContentBlock } from "./webhook.js";

export type TurnProcessor = (
  chatId: string,
  pushName: string | null,
  blocks: AriaContentBlock[],
) => Promise<void>;

type ChatState = {
  buffer: AriaContentBlock[];
  pushName: string | null;
  timer: NodeJS.Timeout | null;
  processing: boolean;
};

const states = new Map<string, ChatState>();

/**
 * Adiciona o conteúdo de uma mensagem recebida ao buffer da conversa e
 * (re)agenda o flush. O processor é chamado uma única vez por rajada.
 */
export function enqueueMessage(
  chatId: string,
  pushName: string | null,
  blocks: AriaContentBlock[],
  processor: TurnProcessor,
  debounceMs: number,
): void {
  let st = states.get(chatId);
  if (!st) {
    st = { buffer: [], pushName, timer: null, processing: false };
    states.set(chatId, st);
  }
  if (pushName) st.pushName = pushName;
  st.buffer.push(...blocks);
  scheduleFlush(chatId, processor, debounceMs);
}

function scheduleFlush(chatId: string, processor: TurnProcessor, debounceMs: number): void {
  const st = states.get(chatId);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => void flush(chatId, processor, debounceMs), debounceMs);
  st.timer.unref?.();
}

async function flush(chatId: string, processor: TurnProcessor, debounceMs: number): Promise<void> {
  const st = states.get(chatId);
  if (!st) return;
  st.timer = null;

  // Já há um turno rodando para este chat — re-arma e tenta de novo depois.
  if (st.processing) {
    scheduleFlush(chatId, processor, debounceMs);
    return;
  }
  if (st.buffer.length === 0) {
    states.delete(chatId);
    return;
  }

  // Consome o buffer atual como um único turno.
  st.processing = true;
  const blocks = st.buffer;
  const pushName = st.pushName;
  st.buffer = [];

  try {
    await processor(chatId, pushName, blocks);
  } catch (err) {
    console.error("[queue] erro no processor:", err instanceof Error ? err.message : err);
  } finally {
    st.processing = false;
    // Mensagens chegaram durante o processamento → processa a próxima rajada.
    if (st.buffer.length > 0) {
      scheduleFlush(chatId, processor, debounceMs);
    } else if (!st.timer) {
      states.delete(chatId);
    }
  }
}
