'use strict';

/**
 * Time's Down - server
 *
 * Zero dependencies. Plain node:http for static files + a small JSON API,
 * with Server-Sent Events for live lobby updates (the client also polls as a
 * fallback for networks that buffer streamed responses).
 *
 * Rooms live in memory only: this is a party game, not a database.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// I, L and O are dropped so codes can't be misread across a noisy table.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;

const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms are dropped after 12h idle
const DEVICE_ACTIVE_MS = 90 * 1000;      // "connected" window for the device counter
const MAX_WORD_LEN = 64;
const MAX_WORDS = 2000;
const MIN_TEAMS = 2;
const MAX_TEAMS = 6;
const MIN_TURN_SECONDS = 15;
const MAX_TURN_SECONDS = 120;
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/** @type {Map<string, object>} */
const rooms = new Map();

// ---------------------------------------------------------------- utilities

const rid = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');

function newCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a free room code');
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function defaultTeamNames(count) {
  return Array.from({ length: count }, (_, i) => 'Team ' + (i + 1));
}

/** Replace control characters with spaces. */
function stripControl(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code < 32 || code === 127 ? ' ' : text[i];
  }
  return out;
}

function cleanWord(raw) {
  if (typeof raw !== 'string') return '';
  return stripControl(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_WORD_LEN);
}

function cleanName(raw, fallback) {
  const s = typeof raw === 'string'
    ? stripControl(raw).replace(/\s+/g, ' ').trim().slice(0, 24)
    : '';
  return s || fallback;
}

// -------------------------------------------------------------------- rooms

function createRoom() {
  const code = newCode();
  const room = {
    code,
    ownerToken: rid(18),
    phase: 'lobby',            // lobby | playing | results
    settings: {
      teams: 2,
      turnSeconds: 30,
      teamNames: defaultTeamNames(MAX_TEAMS)
    },
    words: new Map(),          // wordId -> { id, text, deviceId, addedAt }
    devices: new Map(),        // deviceId -> { joinedAt, lastSeen }
    clients: new Set(),        // SSE subscribers
    deck: [],                  // snapshot taken when the game starts
    results: null,             // final scoreboard, shared back to every device
    version: 0,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
}

function touchDevice(room, deviceId) {
  if (!deviceId) return;
  const existing = room.devices.get(deviceId);
  if (existing) existing.lastSeen = Date.now();
  else room.devices.set(deviceId, { joinedAt: Date.now(), lastSeen: Date.now() });
  touchRoom(room);
}

function activeDeviceCount(room) {
  const cutoff = Date.now() - DEVICE_ACTIVE_MS;
  let n = 0;
  for (const d of room.devices.values()) if (d.lastSeen >= cutoff) n++;
  return n;
}

/**
 * The state a single device is allowed to see. Word text is never broadcast:
 * a device only gets back the words it typed itself, so nobody - not even the
 * host - can read the deck before playing it.
 */
function stateFor(room, deviceId, owner) {
  const mine = [];
  for (const w of room.words.values()) {
    if (w.deviceId === deviceId) mine.push(w);
  }
  mine.sort((a, b) => a.addedAt - b.addedAt);
  return {
    code: room.code,
    phase: room.phase,
    version: room.version,
    totalWords: room.words.size,
    myWordCount: mine.length,
    myWords: mine.map((w) => ({ id: w.id, text: w.text })),
    deviceCount: activeDeviceCount(room),
    settings: {
      teams: room.settings.teams,
      turnSeconds: room.settings.turnSeconds,
      teamNames: room.settings.teamNames.slice(0, room.settings.teams)
    },
    deckSize: room.deck.length,
    results: room.results,
    isOwner: Boolean(owner)
  };
}

function broadcast(room) {
  room.version++;
  touchRoom(room);
  const dead = [];
  for (const client of room.clients) {
    const payload = JSON.stringify(stateFor(room, client.deviceId, client.isOwner));
    try {
      client.res.write('data: ' + payload + '\n\n');
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) room.clients.delete(c);
}

function sweepRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff) {
      for (const client of room.clients) {
        try { client.res.end(); } catch { /* already gone */ }
      }
      rooms.delete(code);
    }
  }
}
setInterval(sweepRooms, 10 * 60 * 1000).unref();

// ------------------------------------------------------------ http plumbing

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'Forbidden');
  }
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // Unknown path: hand back the app shell so deep links still work.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, buf) => {
        if (e2) return fail(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  });
}

// -------------------------------------------------------------------- routes

function getRoom(res, code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) {
    fail(res, 404, 'That room does not exist (or it expired). Check the code.');
    return null;
  }
  return room;
}

function isOwner(room, token) {
  return Boolean(token) && token === room.ownerToken;
}

function requireOwner(res, room, token) {
  if (!isOwner(room, token)) {
    fail(res, 403, 'Only the host can do that.');
    return false;
  }
  return true;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', ...]
  const method = req.method;

  // POST /api/rooms -> create a room
  if (parts.length === 2 && parts[1] === 'rooms' && method === 'POST') {
    const body = await readJson(req);
    const deviceId = typeof body.deviceId === 'string' && body.deviceId
      ? body.deviceId.slice(0, 64)
      : rid(8);
    const room = createRoom();
    touchDevice(room, deviceId);
    return sendJson(res, 201, {
      code: room.code,
      ownerToken: room.ownerToken,
      deviceId,
      state: stateFor(room, deviceId, true)
    });
  }

  if (parts.length < 3 || parts[1] !== 'rooms') return fail(res, 404, 'Unknown endpoint');

  const room = getRoom(res, parts[2]);
  if (!room) return;
  const action = parts[3];

  // GET /api/rooms/:code/events -> SSE stream
  if (action === 'events' && method === 'GET') {
    const deviceId = url.searchParams.get('deviceId') || rid(8);
    const owner = isOwner(room, url.searchParams.get('ownerToken'));
    touchDevice(room, deviceId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const client = { res, deviceId, isOwner: owner };
    room.clients.add(client);
    res.write('data: ' + JSON.stringify(stateFor(room, deviceId, owner)) + '\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
        touchDevice(room, deviceId);
      } catch { /* connection closed */ }
    }, 20000);
    keepAlive.unref();
    const close = () => { clearInterval(keepAlive); room.clients.delete(client); };
    req.on('close', close);
    req.on('error', close);
    return;
  }

  // GET /api/rooms/:code/state -> polling fallback
  if (action === 'state' && method === 'GET') {
    const deviceId = url.searchParams.get('deviceId') || '';
    const owner = isOwner(room, url.searchParams.get('ownerToken'));
    touchDevice(room, deviceId);
    return sendJson(res, 200, stateFor(room, deviceId, owner));
  }

  if (method !== 'POST') return fail(res, 405, 'Method not allowed');
  const body = await readJson(req);
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
  const owner = isOwner(room, body.ownerToken);

  // POST /api/rooms/:code/join
  if (action === 'join') {
    if (!deviceId) return fail(res, 400, 'Missing device id');
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, stateFor(room, deviceId, owner));
  }

  // POST /api/rooms/:code/words   { deviceId, text }
  if (action === 'words' && parts.length === 4) {
    if (!deviceId) return fail(res, 400, 'Missing device id');
    const text = cleanWord(body.text);
    if (!text) return fail(res, 400, 'A card needs some text.');
    if (room.words.size >= MAX_WORDS) return fail(res, 400, 'This deck is full.');
    const word = { id: rid(6), text, deviceId, addedAt: Date.now() };
    room.words.set(word.id, word);
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 201, {
      word: { id: word.id, text: word.text },
      state: stateFor(room, deviceId, owner)
    });
  }

  // POST /api/rooms/:code/words/:wordId/delete
  if (action === 'words' && parts.length === 6 && parts[5] === 'delete') {
    const word = room.words.get(parts[4]);
    if (!word) return fail(res, 404, 'That card is already gone.');
    if (word.deviceId !== deviceId) {
      return fail(res, 403, 'You can only remove cards added on this device.');
    }
    room.words.delete(word.id);
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, stateFor(room, deviceId, owner));
  }

  // POST /api/rooms/:code/settings  { teams, turnSeconds, teamNames }
  if (action === 'settings') {
    if (!requireOwner(res, room, body.ownerToken)) return;
    if (body.teams !== undefined) {
      const n = Math.round(Number(body.teams));
      if (!Number.isFinite(n) || n < MIN_TEAMS || n > MAX_TEAMS) {
        return fail(res, 400, 'Teams must be between ' + MIN_TEAMS + ' and ' + MAX_TEAMS + '.');
      }
      room.settings.teams = n;
    }
    if (body.turnSeconds !== undefined) {
      const s = Math.round(Number(body.turnSeconds));
      if (!Number.isFinite(s) || s < MIN_TURN_SECONDS || s > MAX_TURN_SECONDS) {
        return fail(res, 400, 'Turn length must be between ' + MIN_TURN_SECONDS +
          ' and ' + MAX_TURN_SECONDS + ' seconds.');
      }
      room.settings.turnSeconds = s;
    }
    if (Array.isArray(body.teamNames)) {
      body.teamNames.slice(0, MAX_TEAMS).forEach((name, i) => {
        room.settings.teamNames[i] = cleanName(name, 'Team ' + (i + 1));
      });
    }
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, stateFor(room, deviceId, true));
  }

  // POST /api/rooms/:code/start -> snapshot + shuffle the deck, hand it to the host
  if (action === 'start') {
    if (!requireOwner(res, room, body.ownerToken)) return;
    if (room.words.size < 1) return fail(res, 400, 'The deck is empty.');
    room.deck = shuffle([...room.words.values()].map((w) => ({ id: w.id, text: w.text })));
    room.phase = 'playing';
    room.results = null;
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, {
      deck: room.deck,
      settings: stateFor(room, deviceId, true).settings
    });
  }

  // POST /api/rooms/:code/finish  { results } -> publish the scoreboard
  if (action === 'finish') {
    if (!requireOwner(res, room, body.ownerToken)) return;
    room.phase = 'results';
    room.results = body.results && typeof body.results === 'object' ? body.results : null;
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, stateFor(room, deviceId, true));
  }

  // POST /api/rooms/:code/reset  { mode: 'replay' | 'keep' | 'clear' }
  if (action === 'reset') {
    if (!requireOwner(res, room, body.ownerToken)) return;
    const mode = body.mode === 'replay' || body.mode === 'clear' ? body.mode : 'keep';
    room.results = null;
    if (mode === 'replay') {
      if (!room.deck.length) return fail(res, 400, 'There is no previous deck to replay.');
      room.deck = shuffle(room.deck);
      room.phase = 'playing';
      touchDevice(room, deviceId);
      broadcast(room);
      return sendJson(res, 200, {
        deck: room.deck,
        settings: stateFor(room, deviceId, true).settings
      });
    }
    if (mode === 'clear') room.words.clear();
    room.deck = [];
    room.phase = 'lobby';
    touchDevice(room, deviceId);
    broadcast(room);
    return sendJson(res, 200, stateFor(room, deviceId, true));
  }

  return fail(res, 404, 'Unknown endpoint');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (res.headersSent) return;
      fail(res, 400, err.message || 'Something went wrong');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
  serveStatic(req, res, url.pathname);
});

// SSE streams must not be cut short by the default idle timeouts.
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const addresses = lanAddresses();
  const line = '  ' + '-'.repeat(42);
  console.log('');
  console.log("  Time's Down is running");
  console.log(line);
  console.log('  On this machine   http://localhost:' + PORT);
  for (const address of addresses) {
    console.log('  On your phone     http://' + address + ':' + PORT);
  }
  if (!addresses.length) {
    console.log('  (No LAN address found - phones need this machine on the same network.)');
  }
  console.log(line);
  console.log('  Everyone must be on the same Wi-Fi. Ctrl+C to stop.');
  console.log('');
});
