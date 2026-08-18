'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules.js');

const { applyTurn, takeCard, bury, shuffle } = Rules;

test('a clean turn: everything guessed leaves the pile', () => {
  const deck = ['c', 'd']; // a and b were already taken during the turn
  const out = applyTurn(deck, ['a', 'b'], { a: 'ok', b: 'ok' });
  assert.deepEqual(out.deck, ['c', 'd']);
  assert.equal(out.scored, 2);
});

test('skipped cards stay in the pile and score nothing', () => {
  // Live play buried 'a' and 'b' at the bottom.
  const deck = ['c', 'a', 'b'];
  const out = applyTurn(deck, ['a', 'b'], { a: 'skip', b: 'skip' });
  assert.deepEqual(out.deck, ['c', 'a', 'b']);
  assert.equal(out.scored, 0);
});

test('correction: a card wrongly validated goes back into the pile', () => {
  const deck = ['c'];                      // 'a' was pulled out when validated
  const out = applyTurn(deck, ['a'], { a: 'skip' });
  assert.deepEqual(out.deck, ['c', 'a'], 'returns to the bottom');
  assert.equal(out.scored, 0);
});

test('correction: a card wrongly skipped is removed and counted', () => {
  const deck = ['c', 'a'];                 // 'a' was buried when skipped
  const out = applyTurn(deck, ['a'], { a: 'ok' });
  assert.deepEqual(out.deck, ['c']);
  assert.equal(out.scored, 1);
});

test('a card skipped then guessed in the same turn counts once', () => {
  // 'a' came round twice: skipped, then validated. Live play removed it.
  const deck = ['b'];
  const out = applyTurn(deck, ['a'], { a: 'ok' });
  assert.deepEqual(out.deck, ['b']);
  assert.equal(out.scored, 1);
});

test('applying the same turn twice changes nothing (idempotent)', () => {
  const first = applyTurn(['c', 'a'], ['a', 'b'], { a: 'skip', b: 'ok' });
  const second = applyTurn(first.deck, ['a', 'b'], { a: 'skip', b: 'ok' });
  assert.deepEqual(second.deck, first.deck);
  assert.equal(second.scored, first.scored);
});

test('no duplicates appear when a skipped card is already in the pile', () => {
  const out = applyTurn(['a', 'b'], ['a'], { a: 'skip' });
  assert.deepEqual(out.deck, ['a', 'b']);
});

test('takeCard removes the top card, bury sends it to the bottom', () => {
  assert.deepEqual(takeCard(['a', 'b', 'c']), { deck: ['b', 'c'], id: 'a' });
  assert.deepEqual(bury(['a', 'b', 'c']), { deck: ['b', 'c', 'a'], id: 'a' });
  assert.deepEqual(bury([]), { deck: [], id: undefined });
});

test('a round always terminates: every card ends up guessed', () => {
  // Simulate a whole round of alternating skips and guesses.
  let deck = shuffle(Array.from({ length: 40 }, (_, i) => 'w' + i));
  let guessed = 0;
  let guard = 0;

  while (deck.length) {
    assert.ok(++guard < 5000, 'round should terminate');
    const order = [];
    const results = {};
    // One turn: look at up to 8 cards, guessing two out of every three.
    for (let i = 0; i < 8 && deck.length; i++) {
      const top = deck[0];
      if (!(top in results)) order.push(top);
      if (i % 3 === 2) {
        results[top] = 'skip';
        deck = bury(deck).deck;
      } else {
        results[top] = 'ok';
        deck = takeCard(deck).deck;
      }
    }
    const settled = applyTurn(deck, order, results);
    deck = settled.deck;
    guessed += settled.scored;
  }

  assert.equal(guessed, 40, 'every card scores exactly once across the round');
});

test('shuffle keeps every card exactly once', () => {
  const input = Array.from({ length: 100 }, (_, i) => i);
  const out = shuffle(input);
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort((a, b) => a - b), input);
  assert.deepEqual(input, Array.from({ length: 100 }, (_, i) => i), 'input untouched');
});
