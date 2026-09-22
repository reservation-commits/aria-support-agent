import type Anthropic from "@anthropic-ai/sdk";

// Definições (JSON Schema) das tools. Módulo PURO, sem imports de db/config,
// para o eval suite poder importá-las sem subir o banco.
export const tools: Anthropic.Tool[] = [
  {
    name: "find_reservation_by_code",
    description:
      "Buscar uma reserva pelo código (reservation_code). Use SEMPRE que o cliente fornecer qualquer código que pareça uma reserva. Passe o código EXATAMENTE como o cliente digitou — a busca interna tolera variações (com ou sem prefixo TWK-, maiúsculas/minúsculas, espaços). NUNCA invente prefixo nem modifique o código antes de chamar.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Código exatamente como o cliente forneceu (ex: 'RGSRQNJ4', 'TWK-RGSRQNJ4', 'rgsrqnj4'). Não adicione nem remova caracteres.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "find_reservations_by_email",
    description:
      "Listar reservas do cliente pelo email cadastrado. Use quando o cliente fornecer um email e quiser consultar histórico ou reserva sem código.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email do cliente" },
      },
      required: ["email"],
    },
  },
  {
    name: "find_reservations_by_phone",
    description:
      "Listar reservas do cliente pelo telefone cadastrado (formato E.164, ex: +5511999999999). Pode usar o número do WhatsApp do cliente.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Telefone E.164" },
      },
      required: ["phone"],
    },
  },
  {
    name: "get_restaurant_opening_hours",
    description:
      "Buscar os horários de funcionamento de um restaurante. Passe restaurant_id (preferido, é o que a maioria das tools retorna) OU slug. Pelo menos um é obrigatório.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: "ID do restaurante (preferido)" },
        slug: { type: "string", description: "Slug do restaurante (alternativa)" },
      },
    },
  },
  {
    name: "get_restaurant_info",
    description: "Buscar informações públicas de um restaurante pelo restaurant_id.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string" },
      },
      required: ["restaurant_id"],
    },
  },
  {
    name: "get_customer_profile",
    description:
      "Buscar o perfil de preferências acumuladas do cliente pelo número de WhatsApp. Chame SEMPRE no início de cada conversa, antes de fazer qualquer recomendação. O perfil contém alergias, restrições alimentares, cozinhas preferidas, cozinhas que não gosta, faixa de preço preferida, necessidades especiais e notas livres.",
    input_schema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Número de WhatsApp do cliente no formato E.164 (ex: +5511999999999)",
        },
      },
      required: ["phone"],
    },
  },
  {
    name: "update_customer_profile",
    description:
      "Salvar ou atualizar preferências do cliente. Chame silenciosamente SEMPRE que o cliente mencionar qualquer preferência, restrição, alergia, gosto ou necessidade especial — sem interromper o fluxo da conversa. Arrays são ACUMULATIVOS: o banco faz merge automático com o histórico anterior, nunca sobrescreve.",
    input_schema: {
      type: "object",
      properties: {
        phone: {
          type: "string",
          description: "Número de WhatsApp do cliente no formato E.164",
        },
        allergies: {
          type: "array",
          items: { type: "string" },
          description: "Alergias alimentares mencionadas (ex: ['glúten', 'frutos do mar'])",
        },
        dietary_restrictions: {
          type: "array",
          items: { type: "string" },
          description: "Restrições alimentares (ex: ['vegano', 'sem lactose', 'halal'])",
        },
        cuisine_preferences: {
          type: "array",
          items: { type: "string" },
          description: "Cozinhas ou estilos que o cliente gosta (ex: ['japonesa', 'italiana'])",
        },
        cuisine_dislikes: {
          type: "array",
          items: { type: "string" },
          description: "Cozinhas ou ingredientes que o cliente não aprecia (ex: ['muito apimentado'])",
        },
        price_range: {
          type: "string",
          enum: ["budget", "mid", "premium", "luxury"],
          description: "Faixa de preço preferida do cliente",
        },
        special_needs: {
          type: "string",
          description: "Necessidades especiais de acessibilidade, cadeirinha infantil, etc.",
        },
        notes: {
          type: "string",
          description: "Qualquer outra informação relevante sobre o perfil do cliente (acumulativa — cada nota nova é adicionada ao histórico)",
        },
      },
      required: ["phone"],
    },
  },
  {
    name: "search_reservations",
    description:
      "Buscar reservas combinando filtros opcionais (nome, email, telefone, código parcial, restaurante, intervalo de datas, status). Use quando o cliente não forneceu o código exato mas deu pistas como nome do restaurante + data, ou nome próprio + cidade. Pelo menos um filtro é obrigatório. Retorna até 25 resultados.",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nome ou parte do nome do cliente" },
        customer_email: { type: "string" },
        customer_phone: { type: "string", description: "Telefone (qualquer formato — usa LIKE)" },
        reservation_code: { type: "string", description: "Código parcial ou completo" },
        restaurant_name: { type: "string", description: "Nome ou parte do nome do restaurante" },
        date_from: { type: "string", description: "Data inicial YYYY-MM-DD (inclusive)" },
        date_to: { type: "string", description: "Data final YYYY-MM-DD (inclusive)" },
        status: { type: "string", description: "pending | confirmed | cancelled | completed" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "search_restaurants",
    description:
      "Busca ESTRUTURADA de restaurantes por cidade, país, parte do nome ou cozinha exata. Use quando o cliente cita um critério objetivo (ex: 'tem algum restaurante japonês em Paris?', 'o restaurante chama Le Bernardin'). Para pedidos por VIBE/ocasião em linguagem natural, prefira discover_restaurants. Cada resultado traz pedidos_90d, aceitos_90d e confirma_pedidos (true = a casa de fato confirma os pedidos da plataforma; as que confirmam vêm primeiro). Ao oferecer ALTERNATIVA a quem ficou sem mesa, use só casas com confirma_pedidos=true. Se nenhuma tiver, não prometa nada: diga que o cliente pode pedir a mesa pela página e que o restaurante confirma por e-mail. Nenhum destes campos é disponibilidade de mesa.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        country: { type: "string" },
        name_query: { type: "string", description: "Parte do nome do restaurante" },
        cuisine: { type: "string", description: "Tipo de cozinha (busca em descrição)" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "discover_restaurants",
    description:
      "Descoberta por RELEVÂNCIA em linguagem natural, ranqueada sobre a descrição (about_text), nome, cidade e país dos restaurantes da TWK. Use quando o cliente descreve uma VIBE, ocasião ou critério subjetivo em vez de um nome/cozinha exata — ex: 'um lugar romântico com vista', 'algo animado para ir com amigos', 'bom para fechar um negócio', 'jantar tranquilo e intimista'. Passe a descrição do cliente em `query` (pode ser a frase dele). Filtre por cidade/país quando o cliente indicar. Só retorna restaurantes cadastrados na plataforma. Cada resultado traz pedidos_90d, aceitos_90d e confirma_pedidos (true = a casa de fato confirma os pedidos da plataforma). Ao oferecer ALTERNATIVA a quem ficou sem mesa, use só casas com confirma_pedidos=true. Se nenhuma tiver, não prometa nada: diga que o cliente pode pedir a mesa pela página e que o restaurante confirma por e-mail. Nenhum destes campos é disponibilidade de mesa.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Descrição/vibe/ocasião em linguagem natural (ex: 'romântico com vista para o mar')",
        },
        city: { type: "string", description: "Filtro opcional de cidade" },
        country: { type: "string", description: "Filtro opcional de país" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Padrão: 6" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_booking_link_by_name",
    description:
      "Obter o LINK DE RESERVA (url_page_twk) de um restaurante a partir do NOME que o cliente disse. USE ESTA TOOL COMO PRIMEIRA AÇÃO sempre que o cliente quiser reservar e citar o restaurante pelo nome. Busca por nome aproximado e é à prova de diferença de idioma na cidade (cliente diz 'Milão', banco tem 'Milano') — não trave pela cidade. Retorna os restaurantes que casam, cada um com seu url_page_twk; entregue o link do que corresponde (se vier mais de um, confirme qual com o cliente). Só considere 'não existe' se esta tool retornar vazio.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome do restaurante como o cliente disse (ex: 'Contraste')" },
        city: { type: "string", description: "Cidade, se o cliente mencionou (opcional; a busca tolera idioma diferente)" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_restaurant_booking_link",
    description:
      "Obter o link OFICIAL da página do restaurante na plataforma TWK (coluna url_page_twk do banco). Use sempre que o cliente quiser reservar e você ainda não tiver o url_page_twk em mãos (os resultados de search_restaurants/discover_restaurants já trazem esse campo). O link retornado é o valor EXATO do banco; nunca o modifique nem monte a partir do slug. Se não houver link cadastrado, NÃO invente e NUNCA peça para o cliente buscar pelo nome — escale para a equipe enviar o link.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string" },
      },
      required: ["restaurant_id"],
    },
  },
  {
    name: "get_restaurant_location",
    description:
      "Obter endereço completo do restaurante + link do Google Maps clicável. SEMPRE retorna um maps_link válido — se o banco não tiver o endereço, busca na internet (Google) automaticamente; e mesmo sem nada, gera um link de busca pelo nome. Esta tool NUNCA falha em entregar um link. Use SEMPRE que o cliente perguntar 'onde fica', 'qual o endereço', 'como chego lá'. Passe restaurant_id se souber; se não souber o ID, passe restaurant_name e city.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: "ID do restaurante (preferido, se conhecido)" },
        restaurant_name: {
          type: "string",
          description: "Nome do restaurante — use quando não tiver o restaurant_id",
        },
        city: { type: "string", description: "Cidade do restaurante" },
        country: { type: "string", description: "País do restaurante (opcional, melhora a precisão)" },
      },
    },
  },
  {
    name: "find_restaurants_near",
    description:
      "Sugerir restaurantes da plataforma TWK PRÓXIMOS ao cliente, ordenados por distância, JÁ ANOTADOS com os horários de hoje (today_hours) e se estão ABERTOS AGORA (open_now). REQUER que o cliente tenha compartilhado a localização (você verá '[Sistema: cliente compartilhou localização — latitude: X, longitude: Y]'). Para o pedido 'o que está aberto agora perto de mim', use only_open=true. Cada resultado traz url_page_twk para reserva. NUNCA retorna restaurantes fora da plataforma.",
    input_schema: {
      type: "object",
      properties: {
        client_latitude: { type: "number" },
        client_longitude: { type: "number" },
        city: { type: "string", description: "Filtro opcional. Ex: 'Paris'" },
        cuisine: {
          type: "string",
          description: "Filtro opcional. Ex: 'japonês', 'francesa', 'vegano'",
        },
        max_distance_km: {
          type: "number",
          description: "Filtro opcional. Descarta resultados além desse raio.",
        },
        only_open: {
          type: "boolean",
          description: "Se true, retorna só os que estão ABERTOS AGORA (open_now). Use para 'aberto agora perto de mim'.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Padrão: 5" },
      },
      required: ["client_latitude", "client_longitude"],
    },
  },
  {
    name: "compute_route_to_restaurant",
    description:
      "Calcular distância e tempo de viagem do cliente até o restaurante — e, para o pedido 'a que horas devo sair?' / 'chego a tempo?', a HORA DE SAIR. REQUER que o cliente tenha compartilhado a localização (você verá '[Sistema: cliente compartilhou localização — latitude: X, longitude: Y]'). Se informar arrival_time (o horário da reserva, HH:MM), a tool retorna suggested_departure (= chegada − viagem − margem). Se ainda não compartilhou a localização, peça gentilmente antes.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string" },
        client_latitude: { type: "number" },
        client_longitude: { type: "number" },
        mode: {
          type: "string",
          enum: ["driving", "walking", "bicycling", "transit"],
          description: "Padrão: driving",
        },
        arrival_time: {
          type: "string",
          description: "Horário de chegada/reserva no formato HH:MM (ex: '20:00'). Se informado, retorna a hora sugerida de sair.",
        },
        buffer_minutes: {
          type: "integer",
          description: "Margem de segurança antes da reserva (padrão 10 min).",
        },
      },
      required: ["restaurant_id", "client_latitude", "client_longitude"],
    },
  },
  {
    name: "find_user",
    description: "Buscar um usuário cadastrado por email ou telefone. Útil antes de criar reserva.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string", description: "Telefone E.164" },
      },
    },
  },
  {
    name: "run_sql_read",
    description:
      "PODER DE BUSCA LIVRE NO BANCO (somente leitura). Use quando as tools estruturadas não resolverem — por exemplo, para localizar um restaurante e seu url_page_twk por nome aproximado, conferir uma coluna, ou investigar por que algo não apareceu. Regras: APENAS um SELECT (ou WITH...SELECT); roda em transação somente-leitura; resultado limitado. Tabelas úteis: public.db_restaurants (restaurant_id, name, city, country, slug, url_page_twk, address, latitude, longitude, about_text, price_range_id, published), public.reservations (reservation_code, booking_date, reservation_time, people, booking_status, restaurant_id), public.opening_hours (restaurant_id, weekday, open_time, close_time). É PROIBIDO e bloqueado consultar dados pessoais de clientes (tabela de usuários, perfis, mensagens) — para isso use as tools próprias, escopadas ao telefone do cliente. Exemplo: SELECT name, city, url_page_twk, slug FROM public.db_restaurants WHERE name ILIKE '%contraste%' AND published = true.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Uma única instrução SELECT (sem ';'). Sempre filtre por published = true em db_restaurants." },
      },
      required: ["sql"],
    },
  },
  {
    name: "set_outbound_consent",
    description:
      "Registrar a preferência do cliente sobre receber mensagens PROATIVAS (lembrete de reserva e convite de avaliação). Use quando o cliente pedir, durante a conversa, para parar de receber essas mensagens (opt_out=true) ou para voltar a recebê-las (opt_out=false). Não afeta o atendimento normal — o cliente continua podendo falar com você. Sempre confirme a mudança com gentileza. O telefone é resolvido pelo servidor.",
    input_schema: {
      type: "object",
      properties: {
        opt_out: { type: "boolean", description: "true = parar de receber proativas; false = voltar a receber" },
      },
      required: ["opt_out"],
    },
  },
  {
    name: "save_experience_review",
    description:
      "Salvar a avaliação da experiência do cliente após a visita (pós-experiência). Chame ao final do fluxo de avaliação, depois de coletar o que o cliente quis dar. Todos os campos são opcionais — salve o que tiver. As tags devem ser dos conjuntos canônicos (veja o fluxo de avaliação no prompt). O telefone do cliente é resolvido pelo servidor.",
    input_schema: {
      type: "object",
      properties: {
        reservation_code: { type: "string", description: "Código da reserva avaliada, se conhecido" },
        restaurant_id: { type: "string", description: "ID do restaurante avaliado, se conhecido" },
        platform_rating: { type: "integer", minimum: 1, maximum: 5, description: "Nota de 1 a 5 para a experiência de usar a plataforma The World Keys" },
        establishment_rating: { type: "integer", minimum: 1, maximum: 5, description: "Nota de 1 a 5 para a experiência no estabelecimento" },
        establishment_tags: {
          type: "array", items: { type: "string" },
          description: "Aspectos destacados sobre o estabelecimento (slugs canônicos: food, service, ambiance, value, waiting, cleanliness, presentation)",
        },
        platform_tags: {
          type: "array", items: { type: "string" },
          description: "Aspectos destacados sobre a plataforma (slugs canônicos: booking_ease, communication, support, reliability)",
        },
        feedback: { type: "string", description: "Sugestão de melhoria / comentário livre do cliente" },
        language: { type: "string", description: "Idioma da conversa (ex: pt, en, es, fr)" },
      },
    },
  },
  {
    name: "send_restaurant_options",
    description:
      "Enviar ao cliente uma LISTA INTERATIVA nativa do WhatsApp com restaurantes (até 10). O cliente toca em 'Ver opções', escolhe uma linha e a seleção volta para você como '[Sistema: seleção id=restaurant:<restaurant_id>]'. USE ao apresentar 3 ou mais opções vindas de search_restaurants/discover_restaurants/find_restaurants_near — é mais elegante que texto corrido. O servidor busca nome e cidade REAIS do banco pelos restaurant_ids (você só passa os IDs que viu nas tools de busca). A mensagem É ENVIADA NA HORA: sua resposta final deve ser no máximo uma linha complementar, sem repetir as opções. Sem emojis no body.",
    input_schema: {
      type: "object",
      properties: {
        body: {
          type: "string",
          description:
            "Texto de apresentação acima da lista (máx ~1000 caracteres), elegante e curto. Ex: 'Encontrei estas joias da nossa curadoria em Paris para a sua noite:'",
        },
        restaurant_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "IDs dos restaurantes, na ordem de apresentação — SOMENTE ids retornados por tools nesta conversa",
        },
        button_label: {
          type: "string",
          description: "Rótulo do botão que abre a lista (máx 20 chars). Padrão: 'Ver opções'",
        },
        section_title: {
          type: "string",
          description: "Título da seção da lista (máx 24 chars). Ex: 'Nossa curadoria'",
        },
      },
      required: ["body", "restaurant_ids"],
    },
  },
  {
    name: "send_quick_replies",
    description:
      "Enviar ao cliente uma mensagem com até 3 BOTÕES de resposta rápida nativos do WhatsApp. USE para confirmações simples e binárias/ternárias — ex: 'Quer que eu envie o link de reserva?' com botões 'Sim, envie' / 'Ver outras opções'. NÃO use para perguntas abertas (data, cidade, número de pessoas). A mensagem É ENVIADA NA HORA: resposta final vazia ou uma linha no máximo. Títulos de botão têm no máximo 20 caracteres. Sem emojis.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Texto da pergunta/mensagem (máx ~1000 caracteres)" },
        options: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Id opcional da opção (volta para você quando o cliente toca). Padrão: o próprio rótulo" },
              label: { type: "string", description: "Rótulo do botão (máx 20 caracteres)" },
            },
            required: ["label"],
          },
          description: "Botões, na ordem de exibição",
        },
      },
      required: ["body", "options"],
    },
  },
  {
    name: "send_booking_button",
    description:
      "Enviar ao cliente a mensagem de reserva com um BOTÃO nativo 'Reservar' que abre a página oficial do restaurante na TWK. O SERVIDOR busca o url_page_twk exato do banco pelo restaurant_id — o link é sempre o oficial, você não passa URL. PREFIRA esta tool a colar a URL crua quando o cliente decidir reservar um restaurante específico. Se o restaurante não tiver link cadastrado, a tool retorna erro — siga a regra existente (escale PEDIDO_ESPECIAL). A mensagem É ENVIADA NA HORA: resposta final vazia ou uma linha no máximo. Sem emojis no body.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: "ID do restaurante (visto em uma tool de busca nesta conversa)" },
        body: {
          type: "string",
          description:
            "Texto de apresentação acima do botão — destaque elegante do restaurante e instrução curta (escolher data, horário e pessoas na página; confirmação chega por email). Máx ~1000 caracteres.",
        },
      },
      required: ["restaurant_id", "body"],
    },
  },
  {
    name: "send_location_pin",
    description:
      "Enviar ao cliente o PIN DE LOCALIZAÇÃO nativo do WhatsApp com as coordenadas do restaurante — abre direto no mapa do aparelho, sem link. USE como complemento quando o cliente pergunta 'onde fica' / 'como chego' (junto com a resposta textual de get_restaurant_location). Requer que o restaurante tenha coordenadas ou endereço resolvível; se a tool falhar, siga apenas com o maps_link do get_restaurant_location. A mensagem É ENVIADA NA HORA.",
    input_schema: {
      type: "object",
      properties: {
        restaurant_id: { type: "string", description: "ID do restaurante" },
      },
      required: ["restaurant_id"],
    },
  },
  {
    name: "log_attendance_event",
    description:
      "Registrar uma nota interna do atendimento (auditoria). Use para registrar ações relevantes: escalações, mudanças, problemas reportados.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Descrição da ação realizada no atendimento" },
        restaurant_id: { type: "string" },
        reservation_id: { type: "string" },
      },
      required: ["description"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Escalar para a equipe humana com tag e SLA. SEMPRE comunique ao cliente o próximo passo e o prazo antes de chamar (ou na mesma mensagem). Tags válidas: URGENTE, PENDENTE_12H, MODIFICACAO, PEDIDO_ESPECIAL, ACESSIBILIDADE, PARCEIRO_B2B, REMOCAO_LISTAGEM (estabelecimento pede para sair / não consentiu / proteção de dados — FLUXO 7), CORRECAO_LISTAGEM (estabelecimento pede correção de dados da página).",
    input_schema: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          enum: [
            "URGENTE",
            "PENDENTE_12H",
            "MODIFICACAO",
            "PEDIDO_ESPECIAL",
            "ACESSIBILIDADE",
            "PARCEIRO_B2B",
            "REMOCAO_LISTAGEM",
            "CORRECAO_LISTAGEM",
          ],
        },
        summary: { type: "string", description: "Resumo curto do caso para a equipe humana" },
        customer_phone: { type: "string", description: "WhatsApp do cliente (E.164)" },
        reservation_code: { type: "string" },
      },
      required: ["tag", "summary", "customer_phone"],
    },
  },
  {
    name: "manage_reservation",
    description:
      "SÓ NO CANAL DE E-MAIL e SÓ quando quem escreve é o RESTAURANTE respondendo a um pedido de mesa (thread 'Great news!…'/'Pending Request…'). Aplica a decisão da casa pela plataforma, exatamente como o botão do /r/: accept (aceita), decline (recusa) ou reschedule + new_time HH:MM (propõe outro horário — o cliente recebe e-mail com Aceitar/Recusar e decide; o status só muda quando ele clicar). O servidor confere que o remetente é o e-mail da casa no catálogo; se não for, recusa e você orienta a casa a usar o link do /r/. Depois de chamar, responda ao restaurante: agradeça, diga que o cliente foi avisado e inclua o convite à conta gratuita (2 minutos).",
    input_schema: {
      type: "object",
      properties: {
        reservation_code: { type: "string", description: "Código da reserva citado na thread (ex.: VK6BEDL6)" },
        action: { type: "string", enum: ["accept", "decline", "reschedule"] },
        new_time: { type: "string", description: "Só para reschedule: HH:MM (24h). Se a casa deu uma janela ou dois turnos, escolha o mais próximo do horário pedido pelo cliente." },
        reason: { type: "string", description: "Trecho literal do e-mail da casa que justifica a ação" },
      },
      required: ["reservation_code", "action", "reason"],
    },
  },
];
