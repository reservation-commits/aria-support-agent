/**
 * waLimits.ts — limites de payload do WhatsApp Cloud API.
 * Módulo PURO (sem config/env/IO) para ser testável offline, como historyTrim.
 *
 * Limites oficiais relevantes:
 *   texto livre 4096 · body interativo 1024 · título de botão 20 ·
 *   título de linha de lista 24 · descrição de linha 72 · rótulo do botão da lista 20
 */

export const WA_TEXT_MAX = 4000; // margem sob o limite oficial de 4096
export const WA_INTERACTIVE_BODY_MAX = 1024;
export const WA_BUTTON_TITLE_MAX = 20;
export const WA_LIST_ROW_TITLE_MAX = 24;
export const WA_LIST_ROW_DESC_MAX = 72;
export const WA_LIST_BUTTON_MAX = 20;
export const WA_SECTION_TITLE_MAX = 24;
/** Teto por parâmetro de template — o corpo inteiro cabe em 1024. */
export const WA_TEMPLATE_PARAM_MAX = 250;

/**
 * Divide texto acima do limite em partes enviáveis, cortando de preferência
 * em parágrafo, depois linha, depois espaço — nunca no meio de uma palavra
 * (a menos que não haja alternativa).
 */
export function splitForWhatsApp(text: string): string[] {
  if (text.length <= WA_TEXT_MAX) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > WA_TEXT_MAX) {
    const window = rest.slice(0, WA_TEXT_MAX);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > WA_TEXT_MAX / 2 ? cut : WA_TEXT_MAX;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Saneia um parâmetro de template ({{1}}, {{2}}…).
 *
 * A Cloud API REJEITA o envio inteiro quando um parâmetro contém quebra de
 * linha, tabulação ou mais de 4 espaços seguidos. Como os parâmetros vêm do
 * banco (nome do cliente, nome do restaurante), basta um cadastro com "\n" no
 * fim para derrubar a notificação — e o erro chega como um 400 genérico, difícil
 * de rastrear às 3h da manhã. Sanear aqui, e não em cada chamador, garante que
 * nenhum caminho de envio escape.
 */
export function sanitizeTemplateParam(s: string, max = WA_TEMPLATE_PARAM_MAX): string {
  const limpo = String(s ?? "")
    .replace(/[\r\n\t]+/g, " ") // proibidos pela Meta
    .replace(/ {2,}/g, " ")     // corta a regra dos 4 espaços na raiz
    .trim();
  return clampText(limpo, max);
}

/** Corta texto no limite com reticências — nunca envia payload inválido. */
export function clampText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}
