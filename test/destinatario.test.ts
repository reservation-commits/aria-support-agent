import { test } from "node:test";
import assert from "node:assert/strict";
import { pareceNotificacaoDeReserva } from "../src/venueIdentityRegra.js";
import { promptPara, PROMPT_JUIZ, PROMPT_JUIZ_ESTABELECIMENTO } from "../src/juizRegua.js";
import { motivoDeBloqueio } from "../src/format.js";

test("assunto de notificação da plataforma é reconhecido (a casa responde em cima dele)", () => {
  for (const s of ["Re: Great news! Fratelli have a new booking!", "RE: Pending Request — Reservation ID X", "Re: Reservation Refused", "Fwd: Booking accepted", "Re: Nouvelle réservation"]) {
    assert.equal(pareceNotificacaoDeReserva(s), true, s);
  }
  for (const s of ["Question about dinner in Paris", "Reserva para sábado?", null, ""]) {
    assert.equal(pareceNotificacaoDeReserva(s), false, String(s));
  }
});

test("a régua do estabelecimento é outra e permite código, link e nome do cliente", () => {
  assert.equal(promptPara("cliente"), PROMPT_JUIZ);
  assert.equal(promptPara("estabelecimento"), PROMPT_JUIZ_ESTABELECIMENTO);
  assert.match(PROMPT_JUIZ_ESTABELECIMENTO, /theworldkeys\.com\/r\/<código>/);
  assert.match(PROMPT_JUIZ_ESTABELECIMENTO, /sem_prazo: sempre 1/);
});

test("a carta do incidente Fratelli passa nas regras da porta (o erro estava só na régua semântica)", () => {
  const carta =
    "Prezada equipe do Fratelli,\n\nMuito obrigada pela confirmação e pela atenção.\n\n" +
    "A reserva de 6 pessoas para quinta-feira, 1º de outubro, às 20h, em nome de Priscila, está confirmada. Ela já recebeu o aviso da confirmação.\n\n" +
    "Qualquer ajuste, é só responder a este e-mail.\n\nAria · The World Keys";
  assert.equal(motivoDeBloqueio(carta, { prazoPermitido: true }), null);
});
