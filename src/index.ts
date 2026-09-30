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
import {
  markMessageProcessed, pruneProcessedMessages, detectUnaccent, setOutboundConsent, setWhatsAppReservas, getReservationForEvent, pool,
  savePendingWhatsApp, loadPendingWhatsApp, claimPendingWhatsApp, requeuePendingWhatsApp,
} from "./db.js";
import { detectConsentIntent, consentConfirmation } from "./consent.js";
import { summarizeAndSaveSession } from "./summarizer.js";
import { normalizePhone } from "./phone.js";
import { whatsappIdentity } from "./identity.js";
import { responderComRevisao } from "./entrega.js";
import { sendText, markAsReadWithTyping } from "./whatsapp.js";
import { sanitizeReply } from "./format.js";
import { logMessage, logScopeBlock } from "./dashboard/logger.js";
import { runDashboardMigrations } from "./dashboard/migrations.js";
import { startMonitor } from "./monitor.js";
import { startTester } from "./tester.js";
import { startAnalyst } from "./analyst.js";
import { startJuiz } from "./juiz.js";
import { startReminders } from "./reminders.js";
import { startEmailChannel, handleInboundEmail } from "./emailChannel.js";
import { tratarEventoReserva } from "./reservationEvents.js";
import { verificarSegredoWebhook, STATUS_DE } from "./webhookAuth.js";
import { notificarEstabelecimento, startVenueReminders, type ResultadoEstabelecimento } from "./venueEvents.js";
import { startCompromissos } from "./compromissos.js";
import { startReservationWatch } from "./watcher.js";
import { avisoSeEstabelecimento } from "./venueIdentity.js";
import { parsePayloadEvento } from "./eventFormat.js";
import { avaliarTelefone, podeReceberWhatsApp } from "./phoneQuality.js";
import { normalizarIdioma, IDIOMAS_ACEITOS } from "./templateLocale.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { dashboardCredentials } from "./dashboard/auth.js";
import { enqueueMessage, isBusy } from "./conversationQueue.js";
import { isHumanControlled } from "./handoff.js";
import { isOutOfScope, textFromBlocks } from "./scopeScreen.js";
import { seedCostGuard } from "./costGuard.js";
import { recallMemories, startEmbeddingsSync } from "./embeddings.js";
import { startAlerts } from "./alerts.js";
import { createHash } from "node:crypto";
import { systemPromptFor } from "./systemPrompt.js";
import { BUILD } from "./buildInfo.js";

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
// /health também identifica O QUE está no ar. Em 11/09 publicamos uma correção e não havia
// como verificar de fora se ela tinha subido: o endpoint dizia apenas "ok". Agora ele devolve
// a etiqueta da versão, a impressão digital do prompt REALMENTE carregado (não a do arquivo em
// disco: se o build for antigo, o hash denuncia) e há quanto tempo o processo subiu.
const PROMPT_HASH = createHash("sha256")
  .update(systemPromptFor("whatsapp") + systemPromptFor("email"))
  .digest("hex")
  .slice(0, 12);
const SUBIU_EM = new Date().toISOString();
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "aria-whatsapp-agent",
    build: BUILD,
    promptHash: PROMPT_HASH,
    startedAt: SUBIU_EM,
    uptimeSeconds: Math.round(process.uptime()),
    // v17: quais etapas de notificação este container ligou (só booleanos — sem nomes nem segredos).
    // Variável adicionada sem redeploy fica invisível; aqui a dúvida acaba em uma chamada.
    etapas: {
      eventos: config.reservationEvents.enabled,
      vigiaReservas: config.reservationEvents.enabled && config.reservationWatch.enabled,
      lembrete2h: config.reminders.enabled && !!config.reminders.template,
      vesperaCliente: config.briefing.enabled && !!config.briefing.template,
      vesperaComMapa: config.briefing.enabled && !!config.briefing.templateMap,
      avaliacao: config.review.enabled && !!config.review.template,
      pendenteCliente24h: !!config.pendingNudge.template,
      encerramentoHonesto: !!config.pendingClose.template,
      pedidoNovoCasa: config.reservationEvents.enabled && !!config.reservationEvents.venueTemplates.pedido_recebido,
      lembreteCasa24h: !!config.venueNudge.template,
      vesperaCasa: config.venueBriefing.enabled && !!config.venueBriefing.template,
      agendaCasa: !!config.venueAgenda.template,
    },
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// Evento TRANSACIONAL de reserva. O n8n, que já manda o e-mail em cada
// transição, avisa aqui e a Aria dispara o template de WhatsApp.
//
// Corpo: { event, reservation_code, trace_id? } — só referências, nunca PII.
// Autenticação: x-aria-secret, comparação em tempo constante. Sem segredo
// configurado, a rota NÃO EXISTE (404): não há caminho de envio sem senha.
//
// Resposta síncrona de propósito: o n8n registra o desfecho de cada evento no
// próprio histórico de execução, o que torna o fluxo auditável dos dois lados.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Marca ou desmarca quem recebe WhatsApp de reservas (opt-in — fundador, 2026-09-25).
 * Chamado pelo site (caixa "quero receber por WhatsApp") ou por um nó do n8n. Mesmo
 * segredo dos eventos; sem segredo configurado a rota não existe (404).
 * Corpo: { phone, whatsapp_reservas: true|false, tipo?: "cliente"|"estabelecimento",
 *          restaurant_id?, source?, motivo?, idioma?: pt|en|es|fr|it|de }
 */
app.post("/webhook/consent", (req, res) => {
  const veredito = verificarSegredoWebhook({
    habilitado: !!config.reservationEvents.secret,
    esperado: config.reservationEvents.secret,
    fornecido: req.header("x-aria-secret"),
  });
  if (veredito !== "ok") {
    res.sendStatus(STATUS_DE[veredito]);
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const tel = avaliarTelefone(typeof b.phone === "string" ? b.phone : "");
  if (!podeReceberWhatsApp(tel)) {
    res.status(400).json({ ok: false, motivo: "telefone_nao_enviavel", detalhe: `${tel.qualidade}: ${tel.motivo}` });
    return;
  }
  if (typeof b.whatsapp_reservas !== "boolean") {
    res.status(400).json({ ok: false, motivo: "payload_invalido", detalhe: "whatsapp_reservas deve ser true ou false" });
    return;
  }
  const tipo = b.tipo === "estabelecimento" ? "estabelecimento" : "cliente";
  let idioma: string | null = null;
  if (b.idioma != null && b.idioma !== "") {
    idioma = normalizarIdioma(String(b.idioma));
    if (!idioma) {
      res.status(400).json({ ok: false, motivo: "idioma_desconhecido", detalhe: `use um de: ${IDIOMAS_ACEITOS.join(", ")}` });
      return;
    }
  }
  setWhatsAppReservas({
    idioma,
    phone: tel.e164,
    ligado: b.whatsapp_reservas,
    tipo,
    restaurantId: typeof b.restaurant_id === "string" ? b.restaurant_id.slice(0, 64) : null,
    source: typeof b.source === "string" ? b.source.slice(0, 40) : "webhook",
    motivo: typeof b.motivo === "string" ? b.motivo.slice(0, 200) : null,
  })
    .then(() => res.json({ ok: true, phone_pais: tel.pais, tipo, whatsapp_reservas: b.whatsapp_reservas, idioma }))
    .catch((err) => {
      console.error("[consent] gravação falhou", err);
      res.status(500).json({ ok: false, motivo: "erro", detalhe: "falha interna" });
    });
});

app.post("/webhook/reservation-event", (req, res) => {
  const veredito = verificarSegredoWebhook({
    habilitado: config.reservationEvents.enabled,
    esperado: config.reservationEvents.secret,
    fornecido: req.header("x-aria-secret"),
  });
  if (veredito !== "ok") {
    res.sendStatus(STATUS_DE[veredito]);
    return;
  }

  void tratarEventoReserva(req.body)
    .then(async (r) => {
      // Etapa do ESTABELECIMENTO, independente do desfecho do cliente (2026-09-25).
      let estabelecimento: ResultadoEstabelecimento = { acao: "nao_se_aplica", detalhe: "payload inválido" };
      const p = parsePayloadEvento(req.body);
      if (p) {
        const linha = await getReservationForEvent(p.reservationCode).catch(() => null);
        estabelecimento = await notificarEstabelecimento(p, linha).catch((err) => {
          console.error("[evento-estabelecimento] erro não tratado", err);
          return { acao: "falha_envio", detalhe: "falha interna" } as ResultadoEstabelecimento;
        });
      }
      // 200 mesmo quando nada foi enviado: "telefone não enviável" e "opt-out"
      // são desfechos corretos, não erros do chamador. O n8n não deve re-tentar.
      res.status(r.acao === "payload_invalido" ? 400 : 200).json({ ...r, estabelecimento });
    })
    .catch((err) => {
      console.error("[evento-reserva] erro não tratado", err);
      res.status(500).json({ acao: "erro", detalhe: "falha interna" });
    });
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
  if (await isHumanControlled(chatId)) {
    console.log(`[handoff] ${chatId} sob controle humano — Aria em silêncio`);
    return;
  }

  const startedAt = Date.now();
  // v13: se o número é de um ESTABELECIMENTO marcado (recebe pedidos no WhatsApp), o turno
  // ganha o aviso de sistema com o papel de parceiro e os links de resposta dos pedidos.
  const avisoCasa = await avisoSeEstabelecimento(whatsappIdentity(chatId).phone!);
  const blocosDoTurno = avisoCasa ? ([{ type: "text", text: avisoCasa }, ...blocks] as AriaContentBlock[]) : blocks;
  // Cast no limite: AriaContentBlock inclui bloco de documento (PDF) que o SDK
  // 0.30 ainda não tipa, mas a API /v1/messages serializa e aceita normalmente.
  const userMsg = {
    role: "user" as const,
    content: blocosDoTurno as unknown as Anthropic.MessageParam["content"],
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
  let turno: Awaited<ReturnType<typeof responderComRevisao>>;
  try {
    turno = await responderComRevisao({
      history, seed, userMsg, identity, destinatario: avisoCasa ? "estabelecimento" : "cliente",
      entrada: textFromBlocks(blocks), channel: "whatsapp", chatId, sender: chatId, sanitize: sanitizeReply,
    });
  } catch (err) {
    // O modelo falhou (crédito, chave, rede). Antes a mensagem morria aqui — a Meta já
    // recebeu o 200 e não reenvia. Agora vai para a fila de replay e o alerta URGENTE
    // já foi aberto por alertarModeloIndisponivel() em claude.ts.
    await savePendingWhatsApp(chatId, pushName, blocks).catch((e) =>
      console.error("[replay] falha ao guardar mensagem pendente:", e instanceof Error ? e.message : e),
    );
    throw err;
  }
  const { reply, updatedHistory } = turno;

  setHistory(chatId, updatedHistory);

  // O caminho único (entrega.ts) já sanitizou, revisou (regras + leitura semântica),
  // reescreveu uma vez se preciso e, se ainda assim reprovou, reteve com registro e escalação.
  const clean = reply;
  if (!clean) return;

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

/**
 * Replay da fila do WhatsApp: a cada 10 min, cada mensagem cujo turno falhou volta pelo
 * MESMO caminho da conversa (fila por chat, debounce, escopo, porta de saída). Só se a
 * conversa não estiver ocupada. Até 7 dias e 20 tentativas por mensagem — depois disso
 * a linha fica na tabela como evidência, não como fantasma.
 */
function startWhatsAppReplay(): void {
  const tick = async () => {
    let pendentes: Awaited<ReturnType<typeof loadPendingWhatsApp>>;
    try { pendentes = await loadPendingWhatsApp(7, 20); } catch { return; }
    for (const p of pendentes) {
      if (isBusy(p.chat_id)) continue;
      const claimed = await claimPendingWhatsApp(p.id).catch(() => null);
      if (!claimed) continue;
      console.log(`[replay] reprocessando mensagem de WhatsApp pendente desde ${claimed.created_at.toISOString()} (tentativa ${claimed.tentativas + 1})`);
      enqueueMessage(
        claimed.chat_id,
        claimed.push_name,
        claimed.blocks as AriaContentBlock[],
        async (chatId, pushName, blocks) => {
          try { await processTurn(chatId, pushName, blocks); }
          catch (err) {
            // processTurn já regravou a mensagem (savePendingWhatsApp) com a linha nova;
            // aqui só corrigimos o contador, apagando a duplicata e regravando com +1.
            await requeuePendingWhatsApp(claimed).catch(() => {});
            await pool.query(`DELETE FROM public.aria_pending_whatsapp WHERE chat_id = $1 AND tentativas = 0 AND created_at > $2`, [claimed.chat_id, claimed.created_at]).catch(() => {});
            throw err;
          }
        },
        config.reply.debounceMs,
      );
    }
  };
  setTimeout(() => void tick(), 30_000);
  setInterval(() => void tick(), 10 * 60_000).unref();
  console.log("[replay] fila de WhatsApp: reprocessamento a cada 10 min");
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
      startWhatsAppReplay();
      startAnalyst();
      startJuiz();
      startReminders();
      startVenueReminders();
      startCompromissos();
      startReservationWatch();
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
      startWhatsAppReplay();
      startAnalyst();
      startJuiz();
      startReminders();
      startVenueReminders();
      startCompromissos();
      startReservationWatch();
      startEmailChannel();
      startDedupCleanup();
      startEmbeddingsSync();
      startAlerts();
    });
});
