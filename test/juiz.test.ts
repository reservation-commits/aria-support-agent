import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretarVeredito, resumirVereditos, RUBRICA, NOTA_MINIMA } from "../src/juizRegua.js";

const tudoUm = Object.fromEntries(RUBRICA.map((c) => [c, 1]));

test("juiz: interpreta veredito limpo e soma as notas", () => {
  const texto = JSON.stringify([{ id: 10, notas: tudoUm, motivo: "ok" }]);
  const v = interpretarVeredito(texto, [10]);
  assert.equal(v.length, 1);
  assert.equal(v[0].nota, 6);
  assert.equal(v[0].message_id, 10);
});

test("juiz: aceita texto ao redor do JSON (salvaguarda)", () => {
  const texto = "Aqui está:\n" + JSON.stringify([{ id: 1, notas: tudoUm, motivo: "x" }]) + "\nfim";
  assert.equal(interpretarVeredito(texto, [1]).length, 1);
});

test("juiz: id inventado pelo modelo é descartado; id repetido fica o primeiro", () => {
  const texto = JSON.stringify([
    { id: 999, notas: tudoUm, motivo: "inventado" },
    { id: 5, notas: { ...tudoUm, sem_prazo: 0 }, motivo: "primeiro" },
    { id: 5, notas: tudoUm, motivo: "segundo" },
  ]);
  const v = interpretarVeredito(texto, [5]);
  assert.equal(v.length, 1);
  assert.equal(v[0].notas.sem_prazo, 0);
  assert.equal(v[0].motivo, "primeiro");
});

test("juiz: critério ausente ou valor estranho vira 0 (na dúvida, reprova)", () => {
  const texto = JSON.stringify([{ id: 2, notas: { idioma_ok: 1, sem_prazo: "sim", tom_marca: 2 }, motivo: "" }]);
  const v = interpretarVeredito(texto, [2]);
  assert.equal(v[0].nota, 1);
  assert.equal(v[0].notas.sem_prazo, 0);
  assert.equal(v[0].notas.discricao, 0);
});

test("juiz: motivo é achatado e limitado a 240 caracteres", () => {
  const texto = JSON.stringify([{ id: 3, notas: tudoUm, motivo: "a\n\n b   c" + "x".repeat(500) }]);
  const v = interpretarVeredito(texto, [3]);
  assert.ok(v[0].motivo.startsWith("a b c"));
  assert.equal(v[0].motivo.length, 240);
});

test("juiz: sem array JSON → lança (nada é gravado como ok)", () => {
  assert.throws(() => interpretarVeredito("não consigo julgar", [1]), /sem array JSON/);
  assert.throws(() => interpretarVeredito("[{id: 1,}]", [1]), /JSON inválido/);
});

test("juiz: resumo reprova por nota baixa OU por prazo prometido, mesmo com nota alta", () => {
  const v = interpretarVeredito(
    JSON.stringify([
      { id: 1, notas: tudoUm, motivo: "" },
      { id: 2, notas: { ...tudoUm, sem_prazo: 0 }, motivo: "prometeu 24h" },
      { id: 3, notas: { idioma_ok: 0, sem_prazo: 1, sem_vocabulario_interno: 0, discricao: 1, resolve_agora: 0, tom_marca: 1 }, motivo: "" },
    ]),
    [1, 2, 3],
  );
  const r = resumirVereditos(v);
  assert.equal(r.total, 3);
  assert.equal(r.reprovadas, 2);
  assert.deepEqual(r.ids_reprovadas, [2, 3]);
  assert.equal(r.prazos, 1);
  assert.equal(r.idioma, 1);
  assert.equal(r.media, 4.7);
  assert.ok(NOTA_MINIMA === 5);
});

test("juiz: resumo vazio não divide por zero", () => {
  const r = resumirVereditos([]);
  assert.equal(r.total, 0);
  assert.equal(r.media, 0);
});
