import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueMessage } from "../src/conversationQueue.js";

type Block = { type: "text"; text: string };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const txt = (s: string): Block => ({ type: "text", text: s });

const DEBOUNCE = 30;

test("agrupa mensagens em rajada num único turno", async () => {
  const calls: Block[][] = [];
  const processor = async (_chat: string, _name: string | null, blocks: unknown[]) => {
    calls.push(blocks as Block[]);
  };

  // três balões em sequência dentro da janela de debounce
  enqueueMessage("chatA", "Ana", [txt("oi")], processor, DEBOUNCE);
  enqueueMessage("chatA", "Ana", [txt("quero reservar")], processor, DEBOUNCE);
  enqueueMessage("chatA", "Ana", [txt("em Paris")], processor, DEBOUNCE);

  await sleep(DEBOUNCE * 3);

  assert.equal(calls.length, 1, "deveria processar uma vez só");
  assert.deepEqual(
    calls[0].map((b) => b.text),
    ["oi", "quero reservar", "em Paris"],
    "todos os blocos da rajada deveriam chegar juntos",
  );
});

test("serializa: nunca processa dois turnos do mesmo chat em paralelo", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const order: string[] = [];

  // Sinaliza quando o PRIMEIRO turno realmente começou — sem depender da
  // precisão dos timers do SO (o sleep fixo era flaky no Windows).
  let signalStarted: () => void;
  const firstStarted = new Promise<void>((r) => (signalStarted = r));

  const processor = async (_chat: string, _name: string | null, blocks: unknown[]) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    order.push((blocks as Block[])[0].text);
    signalStarted();
    await sleep(40); // turno "lento"
    concurrent--;
  };

  // primeira rajada
  enqueueMessage("chatB", null, [txt("primeira")], processor, DEBOUNCE);
  await firstStarted; // garante que o primeiro turno ESTÁ em processamento
  // chega nova mensagem ENQUANTO a primeira ainda processa
  enqueueMessage("chatB", null, [txt("segunda")], processor, DEBOUNCE);

  // Aguarda até o segundo turno concluir (com teto de segurança).
  const deadline = Date.now() + 2_000;
  while (order.length < 2 && Date.now() < deadline) await sleep(10);

  assert.equal(maxConcurrent, 1, "não pode haver sobreposição de turnos");
  assert.deepEqual(order, ["primeira", "segunda"], "ordem deve ser preservada");
});

test("chats diferentes são independentes", async () => {
  const seen: string[] = [];
  const processor = async (chat: string) => {
    seen.push(chat);
  };
  enqueueMessage("x1", null, [txt("a")], processor, DEBOUNCE);
  enqueueMessage("x2", null, [txt("b")], processor, DEBOUNCE);
  await sleep(DEBOUNCE * 3);
  assert.equal(seen.length, 2);
  assert.ok(seen.includes("x1") && seen.includes("x2"));
});
