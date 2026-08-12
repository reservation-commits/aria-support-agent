# Aria — WhatsApp Support Agent

Agente de atendimento da **The World Keys** via WhatsApp.
Stack: Node.js 22 · TypeScript · Express · Anthropic Claude (tool calling) · **WhatsApp Cloud API (Meta)** · PostgreSQL.

---

## Estrutura

```
src/
  index.ts         # Express, verificação GET do webhook, validação HMAC
  config.ts        # leitura de env
  systemPrompt.ts  # prompt da Aria
  claude.ts        # loop de tool calling (Anthropic SDK)
  tools.ts         # 11 tools (10 SQL + escalate_to_human)
  db.ts            # pool pg + funções de query parametrizadas
  whatsapp.ts      # cliente Cloud API (Graph) — send, mark-as-read, media
  webhook.ts       # parser de payload Meta (texto / imagem / áudio / interactive / location)
  media.ts         # transcrição de áudio via Whisper (opcional)
  sessions.ts      # histórico de conversa em memória (TTL)
Dockerfile
.env.example
```

---

## Variáveis de ambiente

| Variável | Obrigatório | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | **sim** | Chave da Anthropic |
| `ANTHROPIC_MODEL` | não (`claude-sonnet-4-6`) | Modelo Claude |
| `WHATSAPP_PHONE_NUMBER_ID` | **sim** | ID do número (Meta) |
| `WHATSAPP_ACCESS_TOKEN` | **sim** | System User Access Token permanente |
| `WHATSAPP_VERIFY_TOKEN` | **sim** | String aleatória que você inventa — usada na verificação inicial do webhook |
| `WHATSAPP_APP_SECRET` | recomendado | App Secret do app no Meta for Developers — habilita validação HMAC da assinatura |
| `WHATSAPP_GRAPH_VERSION` | não (`v21.0`) | Versão da Graph API |
| `PGHOST/PORT/USER/PASSWORD/DATABASE` | **sim** | Postgres (Google Cloud) |
| `PGSSL` | não (`true`) | SSL para Cloud SQL |
| `OPENAI_API_KEY` | não | Habilita Whisper para áudios |
| `PORT` | não (3000) | |
| `WEBHOOK_PATH` | não (`/webhook/whatsapp`) | |
| `SESSION_TTL_MINUTES` | não (60) | |
| `MAX_HISTORY_TURNS` | não (20) | |

---

## Passo a passo no Meta for Developers

### 1. Pegar o `WHATSAPP_PHONE_NUMBER_ID`
1. Abra https://business.facebook.com → **WhatsApp Manager**
2. Clique no número (`+55 21 96784-1007`)
3. O **ID do número de telefone** aparece no topo da página (números longos)
4. Copie para `WHATSAPP_PHONE_NUMBER_ID`

### 2. Pegar o `WHATSAPP_ACCESS_TOKEN` (permanente)
1. Em https://business.facebook.com → **Configurações** → **Usuários do sistema**
2. Crie um System User (ou use um existente) com **role: Admin**
3. Clique em **Atribuir ativos** → atribua a conta do WhatsApp Business com permissão de **gerenciar**
4. Clique em **Gerar token** → escolha o app → marque os escopos:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. **Sem data de expiração** → copie o token. Esse é o `WHATSAPP_ACCESS_TOKEN`.

### 3. Criar (ou reaproveitar) o App e pegar o `WHATSAPP_APP_SECRET`
1. https://developers.facebook.com → **Meus Apps** → criar app do tipo **Business**
2. Adicione o produto **WhatsApp**
3. Em **Configurações → Básico**: copie o **App Secret** → `WHATSAPP_APP_SECRET`
4. Vincule o número da WhatsApp Business Account ao app (passo do próprio assistente da Meta)

### 4. Configurar o webhook
1. No app → **WhatsApp → Configuration → Webhook**
2. **Callback URL**: `https://seu-dominio/webhook/whatsapp`
3. **Verify Token**: cole exatamente o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
4. Clique em **Verificar e salvar** — a Meta vai bater no GET; se o token bater, fica ✅
5. Em **Webhook fields**, marque pelo menos: **`messages`**

### 5. Deploy
- No Easypanel, redeploy.
- Logs devem mostrar `[aria] listening on :3000` e ao salvar o webhook na Meta, `[webhook] verification ok`.
- Mande um WhatsApp pro número e a Aria responde.

---

## Janela de 24h e templates

A Cloud API só deixa enviar **mensagens livres** (texto normal) dentro de uma janela de **24h após a última mensagem do usuário**. Fora dessa janela, é preciso usar um **template aprovado pela Meta**.

Pra Aria de suporte respondendo a quem escreveu primeiro, isso nunca é problema.

**Outbound proativo já implementado:** [src/reminders.ts](src/reminders.ts) varre reservas aceitas e dispara um **lembrete ~2h antes** (configurável via `REMINDERS_HOURS_BEFORE`) via template aprovado (`sendTemplate` em [src/whatsapp.ts](src/whatsapp.ts)). Cada reserva recebe o lembrete uma única vez (`aria_reminders_sent`). Vem **desligado** por padrão — ligue com `REMINDERS_ENABLED=true` depois de aprovar um template em WhatsApp Manager → **Templates de mensagens** e setar `REMINDERS_TEMPLATE`. O corpo do template precisa ter, nesta ordem: `{{1}}` primeiro nome · `{{2}}` restaurante · `{{3}}` horário (HH:MM). Há também o convite de avaliação ~6h após a visita (`REVIEW_ENABLED` + `REVIEW_TEMPLATE`, corpo: `{{1}}` primeiro nome · `{{2}}` restaurante).

---

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha as chaves
npm run dev
```

Pra testar o webhook localmente, exponha a porta via ngrok/cloudflared:
```bash
ngrok http 3000
```
E use a URL do ngrok como Callback URL na Meta.

Health check: `GET http://localhost:3000/health`

---

## Como o agente decide

- Cada mensagem chega como `messages` no webhook da Meta → parser monta `ContentBlockParam[]` para o Claude (texto + imagens em base64 + transcrição de áudio + texto de botões interativos + localização).
- O Claude usa o system prompt da Aria ([src/systemPrompt.ts](src/systemPrompt.ts)) e decide quando chamar tools.
- Tools são SQL **parametrizado** ([src/db.ts](src/db.ts)) — zero injeção.
- `escalate_to_human` grava em `public.update_events` e loga em `console.warn` (plugue Slack/email/ticket em [src/tools.ts](src/tools.ts)).

## Tools disponíveis ao modelo

**Leitura (reservas são somente leitura — alteração/cancelamento é sempre pelo site):**

| Tool | Quando o modelo usa |
|---|---|
| `find_reservation_by_code` | Cliente fornece código (`TWK-XXXXXXXX`) |
| `find_reservations_by_email` / `find_reservations_by_phone` | Histórico do cliente |
| `search_reservations` | Cliente sem código, mas com pistas (nome, restaurante, data) |
| `get_restaurant_opening_hours` / `get_restaurant_info` | Horários e info pública |
| `search_restaurants` / `discover_restaurants` / `find_restaurants_near` | Busca estruturada, por vibe (full-text) e por proximidade (com `open_now`) |
| `get_booking_link_by_name` / `get_restaurant_booking_link` | URL oficial de reserva (`url_page_twk`) |
| `get_restaurant_location` / `compute_route_to_restaurant` | Endereço + Maps, rota e "hora de sair" |
| `get_customer_profile` / `update_customer_profile` | Perfil acumulativo (alergias, gostos) |
| `run_sql_read` | SELECT livre blindado (sqlGuard + transação read-only) |
| `find_user` | Resolver usuário por email/telefone |

**Mensagens ricas nativas do WhatsApp (o servidor envia na hora):**

| Tool | O que envia |
|---|---|
| `send_restaurant_options` | Lista interativa com até 10 restaurantes (nomes/cidades resolvidos pelo servidor); a escolha volta como `[Sistema: seleção id=restaurant:<id>]` |
| `send_quick_replies` | Até 3 botões de resposta rápida para confirmações fechadas |
| `send_booking_button` | Botão *Reservar* que abre a página oficial — o servidor busca o `url_page_twk` exato pelo `restaurant_id` (zero risco de URL inventada) |
| `send_location_pin` | Pin de localização nativo (abre no mapa do aparelho) |

**Ações:**

| Tool | Quando o modelo usa |
|---|---|
| `save_experience_review` | Fim do fluxo de avaliação pós-experiência |
| `set_outbound_consent` | Opt-out/opt-in conversacional de mensagens proativas |
| `log_attendance_event` | Auditoria interna |
| `escalate_to_human` | Tags: URGENTE, PENDENTE_12H, MODIFICACAO, PEDIDO_ESPECIAL, ACESSIBILIDADE, PARCEIRO_B2B |

---

## Tipos de mensagem aceitos

- **Texto** ✓
- **Imagem** ✓ (base64 → multimodal Claude)
- **Áudio** ✓ (Whisper se `OPENAI_API_KEY` setado; senão pede reenvio em texto)
- **Botão interativo / lista** ✓ (vira texto)
- **Localização** ✓ (vira texto descritivo)
- Vídeo / Documento / Sticker — reconhecidos; conteúdo pedido em texto (não baixa binário ainda)

---

## Segurança

- **Validação HMAC** dos webhooks via `x-hub-signature-256` quando `WHATSAPP_APP_SECRET` está setado. Sem o secret, qualquer um que conhecer a URL pode mandar payload — em produção, sempre setar.
- Tokens nunca logados.
- Queries SQL 100% parametrizadas.
- Container roda como user não-root (`app`) no Dockerfile.

---

## Robustez de runtime (implementado)

- **Coalescência de rajada + serialização por conversa** ([src/conversationQueue.ts](src/conversationQueue.ts)): mensagens em sequência do mesmo número viram um único turno do agente, e turnos do mesmo chat nunca rodam em paralelo. Elimina race condition de histórico e respostas desencontradas. Janela via `REPLY_DEBOUNCE_MS` (padrão 2500ms).
- **Trimming de histórico seguro** ([src/sessions.ts](src/sessions.ts)): nunca corta entre um `tool_use` e seu `tool_result` (evita HTTP 400) e preserva o systemHint inicial.
- **Telefone server-side** ([src/tools.ts](src/tools.ts)): perfil/reservas usam o número real do WhatsApp (chatId), não o que o modelo digitou — confiabilidade + impede consultar dados de outro número.
- **`sendText` com retry/backoff** e detecção de janela de 24h ([src/whatsapp.ts](src/whatsapp.ts)) — não derruba o fluxo e não loga outbound que não entregou.
- **Modo handoff humano** ([src/handoff.ts](src/handoff.ts)): pelo painel (`POST /dashboard/api/handoff/:chatId`) um atendente assume e a Aria silencia aquele chat por um TTL, voltando sozinha depois.
- **Status de entrega**: webhooks `statuses` com `failed` são logados.
- **Documentos PDF**: baixados e enviados ao Claude como bloco de documento (leitura nativa); base64 não é persistido no checkpoint.
- **Deduplicação persistida** ([src/db.ts](src/db.ts) `markMessageProcessed`, tabela `aria_processed_messages`): além do cache em memória, cada `wa_message_id` é registrado no banco — reentregas da Meta após restart/deploy (ou em múltiplas réplicas) não geram resposta duplicada. Poda diária automática.
- **Descoberta por relevância** ([src/db.ts](src/db.ts) `discoverRestaurants`, tool `discover_restaurants`): full-text search nativo do Postgres (`websearch_to_tsquery` + `ts_rank`) sobre `about_text`+nome+cidade+país. Entende pedidos por vibe/ocasião ("romântico com vista", "bom para fechar negócio"). Sem extensão. Para catálogos grandes, acelere com um índice GIN:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS db_restaurants_fts_idx
    ON public.db_restaurants
    USING GIN (to_tsvector('simple',
      coalesce(name,'') || ' ' || coalesce(about_text,'') || ' ' ||
      coalesce(city,'') || ' ' || coalesce(country,'')));
  ```
  **Acentos:** as migrations tentam habilitar a extensão `unaccent` automaticamente (best-effort — sem privilégio, segue sem ela). Quando disponível, a busca normaliza acentos ("São Paulo" casa com "sao paulo"), detectado no startup (`detectUnaccent`). Nenhum passo manual.
  (Migração para embeddings/pgvector é troca interna de `discoverRestaurants`, sem mexer no resto.)
- **Validação de horário**: antes de mandar reservar um dia/hora específico, a Aria confere os `opening_hours` e, se o restaurante estiver fechado nesse dia/hora, oferece os horários reais em vez de mandar para uma reserva impossível.
- **Opt-out / consentimento** ([src/consent.ts](src/consent.ts)): "PARAR"/"stop"/"quero parar os lembretes" (multi-idioma) são detectados antes do agente, registrados em `aria_contact_consent` e confirmados no idioma do país; os disparos proativos respeitam o opt-out. A Aria também honra pedidos conversacionais via tool `set_outbound_consent`.

## Canal de email (Gmail)

A Aria também atende a caixa **support@theworldkeys.com** com o mesmo motor do WhatsApp: mesmos fluxos, mesmas tools de banco, mesmo perfil acumulativo (cliente que fala nos dois canais é reconhecido como a mesma pessoa via cadastro). Diferenças por canal ficam numa camada própria do prompt ([systemPrompt.ts](src/systemPrompt.ts) `EMAIL_CHANNEL_OVERLAY`): texto puro de email (sem markup de WhatsApp), saudação/assinatura, identidade pelo remetente e sem as tools `send_*`.

Como funciona ([src/emailChannel.ts](src/emailChannel.ts)): polling da Gmail API a cada `EMAIL_POLL_SECONDS` (60s) sobre `in:inbox is:unread`; cada email vira um turno (texto novo sem o histórico citado + anexos de imagem/PDF como blocos multimodais); a resposta sai pela própria Gmail API **na mesma thread** (`In-Reply-To`/`References` + `threadId`), com cópia em Enviados. Guardas anti-loop: nunca responde auto-replies (`Auto-Submitted`, `Precedence: bulk/list`), remetentes no-reply/daemon nem a própria caixa; só processa emails mais novos que `EMAIL_MAX_AGE_DAYS` (não responde backlog antigo ao ligar). Dedup persistida e handoff humano funcionam igual (chave de conversa `email:<endereço>` no painel).

### Ativação — Modo A: via n8n (recomendado se o n8n já está conectado à caixa)

Dispensa credenciais Google próprias — o n8n (já autenticado no Gmail) faz a ponte nos dois sentidos.

**Envs no Easypanel:** `EMAIL_ENABLED=true` · `EMAIL_ADDRESS=support@theworldkeys.com` · `N8N_EMAIL_SEND_WEBHOOK=<url do fluxo 2>` · `EMAIL_WEBHOOK_SECRET=<string aleatória longa>` → redeploy (log: `[email] canal ativo (modo n8n)`).

**Fluxo 1 — entrada (Gmail → Aria):**
1. **Gmail Trigger**: evento *Message Received*, caixa INBOX, com *download simplificado* desativado se quiser anexos.
2. *(opcional)* **Gmail → Mark as read** na mensagem.
3. **HTTP Request**: `POST https://SEU-DOMINIO/webhook/email`, header `x-aria-secret: <EMAIL_WEBHOOK_SECRET>`, body JSON:
   `{ "from": "{{ $json.from?.value?.[0]?.address || $json.From }}", "fromName": "{{ $json.from?.value?.[0]?.name || '' }}", "subject": "{{ $json.subject || $json.Subject }}", "text": "{{ $json.text || '' }}", "html": "{{ $json.html || '' }}", "messageId": "{{ $json.id }}", "threadId": "{{ $json.threadId }}" }`
   (o parser da Aria é tolerante a variações desses nomes de campo; anexos são opcionais: `attachments: [{mimeType, data(base64), filename}]`).

**Fluxo 2 — saída (Aria → Gmail):**
1. **Webhook** (POST, ex.: path `aria-email-send`; valide o header `x-aria-secret` num nó IF, comparando com o mesmo segredo).
2. **Gmail → Message → Reply**: *Message ID* = `{{ $json.body.gmailMessageId }}` · *Message* = `{{ $json.body.html }}` · *Email Type* = HTML. (Se `gmailMessageId` vier vazio — raro —, um IF cai num **Gmail → Send** com To/Subject/`html`.)
3. A URL de produção desse Webhook é o valor de `N8N_EMAIL_SEND_WEBHOOK`.

A resposta da Aria chega ao n8n com `{ to, subject, text, html, gmailMessageId, threadId, mailbox }` — o *Reply* garante a mesma thread.

### Multi-caixa (support@ + reservation@)

Restaurantes respondem à notificação de reserva enviada por `reservation@` — e a resposta cai **naquela** caixa, não em support@. Para a Aria ler as duas:

1. **Env**: `EMAIL_EXTRA_ADDRESSES=reservation@theworldkeys.com` (vírgula separa se houver mais).
2. **Entrada**: duplique o Fluxo 1 com um **Gmail Trigger da credencial reservation@**, apontando para o MESMO `POST /webhook/email`, e acrescente ao body JSON o campo `"mailbox": "reservation@theworldkeys.com"`. (Ponha o mesmo campo `"mailbox": "support@theworldkeys.com"` no fluxo original — sem ele a Aria tenta deduzir pelo header To, mas o campo explícito é infalível.)
3. **Saída**: no Fluxo 2, adicione um **Switch** sobre `{{ $json.body.mailbox }}` com um ramo por caixa, cada ramo com o nó **Gmail → Reply da credencial daquela caixa**. Isso é obrigatório: o `gmailMessageId` só existe na caixa que recebeu — responder pela credencial errada dá erro e quebra a thread.

Com isso, o restaurante que responde à notificação recebe a orientação da Aria (usar o botão *Respond to Your Pending Requests* para aceitar/recusar/propor novo horário) **na mesma thread, vinda de reservation@** — e o cliente em support@ continua atendido como antes.

### Ativação — Modo B: Gmail API direto (sem n8n)

1. No [Google Cloud Console](https://console.cloud.google.com) (pode ser o mesmo projeto do Maps): **APIs & Services → Library → Gmail API → Enable**.
2. **OAuth consent screen**: tipo *Internal* (Workspace), nome "Aria".
3. **Credentials → Create Credentials → OAuth client ID → Desktop app** → copie `GMAIL_CLIENT_ID` e `GMAIL_CLIENT_SECRET`.
4. Gere o refresh token no [OAuth Playground](https://developers.google.com/oauthplayground): engrenagem → *Use your own OAuth credentials* (cole id/secret) → no passo 1, escopo `https://www.googleapis.com/auth/gmail.modify` → **faça login com a própria caixa reservation@** → passo 2, *Exchange authorization code for tokens* → copie o `refresh_token` para `GMAIL_REFRESH_TOKEN`.
5. No Easypanel: `EMAIL_ENABLED=true`, `EMAIL_ADDRESS=support@theworldkeys.com` + as 3 credenciais → redeploy. Logs devem mostrar `[email] canal ativo (Gmail direto)`.

## Observabilidade de custo

Cada turno do agente registra o consumo de tokens (input/output/cache) em `aria_llm_usage`. O painel expõe `GET /dashboard/api/usage?days=7` com totais, série por dia, por modelo e top conversas — visão direta do custo da operação.

## Watchdog de pendências (opcional)

`PENDING_WATCH_ENABLED=true` liga a varredura que escala automaticamente (`PENDENTE_12H`, uma vez por reserva, sem mensagem ao cliente) reservas paradas em aprovação há `PENDING_WATCH_HOURS`+ horas com `booking_status = PENDING_WATCH_STATUS`. O time age antes de o cliente reclamar. Desligado por padrão — confirme o status correto no seu banco antes de ligar.

## Testes e qualidade

- **Testes unitários** (offline, sem dependências): `npm test` — Node test runner + tsx. Cobrem `trimHistory`, a fila de conversa, `sanitizeReply`, `normalizePhone`, datas, idioma por país e detecção de opt-out.
- **Eval de comportamento** (contra o modelo real): `npm run eval` — roda conversas-golden ([eval/cases.ts](eval/cases.ts)) com as tools mockadas e verifica que a Aria nunca inventa URL, sempre redireciona cancelamento para o site, casa o idioma, escala reembolso, e não usa emoji/markdown. Precisa de `ANTHROPIC_API_KEY` (consome tokens; ideal antes de cada deploy ou mudança de prompt). Falha `hard` retorna exit 1.

## Upgrade — capacidades adicionadas

**Correções e endurecimento:**
- **`open_now` no fuso do restaurante** ([src/tz.ts](src/tz.ts)): "aberto agora" é calculado no fuso inferido do país/cidade do próprio restaurante (DST correto via Intl), não mais num fuso global fixo. Fallback: `TWK_LOCAL_TZ`.
- **Fail-closed em produção**: `NODE_ENV=production` exige `WHATSAPP_APP_SECRET` e SSL do Postgres verificado (ou reconhecimento explícito via `PGSSL_ALLOW_UNVERIFIED=true`). O boot falha em vez de subir aberto.
- **Teto diário de custo** ([src/costGuard.ts](src/costGuard.ts)): `COST_DAILY_TOKEN_BUDGET` limita o gasto do modelo principal por dia (UTC, semeado do banco em restart). Ao atingir, degrada para `COST_FALLBACK_MODEL` — o atendimento nunca para. Estado visível na aba Custo do painel.
- **Emails à prova de restart** (`aria_pending_emails`): cada email aceito é persistido até o turno completar; no boot, pendentes são reenfileirados. Deploy no meio do turno não perde mais email.
- **Tools de leitura em paralelo** ([src/claude.ts](src/claude.ts)): `tool_use` múltiplos do mesmo turno rodam com `Promise.all` (send_* continuam em série para preservar ordem) — corta latência.
- **Pool Postgres**: 10 conexões (`PGPOOL_MAX`).

**Inteligência (opcional, `EMBEDDINGS_ENABLED=true` + `OPENAI_API_KEY`):**
- **Descoberta híbrida** ([src/embeddings.ts](src/embeddings.ts)): `discover_restaurants` funde full-text + busca vetorial (Reciprocal Rank Fusion). "Romântico com vista" acha o restaurante certo mesmo sem essas palavras no texto. Sem pgvector — vetores em tabela comum, similaridade em memória, sync diário incremental por hash.
- **Memória semântica**: resumos de sessão são indexados; no início de cada conversa os mais relevantes para a mensagem atual entram no contexto — a Aria lembra de conversas de meses atrás, em qualquer canal.

**Concierge proativo:**
- **Briefing de véspera** (`BRIEFING_ENABLED` + template): mensagem ~24h antes com restaurante, data e hora; a resposta do cliente abre a janela de 24h e a Aria orienta rota/dress code/observações.
- **Fechamento de loop de escalação**: no painel, "Resolver" uma escalação pode enviar o desfecho ao cliente no WhatsApp — escalação deixou de ser fire-and-forget.
- **Alertas por email** ([src/alerts.ts](src/alerts.ts), `ALERTS_ENABLED` + `ALERT_EMAIL_TO`): escalação URGENTE, health check reprovado, teto de custo e testes falhando alertam a equipe mesmo com o painel fechado (throttle configurável).

**Central de comando (painel):**
- **Multiusuário com auditoria**: `DASHBOARD_USERS=ana:s1,bruno:s2` + `DASHBOARD_ADMINS`; toda ação registra o operador real; RBAC (excluir respostas prontas é admin).
- **Inbox real**: status por conversa (aberta/aguardando cliente/aguardando equipe/resolvida), atribuição, notas internas, tags, filtro "Minhas"; respostas prontas no composer; **composer de email habilitado** (mesma thread via canal de email).
- **Escalações com workflow**: assumir, resolver (com nota + mensagem ao cliente), reabrir, SLA countdown por tag com estouro em vermelho.
- **Busca full-text** em todo o histórico de mensagens (índice GIN) + entrada na paleta Ctrl+K.
- **Aba Catálogo**: qualidade de dados (sem link de reserva, sem horários, sem descrição, sem coordenadas) priorizada por volume de reservas — ataca a causa raiz de escalações PEDIDO_ESPECIAL.
- **Novos gráficos**: heatmap de volume (dia × hora), tendência semanal de CSAT, custo estimado por modelo (preços por família), barra do teto de custo.
- **Export CSV** de reservas, escalações, avaliações e conversas.

## Trocas que podem fazer sentido depois

- **Redis** para sessões/rate-limit/handoff quando passar de 1 réplica. Hoje **não é necessário** — recomendado rodar 1 réplica (estratégia de deploy "recreate", não rolling). A dedup já é à prova de restart/réplica via banco. Migrar só quando o volume justificar.
- **Filas (BullMQ)** se o volume crescer muito.
- **Embeddings/pgvector** sobre `about_text` para descoberta semântica de verdade (stemming, sinônimos, multilíngue). Já existe a base com full-text (`discover_restaurants`); seria uma troca interna do motor.
- **Pacing de capacidade** (disponibilidade leve): tabela opcional de capacidade por restaurante/turno → disponibilidade ≈ capacidade − reservas confirmadas no período. Seguro porque nunca promete mesa, só dá um sinal ("parece tranquilo" vs "está concorrido, confirme na página"). Requer cadastrar a capacidade.
- **Eval suite de comportamento** (golden conversations contra o modelo real), além dos testes unitários offline (`npm test`) e dos smoke tests de infra ([src/tester.ts](src/tester.ts)).
