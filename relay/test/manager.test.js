// Two real connection managers, through the real relay client, against the real Worker
// in Miniflare. test/remote-manager.test.js covers the manager's rules with a fake relay.
// This one proves the protocol end to end: pair with a code, connect, exchange frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createManager } = require('../../lib/remote/manager.js');
const relayClient = require('../../lib/remote/relay-client.js');
const { createKeystore } = require('../../lib/remote/keystore.js');
const { newIdentity, deviceIdFromPublicKey } = require('../../lib/remote/crypto.js');

const SECRET = 'test-secret-not-a-real-one-0123456789';
const PIN = '123456';
const FAST = { N: 16, r: 8, p: 1 };
const MIB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const wranglerToml = await readFile(path.join(root, 'wrangler.toml'), 'utf8');
const compatibilityDate = wranglerToml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1];

async function waitFor(what, check, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function startWorld(t) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(root, 'src', 'index.js'),
    modulesRoot: path.join(root, 'src'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate,
    durableObjects: {
      MAILBOX: { className: 'Mailbox', useSQLite: true },
      PAIRING_SLOT: { className: 'PairingSlot', useSQLite: true }
    },
    durableObjectsPersist: false,
    bindings: { ACCESS_SECRET: SECRET }
  });
  const url = new URL(await mf.ready);
  const dir = await mkdtemp(path.join(tmpdir(), 'sanctum-relay-manager-'));
  const managers = [];
  t.after(async () => {
    for (const manager of managers) manager.shutdown();
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  let count = 0;
  const address = `ws://${url.host}/${SECRET}`;
  return {
    host: url.host,
    address,
    async device(name, deviceAddress = address) {
      const keystore = createKeystore({
        file: path.join(dir, `keys-${count++}.json`),
        protect: (bytes) => bytes,
        unprotect: (bytes) => bytes,
        kdfCost: FAST
      });
      let saved = deviceAddress;
      const manager = createManager({
        keystore,
        relay: relayClient,
        addressStore: {
          load: () => saved,
          save: (value) => {
            saved = value;
          }
        },
        deviceName: name
      });
      managers.push(manager);
      const frames = [];
      manager.onFrame((id, frame) => frames.push({ id, frame }));
      assert.equal((await manager.setPin(PIN)).ok, true);
      return { name, manager, keystore, frames, id: deviceIdFromPublicKey(keystore.getIdentity().publicKey) };
    }
  };
}

// The host's socket opens in the background, and until it does the relay says no pairing
// is waiting. A person can't type a code that fast, but a test can. That answer doesn't
// count as a failed code, so asking again is fine.
async function pairWithCode(home, laptop) {
  const { code } = home.manager.createCode();
  assert.ok(code);
  for (let i = 0; i < 50; i++) {
    const answer = await laptop.manager.pair(code, laptop.name);
    if (answer.ok || !/cancelled/.test(answer.error)) return answer;
    await sleep(50);
  }
  return assert.fail('the pairing slot never opened');
}

test('two managers pair with a code, connect, exchange frames, and removal reaches the other end', async (t) => {
  const world = await startWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');

  const answer = await pairWithCode(home, laptop);
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.device.id, home.id);
  assert.equal(answer.device.name, 'Home');
  assert.equal(answer.device.role, 'home');

  await waitFor('both ends to connect', () => home.manager.status().devices[0]?.connected && laptop.manager.status().devices[0]?.connected);
  const atHome = home.manager.status().devices[0];
  assert.equal(atHome.id, laptop.id);
  assert.equal(atHome.name, 'Laptop');
  assert.equal(atHome.role, 'laptop');
  assert.equal(atHome.path, 'relay');
  assert.equal(atHome.fingerprint, `${laptop.id.slice(0, 4)}-${laptop.id.slice(4, 8)}`);
  assert.equal(home.keystore.listPeers()[0].provisional, undefined);

  // Both ways.
  assert.equal(home.manager.send(laptop.id, { from: 'home' }), true);
  assert.equal(laptop.manager.send(home.id, { from: 'laptop' }), true);
  await waitFor('small frames', () => home.frames.length === 1 && laptop.frames.length === 1);
  assert.deepEqual(laptop.frames[0], { id: home.id, frame: { from: 'home' } });
  assert.deepEqual(home.frames[0], { id: laptop.id, frame: { from: 'laptop' } });

  // Bigger than the relay's 1 MiB limit on a single frame, so it has to split.
  const big = { text: 'x'.repeat(2 * MIB), end: true };
  assert.equal(home.manager.send(laptop.id, big), true);
  await waitFor('the 2 MiB frame', () => laptop.frames.length === 2);
  assert.equal(laptop.frames[1].frame.text, big.text);
  assert.equal(laptop.frames[1].frame.end, true);

  // More than the relay's 120 a second, which only all arrive if they're paced.
  const burst = 300;
  for (let i = 0; i < burst; i++) assert.equal(laptop.manager.send(home.id, { i }), true);
  await waitFor('the burst', () => home.frames.length === burst + 1, 30000);
  assert.deepEqual(home.frames.slice(1).map((f) => f.frame.i), [...Array(burst).keys()]);

  // Removal, with the last device, so the relay socket closes straight after the notice.
  assert.deepEqual(laptop.manager.removeDevice(home.id), { ok: true });
  assert.deepEqual(laptop.manager.status().devices, []);
  await waitFor('the other end to remove it', () => home.manager.status().devices.length === 0);
  assert.deepEqual(home.keystore.listPeers(), []);
});

test('a wrong code fails, and the same code is then refused without asking again', async (t) => {
  const world = await startWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');

  const { code } = home.manager.createCode();
  const wrong = code === '222222' ? '333333' : '222222';
  await sleep(200);
  const first = await laptop.manager.pair(wrong, 'Laptop');
  assert.deepEqual(first, { ok: false, error: "That code didn't work. Check it and try again." });
  const second = await laptop.manager.pair(wrong, 'Laptop');
  assert.deepEqual(second, { ok: false, error: "That code didn't work. Get a new one." });
  assert.deepEqual(home.manager.status().devices, []);

  // The right one still works after that.
  const right = await laptop.manager.pair(code, 'Laptop');
  assert.equal(right.ok, true);
});

test('a wrong secret gets nowhere', async (t) => {
  const world = await startWorld(t);
  const laptop = await world.device('Laptop', `ws://${world.host}/not-the-secret`);
  const answer = await laptop.manager.pair('ABCDEF', 'Laptop');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /Couldn't reach/);
  assert.ok(!answer.error.includes('not-the-secret'));
});

test('the Worker answers pings on both kinds of socket, as the relay client relies on', async (t) => {
  const world = await startWorld(t);
  const identity = newIdentity();
  const sockets = [
    `${world.address}/device/${deviceIdFromPublicKey(identity.publicKey)}`,
    `${world.address}/pair/host`
  ];
  for (const url of sockets) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const pong = new Promise((resolve) => ws.once('pong', resolve));
    ws.ping();
    await Promise.race([pong, sleep(3000).then(() => assert.fail(`no pong from ${url.split('/').slice(-2).join('/')}`))]);
    ws.terminate();
  }
});

test('a device that is replaced by a newer connection of itself is told so by a close frame', async (t) => {
  const world = await startWorld(t);
  const identity = newIdentity();
  const clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle)
  };
  const connect = (events) =>
    relayClient.connectDevice({
      address: world.address,
      identity,
      clock,
      onReady: () => {
        events.ready = true;
      },
      onMessage: () => {},
      onOffline: () => {},
      onClose: () => {
        events.closed = true;
      }
    });

  const firstEvents = {};
  const first = connect(firstEvents);
  await waitFor('the first connection', () => firstEvents.ready);
  const secondEvents = {};
  const second = connect(secondEvents);
  await waitFor('the second connection', () => secondEvents.ready);
  await waitFor('the first to notice', () => firstEvents.closed, 3000);
  assert.equal(secondEvents.closed, undefined);
  first.close();
  second.close();
});
