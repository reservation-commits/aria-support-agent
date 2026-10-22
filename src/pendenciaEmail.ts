/**
 * pendenciaEmail.ts — as duas cartas de pendência ao cliente, por E-MAIL (lógica pura, sem I/O).
 *
 * POR QUE EXISTE (v22, 2026-10-22, planos B2/B3)
 * As mensagens "seu pedido segue conosco" (24 h depois) e "encerramento honesto" (véspera) só saíam por
 * WhatsApp — e nenhum cliente tinha opt-in: em 30 dias, 168 tentativas morreram em `sem_opt_in` e 93 em
 * telefone inválido. O cliente que mais precisava ouvir a verdade era o que menos a recebia. Agora, quando
 * o WhatsApp não é possível, a MESMA mensagem sai por e-mail (o canal pelo qual o pedido foi feito).
 *
 * Regras do ADR-015 embutidas no texto: nada de prazo, nada de processo, nada de "o restaurante não
 * respondeu" como culpa de alguém, nenhuma promessa de mesa. O que já está feito + o que ele recebe +
 * uma ação que a Aria executa agora (procurar outra casa). Idioma = o do cliente, nunca o do restaurante.
 * Mesma fórmula da carta de exclusão aprovada em 14/09 (maestro-atendimento/exclusao.js).
 */

import { languageForPhone, type BaseLang } from "./locale.js";
import { normalizarIdioma } from "./templateLocale.js";

export type TipoCartaPendencia = "pending_nudge" | "pending_close";

export interface DadosCarta {
  nome: string;         // primeiro nome (pode ser vazio)
  restaurante: string;
  data: string;         // já formatada por eventFormat (dia da semana + data, no idioma)
  hora: string;         // já formatada (HH:MM ou 7:30 PM)
}

export interface CartaPendencia { assunto: string; corpo: string; idioma: BaseLang }

const T: Record<BaseLang, Record<TipoCartaPendencia, { assunto: (d: DadosCarta) => string; corpo: (d: DadosCarta) => string }>> = {
  en: {
    pending_nudge: {
      assunto: (d) => `Your request at ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("en", d.nome)}\n\n` +
        `Your request at ${d.restaurante} for ${d.data} at ${d.hora} is with us and remains open.\n\n` +
        `If you would rather not wait, tell me what you are in the mood for and I will look for another address nearby and send it to you.\n\n` +
        `Reply to this e-mail; it reaches me directly.\n\nWith pleasure,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `Your request at ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("en", d.nome)}\n\n` +
        `I do not have a confirmation from the restaurant for your request at ${d.restaurante} on ${d.data} at ${d.hora}, and I do not want you to count on a table that has not been confirmed.\n\n` +
        `Tell me what you are in the mood for and the time that suits you: I will look for another address in the area and send it to you.\n\n` +
        `Reply to this e-mail; it reaches me directly.\n\nWith pleasure,\nAria · The World Keys`,
    },
  },
  pt: {
    pending_nudge: {
      assunto: (d) => `O seu pedido no ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("pt", d.nome)}\n\n` +
        `O seu pedido de mesa no ${d.restaurante} para ${d.data} às ${d.hora} está connosco e continua em aberto.\n\n` +
        `Se preferir não esperar, diga-me o que lhe apetece e eu procuro outra morada por perto e envio-lha.\n\n` +
        `Responda a este e-mail; chega-me diretamente.\n\nCom todo o gosto,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `O seu pedido no ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("pt", d.nome)}\n\n` +
        `Não tenho uma confirmação do restaurante para o seu pedido no ${d.restaurante} em ${d.data} às ${d.hora}, e não quero que conte com uma mesa que não foi confirmada.\n\n` +
        `Diga-me o que lhe apetece e o horário que lhe convém: procuro outra morada na zona e envio-lha.\n\n` +
        `Responda a este e-mail; chega-me diretamente.\n\nCom todo o gosto,\nAria · The World Keys`,
    },
  },
  es: {
    pending_nudge: {
      assunto: (d) => `Su solicitud en ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("es", d.nome)}\n\n` +
        // "para el <día>" é lido pela porta de saída como data prometida; a data da reserva vai entre parênteses.
        `Su solicitud de mesa en ${d.restaurante} (${d.data}, ${d.hora}) está con nosotros y sigue abierta.\n\n` +
        `Si prefiere no esperar, dígame qué le apetece y buscaré otra dirección cerca para enviársela.\n\n` +
        `Responda a este correo; me llega directamente.\n\nCon mucho gusto,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `Su solicitud en ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("es", d.nome)}\n\n` +
        `No tengo una confirmación del restaurante para su solicitud en ${d.restaurante} el ${d.data} a las ${d.hora}, y no quiero que cuente con una mesa que no ha sido confirmada.\n\n` +
        `Dígame qué le apetece y la hora que le conviene: buscaré otra dirección en la zona y se la enviaré.\n\n` +
        `Responda a este correo; me llega directamente.\n\nCon mucho gusto,\nAria · The World Keys`,
    },
  },
  fr: {
    pending_nudge: {
      assunto: (d) => `Votre demande chez ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("fr", d.nome)}\n\n` +
        `Votre demande de table chez ${d.restaurante} pour le ${d.data} à ${d.hora} est entre nos mains et reste ouverte.\n\n` +
        `Si vous préférez ne pas attendre, dites-moi ce qui vous ferait plaisir et je chercherai une autre adresse à proximité pour vous l'envoyer.\n\n` +
        `Répondez à cet e-mail ; il m'arrive directement.\n\nAvec plaisir,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `Votre demande chez ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("fr", d.nome)}\n\n` +
        `Je n'ai pas de confirmation du restaurant pour votre demande chez ${d.restaurante} le ${d.data} à ${d.hora}, et je ne veux pas que vous comptiez sur une table qui n'a pas été confirmée.\n\n` +
        `Dites-moi ce qui vous ferait plaisir et l'heure qui vous convient : je chercherai une autre adresse dans le quartier et je vous l'enverrai.\n\n` +
        `Répondez à cet e-mail ; il m'arrive directement.\n\nAvec plaisir,\nAria · The World Keys`,
    },
  },
  it: {
    pending_nudge: {
      assunto: (d) => `La sua richiesta da ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("it", d.nome)}\n\n` +
        `La sua richiesta di tavolo da ${d.restaurante} per ${d.data} alle ${d.hora} è con noi e resta aperta.\n\n` +
        `Se preferisce non aspettare, mi dica cosa le piacerebbe e cercherò un altro indirizzo nelle vicinanze da inviarle.\n\n` +
        `Risponda a questa e-mail; mi arriva direttamente.\n\nCon piacere,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `La sua richiesta da ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("it", d.nome)}\n\n` +
        `Non ho una conferma dal ristorante per la sua richiesta da ${d.restaurante} il ${d.data} alle ${d.hora}, e non voglio che conti su un tavolo che non è stato confermato.\n\n` +
        `Mi dica cosa le piacerebbe e l'orario che preferisce: cercherò un altro indirizzo in zona e glielo invierò.\n\n` +
        `Risponda a questa e-mail; mi arriva direttamente.\n\nCon piacere,\nAria · The World Keys`,
    },
  },
  de: {
    pending_nudge: {
      assunto: (d) => `Ihre Anfrage im ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("de", d.nome)}\n\n` +
        `Ihre Tischanfrage im ${d.restaurante} für ${d.data} um ${d.hora} liegt bei uns und ist weiterhin offen.\n\n` +
        `Wenn Sie lieber nicht warten möchten, sagen Sie mir, worauf Sie Lust haben, und ich suche eine andere Adresse in der Nähe und schicke sie Ihnen.\n\n` +
        `Antworten Sie einfach auf diese E-Mail; sie erreicht mich direkt.\n\nMit Freude,\nAria · The World Keys`,
    },
    pending_close: {
      assunto: (d) => `Ihre Anfrage im ${d.restaurante}`,
      corpo: (d) =>
        `${sauda("de", d.nome)}\n\n` +
        `Ich habe keine Bestätigung des Restaurants für Ihre Anfrage im ${d.restaurante} am ${d.data} um ${d.hora}, und ich möchte nicht, dass Sie mit einem Tisch rechnen, der nicht bestätigt wurde.\n\n` +
        `Sagen Sie mir, worauf Sie Lust haben und welche Uhrzeit Ihnen passt: Ich suche eine andere Adresse in der Gegend und schicke sie Ihnen.\n\n` +
        `Antworten Sie einfach auf diese E-Mail; sie erreicht mich direkt.\n\nMit Freude,\nAria · The World Keys`,
    },
  },
};

function sauda(idioma: BaseLang, nome: string): string {
  const n = nome.trim();
  const s: Record<BaseLang, [string, string]> = {
    en: ["Hello", "Hello,"], pt: ["Olá", "Olá,"], es: ["Hola", "Hola,"], fr: ["Bonjour", "Bonjour,"], it: ["Buongiorno", "Buongiorno,"], de: ["Guten Tag", "Guten Tag,"],
  };
  return n ? `${s[idioma][0]} ${n},` : s[idioma][1];
}

/**
 * Idioma da carta: a preferência registrada (opt-in) vence; senão o país do telefone do cliente, se
 * inequívoco; senão inglês. NUNCA o país do restaurante (incidente La Petite Maison, 14/09).
 */
export function idiomaDaCarta(p: { idiomaPreferido?: string | null; phone?: string | null }): BaseLang {
  const pref = normalizarIdioma(p.idiomaPreferido);
  if (pref) return pref;
  const tel = (p.phone ?? "").trim();
  if (tel.startsWith("+")) {
    const a = languageForPhone(tel, "en");
    const b = languageForPhone(tel, "pt");
    if (a === b) return a; // país conhecido: o resultado não depende do fallback
  }
  return "en";
}

export function cartaPendencia(tipo: TipoCartaPendencia, idioma: BaseLang, d: DadosCarta): CartaPendencia {
  const t = T[idioma] ?? T.en;
  return { assunto: t[tipo].assunto(d), corpo: t[tipo].corpo(d), idioma: T[idioma] ? idioma : "en" };
}

export const IDIOMAS_CARTA = Object.keys(T) as BaseLang[];
