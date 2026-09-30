/**
 * venueIdentity.ts — descobre se um número de WhatsApp é de um estabelecimento marcado (banco).
 */

import { pool } from "./db.js";
import { montarAvisoEstabelecimento, type CasaIdentificada, type PedidoPendente } from "./venueIdentityRegra.js";

export async function identificarEstabelecimento(phoneE164: string): Promise<CasaIdentificada | null> {
  try {
    const { rows } = await pool.query<{ restaurant_id: string | null; nome: string | null; cidade: string | null }>(
      `SELECT c.restaurant_id, d.name AS nome, d.city AS cidade
         FROM public.aria_contact_consent c
         LEFT JOIN public.db_restaurants d ON d.restaurant_id = c.restaurant_id
        WHERE c.phone = $1 AND c.tipo = 'estabelecimento'
        LIMIT 1`,
      [phoneE164],
    );
    const r = rows[0];
    if (!r || !r.restaurant_id) return null;
    return { restaurantId: r.restaurant_id, nome: r.nome ?? "estabelecimento", cidade: r.cidade };
  } catch (err) {
    console.warn("[venue] identificação falhou:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function pendentesDaCasa(restaurantId: string): Promise<PedidoPendente[]> {
  try {
    const { rows } = await pool.query<PedidoPendente>(
      `SELECT reservation_code, booking_date, reservation_time, people
         FROM public.reservations
        WHERE restaurant_id = $1 AND expired_at IS NULL
          AND lower(btrim(booking_status)) IN ('pending', 'in treatment')
          AND booking_date >= CURRENT_DATE
        ORDER BY booking_date ASC, reservation_time ASC NULLS LAST
        LIMIT 5`,
      [restaurantId],
    );
    return rows;
  } catch {
    return [];
  }
}

/** Texto do aviso de sistema para o turno, ou null se o número não é de estabelecimento. */
export async function avisoSeEstabelecimento(phoneE164: string): Promise<string | null> {
  const casa = await identificarEstabelecimento(phoneE164);
  if (!casa) return null;
  const pendentes = await pendentesDaCasa(casa.restaurantId);
  return montarAvisoEstabelecimento(casa, pendentes);
}
