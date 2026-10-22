/**
 * alertaRegra.ts — QUANDO avisar o operador e como dizer o tempo (puro, testável; v20).
 *
 * Duas checagens seguidas em falha abrem o incidente (um timeout isolado não acorda ninguém),
 * o aviso se repete a cada N horas enquanto durar, e a volta é avisada uma vez. O envio fica
 * em alertaOperador.ts.
 */

/** Hora de Paris, para quem lê no celular: "05/10 14:55". */
export function horaParis(d: Date): string {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}/${v("month")} ${v("hour")}:${v("minute")} (Paris)`;
}

/** "70 h", "3 h 20 min", "25 min". */
export function duracao(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return h >= 10 || resto === 0 ? `${h} h` : `${h} h ${resto} min`;
}

export type EstadoIncidente = { falhasSeguidas: number; abertoEm: number | null; ultimoAviso: number | null };
export type AcaoIncidente = "nada" | "avisar_queda" | "repetir_queda" | "avisar_volta";

export function estadoInicial(): EstadoIncidente {
  return { falhasSeguidas: 0, abertoEm: null, ultimoAviso: null };
}

/**
 * Uma checagem a mais: devolve o que fazer e o novo estado. `falhasParaAbrir` checagens seguidas
 * em falha abrem o incidente; `repetirMs` > 0 repete o aviso enquanto durar.
 */
export function decidirAlertaIncidente(
  estado: EstadoIncidente,
  ok: boolean,
  agora: number,
  opts: { falhasParaAbrir: number; repetirMs: number },
): { acao: AcaoIncidente; estado: EstadoIncidente } {
  if (ok) {
    const acao: AcaoIncidente = estado.ultimoAviso !== null ? "avisar_volta" : "nada";
    return { acao, estado: estadoInicial() };
  }
  const falhasSeguidas = estado.falhasSeguidas + 1;
  const abertoEm = estado.abertoEm ?? agora;
  if (estado.ultimoAviso === null) {
    if (falhasSeguidas >= opts.falhasParaAbrir) return { acao: "avisar_queda", estado: { falhasSeguidas, abertoEm, ultimoAviso: agora } };
    return { acao: "nada", estado: { falhasSeguidas, abertoEm, ultimoAviso: null } };
  }
  if (opts.repetirMs > 0 && agora - estado.ultimoAviso >= opts.repetirMs) {
    return { acao: "repetir_queda", estado: { falhasSeguidas, abertoEm, ultimoAviso: agora } };
  }
  return { acao: "nada", estado: { falhasSeguidas, abertoEm, ultimoAviso: estado.ultimoAviso } };
}

/**
 * v21 — autoteste do alerta na subida. Cada versão nova avisa uma vez que subiu ("este canal está
 * funcionando"): é o teste do caminho real — variável, template, número e entrega — sem derrubar
 * nada. O mesmo build reiniciando (queda, redeploy sem mudança) só avisa de novo depois de
 * `intervaloMs`, para um laço de reinício não virar rajada no celular.
 */
export function deveAvisarBoot(p: { build: string; ultimoBuild: string | null; ultimoEm: number | null; agora: number; intervaloMs: number }): boolean {
  if (!p.ultimoBuild || p.ultimoEm === null) return true;
  if (p.ultimoBuild !== p.build) return true;
  return p.agora - p.ultimoEm >= p.intervaloMs;
}
