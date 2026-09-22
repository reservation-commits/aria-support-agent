import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeInternalNote, motivoDeBloqueio, outboundGate, idiomaProvavel, containsSilenceMarker } from "../src/format.js";

// ── O incidente de 2026-09-11 ────────────────────────────────────────────────
// Texto EXATO entregue a Nicole Eisenmann (BASF) como carta oficial da TWK.
const INCIDENTE =
  "Escalei o caso à equipe com prioridade (SLA de 2 horas) para acelerar a confirmação junto ao Baan Chiang. " +
  "A cliente foi informada do prazo e do canal de acompanhamento na conta.";

test("o texto do incidente de 11/09 é barrado", () => {
  assert.equal(looksLikeInternalNote(INCIDENTE), true);
  assert.ok(motivoDeBloqueio(INCIDENTE));
});

test("o incidente também é barrado pelo portão, com o inglês da cliente na entrada", () => {
  const entrada = "Still no answer? Could you please check? Thank you very much. Best regards, Nicole Eisenmann";
  const r = outboundGate(INCIDENTE, entrada);
  assert.equal(r.ok, false);
});

// ── Famílias de nota interna que escapavam ───────────────────────────────────
test("barra relato de ação em primeira pessoa", () => {
  assert.ok(motivoDeBloqueio("Registrei no painel e segui com o atendimento do cliente seguinte."));
  assert.ok(motivoDeBloqueio("I have escalated this to the team with priority."));
  assert.ok(motivoDeBloqueio("J'ai transmis le dossier à l'équipe concernée."));
});

test("barra anúncio de plano antes da saudação", () => {
  assert.ok(motivoDeBloqueio("Como o remetente escreveu em inglês, vou responder em inglês: Dear Sir, ..."));
});

test("barra narração de tool, dump e coluna interna", () => {
  assert.ok(motivoDeBloqueio('{"ok":true,"data":{"reservation_code":"ABC"}}'));
  assert.ok(motivoDeBloqueio("A tool find_reservation_by_code retornou vazio para este código."));
  assert.ok(motivoDeBloqueio("O booking_status segue Pending; você recebe aviso assim que mudar."));
});

test("barra nota interna em idioma que não é português", () => {
  assert.ok(motivoDeBloqueio("This is an automated report, no action needed."));
  assert.ok(motivoDeBloqueio("Réponse vide — newsletter, aucune action."));
});

test("barra marcador de silêncio em qualquer posição", () => {
  assert.equal(containsSilenceMarker("[[SILENCIO]]"), true);
  assert.ok(motivoDeBloqueio("[[SILENCIO]] — trata-se de newsletter da casa."));
  assert.ok(motivoDeBloqueio("[[SILENCIO]]"));
});

test("barra placeholder de resposta vazia", () => {
  assert.ok(motivoDeBloqueio("..."));
  assert.ok(motivoDeBloqueio("   "));
});

test("barra anotação sem saudação e sem segunda pessoa", () => {
  assert.ok(motivoDeBloqueio("Caso encaminhado. Aguardando retorno do estabelecimento."));
});

// ── Cartas legítimas NÃO podem ser barradas ──────────────────────────────────
test("carta legítima ao cliente passa", () => {
  const carta =
    "Dear Ms Eisenmann,\n\nYour request EVU5Z99H for BAAN CHIANG has not yet been answered by the restaurant. " +
    "I wrote to them again today. The moment they answer, your confirmation arrives by e-mail.\n\nWith pleasure, Aria";
  assert.equal(motivoDeBloqueio(carta), null);
  assert.equal(outboundGate(carta, "Still no answer? Could you please check? Thank you.").ok, true);
});

test("carta legítima em francês passa", () => {
  const carta =
    "Bonjour Madame,\n\nMISS KÔ n'a pas encore répondu à votre demande. Je viens de leur réécrire. " +
    "Dès qu'ils répondent, vous recevez la confirmation par e-mail.\n\nAvec plaisir, Aria";
  assert.equal(motivoDeBloqueio(carta), null);
  assert.equal(outboundGate(carta, "Bonjour, avez-vous des nouvelles du restaurant ? Merci.").ok, true);
});

test("resposta ao restaurante confirmando que o cliente foi avisado passa", () => {
  // FLUXO 5: legítimo dizer ao ESTABELECIMENTO que o cliente foi notificado.
  const carta =
    "Bonjour,\n\nMerci pour votre réponse. Nous avons proposé 22h00 à votre client : il décide en un clic et vous êtes prévenus. " +
    "Votre compte professionnel gratuit vous permet de répondre en deux minutes.";
  assert.equal(motivoDeBloqueio(carta), null);
});

// ── Idioma ───────────────────────────────────────────────────────────────────
test("idiomaProvavel reconhece os idiomas dos clientes reais", () => {
  assert.equal(idiomaProvavel("Still no answer? Could you please check? Thank you very much."), "en");
  assert.equal(idiomaProvavel("Bonjour, avez-vous des nouvelles du restaurant ? Merci de votre réponse."), "fr");
  assert.equal(idiomaProvavel("Escalei o caso à equipe. A cliente foi informada do prazo e da sua conta."), "pt");
});

test("idiomaProvavel devolve null quando não há sinal suficiente", () => {
  assert.equal(idiomaProvavel("ok"), null);
  assert.equal(idiomaProvavel("EVU5Z99H"), null);
});

test("portão barra resposta em idioma diferente do da entrada", () => {
  const entrada = "Hello, could you please confirm my reservation? Thank you very much for your help.";
  const resposta = "Olá, a sua reserva segue pendente. Você recebe um aviso assim que o restaurante responder, obrigado.";
  const r = outboundGate(resposta, entrada);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /idioma divergente/.test(r.motivo));
});

test("portão não barra quando o idioma bate", () => {
  const entrada = "Hello, could you please confirm my reservation? Thank you very much for your help.";
  const resposta = "Hello, thank you for writing. Your reservation is still pending with the restaurant, and we will tell you the moment they reply.";
  assert.equal(outboundGate(resposta, entrada).ok, true);
});

// ── Promessa de disponibilidade (incidente de 11/09, cliente Alan Wilde) ─────
test("barra a promessa de disponibilidade imediata feita ao cliente em 11/09", () => {
  const trecho =
    "Dear Mr Wilde,\n\nI've hand-picked a few equally beautiful tables nearby for tomorrow night, each one you can book directly with instant availability. " +
    "Simply choose your time and party size on the page and you'll have your confirmation in hand.\n\nWith pleasure,\nAria";
  assert.match(motivoDeBloqueio(trecho) ?? "", /promete disponibilidade/);
});

test("barra promessa de confirmação imediata ou mesa garantida em outros idiomas", () => {
  assert.match(motivoDeBloqueio("Bonjour Madame, ces adresses offrent une disponibilité immédiate pour ce soir. Avec plaisir, Aria") ?? "", /promete disponibilidade/);
  assert.match(motivoDeBloqueio("Olá, Ricardo! Essas casas têm confirmação imediata, é só escolher. Com prazer, Aria") ?? "", /promete disponibilidade/);
  assert.match(motivoDeBloqueio("Hola, Lucía: le dejo una mesa garantizada en este restaurante. Con gusto, Aria") ?? "", /promete disponibilidade/);
  assert.match(motivoDeBloqueio("Gentile signora, il tavolo garantito vi aspetta stasera. Con piacere, Aria") ?? "", /promete disponibilidade/);
});

test("não barra quem descreve a confirmação sem prometê-la", () => {
  const carta =
    "Dear Mr Wilde,\n\nYou can request a table directly on the page. The restaurant confirms by e-mail, and the confirmation reaches you the moment they reply.\n\nWith pleasure,\nAria";
  assert.equal(motivoDeBloqueio(carta), null);
  const fr = "Bonjour Madame,\n\nDès qu'ils confirment, la confirmation vous parvient par e-mail. Avec plaisir, Aria";
  assert.equal(motivoDeBloqueio(fr), null);
});
