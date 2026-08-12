/**
 * Safety net for the model output before sending to WhatsApp.
 *
 * 1. Strips all emojis / pictographic characters — the system prompt forbids
 *    them, but this guarantees compliance even on rare slip-ups.
 * 2. Normalizes common Markdown to WhatsApp markup:
 *      **bold**     → *bold*
 *      __italic__   → _italic_
 *      ~~strike~~   → ~strike~
 * 3. Collapses excessive blank lines.
 */
export function sanitizeReply(text: string): string {
  let out = text;

  // Markdown → WhatsApp markup. Use non-greedy matches across single lines.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+?)__/g, "_$1_");
  out = out.replace(/~~([^~\n]+?)~~/g, "~$1~");

  // Strip emojis (Extended_Pictographic covers emoji, dingbats, symbols).
  // Also strip variation selectors and ZWJ used by emoji sequences.
  out = out.replace(/\p{Extended_Pictographic}/gu, "");
  out = out.replace(/[\u{FE0F}\u{200D}]/gu, "");

  // Clean up any double-spaces left by emoji removal (e.g. "Bom dia, X! \n").
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/[ \t]{2,}/g, " ");

  // Collapse 3+ consecutive newlines to 2.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Safety net para respostas por EMAIL (texto puro).
 *
 * 1. Remove emojis (mesma regra absoluta da Aria).
 * 2. REMOVE marcadores de markdown/WhatsApp em vez de convertê-los — em email
 *    texto puro, asteriscos e underscores apareceriam literais.
 * 3. Normaliza linhas em branco excessivas.
 */
export function sanitizeEmailReply(text: string): string {
  let out = text;

  // Marcadores de ênfase → texto puro (conteúdo preservado, marcador removido).
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  out = out.replace(/__([^_\n]+?)__/g, "$1");
  out = out.replace(/~~([^~\n]+?)~~/g, "$1");
  out = out.replace(/\*([^*\n]+?)\*/g, "$1");
  // Itálico _..._ apenas quando delimitado (evita comer underscores de URLs/ids).
  out = out.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,;:!?]|$)/gm, "$1$2");

  // Strip emojis + variation selectors/ZWJ.
  out = out.replace(/\p{Extended_Pictographic}/gu, "");
  out = out.replace(/[\u{FE0F}\u{200D}]/gu, "");

  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

/**
 * Detecta quando a resposta do agente NÃO é uma mensagem ao cliente, e sim uma
 * decisão de silêncio ou uma nota interna de raciocínio (ex.: "[Resposta vazia —
 * mensagem automática repetida...]", "Este email é um relatório automático...").
 * O prompt manda usar o marcador [[SILENCIO]], mas esta rede de segurança pega
 * também as variações que o modelo escreve por conta própria — NADA disso pode
 * chegar à caixa de entrada de um cliente.
 */
export function looksLikeInternalNote(text: string): boolean {
  const t = text.trim();
  if (!t) return true;

  // Marcador explícito de silêncio (contrato com o prompt).
  if (/^\[{0,2}\s*sil[êe]ncio\s*\]{0,2}$/i.test(t)) return true;

  // Resposta que é UM ÚNICO bloco entre colchetes = anotação, não mensagem.
  if (/^\[[^\]]+\]$/s.test(t)) return true;

  // Frases de meta-raciocínio sobre a própria decisão de (não) responder.
  // Só nas primeiras linhas — é onde a nota interna se declara.
  const head = t.slice(0, 300).toLowerCase();
  const metaPhrases = [
    "resposta vazia",
    "nenhuma resposta será enviada",
    "não vou gerar uma resposta",
    "não há ação de atendimento",
    "nenhuma ação de atendimento",
    "não requer ação de atendimento",
    "sem novo conteúdo a atender",
    "não contém nenhuma solicitação",
    "não é uma mensagem de cliente",
    "mensagem automática repetida",
    "recomendação interna",
    "este email é um relatório automático",
    "trata-se de uma notificação automática",
  ];
  return metaPhrases.some((p) => head.includes(p));
}
