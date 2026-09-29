/**
 * juiz.ts — o Juiz de Conversa (autoavaliação diária da Aria).
 *
 * Por que existe: em set/2026 descobrimos a olho nu, lendo mensagens, que a Aria
 * prometia prazo (14 vezes), trocava de idioma (9 vezes) e usava vocabulário interno.
 * O `outboundGate` barra o que é detectável por regra; o que é julgamento (discrição,
 * resolver agora, tom da marca) só um leitor pega. Este módulo é esse leitor: uma vez
 * por dia, um modelo barato lê cada resposta enviada nas últimas 24 h, ao lado da
 * mensagem do cliente que a motivou, e dá nota 0/1 em seis critérios do ADR-015.
 *
 * O que ele NUNCA faz: reescrever, reenviar ou tocar na conversa. Ele grava notas em
 * `aria_quality_scores` e, se houver resposta reprovada, abre escalação ALTA com
 * contagens e ids de mensagem (nunca nome, telefone ou e-mail — o operador abre a
 * conversa pelo id no painel). Veredito ilegível é falha alta: nada é gravado como ok.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logEscalation, pool } from "./db.js";

import { RUBRICA, NOTA_MINIMA, PROMPT_JUIZ, interpretarVeredito, resumirVereditos } from "./juizRegua.js";
import type { Criterio, Veredito, ResumoJulgamento } from "./juizRegua.js";
export { RUBRICA, NOTA_MINIMA, interpretarVeredito, resumirVereditos };
export type { Criterio, Veredito, ResumoJulgamento };

// ─── Coleta ───────────────────────────────────────────────────────────────────

interface Par {
  id: number;
  chat_id: string;
  channel: "email" | "whatsapp";
  pergunta: string | null;
  resposta: string;
}

const MAX_POR_RODADA = 40;
const MAX_CHARS = 1200;

/** Respostas enviadas nas últimas 24 h que ainda não foram julgadas, com a mensagem do cliente que as motivou. */
async function coletarPares(): Promise<Par[]> {
  const { rows } = await pool.query<{ id: string; chat_id: string; pergunta: string | null; resposta: string }>(
    `SELECT o.id::text AS id, o.chat_id, o.content AS resposta,
            (SELECT i.content FROM public.aria_messages i
              WHERE i.chat_id = o.chat_id AND i.direction = 'inbound' AND i.created_at < o.created_at
              ORDER BY i.created_at DESC LIMIT 1) AS pergunta
       FROM public.aria_messages o
      WHERE o.direction = 'outbound'
        AND o.created_at >= NOW() - INTERVAL '24 hours'
        AND o.content IS NOT NULL AND length(btrim(o.content)) > 0
        AND NOT EXISTS (SELECT 1 FROM public.aria_quality_scores q WHERE q.message_id = o.id)
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [MAX_POR_RODADA],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    chat_id: r.chat_id,
    channel: r.chat_id.startsWith("email:") ? "email" : "whatsapp",
    pergunta: r.pergunta ? r.pergunta.slice(0, MAX_CHARS) : null,
    resposta: r.resposta.slice(0, MAX_CHARS),
  }));
}

// ─── Julgamento ───────────────────────────────────────────────────────────────

const SYSTEM = PROMPT_JUIZ;

async function julgar(pares: Par[]): Promise<{ vereditos: Veredito[]; model: string }> {
  const model = config.cost.fallbackModel;
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 60_000, maxRetries: 1 });
  const res = await client.messages.create({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(pares.map(({ id, pergunta, resposta }) => ({ id, pergunta, resposta }))) }],
  });
  const texto = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { vereditos: interpretarVeredito(texto, pares.map((p) => p.id)), model };
}

async function gravar(vereditos: Veredito[], pares: Par[], model: string): Promise<void> {
  const porId = new Map(pares.map((p) => [p.id, p]));
  for (const v of vereditos) {
    const p = porId.get(v.message_id);
    if (!p) continue;
    await pool.query(
      `INSERT INTO public.aria_quality_scores (message_id, chat_id, channel, model, notas, nota, motivo)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (message_id) DO NOTHING`,
      [v.message_id, p.chat_id, p.channel, model, JSON.stringify(v.notas), v.nota, v.motivo],
    );
  }
}

// ─── Ciclo ────────────────────────────────────────────────────────────────────

export async function rodarJuiz(): Promise<ResumoJulgamento | null> {
  let pares: Par[];
  try {
    pares = await coletarPares();
  } catch (err) {
    console.error("[juiz] coleta falhou:", err instanceof Error ? err.message : err);
    return null;
  }
  if (pares.length === 0) {
    console.log("[juiz] nada novo para julgar");
    return { total: 0, reprovadas: 0, prazos: 0, idioma: 0, media: 0, ids_reprovadas: [] };
  }

  let vereditos: Veredito[];
  let model: string;
  try {
    ({ vereditos, model } = await julgar(pares));
  } catch (err) {
    // Falhar alto: sem veredito legível, nada é gravado e o operador fica sabendo.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[juiz] julgamento falhou:", msg);
    await logEscalation({
      tag: "ALTA",
      summary: `[juiz] a autoavaliação diária NÃO rodou (${pares.length} respostas sem nota). Erro: ${msg.slice(0, 160)}`,
      phone: "",
    }).catch(() => {});
    return null;
  }

  try {
    await gravar(vereditos, pares, model);
  } catch (err) {
    console.error("[juiz] gravação falhou:", err instanceof Error ? err.message : err);
  }

  const resumo = resumirVereditos(vereditos);
  const faltando = pares.length - vereditos.length;
  console.log(
    `[juiz] ${resumo.total} respostas julgadas · média ${resumo.media}/6 · reprovadas ${resumo.reprovadas}` +
      (resumo.prazos ? ` · prazo prometido ${resumo.prazos}` : "") +
      (resumo.idioma ? ` · idioma errado ${resumo.idioma}` : "") +
      (faltando ? ` · sem veredito ${faltando}` : ""),
  );

  if (resumo.reprovadas > 0) {
    await logEscalation({
      tag: "ALTA",
      summary:
        `[juiz] ${resumo.reprovadas} de ${resumo.total} respostas das últimas 24h reprovaram na régua do ADR-015` +
        (resumo.prazos ? ` (${resumo.prazos} com prazo prometido)` : "") +
        (resumo.idioma ? ` (${resumo.idioma} em idioma errado)` : "") +
        `. Mensagens: ${resumo.ids_reprovadas.join(", ")}. Motivos em aria_quality_scores.`,
      phone: "",
    }).catch(() => {});
  }
  return resumo;
}

async function julgouRecentemente(): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.aria_quality_scores WHERE judged_at >= NOW() - INTERVAL '20 hours'`,
    );
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return true; // sem tabela ainda → não roda agora
  }
}

const CHECAGEM_MS = 6 * 60 * 60_000;

/** Uma rodada por dia: na subida (após 3 min) e a cada 6 h, só se não julgou nas últimas 20 h. */
export function startJuiz(): void {
  const tick = async () => {
    if (await julgouRecentemente()) return;
    await rodarJuiz();
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), CHECAGEM_MS).unref();
  }, 3 * 60_000).unref();
  console.log("[juiz] autoavaliação diária ligada (ADR-015, 6 critérios)");
}
