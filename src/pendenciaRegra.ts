/**
 * pendenciaRegra.ts — regras PURAS das mensagens v16 (agenda da casa e mapa da véspera).
 * Sem config/env/IO, para rodar nos testes offline.
 */

export type MesaAgenda = { hora: string; cliente: string; pessoas: string };

/**
 * Lista das mesas de amanhã num único parâmetro de template: "19:30 Anna Lee (2) · 20:00 Marc Dupont (4)".
 * Parâmetro da Meta não aceita quebra de linha e o nosso teto é 250 caracteres; o que não couber
 * vira " · +N" — a casa vê quantas faltam e o painel tem a lista inteira.
 */
export function montarListaAgenda(mesas: MesaAgenda[], max = 250): string {
  const itens = mesas.map((m) => `${m.hora} ${m.cliente || "—"} (${m.pessoas || "?"})`.replace(/\s+/g, " ").trim());
  if (itens.length === 0) return "";
  let out = "";
  let usados = 0;
  for (const item of itens) {
    const candidato = out ? `${out} · ${item}` : item;
    const restantes = itens.length - usados - 1;
    const sufixo = restantes > 0 ? ` · +${restantes}` : "";
    if (candidato.length + sufixo.length > max) break;
    out = candidato;
    usados++;
  }
  if (usados === 0) {
    // Nem a primeira coube (nome absurdo): corta o primeiro item e sinaliza o resto.
    const resto = itens.length - 1;
    const sufixo = resto > 0 ? ` · +${resto}` : "";
    return itens[0].slice(0, Math.max(0, max - sufixo.length - 1)) + "…" + sufixo;
  }
  const faltam = itens.length - usados;
  return faltam > 0 ? `${out} · +${faltam}` : out;
}

/**
 * Sufixo do botão "Ver no mapa": nome + cidade, codificados para URL. Não usa o endereço inteiro
 * (codificado, estoura os 250 caracteres e o Google acha a casa pelo nome + cidade).
 */
export function consultaMapa(nome: string | null | undefined, cidade: string | null | undefined): string {
  const q = [nome, cidade]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  return q ? encodeURIComponent(q) : "";
}

/** Endereço pronto para a ficha: uma linha, sem quebras nem espaços duplos; "" se não houver. */
export function enderecoParaFicha(endereco: string | null | undefined): string {
  const s = (endereco ?? "").replace(/\s+/g, " ").trim();
  return s.length >= 8 ? s : "";
}
