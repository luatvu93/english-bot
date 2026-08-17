// Self-checks for the deck: no duplicates, correct level ordering, correct wrap-around.
import assert from "node:assert/strict";

process.env.TELEGRAM_TOKEN ??= "test-token"; // grammy refuses an empty token
const { DECK, nextCard, levelStart } = await import("./bot.js");

// A word must never appear twice, or the learner sees the same card again mid-cycle.
const seen = new Set();
for (const card of DECK) {
  assert.ok(!seen.has(card.word), `duplicate word: ${card.word}`);
  seen.add(card.word);
}

// Levels stay grouped and in ascending order.
const levels = ["A1", "A2", "B1", "B2", "C1", "C2"];
const order = DECK.map((card) => levels.indexOf(card.level));
for (let i = 1; i < order.length; i++) {
  assert.ok(order[i] >= order[i - 1], `level goes backwards at index ${i}`);
}

// levelStart points at the first card of that level.
for (const level of levels) {
  const start = levelStart(level);
  assert.equal(DECK[start].level, level);
  assert.ok(start === 0 || DECK[start - 1].level !== level);
}

// Walking the whole deck returns every card exactly once and lands back at 0.
let index = 0;
const walked = [];
for (let i = 0; i < DECK.length; i++) {
  const step = nextCard(index);
  walked.push(step.card.word);
  index = step.next;
}
assert.equal(index, 0, "deck should wrap back to the start");
assert.equal(new Set(walked).size, DECK.length);

// A stored index past the end still resolves instead of crashing.
assert.equal(nextCard(DECK.length).card.word, DECK[0].word);

console.log(`ok - ${DECK.length} words`);
