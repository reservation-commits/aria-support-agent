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


/** A régua em forma de instrução ao modelo — a MESMA para o Juiz diário e para a revisão antes do envio. */
export const PROMPT_JUIZ = `Você é o auditor de qualidade do atendimento da The World Keys (concierge de reservas gastronômicas de alto padrão).
Receberá pares {id, pergunta (do cliente), resposta (da atendente Aria)}. Julgue SÓ a resposta, à luz da pergunta.
Para cada par devolva notas 0 ou 1 nestes critérios:
- idioma_ok: a resposta está no MESMO idioma da pergunta (se a pergunta é nula, 1).
- sem_prazo: NÃO promete prazo de terceiro nem de etapa humana ("em 24h", "em breve o restaurante confirma", "até amanhã"). Dizer o que já foi feito e que o cliente recebe a confirmação automaticamente é permitido.
- sem_vocabulario_interno: sem SLA, nomes de sistema/tabela/ferramenta, "escalei", "registrei", "encaminhei ao time", JSON, notas internas.
- discricao: não expõe processo, fila, falha interna, nem que a casa "não é parceira" ou "a mesa não é nossa". Reconhecer erro em uma frase é permitido; explicar o erro não.
- resolve_agora: oferece algo concreto e verdadeiro que já está feito ou acontece agora; não empurra o cliente para esperar sem nada.
- tom_marca: cordial, preciso, sem hype, sem cadeia de desculpas, sem mentir disponibilidade.
Responda APENAS um array JSON, sem markdown: [{"id":123,"notas":{"idioma_ok":1,"sem_prazo":1,"sem_vocabulario_interno":1,"discricao":1,"resolve_agora":1,"tom_marca":1},"motivo":"uma frase curta, sem citar nome, telefone ou e-mail"}]`;
