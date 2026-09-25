/**
 * locale.ts
 *
 * Mapa do código de discagem do país (E.164) → idioma base (pt/en/es/fr/it/de).
 * Puro e sem dependências — usado para escolher o idioma de mensagens livres
 * (ex.: confirmação de opt-out) e como base para o idioma dos templates.
 */

export type BaseLang = "pt" | "en" | "es" | "fr" | "it" | "de";

// Prefixos mais longos primeiro (ex: 351 antes de 1) — a ordenação é feita abaixo.
const CODE_LANG: Array<[string, BaseLang]> = [
  ["55", "pt"], ["351", "pt"], ["244", "pt"], ["258", "pt"],
  ["34", "es"], ["52", "es"], ["54", "es"], ["56", "es"], ["57", "es"], ["51", "es"],
  ["58", "es"], ["591", "es"], ["593", "es"], ["595", "es"], ["598", "es"],
  ["502", "es"], ["503", "es"], ["504", "es"], ["505", "es"], ["506", "es"], ["507", "es"],
  ["33", "fr"], ["32", "fr"], ["221", "fr"], ["225", "fr"],
  ["1", "en"], ["44", "en"], ["61", "en"], ["353", "en"], ["64", "en"], ["27", "en"],
  ["39", "it"],
  ["49", "de"], ["43", "de"],
];
const SORTED = [...CODE_LANG].sort((a, b) => b[0].length - a[0].length);

export function languageForPhone(phone: string, fallback: BaseLang = "en"): BaseLang {
  const digits = phone.replace(/\D/g, "");
  for (const [code, lang] of SORTED) {
    if (digits.startsWith(code)) return lang;
  }
  return fallback;
}
