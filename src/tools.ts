import type Anthropic from "@anthropic-ai/sdk";
import {
  cancelReservation,
  findBookingLinkByName,
  findReservationByCode,
  findReservationsByEmail,
  findReservationsByPhone,
  findRestaurantsNear,
  findUser,
  getRestaurantsByIds,
  getCustomerProfile,
  getRestaurantInfo,
  getRestaurantOpeningHours,
  getRestaurantWithLocation,
  logAttendanceEvent,
  logEscalation,
  runReadOnlyQuery,
  setOutboundConsent,
  saveExperienceReview,
  searchReservations,
  searchRestaurants,
  upsertCustomerProfile,
} from "./db.js";
import { logToolCall, logMessage } from "./dashboard/logger.js";
import { publish } from "./dashboard/events.js";
import {
  sendCtaUrl,
  sendInteractiveButtons,
  sendInteractiveList,
  sendLocation,
} from "./whatsapp.js";
import { sanitizeReply } from "./format.js";
import {
  buildMapsLink,
  computeRoute,
  geocodeAddress,
  lookupAddress,
  type TravelMode,
} from "./maps.js";
import { contactKey, resolveProfileKey, type AgentIdentity } from "./identity.js";
import { hybridDiscover } from "./embeddings.js";

export { tools } from "./toolSchemas.js";

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export async function runTool(
  name: string,
  input: Record<string, unknown>,
  identity: AgentIdentity | null = null,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const result = await _execTool(name, input, identity);
  const latencyMs = Date.now() - startedAt;

  // Persist for dashboard analytics + emit live event. Best-effort, never throws.
  void logToolCall({
    chatId: contactKey(identity),
    toolName: name,
    input,
    outputSummary: result.ok
      ? safeStringify(result.data).slice(0, 1000)
      : `ERROR: ${result.error}`,
    success: result.ok,
    errorMessage: result.ok ? null : result.error,
    latencyMs,
  });

  // Special: surface escalations to live event stream with full context.
  if (name === "escalate_to_human" && result.ok) {
    publish({
      kind: "escalation",
      // A identidade do servidor é a fonte de verdade; o telefone digitado pelo
      // modelo é só fallback (ex.: escalação B2B citando um terceiro).
      chat: contactKey(identity) ?? (input.customer_phone as string | undefined) ?? null,
      tag: String(input.tag ?? "UNKNOWN"),
      summary: String(input.summary ?? ""),
      at: new Date().toISOString(),
    });
  }

  return result;
}

/**
 * Calcula a hora de SAIR a partir do horário de chegada (HH:MM), do tempo de
 * viagem (segundos) e de uma margem de segurança (min). Aritmética de relógio
 * pura — sem fuso (chegada e saída estão no mesmo relógio local).
 */
function computeDeparture(
  arrivalHHMM: string,
  durationSeconds: number,
  bufferMin: number,
): { suggested_departure: string; crossedMidnight: boolean } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(arrivalHHMM.trim());
  if (!m) return null;
  const arrivalMin = Number(m[1]) * 60 + Number(m[2]);
  const depMin = arrivalMin - Math.ceil(durationSeconds / 60) - Math.max(0, bufferMin);
  const norm = ((depMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(norm / 60)).padStart(2, "0");
  const mm = String(norm % 60).padStart(2, "0");
  return { suggested_departure: `${hh}:${mm}`, crossedMidnight: depMin < 0 };
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return "[unserializable]";
  }
}

async function _execTool(
  name: string,
  input: Record<string, unknown>,
  identity: AgentIdentity | null,
): Promise<ToolResult> {
  // A identidade do cliente é a fonte de verdade do SERVIDOR (telefone do
  // WhatsApp ou remetente do email), nunca o que o modelo digitou. Isso impede
  // lookup do perfil/reservas de OUTRO cliente e elimina falha silenciosa.
  const trustedPhone = identity?.phone ?? null;
  const trustedEmail = identity?.email ?? null;
  // Chave do perfil acumulativo: telefone → telefone do cadastro (por email) →
  // chave sintética "email:<addr>". Cliente multicanal compartilha o perfil.
  const profileKey = identity ? await resolveProfileKey(identity) : null;
  // Destino WhatsApp para as tools send_* (a Graph API espera sem o "+").
  const waTo =
    identity?.channel === "whatsapp" && identity.phone
      ? identity.phone.replace(/^\+/, "")
      : null;

  try {
    switch (name) {
      case "find_reservation_by_code": {
        const rows = await findReservationByCode(String(input.code));
        return { ok: true, data: rows };
      }
      case "find_reservations_by_email": {
        const rows = await findReservationsByEmail(String(input.email));
        return { ok: true, data: rows };
      }
      case "find_reservations_by_phone": {
        const rows = await findReservationsByPhone(trustedPhone ?? String(input.phone));
        return { ok: true, data: rows };
      }
      case "get_restaurant_opening_hours": {
        const rows = await getRestaurantOpeningHours({
          restaurantId: input.restaurant_id as string | undefined,
          slug: input.slug as string | undefined,
        });
        return { ok: true, data: rows };
      }
      case "get_restaurant_info": {
        const rows = await getRestaurantInfo(String(input.restaurant_id));
        return { ok: true, data: rows };
      }
      case "get_customer_profile": {
        const profile = await getCustomerProfile(profileKey ?? String(input.phone));
        return { ok: true, data: profile ?? { empty: true } };
      }
      case "update_customer_profile": {
        const updated = await upsertCustomerProfile({
          customerPhone: profileKey ?? String(input.phone),
          allergies: input.allergies as string[] | undefined,
          dietaryRestrictions: input.dietary_restrictions as string[] | undefined,
          cuisinePreferences: input.cuisine_preferences as string[] | undefined,
          cuisineDislikes: input.cuisine_dislikes as string[] | undefined,
          priceRange: input.price_range as string | undefined,
          specialNeeds: input.special_needs as string | undefined,
          notes: input.notes as string | undefined,
        });
        return { ok: true, data: updated };
      }
      // cancel_reservation removido intencionalmente:
      // o agente redireciona o cliente para theworldkeys.com/users/reservations.
      // A função cancelReservation em db.ts é mantida para uso interno futuro.
      case "search_reservations": {
        const rows = await searchReservations({
          customerName: input.customer_name as string | undefined,
          customerEmail: input.customer_email as string | undefined,
          customerPhone: input.customer_phone as string | undefined,
          reservationCode: input.reservation_code as string | undefined,
          restaurantName: input.restaurant_name as string | undefined,
          dateFrom: input.date_from as string | undefined,
          dateTo: input.date_to as string | undefined,
          status: input.status as string | undefined,
          limit: input.limit as number | undefined,
        });
        return { ok: true, data: rows };
      }
      case "search_restaurants": {
        const rows = await searchRestaurants({
          city: input.city as string | undefined,
          country: input.country as string | undefined,
          nameQuery: input.name_query as string | undefined,
          cuisine: input.cuisine as string | undefined,
          limit: input.limit as number | undefined,
        });
        return { ok: true, data: rows };
      }
      case "discover_restaurants": {
        // Híbrido: full-text + semântica (embeddings) fundidos por RRF. Com
        // embeddings desligados, hybridDiscover devolve exatamente o full-text.
        const rows = await hybridDiscover({
          query: String(input.query ?? ""),
          city: input.city as string | undefined,
          country: input.country as string | undefined,
          limit: input.limit as number | undefined,
        });
        return { ok: true, data: rows };
      }
      case "find_restaurants_near": {
        const rows = await findRestaurantsNear({
          latitude: Number(input.client_latitude),
          longitude: Number(input.client_longitude),
          city: input.city as string | undefined,
          cuisine: input.cuisine as string | undefined,
          maxDistanceKm: input.max_distance_km as number | undefined,
          onlyOpen: input.only_open === true,
          limit: input.limit as number | undefined,
        });
        // Round distance to 1 decimal for cleaner model output, and trim payload.
        const trimmed = rows.map((r) => ({
          restaurant_id: r.restaurant_id,
          name: r.name,
          city: r.city,
          country: r.country,
          slug: r.slug,
          address: r.address,
          latitude: r.latitude,
          longitude: r.longitude,
          price_range_id: r.price_range_id,
          site_url: r.site_url,
          url_page_twk: r.url_page_twk,
          distance_km: Number(Number(r.distance_km).toFixed(1)),
          today_hours: r.today_hours,
          open_now: r.open_now,
        }));
        return { ok: true, data: trimmed };
      }
      case "get_booking_link_by_name": {
        const rows = await findBookingLinkByName(String(input.name ?? ""), input.city as string | undefined);
        return { ok: true, data: rows };
      }
      case "get_restaurant_booking_link": {
        const r = await getRestaurantWithLocation(String(input.restaurant_id));
        if (!r) return { ok: false, error: "Restaurante não encontrado." };

        // Use the EXACT url_page_twk column. Never invent or build a URL.
        const url = (r.url_page_twk as string | null)?.trim() || null;
        if (!url) {
          return {
            ok: false,
            error:
              "Restaurante sem url_page_twk cadastrada. NÃO gere link manualmente e NÃO peça para o cliente buscar pelo nome. Diga que está providenciando o link oficial e escale com PEDIDO_ESPECIAL para a equipe enviar a URL correta.",
          };
        }

        return {
          ok: true,
          data: {
            restaurant_id: r.restaurant_id,
            restaurant_name: r.name,
            city: r.city,
            country: r.country,
            booking_url: url,
          },
        };
      }
      case "get_restaurant_location": {
        // restaurant_id is preferred; restaurant_name + city work as fallback
        // so a Maps link can ALWAYS be produced — even without a clean DB row.
        const r = input.restaurant_id
          ? await getRestaurantWithLocation(String(input.restaurant_id))
          : null;

        const name =
          (r?.name as string | null) ?? (input.restaurant_name as string | undefined) ?? null;
        const city =
          (r?.city as string | null) ?? (input.city as string | undefined) ?? null;
        const country =
          (r?.country as string | null) ?? (input.country as string | undefined) ?? null;

        if (!name && !city) {
          return {
            ok: false,
            error:
              "Informe ao menos o nome do restaurante ou a cidade. Peça esse dado ao cliente e chame a tool de novo — nunca diga que não tem o endereço.",
          };
        }

        let address = (r?.address as string | null) ?? null;
        let lat = (r?.latitude as number | null) ?? null;
        let lng = (r?.longitude as number | null) ?? null;

        // Missing address or coords → look it up on the internet (Google).
        if (!address || lat == null || lng == null) {
          const query = [name, city, country].filter(Boolean).join(", ");
          const resolved = await lookupAddress(query);
          if (resolved) {
            address = address ?? resolved.formattedAddress;
            lat = lat ?? resolved.lat;
            lng = lng ?? resolved.lng;
          }
        }

        // Maps link is ALWAYS produced: coords if available, else a name+city
        // search query (which always opens the place in Google Maps).
        const queryFallback = [name, city, country].filter(Boolean).join(", ");
        const maps_link = buildMapsLink({
          name: name ?? undefined,
          address: address ?? queryFallback,
          lat: lat ?? undefined,
          lng: lng ?? undefined,
        });

        return {
          ok: true,
          data: {
            restaurant_id: r?.restaurant_id ?? input.restaurant_id ?? null,
            name,
            address: address ?? queryFallback,
            address_is_precise: Boolean(address),
            city,
            country,
            latitude: lat,
            longitude: lng,
            telephone: r?.telephone_of_the_establishment ?? null,
            site_url: r?.site_url ?? null,
            maps_link,
          },
        };
      }
      case "compute_route_to_restaurant": {
        const r = await getRestaurantWithLocation(String(input.restaurant_id));
        if (!r) return { ok: false, error: "Restaurante não encontrado." };

        const addressStr =
          (r.address as string | null) ??
          [r.name, r.city, r.country].filter(Boolean).join(", ");

        let destLat = r.latitude as number | null;
        let destLng = r.longitude as number | null;
        if ((destLat == null || destLng == null) && addressStr) {
          const geo = await geocodeAddress(addressStr);
          if (geo) {
            destLat = geo.lat;
            destLng = geo.lng;
          }
        }
        if (destLat == null || destLng == null) {
          return { ok: false, error: "Não foi possível resolver as coordenadas do restaurante." };
        }

        const route = await computeRoute({
          origin: {
            lat: Number(input.client_latitude),
            lng: Number(input.client_longitude),
          },
          destination: { lat: destLat, lng: destLng },
          mode: (input.mode as TravelMode | undefined) ?? "driving",
        });
        if (!route) return { ok: false, error: "Não foi possível calcular a rota." };

        // "Saia agora": se o cliente informou o horário de chegada/reserva,
        // calcula a que horas sair (chegada − viagem − margem de segurança).
        const arrival = typeof input.arrival_time === "string" ? input.arrival_time : null;
        const bufferMin = Number(input.buffer_minutes ?? 10);
        const departure = arrival ? computeDeparture(arrival, route.duration_seconds, bufferMin) : null;

        return {
          ok: true,
          data: {
            ...route,
            restaurant_name: r.name,
            ...(departure
              ? {
                  arrive_by: arrival,
                  suggested_departure: departure.suggested_departure,
                  buffer_minutes: bufferMin,
                  note_overnight: departure.crossedMidnight,
                }
              : {}),
            maps_link: buildMapsLink({
              name: r.name as string | undefined,
              address: addressStr,
              lat: destLat,
              lng: destLng,
            }),
          },
        };
      }
      case "run_sql_read": {
        const rows = await runReadOnlyQuery(String(input.sql ?? ""));
        return { ok: true, data: rows };
      }
      case "find_user": {
        const rows = await findUser({
          email: input.email as string | undefined,
          phone: input.phone as string | undefined,
        });
        return { ok: true, data: rows };
      }
      case "set_outbound_consent": {
        if (!profileKey) return { ok: false, error: "Identidade do cliente indisponível." };
        await setOutboundConsent(profileKey, Boolean(input.opt_out), "agent");
        return { ok: true, data: { opted_out: Boolean(input.opt_out) } };
      }
      case "save_experience_review": {
        const saved = await saveExperienceReview({
          customerPhone: profileKey ?? String(input.customer_phone ?? ""),
          reservationCode: (input.reservation_code as string | undefined) ?? null,
          restaurantId: (input.restaurant_id as string | undefined) ?? null,
          platformRating: (input.platform_rating as number | undefined) ?? null,
          establishmentRating: (input.establishment_rating as number | undefined) ?? null,
          establishmentTags: input.establishment_tags as string[] | undefined,
          platformTags: input.platform_tags as string[] | undefined,
          feedback: (input.feedback as string | undefined) ?? null,
          language: (input.language as string | undefined) ?? null,
        });
        publish({
          kind: "tool_call",
          chat: profileKey,
          tool: "experience_review_saved",
          success: true,
          latency_ms: 0,
          at: new Date().toISOString(),
        });
        return { ok: true, data: saved };
      }
      // ─── Mensagens ricas (enviadas na hora pelo servidor) ──────────────────
      case "send_restaurant_options": {
        if (!waTo) {
          return {
            ok: false,
            error:
              "Mensagens ricas não estão disponíveis neste canal — entregue o conteúdo em texto normal.",
          };
        }
        const ids = Array.isArray(input.restaurant_ids)
          ? (input.restaurant_ids as unknown[]).map(String)
          : [];
        const rows = await getRestaurantsByIds(ids);
        if (rows.length === 0) {
          return { ok: false, error: "Nenhum restaurante válido para os IDs informados. Use IDs vindos das tools de busca." };
        }
        const body = sanitizeReply(String(input.body ?? ""));
        const sent = await sendInteractiveList(waTo, {
          body: body || "Aqui estão as opções da nossa curadoria:",
          buttonLabel: String(input.button_label ?? "Ver opções"),
          sectionTitle: (input.section_title as string | undefined) ?? "Nossa curadoria",
          rows: rows.map((r) => ({
            id: `restaurant:${r.restaurant_id}`,
            title: String(r.name ?? ""),
            description: [r.city, r.country].filter(Boolean).join(", "),
          })),
        });
        if (!sent) return { ok: false, error: "Falha ao enviar a lista. Apresente as opções em texto normal." };
        void logMessage({
          chatId: waTo, pushName: null, direction: "outbound",
          content: `[lista interativa] ${body} — ${rows.map((r) => r.name).join(" | ")}`,
        });
        return { ok: true, data: { sent: true, options: rows.map((r) => ({ restaurant_id: r.restaurant_id, name: r.name })) } };
      }
      case "send_quick_replies": {
        if (!waTo) {
          return {
            ok: false,
            error:
              "Mensagens ricas não estão disponíveis neste canal — entregue o conteúdo em texto normal.",
          };
        }
        const options = Array.isArray(input.options) ? (input.options as Array<{ id?: string; label?: string }>) : [];
        const buttons = options
          .filter((o) => o?.label)
          .slice(0, 3)
          .map((o) => ({ id: String(o.id ?? o.label), title: sanitizeReply(String(o.label)) }));
        if (buttons.length === 0) return { ok: false, error: "Informe ao menos um botão com label." };
        const body = sanitizeReply(String(input.body ?? ""));
        if (!body) return { ok: false, error: "Informe o texto (body) da mensagem." };
        const sent = await sendInteractiveButtons(waTo, body, buttons);
        if (!sent) return { ok: false, error: "Falha ao enviar os botões. Faça a pergunta em texto normal." };
        void logMessage({
          chatId: waTo, pushName: null, direction: "outbound",
          content: `[botões] ${body} — ${buttons.map((b) => b.title).join(" | ")}`,
        });
        return { ok: true, data: { sent: true } };
      }
      case "send_booking_button": {
        if (!waTo) {
          return {
            ok: false,
            error:
              "Mensagens ricas não estão disponíveis neste canal — entregue o conteúdo em texto normal.",
          };
        }
        const r = await getRestaurantWithLocation(String(input.restaurant_id));
        if (!r) return { ok: false, error: "Restaurante não encontrado." };
        const url = (r.url_page_twk as string | null)?.trim() || null;
        if (!url) {
          return {
            ok: false,
            error:
              "Restaurante sem url_page_twk cadastrada. NÃO gere link manualmente. Diga que está providenciando o link oficial e escale com PEDIDO_ESPECIAL.",
          };
        }
        const body = sanitizeReply(String(input.body ?? "")) || `Sua reserva no *${r.name}* é feita direto na página oficial — escolha data, horário e número de pessoas.`;
        const sent = await sendCtaUrl(waTo, {
          body,
          displayText: "Reservar",
          url,
          footer: "The World Keys",
        });
        if (!sent) return { ok: false, error: "Falha ao enviar o botão. Entregue a URL exata em texto, sozinha na linha." };
        void logMessage({
          chatId: waTo, pushName: null, direction: "outbound",
          content: `[botão Reservar → ${url}] ${body}`,
        });
        return { ok: true, data: { sent: true, restaurant_name: r.name, booking_url: url } };
      }
      case "send_location_pin": {
        if (!waTo) {
          return {
            ok: false,
            error:
              "Mensagens ricas não estão disponíveis neste canal — entregue o conteúdo em texto normal.",
          };
        }
        const r = await getRestaurantWithLocation(String(input.restaurant_id));
        if (!r) return { ok: false, error: "Restaurante não encontrado." };
        let lat = r.latitude as number | null;
        let lng = r.longitude as number | null;
        const addressStr =
          (r.address as string | null) ?? [r.name, r.city, r.country].filter(Boolean).join(", ");
        if (lat == null || lng == null) {
          const geo = await geocodeAddress(addressStr);
          if (geo) { lat = geo.lat; lng = geo.lng; }
        }
        if (lat == null || lng == null) {
          return { ok: false, error: "Sem coordenadas para este restaurante. Use get_restaurant_location e entregue o maps_link em texto." };
        }
        const sent = await sendLocation(waTo, {
          latitude: Number(lat),
          longitude: Number(lng),
          name: (r.name as string | undefined) ?? undefined,
          address: (r.address as string | undefined) ?? undefined,
        });
        if (!sent) return { ok: false, error: "Falha ao enviar o pin. Entregue o maps_link em texto." };
        void logMessage({
          chatId: waTo, pushName: null, direction: "outbound",
          content: `[pin de localização] ${r.name ?? ""} — ${addressStr}`,
        });
        return { ok: true, data: { sent: true, name: r.name, latitude: lat, longitude: lng } };
      }
      case "log_attendance_event": {
        const res = await logAttendanceEvent({
          description: String(input.description),
          restaurantId: (input.restaurant_id as string | undefined) ?? null,
          reservationId: (input.reservation_id as string | undefined) ?? null,
        });
        return { ok: true, data: res };
      }
      case "escalate_to_human": {
        const phone = trustedPhone ?? trustedEmail ?? String(input.customer_phone ?? "");
        // Fonte de verdade do painel: tabela própria aria_escalations.
        await logEscalation({
          tag: String(input.tag),
          summary: String(input.summary ?? ""),
          phone,
          reservationCode: (input.reservation_code as string | undefined) ?? null,
        }).catch((e) => console.error("[escalate] falha ao gravar aria_escalations", e));

        // Audit log legado (best-effort; pode falhar se o schema de update_events diferir).
        await logAttendanceEvent({
          description: `ESCALAÇÃO [${String(input.tag)}] ${String(input.summary)} | phone=${phone} code=${String(input.reservation_code ?? "n/a")}`,
          restaurantId: null,
          reservationId: null,
        }).catch((e) => console.error("[escalate] failed to log event", e));

        console.warn("[escalate]", {
          tag: input.tag,
          summary: input.summary,
          customer_phone: phone,
          reservation_code: input.reservation_code,
        });

        return { ok: true, data: { escalated: true, tag: input.tag } };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tool:${name}]`, msg);
    return { ok: false, error: msg };
  }
}
