/**
 * alertaOperador.ts — o aviso que chega ao celular de quem opera (v20).
 *
 * Um template de WhatsApp para o número do operador (OPERATOR_ALERT_WHATSAPP_TO), com três
 * campos: sistema, situação, horário. Não passa pelo modelo, pelo painel nem pelo e-mail — é o
 * canal que continua de pé quando a Aria está muda. Não é mensagem a cliente: não consulta
 * opt-in e não conta no teto diário.
 *
 * A decisão de QUANDO avisar é pura e mora em alertaRegra.ts.
 *
 * v21: cada alerta fica registrado (aria_outbound_log, origem "alerta") e tem a entrega rastreada
 * (aria_delivery_status, destinatário "operador") — "enviado" nunca provou entrega. Se o alerta
 * não sai, abre uma escalação: canal de alerta que falha calado é o pior dos mundos. E a cada
 * versão que sobe, a Aria manda um aviso de que subiu: o autoteste do caminho real.
 */

import { deveAvisarBoot, horaParis } from "./alertaRegra.js";
import { BUILD } from "./buildInfo.js";
import { config } from "./config.js";
import { logEscalationUnica, pool, resolverEscalacoes } from "./db.js";
import { registrarMensagemEnviada } from "./deliveryStatus.js";
import { registrarSaida } from "./outboundLog.js";
import { avaliarTelefone } from "./phoneQuality.js";
import { sendTemplate } from "./whatsapp.js";

export function alertaOperadorLigado(): boolean {
  return !!config.operatorAlert.to && !!config.operatorAlert.template;
}

async function falhou(motivo: string, evento: string): Promise<false> {
  console.error(`[alerta-operador] ${motivo}`);
  await registrarSaida({ origem: "alerta", evento, desfecho: "alerta_falhou", template: config.operatorAlert.template, locale: config.operatorAlert.locale, motivo, traceId: BUILD });
  await logEscalationUnica({
    tag: "ALTA",
    summary: `[alerta-operador] o alerta ao operador NÃO saiu — ${motivo}. Enquanto isto durar, uma queda do modelo só aparece neste painel.`,
    prefixos: ["[alerta-operador] o alerta ao operador NÃO saiu"],
  }).catch(() => {});
  return false;
}

/**
 * Envia o alerta. Devolve false se estiver desligado, se o número não for E.164 ou se a Cloud API
 * recusar — nunca lança: quem chama é o monitor. `evento` identifica o motivo no registro.
 */
export async function alertarOperador(p: { sistema: string; situacao: string; quando?: Date; evento?: string }): Promise<boolean> {
  if (!alertaOperadorLigado()) return false;
  const evento = `alerta_operador:${p.evento ?? "incidente"}`;
  const tel = avaliarTelefone(config.operatorAlert.to);
  if (!tel.e164) return falhou("OPERATOR_ALERT_WHATSAPP_TO não é um número em E.164 (ex.: +33612345678)", evento);
  try {
    const envio = await sendTemplate({
      to: tel.e164,
      template: config.operatorAlert.template,
      locale: config.operatorAlert.locale,
      bodyParams: [p.sistema.slice(0, 60), p.situacao.slice(0, 300), horaParis(p.quando ?? new Date())],
    });
    if (!envio.ok) {
      return falhou(`a Cloud API recusou o template '${config.operatorAlert.template}' (${config.operatorAlert.locale}) — aprovado na Meta nesse idioma?`, evento);
    }
    console.warn(`[alerta-operador] enviado: ${p.sistema} — ${p.situacao}`);
    await registrarSaida({ origem: "alerta", evento, desfecho: "alerta_enviado", template: config.operatorAlert.template, locale: config.operatorAlert.locale, pais: tel.pais, motivo: p.situacao.slice(0, 300), traceId: BUILD });
    await registrarMensagemEnviada({ messageId: envio.messageId, reservationCode: null, template: config.operatorAlert.template, locale: config.operatorAlert.locale, destinatario: "operador", evento });
    // O canal voltou a funcionar: fecha a escalação de "alerta não saiu", se havia.
    await resolverEscalacoes(["[alerta-operador] o alerta ao operador NÃO saiu"], `alerta enviado com sucesso em ${new Date().toISOString()} (fechada pela Aria)`).catch(() => {});
    return true;
  } catch (err) {
    return falhou(`falha ao enviar (${err instanceof Error ? err.message.slice(0, 120) : "erro desconhecido"})`, evento);
  }
}

const EVENTO_BOOT = "alerta_operador:subida";
const INTERVALO_MESMO_BUILD_MS = 6 * 3_600_000;
const TENTATIVAS_BOOT = 48;

/**
 * Autoteste na subida (v21). Chamado uma vez quando os serviços iniciam. Desligado com
 * OPERATOR_ALERT_ON_BOOT=false. Se não der para ler o registro, avisa mesmo assim: na dúvida,
 * o teste roda.
 */
export async function alertaDeBoot(): Promise<void> {
  if (!alertaOperadorLigado()) {
    console.log("[alerta-operador] desligado (OPERATOR_ALERT_WHATSAPP_TO ou OPERATOR_ALERT_TEMPLATE vazio)");
    return;
  }
  if (!config.operatorAlert.onBoot) return;
  let ultimoBuild: string | null = null;
  let ultimoEm: number | null = null;
  try {
    const { rows } = await pool.query<{ trace_id: string | null; created_at: Date }>(
      `SELECT trace_id, created_at FROM public.aria_outbound_log
        WHERE evento = $1 AND desfecho = 'alerta_enviado' ORDER BY created_at DESC LIMIT 1`,
      [EVENTO_BOOT],
    );
    if (rows[0]) { ultimoBuild = rows[0].trace_id; ultimoEm = new Date(rows[0].created_at).getTime(); }
  } catch { /* sem registro legível: avisa */ }
  if (!deveAvisarBoot({ build: BUILD, ultimoBuild, ultimoEm, agora: Date.now(), intervaloMs: INTERVALO_MESMO_BUILD_MS })) return;
  const tentar = async (tentativa: number): Promise<void> => {
    const ok = await alertarOperador({
      sistema: "Aria (atendimento)",
      situacao: `Teste do alerta: a Aria subiu (versão ${BUILD.slice(0, 14)}) e este canal está funcionando. Nenhuma ação é necessária.`,
      evento: "subida",
    });
    // Template ainda em análise na Meta, ou falha passageira: tenta de novo a cada 30 min, por 24 h.
    // A escalação de "alerta não saiu" já está aberta desde a primeira falha e fecha no primeiro sucesso.
    if (!ok && tentativa < TENTATIVAS_BOOT) setTimeout(() => void tentar(tentativa + 1), 30 * 60_000).unref();
  };
  await tentar(1);
}
