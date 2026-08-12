/**
 * summarizer.ts
 *
 * Ao final de cada conversa (quando a sessão expira por inatividade), gera
 * automaticamente um resumo compacto com o modelo mais leve disponível e salva
 * no perfil do cliente como nota datada. Na próxima conversa, a Aria lê esse
 * histórico narrativo via get_customer_profile e o contexto é reconstituído —
 * sem nenhuma ação adicional do cliente.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { upsertCustomerProfile } from "./db.js";
import { identityFromChatId, resolveProfileKey } from "./identity.js";
import { saveMemory } from "./embeddings.js";

// Cliente próprio para não criar dependência circular com claude.ts.
const _client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Mínimo de turns do assistente para valer a pena resumir.
const MIN_ASSISTANT_TURNS = 2;

// Modelo leve: rápido e baratíssimo para sumarização.
const SUMMARY_MODEL = "claude-haiku-4-5";

export async function summarizeAndSaveSession(
  chatId: string,
  messages: Anthropic.MessageParam[],
): Promise<void> {
  try {
    const assistantTurns = messages.filter((m) => m.role === "assistant").length;
    if (assistantTurns < MIN_ASSISTANT_TURNS) return;

    const transcript = buildTranscript(messages);
    if (!transcript) return;

    const response = await _client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 300,
      system:
        "Você resume conversas de atendimento de forma ultraconcisa. " +
        "Responda APENAS com bullet points em português (máximo 5), sem introdução nem conclusão. " +
        "Priorize: preferências reveladas, restrições alimentares/alergias, " +
        "restaurantes discutidos ou reservados, problemas relatados, " +
        "contexto relevante para o próximo atendimento. " +
        "Ignore saudações e conteúdo vazio.",
      messages: [
        {
          role: "user",
          content: `Conversa:\n\n${transcript}`,
        },
      ],
    });

    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!summary) return;

    // Chave multi-canal: telefone no WhatsApp; no email, o telefone do cadastro
    // (lookup pelo endereço) ou a chave sintética "email:<addr>".
    const profileKey = await resolveProfileKey(identityFromChatId(chatId));
    const date = new Date().toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const dated = `[Conversa de ${date}]\n${summary}`;

    await upsertCustomerProfile({ customerPhone: profileKey, notes: dated });
    // Memória semântica de longo prazo: indexa o resumo para recuperação por
    // relevância em conversas futuras (mesmo depois que o notes atingir o teto).
    void saveMemory(profileKey, dated);
    console.log(`[summarizer] sessão resumida e salva para ${profileKey}`);
  } catch (err) {
    // Best-effort — jamais bloqueia nem lança erro.
    console.warn("[summarizer] falhou:", err instanceof Error ? err.message : err);
  }
}

/**
 * Monta um transcript legível a partir dos MessageParam.
 * Filtra blocos de sistema, tool calls e imagens — só texto útil.
 */
function buildTranscript(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const role = msg.role === "user" ? "Cliente" : "Aria";
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    for (const block of blocks) {
      if (block.type !== "text") continue;
      const text = block.text.trim();
      // Ignora injeções de sistema e tool results.
      if (text.startsWith("[Sistema:") || text.startsWith("{")) continue;
      if (text.length < 3) continue;
      lines.push(`${role}: ${text}`);
    }
  }

  return lines.join("\n");
}
