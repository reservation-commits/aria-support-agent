import { test } from "node:test";
import assert from "node:assert/strict";
import { escolherLocale, normalizarIdioma } from "../src/templateLocale.js";
import { languageForPhone } from "../src/locale.js";

const TODOS = ["en", "pt_BR", "es", "fr", "it", "de"];

test("idioma: preferência marcada vence o país do telefone", () => {
  const r = escolherLocale({ idiomaPreferido: "pt", phone: "+33612345678", aprovados: TODOS, defaultLocale: "en" });
  assert.deepEqual(r, { locale: "pt_BR", origem: "preferencia" });
});

test("idioma: sem preferência, vale o país", () => {
  assert.deepEqual(escolherLocale({ idiomaPreferido: null, phone: "+351912345678", aprovados: TODOS, defaultLocale: "en" }), { locale: "pt_BR", origem: "pais" });
  assert.deepEqual(escolherLocale({ idiomaPreferido: "", phone: "+393331234567", aprovados: TODOS, defaultLocale: "en" }), { locale: "it", origem: "pais" });
  assert.deepEqual(escolherLocale({ idiomaPreferido: null, phone: "+4915112345678", aprovados: TODOS, defaultLocale: "en" }), { locale: "de", origem: "pais" });
});

test("idioma: preferência sem tradução aprovada na Meta cai para o país, e depois para o padrão", () => {
  // só en aprovado (situação de hoje): português marcado → en
  assert.deepEqual(escolherLocale({ idiomaPreferido: "pt", phone: "+351912345678", aprovados: ["en"], defaultLocale: "en" }), { locale: "en", origem: "padrao" });
  // it marcado, it não aprovado, telefone francês, fr aprovado → fr pelo país
  assert.deepEqual(escolherLocale({ idiomaPreferido: "it", phone: "+33612345678", aprovados: ["en", "fr"], defaultLocale: "en" }), { locale: "fr", origem: "pais" });
});

test("idioma: país desconhecido cai no padrão", () => {
  assert.deepEqual(escolherLocale({ idiomaPreferido: null, phone: "+81312345678", aprovados: TODOS, defaultLocale: "en" }), { locale: "en", origem: "padrao" });
});

test("idioma: lista de aprovados vazia = tudo permitido (dev)", () => {
  assert.equal(escolherLocale({ idiomaPreferido: "de", phone: "+1", aprovados: [], defaultLocale: "en" }).locale, "de");
});

test("normalizarIdioma aceita códigos e nomes, nunca inventa", () => {
  assert.equal(normalizarIdioma("PT-br"), "pt");
  assert.equal(normalizarIdioma("en_US"), "en");
  assert.equal(normalizarIdioma("Português"), "pt");
  assert.equal(normalizarIdioma("italiano"), "it");
  assert.equal(normalizarIdioma("Deutsch"), "de");
  assert.equal(normalizarIdioma("klingon"), null);
  assert.equal(normalizarIdioma(null), null);
});

test("locale.ts: Itália e Alemanha entraram no mapa; Áustria fala alemão", () => {
  assert.equal(languageForPhone("+39 333 1234567"), "it");
  assert.equal(languageForPhone("+49 151 1234567"), "de");
  assert.equal(languageForPhone("+43 660 1234567"), "de");
  assert.equal(languageForPhone("+351 912 345 678"), "pt");
});
