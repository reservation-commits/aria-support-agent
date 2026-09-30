import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  webhookPath: process.env.WEBHOOK_PATH ?? "/webhook/whatsapp",

  // Em produção (NODE_ENV=production) os requisitos de segurança viram
  // OBRIGATÓRIOS (fail-closed): HMAC do webhook e SSL verificado do Postgres.
  // Ver checagens no boot (index.ts).
  isProduction: (process.env.NODE_ENV ?? "").toLowerCase() === "production",

  // URL pública DESTE servidor (Easypanel), sem barra no fim. Usada para os
  // ícones do rodapé dos emails (PUBLIC_URL/icons/*). Se vazio, o email cai
  // num rodapé de contatos por texto (os ícones não aparecem).
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    // Modelo mais capaz da Anthropic — máxima inteligência para resolver o
    // pedido do cliente. Override via ANTHROPIC_MODEL (ex: claude-sonnet-4-6
    // para respostas mais rápidas/baratas). Prompt+tools são cacheados, o que
    // reduz bastante o custo de input mesmo no Opus.
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  },

  cost: {
    // Teto DIÁRIO de tokens (input+output do modelo principal, dia UTC).
    // 0 = sem teto. Ao ultrapassar, a Aria NÃO para: degrada para o modelo de
    // fallback (mais barato) até a virada do dia e alerta no painel. Protege
    // contra abuso/custo desgovernado sem jamais calar um cliente real.
    dailyTokenBudget: Number(process.env.COST_DAILY_TOKEN_BUDGET ?? 0),
    fallbackModel: process.env.COST_FALLBACK_MODEL ?? "claude-haiku-4-5-20251001",
  },

  whatsapp: {
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "", // optional but recommended
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
  },

  pg: {
    host: required("PGHOST"),
    port: Number(process.env.PGPORT ?? 5432),
    user: required("PGUSER"),
    password: required("PGPASSWORD"),
    database: required("PGDATABASE"),
    ssl: (process.env.PGSSL ?? "true").toLowerCase() === "true",
    // Cloud SQL e a maioria dos provedores usam certificado próprio; por padrão
    // não exigimos cadeia válida. Em ambientes com CA confiável, setar
    // PGSSL_REJECT_UNAUTHORIZED=true endurece contra MITM.
    sslRejectUnauthorized:
      (process.env.PGSSL_REJECT_UNAUTHORIZED ?? "false").toLowerCase() === "true",
    // Reconhecimento EXPLÍCITO de que o certificado do banco não é verificado
    // (Cloud SQL com cert próprio). Em produção, sem PGSSL_REJECT_UNAUTHORIZED
    // nem este flag, o boot FALHA — segurança não fica implícita.
    allowUnverifiedSsl:
      (process.env.PGSSL_ALLOW_UNVERIFIED ?? "false").toLowerCase() === "true",
  },

  openaiKey: process.env.OPENAI_API_KEY ?? "",
  googleMapsKey: process.env.GOOGLE_MAPS_API_KEY ?? "",

  embeddings: {
    // Descoberta SEMÂNTICA de restaurantes + memória de longo prazo do cliente.
    // Precisa de OPENAI_API_KEY (embeddings text-embedding-3-small — custo
    // desprezível). DESLIGADO por padrão; sem ele, a descoberta segue no
    // full-text e a memória nos notes do perfil (comportamento anterior).
    // Não requer pgvector: os vetores ficam em tabela comum e a similaridade
    // roda em memória (catálogo curado cabe com folga).
    enabled: (process.env.EMBEDDINGS_ENABLED ?? "false").toLowerCase() === "true",
    model: process.env.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
  },

  // Fuso usado para calcular "aberto agora" em buscas por proximidade. Padrão:
  // mercado primário (Brasil). "Perto de mim" costuma ser local ao cliente.
  localTz: process.env.TWK_LOCAL_TZ ?? "America/Sao_Paulo",

  session: {
    ttlMinutes: Number(process.env.SESSION_TTL_MINUTES ?? 60),
    maxHistoryTurns: Number(process.env.MAX_HISTORY_TURNS ?? 20),
  },

  reply: {
    // Minimum wall-clock time between receiving a message and sending the reply.
    // Makes the bot feel less robotic without parecer travado — 3s é suave e
    // ainda fica dentro da janela do indicador "digitando".
    minDelaySeconds: Number(process.env.RESPONSE_MIN_DELAY_SECONDS ?? 3),
    // Janela de coalescência: mensagens em rajada (cliente digitando em vários
    // balões) são agrupadas num único turno do agente. Evita race condition e
    // respostas desencontradas.
    debounceMs: Number(process.env.REPLY_DEBOUNCE_MS ?? 2500),
  },

  reminders: {
    // Outbound proativo: lembrete da reserva algumas horas antes. DESLIGADO por
    // padrão — só liga depois do template aprovado no WhatsApp Manager.
    enabled: (process.env.REMINDERS_ENABLED ?? "false").toLowerCase() === "true",
    // Nome do template aprovado (o MESMO nome, com várias traduções de idioma).
    template: process.env.REMINDERS_TEMPLATE ?? "",
    // Idioma de fallback quando não der para inferir pelo país, ou quando o
    // idioma do país ainda não tem tradução aprovada no template.
    //
    // Padrão INGLÊS, não pt_BR: a validação da base (2026-09-21,
    // docs/notificacoes/fase0-validacao-telefones.md) mostrou que os telefones
    // entregáveis são US 3.938 · GB 1.713 · SG 1.215 · FR 751 · CA 722 ·
    // AU 709 · HK 648 · IT 502 · DE 489 · BR 429. Português era o 10º grupo.
    defaultLocale: process.env.REMINDERS_DEFAULT_LOCALE ?? "en",
    // Idiomas REALMENTE aprovados no template (no WhatsApp Manager). O agente só
    // envia nestes; idioma de país fora desta lista cai no defaultLocale.
    // Comece com o que existe (en) e amplie conforme aprovar (ex: "en,fr,pt_BR,es").
    locales: (process.env.REMINDERS_LOCALES ?? "en")
      .split(",").map((s) => s.trim()).filter(Boolean),
    // Quantas horas antes da reserva enviar o lembrete.
    hoursBefore: Number(process.env.REMINDERS_HOURS_BEFORE ?? 2),
    // Só envia para reservas neste status (a regra do negócio: aceita).
    status: process.env.REMINDERS_STATUS ?? "accept",
    // Intervalo de varredura do scheduler (min). Menor = lembrete mais perto das 2h.
    sweepMinutes: Number(process.env.REMINDERS_SWEEP_MINUTES ?? 20),
  },

  reservationEvents: {
    // Notificação TRANSACIONAL por evento: o n8n — que já dispara o e-mail em
    // cada transição da reserva — avisa a Aria em POST /webhook/reservation-event
    // e ela manda o template de WhatsApp. Um dono da mensagem, dois canais.
    //
    // As varreduras de reminders.ts são por TEMPO (2h antes, véspera, pós). Esta
    // é por EVENTO: é ela que diz "seu pedido foi aceito" no instante em que foi,
    // que é o que o cliente espera do WhatsApp.
    //
    // DESLIGADO por padrão. Ligar exige aprovação do fundador (constituição:
    // "novo fluxo orquestrado entrando em operação").
    enabled: (process.env.RESERVATION_EVENTS_ENABLED ?? "false").toLowerCase() === "true",
    // Segredo compartilhado (header x-aria-secret). Sem ele a rota responde 404:
    // não existe caminho de envio sem autenticação.
    secret: process.env.RESERVATION_EVENTS_SECRET ?? "",
    // Teto de envios por dia (UTC). 0 = sem teto. Rede de segurança do canário
    // contra tempestade (n8n re-tentando em laço, importação em lote). O volume
    // normal é ~13 pedidos/dia; 25 dá folga e ainda barra um surto.
    // FAIL-CLOSED: se o teto está ligado e não dá para contar, NÃO envia — teto
    // que não se consegue impor não é teto.
    dailyCap: Number(process.env.RESERVATION_EVENTS_DAILY_CAP ?? 0),
    // Nome do template aprovado na Meta para cada evento. Evento sem template
    // configurado não envia nada — e registra finding, nunca silêncio.
    templates: {
      pedido_recebido: process.env.RESERVATION_EVENT_TEMPLATE_RECEBIDO ?? "",
      aceito: process.env.RESERVATION_EVENT_TEMPLATE_ACEITO ?? "",
      recusado: process.env.RESERVATION_EVENT_TEMPLATE_RECUSADO ?? "",
      reagendamento_proposto: process.env.RESERVATION_EVENT_TEMPLATE_REAGENDAMENTO ?? "",
      cancelado: process.env.RESERVATION_EVENT_TEMPLATE_CANCELADO ?? "",
    } as Record<string, string>,
    // Etapas do ESTABELECIMENTO (2026-09-25): só para casas marcadas no opt-in
    // (tipo = estabelecimento). Vazio = etapa da casa desligada, sem finding.
    venueTemplates: {
      pedido_recebido: process.env.RESERVATION_EVENT_TEMPLATE_VENUE_RECEBIDO ?? "",
      cancelado: process.env.RESERVATION_EVENT_TEMPLATE_VENUE_CANCELADO ?? "",
    } as Record<string, string>,
  },

  reservationWatch: {
    // Vigia de reservas (watcher.ts): a Aria lê a tabela e dispara os eventos sozinha —
    // sem depender do n8n. Só age com RESERVATION_EVENTS_ENABLED=true.
    enabled: (process.env.RESERVATION_WATCH_ENABLED ?? "true").toLowerCase() !== "false",
    intervalMinutes: Number(process.env.RESERVATION_WATCH_MINUTES ?? 2),
  },

  revisao: {
    // Revisão semântica ANTES do envio (revisao.ts). Ligada por padrão; desligar só em
    // emergência — as regras da porta continuam valendo mesmo com isto off.
    enabled: (process.env.REVISAO_PRE_ENVIO ?? "true").toLowerCase() !== "false",
  },

  venueBriefing: {
    // Véspera para a CASA: nome, hora e pessoas, ~24h antes. Só casas marcadas.
    enabled: (process.env.VENUE_BRIEFING_ENABLED ?? "false").toLowerCase() === "true",
    template: process.env.VENUE_BRIEFING_TEMPLATE ?? "",
    hoursBefore: Number(process.env.VENUE_BRIEFING_HOURS_BEFORE ?? 24),
  },

  email: {
    // Canal de EMAIL (Gmail API, caixa reservation@). DESLIGADO por padrão —
    // liga com EMAIL_ENABLED=true + credenciais OAuth do Google Cloud
    // (client_id/secret do tipo "Desktop app" + refresh_token com escopo
    // gmail.modify da própria caixa). Ver README para o passo a passo.
    enabled: (process.env.EMAIL_ENABLED ?? "false").toLowerCase() === "true",
    // Endereço da caixa PRINCIPAL atendida (usado no From do modo Gmail direto
    // e como fallback quando não dá para saber em qual caixa o email chegou).
    address: (process.env.EMAIL_ADDRESS ?? "").trim().toLowerCase(),
    // Caixas ADICIONAIS vigiadas via n8n (separadas por vírgula) — ex.:
    // reservation@theworldkeys.com, que recebe as respostas dos restaurantes às
    // notificações de reserva. Cada caixa extra precisa do seu próprio Gmail
    // Trigger no n8n apontando para o MESMO POST /webhook/email (com o campo
    // "mailbox" no corpo) e de um ramo próprio no fluxo de envio (a resposta
    // SEMPRE sai pela caixa que recebeu — senão a thread quebra).
    extraAddresses: (process.env.EMAIL_EXTRA_ADDRESSES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Nome de exibição no From.
    fromName: process.env.EMAIL_FROM_NAME ?? "Aria · The World Keys",
    clientId: process.env.GMAIL_CLIENT_ID ?? "",
    clientSecret: process.env.GMAIL_CLIENT_SECRET ?? "",
    refreshToken: process.env.GMAIL_REFRESH_TOKEN ?? "",
    // MODO N8N (alternativa sem credenciais Google próprias): o n8n — que já
    // está autenticado na caixa — empurra os emails recebidos para
    // POST /webhook/email e envia as respostas pelo webhook abaixo.
    n8nSendWebhook: process.env.N8N_EMAIL_SEND_WEBHOOK ?? "",
    // Segredo compartilhado (header x-aria-secret) que protege a entrada e
    // assina a saída. OBRIGATÓRIO no modo n8n.
    webhookSecret: process.env.EMAIL_WEBHOOK_SECRET ?? "",
    // Intervalo de varredura da caixa (segundos). Email tolera latência —
    // 60s dá sensação de resposta imediata sem estressar a API.
    pollSeconds: Number(process.env.EMAIL_POLL_SECONDS ?? 60),
    // Só processa emails mais novos que N dias (proteção contra responder um
    // backlog antigo de não-lidos ao ligar o canal pela primeira vez).
    maxAgeDays: Number(process.env.EMAIL_MAX_AGE_DAYS ?? 7),
    // replay da fila pendente em runtime (minutos). 0 desliga.
    replayMinutes: Math.max(1, Number(process.env.EMAIL_REPLAY_MINUTES ?? 10)),
  },

  n8nApi: {
    // API REST do n8n para o painel ler as execuções do rastreador de cliques
    // da campanha (workflow do webhook /go). Somente leitura. Sem estas duas
    // variáveis, o bloco Campanha mostra os envios mas avisa que cliques não
    // estão configurados.
    apiUrl: (process.env.N8N_API_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.N8N_API_KEY ?? "",
    clickWorkflowId: process.env.N8N_CLICK_WORKFLOW_ID ?? "HoFjhfqzPmCAkrnZ",
  },

  pendingWatch: {
    // Watchdog interno: reservas paradas em aprovação há N horas geram uma
    // escalação automática PENDENTE_12H no painel (SEM mensagem ao cliente).
    // DESLIGADO por padrão — ligue depois de confirmar qual booking_status
    // representa "aguardando aprovação" no seu banco.
    enabled: (process.env.PENDING_WATCH_ENABLED ?? "false").toLowerCase() === "true",
    hours: Number(process.env.PENDING_WATCH_HOURS ?? 12),
    status: process.env.PENDING_WATCH_STATUS ?? "pending",
  },

  briefing: {
    // Briefing de VÉSPERA: template ~24h antes da reserva, com restaurante,
    // data e horário — o toque de concierge que antecipa a experiência (o
    // cliente responde e a Aria orienta rota, dress code, observações).
    // DESLIGADO por padrão; requer template aprovado com {{1}} primeiro nome ·
    // {{2}} restaurante · {{3}} data (DD/MM) · {{4}} horário (HH:MM).
    enabled: (process.env.BRIEFING_ENABLED ?? "false").toLowerCase() === "true",
    template: process.env.BRIEFING_TEMPLATE ?? "",
    hoursBefore: Number(process.env.BRIEFING_HOURS_BEFORE ?? 24),
  },

  review: {
    // Pós-experiência: mensagem ~6h DEPOIS da reserva, agradecendo e convidando
    // o cliente a avaliar. Ao responder, a Aria conduz a coleta da avaliação.
    // DESLIGADO por padrão. Compartilha defaultLocale/sweep com reminders.
    enabled: (process.env.REVIEW_ENABLED ?? "false").toLowerCase() === "true",
    template: process.env.REVIEW_TEMPLATE ?? "",
    hoursAfter: Number(process.env.REVIEW_HOURS_AFTER ?? 6),
    status: process.env.REVIEW_STATUS ?? "accept",
  },

  alerts: {
    // Alertas críticos por EMAIL para a equipe (escalação URGENTE, health
    // check reprovado, teto de custo, testes falhando). Requer o canal de
    // email ativo. DESLIGADO por padrão.
    enabled: (process.env.ALERTS_ENABLED ?? "false").toLowerCase() === "true",
    emailTo: (process.env.ALERT_EMAIL_TO ?? "").trim(),
    minIntervalMin: Number(process.env.ALERT_MIN_INTERVAL_MIN ?? 30),
  },

  scope: {
    // Bloqueio de escopo: a Aria só responde clientes e estabelecimentos sobre
    // assuntos da plataforma. Newsletters, marketing, propaganda e relatórios
    // automáticos de serviços contratados são IGNORADOS em silêncio (registrados
    // no painel). LIGADO por padrão. Duas camadas:
    //  1) determinística (custo zero): remetentes de ferramentas de email em
    //     massa e corpo com rodapé de descadastro;
    //  2) semântica: um classificador barato roda na PRIMEIRA mensagem de cada
    //     contato novo e decide no-escopo/fora-de-escopo (falha em aberto).
    enabled: (process.env.SCOPE_FILTER_ENABLED ?? "true").toLowerCase() === "true",
    // Modelo do classificador — barato e rápido (a triagem não precisa do Opus).
    // Override via SCOPE_MODEL.
    model: process.env.SCOPE_MODEL ?? "claude-haiku-4-5-20251001",
  },

  platform: {
    // Base URL of theworldkeys.com (no trailing slash). Used for the login
    // fallback link. Restaurant page URLs come from the db column url_page_twk,
    // never built here.
    baseUrl: (process.env.TWK_PLATFORM_URL ?? "https://theworldkeys.com").replace(/\/+$/, ""),
  },
} as const;
