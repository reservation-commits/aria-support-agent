import { test } from "node:test";
import assert from "node:assert/strict";
import { languageForPhone } from "../src/locale.js";

test("mapeia código do país para o idioma base", () => {
  assert.equal(languageForPhone("+5511999999999"), "pt"); // Brasil
  assert.equal(languageForPhone("+351912345678"), "pt");  // Portugal
  assert.equal(languageForPhone("+14155550123"), "en");   // EUA
  assert.equal(languageForPhone("+442071234567"), "en");  // Reino Unido
  assert.equal(languageForPhone("+34911223344"), "es");   // Espanha
  assert.equal(languageForPhone("+5215512345678"), "es"); // México
  assert.equal(languageForPhone("+33612345678"), "fr");   // França
});

test("prefixo mais longo vence (351 antes de 1)", () => {
  assert.equal(languageForPhone("+351211111111"), "pt");
});

test("país desconhecido cai no fallback", () => {
  assert.equal(languageForPhone("+9990000000"), "en");
  assert.equal(languageForPhone("+9990000000", "pt"), "pt");
});
