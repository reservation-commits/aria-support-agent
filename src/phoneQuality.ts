/**
 * phoneQuality.ts — a trava de telefone do outbound.
 *
 * Módulo PURO (sem config/env/IO), como waLimits e tz, para rodar nos testes
 * offline.
 *
 * POR QUE EXISTE
 * `normalizePhone()` cola um "+" nos dígitos e devolve. Isso é suficiente para
 * o INBOUND (o número veio da própria Meta, já correto), mas é perigoso no
 * OUTBOUND: 342 das 2.680 reservas dos últimos 180 dias têm telefone gravado
 * sem "+", com DDD brasileiro na posição do código de país. "+21…" não é o Rio,
 * é o Egito. Um template entregue ao número errado leva nome, restaurante e
 * data de reserva de um cliente a um desconhecido — vazamento de dado pessoal —
 * e derruba o quality rating do nosso número na Meta.
 *
 * MÉTODO (o mesmo do relatório docs/notificacoes/fase0-validacao-telefones.md,
 * para que os números dos dois batam):
 *   A) leitura INTERNACIONAL — "+" + dígitos;
 *   B) leitura NACIONAL BRASILEIRA — os mesmos dígitos lidos como número do
 *      Brasil, testada porque é a corrupção que os dados mostram.
 * Duas leituras válidas = ambiguidade real. Não se adivinha: quarentena.
 *
 * REGRA DE OURO: só `ENVIAVEL` recebe mensagem. Todo o resto segue por e-mail.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export type QualidadeTelefone =
  /** Uma única leitura válida, e a linha aceita WhatsApp. */
  | "ENVIAVEL"
  /** Válido, mas é fixo/VoIP — não existe WhatsApp nessa linha. */
  | "ENVIAVEL_NAO_MOVEL"
  /** Válido como internacional E como nacional brasileiro: pode ser outra pessoa. */
  | "AMBIGUO_BR"
  /** Inválido como internacional, válido como brasileiro: provavelmente falta o +55. */
  | "CORRIGIVEL_BR"
  /** Nenhuma leitura válida. */
  | "INVALIDO"
  /** Campo vazio. */
  | "VAZIO";

export type AvaliacaoTelefone = {
  qualidade: QualidadeTelefone;
  /**
   * E.164 do número válido. Preenchido em `ENVIAVEL` e em `ENVIAVEL_NAO_MOVEL` (linha fixa válida —
   * v12: casa marcada pelo fundador pode receber no fixo). Para o CLIENTE, o único portão continua
   * sendo `podeReceberWhatsApp`, que exige `ENVIAVEL`.
   */
  e164: string | null;
  pais: string | null;
  tipo: string | null;
  /** Frase curta para log e finding — nunca contém o número. */
  motivo: string;
};

/** Tipos de linha em que o WhatsApp é plausível. FIXED_LINE nunca tem. */
const TIPO_MOVEL = new Set(["MOBILE", "FIXED_LINE_OR_MOBILE"]);

function ler(entrada: string, pais?: "BR") {
  try {
    const p = pais ? parsePhoneNumberFromString(entrada, pais) : parsePhoneNumberFromString(entrada);
    if (!p || !p.isValid()) return null;
    return { e164: p.number, pais: p.country ?? "??", tipo: p.getType() ?? "DESCONHECIDO" };
  } catch {
    return null;
  }
}

export function avaliarTelefone(bruto: string | null | undefined): AvaliacaoTelefone {
  const digitos = String(bruto ?? "").replace(/\D/g, "");

  if (digitos.length === 0) {
    return { qualidade: "VAZIO", e164: null, pais: null, tipo: null, motivo: "telefone ausente" };
  }
  // E.164 admite no máximo 15 dígitos; abaixo de 8 não há número discável.
  if (digitos.length > 15 || digitos.length < 8) {
    return {
      qualidade: "INVALIDO", e164: null, pais: null, tipo: null,
      motivo: `comprimento fora do E.164 (${digitos.length} dígitos)`,
    };
  }

  const intl = ler("+" + digitos);
  const br = digitos.length >= 10 && digitos.length <= 11 ? ler(digitos, "BR") : null;

  if (intl && br) {
    return {
      qualidade: "AMBIGUO_BR", e164: null, pais: intl.pais, tipo: intl.tipo,
      motivo: `duas leituras válidas (${intl.pais} internacional ou BR nacional) — não se adivinha`,
    };
  }
  if (intl) {
    const movel = TIPO_MOVEL.has(intl.tipo);
    return {
      qualidade: movel ? "ENVIAVEL" : "ENVIAVEL_NAO_MOVEL",
      e164: intl.e164,
      pais: intl.pais,
      tipo: intl.tipo,
      motivo: movel ? `válido em ${intl.pais}` : `linha ${intl.tipo} em ${intl.pais} — sem WhatsApp`,
    };
  }
  if (br) {
    return {
      qualidade: "CORRIGIVEL_BR", e164: null, pais: "BR", tipo: br.tipo,
      motivo: "parece número brasileiro sem o código do país — confirmar com o cliente",
    };
  }
  return {
    qualidade: "INVALIDO", e164: null, pais: null, tipo: null,
    motivo: "nenhuma leitura válida",
  };
}

/** Único ponto de decisão do outbound: se isto é falso, não se envia. */
export function podeReceberWhatsApp(a: AvaliacaoTelefone): a is AvaliacaoTelefone & { e164: string } {
  return a.qualidade === "ENVIAVEL" && typeof a.e164 === "string" && a.e164.length > 0;
}
