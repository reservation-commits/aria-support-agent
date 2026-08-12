/**
 * tz.ts — fuso horário POR RESTAURANTE.
 *
 * O "aberto agora" era calculado num fuso global fixo (TWK_LOCAL_TZ), o que
 * errava para qualquer restaurante fora dele (um bistrô em Paris às 20h locais
 * aparecia "fechado" no fuso de São Paulo). Aqui o fuso é inferido do
 * país/cidade do próprio restaurante — sem tocar no schema do catálogo — e o
 * open_now é computado em JS com Intl (DST correto, sem aproximação por
 * longitude). Sem match no mapa, cai no fuso configurado (comportamento
 * anterior), nunca em erro.
 */

// SEM import de config: este módulo roda nos testes offline (que não têm as
// envs obrigatórias). O fallback de fuso lê a env diretamente.
const FALLBACK_TZ = process.env.TWK_LOCAL_TZ ?? "America/Sao_Paulo";

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

// País normalizado (PT/EN/local) → IANA tz. Países com múltiplos fusos têm
// desambiguação por cidade em CITY_TZ; o valor aqui é o fuso do mercado
// principal do país.
const COUNTRY_TZ: Record<string, string> = {
  brazil: "America/Sao_Paulo", brasil: "America/Sao_Paulo",
  france: "Europe/Paris", franca: "Europe/Paris",
  portugal: "Europe/Lisbon",
  italy: "Europe/Rome", italia: "Europe/Rome",
  spain: "Europe/Madrid", espanha: "Europe/Madrid", espana: "Europe/Madrid",
  "united kingdom": "Europe/London", uk: "Europe/London", england: "Europe/London", "reino unido": "Europe/London",
  germany: "Europe/Berlin", alemanha: "Europe/Berlin", deutschland: "Europe/Berlin",
  switzerland: "Europe/Zurich", suica: "Europe/Zurich", suisse: "Europe/Zurich",
  netherlands: "Europe/Amsterdam", holanda: "Europe/Amsterdam",
  belgium: "Europe/Brussels", belgica: "Europe/Brussels",
  austria: "Europe/Vienna",
  greece: "Europe/Athens", grecia: "Europe/Athens",
  ireland: "Europe/Dublin", irlanda: "Europe/Dublin",
  denmark: "Europe/Copenhagen", dinamarca: "Europe/Copenhagen",
  sweden: "Europe/Stockholm", suecia: "Europe/Stockholm",
  norway: "Europe/Oslo", noruega: "Europe/Oslo",
  finland: "Europe/Helsinki", finlandia: "Europe/Helsinki",
  poland: "Europe/Warsaw", polonia: "Europe/Warsaw",
  "czech republic": "Europe/Prague", czechia: "Europe/Prague",
  monaco: "Europe/Monaco",
  turkey: "Europe/Istanbul", turquia: "Europe/Istanbul",
  morocco: "Africa/Casablanca", marrocos: "Africa/Casablanca",
  "south africa": "Africa/Johannesburg", "africa do sul": "Africa/Johannesburg",
  "united states": "America/New_York", usa: "America/New_York", "estados unidos": "America/New_York", eua: "America/New_York",
  canada: "America/Toronto",
  mexico: "America/Mexico_City",
  argentina: "America/Argentina/Buenos_Aires",
  chile: "America/Santiago",
  peru: "America/Lima",
  colombia: "America/Bogota",
  uruguay: "America/Montevideo", uruguai: "America/Montevideo",
  japan: "Asia/Tokyo", japao: "Asia/Tokyo",
  china: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  singapore: "Asia/Singapore", singapura: "Asia/Singapore",
  thailand: "Asia/Bangkok", tailandia: "Asia/Bangkok",
  india: "Asia/Kolkata",
  "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai", "emirados arabes unidos": "Asia/Dubai",
  australia: "Australia/Sydney",
};

// Cidades que desambiguam países com vários fusos.
const CITY_TZ: Record<string, string> = {
  "new york": "America/New_York", miami: "America/New_York", boston: "America/New_York", washington: "America/New_York",
  chicago: "America/Chicago", houston: "America/Chicago", dallas: "America/Chicago", austin: "America/Chicago",
  denver: "America/Denver",
  "los angeles": "America/Los_Angeles", "san francisco": "America/Los_Angeles", "las vegas": "America/Los_Angeles", seattle: "America/Los_Angeles",
  vancouver: "America/Vancouver",
  toronto: "America/Toronto", montreal: "America/Toronto",
  perth: "Australia/Perth",
  sydney: "Australia/Sydney", melbourne: "Australia/Sydney",
  manaus: "America/Manaus",
  "mexico city": "America/Mexico_City", cancun: "America/Cancun",
};

/** IANA tz do restaurante a partir de país/cidade; null se não souber. */
export function tzForRestaurant(country?: string | null, city?: string | null): string | null {
  const c = norm(city);
  if (c && CITY_TZ[c]) return CITY_TZ[c];
  const p = norm(country);
  if (p && COUNTRY_TZ[p]) return COUNTRY_TZ[p];
  return null;
}

const WEEKDAY_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Momento atual no fuso dado: weekday na convenção do Postgres (0=domingo) e
 * minutos desde meia-noite. Fuso inválido cai no fuso configurado.
 */
export function nowInTz(tz: string, at: Date = new Date()): { weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: FALLBACK_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    weekday: WEEKDAY_NUM[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export type HourRange = { open: string; close: string }; // "HH:MM"

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Aberto agora? Faixas overnight (fecha depois da meia-noite: close <= open)
 * são tratadas: 19:00–02:00 está aberto às 23h e à 1h.
 */
export function isOpenNow(ranges: HourRange[], nowMinutes: number): boolean {
  return ranges.some((r) => {
    const open = toMinutes(r.open);
    const close = toMinutes(r.close);
    if (close > open) return nowMinutes >= open && nowMinutes <= close;
    return nowMinutes >= open || nowMinutes <= close;
  });
}
