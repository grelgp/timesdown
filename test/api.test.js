'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT) || 3987;
const BASE = 'http://127.0.0.1:' + PORT;

let child;

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) { await res.text(); return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

test.after(() => { if (child) child.kill(); });

test('serves the app shell', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Time&#39;s Down/);
});

test('rejects path traversal out of public/', async () => {
  const res = await fetch(BASE + '/..%2f..%2fserver.js');
  const text = await res.text();
  assert.ok(!text.includes('createRoom'), 'must not leak server source');
});

test('creates a room with a 4-letter code', async () => {
  const { status, body } = await post('/api/rooms', { deviceId: 'host-1' });
  assert.equal(status, 201);
  assert.match(body.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.ok(body.ownerToken);
  assert.equal(body.state.isOwner, true);
  assert.equal(body.state.totalWords, 0);
});

test('unknown room codes are rejected', async () => {
  const { status, body } = await post('/api/rooms/ZZZZ/join', { deviceId: 'x' });
  assert.equal(status, 404);
  assert.match(body.error, /does not exist/);
});

test('room codes are case-insensitive on join', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const { status } = await post('/api/rooms/' + room.code.toLowerCase() + '/join', { deviceId: 'p' });
  assert.equal(status, 200);
});

test('a device only ever sees its own words', async () => {
  const room = (await post('/api/rooms', { deviceId: 'host' })).body;
  const code = room.code;

  await post('/api/rooms/' + code + '/words', { deviceId: 'host', text: 'submarine' });
  await post('/api/rooms/' + code + '/words', { deviceId: 'phone-2', text: 'accordion' });
  await post('/api/rooms/' + code + '/words', { deviceId: 'phone-2', text: 'lighthouse' });

  const host = (await get('/api/rooms/' + code + '/state?deviceId=host')).body;
  assert.equal(host.totalWords, 3, 'total is public');
  assert.equal(host.myWordCount, 1);
  assert.deepEqual(host.myWords.map((w) => w.text), ['submarine']);

  const other = (await get('/api/rooms/' + code + '/state?deviceId=phone-2')).body;
  assert.equal(other.totalWords, 3);
  assert.deepEqual(other.myWords.map((w) => w.text), ['accordion', 'lighthouse']);

  // Even the owner token does not unlock other people's words.
  const asOwner = (await get(
    '/api/rooms/' + code + '/state?deviceId=host&ownerToken=' + room.ownerToken
  )).body;
  assert.equal(asOwner.isOwner, true);
  assert.equal(asOwner.myWords.length, 1);
  assert.ok(!JSON.stringify(asOwner).includes('accordion'));
});

test('empty words are rejected, multi-word entries are accepted', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;

  for (const bad of ['', '   ', '\t\n ']) {
    const res = await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: bad });
    assert.equal(res.status, 400, 'rejected: ' + JSON.stringify(bad));
  }

  const ok = await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: '  the   Eiffel Tower  ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.word.text, 'the Eiffel Tower', 'whitespace is collapsed');
});

test('a device cannot delete another device\'s word', async () => {
  const room = (await post('/api/rooms', { deviceId: 'a' })).body;
  const code = room.code;
  const added = (await post('/api/rooms/' + code + '/words', { deviceId: 'a', text: 'kettle' })).body;

  const denied = await post('/api/rooms/' + code + '/words/' + added.word.id + '/delete', { deviceId: 'b' });
  assert.equal(denied.status, 403);

  const allowed = await post('/api/rooms/' + code + '/words/' + added.word.id + '/delete', { deviceId: 'a' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.totalWords, 0);
});

test('only the host can change settings or start', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: 'anvil' });

  assert.equal((await post('/api/rooms/' + code + '/settings', { deviceId: 'p', teams: 4 })).status, 403);
  assert.equal((await post('/api/rooms/' + code + '/start', { deviceId: 'p' })).status, 403);

  const set = await post('/api/rooms/' + code + '/settings', {
    deviceId: 'h', ownerToken: room.ownerToken, teams: 4, turnSeconds: 45,
    teamNames: ['Reds', 'Blues', '', 'Greens']
  });
  assert.equal(set.status, 200);
  assert.equal(set.body.settings.teams, 4);
  assert.equal(set.body.settings.turnSeconds, 45);
  assert.deepEqual(set.body.settings.teamNames, ['Reds', 'Blues', 'Team 3', 'Greens']);
});

test('settings are range-checked', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  const t = room.ownerToken;
  assert.equal((await post('/api/rooms/' + code + '/settings', { deviceId: 'h', ownerToken: t, teams: 1 })).status, 400);
  assert.equal((await post('/api/rooms/' + code + '/settings', { deviceId: 'h', ownerToken: t, teams: 9 })).status, 400);
  assert.equal((await post('/api/rooms/' + code + '/settings', { deviceId: 'h', ownerToken: t, turnSeconds: 5 })).status, 400);
  assert.equal((await post('/api/rooms/' + code + '/settings', { deviceId: 'h', ownerToken: t, turnSeconds: 999 })).status, 400);
});

test('starting deals the whole deck to the host and locks the phase', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  const words = ['alpha', 'bravo', 'charlie', 'delta'];
  for (const text of words) {
    await post('/api/rooms/' + code + '/words', { deviceId: 'h', text });
  }

  const started = await post('/api/rooms/' + code + '/start', { deviceId: 'h', ownerToken: room.ownerToken });
  assert.equal(started.status, 200);
  assert.deepEqual(started.body.deck.map((c) => c.text).sort(), [...words].sort());

  const state = (await get('/api/rooms/' + code + '/state?deviceId=h')).body;
  assert.equal(state.phase, 'playing');
  assert.equal(state.deckSize, 4);
});

test('an empty deck cannot be started', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const res = await post('/api/rooms/' + room.code + '/start', { deviceId: 'h', ownerToken: room.ownerToken });
  assert.equal(res.status, 400);
});

test('words added mid-game land in the next deck, not the current one', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: 'first' });
  const started = await post('/api/rooms/' + code + '/start', { deviceId: 'h', ownerToken: room.ownerToken });
  assert.equal(started.body.deck.length, 1);

  await post('/api/rooms/' + code + '/words', { deviceId: 'latecomer', text: 'second' });

  const replay = await post('/api/rooms/' + code + '/reset', {
    deviceId: 'h', ownerToken: room.ownerToken, mode: 'replay'
  });
  assert.deepEqual(replay.body.deck.map((c) => c.text), ['first'], 'replay uses the same deck');

  const keep = await post('/api/rooms/' + code + '/reset', {
    deviceId: 'h', ownerToken: room.ownerToken, mode: 'keep'
  });
  assert.equal(keep.body.phase, 'lobby');
  assert.equal(keep.body.totalWords, 2, 'the new word is in the pool for the next game');
});

test('clear wipes the pool and returns everyone to the lobby', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: 'gone' });
  await post('/api/rooms/' + code + '/start', { deviceId: 'h', ownerToken: room.ownerToken });

  const cleared = await post('/api/rooms/' + code + '/reset', {
    deviceId: 'h', ownerToken: room.ownerToken, mode: 'clear'
  });
  assert.equal(cleared.body.phase, 'lobby');
  assert.equal(cleared.body.totalWords, 0);
  assert.equal(cleared.body.myWordCount, 0);
});

test('final scores are published to every device', async () => {
  const room = (await post('/api/rooms', { deviceId: 'h' })).body;
  const code = room.code;
  await post('/api/rooms/' + code + '/words', { deviceId: 'h', text: 'x' });
  await post('/api/rooms/' + code + '/start', { deviceId: 'h', ownerToken: room.ownerToken });

  await post('/api/rooms/' + code + '/finish', {
    deviceId: 'h',
    ownerToken: room.ownerToken,
    results: { teamNames: ['Reds', 'Blues'], scores: [[3, 4, 2], [1, 5, 6]], totals: [9, 12] }
  });

  const player = (await get('/api/rooms/' + code + '/state?deviceId=someone-else')).body;
  assert.equal(player.phase, 'results');
  assert.deepEqual(player.results.totals, [9, 12]);
});

test('SSE pushes an update when another device adds a word', async () => {
  const room = (await post('/api/rooms', { deviceId: 'watcher' })).body;
  const code = room.code;

  const controller = new AbortController();
  const res = await fetch(BASE + '/api/rooms/' + code + '/events?deviceId=watcher', {
    signal: controller.signal
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function nextState() {
    for (let i = 0; i < 60; i++) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const parsed = JSON.parse(line.slice(6));
          buffer = '';
          return parsed;
        }
      }
    }
    throw new Error('no state received');
  }

  const initial = await nextState();
  assert.equal(initial.totalWords, 0);

  await post('/api/rooms/' + code + '/words', { deviceId: 'other-phone', text: 'pushed' });

  const updated = await nextState();
  assert.equal(updated.totalWords, 1);
  assert.equal(updated.myWordCount, 0, 'the watcher does not receive another device\'s word');
  assert.ok(!JSON.stringify(updated).includes('pushed'));

  controller.abort();
});
