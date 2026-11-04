// Runs the real Worker in Miniflare (workerd), and talks to it with `ws`, the
// same library the desktop client uses. Clients here sign with
// lib/remote/crypto.js, so these tests also pin that the Worker derives the same
// device id and accepts the same Ed25519 signatures.
//
// Miniflare can't advance time inside workerd, so expiry tests shorten the
// lifetimes through the PAIR_TTL_MS and AUTH_TIMEOUT_MS bindings and wait in
// real time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { newIdentity, sign, deviceIdFromPublicKey } = require('../../lib/remote/crypto.js');

const SECRET = 'test-secret-not-a-real-one-0123456789';
const AUTH_LABEL = 'sanctum-relay-auth-v1:';
const MIB = 1024 * 1024;
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const wranglerToml = await readFile(path.join(root, 'wrangler.toml'), 'utf8');
const compatibilityDate = wranglerToml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];

async function startRelay({ bindings = {}, persist } = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(root, 'src', 'index.js'),
    modulesRoot: path.join(root, 'src'),
    // Miniflare reads imported .js files as CommonJS unless told otherwise, as wrangler does.
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate,
    durableObjects: {
      MAILBOX: { className: 'Mailbox', useSQLite: true },
      PAIRING_SLOT: { className: 'PairingSlot', useSQLite: true }
    },
    durableObjectsPersist: persist ?? false,
    bindings: { ACCESS_SECRET: SECRET, ...bindings },
    log: undefined
  });
  let url;
  try {
    url = new URL(await mf.ready);
  } catch (err) {
    await mf.dispose();
    throw err;
  }
  const wsBase = `ws://${url.host}`;
  const clients = new Set();

  const relay = {
    mf,
    httpBase: `http://${url.host}`,
    wsBase,
    // Resolves with a client once the socket is open. Rejects with the HTTP
    // status when the Worker refuses the upgrade.
    open(pathname) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsBase + pathname);
        const client = wrap(ws);
        clients.add(client);
        ws.once('open', () => resolve(client));
        ws.once('unexpected-response', (_req, res) => {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        });
        ws.once('error', reject);
      });
    },
    // A device that has finished the challenge and received `ready`.
    async device(identity = newIdentity(), secret = SECRET) {
      const id = deviceIdFromPublicKey(identity.publicKey);
      const client = await relay.open(`/${secret}/device/${id}`);
      const challenge = await client.next();
      assert.equal(challenge.t, 'challenge');
      client.send(authMessage(identity, challenge.nonce));
      const ready = await client.next();
      assert.deepEqual(ready, { t: 'ready' });
      client.id = id;
      client.identity = identity;
      return client;
    },
    async stop() {
      for (const client of clients) client.ws.terminate();
      await mf.dispose();
    }
  };
  return relay;
}

function wrap(ws) {
  const inbox = [];
  const waiting = [];
  // The close frame is what matters. workerd doesn't always end the TCP connection
  // after a close the Worker starts outside a message handler (an alarm, or another
  // connection's request), which leaves `ws` waiting to emit 'close', so the frame
  // itself counts too.
  const closed = new Promise((resolve) => {
    const done = (code, reason) => resolve({ code, reason: reason.toString() });
    ws.once('close', done);
    ws.once('open', () => ws._receiver.once('conclude', done));
  });
  const client = {
    ws,
    inbox,
    closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(ms = 3000) {
      if (inbox.length) return Promise.resolve(inbox.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve };
        waiter.timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(new Error('timed out waiting for a message'));
        }, ms);
        waiting.push(waiter);
      });
    },
    // Messages that arrive within `ms`, for asserting that nothing (more) comes.
    async drain(ms) {
      await sleep(ms);
      return inbox.splice(0);
    },
    async expectClosed(ms = 3000) {
      const result = await Promise.race([client.closed, sleep(ms).then(() => null)]);
      assert.ok(result, 'expected the socket to be closed');
      return result;
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    }
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiting.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      inbox.push(msg);
    }
  });
  return client;
}

function authMessage(identity, nonce, overrides = {}) {
  const sig = sign(identity.secretKey, new TextEncoder().encode(AUTH_LABEL + nonce));
  return { t: 'auth', publicKey: toB64(identity.publicKey), sig: toB64(sig), ...overrides };
}

// Every test gets its own Worker, so DO state (the one pairing slot in particular)
// never leaks from one test into the next.
async function withRelay(options, fn) {
  const relay = await startRelay(options);
  try {
    await fn(relay);
  } finally {
    await relay.stop();
  }
}

test('a wrong or missing secret gets 404 and no upgrade', () =>
  withRelay({}, async (relay) => {
    const id = deviceIdFromPublicKey(newIdentity().publicKey);
    for (const pathname of [`/wrong/device/${id}`, '/wrong/pair/host', '/wrong/pair/guest', `/device/${id}`, '/']) {
      await assert.rejects(relay.open(pathname), { status: 404 }, pathname);
      const res = await fetch(relay.httpBase + pathname);
      assert.equal(res.status, 404, pathname);
    }
  }));

test('a secret that is a prefix of the real one, or the real one plus more, is refused', () =>
  withRelay({}, async (relay) => {
    const id = deviceIdFromPublicKey(newIdentity().publicKey);
    await assert.rejects(relay.open(`/${SECRET.slice(0, -1)}/device/${id}`), { status: 404 });
    await assert.rejects(relay.open(`/${SECRET}x/device/${id}`), { status: 404 });
  }));

test('with no ACCESS_SECRET configured, nothing is served', () =>
  withRelay({ bindings: { ACCESS_SECRET: '' } }, async (relay) => {
    const id = deviceIdFromPublicKey(newIdentity().publicKey);
    await assert.rejects(relay.open(`//device/${id}`), { status: 404 });
    await assert.rejects(relay.open(`/device/${id}`), { status: 404 });
  }));

test('the right secret without a WebSocket upgrade is refused, as are malformed device ids and unknown routes', () =>
  withRelay({}, async (relay) => {
    const id = deviceIdFromPublicKey(newIdentity().publicKey);
    assert.equal((await fetch(`${relay.httpBase}/${SECRET}/device/${id}`)).status, 426);
    assert.equal((await fetch(`${relay.httpBase}/${SECRET}/pair/host`)).status, 426);
    await assert.rejects(relay.open(`/${SECRET}/device/NOT-AN-ID`), { status: 404 });
    await assert.rejects(relay.open(`/${SECRET}/device/${id.toUpperCase()}`), { status: 404 });
    await assert.rejects(relay.open(`/${SECRET}/pair/nobody`), { status: 404 });
    await assert.rejects(relay.open(`/${SECRET}/elsewhere`), { status: 404 });
  }));

test('a device that signs the challenge is accepted', () =>
  withRelay({}, async (relay) => {
    const device = await relay.device();
    assert.ok(device.isOpen);
  }));

test('a bad signature closes the socket', () =>
  withRelay({}, async (relay) => {
    const identity = newIdentity();
    const client = await relay.open(`/${SECRET}/device/${deviceIdFromPublicKey(identity.publicKey)}`);
    const { nonce } = await client.next();
    const good = authMessage(identity, nonce);
    const flipped = Buffer.from(good.sig, 'base64');
    flipped[10] ^= 1;
    client.send({ ...good, sig: toB64(flipped) });
    await client.expectClosed();
    assert.deepEqual(client.inbox, []);
  }));

test('a signature over a different nonce closes the socket', () =>
  withRelay({}, async (relay) => {
    const identity = newIdentity();
    const id = deviceIdFromPublicKey(identity.publicKey);
    const first = await relay.open(`/${SECRET}/device/${id}`);
    const { nonce: oldNonce } = await first.next();
    first.ws.terminate();
    const second = await relay.open(`/${SECRET}/device/${id}`);
    const { nonce } = await second.next();
    assert.notEqual(nonce, oldNonce);
    second.send(authMessage(identity, oldNonce));
    await second.expectClosed();
  }));

test('a device id that does not match the key closes the socket', () =>
  withRelay({}, async (relay) => {
    const identity = newIdentity();
    const other = newIdentity();
    // A valid signature from `identity`, on a connection to somebody else's id.
    const client = await relay.open(`/${SECRET}/device/${deviceIdFromPublicKey(other.publicKey)}`);
    const { nonce } = await client.next();
    client.send(authMessage(identity, nonce));
    await client.expectClosed();
  }));

test('malformed auth closes the socket', async () => {
  const cases = {
    'not JSON': () => 'hello',
    'a different message first': () => ({ t: 'send', to: 'aaaaaaaaaaaaaaaa', data: 'x' }),
    'a missing key': (identity, nonce) => {
      const { publicKey, ...rest } = authMessage(identity, nonce);
      return rest;
    },
    'a short key': (identity, nonce) => authMessage(identity, nonce, { publicKey: toB64(identity.publicKey.slice(1)) }),
    'a short signature': (identity, nonce) => authMessage(identity, nonce, { sig: toB64(new Uint8Array(10)) }),
    'a non-string key': (identity, nonce) => authMessage(identity, nonce, { publicKey: 7 }),
    'a binary frame': () => Buffer.from([1, 2, 3])
  };
  for (const [name, build] of Object.entries(cases)) {
    await withRelay({}, async (relay) => {
      const identity = newIdentity();
      const client = await relay.open(`/${SECRET}/device/${deviceIdFromPublicKey(identity.publicKey)}`);
      const { nonce } = await client.next();
      const payload = build(identity, nonce);
      if (Buffer.isBuffer(payload)) client.ws.send(payload);
      else client.send(payload);
      await client.expectClosed();
    });
  }
});

test('a connection that never authenticates is dropped', () =>
  withRelay({ bindings: { AUTH_TIMEOUT_MS: '300' } }, async (relay) => {
    const identity = newIdentity();
    const client = await relay.open(`/${SECRET}/device/${deviceIdFromPublicKey(identity.publicKey)}`);
    await client.next();
    const started = Date.now();
    await client.expectClosed(5000);
    assert.ok(Date.now() - started < 4000);
  }));

test('a message reaches a connected device with the right from', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    alice.send({ t: 'send', to: bob.id, data: 'aGVsbG8=' });
    assert.deepEqual(await bob.next(), { t: 'recv', from: alice.id, data: 'aGVsbG8=' });
    bob.send({ t: 'send', to: alice.id, data: 'cmVwbHk=' });
    assert.deepEqual(await alice.next(), { t: 'recv', from: bob.id, data: 'cmVwbHk=' });
    assert.deepEqual(await alice.drain(200), []);
    assert.deepEqual(await bob.drain(200), []);
  }));

test('a sender cannot pick its own from', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    const carol = await relay.device();
    alice.send({ t: 'send', to: bob.id, from: carol.id, data: 'x' });
    assert.equal((await bob.next()).from, alice.id);
  }));

test('a send to a device that is not connected gets offline, and nothing is held for later', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bobIdentity = newIdentity();
    const bobId = deviceIdFromPublicKey(bobIdentity.publicKey);
    alice.send({ t: 'send', to: bobId, data: 'for-later' });
    assert.deepEqual(await alice.next(), { t: 'offline', to: bobId });
    const bob = await relay.device(bobIdentity);
    assert.deepEqual(await bob.drain(500), []);
  }));

test('a device that disconnects is offline to the others', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    bob.ws.close();
    await bob.closed;
    await sleep(100);
    alice.send({ t: 'send', to: bob.id, data: 'x' });
    assert.deepEqual(await alice.next(), { t: 'offline', to: bob.id });
  }));

test('a second connection from the same device replaces the first', () =>
  withRelay({}, async (relay) => {
    const identity = newIdentity();
    const first = await relay.device(identity);
    const sender = await relay.device();
    const second = await relay.device(identity);
    await first.expectClosed();
    sender.send({ t: 'send', to: second.id, data: 'x' });
    assert.deepEqual(await second.next(), { t: 'recv', from: sender.id, data: 'x' });
    assert.deepEqual(await first.drain(100), []);
  }));

test('a connection that has not authenticated cannot push out the real device', () =>
  withRelay({}, async (relay) => {
    const identity = newIdentity();
    const real = await relay.device(identity);
    const intruder = await relay.open(`/${SECRET}/device/${real.id}`);
    await intruder.next();
    await sleep(200);
    assert.ok(real.isOpen);
    intruder.ws.terminate();
    const sender = await relay.device();
    sender.send({ t: 'send', to: real.id, data: 'x' });
    assert.equal((await real.next()).t, 'recv');
  }));

test('frames that are not valid sends are ignored or end the connection, and never reach anyone', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    alice.send({ t: 'send', to: 'not-an-id', data: 'x' });
    alice.send({ t: 'send', data: 'x' });
    alice.send({ t: 'send', to: bob.id });
    alice.send({ t: 'nonsense' });
    assert.deepEqual(await bob.drain(300), []);
    assert.ok(alice.isOpen);
    alice.send('not json');
    await alice.expectClosed();
  }));

test('more than 120 messages a second gets slow-down, and the excess is dropped', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    for (let i = 0; i < 200; i++) alice.send({ t: 'send', to: bob.id, data: String(i) });
    await sleep(800);
    const received = bob.inbox.splice(0);
    assert.equal(received.length, 120);
    assert.deepEqual(received.map((m) => m.data), Array.from({ length: 120 }, (_, i) => String(i)));
    const warnings = alice.inbox.splice(0).filter((m) => m.t === 'slow-down');
    assert.ok(warnings.length >= 1);
    assert.ok(alice.isOpen);
    // The limit is per second, so sending works again afterwards.
    await sleep(1000);
    alice.send({ t: 'send', to: bob.id, data: 'again' });
    assert.deepEqual(await bob.next(), { t: 'recv', from: alice.id, data: 'again' });
  }));

test('the rate limit is per device', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    const carol = await relay.device();
    for (let i = 0; i < 200; i++) alice.send({ t: 'send', to: carol.id, data: 'x' });
    await sleep(300);
    bob.send({ t: 'send', to: carol.id, data: 'from-bob' });
    await sleep(300);
    assert.ok(carol.inbox.some((m) => m.from === bob.id));
  }));

test('a frame over 1 MiB is refused, and one of exactly 1 MiB is not', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    const frame = (size) => {
      const base = JSON.stringify({ t: 'send', to: bob.id, data: '' });
      return JSON.stringify({ t: 'send', to: bob.id, data: 'a'.repeat(size - Buffer.byteLength(base)) });
    };
    const exact = frame(MIB);
    assert.equal(Buffer.byteLength(exact), MIB);
    alice.send(exact);
    const got = await bob.next();
    assert.equal(got.from, alice.id);
    assert.ok(alice.isOpen);

    const over = frame(MIB + 1);
    assert.equal(Buffer.byteLength(over), MIB + 1);
    alice.send(over);
    const closed = await alice.expectClosed();
    assert.equal(closed.code, 1009);
    assert.deepEqual(await bob.drain(300), []);
  }));

test('a frame is measured in bytes, not characters', () =>
  withRelay({}, async (relay) => {
    const alice = await relay.device();
    const bob = await relay.device();
    // Three bytes a character, so this is well under 1 MiB in characters but over in bytes.
    const data = '€'.repeat(Math.ceil(MIB / 3));
    alice.send({ t: 'send', to: bob.id, data });
    assert.equal((await alice.expectClosed()).code, 1009);
  }));

test('a guest with no host gets pair-none', () =>
  withRelay({}, async (relay) => {
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    assert.deepEqual(await guest.next(), { t: 'pair-none' });
    await guest.expectClosed();
  }));

test('pairing messages pass between the host and the guest, and nowhere else', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    const bystander = await relay.device();
    guest.send({ t: 'pair', data: 'cGFrZQ==' });
    assert.deepEqual(await host.next(), { t: 'pair', data: 'cGFrZQ==' });
    host.send({ t: 'pair', data: 'cmVwbHk=' });
    assert.deepEqual(await guest.next(), { t: 'pair', data: 'cmVwbHk=' });
    assert.deepEqual(await bystander.drain(200), []);
    assert.deepEqual(await host.drain(100), []);
    assert.deepEqual(await guest.drain(100), []);
  }));

test('a host that has no guest yet does not get its own messages back', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    host.send({ t: 'pair', data: 'x' });
    assert.deepEqual(await host.drain(300), []);
    assert.ok(host.isOpen);
  }));

test('a new pairing host closes the old one', () =>
  withRelay({}, async (relay) => {
    const oldHost = await relay.open(`/${SECRET}/pair/host`);
    const oldGuest = await relay.open(`/${SECRET}/pair/guest`);
    const newHost = await relay.open(`/${SECRET}/pair/host`);
    await oldHost.expectClosed();
    await oldGuest.expectClosed();
    // The old host can no longer reach anyone, and the new slot is empty of guests.
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    guest.send({ t: 'pair', data: 'to-new-host' });
    assert.deepEqual(await newHost.next(), { t: 'pair', data: 'to-new-host' });
    assert.deepEqual(await oldHost.drain(100), []);
  }));

test('a new pairing guest replaces the old one', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const oldGuest = await relay.open(`/${SECRET}/pair/guest`);
    const newGuest = await relay.open(`/${SECRET}/pair/guest`);
    await oldGuest.expectClosed();
    host.send({ t: 'pair', data: 'x' });
    assert.deepEqual(await newGuest.next(), { t: 'pair', data: 'x' });
  }));

test('the slot empties when the host leaves', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    host.ws.close();
    await guest.expectClosed();
    const late = await relay.open(`/${SECRET}/pair/guest`);
    assert.deepEqual(await late.next(), { t: 'pair-none' });
  }));

test('the pairing slot expires: traffic stops, and the next guest finds it empty', () =>
  withRelay({ bindings: { PAIR_TTL_MS: '600' } }, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    guest.send({ t: 'pair', data: 'before' });
    assert.equal((await host.next()).data, 'before');
    await host.expectClosed(4000);
    await guest.expectClosed(1000);
    const late = await relay.open(`/${SECRET}/pair/guest`);
    assert.deepEqual(await late.next(), { t: 'pair-none' });
  }));

test('a new host starts a fresh lifetime, so the old alarm does not cut it short', () =>
  withRelay({ bindings: { PAIR_TTL_MS: '1200' } }, async (relay) => {
    const first = await relay.open(`/${SECRET}/pair/host`);
    await sleep(800);
    const second = await relay.open(`/${SECRET}/pair/host`);
    await first.expectClosed();
    await sleep(700); // past the first host's deadline, inside the second's
    assert.ok(second.isOpen);
    await second.expectClosed(3000);
  }));

test('the default pairing lifetime is long enough to pair in', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    await sleep(1500);
    guest.send({ t: 'pair', data: 'still-here' });
    assert.equal((await host.next()).data, 'still-here');
  }));

test('pairing traffic is limited in size and rate too', () =>
  withRelay({}, async (relay) => {
    const host = await relay.open(`/${SECRET}/pair/host`);
    const guest = await relay.open(`/${SECRET}/pair/guest`);
    for (let i = 0; i < 200; i++) guest.send({ t: 'pair', data: String(i) });
    await sleep(600);
    assert.equal(host.inbox.splice(0).length, 120);
    assert.ok(guest.inbox.some((m) => m.t === 'slow-down'));
    host.send(JSON.stringify({ t: 'pair', data: 'a'.repeat(MIB) }));
    assert.equal((await host.expectClosed()).code, 1009);
  }));

test('Durable Object storage holds no message data after a run', async () => {
  const persist = await mkdtemp(path.join(tmpdir(), 'sanctum-relay-test-'));
  const marker = 'MARKER-' + toB64(newIdentity().publicKey).replace(/[^A-Za-z0-9]/g, '');
  const pairMarker = 'PAIRMARKER-' + marker;
  try {
    await withRelay({ persist }, async (relay) => {
      const alice = await relay.device();
      const bob = await relay.device();
      alice.send({ t: 'send', to: bob.id, data: marker });
      assert.equal((await bob.next()).data, marker);
      // Offline and rejected sends must not be kept either.
      alice.send({ t: 'send', to: deviceIdFromPublicKey(newIdentity().publicKey), data: marker + '-offline' });
      assert.equal((await alice.next()).t, 'offline');

      const host = await relay.open(`/${SECRET}/pair/host`);
      const guest = await relay.open(`/${SECRET}/pair/guest`);
      guest.send({ t: 'pair', data: pairMarker });
      assert.equal((await host.next()).data, pairMarker);
    });

    const files = await listFiles(persist);
    assert.ok(files.length > 0, 'the Durable Objects should have persisted something to inspect');
    for (const file of files) {
      const bytes = await readFile(file);
      assert.ok(!bytes.includes(Buffer.from(marker)), `${file} holds message data`);
      assert.ok(!bytes.includes(Buffer.from(pairMarker)), `${file} holds pairing data`);
    }
  } finally {
    await rm(persist, { recursive: true, force: true });
  }
});

test('the Worker never logs', async () => {
  for (const name of ['index.js', 'mailbox.js', 'pairing-slot.js']) {
    const source = await readFile(path.join(root, 'src', name), 'utf8');
    assert.ok(!/console\.\w+/.test(source), `${name} writes to the console`);
  }
});

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    if ((await stat(full)).isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}
