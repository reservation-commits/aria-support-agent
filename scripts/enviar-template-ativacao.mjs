#!/usr/bin/env node
/**
 * Aria — envio do template de ATIVAÇÃO (Chave Girada) aos restaurantes da lista aprovada.
 * Roda NO SERVIDOR da Aria (precisa de WHATSAPP_* e PG* do serviço). Reutiliza o cliente oficial (dist/whatsapp.js).
 *
 *   node scripts/enviar-template-ativacao.mjs lista.csv                          → DRY-RUN
 *   node scripts/enviar-template-ativacao.mjs lista.csv --apply --aprovacao "<ref>"
 *
 * lista.csv (separador ;): restaurant_id;nome;telefone;idioma;aceitos   (idioma: pt|en|fr|it|es)
 * Env obrigatória em --apply: WHATSAPP_ATIVACAO_TEMPLATE (nome aprovado no WhatsApp Manager), e opcional
 * WHATSAPP_ATIVACAO_LOCALES (ex.: "en,pt_PT,fr,it,es" — só os idiomas realmente aprovados; fora deles cai em en).
 *
 * Guardrails: 1 template por casa e NUNCA um segundo sem resposta · consulta aria_contact_consent e listing_consent (opt-out) ·
 * anti-duplicata em aria_ativacao_envios.jsonl · máx. 15 por execução · aprovação obrigatória.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTemplate } from "../dist/whatsapp.js";
import { normalizePhone } from "../dist/phone.js";
import { pool } from "../dist/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const csv = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
const i = args.indexOf("--aprovacao"); const aprovacao = i >= 0 ? args[i + 1] : null;
const TEMPLATE = process.env.WHATSAPP_ATIVACAO_TEMPLATE || "";
const LOCALES = (process.env.WHATSAPP_ATIVACAO_LOCALES || "en").split(",").map((s) => s.trim());
const MAP = { pt: "pt_PT", en: "en", fr: "fr", it: "it", es: "es" };
const LEDGER = path.join(__dirname, "..", "aria_ativacao_envios.jsonl");
const MAX = 15;

if (!csv) { console.error("uso: node scripts/enviar-template-ativacao.mjs lista.csv [--apply --aprovacao <ref>]"); process.exit(2); }
if (apply && (!aprovacao || !TEMPLATE)) { console.error("--apply exige --aprovacao <ref> e WHATSAPP_ATIVACAO_TEMPLATE"); process.exit(2); }

const linhas = fs.readFileSync(csv, "utf8").split(/\r?\n/).filter(Boolean).slice(1).map((l) => l.split(";"));
const ja = new Set(fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).restaurant_id) : []);

const plano = []; const bloq = [];
for (const [restaurant_id, nome, tel, idioma, aceitos] of linhas) {
  const to = normalizePhone(tel || "");
  if (!to) { bloq.push([nome, "telefone inválido"]); continue; }
  if (ja.has(restaurant_id)) { bloq.push([nome, "template já enviado (nunca um segundo sem resposta)"]); continue; }
  const opt = await pool.query("select 1 from public.aria_contact_consent where phone=$1 and outbound_opted_out", [to]);
  if (opt.rowCount) { bloq.push([nome, "opt-out em aria_contact_consent"]); continue; }
  const lc = await pool.query("select status, do_not_relist, scope from public.v_listing_consent_atual where restaurant_id=$1", [restaurant_id]).catch(() => ({ rows: [] }));
  const e = lc.rows[0];
  if (e && (e.status === "opted_out" || e.do_not_relist || (e.scope || []).includes("outreach"))) { bloq.push([nome, `listing_consent: ${e.status}`]); continue; }
  const loc = MAP[idioma] && LOCALES.includes(MAP[idioma]) ? MAP[idioma] : "en";
  plano.push({ restaurant_id, nome, to, locale: loc, bodyParams: [nome, String(aceitos)] });
  if (plano.length >= MAX) break;
}
console.log(`modo ${apply ? "APPLY" : "DRY-RUN"} · template ${TEMPLATE || "(não definido)"} · a enviar ${plano.length} · bloqueados ${bloq.length}`);
bloq.forEach(([n, m]) => console.log(`  ✗ ${n}: ${m}`));
plano.forEach((p) => console.log(`  → ${p.nome} · ${p.locale} · ${p.to.replace(/\d(?=\d{4})/g, "•")}`));
let ok = 0;
if (apply) for (const p of plano) {
  const sent = await sendTemplate({ to: p.to, template: TEMPLATE, locale: p.locale, bodyParams: p.bodyParams });
  fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), restaurant_id: p.restaurant_id, nome: p.nome, locale: p.locale, ok: sent, aprovacao }) + "\n");
  if (sent) ok++;
  await new Promise((r) => setTimeout(r, 1200));
}
if (apply) console.log(`enviados ${ok}/${plano.length} · ledger ${LEDGER}`);
await pool.end();
