import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { systemPromptFor } from "./systemPrompt.js";
import { buildTemporalContext } from "./datetime.js";
import { tools, runTool } from "./tools.js";
import { recordLlmUsage } from "./db.js";
import { effectiveModel, recordSpend } from "./costGuard.js";
import { contactKey, type AgentIdentity, type Channel } from "./identity.js";
import { SCOPE_CLASSIFIER_SYSTEM, parseScopeVerdict, type ScopeVerdict } from "./scopeGuard.js";

export const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Aumentado de 6 → 12: o início de cada conversa já consome 1 iteração
// (get_customer_profile + find_reservations_by_phone em paralelo), e fluxos
// complexos (busca → localização → rota) precisam de espaço para respirar.
const MAX_TOOL_ITERATIONS = 12;

// Cache-aware system prompt: the large static block is marked for caching;
// the temporal context (changes every request) is a separate uncached block.
// This cuts prompt-processing cost by ~85% and reduces TTFT noticeably.
// Cada canal tem seu próprio prompt (e portanto sua própria entrada de cache).
function buildSystemBlocks(channel: Channel): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: systemPromptFor(channel),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: buildTemporalContext(),
      // No cache_control — temporal context is unique per request.
    },
  ] as Anthropic.TextBlockParam[];
}

// Cache-aware tools list: the last tool carries the cache_control marker so
// the entire tool definition block is cached together with the system prompt.
// Email não recebe as tools de mensagem rica do WhatsApp (send_*).
function withCacheMarker(list: typeof tools): Anthropic.Tool[] {
  return list.map((t, i) =>
    i === list.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
  ) as Anthropic.Tool[];
}
const toolsByChannel: Record<Channel, Anthropic.Tool[]> = {
  whatsapp: withCacheMarker(tools),
  email: withCacheMarker(tools.filter((t) => !t.name.startsWith("send_"))),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Chamada à API com retry/backoff para erros TRANSITÓRIOS (rate limit 429,
 * overloaded 529, 5xx, falha de rede). Sem isso, um soluço momentâneo da API
 * deixaria o cliente sem resposta nenhuma. Erros definitivos (400 etc.)
 * propagam imediatamente.
 */
async function createWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxRetries = 2,
): Promise<Anthropic.Message> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || attempt >= maxRetries) throw err;
      const delay = 1_000 * 2 ** attempt; // 1s, 2s
      console.warn(`[claude] erro transitório (status ${status ?? "rede"}) — retry em ${delay}ms`);
      await sleep(delay);
    }
  }
}

// Acumulador de consumo de tokens do turno — persistido em aria_llm_usage
// (best-effort) para observabilidade de custo por conversa/dia/modelo.
type TurnUsage = { apiCalls: number; input: number; output: number; cacheCreate: number; cacheRead: number };

function accumulateUsage(acc: TurnUsage, response: Anthropic.Message): void {
  const u = response.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  acc.apiCalls++;
  acc.input += u?.input_tokens ?? 0;
  acc.output += u?.output_tokens ?? 0;
  acc.cacheCreate += u?.cache_creation_input_tokens ?? 0;
  acc.cacheRead += u?.cache_read_input_tokens ?? 0;
}

function flushUsage(acc: TurnUsage, chatId: string | null, model: string): void {
  if (acc.apiCalls === 0) return;
  // Alimenta o teto diário de custo (só conta o modelo principal — o fallback
  // barato não deve "gastar" o orçamento que já estourou).
  if (model === config.anthropic.model) recordSpend(acc.input + acc.output);
  void recordLlmUsage({
    chatId,
    model,
    apiCalls: acc.apiCalls,
    inputTokens: acc.input,
    outputTokens: acc.output,
    cacheCreationTokens: acc.cacheCreate,
    cacheReadTokens: acc.cacheRead,
  }).catch((err) =>
    console.warn("[claude] falha ao registrar uso:", err instanceof Error ? err.message : err),
  );
}

/**
 * Classificador semântico de escopo (camada 2 do bloqueio). Roda um modelo
 * BARATO (config.scope.model) sobre a primeira mensagem de um contato novo e
 * decide se é atendimento legítimo (cliente/estabelecimento) ou ruído a ser
 * ignorado (newsletter/marketing/relatório automático).
 *
 * FALHA EM ABERTO: qualquer erro de API/parse retorna inScope=true — nunca
 * calamos um cliente real por causa de um soluço do classificador.
 */
export async function classifyScope(
  text: string,
  channel: Channel,
  firstContact = true,
): Promise<ScopeVerdict> {
  const trimmed = (text ?? "").trim();
  // Sem texto (só anexo/mídia) não dá para triar com segurança → deixa passar.
  if (!trimmed) return { inScope: true, reason: "sem texto para triar — mantido no escopo" };

  // Em conversa já em andamento o listão de contexto não está disponível ao
  // classificador — instrução extra: só marcar fora-de-escopo o que for
  // inequivocamente automático/massa (mensagens curtas de cliente passam).
  const framing = firstContact
    ? "Primeira mensagem do contato"
    : "Mensagem em conversa JÁ EM ANDAMENTO (só marque in_scope=false se for inequivocamente newsletter/disparo/relatório automático; mensagem curta ou ambígua de pessoa = in_scope=true)";

  try {
    const response = await anthropic.messages.create({
      model: config.scope.model,
      max_tokens: 120,
      temperature: 0,
      system: SCOPE_CLASSIFIER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Canal: ${channel}. ${framing}:\n\n"""${trimmed.slice(0, 3000)}"""`,
        },
      ],
    });
    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    void recordLlmUsage({
      chatId: null,
      model: config.scope.model,
      apiCalls: 1,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }).catch(() => {});
    return parseScopeVerdict(raw);
  } catch (err) {
    console.warn("[scope] classificador falhou — mantendo no escopo:", err instanceof Error ? err.message : err);
    return { inScope: true, reason: "classificador indisponível — mantido no escopo" };
  }
}

export async function runAgent(
  history: Anthropic.MessageParam[],
  userMessage: Anthropic.MessageParam,
  identity: AgentIdentity | null = null,
): Promise<{ reply: string; updatedHistory: Anthropic.MessageParam[] }> {
  const channel: Channel = identity?.channel ?? "whatsapp";
  const chatKey = contactKey(identity);
  const messages: Anthropic.MessageParam[] = [...history, userMessage];
  const usage: TurnUsage = { apiCalls: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  // Modelo decidido UMA vez por turno (teto de custo pode degradar p/ fallback).
  const model = effectiveModel();
  // Tools send_* entregam mensagens ricas (lista/botões/pin) diretamente ao
  // cliente — quando alguma teve sucesso, uma resposta final vazia é válida.
  let sentViaTool = false;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await createWithRetry({
      model,
      max_tokens: channel === "email" ? 2048 : 1024,
      system: buildSystemBlocks(channel),
      tools: toolsByChannel[channel],
      messages,
    });
    accumulateUsage(usage, response);

    // Append the assistant turn to the message history regardless of stop reason.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Tools de LEITURA rodam em PARALELO (o modelo costuma pedir perfil +
      // histórico juntos — paralelizar corta a latência do turno). Se houver
      // qualquer send_* (mensagem rica entregue ao cliente NA HORA), roda tudo
      // em série para preservar a ordem de chegada das mensagens no aparelho.
      const hasSend = toolUses.some((tu) => tu.name.startsWith("send_"));
      let results: Awaited<ReturnType<typeof runTool>>[];
      if (hasSend || toolUses.length <= 1) {
        results = [];
        for (const tu of toolUses) {
          results.push(await runTool(tu.name, tu.input as Record<string, unknown>, identity));
        }
      } else {
        results = await Promise.all(
          toolUses.map((tu) => runTool(tu.name, tu.input as Record<string, unknown>, identity)),
        );
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu, idx) => {
        const result = results[idx];
        if (result.ok && tu.name.startsWith("send_")) sentViaTool = true;
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        };
      });

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn (or stop_sequence/max_tokens) — extract final text
    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    flushUsage(usage, chatKey, model);
    return { reply: reply || (sentViaTool ? "" : "..."), updatedHistory: messages };
  }

  console.warn("[claude] hit MAX_TOOL_ITERATIONS — returning fallback message");
  flushUsage(usage, chatKey, model);
  return {
    reply:
      "Estou verificando alguns detalhes do seu pedido. Já vou retornar com a resposta — um momento, por favor.",
    updatedHistory: messages,
  };
}
