/* Time's Down - client.
 *
 * Two very different jobs live in here:
 *   1. The lobby, which every phone in the room sees. It talks to the server
 *      and only ever learns the words this device typed itself.
 *   2. The game, which runs entirely on the host's phone once the deck is
 *      dealt. No round trips mid-turn, so a flaky Wi-Fi can't stall a card.
 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var flashEl = document.getElementById('flash');
  var toastEl = document.getElementById('toast');

  var Rules = window.TimesDownRules;
  var ROUNDS = Rules.ROUNDS;
  var shuffle = Rules.shuffle;

  var TURN_CHOICES = [30, 45, 60, 90];
  var FLASH_MS = 250;

  // ------------------------------------------------------------------ state

  var S = {
    view: 'home',      // home | lobby | game
    room: null,        // last state from the server
    game: null,        // host-side game, see newGame()
    openWord: null,    // id of the word chip currently expanded
    confirmStart: false,
    busy: false,
    renderKey: null
  };

  var es = null;
  var pollHandle = null;
  var timerHandle = null;
  var flashHandle = null;
  var toastHandle = null;
  var audioCtx = null;
  var wakeLock = null;

  // ---------------------------------------------------------------- storage

  function ls(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private browsing */ }
    return null;
  }

  function deviceId() {
    var id = ls('td.deviceId');
    if (!id) {
      id = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      ls('td.deviceId', id);
    }
    return id;
  }

  function session() {
    try { return JSON.parse(ls('td.session') || 'null'); } catch (e) { return null; }
  }

  function setSession(value) {
    ls('td.session', value ? JSON.stringify(value) : null);
  }

  function saveGame() {
    var sess = session();
    if (!sess) return;
    ls('td.game.' + sess.code, S.game ? JSON.stringify(S.game) : null);
  }

  function loadGame(code) {
    try { return JSON.parse(ls('td.game.' + code) || 'null'); } catch (e) { return null; }
  }

  // ------------------------------------------------------------- small utils

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.className = 'on' + (isError ? ' err' : '');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(function () { toastEl.className = ''; }, 2600);
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* no-op */ }
  }

  /** A short tone, so the speaker can put the phone down and still hear time run out. */
  function beep(frequency, ms) {
    try {
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + ms / 1000 + 0.03);
    } catch (e) { /* audio is a nicety, never a blocker */ }
  }

  function unlockAudio() {
    beep(1, 1); // creates + resumes the context inside a user gesture
  }

  function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        navigator.wakeLock.request('screen').then(function (lock) {
          wakeLock = lock;
          lock.addEventListener('release', function () { wakeLock = null; });
        }, function () { /* denied, no harm */ });
      } else if (!on && wakeLock) {
        wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* unsupported */ }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.view === 'game') keepAwake(true);
  });

  // --------------------------------------------------------------------- api

  function api(path, body) {
    return fetch('/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Something went wrong');
        return data;
      });
    });
  }

  function auth(extra) {
    var sess = session() || {};
    var body = { deviceId: deviceId(), ownerToken: sess.ownerToken || undefined };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    return body;
  }

  // ------------------------------------------------------------ live updates

  function connect() {
    var sess = session();
    if (!sess) return;
    disconnect();
    var qs = '?deviceId=' + encodeURIComponent(deviceId()) +
      (sess.ownerToken ? '&ownerToken=' + encodeURIComponent(sess.ownerToken) : '');
    try {
      es = new EventSource('/api/rooms/' + sess.code + '/events' + qs);
      es.onmessage = function (event) {
        try { onServerState(JSON.parse(event.data)); } catch (e) { /* ignore junk */ }
      };
    } catch (e) {
      es = null;
    }
    // Safety net: some mobile networks buffer streamed responses to death.
    clearInterval(pollHandle);
    pollHandle = setInterval(function () {
      if (es && es.readyState === 1) return;
      fetch('/api/rooms/' + sess.code + '/state' + qs)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) onServerState(data); })
        .catch(function () { /* offline, try again next tick */ });
    }, 4000);
  }

  function disconnect() {
    if (es) { try { es.close(); } catch (e) { /* already closed */ } es = null; }
    clearInterval(pollHandle);
    pollHandle = null;
  }

  function onServerState(state) {
    var wasPhase = S.room && S.room.phase;
    S.room = state;
    if (S.view === 'home') S.view = 'lobby';

    // The host's game screen owns the display while a game is running; a lobby
    // broadcast must never yank a card out from under the speaker's thumb.
    if (S.view === 'game') return;

    if (wasPhase && wasPhase !== state.phase) S.confirmStart = false;
    if (S.renderKey && S.renderKey.indexOf('lobby|') === 0 && lobbyKey() === S.renderKey) {
      patchLobby();
      return;
    }
    render();
  }

  // -------------------------------------------------------------- game model

  function newGame(deck, settings) {
    var cards = {};
    var ids = [];
    deck.forEach(function (card) { cards[card.id] = card.text; ids.push(card.id); });
    var names = settings.teamNames.slice(0, settings.teams);
    return {
      v: 1,
      teamNames: names,
      turnSeconds: settings.turnSeconds,
      scores: names.map(function () { return [0, 0, 0]; }),
      cards: cards,
      allIds: ids,
      round: 0,
      team: 0,
      deck: shuffle(ids),
      stage: 'turn-intro',   // turn-intro | play | review | round-end | game-end
      turn: null
    };
  }

  function beginTurn() {
    var g = S.game;
    g.turn = {
      order: [],
      results: {},
      endsAt: Date.now() + g.turnSeconds * 1000,
      current: g.deck.length ? g.deck[0] : null,
      reason: null
    };
    g.stage = 'play';
    saveGame();
    unlockAudio();
    keepAwake(true);
    startTimer();
    render();
  }

  function startTimer() {
    stopTimer();
    timerHandle = setInterval(function () {
      var g = S.game;
      if (!g || g.stage !== 'play' || !g.turn) return stopTimer();
      var left = g.turn.endsAt - Date.now();
      paintTimer(left);
      if (left <= 0) endTurn('time');
    }, 100);
  }

  function stopTimer() {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  function paintTimer(msLeft) {
    var g = S.game;
    var total = g.turnSeconds * 1000;
    var left = Math.max(0, msLeft);
    var seconds = Math.ceil(left / 1000);
    var text = document.getElementById('timerText');
    var bar = document.getElementById('timerBar');
    if (text) {
      text.textContent = String(seconds);
      text.className = 'timer' + (seconds <= 5 ? ' low' : '');
    }
    if (bar) {
      bar.firstElementChild.style.width = (left / total * 100).toFixed(2) + '%';
      bar.className = 'timer-bar' + (seconds <= 5 ? ' low' : '');
    }
  }

  function noteCard(id, result) {
    var turn = S.game.turn;
    if (!(id in turn.results)) turn.order.push(id);
    turn.results[id] = result;
  }

  function validateCard() {
    var g = S.game;
    if (!g || g.stage !== 'play' || !g.turn.current) return;
    var id = g.turn.current;
    noteCard(id, 'ok');
    g.deck.shift();
    flashGreen();
    buzz(35);
    nextCard();
  }

  function skipCard() {
    var g = S.game;
    if (!g || g.stage !== 'play' || !g.turn.current) return;
    var id = g.turn.current;
    noteCard(id, 'skip');
    g.deck.shift();
    g.deck.push(id);       // straight to the bottom of the pile
    flashSkip();
    buzz(12);
    nextCard();
  }

  function nextCard() {
    var g = S.game;
    if (!g.deck.length) return endTurn('cleared');
    g.turn.current = g.deck[0];
    saveGame();
    render();
  }

  function endTurn(reason) {
    var g = S.game;
    if (!g || g.stage !== 'play') return;
    stopTimer();
    g.turn.reason = reason;
    g.turn.current = null;
    g.stage = 'review';
    saveGame();
    if (reason === 'time') {
      buzz([140, 70, 140]);
      beep(660, 200);
      setTimeout(function () { beep(440, 320); }, 220);
    } else {
      beep(880, 160);
    }
    render();
  }

  function turnScore() {
    var turn = S.game.turn;
    return turn.order.filter(function (id) { return turn.results[id] === 'ok'; }).length;
  }

  /** Apply the speaker's corrections, bank the score, hand over to the next team. */
  function confirmReview() {
    var g = S.game;
    var settled = Rules.applyTurn(g.deck, g.turn.order, g.turn.results);
    g.deck = settled.deck;
    g.scores[g.team][g.round] += settled.scored;
    g.turn = null;

    if (!g.deck.length) {
      g.stage = 'round-end';
    } else {
      g.team = (g.team + 1) % g.teamNames.length;
      g.stage = 'turn-intro';
    }
    saveGame();
    render();
  }

  function nextRound() {
    var g = S.game;
    if (g.round < ROUNDS.length - 1) {
      g.round += 1;
      g.deck = shuffle(g.allIds);
      g.team = (g.team + 1) % g.teamNames.length;
      g.stage = 'turn-intro';
      saveGame();
      render();
    } else {
      g.stage = 'game-end';
      saveGame();
      keepAwake(false);
      publishResults();
      render();
    }
  }

  function totalFor(g, teamIndex) {
    return g.scores[teamIndex].reduce(function (a, b) { return a + b; }, 0);
  }

  function publishResults() {
    var g = S.game;
    var sess = session();
    if (!sess || !sess.ownerToken) return;
    api('/rooms/' + sess.code + '/finish', auth({
      results: {
        teamNames: g.teamNames,
        scores: g.scores,
        totals: g.teamNames.map(function (_, i) { return totalFor(g, i); })
      }
    })).catch(function () { /* the scoreboard is on screen either way */ });
  }

  function flashGreen() {
    flash();
  }

  function flashSkip() {
    flash('skip');
  }

  function flash(variant) {
    flashEl.className = variant ? 'on ' + variant : 'on';
    clearTimeout(flashHandle);
    flashHandle = setTimeout(function () { flashEl.className = ''; }, FLASH_MS);
  }

  // ------------------------------------------------------------------ render

  function render() {
    if (S.view === 'game' && S.game) return renderGame();
    if (S.view === 'lobby' && S.room) return renderLobby();
    return renderHome();
  }

  function setHtml(key, html) {
    S.renderKey = key;
    app.innerHTML = html;
  }

  function on(id, event, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    return el;
  }

  // ---- home ----------------------------------------------------------------

  function renderHome() {
    setHtml('home', [
      '<div class="spacer"></div>',
      '<div class="brand">',
      '  <div class="brand-mark">&#9203;</div>',
      "  <h1>Time&#39;s Down</h1>",
      '  <div class="tag">Describe &middot; One word &middot; Mime</div>',
      '</div>',
      '<div class="spacer"></div>',
      '<div class="stack">',
      '  <button class="btn btn-primary btn-lg btn-block" id="createBtn">Create a room</button>',
      '  <div class="divider">or join one</div>',
      '  <input class="field field-code" id="codeInput" maxlength="4" placeholder="CODE"',
      '         autocomplete="off" autocorrect="off" autocapitalize="characters"',
      '         spellcheck="false" enterkeyhint="go" aria-label="Room code">',
      '  <button class="btn btn-lg btn-block" id="joinBtn" disabled>Join room</button>',
      '</div>',
      '<div class="spacer"></div>',
      '<p class="small muted center">Everyone adds cards from their own phone.<br>',
      "The host&#39;s phone then runs the whole game.</p>"
    ].join(''));

    var codeInput = document.getElementById('codeInput');
    var joinBtn = document.getElementById('joinBtn');

    codeInput.addEventListener('input', function () {
      var cleaned = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (cleaned !== codeInput.value) codeInput.value = cleaned;
      joinBtn.disabled = cleaned.length !== 4;
    });
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && codeInput.value.length === 4) joinRoom(codeInput.value);
    });

    on('createBtn', 'click', createRoom);
    joinBtn.addEventListener('click', function () { joinRoom(codeInput.value); });
  }

  function createRoom() {
    if (S.busy) return;
    S.busy = true;
    api('/rooms', { deviceId: deviceId() }).then(function (data) {
      setSession({ code: data.code, ownerToken: data.ownerToken });
      S.room = data.state;
      S.view = 'lobby';
      connect();
      render();
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () { S.busy = false; });
  }

  function joinRoom(rawCode) {
    var code = String(rawCode || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4 || S.busy) return;
    S.busy = true;
    api('/rooms/' + code + '/join', { deviceId: deviceId() }).then(function (state) {
      setSession({ code: code, ownerToken: null });
      S.room = state;
      S.view = 'lobby';
      connect();
      render();
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () { S.busy = false; });
  }

  function leaveRoom() {
    var sess = session();
    if (sess) ls('td.game.' + sess.code, null);
    disconnect();
    stopTimer();
    keepAwake(false);
    setSession(null);
    S.room = null;
    S.game = null;
    S.view = 'home';
    S.confirmStart = false;
    S.openWord = null;
    render();
  }

  // ---- lobby ---------------------------------------------------------------

  function lobbyKey() {
    var r = S.room;
    return ['lobby', r.phase, r.isOwner, S.openWord, S.confirmStart,
      r.settings.teams, r.settings.turnSeconds].join('|');
  }

  function wordListHtml() {
    var words = S.room.myWords;
    if (!words.length) {
      return '<p class="small muted center" style="padding:10px 0">' +
        'No cards from this phone yet. Add the first one above.</p>';
    }
    return words.map(function (word, index) {
      var open = S.openWord === word.id;
      var body = open
        ? '<span class="revealed-text">' + esc(word.text) + '</span>' +
          '<span class="hint">tap to hide</span>'
        // A fixed-width mask: varying it would leak the length of the word.
        : '<span class="masked">••••••••</span>' +
          '<span class="hint">tap to view</span>';
      return '<button class="wordchip' + (open ? ' open' : '') + '" data-word="' + word.id + '">' +
        '<span class="idx">' + (index + 1) + '</span>' + body + '</button>' +
        (open ? '<div class="chip-actions">' +
          '<button class="btn btn-sm btn-danger" data-delete="' + word.id + '">Remove this card</button>' +
          '</div>' : '');
    }).join('');
  }

  function countsHtml() {
    var r = S.room;
    return [
      '<div class="counts">',
      '  <div class="count"><div class="n" id="cMine">' + r.myWordCount + '</div>',
      '    <div class="k">from this phone</div></div>',
      '  <div class="count"><div class="n accent" id="cTotal">' + r.totalWords + '</div>',
      '    <div class="k">cards in deck</div></div>',
      '  <div class="count"><div class="n" id="cDevices">' + r.deviceCount + '</div>',
      '    <div class="k">phones here</div></div>',
      '</div>'
    ].join('');
  }

  function addFormHtml() {
    return [
      '<form id="addForm" class="stack-sm" autocomplete="off">',
      '  <div class="row">',
      '    <input class="field grow" id="wordInput" placeholder="Add a card&hellip;" maxlength="64"',
      '           autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"',
      '           enterkeyhint="done" aria-label="New card">',
      '    <button class="btn btn-primary" id="addBtn" type="submit" disabled>Add</button>',
      '  </div>',
      '  <div id="wordNote"></div>',
      '</form>'
    ].join('');
  }

  function ownerSettingsHtml() {
    var s = S.room.settings;
    var teamButtons = '';
    for (var n = 2; n <= 6; n++) {
      teamButtons += '<button type="button" class="btn" data-teams="' + n + '" aria-pressed="' +
        (s.teams === n) + '">' + n + '</button>';
    }
    var nameInputs = s.teamNames.map(function (name, i) {
      return '<input class="field" data-teamname="' + i + '" maxlength="24" value="' + esc(name) +
        '" aria-label="Name of team ' + (i + 1) + '" placeholder="Team ' + (i + 1) + '">';
    }).join('');
    var turnButtons = TURN_CHOICES.map(function (secs) {
      return '<button type="button" class="btn" data-turn="' + secs + '" aria-pressed="' +
        (s.turnSeconds === secs) + '">' + secs + 's</button>';
    }).join('');

    return [
      '<div class="panel stack">',
      '  <div class="stack-sm">',
      '    <h3>How many teams?</h3>',
      '    <div class="seg" id="teamSeg">' + teamButtons + '</div>',
      '  </div>',
      '  <div class="stack-sm" id="teamNames">' + nameInputs + '</div>',
      '  <div class="stack-sm">',
      '    <h3>Turn length</h3>',
      '    <div class="seg" id="turnSeg">' + turnButtons + '</div>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function startBlockHtml() {
    var r = S.room;
    if (!S.confirmStart) {
      return '<button class="btn btn-primary btn-lg btn-block" id="startBtn"' +
        (r.totalWords < 1 ? ' disabled' : '') + '>Start the game</button>' +
        (r.totalWords < 1
          ? '<p class="small muted center">Add at least one card first.</p>'
          : '<p class="small muted center">Check the deck size with the table before you start.</p>');
    }
    return [
      '<div class="panel stack">',
      '  <div class="center stack-sm">',
      '    <h2>Start with ' + r.totalWords + ' ' + (r.totalWords === 1 ? 'card' : 'cards') + '?</h2>',
      '    <p class="small muted">This locks the deck for the game. Anyone still adding cards is',
      '       filling the deck for the <em>next</em> game.</p>',
      '  </div>',
      '  <div class="row">',
      '    <button class="btn grow" id="cancelStart">Not yet</button>',
      '    <button class="btn btn-ok grow" id="confirmStart">Deal the cards</button>',
      '  </div>',
      '</div>'
    ].join('');
  }

  function phaseNoticeHtml() {
    var r = S.room;
    if (r.phase === 'playing') {
      return '<div class="notice notice-info">A game is running on the host&#39;s phone. ' +
        'You can keep adding cards here - they go into the next game.</div>';
    }
    if (r.phase === 'results' && r.results) {
      return '<div class="panel stack-sm">' + podiumHtml(r.results.teamNames, r.results.totals) +
        (r.isOwner ? '' : '<p class="small muted center">Waiting for the host to set up the next game.</p>') +
        '</div>';
    }
    return '';
  }

  function renderLobby() {
    var r = S.room;
    var parts = [
      '<div class="topbar">',
      "  <span class=\"title\">Time&#39;s Down</span>",
      '  <span class="row small muted"><span class="dot" id="liveDot"></span>',
      '    <span class="code-tag">' + esc(r.code) + '</span></span>',
      '</div>'
    ];

    if (r.isOwner) {
      parts.push(
        '<div class="codebox stack-sm">',
        '  <div class="label">Players join at</div>',
        '  <div class="url">' + esc(location.host) + '</div>',
        '  <div class="label">with the code</div>',
        '  <div class="code mono-code">' + esc(r.code) + '</div>',
        '</div>'
      );
    }

    parts.push(phaseNoticeHtml());
    parts.push(countsHtml());
    parts.push('<div class="stack">' + addFormHtml() + '</div>');
    parts.push('<div class="wordlist" id="wordList">' + wordListHtml() + '</div>');

    if (r.isOwner && r.phase !== 'playing') {
      parts.push(ownerSettingsHtml());
      parts.push(startBlockHtml());
    } else if (!r.isOwner && r.phase === 'lobby') {
      parts.push('<p class="small muted center">Waiting for the host to start. ' +
        'Keep adding cards until then.</p>');
    }

    if (r.isOwner && r.phase === 'playing') {
      parts.push('<div class="notice notice-info">This phone is running a game. ' +
        'If you closed it by accident, resume below.</div>');
      parts.push('<button class="btn btn-primary btn-lg btn-block" id="resumeBtn">Resume the game</button>');
    }

    parts.push('<div class="spacer"></div>');
    parts.push('<button class="btn btn-ghost btn-sm" id="leaveBtn">Leave room</button>');

    setHtml(lobbyKey(), parts.join(''));
    wireLobby();
  }

  function wireLobby() {
    var r = S.room;
    var input = document.getElementById('wordInput');
    var addBtn = document.getElementById('addBtn');
    var note = document.getElementById('wordNote');

    function checkDraft() {
      var value = input.value.replace(/\s+/g, ' ').trim();
      addBtn.disabled = value.length === 0;   // empty is the only hard block
      var messages = [];
      if (/\s/.test(value)) {
        messages.push('That is more than one word. Allowed - just making sure it is on purpose.');
      }
      var clash = S.room.myWords.some(function (w) {
        return w.text.toLowerCase() === value.toLowerCase();
      });
      if (value && clash) messages.push('You already added this exact card from this phone.');
      note.innerHTML = messages.length
        ? '<div class="notice notice-warn">' + messages.map(esc).join('<br>') + '</div>'
        : '';
    }

    input.addEventListener('input', checkDraft);

    document.getElementById('addForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var value = input.value.replace(/\s+/g, ' ').trim();
      if (!value) { toast('A card needs some text.', true); return; }
      addBtn.disabled = true;
      api('/rooms/' + r.code + '/words', auth({ text: value })).then(function (data) {
        input.value = '';
        S.room = data.state;
        checkDraft();
        patchLobby();
        input.focus();          // stay in the field so one person can rattle off cards
      }).catch(function (err) {
        toast(err.message, true);
        addBtn.disabled = false;
      });
    });

    document.getElementById('wordList').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-word]');
      var del = e.target.closest('[data-delete]');
      if (del) {
        var id = del.getAttribute('data-delete');
        api('/rooms/' + r.code + '/words/' + id + '/delete', auth()).then(function (state) {
          S.room = state;
          S.openWord = null;
          render();
          toast('Card removed.');
        }).catch(function (err) { toast(err.message, true); });
        return;
      }
      if (chip) {
        var wordId = chip.getAttribute('data-word');
        S.openWord = S.openWord === wordId ? null : wordId;
        render();
      }
    });

    on('leaveBtn', 'click', function () {
      if (S.room.isOwner && !window.confirm('Leave and close this room on this phone?')) return;
      leaveRoom();
    });

    on('resumeBtn', 'click', function () {
      var saved = loadGame(S.room.code);
      if (saved) {
        S.game = saved;
        if (S.game.stage === 'play') {
          // Time kept running while the app was gone; do not resume mid-turn.
          S.game.stage = 'review';
          S.game.turn.current = null;
          S.game.turn.reason = 'time';
        }
        S.view = 'game';
        render();
      } else {
        api('/rooms/' + S.room.code + '/reset', auth({ mode: 'replay' })).then(function (data) {
          startGameWith(data.deck, data.settings);
        }).catch(function (err) { toast(err.message, true); });
      }
    });

    var teamSeg = document.getElementById('teamSeg');
    if (teamSeg) {
      teamSeg.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-teams]');
        if (!btn) return;
        saveSettings({ teams: Number(btn.getAttribute('data-teams')) });
      });
    }

    var turnSeg = document.getElementById('turnSeg');
    if (turnSeg) {
      turnSeg.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-turn]');
        if (!btn) return;
        saveSettings({ turnSeconds: Number(btn.getAttribute('data-turn')) });
      });
    }

    var teamNames = document.getElementById('teamNames');
    if (teamNames) {
      teamNames.addEventListener('change', function () {
        var names = [].slice.call(teamNames.querySelectorAll('[data-teamname]'))
          .map(function (el) { return el.value; });
        saveSettings({ teamNames: names });
      });
    }

    on('startBtn', 'click', function () { S.confirmStart = true; render(); });
    on('cancelStart', 'click', function () { S.confirmStart = false; render(); });
    on('confirmStart', 'click', function () {
      unlockAudio();
      api('/rooms/' + S.room.code + '/start', auth()).then(function (data) {
        S.confirmStart = false;
        startGameWith(data.deck, data.settings);
      }).catch(function (err) { toast(err.message, true); });
    });

    checkDraft();
  }

  /** Update the numbers and the card list without rebuilding the screen. */
  function patchLobby() {
    var r = S.room;
    var mine = document.getElementById('cMine');
    var total = document.getElementById('cTotal');
    var devices = document.getElementById('cDevices');
    var list = document.getElementById('wordList');
    if (mine) mine.textContent = r.myWordCount;
    if (total) total.textContent = r.totalWords;
    if (devices) devices.textContent = r.deviceCount;
    if (list) list.innerHTML = wordListHtml();
    var dot = document.getElementById('liveDot');
    if (dot) dot.className = 'dot' + (es && es.readyState === 1 ? '' : ' off');
  }

  function saveSettings(patch) {
    api('/rooms/' + S.room.code + '/settings', auth(patch)).then(function (state) {
      S.room = state;
      render();
    }).catch(function (err) { toast(err.message, true); });
  }

  function startGameWith(deck, settings) {
    S.game = newGame(deck, settings);
    S.view = 'game';
    saveGame();
    keepAwake(true);
    render();
  }

  // ---- game ----------------------------------------------------------------

  function renderGame() {
    var g = S.game;
    if (g.stage === 'play') return renderPlay();
    if (g.stage === 'review') return renderReview();
    if (g.stage === 'round-end') return renderRoundEnd();
    if (g.stage === 'game-end') return renderGameEnd();
    return renderTurnIntro();
  }

  function gameTopbar(showQuit) {
    return '<div class="topbar">' +
      '<span class="title">' + esc(ROUNDS[S.game.round].title) + '</span>' +
      (showQuit ? '<button class="btn btn-sm btn-ghost" id="quitBtn">End game</button>' : '') +
      '</div>';
  }

  function renderTurnIntro() {
    var g = S.game;
    var round = ROUNDS[g.round];
    setHtml('game|intro|' + g.round + '|' + g.team, [
      gameTopbar(true),
      '<div class="game">',
      '  <div class="spacer"></div>',
      '  <div class="game-head stack-sm">',
      '    <span class="round-pill">' + esc(round.label) + ' &middot; ' + esc(round.title) + '</span>',
      '    <div class="team-name">' + esc(g.teamNames[g.team]) + "&#39;s turn</div>",
      '    <p class="small muted">' + esc(round.rule) + '</p>',
      '  </div>',
      '  <div class="spacer"></div>',
      '  <div class="panel center stack-sm">',
      '    <p class="small muted">Pass the phone to the speaker.</p>',
      '    <p>' + plural(g.deck.length, 'card', 'cards') + ' left in this round</p>',
      '  </div>',
      '  <button class="btn btn-primary btn-lg btn-block" id="startTurn">Start the ' +
        g.turnSeconds + 's turn</button>',
      '</div>'
    ].join(''));

    on('startTurn', 'click', beginTurn);
    on('quitBtn', 'click', quitGame);
    renderScoresInto();
  }

  function renderPlay() {
    var g = S.game;
    var text = g.cards[g.turn.current] || '';
    var got = turnScore();
    setHtml('game|play|' + g.turn.current, [
      '<div class="game">',
      '  <div class="game-head stack-sm">',
      '    <span class="round-pill">' + esc(ROUNDS[g.round].title) + ' &middot; ' +
           esc(g.teamNames[g.team]) + '</span>',
      '    <div class="timer" id="timerText">' + g.turnSeconds + '</div>',
      '    <div class="timer-bar" id="timerBar"><span style="width:100%"></span></div>',
      '  </div>',
      '  <div class="card" id="card">',
      '    <div class="card-word">' + esc(text) + '</div>',
      '    <div class="card-veil"><span class="finger">&#128072;</span><span>Hold to read</span></div>',
      '  </div>',
      '  <div class="card-meta">',
      '    <span>' + plural(got, 'card', 'cards') + ' this turn</span>',
      '    <span>' + plural(g.deck.length, 'card', 'cards') + ' left</span>',
      '  </div>',
      '  <div class="actions">',
      '    <button class="btn btn-lg" id="skipBtn" style="flex:1">Skip</button>',
      '    <button class="btn btn-ok btn-lg" id="okBtn" style="flex:1.6">Got it</button>',
      '  </div>',
      '</div>'
    ].join(''));

    wireHoldToReveal(document.getElementById('card'));
    on('skipBtn', 'click', skipCard);
    on('okBtn', 'click', validateCard);
    paintTimer(g.turn.endsAt - Date.now());
    if (!timerHandle) startTimer();
  }

  /** Reveal while a finger is down, hide the moment it lifts. */
  function wireHoldToReveal(el) {
    if (!el) return;
    var show = function (e) {
      e.preventDefault();
      if (el.setPointerCapture && e.pointerId !== undefined) {
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      }
      el.classList.add('revealed');
    };
    var hide = function () { el.classList.remove('revealed'); };
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerup', hide);
    el.addEventListener('pointercancel', hide);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function renderReview() {
    var g = S.game;
    var turn = g.turn;
    var rows = turn.order.map(function (id) {
      var kept = turn.results[id] === 'ok';
      return '<div class="review-row ' + (kept ? 'ok' : 'skip') + '" data-row="' + id + '">' +
        '<button class="review-word" data-reveal="' + id + '">' + esc(g.cards[id]) + '</button>' +
        '<button class="toggle" data-toggle="' + id + '" aria-label="Toggle this card">' +
        (kept ? '&#10003;' : '&#8722;') + '</button>' +
        '</div>';
    }).join('');

    var heading = turn.reason === 'cleared' ? 'Pile cleared!' : "Time&#39;s up";

    setHtml('game|review|' + g.round + '|' + g.team, [
      '<div class="game">',
      '  <div class="game-head stack-sm">',
      '    <span class="round-pill">' + esc(g.teamNames[g.team]) + '</span>',
      '    <h2>' + heading + '</h2>',
      '    <p class="small muted">Speaker: fix any bad calls. Hold a word to read it, ',
      '       tap the button on the right to flip it.</p>',
      '  </div>',
      turn.order.length
        ? '<div class="review-list" id="reviewList">' + rows + '</div>'
        : '<div class="panel center muted">No cards came up this turn.</div>',
      '  <div class="panel-tight panel row-between">',
      '    <span>' + esc(g.teamNames[g.team]) + ' this turn</span>',
      '    <strong id="turnScore" style="font-size:1.3rem">' + turnScore() + '</strong>',
      '  </div>',
      '  <button class="btn btn-primary btn-lg btn-block" id="confirmBtn">Confirm</button>',
      '</div>'
    ].join(''));

    var list = document.getElementById('reviewList');
    if (list) {
      [].slice.call(list.querySelectorAll('[data-reveal]')).forEach(function (el) {
        var show = function (e) {
          e.preventDefault();
          if (el.setPointerCapture && e.pointerId !== undefined) {
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
          }
          el.classList.add('revealed');
        };
        var hide = function () { el.classList.remove('revealed'); };
        el.addEventListener('pointerdown', show);
        el.addEventListener('pointerup', hide);
        el.addEventListener('pointercancel', hide);
        el.addEventListener('pointerleave', hide);
        el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      });

      list.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-toggle]');
        if (!btn) return;
        var id = btn.getAttribute('data-toggle');
        var kept = turn.results[id] === 'ok';
        turn.results[id] = kept ? 'skip' : 'ok';
        var row = list.querySelector('[data-row="' + id + '"]');
        row.className = 'review-row ' + (kept ? 'skip' : 'ok');
        btn.innerHTML = kept ? '&#8722;' : '&#10003;';
        document.getElementById('turnScore').textContent = turnScore();
        buzz(10);
        saveGame();
      });
    }

    on('confirmBtn', 'click', confirmReview);
  }

  function scoresTableHtml() {
    var g = S.game;
    var best = -1;
    g.teamNames.forEach(function (_, i) { best = Math.max(best, totalFor(g, i)); });
    var head = '<tr><th>Team</th><th>R1</th><th>R2</th><th>R3</th><th>Total</th></tr>';
    var body = g.teamNames.map(function (name, i) {
      var total = totalFor(g, i);
      return '<tr' + (total === best && total > 0 ? ' class="leader"' : '') + '>' +
        '<td>' + esc(name) + '</td>' +
        g.scores[i].map(function (n, r) {
          return '<td' + (r > g.round ? ' class="muted"' : '') + '>' + (r <= g.round ? n : '&ndash;') + '</td>';
        }).join('') +
        '<td class="total">' + total + '</td></tr>';
    }).join('');
    return '<table class="scores"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function podiumHtml(names, totals) {
    var order = names.map(function (name, i) { return { name: name, score: totals[i] }; })
      .sort(function (a, b) { return b.score - a.score; });
    var medals = ['🥇', '🥈', '🥉'];
    return '<div class="podium">' + order.map(function (row, i) {
      return '<div class="podium-row' + (i === 0 ? ' first' : '') + '">' +
        '<span class="rank">' + (medals[i] || (i + 1) + '.') + '</span>' +
        '<span class="pname">' + esc(row.name) + '</span>' +
        '<span class="pscore">' + row.score + '</span></div>';
    }).join('') + '</div>';
  }

  function renderRoundEnd() {
    var g = S.game;
    var last = g.round === ROUNDS.length - 1;
    setHtml('game|roundend|' + g.round, [
      gameTopbar(true),
      '<div class="game">',
      '  <div class="spacer"></div>',
      '  <div class="game-head stack-sm">',
      '    <span class="round-pill">' + esc(ROUNDS[g.round].label) + ' complete</span>',
      '    <h2>Every card has been guessed</h2>',
      '  </div>',
      '  <div class="panel">' + scoresTableHtml() + '</div>',
      last ? '' : '<p class="small muted center">The full deck comes back, shuffled, for ' +
        esc(ROUNDS[g.round + 1].title.toLowerCase()) + '.</p>',
      '  <div class="spacer"></div>',
      '  <button class="btn btn-primary btn-lg btn-block" id="nextBtn">' +
        (last ? 'See the final scores' : 'Start ' + esc(ROUNDS[g.round + 1].short)) +
        '</button>',
      '</div>'
    ].join(''));

    on('nextBtn', 'click', nextRound);
    on('quitBtn', 'click', quitGame);
  }

  function renderGameEnd() {
    var g = S.game;
    var totals = g.teamNames.map(function (_, i) { return totalFor(g, i); });
    setHtml('game|end', [
      '<div class="topbar"><span class="title">Final scores</span></div>',
      '<div class="game">',
      '  <div class="spacer"></div>',
      podiumHtml(g.teamNames, totals),
      '  <div class="panel">' + scoresTableHtml() + '</div>',
      '  <div class="spacer"></div>',
      '  <div class="stack">',
      '    <button class="btn btn-primary btn-lg btn-block" id="replayBtn">Play the same deck again</button>',
      '    <button class="btn btn-block" id="keepBtn">New deck &middot; keep the cards</button>',
      '    <button class="btn btn-block btn-danger" id="clearBtn">New deck &middot; clear every card</button>',
      '  </div>',
      '  <p class="small muted center">Keeping the cards means players can top up the deck ',
      '     before the next game.</p>',
      '</div>'
    ].join(''));

    on('replayBtn', 'click', function () {
      api('/rooms/' + S.room.code + '/reset', auth({ mode: 'replay' })).then(function (data) {
        startGameWith(data.deck, data.settings);
      }).catch(function (err) { toast(err.message, true); });
    });
    on('keepBtn', 'click', function () { backToLobby('keep'); });
    on('clearBtn', 'click', function () {
      if (!window.confirm('Delete every card in this room? Players will have to add new ones.')) return;
      backToLobby('clear');
    });
  }

  function backToLobby(mode) {
    api('/rooms/' + S.room.code + '/reset', auth({ mode: mode })).then(function (state) {
      S.game = null;
      saveGame();
      S.room = state;
      S.view = 'lobby';
      S.confirmStart = false;
      keepAwake(false);
      render();
    }).catch(function (err) { toast(err.message, true); });
  }

  function quitGame() {
    if (!window.confirm('End this game and go back to the lobby? Scores are lost.')) return;
    stopTimer();
    backToLobby('keep');
  }

  function renderScoresInto() {
    // Turn intro shows the running table underneath, if there is anything to show.
    var g = S.game;
    var any = g.scores.some(function (rows) {
      return rows.some(function (n) { return n > 0; });
    });
    if (!any) return;
    var host = document.querySelector('.game');
    if (!host) return;
    var box = document.createElement('div');
    box.className = 'panel';
    box.innerHTML = scoresTableHtml();
    host.insertBefore(box, host.lastElementChild);
  }

  // ------------------------------------------------------------------ bootup

  function boot() {
    var sess = session();
    if (!sess) return render();

    // auth() carries the owner token, so a reload keeps hosting rights.
    api('/rooms/' + sess.code + '/join', auth()).then(function (state) {
      S.room = state;
      S.view = 'lobby';
      // Only drop the token if we presented one and the server rejected it.
      if (sess.ownerToken && !state.isOwner) setSession({ code: sess.code, ownerToken: null });
      if (state.phase === 'playing' && state.isOwner) {
        var saved = loadGame(sess.code);
        if (saved && saved.stage && saved.stage !== 'game-end') {
          S.game = saved;
          if (saved.stage === 'play' && saved.turn) {
            // The clock kept ticking while we were away - land on the review screen.
            saved.stage = 'review';
            saved.turn.current = null;
            saved.turn.reason = 'time';
          }
          S.view = 'game';
        }
      }
      connect();
      render();
    }).catch(function () {
      setSession(null);
      render();
    });
  }

  window.addEventListener('pagehide', function () { keepAwake(false); });

  boot();
}());
