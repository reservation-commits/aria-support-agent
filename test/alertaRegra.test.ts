import { test } from "node:test";
import assert from "node:assert/strict";
import { decidirAlertaIncidente, duracao, estadoInicial, horaParis, type EstadoIncidente } from "../src/alertaRegra.js";

const OPTS = { falhasParaAbrir: 2, repetirMs: 12 * 3_600_000 };
const MIN5 = 5 * 60_000;

/** Roda uma sequência de checagens (true = ok) a cada 5 min e devolve as ações. */
function rodar(checagens: boolean[], opts = OPTS): string[] {
  let estado: EstadoIncidente = estadoInicial();
  const acoes: string[] = [];
  checagens.forEach((ok, i) => {
    const r = decidirAlertaIncidente(estado, ok, i * MIN5, opts);
    estado = r.estado;
    acoes.push(r.acao);
  });
  return acoes;
}

test("v20 alerta: um timeout isolado não acorda ninguém", () => {
  assert.deepEqual(rodar([true, false, true, true]), ["nada", "nada", "nada", "nada"]);
});

test("v20 alerta: duas falhas seguidas avisam a queda — uma vez", () => {
  assert.deepEqual(rodar([true, false, false, false, false]), ["nada", "nada", "avisar_queda", "nada", "nada"]);
});

test("v20 alerta: a volta é avisada uma vez, e só se a queda foi avisada", () => {
  assert.deepEqual(rodar([false, false, false, true, true]), ["nada", "avisar_queda", "nada", "avisar_volta", "nada"]);
});

test("v20 alerta: as 70 horas de 02 a 05/10 teriam dado 1 aviso de queda, 5 repetições e 1 de volta — não 76", () => {
  const checagens = [...Array(70 * 12).fill(false), true];
  const acoes = rodar(checagens);
  const conta = (a: string) => acoes.filter((x) => x === a).length;
  assert.equal(conta("avisar_queda"), 1);
  assert.equal(conta("repetir_queda"), 5);
  assert.equal(conta("avisar_volta"), 1);
});

test("v20 alerta: repetição desligada (0 h) = só o primeiro aviso e o de volta", () => {
  const acoes = rodar([...Array(400).fill(false), true], { falhasParaAbrir: 2, repetirMs: 0 });
  assert.deepEqual([...new Set(acoes)].sort(), ["avisar_queda", "avisar_volta", "nada"]);
  assert.equal(acoes.filter((a) => a === "avisar_queda").length, 1);
});

test("v20 alerta: o início do incidente é a PRIMEIRA falha, não a do aviso", () => {
  let e = estadoInicial();
  e = decidirAlertaIncidente(e, false, 1_000, OPTS).estado;
  e = decidirAlertaIncidente(e, false, 1_000 + MIN5, OPTS).estado;
  assert.equal(e.abertoEm, 1_000);
  assert.equal(e.ultimoAviso, 1_000 + MIN5);
});

test("v20 alerta: duração legível", () => {
  assert.equal(duracao(25 * 60_000), "25 min");
  assert.equal(duracao(200 * 60_000), "3 h 20 min");
  assert.equal(duracao(3 * 3_600_000), "3 h");
  assert.equal(duracao(70 * 3_600_000 + 5 * 60_000), "70 h");
  assert.equal(duracao(-5), "0 min");
});

test("v20 alerta: horário no fuso de Paris", () => {
  assert.equal(horaParis(new Date("2026-10-05T12:55:00Z")), "05/10 14:55 (Paris)");
  assert.equal(horaParis(new Date("2026-12-31T23:30:00Z")), "01/01 00:30 (Paris)");
});

test("v21 autoteste na subida: versão nova avisa; a mesma versão reiniciando não vira rajada", async () => {
  const { deveAvisarBoot } = await import("../src/alertaRegra.js");
  const H6 = 6 * 3_600_000;
  const base = { build: "v21", agora: 100 * 3_600_000, intervaloMs: H6 };
  assert.equal(deveAvisarBoot({ ...base, ultimoBuild: null, ultimoEm: null }), true); // primeira vez
  assert.equal(deveAvisarBoot({ ...base, ultimoBuild: "v20", ultimoEm: base.agora - 60_000 }), true); // versão nova
  assert.equal(deveAvisarBoot({ ...base, ultimoBuild: "v21", ultimoEm: base.agora - 60_000 }), false); // laço de reinício
  assert.equal(deveAvisarBoot({ ...base, ultimoBuild: "v21", ultimoEm: base.agora - H6 }), true); // mesma versão, 6 h depois
});
