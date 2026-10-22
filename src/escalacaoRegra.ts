/**
 * escalacaoRegra.ts — o que é escalação e o que é telemetria (lógica pura, sem I/O).
 *
 * POR QUE EXISTE (v22, 2026-10-22, plano B4)
 * Em 21/10 a fila `aria_escalations` tinha 15 abertas e 14 eram do próprio sistema: o juiz avisando
 * que o juiz reprovou, a revisão avisando que reteve, o compromisso avisando que a janela fechou.
 * Nenhuma pedia uma ação que um humano pudesse executar — e a única que pedia (LOFOTEN, remoção)
 * ficou 16 dias sem leitura no meio do ruído. Regra: **escalação sem ação humana possível não é
 * escalação, é telemetria** — e telemetria mora em `aria_quality_scores` / `aria_scope_blocks`.
 *
 * Uma escalação ACIONÁVEL nasce com dono (`assigned_to`) e com a ação no próprio resumo. Uma por
 * conversa enquanto estiver aberta (dedup pelo prefixo), para a mesma conversa não gerar dez cartões.
 */

/** Tags que exigem uma pessoa (ou o MAESTRO, pelo ADR-016) fazer algo. */
export const TAGS_ACIONAVEIS = [
  "RESPONDER",          // v22: a Aria não conseguiu responder (retida duas vezes, canal fechado, envio falhou)
  "REMOCAO_LISTAGEM",
  "CORRECAO_LISTAGEM",
  "URGENTE",            // modelo fora / falha de infraestrutura
  "PARCEIRO_B2B",
  "PEDIDO_ESPECIAL",
  "MODIFICACAO",
  "ATRASADO",
  "PENDENTE_12H",
] as const;
export type TagAcionavel = (typeof TAGS_ACIONAVEIS)[number];

/** Resumos que descrevem o funcionamento interno — nunca mais abrem escalação. */
export const PREFIXOS_TELEMETRIA = [
  "[juiz] ",                                   // notas reprovadas (ficam em aria_quality_scores)
  "[revisao] revisor semântico indisponível",  // degradação, não incidente de cliente (o monitor já vigia o modelo)
] as const;

export type ClasseEscalacao = "acionavel" | "telemetria";

export function classificarEscalacao(e: { tag: string; summary: string }): ClasseEscalacao {
  const s = (e.summary ?? "").trimStart();
  if (PREFIXOS_TELEMETRIA.some((p) => s.startsWith(p))) return "telemetria";
  if ((TAGS_ACIONAVEIS as readonly string[]).includes(e.tag)) return "acionavel";
  // ALTA genérica: só é acionável se o resumo pede uma ação explícita ("responder pelo painel", "enviar manualmente").
  return /responder pelo painel|enviar manualmente|responder por humano/i.test(s) ? "acionavel" : "telemetria";
}

/** Dono padrão de uma escalação acionável (ADR-016: atendimento é do MAESTRO; o resto sobe ao fundador). */
export function donoPadrao(tag: string): string {
  return tag === "URGENTE" ? "fundador" : "MAESTRO";
}

/**
 * Escalações antigas que perderam o sentido: resposta retida ou compromisso sem canal com mais de
 * `dias` dias — o cliente ou já escreveu de novo, ou a mesa já passou. Fechar com nota, não apagar.
 */
export const PREFIXOS_VENCEM = ["[revisao] resposta ", "[compromisso] "] as const;
export const DIAS_VENCIMENTO = 7;

/** Prefixo de dedup de uma escalação RESPONDER: uma por conversa enquanto aberta. */
export function prefixoResponder(chatId: string): string {
  return `[responder] ${chatId.slice(0, 80)}`;
}

/** Resumo padronizado da escalação RESPONDER — começa pelo prefixo de dedup e diz a ação. */
export function resumoResponder(chatId: string, canal: string, porque: string): string {
  return `${prefixoResponder(chatId)} — ${porque.slice(0, 220)}. Ação: responder a esta conversa pelo painel (canal ${canal}).`;
}
