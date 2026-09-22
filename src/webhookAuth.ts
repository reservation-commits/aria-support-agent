/**
 * webhookAuth.ts — a guarda dos webhooks de entrada.
 *
 * Módulo PURO (sem config/env/IO), como waLimits e phoneQuality, para poder ser
 * testado offline. A checagem estava inline na rota, onde nenhum teste alcança —
 * e guarda de segurança sem teste é guarda por acreditação.
 *
 * DUAS DECISÕES QUE PARECEM DETALHE E NÃO SÃO:
 *
 * 1. Canal desligado ou sem segredo → **404**, não 401. O 401 anunciaria "esta
 *    rota existe, tente de novo com outra senha". O 404 não conta nada a quem
 *    fez a varredura de portas.
 *
 * 2. A comparação é em tempo constante, mas `crypto.timingSafeEqual` **lança**
 *    quando os buffers têm tamanhos diferentes. Por isso o curto-circuito de
 *    comprimento vem antes. Ele vaza o tamanho do segredo — irrelevante contra
 *    um segredo aleatório longo, e o preço de não derrubar a rota com exceção.
 */

import crypto from "node:crypto";

export type VeredictoWebhook = "ok" | "nao_configurado" | "segredo_invalido";

/** Código HTTP correspondente a cada veredito. */
export const STATUS_DE: Record<VeredictoWebhook, number> = {
  ok: 200,
  nao_configurado: 404,
  segredo_invalido: 401,
};

export function verificarSegredoWebhook(params: {
  habilitado: boolean;
  esperado: string;
  fornecido: string | undefined;
}): VeredictoWebhook {
  if (!params.habilitado || !params.esperado) return "nao_configurado";

  const a = Buffer.from(params.fornecido ?? "", "utf8");
  const b = Buffer.from(params.esperado, "utf8");
  if (a.length !== b.length) return "segredo_invalido";
  return crypto.timingSafeEqual(a, b) ? "ok" : "segredo_invalido";
}
