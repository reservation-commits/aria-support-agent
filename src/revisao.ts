/**
 * revisao.ts — revisão ANTES do envio (a segunda leitura que faltava).
 *
 * Pedido do fundador (2026-09-29): "não permita erros". No mesmo dia o Juiz de Conversa
 * pegou, depois de enviada, uma resposta em francês que prometia prazo ("d'ici vendredi
 * 3 octobre en fin de journée") e expunha processo ("j'ai relancé le restaurant", "en
 * attente de réponse"). A porta de regras não fala francês o bastante, e a leitura
 * diária chega tarde. Esta camada lê CADA resposta antes de sair:
 *
 *   1. regras (outboundGate — barato, determinístico, agora com prazo/data e processo
 *      em pt/en/fr/es/it);
 *   2. leitura semântica por um modelo barato, com a MESMA régua do Juiz (ADR-015).
 *
 * Critérios que barram: prazo prometido, discrição, vocabulário interno, idioma.
 * Os outros dois (resolve agora, tom) só ficam registrados. Se o revisor semântico
 * estiver fora do ar, valem as regras e abre-se aviso — nunca "ok" silencioso.
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { logEscalation, pool } from "./db.js";
import { outboundGate } from "./format.js";
import { PROMPT_JUIZ, interpretarVeredito, type Criterio } from "./juizRegua.js";

export type Revisao =
  | { ok: true; semRevisor?: boolean; avisos?: string[] }
  | { ok: false; origem: "regra" | "juiz"; motivos: string[] };

const CRITERIOS_QUE_BARRAM: Criterio[] = ["sem_prazo", "discricao", "sem_vocabulario_interno", "idioma_ok"];
const NOME: Record<Criterio, string> = {
  idioma_ok: "idioma diferente do da mensagem do cliente",
  sem_prazo: "promete prazo ou data",
  sem_vocabulario_interno: "vocabulário interno (sistema, escalei, registrei)",
  discricao: "expõe processo, fila, espera ou falha interna",
  resolve_agora: "não oferece nada concreto agora",
  tom_marca: "tom fora da marca",
};

let ultimoAvisoRevisor = 0;

async function revisorSemantico(entrada: string, resposta: string, compromisso: string | null): Promise<{ reprovados: Criterio[]; avisos: Criterio[]; motivo: string }> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 25_000, maxRetries: 1 });
  const res = await client.messages.create({
    model: config.cost.fallbackModel,
    max_tokens: 400,
    system: PROMPT_JUIZ,
    messages: [{ role: "user", content: JSON.stringify([{ id: 1, pergunta: entrada.slice(0, 1500), resposta: resposta.slice(0, 2500), ...(compromisso ? { compromisso_registrado: compromisso } : {}) }]) }],
  });
  const texto = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  const [v] = interpretarVeredito(texto, [1]);
  if (!v) throw new Error("revisor não devolveu veredito");
  const zerados = (Object.keys(v.notas) as Criterio[]).filter((c) => v.notas[c] === 0);
  return {
    reprovados: zerados.filter((c) => CRITERIOS_QUE_BARRAM.includes(c)),
    avisos: zerados.filter((c) => !CRITERIOS_QUE_BARRAM.includes(c)),
    motivo: v.motivo,
  };
}

/** Registra cada tentativa (aprovada ou não) — é o que permite medir a taxa de retenção. */
async function registrar(p: { chatId: string; channel: string; tentativa: number; aprovado: boolean; origem: string | null; motivos: string[]; snippet: string }): Promise<void> {
  await pool
    .query(
      `INSERT INTO public.aria_prechecks (chat_id, channel, tentativa, aprovado, origem, motivos, snippet)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [p.chatId, p.channel, p.tentativa, p.aprovado, p.origem, JSON.stringify(p.motivos), p.snippet.slice(0, 300)],
    )
    .catch((err) => console.warn("[revisao] falha ao registrar:", err instanceof Error ? err.message : err));
}

export async function revisarResposta(p: {
  resposta: string;
  entrada: string;
  channel: "whatsapp" | "email";
  chatId: string;
  tentativa: number;
  /** Data do compromisso registrado neste turno (AAAA-MM-DD) — libera a data NOSSA na carta. */
  compromisso?: string | null;
}): Promise<Revisao> {
  const portao = outboundGate(p.resposta, p.entrada, { prazoPermitido: !!p.compromisso });
  if (!portao.ok) {
    await registrar({ chatId: p.chatId, channel: p.channel, tentativa: p.tentativa, aprovado: false, origem: "regra", motivos: [portao.motivo], snippet: p.resposta });
    return { ok: false, origem: "regra", motivos: [portao.motivo] };
  }
  if (!config.revisao.enabled) {
    await registrar({ chatId: p.chatId, channel: p.channel, tentativa: p.tentativa, aprovado: true, origem: "regra", motivos: [], snippet: p.resposta });
    return { ok: true, semRevisor: true };
  }

  try {
    const r = await revisorSemantico(p.entrada, p.resposta, p.compromisso ?? null);
    if (r.reprovados.length) {
      const motivos = [...r.reprovados.map((c) => NOME[c]), ...(r.motivo ? [r.motivo] : [])];
      await registrar({ chatId: p.chatId, channel: p.channel, tentativa: p.tentativa, aprovado: false, origem: "juiz", motivos, snippet: p.resposta });
      return { ok: false, origem: "juiz", motivos };
    }
    await registrar({ chatId: p.chatId, channel: p.channel, tentativa: p.tentativa, aprovado: true, origem: "juiz", motivos: r.avisos.map((c) => NOME[c]), snippet: p.resposta });
    return { ok: true, avisos: r.avisos.map((c) => NOME[c]) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[revisao] revisor semântico indisponível — valendo só as regras:", msg);
    if (Date.now() - ultimoAvisoRevisor > 3_600_000) {
      ultimoAvisoRevisor = Date.now();
      await logEscalation({ tag: "ALTA", summary: `[revisao] revisor semântico indisponível (${msg.slice(0, 120)}) — respostas saindo só com a porta de regras`, phone: "" }).catch(() => {});
    }
    await registrar({ chatId: p.chatId, channel: p.channel, tentativa: p.tentativa, aprovado: true, origem: "regra", motivos: ["revisor indisponível"], snippet: p.resposta });
    return { ok: true, semRevisor: true };
  }
}
