/**
 * reservationEvents.ts — notificação TRANSACIONAL de reserva por WhatsApp.
 *
 * As varreduras de reminders.ts são por TEMPO (2h antes, véspera, 6h depois).
 * Faltava a que o cliente realmente espera: a que avisa **no instante em que o
 * status muda**. É esta.
 *
 * ARQUITETURA (ADR-004: reservas = plataforma, ninguém escreve)
 * O n8n, que já dispara o e-mail em cada transição, avisa a Aria por
 * POST /webhook/reservation-event. O corpo traz APENAS referências
 * (`event` + `reservation_code` + `trace_id`) — nunca dados do cliente, que a
 * Aria lê do banco. Isso cumpre a regra 1 da constituição e mantém o webhook
 * inútil para quem o descobrir: sem o segredo não passa, e mesmo o corpo não
 * carrega PII.
 *
 * ORDEM DAS TRAVAS (todas fail-closed)
 *    1. canal ligado?                → senão, nada acontece
 *    2. payload válido e evento conhecido?
 *    3. template configurado para o evento? → senão, FINDING (nunca silêncio)
 *    4. reserva existe?
 *    5. telefone `ENVIAVEL` pela avaliação E.164? → senão, segue só por e-mail
 *    6. cliente não optou por sair?
 *    7. dados suficientes para uma mensagem correta?
 *    8. teto diário do canário (se ligado)
 *    9. claim atômico do envio (anti-duplicata, resiste a réplicas)
 *   10. envia; se falhar, devolve o claim e registra FINDING
 *
 * Todo desfecho — inclusive os nove que NÃO enviam — vai para
 * `aria_outbound_log` por um ponto único de saída. Sem isso não há canário:
 * "não mandei porque o telefone é ambíguo" é o dado que diz se a trava está
 * calibrada.
 *
 * O que esta camada NUNCA faz: escrever em `reservations`, inventar texto
 * (o template é fixo e aprovado pela Meta) ou enviar a quem não passou em 5 e 6.
 */

import { config } from "./config.js";
import {
  getReservationForEvent,
  isOptedOut,
  liberarEnvio,
  logEscalation,
  reservarEnvio,
} from "./db.js";
import { publish } from "./dashboard/events.js";
import { montarParametros, parsePayloadEvento } from "./eventFormat.js";
import { languageForPhone } from "./locale.js";
import { contarEnviosHoje, registrarSaida, type RegistroSaida } from "./outboundLog.js";
import { avaliarTelefone, podeReceberWhatsApp } from "./phoneQuality.js";
import { sendTemplate } from "./whatsapp.js";

export type AcaoEvento =
  | "enviado"
  | "duplicado"
  | "canal_desligado"
  | "payload_invalido"
  | "sem_template"
  | "reserva_nao_encontrada"
  | "telefone_nao_enviavel"
  | "opt_out"
  | "dados_insuficientes"
  | "teto_diario"
  | "falha_envio";

export type ResultadoEvento = { acao: AcaoEvento; detalhe: string };

const BASE_TO_TEMPLATE: Record<string, string> = { pt: "pt_BR", en: "en", es: "es", fr: "fr" };

/**
 * Idioma do template. Só devolve um que esteja entre os APROVADOS na Meta
 * (config.reminders.locales) — tentar uma tradução inexistente é envio perdido.
 *
 * [Limitação declarada] O sinal é o país do telefone. O ADR-015 manda responder
 * no idioma do cliente, e para uma mensagem que inicia a conversa (sem texto
 * dele para ler) este é o melhor sinal disponível. Cliente italiano ou alemão
 * cai em inglês enquanto `locale.ts` não mapear IT/DE — degradação conhecida,
 * não silenciosa.
 */
function localeParaTemplate(phone: string): string {
  const aprovados = config.reminders.locales;
  const permitido = (l: string) => aprovados.length === 0 || aprovados.includes(l);
  const fallback = permitido(config.reminders.defaultLocale)
    ? config.reminders.defaultLocale
    : aprovados[0] ?? config.reminders.defaultLocale;
  const doPais = BASE_TO_TEMPLATE[languageForPhone(phone)] ?? fallback;
  return permitido(doPais) ? doPais : fallback;
}

async function registrarFinding(resumo: string, code: string): Promise<void> {
  console.error(`[evento-reserva] ${resumo}`);
  publish({ kind: "error", where: "evento-reserva", message: resumo, at: new Date().toISOString() });
  await logEscalation({
    tag: "URGENTE",
    summary: `[evento-reserva] ${resumo}`,
    phone: "",
    reservationCode: code,
  }).catch(() => {});
}

/**
 * Ponto ÚNICO de saída. `decidir()` tem nove ramos de retorno; se cada um
 * gravasse o próprio log, o primeiro ramo novo esqueceria — e o canário ficaria
 * cego exatamente no caso raro que interessa. Aqui todo desfecho passa pelo
 * mesmo registro, por construção.
 */
export async function tratarEventoReserva(body: unknown): Promise<ResultadoEvento> {
  const ctx: Partial<RegistroSaida> = {};
  const r = await decidir(body, ctx);
  await registrarSaida({
    origem: "evento",
    desfecho: r.acao,
    motivo: r.detalhe,
    ...ctx,
  });
  return r;
}

async function decidir(body: unknown, ctx: Partial<RegistroSaida>): Promise<ResultadoEvento> {
  // 1 — canal ligado?
  if (!config.reservationEvents.enabled) {
    return { acao: "canal_desligado", detalhe: "RESERVATION_EVENTS_ENABLED=false" };
  }

  // 2 — payload válido?
  const p = parsePayloadEvento(body);
  if (!p) return { acao: "payload_invalido", detalhe: "event ou reservation_code ausente/inválido" };

  const marca = `evt_${p.event}`;
  const rastro = p.traceId ? ` trace=${p.traceId}` : "";
  ctx.evento = p.event;
  ctx.reservationCode = p.reservationCode;
  ctx.traceId = p.traceId;

  // 3 — template configurado? Evento sem template é falha de configuração, e
  // falha de configuração é finding: foi exatamente isso que manteve o outbound
  // inerte por meses.
  const template = config.reservationEvents.templates[p.event] ?? "";
  ctx.template = template || null;
  if (!template) {
    await registrarFinding(
      `evento '${p.event}' recebido mas nenhum template configurado — nada foi enviado ao cliente (reserva ${p.reservationCode})`,
      p.reservationCode,
    );
    return { acao: "sem_template", detalhe: `template de '${p.event}' não configurado` };
  }

  // 4 — reserva existe?
  const r = await getReservationForEvent(p.reservationCode);
  if (!r) {
    await registrarFinding(
      `evento '${p.event}' para reserva inexistente ${p.reservationCode}${rastro}`,
      p.reservationCode,
    );
    return { acao: "reserva_nao_encontrada", detalhe: p.reservationCode };
  }

  // 5 — a trava de telefone. Só E.164 inequívoco e linha móvel.
  const tel = avaliarTelefone(r.customer_phone);
  ctx.qualidadeTelefone = tel.qualidade;
  ctx.pais = tel.pais;
  if (!podeReceberWhatsApp(tel)) {
    console.log(
      `[evento-reserva] ${p.event} ${p.reservationCode}: sem WhatsApp (${tel.qualidade} — ${tel.motivo}); segue por e-mail${rastro}`,
    );
    return { acao: "telefone_nao_enviavel", detalhe: `${tel.qualidade}: ${tel.motivo}` };
  }

  // 6 — consentimento.
  if (await isOptedOut(tel.e164)) {
    return { acao: "opt_out", detalhe: "cliente optou por não receber" };
  }

  // 7 — dados suficientes para uma mensagem CORRETA? Parâmetro vazio a Meta
  // rejeita, e data errada é pior que silêncio (ver montarParametros).
  const params = montarParametros(p.event, r, tel.pais);
  if (!params) {
    await registrarFinding(
      `evento '${p.event}' da reserva ${p.reservationCode} sem dados suficientes para o template ` +
        `(nome, restaurante, data ou hora ausente; no reagendamento, a data/hora PROPOSTA) — nada enviado${rastro}`,
      p.reservationCode,
    );
    return { acao: "dados_insuficientes", detalhe: `faltam campos para '${p.event}'` };
  }

  // 8 — teto diário do canário. Antes do claim, para um evento barrado pelo
  // teto não queimar a marca de dedup e poder sair amanhã.
  if (config.reservationEvents.dailyCap > 0) {
    let hoje: number;
    try {
      hoje = await contarEnviosHoje();
    } catch (err) {
      // Fail-closed: teto que não se consegue impor não é teto.
      await registrarFinding(
        `não foi possível contar os envios do dia para aplicar o teto — nada enviado ` +
          `(${err instanceof Error ? err.message : err})${rastro}`,
        p.reservationCode,
      );
      return { acao: "teto_diario", detalhe: "contagem do teto indisponível" };
    }
    if (hoje >= config.reservationEvents.dailyCap) {
      await registrarFinding(
        `teto diário de ${config.reservationEvents.dailyCap} envios atingido (${hoje} hoje) — ` +
          `evento '${p.event}' da reserva ${p.reservationCode} não enviado${rastro}`,
        p.reservationCode,
      );
      return { acao: "teto_diario", detalhe: `${hoje}/${config.reservationEvents.dailyCap} hoje` };
    }
  }

  // 9 — claim atômico ANTES do envio: dois webhooks simultâneos do n8n para a
  // mesma reserva não viram duas mensagens.
  const ganhou = await reservarEnvio(p.reservationCode, marca, tel.e164);
  if (!ganhou) {
    return { acao: "duplicado", detalhe: `${marca} já enviado para ${p.reservationCode}` };
  }

  // 10 — envio.
  const locale = localeParaTemplate(tel.e164);
  ctx.locale = locale;
  const ok = await sendTemplate({ to: tel.e164, template, locale, bodyParams: params });

  if (!ok) {
    // Devolve o claim: uma falha não pode queimar a notificação para sempre.
    await liberarEnvio(p.reservationCode, marca).catch(() => {});
    await registrarFinding(
      `envio do evento '${p.event}' falhou na Cloud API para a reserva ${p.reservationCode} ` +
        `(template '${template}', idioma '${locale}') — conferir aprovação do template nesse idioma${rastro}`,
      p.reservationCode,
    );
    return { acao: "falha_envio", detalhe: `template '${template}' idioma '${locale}'` };
  }

  publish({
    kind: "tool_call",
    chat: tel.e164,
    tool: `evento_${p.event}_${locale}`,
    success: true,
    latency_ms: 0,
    at: new Date().toISOString(),
  });
  console.log(
    `[evento-reserva] ${p.event} enviado · reserva ${p.reservationCode} · ${tel.pais} · ${locale}${rastro}`,
  );
  return { acao: "enviado", detalhe: `${template}/${locale}` };
}
