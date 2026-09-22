/**
 * outboundLog.ts — registro persistente de TODA saída proativa.
 *
 * POR QUE EXISTE
 * Até aqui o desfecho de um envio vivia em três lugares incompletos: o console
 * (some no deploy), o `publish()` do painel (buffer em memória de 100 eventos,
 * também some) e `aria_reminders_sent` (só os sucessos). Nenhum deles responde
 * a pergunta do canário: *de 100 eventos, quantos viraram mensagem, e por que
 * os outros não viraram?*
 *
 * O dado mais valioso da fase de canário é justamente o NÃO-envio: "não mandei
 * porque o telefone é ambíguo" é o que diz se a trava está calibrada ou
 * engolindo cliente legítimo.
 *
 * NUNCA LANÇA. Falha de log não pode derrubar — nem atrasar — uma notificação.
 * Se a tabela ainda não existe (deploy anterior às migrations), degrada para um
 * aviso e segue.
 *
 * NÃO guarda telefone. A referência é o código da reserva — mesma decisão de
 * minimização tomada em aria_phone_quality.
 */

import { pool } from "./db.js";

export type OrigemSaida = "evento" | "reminder" | "briefing" | "review";

export type RegistroSaida = {
  origem: OrigemSaida;
  desfecho: string;
  evento?: string | null;
  reservationCode?: string | null;
  motivo?: string | null;
  qualidadeTelefone?: string | null;
  pais?: string | null;
  locale?: string | null;
  template?: string | null;
  traceId?: string | null;
};

let avisouTabelaAusente = false;

/**
 * Quantos envios realmente saíram hoje (dia UTC), por canal proativo.
 *
 * Lança de propósito, ao contrário de `registrarSaida`: quem chama usa isto
 * para decidir se PODE enviar. Um erro aqui não pode virar "conte zero e mande
 * à vontade" — o chamador trata a exceção como teto atingido.
 */
export async function contarEnviosHoje(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM public.aria_outbound_log
      WHERE desfecho = 'enviado'
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
  );
  return rows[0]?.n ?? 0;
}

export async function registrarSaida(r: RegistroSaida): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO public.aria_outbound_log
         (origem, desfecho, evento, reservation_code, motivo,
          qualidade_telefone, pais, locale, template, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        r.origem,
        r.desfecho,
        r.evento ?? null,
        r.reservationCode ?? null,
        r.motivo ?? null,
        r.qualidadeTelefone ?? null,
        r.pais ?? null,
        r.locale ?? null,
        r.template ?? null,
        r.traceId || null,
      ],
    );
  } catch (err) {
    // 42P01 = tabela inexistente. Avisa uma vez só, para não poluir o log a
    // cada envio num ambiente que ainda não subiu as migrations.
    const code = (err as { code?: string })?.code;
    if (code === "42P01") {
      if (!avisouTabelaAusente) {
        avisouTabelaAusente = true;
        console.warn("[outbound-log] aria_outbound_log ainda não existe — o canário fica sem dados até o próximo deploy");
      }
      return;
    }
    console.warn("[outbound-log] falha ao registrar:", err instanceof Error ? err.message : err);
  }
}
