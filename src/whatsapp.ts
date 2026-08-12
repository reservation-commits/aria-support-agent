import axios from "axios";
import { config } from "./config.js";
import {
  clampText,
  splitForWhatsApp,
  WA_BUTTON_TITLE_MAX,
  WA_INTERACTIVE_BODY_MAX,
  WA_LIST_BUTTON_MAX,
  WA_LIST_ROW_DESC_MAX,
  WA_LIST_ROW_TITLE_MAX,
  WA_SECTION_TITLE_MAX,
} from "./waLimits.js";

const graphClient = axios.create({
  baseURL: `https://graph.facebook.com/${config.whatsapp.graphVersion}`,
  headers: {
    Authorization: `Bearer ${config.whatsapp.accessToken}`,
    "Content-Type": "application/json",
  },
  timeout: 20_000,
});

// Códigos da Meta que indicam estar FORA da janela de 24h (re-engajamento) —
// nesses casos um texto livre nunca vai entregar; só template adianta. Não
// adianta tentar de novo.
const OUT_OF_WINDOW_CODES = new Set([131047, 131051, 131026, 470, 131000]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a text message via WhatsApp Cloud API.
 *
 * Subject to the 24-hour customer service window — only works if the user has
 * messaged us in the last 24h. Outside that, you'd need a template message.
 *
 * Retorna `true` se entregou à Graph API. NÃO lança: erros transitórios (5xx /
 * rede / rate-limit) são re-tentados com backoff; erros definitivos (fora da
 * janela, payload inválido) são logados e retornam `false`, sem derrubar o fluxo.
 */
export async function sendText(to: string, text: string, maxRetries = 2): Promise<boolean> {
  // A Cloud API rejeita corpo de texto acima de 4096 caracteres — mensagens
  // longas são divididas em partes (por parágrafo) e enviadas em sequência.
  for (const part of splitForWhatsApp(text)) {
    const ok = await postWithRetry(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: part, preview_url: false },
      },
      "sendText",
      maxRetries,
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * POST genérico de mensagem com retry/backoff — mesma semântica do sendText:
 * transitórios (5xx/rede/429) re-tentam; fora da janela de 24h ou payload
 * inválido retornam false sem derrubar o fluxo.
 */
async function postWithRetry(
  payload: Record<string, unknown>,
  label: string,
  maxRetries = 2,
): Promise<boolean> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await graphClient.post(`/${config.whatsapp.phoneNumberId}/messages`, payload);
      return true;
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const e = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      const code = e?.code as number | undefined;

      console.error(
        `[wa.${label}]`,
        status,
        JSON.stringify({ message: e?.message, code, subcode: e?.error_subcode, type: e?.type, fbtrace_id: e?.fbtrace_id }),
      );

      // Fora da janela de 24h ou erro de payload → não adianta repetir.
      if (code && OUT_OF_WINDOW_CODES.has(code)) {
        console.warn(`[wa.${label}] fora da janela de 24h — use template para outbound. Mensagem não entregue.`);
        return false;
      }
      const transient = !status || status >= 500 || status === 429;
      if (!transient || attempt === maxRetries) return false;

      await sleep(500 * 2 ** attempt); // 500ms, 1s
    }
  }
  return false;
}

// ─── Mensagens ricas (interactive / location) ────────────────────────────────
// Todos os textos são cortados nos limites da Cloud API antes do envio — um
// título longo nunca derruba a mensagem inteira.

export type QuickReplyButton = { id: string; title: string };

/** Botões de resposta rápida (até 3). A resposta volta como button_reply. */
export async function sendInteractiveButtons(
  to: string,
  body: string,
  buttons: QuickReplyButton[],
): Promise<boolean> {
  const btns = buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: clampText(b.id, 256), title: clampText(b.title, WA_BUTTON_TITLE_MAX) },
  }));
  if (btns.length === 0) return false;
  return postWithRetry(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: clampText(body, WA_INTERACTIVE_BODY_MAX) },
        action: { buttons: btns },
      },
    },
    "sendButtons",
  );
}

export type ListRow = { id: string; title: string; description?: string };

/** Lista interativa nativa (até 10 linhas). A seleção volta como list_reply. */
export async function sendInteractiveList(
  to: string,
  params: { body: string; buttonLabel: string; sectionTitle?: string; rows: ListRow[]; footer?: string },
): Promise<boolean> {
  const rows = params.rows.slice(0, 10).map((r) => ({
    id: clampText(r.id, 200),
    title: clampText(r.title, WA_LIST_ROW_TITLE_MAX),
    ...(r.description ? { description: clampText(r.description, WA_LIST_ROW_DESC_MAX) } : {}),
  }));
  if (rows.length === 0) return false;
  return postWithRetry(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: clampText(params.body, WA_INTERACTIVE_BODY_MAX) },
        ...(params.footer ? { footer: { text: clampText(params.footer, 60) } } : {}),
        action: {
          button: clampText(params.buttonLabel, WA_LIST_BUTTON_MAX),
          sections: [
            {
              ...(params.sectionTitle ? { title: clampText(params.sectionTitle, WA_SECTION_TITLE_MAX) } : {}),
              rows,
            },
          ],
        },
      },
    },
    "sendList",
  );
}

/** Botão CTA que abre uma URL (ex.: "Reservar" → página do restaurante). */
export async function sendCtaUrl(
  to: string,
  params: { body: string; displayText: string; url: string; footer?: string },
): Promise<boolean> {
  return postWithRetry(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: clampText(params.body, WA_INTERACTIVE_BODY_MAX) },
        ...(params.footer ? { footer: { text: clampText(params.footer, 60) } } : {}),
        action: {
          name: "cta_url",
          parameters: { display_text: clampText(params.displayText, WA_BUTTON_TITLE_MAX), url: params.url },
        },
      },
    },
    "sendCtaUrl",
  );
}

/** Pin de localização nativo — abre direto no mapa do WhatsApp. */
export async function sendLocation(
  to: string,
  params: { latitude: number; longitude: number; name?: string; address?: string },
): Promise<boolean> {
  return postWithRetry(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "location",
      location: {
        latitude: params.latitude,
        longitude: params.longitude,
        ...(params.name ? { name: params.name } : {}),
        ...(params.address ? { address: params.address } : {}),
      },
    },
    "sendLocation",
  );
}

/**
 * Send a pre-approved WhatsApp template message (outbound proativo).
 * Funciona FORA da janela de 24h. Usado para lembretes de reserva.
 *
 * `bodyParams` preenche, em ordem, os placeholders {{1}}, {{2}}... do corpo do
 * template aprovado no WhatsApp Manager.
 */
export async function sendTemplate(params: {
  to: string;
  template: string;
  locale: string;
  bodyParams: string[];
}): Promise<boolean> {
  try {
    await graphClient.post(`/${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "template",
      template: {
        name: params.template,
        language: { code: params.locale },
        components: params.bodyParams.length
          ? [
              {
                type: "body",
                parameters: params.bodyParams.map((t) => ({ type: "text", text: t })),
              },
            ]
          : [],
      },
    });
    return true;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const e = err.response?.data?.error;
      console.error(
        "[wa.sendTemplate]",
        err.response?.status,
        JSON.stringify({ message: e?.message, code: e?.code, subcode: e?.error_subcode }),
      );
    } else {
      console.error("[wa.sendTemplate]", err);
    }
    return false;
  }
}

/**
 * Mark a received message as read AND show the "typing…" indicator.
 *
 * Meta's typing indicator is bound to the read receipt — it appears in the
 * customer's chat for up to ~25 seconds and is automatically dismissed when
 * we send the next outbound message, whichever comes first.
 *
 * Reference: Cloud API → POST /{PHONE_NUMBER_ID}/messages with
 * { status: "read", typing_indicator: { type: "text" } }.
 */
export async function markAsReadWithTyping(messageId: string): Promise<void> {
  try {
    await graphClient.post(`/${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (err) {
    // Non-critical; just log.
    if (axios.isAxiosError(err)) {
      const e = err.response?.data?.error;
      console.warn(
        "[wa.typing]",
        err.response?.status,
        JSON.stringify({ message: e?.message, code: e?.code, subcode: e?.error_subcode }),
      );
    } else {
      console.warn("[wa.typing]", err);
    }
  }
}

/**
 * Download a media payload by media_id (the ID present in image/audio/document
 * messages). Returns base64 + mime, or null on failure.
 *
 * Meta requires two hops:
 *  1) GET /{MEDIA_ID} → { url, mime_type, sha256, ... }
 *  2) GET that signed URL with our Bearer token → binary
 */
export async function fetchMediaById(
  mediaId: string,
): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const meta = await graphClient.get<{ url: string; mime_type: string }>(`/${mediaId}`);
    const url = meta.data?.url;
    const mimetype = meta.data?.mime_type ?? "application/octet-stream";
    if (!url) return null;

    const bin = await axios.get<ArrayBuffer>(url, {
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      responseType: "arraybuffer",
      timeout: 30_000,
      maxContentLength: 50 * 1024 * 1024, // 50 MB ceiling
    });

    const base64 = Buffer.from(bin.data).toString("base64");
    return { base64, mimetype };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[wa.fetchMediaById]", err.response?.status, err.response?.data);
    } else {
      console.error("[wa.fetchMediaById]", err);
    }
    return null;
  }
}
