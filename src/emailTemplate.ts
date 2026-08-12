/**
 * emailTemplate.ts — template HTML de email da Aria, na identidade visual
 * REAL de theworldkeys.com (tokens extraídos do site em 2026-07-12):
 *
 *   ink #070b10 · charcoal #0f1218 · warm #181c24 · cream #ede9df ·
 *   off-white #f7f4ef · gold #c9a96e / light #e4c990 / dark #9e7c48 ·
 *   silver #9a97a8 · Cormorant Garamond (display) + Jost (texto) · cantos retos
 *
 * Decisões de EMAIL (≠ web): layout em tabelas com estilos inline (Outlook),
 * largura 600px, base CLARA (cream/ink/ouro) — fundo escuro sofre inversões
 * erráticas de dark-mode no Gmail/Outlook — com faixa de cabeçalho ink e
 * wordmark serifado dourado. Fontes com fallback de sistema: Cormorant →
 * Georgia; Jost → Segoe UI/Helvetica (webfonts não carregam na maioria dos
 * clientes). Módulo PURO e testável.
 */

const C = {
  ink: "#070b10",
  paper: "#ede9df",     // fundo externo (cream do site)
  card: "#f7f4ef",      // cartão (twk-white)
  text: "#1d222b",      // ink suavizado para leitura longa
  muted: "#6e6a5e",
  hairline: "#ddd6c6",
  gold: "#c9a96e",
  goldLight: "#e4c990",
  goldDark: "#9e7c48",
  silver: "#9a97a8",
};

const SERIF = `'Cormorant Garamond', Georgia, 'Times New Roman', serif`;
const SANS = `'Jost', 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif`;

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
        `style="display:block;border:0;opacity:0.75;" /></a></td>`,
    ).join("");
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>`;
  }
  // Fallback sem hospedagem de imagem: emoji + rótulo.
  const cells = CONTACTS.map(
    (c) =>
      `<td style="padding:0 11px;text-align:center;font-family:${SANS};font-size:11px;color:${C.muted};">` +
      `<a href="${c.href}" target="_blank" style="text-decoration:none;color:${C.goldDark};">` +
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
      return `<a href="${href}" style="color:${C.goldDark};font-weight:500;text-decoration:underline;text-decoration-color:${C.gold};" target="_blank">${url}</a>`;
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
        `<p style="margin:0 0 18px;font-family:${SANS};font-size:15.5px;line-height:1.75;color:${C.text};">${p}</p>`,
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
): string {
  const content = paragraphs(bodyText);
  const preheader = escHtml(bodyText.trim().split("\n")[0] ?? "").slice(0, 140);
  const lang = langOverride ?? detectLang(bodyText);
  const chrome = CHROME[lang];
  const replyLine = chrome.reply
    .replace("{b}", `<strong style="color:${C.text};font-weight:600;">`)
    .replace("{/b}", "</strong>");
  const contacts = contactRow(chrome, iconBaseUrl.replace(/\/+$/, ""));

  return `<!doctype html>
<html lang="pt" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>The World Keys</title>
</head>
<body style="margin:0;padding:0;background-color:${C.paper};">
<!-- preheader (oculto): primeira linha da mensagem no preview da caixa -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.paper}" style="background-color:${C.paper};">
<tr><td align="center" style="padding:28px 14px;">

  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

    <!-- ═══ Cabeçalho: faixa ink com wordmark dourado ═══ -->
    <tr><td bgcolor="${C.ink}" style="background-color:${C.ink};padding:30px 40px 26px;text-align:center;">
      <div style="font-family:${SERIF};font-size:27px;font-weight:400;letter-spacing:6px;color:${C.gold};">THE&nbsp;WORLD&nbsp;KEYS</div>
      <div style="font-family:${SANS};font-size:10.5px;font-weight:400;letter-spacing:4px;color:${C.silver};padding-top:9px;">${chrome.tagline}</div>
    </td></tr>

    <!-- fio dourado -->
    <tr><td style="height:2px;line-height:2px;font-size:2px;background:linear-gradient(90deg,${C.goldDark},${C.goldLight},${C.goldDark});background-color:${C.gold};">&nbsp;</td></tr>

    <!-- ═══ Corpo ═══ -->
    <tr><td bgcolor="${C.card}" style="background-color:${C.card};padding:38px 44px 22px;">
${content}
    </td></tr>

    <!-- assinatura visual -->
    <tr><td bgcolor="${C.card}" style="background-color:${C.card};padding:0 44px 36px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td style="border-top:1px solid ${C.hairline};padding-top:20px;">
          <div style="font-family:${SERIF};font-size:19px;font-style:italic;color:${C.goldDark};">Aria</div>
          <div style="font-family:${SANS};font-size:11px;letter-spacing:2.5px;color:${C.muted};padding-top:4px;">THE&nbsp;WORLD&nbsp;KEYS</div>
        </td></tr>
      </table>
    </td></tr>

    <!-- ═══ Rodapé: ícones de contato (marca d'água) + nota + fine print ═══ -->
    <tr><td align="center" style="padding:20px 30px 6px;">
      ${contacts}
    </td></tr>
    <tr><td style="padding:14px 30px 8px;text-align:center;">
      <p style="margin:0 0 12px;font-family:${SANS};font-size:12px;line-height:1.7;color:${C.muted};">
        ${replyLine}
      </p>
      <p style="margin:0;font-family:${SANS};font-size:10.5px;letter-spacing:1.5px;color:${C.silver};">
        THE&nbsp;WORLD&nbsp;KEYS&nbsp;&middot;&nbsp;PARIS&nbsp;&middot;&nbsp;${new Date().getFullYear()}
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}
