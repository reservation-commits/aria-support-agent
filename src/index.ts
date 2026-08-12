import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import {
  parseIncoming,
  extractStatuses,
  type WhatsAppWebhookPayload,
  type AriaContentBlock,
  type ParsedMessage,
} from "./webhook.js";
import { getOrRestoreHistory, setHistory, getAllActiveSessions } from "./sessions.js";
import { markMessageProcessed, pruneProcessedMessages, detectUnaccent, setOutboundConsent } from "./db.js";
import { detectConsentIntent, consentConfirmation } from "./consent.js";
import { summarizeAndSaveSession } from "./summarizer.js";
import { normalizePhone } from "./phone.js";
import { whatsappIdentity } from "./identity.js";
import { runAgent } from "./claude.js";
import { sendText, markAsReadWithTyping } from "./whatsapp.js";
import { sanitizeReply, looksLikeInternalNote } from "./format.js";
import { logMessage } from "./dashboard/logger.js";
import { runDashboardMigrations } from "./dashboard/migrations.js";
import { startMonitor } from "./monitor.js";
import { startTester } from "./tester.js";
import { startAnalyst } from "./analyst.js";
import { startReminders } from "./reminders.js";
import { startEmailChannel, handleInboundEmail } from "./emailChannel.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { dashboardCredentials } from "./dashboard/auth.js";
import { enqueueMessage } from "./conversationQueue.js";
import { isHumanControlled } from "./handoff.js";
import { isOutOfScope, textFromBlocks } from "./scopeScreen.js";
import { seedCostGuard } from "./costGuard.js";
import { recallMemories, startEmbeddingsSync } from "./embeddings.js";
import { startAlerts } from "./alerts.js";

// ─── Fail-closed em produção ─────────────────────────────────────────────────
// Segurança não fica implícita: com NODE_ENV=production, webhook sem HMAC ou
// Postgres sem certificado verificado (e sem reconhecimento explícito) derruba
// o boot — melhor não subir do que subir aberto.
if (config.isProduction) {
  if (!config.whatsapp.appSecret) {
    console.error(
      "[aria] FATAL: NODE_ENV=production exige WHATSAPP_APP_SECRET (validação HMAC do webhook). " +
        "Sem ele, qualquer um com a URL forja payloads.",
    );
    process.exit(1);
  }
  if (config.pg.ssl && !config.pg.sslRejectUnauthorized && !config.pg.allowUnverifiedSsl) {
    console.error(
      "[aria] FATAL: em produção a conexão ao Postgres não verifica o certificado. " +
        "Sete PGSSL_REJECT_UNAUTHORIZED=true, ou reconheça explicitamente com " +
        "PGSSL_ALLOW_UNVERIFIED=true (Cloud SQL com certificado próprio).",
    );
    process.exit(1);
  }
}

const app = express();

// Capture raw body so we can verify Meta's x-hub-signature-256 header.
app.use(
  express.json({
    limit: "20mb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "aria-whatsapp-agent" });
});

// Catálogo de testes (PT/FR) — página pública para a equipe de QA validar o agente.
const _dirname = path.dirname(fileURLToPath(import.meta.url));
app.get("/catalogo", (_req, res) => {
  res.sendFile(path.resolve(_dirname, "../public/catalogo-testes.html"));
});

// Sobre a Aria (PT/FR) — página de apresentação das capacidades do agente,
// com exemplos reais e o histórico de incidentes corrigidos.
app.get("/sobre", (_req, res) => {
  res.sendFile(path.resolve(_dirname, "../public/sobre-aria.html"));
});

// Ícones do rodapé dos emails — servidos SEM autenticação (clientes de email
// os buscam anonimamente) e com cache longo. URL pública = PUBLIC_URL/icons/*.
app.use(
  "/icons",
  express.static(path.resolve(_dirname, "../public/icons"), { maxAge: "30d", immutable: true }),
);

// ─── Dashboard (admin) ──────────────────────────────────────────────────────
if (dashboardCredentials()) {
  app.use("/dashboard", createDashboardRouter());
  console.log("[aria] dashboard enabled at /dashboard");
} else {
  console.warn("[aria] dashboard DISABLED — set DASHBOARD_USER + DASHBOARD_PASSWORD to enable");
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta webhook verification (GET) — Meta sends this once when you save the URL
// in the WhatsApp product settings. We must echo back hub.challenge if the
// verify token matches.
// ─────────────────────────────────────────────────────────────────────────────
app.get(config.webhookPath, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken && typeof challenge === "string") {
    console.log("[webhook] verification ok");
    res.status(200).send(challenge);
    return;
  }
  console.warn("[webhook] verification failed", { mode, tokenMatch: token === config.whatsapp.verifyToken });
  res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────────────────────────
// Incoming messages (POST)
// ─────────────────────────────────────────────────────────────────────────────
app.post(config.webhookPath, (req, res) => {
  if (!verifySignature(req)) {
    res.sendStatus(401);
    return;
  }

  // Always 200 quickly so Meta doesn't retry; process async.
  res.status(200).json({ received: true });

  const payload = req.body as WhatsAppWebhookPayload;

  // Webhooks de status (entregue/lido/falhou) não têm `messages` — observa falhas.
  for (const s of extractStatuses(payload)) {
    if (s.status === "failed") {
      console.warn(`[webhook] entrega FALHOU para ${s.recipient ?? "?"}: ${s.errorTitle ?? "sem detalhe"} (msg ${s.id})`);
    }
  }

  void handleMessage(payload).catch((err) => {
    console.error("[webhook] handleMessage error", err);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Entrada de EMAIL via n8n (modo n8n do canal de email). O fluxo do n8n
// (Gmail Trigger → HTTP Request) posta aqui cada email recebido, autenticado
// pelo segredo compartilhado no header x-aria-secret.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook/email", (req, res) => {
  if (!config.email.enabled || !config.email.n8nSendWebhook || !config.email.webhookSecret) {
    res.sendStatus(404);
    return;
  }
  const provided = req.header("x-aria-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(config.email.webhookSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.sendStatus(401);
    return;
  }
  // 200 imediato (o n8n não precisa esperar o turno do agente).
  res.status(200).json({ received: true });
  void handleInboundEmail(req.body).catch((err) =>
    console.error("[email] inbound webhook error", err),
  );
});

function verifySignature(req: express.Request): boolean {
  // If no app secret configured, skip verification (dev mode).
  if (!config.whatsapp.appSecret) return true;

  const signature = req.header("x-hub-signature-256");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) {
    console.warn("[webhook] missing signature or raw body");
    return false;
  }

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex");

  // Constant-time compare
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Janela deslizante de 60 s por número. Protege contra abuso e custos inesperados.
const _rateLimits = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_MESSAGES = 15;

function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  const timestamps = (_rateLimits.get(chatId) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  timestamps.push(now);
  _rateLimits.set(chatId, timestamps);
  return timestamps.length > RATE_MAX_MESSAGES;
}

// Poda periódica: sem isso, cada número que já escreveu fica no Map para sempre.
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of _rateLimits) {
    if (ts.every((t) => now - t >= RATE_WINDOW_MS)) _rateLimits.delete(id);
  }
}, 5 * 60_000).unref();

// ─── Deduplicação de mensagens ───────────────────────────────────────────────
// O WhatsApp Cloud API frequentemente entrega o mesmo webhook 2x em milissegundos
// de diferença. Guardamos os IDs processados em memória por 10 minutos.
const _processedIds = new Map<string, number>();
const _DEDUP_TTL_MS = 10 * 60 * 1000;

function isDuplicate(messageId: string): boolean {
  const seen = _processedIds.get(messageId);
  if (seen) return true;
  _processedIds.set(messageId, Date.now());
  // Limpeza lazy: remove entradas expiradas a cada verificação.
  for (const [id, ts] of _processedIds) {
    if (Date.now() - ts > _DEDUP_TTL_MS) _processedIds.delete(id);
  }
  return false;
}

// Poda diária da tabela de dedup persistida.
function startDedupCleanup(): void {
  const DAY_MS = 24 * 60 * 60_000;
  setInterval(() => {
    void pruneProcessedMessages(48).catch((err) =>
      console.warn("[dedup] prune falhou:", err instanceof Error ? err.message : err),
    );
  }, DAY_MS).unref();
}

async function handleMessage(payload: WhatsAppWebhookPayload): Promise<void> {
  // A Meta pode agrupar várias mensagens num único webhook — processa todas em ordem.
  const parsedList = await parseIncoming(payload);
  for (const parsed of parsedList) {
    await handleOneMessage(parsed).catch((err) =>
      console.error("[webhook] handleOneMessage error", err),
    );
  }
}

async function handleOneMessage(parsed: ParsedMessage): Promise<void> {
  // Descarta silenciosamente mensagens já processadas.
  // 1) Cache em memória — caminho rápido para o reenvio em milissegundos.
  if (isDuplicate(parsed.messageId)) {
    console.log(`[webhook] mensagem duplicada ignorada (memória): ${parsed.messageId}`);
    return;
  }
  // 2) Dedup persistida — pega reentregas após restart/deploy e múltiplas réplicas.
  try {
    const fresh = await markMessageProcessed(parsed.messageId);
    if (!fresh) {
      console.log(`[webhook] mensagem duplicada ignorada (banco): ${parsed.messageId}`);
      return;
    }
  } catch (err) {
    // Falha no dedup persistido não pode travar o atendimento — segue só com o de memória.
    console.warn("[webhook] dedup persistida indisponível:", err instanceof Error ? err.message : err);
  }

  // Rate limiting — sem resposta ao cliente (não incentiva o abuso).
  if (isRateLimited(parsed.chatId)) {
    console.warn(`[webhook] rate limit atingido para ${parsed.chatId} — mensagem descartada`);
    return;
  }

  // Log inbound message (best-effort).
  const inboundText = parsed.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const hasMedia = parsed.content.some((b) => b.type === "image");
  void logMessage({
    chatId: parsed.chatId,
    pushName: parsed.pushName,
    direction: "inbound",
    waMessageId: parsed.messageId,
    content: inboundText || "[mídia]",
    hasMedia,
    mediaType: hasMedia ? "image" : null,
  });

  // Mark as read AND show "typing…" immediately. Typing renders for ~25s in
  // the client; cobre a janela de debounce + processamento do agente.
  void markAsReadWithTyping(parsed.messageId);

  // Opt-out / opt-in de mensagens proativas (determinístico, garantido). Pega
  // mensagens curtas e diretas ("PARAR", "stop", "quero parar os lembretes").
  const intent = detectConsentIntent(inboundText);
  if (intent) {
    void setOutboundConsent(normalizePhone(parsed.chatId), intent === "opt_out", "keyword").catch(() => {});
    const msg = consentConfirmation(intent, normalizePhone(parsed.chatId));
    const ok = await sendText(parsed.chatId, msg);
    if (ok) {
      void logMessage({ chatId: parsed.chatId, pushName: parsed.pushName, direction: "outbound", content: msg });
    }
    return; // não passa para o agente — foi um comando de consentimento
  }

  // Enfileira o conteúdo. Mensagens em rajada do mesmo número são agrupadas num
  // único turno do agente (debounce) e turnos do mesmo chat nunca se sobrepõem.
  enqueueMessage(parsed.chatId, parsed.pushName, parsed.content, processTurn, config.reply.debounceMs);
}

/**
 * Processa um turno completo da conversa: roda o agente sobre o conteúdo
 * acumulado e envia a resposta. Chamado pela fila — nunca em paralelo para o
 * mesmo chatId.
 */
async function processTurn(
  chatId: string,
  pushName: string | null,
  blocks: AriaContentBlock[],
): Promise<void> {
  // Conversa sob controle de um atendente humano → a Aria fica em silêncio.
  if (isHumanControlled(chatId)) {
    console.log(`[handoff] ${chatId} sob controle humano — Aria em silêncio`);
    return;
  }

  const startedAt = Date.now();
  // Cast no limite: AriaContentBlock inclui bloco de documento (PDF) que o SDK
  // 0.30 ainda não tipa, mas a API /v1/messages serializa e aceita normalmente.
  const userMsg = {
    role: "user" as const,
    content: blocks as unknown as Anthropic.MessageParam["content"],
  };

  // Identidade confiável do servidor: telefone E.164 do WhatsApp.
  const identity = whatsappIdentity(chatId);
  const phoneE164 = identity.phone!;

  // Tenta memória em RAM primeiro; se não encontrar (restart), restaura do banco.
  const history = await getOrRestoreHistory(chatId);

  // Memória semântica: no INÍCIO da conversa, recupera os resumos de sessões
  // anteriores mais relevantes para a mensagem atual (vazio se desligado).
  let memoryHint = "";
  if (history.length === 0) {
    const memories = await recallMemories(phoneE164, textFromBlocks(blocks), 3).catch(() => []);
    if (memories.length > 0) {
      memoryHint =
        `\n[Memórias de conversas anteriores relevantes para esta mensagem:\n` +
        memories.map((m) => `— ${m}`).join("\n") +
        `]`;
    }
  }

  const systemHint = {
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `[Sistema: contato via WhatsApp. Telefone: ${phoneE164}. Nome no perfil: ${pushName ?? "não informado"}.]${memoryHint}`,
      },
    ],
  };

  // Bloqueio de escopo: newsletter/marketing/relatório automático → silêncio
  // (registrado no painel). Só triamos o PRIMEIRO contato — conversa já iniciada
  // não é re-triada.
  if (
    await isOutOfScope({
      channel: "whatsapp",
      chatId,
      sender: phoneE164,
      subject: null,
      text: textFromBlocks(blocks),
      firstContact: history.length === 0,
    })
  ) {
    return;
  }

  const seed = history.length === 0 ? [systemHint] : [];
  const { reply, updatedHistory } = await runAgent([...history, ...seed], userMsg, identity);

  setHistory(chatId, updatedHistory);

  const clean = sanitizeReply(reply);
  if (!clean) return;

  // Silêncio deliberado ou nota interna do agente — nunca vai para o cliente.
  if (looksLikeInternalNote(clean)) {
    console.log(`[agent] silêncio do agente para ${chatId} — nota interna suprimida`);
    return;
  }

  // Enforce minimum reply delay so the bot doesn't feel robotic.
  const minMs = config.reply.minDelaySeconds * 1000;
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) {
    await sleep(minMs - elapsed);
  }

  const ok = await sendText(chatId, clean);

  // Log outbound message (só se realmente entregou).
  if (ok) {
    void logMessage({
      chatId,
      pushName,
      direction: "outbound",
      content: clean,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Em todo deploy/restart o processo recebe SIGTERM. Antes de encerrar,
// sumarizamos todas as sessões ativas para que a próxima conversa
// do cliente comece com contexto — mesmo que o servidor tenha reiniciado.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[aria] ${signal} recebido — salvando sessões ativas...`);
  const active = getAllActiveSessions();
  if (active.length > 0) {
    await Promise.allSettled(
      active.map(({ chatId, messages }) => summarizeAndSaveSession(chatId, messages)),
    );
    console.log(`[aria] ${active.length} sessão(ões) resumida(s) e salva(s).`);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => void gracefulShutdown("SIGINT"));

// ─────────────────────────────────────────────────────────────────────────────

app.listen(config.port, async () => {
  console.log(`[aria] listening on :${config.port}`);
  console.log(`[aria] webhook path: ${config.webhookPath}`);
  console.log(`[aria] model: ${config.anthropic.model}`);
  console.log(`[aria] graph version: ${config.whatsapp.graphVersion}`);
  if (!config.whatsapp.appSecret) {
    console.warn("[aria] WHATSAPP_APP_SECRET not set — signature verification disabled");
  }

  // Migrations — idempotent, best-effort.
  runDashboardMigrations()
    .then(() => {
      // Detecta capacidade de normalizar acentos na busca (após migrations,
      // pois é lá que tentamos criar a extensão unaccent).
      void detectUnaccent();
      // Semeia o teto diário de custo com o que já foi gasto hoje (restart-safe).
      void seedCostGuard();
      // Inicia serviços autônomos somente após migrations garantidas.
      startMonitor();
      startTester();
      startAnalyst();
      startReminders();
      startEmailChannel();
      startDedupCleanup();
      startEmbeddingsSync();
      startAlerts();
    })
    .catch((err) => {
      console.error("[aria] dashboard migrations failed (continuing without):", err);
      void detectUnaccent();
      void seedCostGuard();
      // Inicia mesmo assim — os serviços tratam falhas internamente.
      startMonitor();
      startTester();
      startAnalyst();
      startReminders();
      startEmailChannel();
      startDedupCleanup();
      startEmbeddingsSync();
      startAlerts();
    });
});
