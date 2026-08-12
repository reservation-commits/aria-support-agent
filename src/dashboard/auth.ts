import type { RequestHandler, Request } from "express";
import crypto from "node:crypto";

/**
 * HTTP Basic Auth com MÚLTIPLOS OPERADORES e papéis.
 *
 *  • DASHBOARD_USER + DASHBOARD_PASSWORD — conta legada (sempre admin).
 *  • DASHBOARD_USERS — contas adicionais, "ana:senha1,bruno:senha2".
 *  • DASHBOARD_ADMINS — usuários com papel admin, "ana,bruno" (a conta legada
 *    é admin sempre).
 *
 * O usuário autenticado fica em res.locals.operator ({ user, admin }) — toda
 * ação mutável do painel (enviar mensagem, assumir conversa, resolver
 * escalação) é auditada com o NOME REAL do operador, não um "operador" fixo.
 * Sem nenhuma conta configurada, o painel fica DESABILITADO (closed by default).
 */

export type Operator = { user: string; admin: boolean };

type Account = { user: string; pass: string; admin: boolean };

function accounts(): Account[] {
  const out: Account[] = [];
  const legacyUser = (process.env.DASHBOARD_USER ?? "").trim();
  const legacyPass = (process.env.DASHBOARD_PASSWORD ?? "").trim();
  if (legacyUser && legacyPass) out.push({ user: legacyUser, pass: legacyPass, admin: true });

  const admins = new Set(
    (process.env.DASHBOARD_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const entry of (process.env.DASHBOARD_USERS ?? "").split(",")) {
    const idx = entry.indexOf(":");
    if (idx <= 0) continue;
    const user = entry.slice(0, idx).trim();
    const pass = entry.slice(idx + 1).trim();
    if (!user || !pass || out.some((a) => a.user === user)) continue;
    out.push({ user, pass, admin: admins.has(user) });
  }
  return out;
}

/** Truthy se há ao menos uma conta configurada (painel habilitado). */
export function dashboardCredentials(): Account[] | null {
  const list = accounts();
  return list.length > 0 ? list : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compara contra si mesmo para gastar o mesmo tempo, e falha.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Operador autenticado da requisição (setado pelo middleware). */
export function operatorFrom(req: Request): Operator {
  const op = (req.res?.locals as { operator?: Operator } | undefined)?.operator;
  return op ?? { user: "operador", admin: false };
}

export function basicAuth(): RequestHandler {
  const list = accounts();
  if (list.length === 0) {
    return (_req, res) => {
      res.status(503).json({
        error: "Dashboard disabled. Set DASHBOARD_USER and DASHBOARD_PASSWORD to enable.",
      });
    };
  }

  return (req, res, next) => {
    const header = req.header("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      let decoded = "";
      try {
        decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      } catch {
        /* header inválido */
      }
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : "";
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      // Percorre TODAS as contas (tempo independente de qual usuário casa).
      let matched: Account | null = null;
      for (const acc of list) {
        const userOk = safeEqual(user, acc.user);
        const passOk = safeEqual(pass, acc.pass);
        if (userOk && passOk) matched = acc;
      }
      if (matched) {
        res.locals.operator = { user: matched.user, admin: matched.admin } satisfies Operator;
        next();
        return;
      }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Aria Dashboard", charset="UTF-8"');
    res.status(401).send("Authentication required");
  };
}
