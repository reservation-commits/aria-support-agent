/**
 * templateLocale.ts — em que idioma sai o template de WhatsApp (regra única, pura).
 *
 * Ordem de decisão (fundador, 2026-09-25: "cada estabelecimento ou cliente no seu idioma"):
 *   1. o idioma marcado no identificador (`aria_contact_consent.idioma`) — se estiver
 *      entre os APROVADOS na Meta;
 *   2. senão, o idioma do país do telefone (`locale.ts`) — se aprovado;
 *   3. senão, o idioma padrão (`REMINDERS_DEFAULT_LOCALE`, hoje `en`).
 *
 * "Aprovado" = tradução do template que existe na Meta (`REMINDERS_LOCALES`). Tentar uma
 * tradução inexistente é envio perdido; por isso a regra degrada para o padrão em vez de
 * arriscar. Usada pelos dois remetentes: reservationEvents.ts (por evento) e reminders.ts
 * (por tempo). Nenhum deles decide idioma por conta própria.
 */

import { languageForPhone, type BaseLang } from "./locale.js";

/** idioma base → locale do template na Meta. */
export const BASE_TO_TEMPLATE: Record<BaseLang, string> = {
  pt: "pt_BR",
  en: "en",
  es: "es",
  fr: "fr",
  it: "it",
  de: "de",
};

export const IDIOMAS_ACEITOS = Object.keys(BASE_TO_TEMPLATE) as BaseLang[];

/**
 * Normaliza o que o operador ou o site escreveu ("PT-br", "en_US", "Português") para o
 * idioma base. Devolve null se não reconhecer — nunca inventa.
 */
export function normalizarIdioma(bruto: string | null | undefined): BaseLang | null {
  if (!bruto) return null;
  const t = bruto.trim().toLowerCase().replace(/[-_].*$/, "");
  const nomes: Record<string, BaseLang> = {
    pt: "pt", por: "pt", portugues: "pt", português: "pt",
    en: "en", eng: "en", english: "en", ingles: "en", inglês: "en",
    es: "es", spa: "es", espanol: "es", español: "es", spanish: "es", espanhol: "es",
    fr: "fr", fra: "fr", fre: "fr", francais: "fr", français: "fr", french: "fr", frances: "fr", francês: "fr",
    it: "it", ita: "it", italiano: "it", italian: "it",
    de: "de", deu: "de", ger: "de", deutsch: "de", german: "de", alemao: "de", alemão: "de",
  };
  return nomes[t] ?? null;
}

export interface EscolhaLocale {
  locale: string;
  origem: "preferencia" | "pais" | "padrao";
}

export function escolherLocale(p: {
  idiomaPreferido: string | null | undefined;
  phone: string;
  aprovados: string[];
  defaultLocale: string;
}): EscolhaLocale {
  const permitido = (l: string) => p.aprovados.length === 0 || p.aprovados.includes(l);
  const padrao = permitido(p.defaultLocale) ? p.defaultLocale : (p.aprovados[0] ?? p.defaultLocale);

  const pref = normalizarIdioma(p.idiomaPreferido);
  if (pref && permitido(BASE_TO_TEMPLATE[pref])) return { locale: BASE_TO_TEMPLATE[pref], origem: "preferencia" };

  // País conhecido = o mapa devolve o mesmo idioma seja qual for o fallback.
  const paisConhecido = languageForPhone(p.phone, "en") === languageForPhone(p.phone, "pt");
  const doPais = BASE_TO_TEMPLATE[languageForPhone(p.phone)];
  if (paisConhecido && permitido(doPais)) return { locale: doPais, origem: "pais" };

  return { locale: padrao, origem: "padrao" };
}
