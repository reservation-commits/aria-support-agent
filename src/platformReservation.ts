/**
 * platformReservation.ts — a ponte entre um e-mail de restaurante e a PLATAFORMA.
 *
 * Quando a casa responde por e-mail em vez de clicar no /r/ ("aceito", "não dá", "só temos 19h ou 22h"),
 * a Aria aplica a decisão pelo MESMO caminho que o botão usa: GET /r/{código} (que embute a reserva) e
 * POST /api/reservations/manage. Nunca escreve em `reservations` diretamente (ADR-004): o site muda o
 * status, avisa o cliente (no reagendamento, com Accept new time / Decline) e propaga a decisão.
 *
 * Contrato descoberto em 2026-09-10 no bundle do /r/ (page-*.js):
 *   POST /api/reservations/manage
 *   { reservationCode, action: "accept"|"decline"|"reschedule", newTime?: "HH:MM",
 *     reservation: {id,status,date,time,people,details}, restaurant, user }
 */

const SITE = process.env.TWK_SITE_URL ?? "https://theworldkeys.com";

export type ManageAction = "accept" | "decline" | "reschedule";

export type PlatformReservation = {
  id: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  people: number;
  status: string;
  details?: string | null;
  restaurant: { name?: string; restaurant_id?: string; email_for_reservations?: string; [k: string]: unknown };
  user: Record<string, unknown>;
};

/** Extrai `initialReservation` do HTML do /r/. O Next serializa o objeto com aspas escapadas. */
export function parseInitialReservation(html: string): PlatformReservation {
  const i = html.indexOf("initialReservation");
  if (i < 0) throw new Error("página /r/ sem initialReservation — código inválido ou página mudou");
  const BS = String.fromCharCode(92);
  const janela = html.slice(i, i + 20000).split(BS + '"').join('"').split(BS + BS).join(BS);
  const j = janela.indexOf("{");
  let depth = 0;
  let k = j;
  for (; k < janela.length; k++) {
    const ch = janela[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        k++;
        break;
      }
    }
  }
  return JSON.parse(janela.slice(j, k)) as PlatformReservation;
}

/** Domínio do remetente tem de bater com o e-mail de reservas da casa no catálogo. */
export function emailDomainMatches(sender: string | null | undefined, catalogEmail: string | null | undefined): boolean {
  const dom = (e: string | null | undefined) =>
    String(e ?? "")
      .trim()
      .toLowerCase()
      .replace(/^.*</, "")
      .replace(/>.*$/, "")
      .replace(/^.*@/, "");
  const a = dom(sender);
  const b = dom(catalogEmail);
  if (!a || !b) return false;
  // Domínios genéricos (gmail etc.) só batem se o endereço inteiro for igual.
  const genericos = /^(gmail|hotmail|outlook|yahoo|icloud|live|msn|aol)\./;
  if (genericos.test(a) || genericos.test(b)) {
    const full = (e: string | null | undefined) => String(e ?? "").trim().toLowerCase().replace(/^.*</, "").replace(/>.*$/, "");
    return full(sender) === full(catalogEmail);
  }
  return a === b;
}

export type ManageGuardError = { ok: false; error: string };

/** Validações antes de tocar a plataforma. Puras, testáveis. */
export function validateManage(
  r: PlatformReservation,
  action: string,
  newTime: string | undefined,
  today: string,
): ManageGuardError | null {
  if (!["accept", "decline", "reschedule"].includes(action)) return { ok: false, error: `ação inválida: ${action}` };
  if (!/^(Pending|In Treatment)$/i.test(r.status ?? "")) {
    return { ok: false, error: `reserva em status "${r.status}" — só Pending/In Treatment podem ser decididas` };
  }
  if (r.date < today) return { ok: false, error: `a data da mesa (${r.date}) já passou — nada a decidir; avise o cliente` };
  if (action === "reschedule" && !/^\d{2}:\d{2}$/.test(newTime ?? "")) {
    return { ok: false, error: "reschedule exige new_time no formato HH:MM" };
  }
  return null;
}

export async function fetchReservation(code: string): Promise<PlatformReservation> {
  const res = await fetch(`${SITE}/r/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`GET /r/${code} → HTTP ${res.status}`);
  return parseInitialReservation(await res.text());
}

export async function manageReservation(p: {
  code: string;
  action: ManageAction;
  newTime?: string;
}): Promise<{ ok: true; status: string | null; message: string | null } | ManageGuardError> {
  const r = await fetchReservation(p.code);
  const guard = validateManage(r, p.action, p.newTime, new Date().toISOString().slice(0, 10));
  if (guard) return guard;
  const body: Record<string, unknown> = {
    reservationCode: p.code,
    action: p.action,
    reservation: { id: r.id, status: r.status, date: r.date, time: r.time, people: r.people, details: r.details },
    restaurant: r.restaurant,
    user: r.user,
  };
  if (p.newTime) body.newTime = p.newTime;
  const res = await fetch(`${SITE}/api/reservations/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as { reservation?: { status?: string }; message?: string; error?: string };
  if (!res.ok) return { ok: false, error: `plataforma respondeu HTTP ${res.status}: ${j.error ?? j.message ?? ""}` };
  return { ok: true, status: j.reservation?.status ?? null, message: j.message ?? null };
}
