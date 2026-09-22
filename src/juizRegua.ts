/**
 * juizRegua.ts — a régua do Juiz de Conversa (lógica pura, sem I/O, sem config).
 * Isolada para ser testável sem subir o pool do banco nem exigir envs — mesmo motivo
 * do historyTrim.ts. O ciclo (coleta, modelo, gravação, escalação) fica em juiz.ts.
 */

export const RUBRICA = [
  "idioma_ok",               // responde no idioma em que o cliente escreveu
  "sem_prazo",               // não promete prazo de terceiro nem de etapa humana
  "sem_vocabulario_interno", // sem SLA, tool, tabela, "escalei", "registrei", JSON
  "discricao",               // não expõe processo, fila, falha ou "não é parceiro"
  "resolve_agora",           // oferece o que já foi feito e o que o cliente recebe agora
  "tom_marca",               // cordial, preciso, sem hype, sem pedir desculpas em série
] as const;
export type Criterio = (typeof RUBRICA)[number];

export const NOTA_MINIMA = 5; // de 6: uma falha tolerada, exceto prazo prometido

export interface Veredito {
  message_id: number;
  notas: Record<Criterio, 0 | 1>;
  nota: number;
  motivo: string;
}

export interface ResumoJulgamento {
  total: number;
  reprovadas: number;   // nota < NOTA_MINIMA
  prazos: number;       // sem_prazo = 0 (sempre reprova, mesmo com nota alta)
  idioma: number;       // idioma_ok = 0
  media: number;        // média das notas, 1 casa
  ids_reprovadas: number[];
}

/**
 * Interpreta o texto devolvido pelo modelo. Pura e estrita:
 *  - só aceita ids que foram enviados para julgamento (o modelo não inventa mensagens);
 *  - nota fora de {0,1} vira 0 (na dúvida, reprova — nunca aprova por acidente);
 *  - critério ausente vira 0;
 *  - id repetido: fica o primeiro.
 * Texto sem array JSON → lança (o chamador registra falha, não grava nada).
 */
export function interpretarVeredito(texto: string, esperados: number[]): Veredito[] {
  const m = texto.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("veredito sem array JSON");
  let bruto: unknown;
  try {
    bruto = JSON.parse(m[0]);
  } catch {
    throw new Error("veredito com JSON inválido");
  }
  if (!Array.isArray(bruto)) throw new Error("veredito não é array");

  const permitidos = new Set(esperados);
  const vistos = new Set<number>();
  const out: Veredito[] = [];
  for (const item of bruto as Array<Record<string, unknown>>) {
    if (!item || typeof item !== "object") continue;
    const id = Number(item.id);
    if (!Number.isInteger(id) || !permitidos.has(id) || vistos.has(id)) continue;
    vistos.add(id);
    const notasBrutas = (item.notas && typeof item.notas === "object" ? item.notas : {}) as Record<string, unknown>;
    const notas = {} as Record<Criterio, 0 | 1>;
    let soma = 0;
    for (const c of RUBRICA) {
      const v = notasBrutas[c];
      const n: 0 | 1 = v === 1 || v === true || v === "1" ? 1 : 0;
      notas[c] = n;
      soma += n;
    }
    const motivo = String(item.motivo ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    out.push({ message_id: id, notas, nota: soma, motivo });
  }
  return out;
}

export function resumirVereditos(v: Veredito[]): ResumoJulgamento {
  const reprovadas = v.filter((x) => x.nota < NOTA_MINIMA || x.notas.sem_prazo === 0);
  const media = v.length ? Math.round((v.reduce((a, x) => a + x.nota, 0) / v.length) * 10) / 10 : 0;
  return {
    total: v.length,
    reprovadas: reprovadas.length,
    prazos: v.filter((x) => x.notas.sem_prazo === 0).length,
    idioma: v.filter((x) => x.notas.idioma_ok === 0).length,
    media,
    ids_reprovadas: reprovadas.map((x) => x.message_id).sort((a, b) => a - b),
  };
}

