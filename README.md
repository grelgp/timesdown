# Time's Down

A mobile web version of Time's Up, for a group of people sharing one room and
one Wi-Fi. Everyone fills the deck from their own phone; the host's phone then
runs the whole game.

No dependencies, no build step, no database. `node server.js` and you're playing.

## Running it

```sh
node server.js
```

The console prints the address to hand round:

```
  Time's Down is running
  ------------------------------------------
  On this machine   http://localhost:3000
  On your phone     http://192.168.1.24:3000
  ------------------------------------------
```

Everyone must be on the same network. Set `PORT` to use a different port.

## How a game goes

1. **One person creates a room** and gets a four-letter code (no I, L or O, so
   nothing gets misread across a noisy table).
2. **Everyone else joins** with that code. Nobody signs up or picks a name -
   several people can share one phone and take turns typing.
3. **Everyone adds cards.** Your own cards are listed but masked; tap one to
   read it or remove it. You can see how many you added and how many are in the
   deck overall, but never anyone else's words.
4. **The host picks the number of teams** (2-6, with editable names) and the
   turn length.
5. **The host confirms the deck size and starts.** From here only the host's
   phone matters - everyone else can pocket theirs, or stay and keep adding
   cards for the next game.
6. **Three rounds with the same deck**: describe it, then one word, then mime.
   The card is blank until the speaker holds a finger on it, so the phone can be
   set down mid-mime without giving anything away.
   - **Got it** flashes the whole screen green for a quarter second, so the rest
     of the table can see the call was made.
   - **Skip** sends the card to the bottom of the pile.
7. **After each turn** every card that came up is listed for correction. Hold a
   word to read it, tap the button beside it to flip a bad call. Cards taken
   back go straight into the pile; cards awarded late come out of it.
8. **A round ends when the pile is empty**, scores are banked, and the full deck
   comes back shuffled for the next round.
9. **At the end**: final scores, then replay the same deck, start a new deck
   keeping the cards people added, or clear everything and start over.

## Design notes

**Nobody can read the deck early.** The server only ever sends a device the
words that device typed. Totals are public, text is not - the host's own
"is this everyone?" screen shows a count and nothing else. The full deck is
handed out exactly once, to the host, at the moment the game starts.

**The game runs offline once dealt.** After the deck is dealt the host's phone
holds the whole game. A dropped Wi-Fi mid-turn cannot stall a card. The game is
also saved to local storage as it goes, so an accidental refresh picks up where
it left off - dropping to the correction screen rather than resuming a turn
whose clock kept running.

**Cards added mid-game go to the next game.** The deck is snapshotted at start,
so anyone still typing is filling the *next* deck. "Play the same deck again"
replays the snapshot; "keep the cards" starts a fresh deck from the whole pool.

**Empty is the only thing that blocks.** A card with two words gets a warning,
never a refusal - "blue whale" is a perfectly good card. Same for duplicates
from the same phone.

**A turn timer was added.** The brief didn't mention one, but Time's Up doesn't
work without it. It defaults to 30 seconds and the host can set 30/45/60/90.
The end of a turn also beeps and vibrates, since the speaker may be miming with
the phone face down.

## Deploying

In production this runs as a Docker container. There is nothing to install and
nothing to build — the `Dockerfile` is a single `node:20-alpine` stage that
copies `server.js` and `public/` in and runs them as the unprivileged `node`
user, since rooms live in memory and nothing is ever written to disk.

It sits behind Traefik on the `proxy` network (see `compose.yml`), publicly
reachable at **`timesdown.grelgp.fr`**. Public rather than VPN-only on purpose:
the players are guests holding their own phones, and they cannot be WireGuard
peers. The router is deliberately *not* behind Traefik's `compress` middleware
— the live state feed is Server-Sent Events, and a compressor that buffers
would stall it. Full exposure model, DNS, and certificate details are
documented in the parent `server` repo's `README.md`.

```bash
docker compose up -d --build
```

Restarting the container ends any game in progress, same as restarting the
server locally.

---

## Layout

| Path | What it is |
| --- | --- |
| `server.js` | HTTP + JSON API + Server-Sent Events. In-memory rooms, no deps. |
| `public/index.html` | App shell. |
| `public/styles.css` | Everything visual. Mobile-first, dark, big thumb targets. |
| `public/rules.js` | Pure deck/turn rules, shared by the browser and the tests. |
| `public/app.js` | Lobby, game loop, rendering. |
| `test/` | Node's built-in test runner. |
| `Dockerfile` | Single-stage `node:20-alpine`, runs as `node` on port 3000. |
| `compose.yml` | Traefik labels for `timesdown.grelgp.fr` on the `proxy` network. |

Rooms live in memory and are dropped after 12 hours idle. Restarting the server
ends any game in progress.

## Tests

```sh
node --test test/
```

Covers the deck arithmetic (skips, corrections in both directions, a whole round
terminating with every card scored exactly once) and the API end to end,
including that a device is never sent another device's words - over both the
polling endpoint and the live stream.
