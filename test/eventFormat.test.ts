import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ehEventoReserva,
  formatarData,
  formatarHora,
  montarParametros,
  primeiroNome,
  toYMD,
} from "../src/eventFormat.js";
import { sanitizeTemplateParam, WA_TEMPLATE_PARAM_MAX } from "../src/waLimits.js";

test("data nunca sai ambígua entre dia e mês", () => {
  // 3 de abril: "03/04" seria 4 de março para um americano.
  for (const pais of ["US", "GB", "FR", "BR", null]) {
    const s = formatarData("2026-04-03", pais);
    assert.ok(!/^\d{2}\/\d{2}/.test(s), `${pais}: "${s}" ainda é numérico e ambíguo`);
    assert.ok(/3/.test(s) && /2026/.test(s), `${pais}: "${s}" deveria conter dia e ano`);
  }
});

test("data respeita o idioma do cliente", () => {
  assert.match(formatarData("2026-04-03", "US"), /Apr/);
  assert.match(formatarData("2026-04-03", "FR"), /avr/i);
  assert.match(formatarData("2026-04-03", "BR"), /abr/i);
});

test("toYMD não desliza um dia com o Date que o pg devolve", () => {
  // O pg entrega DATE como Date à meia-noite LOCAL. Ler em UTC voltaria um dia
  // em fusos negativos.
  const meiaNoiteLocal = new Date(2026, 3, 3, 0, 0, 0);
  assert.equal(toYMD(meiaNoiteLocal), "2026-04-03");
  assert.equal(toYMD("2026-04-03"), "2026-04-03");
  assert.equal(toYMD("2026-04-03T22:00:00.000Z"), "2026-04-03");
  assert.equal(toYMD(null), null);
  assert.equal(toYMD("qualquer coisa"), null);
});

test("hora segue a convenção do país", () => {
  assert.match(formatarHora("20:00:00", "US"), /8.*PM/i);
  assert.equal(formatarHora("20:00:00", "FR").replace(/ | /g, " ").trim(), "20:00");
  assert.equal(formatarHora("lixo", "FR"), "");
  assert.equal(formatarHora(null, "FR"), "");
});

test("primeiroNome pega só o primeiro e tolera sujeira", () => {
  assert.equal(primeiroNome("  Marie   Claire  Dubois "), "Marie");
  assert.equal(primeiroNome(null), "");
  assert.equal(primeiroNome(""), "");
});

test("ehEventoReserva só aceita os eventos do contrato", () => {
  assert.ok(ehEventoReserva("aceito"));
  assert.ok(ehEventoReserva("pedido_recebido"));
  assert.equal(ehEventoReserva("qualquer"), false);
  assert.equal(ehEventoReserva(42), false);
  assert.equal(ehEventoReserva(null), false);
});

test("a ordem dos parâmetros é o contrato com o template aprovado", () => {
  const dados = {
    customer_name: "Marie Dubois",
    restaurant_name: "Le Bernardin",
    booking_date: "2026-04-03",
    reservation_time: "20:00:00",
  };
  const aceito = montarParametros("aceito", dados, "FR");
  assert.ok(aceito);
  assert.equal(aceito.length, 4);
  assert.equal(aceito[0], "Marie");
  assert.equal(aceito[1], "Le Bernardin");
  assert.match(aceito[2], /avr/i);

  // Recusa e cancelamento não têm hora: 3 parâmetros.
  assert.equal(montarParametros("recusado", dados, "FR")?.length, 3);
  assert.equal(montarParametros("cancelado", dados, "FR")?.length, 3);
});

test("reagendamento usa a data proposta, não a original", () => {
  const p = montarParametros(
    "reagendamento_proposto",
    {
      customer_name: "John Smith",
      restaurant_name: "Septime",
      booking_date: "2026-04-03",
      reservation_time: "20:00:00",
      reschedule_proposed_date: "2026-04-10",
      reschedule_proposed_time: "21:30:00",
    },
    "US",
  );
  assert.ok(p);
  assert.match(p[2], /10/, "deveria trazer a data proposta");
  assert.match(p[3], /9:30.*PM/i, "deveria trazer a hora proposta");
});

test("reagendamento SEM proposta não monta nada — nunca reenvia a data antiga", () => {
  // Em 2026-09-21 nenhuma reserva do banco tinha reschedule_proposed_date.
  // Cair na data original diria "podemos oferecer <a mesma data>", que é pior
  // que não avisar.
  const p = montarParametros(
    "reagendamento_proposto",
    {
      customer_name: "John",
      restaurant_name: "Septime",
      booking_date: "2026-04-03",
      reservation_time: "20:00:00",
      reschedule_proposed_date: null,
      reschedule_proposed_time: null,
    },
    "GB",
  );
  assert.equal(p, null);
});

test("qualquer parâmetro vazio aborta a montagem", () => {
  const base = {
    customer_name: "John Smith",
    restaurant_name: "Septime",
    booking_date: "2026-04-03",
    reservation_time: "20:00:00",
  };
  // A Meta rejeita parâmetro vazio; melhor não montar do que levar 400 genérico.
  assert.equal(montarParametros("aceito", { ...base, restaurant_name: "" }, "GB"), null);
  assert.equal(montarParametros("aceito", { ...base, restaurant_name: "   " }, "GB"), null);
  assert.equal(montarParametros("aceito", { ...base, customer_name: null }, "GB"), null);
  assert.equal(montarParametros("aceito", { ...base, booking_date: null }, "GB"), null);
  assert.equal(montarParametros("aceito", { ...base, reservation_time: null }, "GB"), null);
  // Recusa não usa hora: hora ausente não deve abortá-la.
  assert.notEqual(montarParametros("recusado", { ...base, reservation_time: null }, "GB"), null);
});

test("parâmetro de template nunca leva o que a Meta rejeita", () => {
  const sujo = "Chez\nMaurice\t—  \n  Paris    18e";
  const limpo = sanitizeTemplateParam(sujo);
  assert.ok(!/[\r\n\t]/.test(limpo), "sem quebra de linha ou tabulação");
  assert.ok(!/ {2,}/.test(limpo), "sem espaços repetidos (regra dos 4 espaços)");
  assert.equal(limpo, "Chez Maurice — Paris 18e");
});

test("parâmetro longo é cortado no teto", () => {
  const s = sanitizeTemplateParam("a".repeat(500));
  assert.ok(s.length <= WA_TEMPLATE_PARAM_MAX);
});
