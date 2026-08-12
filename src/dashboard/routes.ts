import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { basicAuth, operatorFrom } from "./auth.js";
import {
  getConversationMessages,
  getConversationMeta,
  upsertConversationMeta,
  listCannedResponses,
  addCannedResponse,
  deleteCannedResponse,
  getEscalation,
  updateEscalation,
  searchMessages,
  getCatalogQuality,
  getReviewsTrend,
  getMessageHeatmap,
  getHealthHistory,
  getHealthSummary,
  getLatestTestRun,
  getOverview,
  getSystemHealth,
  getToolAnalytics,
  listConversations,
  listEscalations,
  listReservations,
  listReservationStatuses,
  listRestaurants,
  listSuggestions,
  updateSuggestionStatus,
  countPendingSuggestions,
  listRecentReminders,
  listExperienceReviews,
  getReviewsSummary,
  countOptedOut,
  getUsageSummary,
  listScopeBlocks,
  countScopeBlocksToday,
} from "./queries.js";
import { runAllTests } from "../tester.js";
import { runAnalysis } from "../analyst.js";
import { events, recentEvents, type AriaEvent } from "./events.js";
import { takeOver, release, listHandoffs } from "../handoff.js";
import { sendText } from "../whatsapp.js";
import { sendOperatorEmail } from "../emailChannel.js";
import { costStatus } from "../costGuard.js";
import { logMessage } from "./logger.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDashboardRouter(): express.Router {
  const router = express.Router();
  const auth = basicAuth();

  // Static HTML page at /dashboard (and /dashboard/)
  router.get("/", auth, (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../../public/dashboard.html"));
  });

  // Preview do template de email da Aria (referência visual para o time).
  router.get("/email-preview", auth, (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../../public/email-preview.html"));
  });

  // ─── API ────────────────────────────────────────────────────────────────

  // Operador autenticado (o front mostra quem está logado e ajusta o RBAC).
  router.get("/api/me", auth, (req, res) => {
    res.json(operatorFrom(req));
  });

  router.get("/api/overview", auth, async (_req, res) => {
    try {
      res.json(await getOverview());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/conversations", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 50), 1, 500);
      res.json(await listConversations(limit));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/conversations/:chatId", auth, async (req, res) => {
    try {
      const chatId = String(req.params.chatId ?? "");
      const limit = clamp(Number(req.query.limit ?? 300), 1, 1000);
      const messages = await getConversationMessages(chatId, limit);
      res.json({ chat_id: chatId, messages });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Status reais existentes no banco (o painel monta os filtros daqui).
  router.get("/api/reservations/statuses", auth, async (_req, res) => {
    try {
      res.json(await listReservationStatuses());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/reservations", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
      res.json(
        await listReservations({
          status: (req.query.status as string) || undefined,
          search: (req.query.search as string) || undefined,
          limit,
        }),
      );
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/escalations", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 50), 1, 200);
      res.json(await listEscalations(limit));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/tools", auth, async (req, res) => {
    try {
      const days = clamp(Number(req.query.days ?? 7), 1, 90);
      res.json(await getToolAnalytics(days));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/restaurants", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
      res.json(await listRestaurants(limit));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.get("/api/system", auth, async (_req, res) => {
    try {
      res.json(await getSystemHealth());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Saúde ──────────────────────────────────────────────────────────────────
  router.get("/api/health/history", auth, async (_req, res) => {
    try {
      const [history, summary] = await Promise.all([getHealthHistory(96), getHealthSummary()]);
      res.json({ summary, history });
    } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  // ─── Testes ─────────────────────────────────────────────────────────────────
  router.get("/api/tests/latest", auth, async (_req, res) => {
    try { res.json(await getLatestTestRun()); }
    catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  router.post("/api/tests/run", auth, async (_req, res) => {
    try {
      const result = await runAllTests();
      res.json(result);
    } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  // ─── Sugestões ───────────────────────────────────────────────────────────────
  router.get("/api/suggestions", auth, async (req, res) => {
    try {
      const status = (req.query.status as string) || undefined;
      const [suggestions, pending] = await Promise.all([
        listSuggestions(status),
        countPendingSuggestions(),
      ]);
      res.json({ suggestions, pending_count: pending });
    } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  router.post("/api/suggestions/:id/status", auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body as { status?: string };
      if (!["approved", "dismissed"].includes(status ?? "")) {
        res.status(400).json({ error: "status deve ser approved ou dismissed" });
        return;
      }
      const ok = await updateSuggestionStatus(id, status as "approved" | "dismissed");
      res.json({ ok });
    } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  router.post("/api/analysis/run", auth, async (_req, res) => {
    try {
      const result = await runAnalysis();
      res.json(result);
    } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
  });

  // ─── Handoff humano ───────────────────────────────────────────────────────
  // Lista as conversas atualmente sob controle humano (Aria silenciada).
  router.get("/api/handoff", auth, (_req, res) => {
    res.json({ handoffs: listHandoffs() });
  });

  // Assume / devolve uma conversa. body: { action: "take"|"release", minutes?, agent? }
  router.post("/api/handoff/:chatId", auth, (req, res) => {
    const chatId = String(req.params.chatId ?? "");
    if (!chatId) {
      res.status(400).json({ error: "chatId obrigatório" });
      return;
    }
    const { action, minutes, agent } = req.body as {
      action?: string;
      minutes?: number;
      agent?: string;
    };
    if (action === "take") {
      takeOver(chatId, clamp(Number(minutes ?? 60), 1, 1440), agent ?? operatorFrom(req).user);
      res.json({ ok: true, chatId, controlled: true });
    } else if (action === "release") {
      release(chatId);
      res.json({ ok: true, chatId, controlled: false });
    } else {
      res.status(400).json({ error: 'action deve ser "take" ou "release"' });
    }
  });

  // Envia uma mensagem manual (operador humano) para o cliente — WhatsApp OU
  // email (chatId "email:<endereço>"). Engaja handoff curto para a Aria não
  // atravessar a conversa do atendente. Auditado com o nome real do operador.
  router.post("/api/conversations/:chatId/send", auth, async (req, res) => {
    const chatId = String(req.params.chatId ?? "");
    const { text } = req.body as { text?: string };
    if (!chatId || !text?.trim()) {
      res.status(400).json({ error: "chatId e text são obrigatórios" });
      return;
    }
    const operator = operatorFrom(req).user;
    try {
      const ok = chatId.startsWith("email:")
        ? await sendOperatorEmail(chatId.slice("email:".length), text.trim())
        : await sendText(chatId, text.trim());
      if (ok) {
        takeOver(chatId, 30, operator);
        void logMessage({
          chatId,
          direction: "outbound",
          content: `[${operator}] ${text.trim()}`,
          pushName: operator,
        });
      }
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Inbox: metadados de conversa (status, responsável, notas, tags) ─────
  router.get("/api/conversations/:chatId/meta", auth, async (req, res) => {
    try {
      res.json(await getConversationMeta(String(req.params.chatId ?? "")));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post("/api/conversations/:chatId/meta", auth, async (req, res) => {
    try {
      const chatId = String(req.params.chatId ?? "");
      const { status, assigned_to, notes, tags } = req.body as {
        status?: string;
        assigned_to?: string | null;
        notes?: string | null;
        tags?: string[];
      };
      if (status && !["open", "pending_customer", "pending_team", "resolved"].includes(status)) {
        res.status(400).json({ error: "status inválido" });
        return;
      }
      const meta = await upsertConversationMeta(chatId, {
        status,
        assignedTo: assigned_to,
        notes,
        tags,
      });
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Respostas prontas ───────────────────────────────────────────────────
  router.get("/api/canned", auth, async (_req, res) => {
    try {
      res.json(await listCannedResponses());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.post("/api/canned", auth, async (req, res) => {
    try {
      const { title, body } = req.body as { title?: string; body?: string };
      if (!title?.trim() || !body?.trim()) {
        res.status(400).json({ error: "title e body são obrigatórios" });
        return;
      }
      res.json(await addCannedResponse(title.trim(), body.trim(), operatorFrom(req).user));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  router.delete("/api/canned/:id", auth, async (req, res) => {
    try {
      if (!operatorFrom(req).admin) {
        res.status(403).json({ error: "apenas admin remove respostas prontas" });
        return;
      }
      res.json({ ok: await deleteCannedResponse(Number(req.params.id)) });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Workflow de escalações (resolver com retorno ao cliente) ────────────
  router.post("/api/escalations/:id/action", auth, async (req, res) => {
    const id = Number(req.params.id);
    const { action, note, message, assignee } = req.body as {
      action?: string;
      note?: string;
      message?: string;
      assignee?: string;
    };
    if (!["resolve", "reopen", "assign"].includes(action ?? "")) {
      res.status(400).json({ error: "action deve ser resolve, reopen ou assign" });
      return;
    }
    const operator = operatorFrom(req).user;
    try {
      const ok = await updateEscalation(id, action as "resolve" | "reopen" | "assign", operator, {
        note,
        assignee,
      });
      // Fechamento de loop: ao resolver com mensagem, o CLIENTE recebe o
      // desfecho no WhatsApp — a escalação deixa de ser fire-and-forget.
      let notified = false;
      if (ok && action === "resolve" && message?.trim()) {
        const esc = await getEscalation(id);
        if (esc?.phone) {
          notified = await sendText(String(esc.phone), message.trim());
          if (notified) {
            void logMessage({
              chatId: String(esc.phone),
              direction: "outbound",
              content: `[${operator} · resolução] ${message.trim()}`,
              pushName: operator,
            });
          }
        }
      }
      res.json({ ok, notified });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Busca full-text no histórico ────────────────────────────────────────
  router.get("/api/search", auth, async (req, res) => {
    try {
      const q = String(req.query.q ?? "").trim();
      if (q.length < 2) {
        res.json({ q, results: [] });
        return;
      }
      const limit = clamp(Number(req.query.limit ?? 50), 1, 200);
      res.json({ q, results: await searchMessages(q, limit) });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Qualidade do catálogo ───────────────────────────────────────────────
  router.get("/api/catalog/quality", auth, async (_req, res) => {
    try {
      res.json(await getCatalogQuality());
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Analytics extras (CSAT por semana + heatmap de volume) ──────────────
  router.get("/api/analytics/extra", auth, async (req, res) => {
    try {
      const days = clamp(Number(req.query.days ?? 30), 1, 90);
      const [trend, heatmap] = await Promise.all([getReviewsTrend(26), getMessageHeatmap(days)]);
      res.json({ reviews_trend: trend, heatmap });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Export CSV ──────────────────────────────────────────────────────────
  router.get("/api/export/:what", auth, async (req, res) => {
    try {
      const what = String(req.params.what ?? "");
      let rows: Array<Record<string, unknown>> = [];
      if (what === "reservations") rows = (await listReservations({ limit: 500 })) as never;
      else if (what === "escalations") rows = (await listEscalations(200)) as never;
      else if (what === "reviews") rows = (await listExperienceReviews(500)) as never;
      else if (what === "conversations") rows = (await listConversations(500)) as never;
      else {
        res.status(400).json({ error: "export desconhecido" });
        return;
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="aria-${what}.csv"`);
      res.send(toCsv(rows));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Avaliações de experiência coletadas (para revisão antes de publicar).
  router.get("/api/reviews", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
      const [reviews, summary] = await Promise.all([listExperienceReviews(limit), getReviewsSummary()]);
      res.json({ reviews, summary });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Status do outbound proativo (lembretes) + últimos enviados.
  router.get("/api/reminders", auth, async (_req, res) => {
    try {
      const [recent, optedOut] = await Promise.all([listRecentReminders(50), countOptedOut()]);
      res.json({
        enabled: config.reminders.enabled,
        template: config.reminders.template || null,
        default_locale: config.reminders.defaultLocale,
        locales: config.reminders.locales,
        opted_out_count: optedOut,
        review_enabled: config.review.enabled,
        review_template: config.review.template || null,
        briefing_enabled: config.briefing.enabled,
        briefing_template: config.briefing.template || null,
        briefing_hours_before: config.briefing.hoursBefore,
        hours_before: config.reminders.hoursBefore,
        status: config.reminders.status,
        sweep_minutes: config.reminders.sweepMinutes,
        recent,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Consumo de tokens da API Anthropic (custo) — totais, por dia, por modelo,
  // top conversas. ?days=7 (padrão) até 90.
  router.get("/api/usage", auth, async (req, res) => {
    try {
      const days = clamp(Number(req.query.days ?? 7), 1, 90);
      const usage = await getUsageSummary(days);
      // Estado do teto diário de custo (budget, gasto de hoje, degradado?).
      res.json({ ...usage, cost_guard: costStatus() });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Mensagens ignoradas por estarem fora de escopo (bloqueio de escopo).
  router.get("/api/scope-blocks", auth, async (req, res) => {
    try {
      const limit = clamp(Number(req.query.limit ?? 100), 1, 500);
      const [blocks, today] = await Promise.all([listScopeBlocks(limit), countScopeBlocksToday()]);
      res.json({ enabled: config.scope.enabled, model: config.scope.model, today, blocks });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Server-Sent Events: live event stream for the "Logs ao vivo" panel.
  router.get("/api/events/stream", auth, (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Hydrate the client with recent events.
    for (const ev of recentEvents()) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }

    const onEvent = (ev: AriaEvent) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    events.on("event", onEvent);

    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 25_000);

    req.on("close", () => {
      events.off("event", onEvent);
      clearInterval(heartbeat);
    });
  });

  return router;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Serializa linhas em CSV (RFC 4180: aspas duplicadas, campos entre aspas). */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map((c) => cell(c)).join(",")];
  for (const row of rows) lines.push(cols.map((c) => cell(row[c])).join(","));
  return "﻿" + lines.join("\r\n"); // BOM: Excel abre UTF-8 corretamente
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
