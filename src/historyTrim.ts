/**
 * historyTrim.ts
 *
 * Lógica pura (sem I/O, sem config) de aparo do histórico de mensagens.
 * Isolada aqui para ser testável sem subir o pool do banco nem exigir envs.
 */

import type Anthropic from "@anthropic-ai/sdk";

/**
 * Apara o histórico mantendo no máximo `maxMessages` mensagens, MAS sem nunca
 * quebrar a integridade exigida pela API da Anthropic:
 *
 *  - A janela precisa começar numa mensagem `user` que NÃO seja um tool_result
 *    órfão (todo bloco tool_result tem que vir logo após o tool_use que o gerou).
 *  - O systemHint inicial ("[Sistema: contato via WhatsApp...]") é preservado no
 *    topo, pois carrega telefone/nome do contato usados pelo agente.
 *
 * Cortar o array cru com slice(-N) poderia deixar um tool_result sem o tool_use
 * correspondente e causar HTTP 400 na próxima chamada.
 */
export function trimHistory(
  messages: Anthropic.MessageParam[],
  maxMessages: number,
): Anthropic.MessageParam[] {
  if (messages.length <= maxMessages) return messages;

  const head: Anthropic.MessageParam[] = [];
  let rest = messages;
  if (messages.length > 0 && isSystemHint(messages[0])) {
    head.push(messages[0]);
    rest = messages.slice(1);
  }

  const keep = Math.max(maxMessages - head.length, 1);
  let start = Math.max(rest.length - keep, 0);

  // Avança até a primeira mensagem de usuário "limpa" (texto/imagem, sem
  // tool_result) — garante que a janela começa num turno real do cliente.
  while (start < rest.length && !isCleanUserStart(rest[start])) {
    start++;
  }

  // Salvaguarda: se não achou um ponto limpo (raro), volta ao último início
  // limpo conhecido para não devolver um array vazio.
  if (start >= rest.length) {
    start = rest.length;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (isCleanUserStart(rest[i])) {
        start = i;
        break;
      }
    }
  }

  return [...head, ...rest.slice(start)];
}

export function isSystemHint(m: Anthropic.MessageParam): boolean {
  if (m.role !== "user" || !Array.isArray(m.content)) return false;
  const first = m.content[0];
  return (
    !!first &&
    first.type === "text" &&
    // Cobre todos os canais: "[Sistema: contato via WhatsApp...]" e
    // "[Sistema: contato via EMAIL...]".
    first.text.startsWith("[Sistema: contato via ")
  );
}

export function isCleanUserStart(m: Anthropic.MessageParam): boolean {
  if (m.role !== "user") return false;
  if (!Array.isArray(m.content)) return true; // string content = texto puro
  return !m.content.some((b) => b.type === "tool_result");
}
