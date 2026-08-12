/**
 * identity.ts — identidade multi-canal do cliente.
 *
 * No WhatsApp a fonte de verdade é o TELEFONE (chatId do webhook da Meta);
 * no email é o ENDEREÇO do remetente. As tools nunca confiam no que o modelo
 * digitou — sempre na identidade resolvida pelo servidor.
 *
 * Convenção de chave de sessão/conversa (chatId string, usada na fila, nas
 * sessões e no dashboard):
 *   WhatsApp → "5511999999999"        (dígitos, como a Meta entrega)
 *   Email    → "email:cliente@x.com"  (prefixo fixo + endereço minúsculo)
 */

import { findUser } from "./db.js";
import { normalizePhone } from "./phone.js";

export type Channel = "whatsapp" | "email";

export type AgentIdentity = {
  channel: Channel;
  /** E.164 com "+" quando conhecido (sempre no WhatsApp; no email só se cadastrado). */
  phone: string | null;
  /** Endereço de email minúsculo quando conhecido (sempre no canal email). */
  email: string | null;
};

export const EMAIL_CHAT_PREFIX = "email:";

export function whatsappIdentity(chatId: string): AgentIdentity {
  return { channel: "whatsapp", phone: normalizePhone(chatId), email: null };
}

export function emailIdentity(address: string): AgentIdentity {
  return { channel: "email", phone: null, email: address.trim().toLowerCase() };
}

export function emailChatId(address: string): string {
  return `${EMAIL_CHAT_PREFIX}${address.trim().toLowerCase()}`;
}

/** Reconstrói a identidade a partir da chave de conversa (sessões/fila). */
export function identityFromChatId(chatId: string): AgentIdentity {
  if (chatId.startsWith(EMAIL_CHAT_PREFIX)) {
    return emailIdentity(chatId.slice(EMAIL_CHAT_PREFIX.length));
  }
  return whatsappIdentity(chatId);
}

/** Chave curta da conversa para logs/analytics (telefone ou email). */
export function contactKey(identity: AgentIdentity | null): string | null {
  if (!identity) return null;
  return identity.phone ?? (identity.email ? emailChatId(identity.email) : null);
}

/**
 * Chave do PERFIL ACUMULATIVO (aria_customer_profiles.customer_phone).
 * Prioridade: telefone confiável → telefone do cadastro (lookup por email) →
 * chave sintética "email:<addr>". Assim o MESMO cliente que fala por WhatsApp
 * e por email compartilha um único perfil sempre que o cadastro permitir.
 */
export async function resolveProfileKey(identity: AgentIdentity): Promise<string> {
  if (identity.phone) return identity.phone;
  if (identity.email) {
    try {
      const rows = (await findUser({ email: identity.email })) as Array<{ phone?: string | null }>;
      const phone = rows.find((r) => r.phone)?.phone;
      if (phone) return normalizePhone(String(phone));
    } catch {
      // lookup é best-effort — cai na chave sintética
    }
    return emailChatId(identity.email);
  }
  throw new Error("Identidade sem telefone nem email.");
}
