/**
 * Conversas-golden para o eval de comportamento da Aria.
 *
 * Cada caso roda contra o MODELO REAL (system prompt + tools), mas com as tools
 * MOCKADAS (retornos canônicos), e verifica o comportamento do agente:
 * nunca inventa URL, sempre redireciona cancelamento, casa idioma, escala
 * quando deve, não usa emoji nem markdown padrão, etc.
 *
 * As asserções são tolerantes a variação de redação (estruturais), não exigem
 * texto exato. `hard` derruba o eval; `soft` só alerta.
 */

export type ToolMock = unknown | ((input: Record<string, unknown>) => unknown);
export type ToolCall = { name: string; input: Record<string, unknown> };
export type Assert = {
  sev: "hard" | "soft";
  desc: string;
  check: (reply: string, calls: ToolCall[]) => boolean;
};
export type Case = {
  name: string;
  turns: string[];
  mocks?: Record<string, ToolMock>;
  asserts: Assert[];
};

// ── Helpers de asserção ───────────────────────────────────────────────────────
const noEmoji = (r: string) => !/\p{Extended_Pictographic}/u.test(r);
const noMarkdownBold = (r: string) => !r.includes("**");
const called = (calls: ToolCall[], name: string) => calls.some((c) => c.name === name);
const includes = (r: string, s: string) => r.toLowerCase().includes(s.toLowerCase());
const hasExternalBooking = (r: string) =>
  /(opentable|thefork|the-fork|resy|tripadvisor|booking\.com|yelp|google\.[a-z.]+\/[^ ]*reserv)/i.test(r);
const looksEnglish = (r: string) =>
  /\b(the|your|you|we|reservation|restaurant|recommend|table|hello|hi|would)\b/i.test(r) &&
  !/\b(você|reserva|obrigad|recomend|olá|endereço)\b/i.test(r);

const BASE: Assert[] = [
  { sev: "hard", desc: "sem emoji", check: (r) => noEmoji(r) },
  { sev: "hard", desc: "sem markdown ** (usa markup do WhatsApp)", check: (r) => noMarkdownBold(r) },
];

export const cases: Case[] = [
  {
    name: "Cancelamento → redireciona para o site (não cancela)",
    turns: ["Quero cancelar minha reserva TWK-AB12CD34"],
    mocks: {
      find_reservation_by_code: [
        { reservation_code: "TWK-AB12CD34", restaurant_name: "Le Bernardin", city: "Nova York",
          booking_date: "2026-07-01", reservation_time: "20:00", people: 2, booking_status: "accept" },
      ],
    },
    asserts: [
      ...BASE,
      { sev: "hard", desc: "redireciona para theworldkeys.com/users/reservations",
        check: (r) => /theworldkeys\.com\/users\/reservations/i.test(r) },
      { sev: "hard", desc: "não chama nenhuma tool de cancelamento",
        check: (_r, c) => !c.some((x) => /cancel/i.test(x.name)) },
    ],
  },
  {
    name: "Localização → usa a tool e devolve o maps_link",
    turns: ["Onde fica o Le Bernardin?"],
    mocks: {
      get_restaurant_location: {
        name: "Le Bernardin", address: "155 W 51st St, New York",
        city: "New York", maps_link: "https://www.google.com/maps/search/?api=1&query=Le+Bernardin",
        address_is_precise: true,
      },
    },
    asserts: [
      ...BASE,
      { sev: "hard", desc: "chama get_restaurant_location", check: (_r, c) => called(c, "get_restaurant_location") },
      { sev: "hard", desc: "inclui o link do Google Maps", check: (r) => includes(r, "google.com/maps") },
    ],
  },
  {
    name: "Reembolso → escala para humano com próximo passo",
    turns: ["Fui cobrado indevidamente e quero reembolso agora!"],
    mocks: { escalate_to_human: { escalated: true, tag: "URGENTE" } },
    asserts: [
      ...BASE,
      { sev: "hard", desc: "chama escalate_to_human", check: (_r, c) => called(c, "escalate_to_human") },
      { sev: "soft", desc: "comunica próximo passo/prazo",
        check: (r) => /(minuto|hora|equipe|retorn|prazo|contato)/i.test(r) },
    ],
  },
  {
    name: "Nova reserva → entrega a URL exata, nunca manda buscar pelo nome",
    turns: ["Vou a Milão e quero reservar no Contraste para surpreender minha esposa"],
    mocks: {
      get_booking_link_by_name: [
        { restaurant_id: "r1", name: "Contraste", city: "Milano", country: "Itália",
          slug: "contraste-milano", url_page_twk: "https://theworldkeys.com/hospitality/contraste-milano/" },
      ],
      discover_restaurants: [
        { restaurant_id: "r1", name: "Contraste", city: "Milano", country: "Itália",
          slug: "contraste-milano", url_page_twk: "https://theworldkeys.com/hospitality/contraste-milano/" },
      ],
      search_restaurants: [
        { restaurant_id: "r1", name: "Contraste", city: "Milano", country: "Itália",
          slug: "contraste-milano", url_page_twk: "https://theworldkeys.com/hospitality/contraste-milano/" },
      ],
      get_restaurant_booking_link: {
        restaurant_id: "r1", restaurant_name: "Contraste", city: "Milano",
        booking_url: "https://theworldkeys.com/hospitality/contraste-milano/",
      },
      send_booking_button: {
        sent: true, restaurant_name: "Contraste",
        booking_url: "https://theworldkeys.com/hospitality/contraste-milano/",
      },
    },
    asserts: [
      ...BASE,
      { sev: "hard", desc: "entrega o link de reserva (URL exata em texto OU botão nativo send_booking_button)",
        check: (r, c) =>
          includes(r, "theworldkeys.com/hospitality/contraste-milano/") ||
          c.some((x) => x.name === "send_booking_button" && x.input.restaurant_id === "r1") },
      { sev: "hard", desc: "NUNCA manda o cliente buscar/procurar pelo nome na plataforma",
        check: (r) => !/(busqu|procur|pesquis|localiz[ae]).{0,40}(plataforma|site|theworldkeys|nome|restaurante)/i.test(r) },
      { sev: "hard", desc: "não cita plataforma de reserva externa", check: (r) => !hasExternalBooking(r) },
    ],
  },
  {
    name: "Idioma → responde em inglês quando o cliente escreve em inglês",
    turns: ["Hi! Could you recommend a nice romantic restaurant in Lisbon?"],
    mocks: {
      discover_restaurants: [{ restaurant_id: "r9", name: "Belcanto", city: "Lisbon", country: "Portugal", slug: "belcanto" }],
      search_restaurants: [{ restaurant_id: "r9", name: "Belcanto", city: "Lisbon", country: "Portugal", slug: "belcanto" }],
      send_restaurant_options: { sent: true, options: [{ restaurant_id: "r9", name: "Belcanto" }] },
    },
    asserts: [
      ...BASE,
      { sev: "soft", desc: "responde em inglês", check: (r) => looksEnglish(r) },
      { sev: "hard", desc: "não cita plataforma externa", check: (r) => !hasExternalBooking(r) },
    ],
  },
  {
    name: "Início de conversa → carrega contexto do cliente",
    turns: ["Boa noite"],
    mocks: { get_customer_profile: { empty: true }, find_reservations_by_phone: [] },
    asserts: [
      ...BASE,
      { sev: "soft", desc: "consulta perfil ou histórico do cliente",
        check: (_r, c) => called(c, "get_customer_profile") || called(c, "find_reservations_by_phone") },
    ],
  },
];
