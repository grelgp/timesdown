/* Time's Down - game rules.
 *
 * Pure functions, no DOM. Shared by the browser client and the Node tests so
 * the fiddly part of the game (what happens to the pile after a turn) is
 * checked rather than hoped for.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimesDownRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ROUNDS = [
    {
      label: 'Round 1 of 3',
      short: 'Round 1',
      title: 'Describe',
      rule: 'Say anything you like to get the word across - anything except the word itself, or any piece of it.'
    },
    {
      label: 'Round 2 of 3',
      short: 'Round 2',
      title: 'One word',
      rule: 'One single word as your clue, said once. Then you go quiet.'
    },
    {
      label: 'Round 3 of 3',
      short: 'Round 3',
      title: 'Mime',
      rule: 'No words, no sounds. Act it out.'
    }
  ];

  function shuffle(list, random) {
    var rnd = random || Math.random;
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Settle a turn once the speaker has corrected their calls.
   *
   * `deck` is the pile as it stands after live play: guessed cards were pulled
   * out, skipped cards were pushed to the bottom. `results` may disagree with
   * that, because the review screen lets the speaker flip either way - so this
   * reconciles the two and is safe to run repeatedly on the same input.
   *
   * @param {string[]} deck    remaining card ids, in order
   * @param {string[]} order   card ids seen this turn, first appearance first
   * @param {Object}   results id -> 'ok' | 'skip'
   * @returns {{deck: string[], scored: number}}
   */
  function applyTurn(deck, order, results) {
    var kept = Object.create(null);
    order.forEach(function (id) {
      if (results[id] === 'ok') kept[id] = true;
    });

    // Anything finally marked "got it" leaves the round, wherever it sits now.
    var next = deck.filter(function (id) { return !kept[id]; });

    // Anything flipped back to "skipped" rejoins the bottom of the pile.
    order.forEach(function (id) {
      if (results[id] === 'skip' && next.indexOf(id) === -1) next.push(id);
    });

    return { deck: next, scored: Object.keys(kept).length };
  }

  /** Live play: the card is guessed and leaves the pile. */
  function takeCard(deck) {
    var next = deck.slice();
    var id = next.shift();
    return { deck: next, id: id };
  }

  /** Live play: the card goes to the bottom and comes round again. */
  function bury(deck) {
    var next = deck.slice();
    var id = next.shift();
    if (id !== undefined) next.push(id);
    return { deck: next, id: id };
  }

  return {
    ROUNDS: ROUNDS,
    shuffle: shuffle,
    applyTurn: applyTurn,
    takeCard: takeCard,
    bury: bury
  };
}));
