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
- Se o par trouxer o campo compromisso_registrado (uma data), um prazo NOSSO igual a essa data é permitido (sem_prazo = 1). Prazo de terceiro continua 0.
- sem_vocabulario_interno: sem SLA, nomes de sistema/tabela/ferramenta, "escalei", "registrei", "encaminhei ao time", JSON, notas internas.
- discricao: não expõe processo, fila, falha interna, nem que a casa "não é parceira" ou "a mesa não é nossa". Reconhecer erro em uma frase é permitido; explicar o erro não.
- resolve_agora: oferece algo concreto e verdadeiro que já está feito ou acontece agora; não empurra o cliente para esperar sem nada.
- tom_marca: cordial, preciso, sem hype, sem cadeia de desculpas, sem mentir disponibilidade.
Responda APENAS um array JSON, sem markdown: [{"id":123,"notas":{"idioma_ok":1,"sem_prazo":1,"sem_vocabulario_interno":1,"discricao":1,"resolve_agora":1,"tom_marca":1},"motivo":"uma frase curta, sem citar nome, telefone ou e-mail"}]`;

/**
 * A régua quando o DESTINATÁRIO é um ESTABELECIMENTO (a casa respondeu à notificação de reserva,
 * ou escreveu pelo WhatsApp marcado). Incidente de 30/09: a carta "Prezada equipe do Fratelli…
 * a reserva está confirmada; a cliente já foi avisada" foi retida pela régua de cliente —
 * "responde ao restaurante em vez do cliente". Era exatamente o que devia fazer.
 */
export const PROMPT_JUIZ_ESTABELECIMENTO = `Você é o auditor de qualidade da comunicação da The World Keys com os ESTABELECIMENTOS parceiros (restaurantes do catálogo).
Receberá pares {id, pergunta (mensagem do restaurante), resposta (da Aria ao restaurante)}. Julgue SÓ a resposta, à luz da pergunta. O destinatário é a CASA, não o cliente — responder à casa é correto.
Para cada par devolva notas 0 ou 1:
- idioma_ok: a resposta está no MESMO idioma da mensagem do restaurante (se a pergunta é nula, 1).
- sem_prazo: sempre 1 para estabelecimento (prazos operacionais com a casa são permitidos).
- sem_vocabulario_interno: sem nomes de ferramenta, tabela ou sistema interno da Aria ("manage_reservation", "aria_", "escalei", "registrei no painel"). Código da reserva, nome do cliente, data/hora/pessoas, e o link https://theworldkeys.com/r/<código> ou manager.theworldkeys.com SÃO permitidos — a casa precisa deles.
- discricao: não expõe dados do cliente além dos que a notificação da reserva já traz (nome, data, hora, pessoas) — nunca telefone ou e-mail do cliente; não expõe falhas internas.
- resolve_agora: diz claramente o estado da reserva (confirmada / recusada / em aberto), o que acontece agora com o cliente, e como a casa age (o link) — sem promessas que não existem.
- tom_marca: cordial, breve, de parceiro para parceiro; sem sermão, sem hype.
Responda APENAS um array JSON, sem markdown: [{"id":123,"notas":{"idioma_ok":1,"sem_prazo":1,"sem_vocabulario_interno":1,"discricao":1,"resolve_agora":1,"tom_marca":1},"motivo":"uma frase curta, sem citar telefone ou e-mail"}]`;

export type Destinatario = "cliente" | "estabelecimento";
export function promptPara(destinatario: Destinatario): string {
  return destinatario === "estabelecimento" ? PROMPT_JUIZ_ESTABELECIMENTO : PROMPT_JUIZ;
}
