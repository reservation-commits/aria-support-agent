/**
 * scopeGuard.ts — decide se uma mensagem recebida está DENTRO do escopo de
 * atendimento da Aria (cliente ou estabelecimento tratando de assuntos da
 * The World Keys) ou se é ruído a ser IGNORADO em silêncio: newsletters,
 * disparos de marketing, promoções e relatórios automáticos de serviços
 * contratados.
 *
 * Este módulo é PURO (sem IO, sem config, sem SDK) — testável offline como
 * emailText/waLimits/historyTrim. A camada determinística abaixo pega o óbvio
 * (remetentes de ferramentas de email em massa, corpo com "cancelar inscrição"
 * etc.) a custo zero; o classificador semântico (que roda o modelo) vive em
 * claude.ts e usa o prompt/parser expostos aqui.
 *
 * PRINCÍPIO DE SEGURANÇA: preferimos deixar passar um spam a calar um cliente
 * de verdade. Por isso a lista determinística só marca sinais de ALTA confiança
 * e o classificador semântico falha em ABERTO (erro/dúvida → responde).
 */

export type ScopeLayer = "structural" | "semantic";

export type ScopeBlock = { layer: ScopeLayer; reason: string };

/**
 * Domínios de plataformas de email em massa / automação de marketing. Um
 * remetente nesses domínios praticamente nunca é um cliente ou restaurante
 * falando 1-a-1 com a gente. (Fragmentos casados por sufixo do host.)
 */
const BULK_SENDER_DOMAINS = [
  "mailchimp.com",
  "mcsv.net",
  "mcdlv.net",
  "rsgsv.net",
  "sendgrid.net",
  "sparkpostmail.com",
  "mailgun.org",
  "mailgun.net",
  "amazonses.com",
  "sendinblue.com",
  "sendibm1.com",
  "brevo.com",
  "rdstation.com.br",
  "rdstation.com",
  "rdops.io",
  "hubspot.com",
  "hubspotemail.net",
  "hs-send.com",
  "mailjet.com",
  "mlsend.com",
  "mailerlite.com",
  "constantcontact.com",
  "rs6.net",
  "klaviyomail.com",
  "klaviyo.com",
  "activehosted.com",
  "getresponse.com",
  "substack.com",
  "beehiiv.com",
  "cmail19.com",
  "cmail20.com",
  "createsend.com",
  "mktomail.com",
  "marketo.com",
  "pardot.com",
  "exct.net",
  "e.email",
  "ccsend.com",
  "mailup.com",
  "infobip.com",
];

/**
 * Localparts (o que vem antes do @) típicos de caixa que só dispara conteúdo
 * unilateral — marketing e notificação automática. NÃO incluímos ambíguos que
 * um restaurante legítimo poderia usar (info, hello, contato, reservas,
 * financeiro/billing) para não gerar falso positivo.
 */
const BULK_LOCALPART = new RegExp(
  "^(" +
    [
      "news",
      "newsletter",
      "newsletters",
      "marketing",
      "mkt",
      "promo",
      "promos",
      "promocao",
      "promocoes",
      "promocional",
      "ofertas",
      "oferta",
      "offers",
      "deals",
      "mailer",
      "mailing",
      "campaign",
      "campanha",
      "campanhas",
      "digest",
      "bulletin",
      "boletim",
      "notification",
      "notifications",
      "notificacao",
      "notificacoes",
      "notify",
      "noti",
      "updates",
      "alerts",
      "alert",
      "newsroom",
    ].join("|") +
    ")([._-]|$|[0-9])",
  "i",
);

/**
 * Marcadores de rodapé de email em massa. Um email 1-a-1 de verdade jamais traz
 * "cancelar inscrição" / "ver no navegador" / "gerenciar preferências". Presença
 * de qualquer um => newsletter/marketing com altíssima confiança (mesmo sem os
 * headers List-* que as guardas estruturais já pegam).
 */
const BULK_BODY_MARKERS: RegExp[] = [
  /\bunsubscribe\b/i,
  /cancelar\s+(?:\w+\s+)?inscri[çc][ãa]o/i,
  /cancelar\s+(?:\w+\s+)?assinatura/i,
  /descadastr\w*/i,
  /se\s+desinscrev\w*/i,
  /darse\s+de\s+baja|darte\s+de\s+baja/i,
  /para\s+(deixar|parar)\s+de\s+receber/i,
  /n[ãa]o\s+(deseja|quer)\s+(mais\s+)?receber/i,
  /no\s+longer\s+wish\s+to\s+receive/i,
  /opt[\s-]?out/i,
  /gerenciar\s+(suas\s+)?prefer[êe]ncias/i,
  /(update|manage)\s+your\s+(email\s+)?preferences/i,
  /ver\s+(este\s+)?(email|e-mail)\s+no\s+navegador/i,
  /view\s+(this\s+)?(email|e-?mail|message)\s+in\s+(your\s+)?browser/i,
  /voir\s+(cet\s+)?e-?mail\s+dans\s+(votre\s+)?navigateur/i,
  /you'?re\s+receiving\s+this\s+(email|because)/i,
  /voc[êe]\s+est[áa]\s+recebendo\s+(este|esse)\s+e-?mail/i,
];

/**
 * Assuntos inequívocos de relatório automático de serviço/infra (DMARC, TLS,
 * status de entrega). Nenhum cliente ou restaurante escreve assim — bloqueio
 * de alta confiança, custo zero.
 */
const AUTOMATED_REPORT_SUBJECTS: RegExp[] = [
  // Relatório agregado DMARC (Google/Yahoo/Microsoft…). O prefixo opcional entre
  // colchetes existe porque a Microsoft manda "[Preview] Report Domain: …" — 40
  // desses escaparam para a camada semântica (paga) até 2026-09-22.
  /^\s*(\[[^\]]{1,20}\]\s*)?(re:\s*)?report domain:/i,
  /^\s*(\[[^\]]{1,20}\]\s*)?report-id:/i,
  /\bdmarc\b.*\breport\b|\breport\b.*\bdmarc\b/i,
  /\b(aggregate|tls)\s+report\b/i,
  /\bsmtp\s+tls\s+report\b/i,
  /\bdelivery\s+status\s+notification\b/i,
  /\bscheduled\s+(report|export)\b/i,
  /\brelat[óo]rio\s+(autom[áa]tico|agendado|semanal\s+de\s+uso)\b/i,
];

/** Extrai o domínio (host, minúsculo) de um endereço de email. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  return address.slice(at + 1).toLowerCase().trim();
}

/** Extrai o localpart (minúsculo) de um endereço de email. */
function localpartOf(address: string): string | null {
  const at = address.indexOf("@");
  if (at <= 0) return null;
  return address.slice(0, at).toLowerCase().trim();
}

/**
 * Camada DETERMINÍSTICA (custo zero). Retorna o motivo do bloqueio quando a
 * mensagem é claramente marketing/newsletter/notificação automática; null quando
 * não há sinal forte (aí decide o classificador semântico).
 *
 * Pensada para EMAIL (tem remetente/assunto/corpo). No WhatsApp o remetente é um
 * telefone — passe só o `text`, e mesmo assim o corpo pode conter marcadores.
 */
export function deterministicOutOfScope(input: {
  from?: string | null;
  subject?: string | null;
  text?: string | null;
}): ScopeBlock | null {
  const from = (input.from ?? "").toLowerCase().trim();
  if (from) {
    const domain = domainOf(from);
    if (domain && BULK_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) {
      return { layer: "structural", reason: `remetente de plataforma de email em massa (${domain})` };
    }
    const local = localpartOf(from);
    if (local && BULK_LOCALPART.test(local)) {
      return { layer: "structural", reason: `caixa de marketing/notificação (${local}@)` };
    }
  }

  const subject = (input.subject ?? "").trim();
  if (subject && AUTOMATED_REPORT_SUBJECTS.some((re) => re.test(subject))) {
    return { layer: "structural", reason: `assunto de relatório automático de serviço ("${subject.slice(0, 80)}")` };
  }

  const body = input.text ?? "";
  if (body) {
    const marker = BULK_BODY_MARKERS.find((re) => re.test(body));
    if (marker) {
      return { layer: "structural", reason: "corpo com rodapé de email em massa (descadastro/preferências)" };
    }
  }

  return null;
}

// ─── Classificador semântico (o prompt e o parser; a chamada vive em claude.ts) ──

/**
 * Instrução do classificador. Ele NÃO conversa nem atende — só rotula a primeira
 * mensagem de um contato como no-escopo ou fora-de-escopo. É deliberadamente
 * conservador: na dúvida, DENTRO do escopo (o custo de calar um cliente real é
 * maior que o de responder um ruído).
 */
export const SCOPE_CLASSIFIER_SYSTEM = `Você é um filtro de triagem da The World Keys, uma plataforma premium de reservas de restaurantes. Recebe a PRIMEIRA mensagem de um novo contato e decide se ela merece atendimento humano/da assistente.

RESPONDA (in_scope=true) quando a mensagem for de:
- um CLIENTE (dúvida, reserva, alteração/cancelamento, recomendação, avaliação, reclamação, elogio, qualquer pedido de atendimento);
- um ESTABELECIMENTO/RESTAURANTE ou parceiro tratando da plataforma, de reservas, do cadastro, da parceria ou de operação;
- qualquer pessoa realmente falando com a The World Keys sobre seus serviços de reserva/concierge.
Na DÚVIDA, responda in_scope=true.

IGNORE (in_scope=false) SOMENTE quando for claramente:
- newsletter, informativo ou disparo em massa;
- email/mensagem de marketing, promoção, propaganda, oferta, cupom, venda, prospecção comercial (cold outreach) de fornecedores querendo VENDER algo para a empresa;
- relatório automático, resumo periódico, fatura/cobrança ou notificação de um SERVIÇO/FERRAMENTA contratado (SaaS, analytics, hospedagem, pagamento, etc.);
- confirmação/alerta automático de sistema não relacionado a um cliente da plataforma.

Responda APENAS com JSON, sem texto extra:
{"in_scope": true|false, "reason": "<motivo curto>"}`;

export type ScopeVerdict = { inScope: boolean; reason: string };

/**
 * Interpreta a resposta do classificador. Tolerante a JSON cercado por texto ou
 * blocos de código. FALHA EM ABERTO: qualquer resposta que não afirme
 * explicitamente in_scope=false é tratada como DENTRO do escopo (responde).
 */
export function parseScopeVerdict(raw: string): ScopeVerdict {
  const fallback: ScopeVerdict = { inScope: true, reason: "resposta do classificador não interpretável — mantido no escopo" };
  if (!raw) return fallback;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const obj = JSON.parse(match[0]) as { in_scope?: unknown; reason?: unknown };
    if (typeof obj.in_scope !== "boolean") return fallback;
    return {
      inScope: obj.in_scope,
      reason: typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : (obj.in_scope ? "no escopo" : "fora do escopo"),
    };
  } catch {
    return fallback;
  }
}
