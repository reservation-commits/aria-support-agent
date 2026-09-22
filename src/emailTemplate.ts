/**
 * emailTemplate.ts — carta da Aria no PADRÃO TWK DE NOTIFICAÇÕES (2026-09-11).
 *
 *   fundo #0B0A08 · cartão #12100C com borda #26200F e cantos 16px ·
 *   dourado #CE9E3C / claro #E6C87A · texto forte #F5EFE3 · corpo #B5AB93 ·
 *   títulos em Georgia · chave animada + wordmark + PARIS · rodapé institucional
 *
 * Por que mudou: até 11/09 a carta da Aria era clara (cream/ink), por receio de
 * inversão de dark-mode no Gmail/Outlook. Os e-mails transacionais escuros já
 * circulam há semanas sem esse problema, e o cliente passou a receber duas
 * identidades diferentes da mesma marca. O fundador pediu uma só: a das
 * notificações. `color-scheme: dark` declarado evita a inversão automática.
 *
 * Decisões de EMAIL (≠ web): tabelas com estilo inline (Outlook), 600px, fontes
 * de sistema (Georgia/Arial — webfont não carrega na maioria dos clientes),
 * imagens só logo e wordmark. Módulo PURO e testável.
 */

// Paleta do padrão TWK de notificações (2026-09-11): cartão escuro, dourado,
// títulos em Georgia. É a mesma dos e-mails transacionais que o cliente já recebe.
const C = {
  ink: "#0B0A08",       // fundo externo
  paper: "#0B0A08",
  card: "#12100C",      // cartão
  cardInner: "#1A1611",  // cartão de detalhes dentro do cartão
  text: "#F5EFE3",      // texto forte (títulos, valores)
  body: "#B5AB93",      // corpo de leitura
  muted: "#8F8368",
  hairline: "#26200F",
  gold: "#CE9E3C",
  goldLight: "#E6C87A",
  goldDark: "#8C6A28",
  silver: "#6E6551",
};

const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `Arial, Helvetica, sans-serif`;
const LOGO = "https://theworldkeys.com/images/twk-logo.gif";
const WORDMARK = "https://img.mailinblue.com/6331555/images/content_library/original/661430b29475332809dc25ad.png";

export type EmailLang = "pt" | "en" | "es" | "fr" | "it";

/**
 * Detecta o idioma (pt/en/es/fr/it) do corpo da resposta para localizar o
 * "chrome" do email (subtítulo, rodapé, rótulo de link). Puro; âncora forte no
 * fecho do concierge ("Com prazer em servir" / "With pleasure" / "Avec plaisir"
 * / "Con mucho gusto" / "Con piacere"). Default 'pt' quando ambíguo.
 */
export function detectLang(text: string): EmailLang {
  const t = " " + (text ?? "").toLowerCase() + " ";
  const score: Record<EmailLang, number> = { pt: 0, en: 0, es: 0, fr: 0, it: 0 };
  const bump = (lang: EmailLang, re: RegExp, w: number) => {
    const m = t.match(re);
    if (m) score[lang] += m.length * w;
  };
  // Âncora forte: assinatura do concierge.
  bump("pt", /prazer em servir/g, 8);
  bump("en", /with pleasure/g, 8);
  bump("fr", /avec plaisir/g, 8);
  bump("es", /con (?:mucho )?gusto/g, 8);
  bump("it", /con piacere/g, 8);
  // Saudação.
  bump("pt", /\b(?:prezad|olá|bom dia|boa (?:tarde|noite))\w*/g, 3);
  bump("en", /\b(?:dear|hello|hi|good (?:morning|afternoon|evening))\b/g, 3);
  bump("es", /\b(?:estimad|hola|buenos días|buenas (?:tardes|noches))\w*/g, 3);
  bump("fr", /\b(?:cher|chère|bonjour|bonsoir)\b/g, 3);
  bump("it", /\b(?:gentile|buongiorno|buonasera|salve)\b/g, 3);
  // Palavras funcionais distintivas.
  bump("pt", /\b(?:você|não|obrigad\w*|sua|com|então|disposição)\b/g, 1);
  bump("en", /\b(?:the|you|your|with|thank|please|reservation)\b/g, 1);
  bump("es", /\b(?:usted|gracias|con|su|cuenta|reserva)\b/g, 1);
  bump("fr", /\b(?:vous|merci|votre|avec|réservation|compte)\b/g, 1);
  bump("it", /\b(?:grazie|prenotazione|vostr\w*|disposizione|ristorante|squadra|subito)\b/g, 1);
  // Sinais ortográficos.
  bump("es", /[¿¡ñ]/g, 2);
  bump("pt", /[ãõç]/g, 1);
  bump("fr", /[êîôûë]/g, 1);
  bump("it", /\b(?:perché|più|così|già)\b/g, 2);

  let best: EmailLang = "pt";
  for (const k of ["en", "es", "fr", "it"] as EmailLang[]) {
    if (score[k] > score[best]) best = k;
  }
  return best;
}

// "Chrome" localizado do email (tudo que NÃO é o corpo do agente).
type ChromeStr = { tagline: string; reply: string; site: string; reservations: string };
const CHROME: Record<EmailLang, ChromeStr> = {
  pt: {
    tagline: "ARIA&nbsp;&middot;&nbsp;CONCIERGE&nbsp;&amp;&nbsp;RESERVAS",
    reply: "Basta {b}responder este email{/b} para continuar falando com a Aria.",
    site: "Site",
    reservations: "Reservas",
  },
  en: {
    tagline: "ARIA&nbsp;&middot;&nbsp;CONCIERGE&nbsp;&amp;&nbsp;RESERVATIONS",
    reply: "Simply {b}reply to this email{/b} to continue speaking with Aria.",
    site: "Website",
    reservations: "Reservations",
  },
  es: {
    tagline: "ARIA&nbsp;&middot;&nbsp;CONSERJER&Iacute;A&nbsp;&amp;&nbsp;RESERVAS",
    reply: "Basta con {b}responder a este correo{/b} para seguir hablando con Aria.",
    site: "Sitio",
    reservations: "Reservas",
  },
  fr: {
    tagline: "ARIA&nbsp;&middot;&nbsp;CONCIERGERIE&nbsp;&amp;&nbsp;R&Eacute;SERVATIONS",
    reply: "Il vous suffit de {b}r&eacute;pondre &agrave; cet email{/b} pour continuer avec Aria.",
    site: "Site",
    reservations: "R&eacute;servations",
  },
  it: {
    tagline: "ARIA&nbsp;&middot;&nbsp;CONCIERGE&nbsp;&amp;&nbsp;PRENOTAZIONI",
    reply: "Basta {b}rispondere a questa email{/b} per continuare a parlare con Aria.",
    site: "Sito",
    reservations: "Prenotazioni",
  },
};

// Contatos do rodapé (ícones em marca d'água). Ordem fixa.
const CONTACTS = [
  { key: "whatsapp", href: "https://wa.me/5521967841007", alt: "WhatsApp", emoji: "\u{1F4AC}" },
  { key: "email", href: "mailto:support@theworldkeys.com", alt: "Email", emoji: "✉️" },
  { key: "site", href: "https://theworldkeys.com/", alt: "site", emoji: "\u{1F310}" },
  { key: "reservas", href: "https://theworldkeys.com/users/reservations", alt: "reservations", emoji: "\u{1F37D}️" },
] as const;

/**
 * Fileira de ícones de contato do rodapé. Com `iconBaseUrl`, usa os PNGs
 * dourados hospedados (marca d'água, opacidade suave), com o rótulo como alt
 * (visível mesmo se o cliente bloquear imagens). Sem base, cai num rodapé de
 * emoji + rótulo, para nunca ficar sem contato.
 */
function contactRow(chrome: ChromeStr, iconBaseUrl: string): string {
  const label = (c: (typeof CONTACTS)[number]) =>
    c.key === "site" ? chrome.site : c.key === "reservas" ? chrome.reservations : c.alt;

  if (iconBaseUrl) {
    const cells = CONTACTS.map(
      (c) =>
        `<td style="padding:0 13px;"><a href="${c.href}" target="_blank" style="text-decoration:none;">` +
        `<img src="${iconBaseUrl}/icons/${c.key}.png" width="26" height="26" alt="${label(c)}" ` +
        `style="display:block;border:0;opacity:0.9;" /></a></td>`,
    ).join("");
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>`;
  }
  // Fallback sem hospedagem de imagem: emoji + rótulo.
  const cells = CONTACTS.map(
    (c) =>
      `<td style="padding:0 11px;text-align:center;font-family:${SANS};font-size:11px;color:${C.muted};">` +
      `<a href="${c.href}" target="_blank" style="text-decoration:none;color:${C.goldLight};">` +
      `<span style="font-size:18px;">${c.emoji}</span><br/>${label(c)}</a></td>`,
  ).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Converte URLs em links dourados clicáveis. Reconhece http(s):// e domínios
 * theworldkeys.com sem protocolo (como a Aria escreve: "theworldkeys.com/...").
 */
function autolink(escaped: string): string {
  // O lookbehind (?<![@\w.]) impede linkar o domínio DENTRO de um email
  // (support@theworldkeys.com) ou de um subdomínio — só linka a URL "solta".
  return escaped.replace(
    /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"']|(?<![@\w.])(?:www\.)?theworldkeys\.com(?:\/[^\s<]*[^\s<.,;:!?)"'])?/g,
    (url) => {
      const href = url.startsWith("http") ? url : `https://${url}`;
      return `<a href="${href}" style="color:${C.goldLight};font-weight:600;text-decoration:underline;text-decoration-color:${C.goldDark};" target="_blank">${url}</a>`;
    },
  );
}

/** Corpo em texto puro → parágrafos HTML (parágrafo = linha em branco). */
function paragraphs(bodyText: string): string {
  return bodyText
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((p) => autolink(escHtml(p)).replace(/\n/g, "<br/>"))
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.65;color:${C.body};">${p}</p>`,
    )
    .join("\n");
}

/**
 * Renderiza o email completo da Aria. `bodyText` é a resposta em texto puro do
 * agente (com saudação e assinatura dela) — o template embala com a marca.
 */
export function renderEmailHtml(
  bodyText: string,
  langOverride?: EmailLang,
  iconBaseUrl = "",
  titulo = "",
): string {
  const content = paragraphs(bodyText);
  const preheader = escHtml(bodyText.trim().split("\n")[0] ?? "").slice(0, 140);
  const lang = langOverride ?? detectLang(bodyText);
  const chrome = CHROME[lang];
  const replyLine = chrome.reply
    .replace("{b}", `<strong style="color:${C.text};font-weight:600;">`)
    .replace("{/b}", "</strong>");
  const contacts = contactRow(chrome, iconBaseUrl.replace(/\/+$/, ""));
  // A Aria assina no próprio corpo ("Com prazer, Aria"). Repetir o nome no bloco
  // de assinatura deixava "Aria" duas vezes seguidas — aqui ele só aparece quando
  // a carta não termina assinada.
  const jaAssinou = /^\s*aria\b/i.test((bodyText.trim().split("\n").filter((l) => l.trim()).pop() ?? ""));
  const assinaturaNome = jaAssinou
    ? ""
    : `          <div style="font-family:${SERIF};font-size:19px;font-style:italic;color:${C.goldLight};">Aria</div>\n`;
  const tituloHtml = titulo
    ? `    <tr><td align="center" style="padding:26px 24px 10px;">
      <h1 style="margin:0;font-family:${SERIF};font-weight:normal;font-size:24px;line-height:1.35;color:${C.text};">${escHtml(titulo)}</h1>
    </td></tr>`
    : "";

  return `<!doctype html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<meta name="supported-color-schemes" content="dark"/>
<title>The World Keys</title>
</head>
<body style="margin:0;padding:0;background-color:${C.paper};">
<!-- preheader (oculto): primeira linha da mensagem no preview da caixa -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" style="background-color:${C.paper};border-collapse:collapse;">
<tr><td align="center" style="padding:12px 6px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:600px;max-width:100%;background-color:${C.card};border:1px solid ${C.hairline};border-radius:16px;border-collapse:separate;overflow:hidden;">

    <!-- Cabeçalho: chave + wordmark + PARIS, igual aos transacionais -->
    <tr><td align="center" style="padding:36px 20px 0 20px;">
      <a href="https://theworldkeys.com/" target="_blank" style="text-decoration:none;">
        <img src="${LOGO}" width="56" alt="" style="display:block;margin:0 auto 14px auto;width:56px;height:auto;border:0;" border="0" />
        <img src="${WORDMARK}" width="220" alt="THE WORLD KEYS" style="display:block;margin:0 auto;width:220px;height:auto;border:0;" border="0" />
      </a>
      <div style="font-family:${SANS};font-size:10px;letter-spacing:4px;color:${C.muted};padding-top:10px;">${chrome.tagline}</div>
    </td></tr>

    <!-- fio dourado curto -->
    <tr><td align="center" style="padding:20px 20px 0 20px;">
      <table role="presentation" width="48" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.gold};font-size:0;line-height:0;">&nbsp;</td></tr></table>
    </td></tr>

${tituloHtml}
    <!-- Corpo: a carta da Aria -->
    <tr><td style="padding:${titulo ? "8px" : "26px"} 28px 0 28px;">
${content}
    </td></tr>

    <!-- Assinatura -->
    <tr><td style="padding:6px 28px 0 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="border-top:1px solid ${C.hairline};padding-top:18px;">
${assinaturaNome}          <div style="font-family:${SANS};font-size:11px;letter-spacing:2.5px;color:${C.muted};">THE&nbsp;WORLD&nbsp;KEYS&nbsp;&nbsp;&#183;&nbsp;&nbsp;CONCIERGE</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- Contatos + convite a responder -->
    <tr><td align="center" style="padding:22px 30px 0;">
      ${contacts}
    </td></tr>
    <tr><td align="center" style="padding:14px 28px 0;">
      <p style="margin:0;font-family:${SANS};font-size:12.5px;line-height:1.7;color:${C.muted};">${replyLine}</p>
    </td></tr>

    <!-- Rodapé institucional, idêntico ao dos transacionais -->
    <tr><td align="center" style="padding:22px 20px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
    <tr><td align="center" style="padding:16px 24px 28px 24px;">
      <p style="margin:0 0 4px 0;font-family:${SERIF};font-size:13px;letter-spacing:3px;color:${C.muted};">THE WORLD KEYS</p>
      <p style="margin:0;font-family:${SANS};font-size:11px;line-height:1.8;color:${C.silver};">
        <a href="https://theworldkeys.com/terms-of-use/" style="color:${C.muted};text-decoration:none;">Terms &amp; Conditions</a> &nbsp;&#183;&nbsp; <a href="mailto:support@theworldkeys.com" style="color:${C.muted};text-decoration:none;">support@theworldkeys.com</a><br/>
        66, Av. des Champs-&#201;lys&#233;es, 75008 Paris, France<br/>
        VAT: FR24901268326 &#183; R.C.S Paris: 901 268 326 &#183; &#169; ${new Date().getFullYear()} The World Keys
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}
