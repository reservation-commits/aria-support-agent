/**
 * deliveryStatus.ts — o que acontece DEPOIS do "enviado".
 *
 * POR QUE EXISTE (v18, 2026-10-01)
 * `aria_outbound_log` responde "quantas notificações saíram e por que as outras não
 * saíram". Não responde a pergunta seguinte, a que mede a fase de estabelecimentos:
 * *a casa recebeu? leu?* A Meta manda isso pelo webhook de status (sent → delivered →
 * read, ou failed), citando o `wamid` da mensagem. Até a v17 só o "failed" era
 * impresso no console, e o console some no deploy.
 *
 * Aqui cada template enviado grava uma linha com o seu `wamid` e o webhook avança o
 * status. Status só anda para a frente: um "delivered" atrasado nunca apaga um "read".
 *
 * NUNCA LANÇA. Falha de registro não pode atrasar nem derrubar uma notificação.
 * NÃO guarda telefone: a referência é o código da reserva (mesma minimização do
 * aria_outbound_log).
 */

import { pool } from "./db.js";

export type StatusEntrega = "sent" | "delivered" | "read" | "failed";
export type DestinatarioEntrega = "cliente" | "estabelecimento";

const ORDEM: Record<StatusEntrega, number> = { sent: 1, delivered: 2, read: 3, failed: 9 };

/** Status só avança. Desconhecido nunca avança. */
export function avancaStatus(atual: string | null | undefined, novo: string): boolean {
  const n = ORDEM[novo as StatusEntrega];
  if (n === undefined) return false;
  const a = ORDEM[(atual ?? "") as StatusEntrega] ?? 0;
  return n > a;
}

let avisouTabelaAusente = false;

function avisarSeTabelaAusente(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code !== "42P01") return false;
  if (!avisouTabelaAusente) {
    avisouTabelaAusente = true;
    console.warn("[entrega] aria_delivery_status ainda não existe — rastreio de entrega fica sem dados até o próximo deploy");
  }
  return true;
}

/** Chamado logo depois de um template aceito pela Cloud API. Sem `messageId` não há o que rastrear. */
export async function registrarMensagemEnviada(m: {
  messageId: string | null;
  reservationCode: string | null | undefined;
  template: string;
  locale: string;
  destinatario: DestinatarioEntrega;
  evento?: string | null;
}): Promise<void> {
  if (!m.messageId) return;
  try {
    await pool.query(
      `INSERT INTO public.aria_delivery_status
         (wa_message_id, reservation_code, template, locale, destinatario, evento)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [m.messageId, m.reservationCode ?? null, m.template, m.locale, m.destinatario, m.evento ?? null],
    );
  } catch (err) {
    if (avisarSeTabelaAusente(err)) return;
    console.warn("[entrega] falha ao registrar envio:", err instanceof Error ? err.message : err);
  }
}

/**
 * Chamado pelo webhook de status. Devolve o que fez, para o log do webhook:
 * `atualizado` (avançou), `ignorado` (id desconhecido — texto livre de conversa, por
 * exemplo — ou status que não avança) ou `erro`.
 */
export async function atualizarStatusEntrega(s: {
  messageId: string;
  status: string;
  errorTitle?: string | null;
}): Promise<"atualizado" | "ignorado" | "erro"> {
  if (!s.messageId || ORDEM[s.status as StatusEntrega] === undefined) return "ignorado";
  try {
    const r = await pool.query(
      `UPDATE public.aria_delivery_status
          SET status = $2, status_at = NOW(), error_title = COALESCE($3, error_title)
        WHERE wa_message_id = $1
          AND CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 9 ELSE 0 END
            < CASE $2    WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 9 ELSE 0 END`,
      [s.messageId, s.status, s.errorTitle ?? null],
    );
    return (r.rowCount ?? 0) > 0 ? "atualizado" : "ignorado";
  } catch (err) {
    if (!avisarSeTabelaAusente(err)) console.warn("[entrega] falha ao atualizar status:", err instanceof Error ? err.message : err);
    return "erro";
  }
}

export type ResumoEntrega = {
  destinatario: string;
  template: string | null;
  enviadas: number;
  entregues: number;
  lidas: number;
  falhas: number;
};

/** Painel e relato: por destinatário e template, nos últimos `dias` dias (lido conta como entregue). */
export async function resumoEntregas(dias = 7): Promise<ResumoEntrega[]> {
  const { rows } = await pool.query(
    `SELECT destinatario, template,
            count(*)::int                                            AS enviadas,
            count(*) FILTER (WHERE status IN ('delivered','read'))::int AS entregues,
            count(*) FILTER (WHERE status = 'read')::int             AS lidas,
            count(*) FILTER (WHERE status = 'failed')::int           AS falhas
       FROM public.aria_delivery_status
      WHERE sent_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [dias],
  );
  return rows as ResumoEntrega[];
}
