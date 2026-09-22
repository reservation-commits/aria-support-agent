import { test } from "node:test";
import assert from "node:assert/strict";
import { verificarSegredoWebhook, STATUS_DE } from "../src/webhookAuth.js";

const SEGREDO = "s3gr3d0-longo-e-aleatorio-para-o-n8n";

test("segredo correto passa", () => {
  const v = verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: SEGREDO });
  assert.equal(v, "ok");
  assert.equal(STATUS_DE[v], 200);
});

test("segredo errado do MESMO tamanho é barrado", () => {
  const errado = "x".repeat(SEGREDO.length);
  assert.equal(errado.length, SEGREDO.length, "cenário precisa ter o mesmo comprimento");
  const v = verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: errado });
  assert.equal(v, "segredo_invalido");
  assert.equal(STATUS_DE[v], 401);
});

test("segredo de tamanho diferente é barrado sem lançar", () => {
  // timingSafeEqual LANÇA com buffers de tamanhos distintos. O curto-circuito
  // de comprimento existe para isso — sem ele a rota devolveria 500.
  for (const f of ["", "x", SEGREDO + "a", SEGREDO.slice(0, -1)]) {
    assert.doesNotThrow(() => verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: f }));
    assert.equal(verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: f }), "segredo_invalido");
  }
});

test("header ausente é barrado", () => {
  assert.equal(
    verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: undefined }),
    "segredo_invalido",
  );
});

test("canal desligado responde 404, nunca 401", () => {
  // 401 anunciaria que a rota existe. 404 não conta nada a quem varre portas.
  const v = verificarSegredoWebhook({ habilitado: false, esperado: SEGREDO, fornecido: SEGREDO });
  assert.equal(v, "nao_configurado");
  assert.equal(STATUS_DE[v], 404);
});

test("sem segredo configurado responde 404 mesmo com header vazio", () => {
  // O buraco clássico: segredo vazio + header vazio "batendo" e liberando tudo.
  for (const f of ["", undefined, "qualquer"]) {
    const v = verificarSegredoWebhook({ habilitado: true, esperado: "", fornecido: f });
    assert.equal(v, "nao_configurado", `fornecido=${JSON.stringify(f)} não podia passar`);
    assert.notEqual(v, "ok");
  }
});

test("desligado tem precedência sobre segredo inválido", () => {
  // Não se distingue "existe e a senha está errada" de "não existe".
  assert.equal(
    verificarSegredoWebhook({ habilitado: false, esperado: SEGREDO, fornecido: "errado" }),
    "nao_configurado",
  );
});

test("comparação é sensível a caixa e a espaço", () => {
  for (const f of [SEGREDO.toUpperCase(), ` ${SEGREDO}`, `${SEGREDO} `]) {
    assert.notEqual(
      verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: f }),
      "ok",
      `"${f}" não podia passar`,
    );
  }
});

test("só existem três vereditos, e cada um tem status", () => {
  const vistos = new Set(
    [
      verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: SEGREDO }),
      verificarSegredoWebhook({ habilitado: true, esperado: SEGREDO, fornecido: "nao" }),
      verificarSegredoWebhook({ habilitado: false, esperado: SEGREDO, fornecido: SEGREDO }),
    ],
  );
  assert.deepEqual([...vistos].sort(), ["nao_configurado", "ok", "segredo_invalido"]);
  for (const v of vistos) assert.equal(typeof STATUS_DE[v], "number");
});
