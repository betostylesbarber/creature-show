// The streaming reply parser must report fields as they complete and sentences as soon as
// they are finished, whatever size the network chunks are.
import test from "node:test";
import assert from "node:assert/strict";
import { JsonFieldStream, SentenceSplitter } from "../src/jsonstream.js";

const reply = {
  read_comment: true,
  comment_language: "Romanian",
  comment_english: "what do you eat?",
  answer: "Berries",
  reply: 'Berries, Ana! Mostly blackberries "from" the hedge.\nAnd pumpkin soup... honestly, é bussin \u{1F383}.',
  mood: "warm",
  action: "none",
  n: 3,
};

for (const size of [1, 3, 7, 64, 1000]) {
  test(`fields and sentences arrive correctly in ${size}-character chunks`, () => {
    const fields = {};
    const order = [];
    const sentences = [];
    const split = new SentenceSplitter((s) => sentences.push(s));
    const stream = new JsonFieldStream({
      streamed: ["reply"],
      onField: (k, v) => {
        fields[k] = v;
        order.push(k);
        if (k === "reply") split.update(v, true);
      },
      onText: (k, text) => split.update(text),
    });
    const json = JSON.stringify(reply);
    for (let i = 0; i < json.length; i += size) stream.push(json.slice(i, i + size));
    assert.deepEqual(fields, reply);
    assert.deepEqual(order, Object.keys(reply));
    assert.deepEqual(sentences, ["Berries, Ana!", 'Mostly blackberries "from" the hedge.', "And pumpkin soup...", "honestly, é bussin \u{1F383}."]);
  });
}

test("a sentence is released before the field is complete", () => {
  const sentences = [];
  const split = new SentenceSplitter((s) => sentences.push(s));
  const stream = new JsonFieldStream({ streamed: ["reply"], onText: (k, t) => split.update(t) });
  stream.push('{"reply": "Dogs, no contest. They are loy');
  assert.deepEqual(sentences, ["Dogs, no contest."]);
});
