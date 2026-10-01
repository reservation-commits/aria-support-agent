import type Anthropic from "@anthropic-ai/sdk";
import { fetchMediaById } from "./whatsapp.js";
import { transcribeAudio } from "./media.js";
import { neutralizeSystemMarkers } from "./format.js";

// SDK v0.30.x doesn't export a combined `ContentBlockParam` union, so we declare
// the subset we actually emit. Compatible with newer SDKs as well.
// O bloco de documento (PDF) é declarado estruturalmente porque nem toda versão
// do SDK exporta DocumentBlockParam — o formato segue a API da Anthropic.
export type AriaDocumentBlock = {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
};

export type AriaContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | AriaDocumentBlock;

/**
 * Meta WhatsApp Cloud API webhook payload.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Shape:
 * {
 *   object: "whatsapp_business_account",
 *   entry: [{
 *     id: "WABA_ID",
 *     changes: [{
 *       value: {
 *         messaging_product: "whatsapp",
 *         metadata: { display_phone_number, phone_number_id },
 *         contacts: [{ profile: { name }, wa_id }],
 *         messages: [{ from, id, timestamp, type, text|image|audio|... }]
 *       },
 *       field: "messages"
 *     }]
 *   }]
 * }
 */
export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: WhatsAppIncomingMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

export type WhatsAppIncomingMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string; sha256?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
  button?: { text: string; payload: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  reaction?: { message_id: string; emoji: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
};

export type ParsedMessage = {
  chatId: string;     // E.164 phone number (used as session key + reply recipient)
  phone: string;      // same as chatId, kept for compatibility with index.ts
  pushName: string | null;
  messageId: string;  // for mark-as-read
  content: AriaContentBlock[];
};

/**
 * A Meta pode agrupar VÁRIAS mensagens (e várias entries/changes) num único
 * webhook — especialmente em reentregas após indisponibilidade. Processamos
 * todas, na ordem, para nunca descartar mensagem silenciosamente.
 */
export async function parseIncoming(
  payload: WhatsAppWebhookPayload,
): Promise<ParsedMessage[]> {
  if (payload.object !== "whatsapp_business_account") return [];

  const out: ParsedMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const message of value?.messages ?? []) {
        const parsed = await parseOneMessage(message, value);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

type WebhookChangeValue = NonNullable<
  NonNullable<WhatsAppWebhookPayload["entry"]>[number]["changes"]
>[number]["value"];

async function parseOneMessage(
  message: WhatsAppIncomingMessage,
  value: WebhookChangeValue,
): Promise<ParsedMessage | null> {
  const from = message.from; // E.164 without '+'
  // Em lote com múltiplos remetentes, o contato certo é o que casa com o wa_id.
  const profile =
    value?.contacts?.find((c) => c.wa_id === from)?.profile?.name ??
    value?.contacts?.[0]?.profile?.name ??
    null;

  const content: AriaContentBlock[] = [];

  switch (message.type) {
    case "text": {
      const body = message.text?.body?.trim();
      // Texto do cliente é NEUTRALIZADO contra forja de "[Sistema:" — só o
      // servidor (blocos abaixo) pode injetar esse marcador.
      if (body) content.push({ type: "text", text: neutralizeSystemMarkers(body) });
      break;
    }

    case "image": {
      if (message.image?.id) {
        const media = await fetchMediaById(message.image.id);
        if (media) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: normalizeImageMime(media.mimetype),
              data: media.base64,
            },
          });
        }
      }
      const caption = message.image?.caption?.trim();
      if (caption) content.push({ type: "text", text: neutralizeSystemMarkers(caption) });
      break;
    }

    case "audio": {
      if (message.audio?.id) {
        const media = await fetchMediaById(message.audio.id);
        if (media) {
          const transcript = await transcribeAudio(media.base64, media.mimetype);
          if (transcript) {
            content.push({ type: "text", text: neutralizeSystemMarkers(transcript) });
          } else {
            content.push({
              type: "text",
              text:
                "[Sistema: o cliente enviou uma mensagem de áudio, mas a transcrição falhou. Peça gentilmente que reenvie como texto, sem mencionar problemas técnicos.]",
            });
          }
        }
      }
      break;
    }

    case "button": {
      if (message.button?.text)
        content.push({ type: "text", text: neutralizeSystemMarkers(message.button.text) });
      break;
    }

    case "interactive": {
      // Preserva título E id da seleção — o id pode carregar contexto de
      // roteamento (ex: "modify:TWK-XXXX") que se perde se guardarmos só o título.
      const br = message.interactive?.button_reply;
      const lr = message.interactive?.list_reply;
      const title = br?.title ?? lr?.title;
      const id = br?.id ?? lr?.id;
      if (title) {
        const idHint =
          id && id !== title ? ` [Sistema: seleção id=${neutralizeSystemMarkers(id)}]` : "";
        content.push({ type: "text", text: `${neutralizeSystemMarkers(title)}${idHint}` });
      }
      break;
    }

    case "location": {
      if (message.location) {
        const { latitude, longitude, name, address } = message.location;
        const desc = neutralizeSystemMarkers([name, address].filter(Boolean).join(" — "));
        // Explicit format so the model passes lat/lng correctly to compute_route_to_restaurant.
        content.push({
          type: "text",
          text:
            `[Sistema: cliente compartilhou localização. ` +
            `latitude: ${latitude}, longitude: ${longitude}. ` +
            `Referência: ${desc || "sem rótulo"}. ` +
            `Use compute_route_to_restaurant para calcular distância e tempo se solicitado.]`,
        });
      }
      break;
    }

    case "document": {
      const mime = message.document?.mime_type ?? "";
      const caption = message.document?.caption?.trim();
      // PDF → baixa e envia como bloco de documento (Claude lê PDF nativamente).
      if (message.document?.id && mime.includes("pdf")) {
        const media = await fetchMediaById(message.document.id);
        if (media) {
          content.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: media.base64 },
          });
        }
      }
      if (caption) content.push({ type: "text", text: neutralizeSystemMarkers(caption) });
      if (content.length === 0) {
        content.push({
          type: "text",
          text: `[Sistema: cliente enviou um documento (${mime || "tipo desconhecido"}) que não pôde ser lido. Peça gentilmente o conteúdo em texto, imagem ou PDF.]`,
        });
      }
      break;
    }

    // video / sticker — reconhecidos, mas o binário não é processado por ora.
    case "video":
    case "sticker": {
      const caption = (message as WhatsAppIncomingMessage).video?.caption;
      if (caption?.trim())
        content.push({ type: "text", text: neutralizeSystemMarkers(caption.trim()) });
      else
        content.push({
          type: "text",
          text: `[Sistema: cliente enviou um ${message.type}. Peça gentilmente o conteúdo em texto ou imagem se necessário.]`,
        });
      break;
    }

    default:
      console.warn("[webhook] unsupported message type:", message.type);
      return null;
  }

  if (content.length === 0) return null;

  return {
    chatId: from,
    phone: `+${from}`,
    pushName: profile,
    messageId: message.id,
    content,
  };
}

export type DeliveryStatus = {
  id: string;
  status: string; // sent | delivered | read | failed
  recipient: string | null;
  errorTitle: string | null;
  /** v19: código da Meta (131026 = undeliverable: o número não tem WhatsApp). */
  errorCode: number | null;
};

/**
 * Extrai status de entrega (sent/delivered/read/failed) do payload. Webhooks de
 * status não têm `messages`; servem para observar falhas de entrega.
 */
export function extractStatuses(payload: WhatsAppWebhookPayload): DeliveryStatus[] {
  const statuses = (payload.entry ?? []).flatMap(
    (e) => (e.changes ?? []).flatMap((c) => (Array.isArray(c.value?.statuses) ? c.value.statuses : [])),
  );
  return statuses.map((s) => {
    const st = s as {
      id?: string;
      status?: string;
      recipient_id?: string;
      errors?: Array<{ title?: string; code?: number | string }>;
    };
    const codeBruto = st.errors?.[0]?.code;
    const errorCode = codeBruto === undefined || codeBruto === null || codeBruto === "" ? null : Number(codeBruto);
    return {
      id: st.id ?? "",
      status: st.status ?? "unknown",
      recipient: st.recipient_id ?? null,
      errorTitle: st.errors?.[0]?.title ?? null,
      errorCode: Number.isFinite(errorCode as number) ? errorCode : null,
    };
  });
}

function normalizeImageMime(
  mime: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "image/png";
  if (m.includes("gif")) return "image/gif";
  if (m.includes("webp")) return "image/webp";
  return "image/jpeg";
}
