/**
 * scopeScreen.ts — orquestra o bloqueio de escopo nos dois canais (WhatsApp e
 * email). Junta a camada determinística (pura, scopeGuard.ts) com o
 * classificador semântico (claude.ts), e registra no painel toda mensagem
 * ignorada — a Aria fica em silêncio, mas o operador enxerga para pegar um
 * eventual falso positivo.
 *
 * A camada determinística roda SEMPRE (custo zero). A semântica roda só na
 * PRIMEIRA mensagem de um contato (firstContact) — depois que uma conversa
 * legítima começou, não faz sentido re-triar cada "obrigado".
 */
import { config } from "./config.js";
import { deterministicOutOfScope } from "./scopeGuard.js";
import { classifyScope } from "./claude.js";
import { logScopeBlock } from "./dashboard/logger.js";
import type { AriaContentBlock } from "./webhook.js";
import type { Channel } from "./identity.js";

/** Junta o texto de blocos de conteúdo (ignora imagem/PDF). */
export function textFromBlocks(blocks: AriaContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export type ScreenInput = {
  channel: Channel;
  chatId: string;
  /** Remetente (email) — no WhatsApp é o telefone/chatId. */
  sender?: string | null;
  subject?: string | null;
  text: string;
  /** Primeira mensagem do contato? Só aí roda o classificador semântico. */
  firstContact: boolean;
};

/**
 * Decide se a mensagem deve ser IGNORADA por estar fora de escopo. Quando
 * bloqueia, já registra no painel. Retorna true = bloqueada (não responder).
 *
 * Segurança: com o filtro desligado, nunca bloqueia. O classificador falha em
 * aberto. Só a camada determinística e um "false" explícito do classificador
 * bloqueiam.
 */
export async function isOutOfScope(input: ScreenInput): Promise<boolean> {
  if (!config.scope.enabled) return false;

  // Camada 1 — determinística (sempre; pega o marketing/newsletter óbvio).
  const structural = deterministicOutOfScope({
    from: input.sender ?? null,
    subject: input.subject ?? null,
    text: input.text,
  });
  if (structural) {
    await record(input, structural.layer, structural.reason);
    return true;
  }

  // Camada 2 — semântica. EMAIL: em toda mensagem (o spam por email insiste, e
  // conversas de ruído criadas antes do filtro têm histórico — se dependesse do
  // primeiro contato, escapariam para sempre; o classificador barato custa uma
  // fração de centavo e evita um turno caro do agente). WHATSAPP: só no primeiro
  // contato (mensagens curtas de cliente no meio da conversa não devem ser
  // re-triadas).
  const runSemantic = input.channel === "email" || input.firstContact;
  if (runSemantic) {
    const verdict = await classifyScope(input.text, input.channel, input.firstContact);
    if (!verdict.inScope) {
      await record(input, "semantic", verdict.reason);
      return true;
    }
  }

  return false;
}

async function record(input: ScreenInput, layer: "structural" | "semantic", reason: string): Promise<void> {
  console.log(
    `[scope] IGNORADO (${layer}/${input.channel}) ${input.sender ?? input.chatId}: ${reason}`,
  );
  await logScopeBlock({
    chatId: input.chatId,
    channel: input.channel,
    sender: input.sender ?? null,
    subject: input.subject ?? null,
    layer,
    reason,
    snippet: input.text.slice(0, 500),
  }).catch(() => {});
}
