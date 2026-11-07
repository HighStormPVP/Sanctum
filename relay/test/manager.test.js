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
import dgram from 'node:dgram';
import net from 'node:net';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createManager } = require('../../lib/remote/manager.js');
const relayClient = require('../../lib/remote/relay-client.js');
const { createKeystore } = require('../../lib/remote/keystore.js');
const { newIdentity, deviceIdFromPublicKey } = require('../../lib/remote/crypto.js');
const { createLocalPairing } = require('../../lib/remote/local-pairing.js');

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
    async device(name, deviceAddress = address, { local = null, clock } = {}) {
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
        local,
        ...(clock ? { clock } : {}),
        deviceName: name
      });
      managers.push(manager);
      const frames = [];
      manager.onFrame((id, frame) => frames.push({ id, frame }));
      assert.equal((await manager.setPin(PIN)).ok, true);
      return { name, manager, keystore, frames, saved: () => saved, id: deviceIdFromPublicKey(keystore.getIdentity().publicKey) };
    }
  };
}

// The host's socket opens in the background, and until it does the relay says no pairing
// is waiting. A person can't type a code that fast, but a test can. That answer doesn't
// count as a failed code, so asking again is fine.
async function pairWithCode(home, laptop) {
  const { code } = await home.manager.createCode();
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
  assert.equal(home.manager.send(laptop.id, { type: 'test', from: 'home' }), true);
  assert.equal(laptop.manager.send(home.id, { type: 'test', from: 'laptop' }), true);
  await waitFor('small frames', () => home.frames.length === 1 && laptop.frames.length === 1);
  assert.deepEqual(laptop.frames[0], { id: home.id, frame: { type: 'test', from: 'home' } });
  assert.deepEqual(home.frames[0], { id: laptop.id, frame: { type: 'test', from: 'laptop' } });

  // Bigger than the relay's 1 MiB limit on a single frame, so it has to split.
  const big = { type: 'test', text: 'x'.repeat(2 * MIB), end: true };
  assert.equal(home.manager.send(laptop.id, big), true);
  await waitFor('the 2 MiB frame', () => laptop.frames.length === 2);
  assert.equal(laptop.frames[1].frame.text, big.text);
  assert.equal(laptop.frames[1].frame.end, true);

  // More than the relay's 120 a second, which only all arrive if they're paced.
  const burst = 300;
  for (let i = 0; i < burst; i++) assert.equal(laptop.manager.send(home.id, { type: 'test', i }), true);
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

  const { code } = await home.manager.createCode();
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

// ---- Pairing on the same network, on loopback only ----
//
// Every socket here is on 127.0.0.1: one bound anywhere else makes Windows ask the person at
// this machine about its firewall. The discovery port is one that's free now, rather than the
// app's, so this can run beside anything else.

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind({ address: '127.0.0.1', port: 0 }, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function udpPortFree(port) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ address: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      socket.close();
    } catch { /* never bound */ }
  }
}

async function tcpPortFree(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// One loopback "network" for the devices in a test, which keeps every line that crosses it
// and every listener it opened.
async function nearby() {
  const discoveryPort = await freeUdpPort();
  const wire = [];
  const listeners = [];
  const pairing = createLocalPairing({ loopback: true, discoveryPort, onWire: (entry) => wire.push(entry) });
  const local = {
    ...pairing,
    listen(options) {
      const listener = pairing.listen(options);
      listeners.push(listener);
      return listener;
    }
  };
  return { local, wire, listeners, discoveryPort };
}

// Both of a listener's ports are free again. The listener says which they were.
async function listenerGone(net_, listener) {
  const ports = await listener.ready;
  assert.ok(ports, 'it had bound');
  await waitFor('both ports to be free', async () => (await udpPortFree(ports.udpPort)) && (await tcpPortFree(ports.tcpPort)), 5000);
}

// Real timers, except the code's ten minutes, which a test can bring forward.
function clockWithLongTimers() {
  const long = new Map();
  let next = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      if (ms < 10 * 60 * 1000) return setTimeout(fn, ms);
      const id = `long-${next++}`;
      long.set(id, fn);
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === 'string') long.delete(handle);
      else clearTimeout(handle);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    fireLong() {
      for (const [id, fn] of [...long]) {
        long.delete(id);
        fn();
      }
    }
  };
}

// Every way the text could cross readably: as it is, in JSON, base64 from any byte, and hex.
function readable(lines, needle) {
  const forms = new Set([needle, JSON.stringify(needle).slice(1, -1)]);
  const bytes = Buffer.from(needle);
  forms.add(bytes.toString('hex'));
  for (let shift = 0; shift < 3; shift++) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const form = encoded.slice(shift ? 4 : 0, Math.floor((shift + bytes.length) / 3) * 4);
    if (form.length >= 8) forms.add(form);
  }
  const text = lines.map((entry) => entry.bytes.toString('latin1')).join('\n');
  const decoded = [...text.matchAll(/[A-Za-z0-9+/]{12,}={0,2}/g)].map((m) => Buffer.from(m[0], 'base64').toString('latin1')).join('\n');
  return [...forms].some((form) => text.includes(form) || decoded.includes(form));
}

test('on the same network, a laptop with only the code pairs, gets the address, and both then talk through the relay', async (t) => {
  const world = await startWorld(t);
  const { local, wire, listeners } = await nearby();
  const home = await world.device('Home', world.address, { local });
  const laptop = await world.device('Laptop', null, { local });
  assert.equal(laptop.manager.status().enabled, false);

  const { code } = await home.manager.createCode();
  assert.ok(code);
  assert.equal(listeners.length, 1);
  assert.deepEqual(await listeners[0].ready && listeners[0].boundAddresses(), ['127.0.0.1', '127.0.0.1']);

  const answer = await laptop.manager.pair(code, 'Laptop');
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.device.id, home.id);
  assert.equal(laptop.saved(), world.address, 'the laptop holds the home PC\'s address');
  assert.equal(laptop.manager.status().enabled, true);
  await listenerGone(net, listeners[0]);

  await waitFor('both ends to connect', () => home.manager.status().devices[0]?.connected && laptop.manager.status().devices[0]?.connected);
  assert.equal(laptop.manager.status().devices[0].path, 'relay');
  assert.equal(home.manager.status().devices[0].path, 'relay');
  assert.equal(home.manager.send(laptop.id, { type: 'test', from: 'home' }), true);
  assert.equal(laptop.manager.send(home.id, { type: 'test', from: 'laptop' }), true);
  await waitFor('a frame each way', () => home.frames.length === 1 && laptop.frames.length === 1);
  assert.deepEqual(laptop.frames[0], { id: home.id, frame: { type: 'test', from: 'home' } });
  assert.deepEqual(home.frames[0], { id: laptop.id, frame: { type: 'test', from: 'laptop' } });

  // What crossed the local network: the four pairing messages, and nothing readable in them.
  const lines = wire.filter((entry) => entry.from === 'laptop' || entry.from === 'home');
  const sent = lines.map((entry) => entry.bytes.toString('utf8')).join('');
  assert.deepEqual(sent.trim().split('\n').map((line) => JSON.parse(line).t).filter((v, i, all) => all.indexOf(v) === i), ['pake', 'pake-reply', 'confirm', 'identity']);
  for (const needle of [world.address, SECRET, `/${SECRET}`, world.host, code, code.toLowerCase()]) {
    assert.equal(readable(lines, needle), false, `${needle === world.address ? 'the address' : needle === code ? 'the code' : 'a secret'} is readable on the local network`);
  }
  // The search works, so finding nothing means something.
  assert.equal(readable([{ bytes: Buffer.from(JSON.stringify({ b: Buffer.from(`x${world.address}`).toString('base64') })) }], world.address), true);
});

test('on the same network, a wrong code uses one of the five attempts, and five cancel the code whichever way they came', async (t) => {
  const world = await startWorld(t);
  const { local, listeners } = await nearby();
  const home = await world.device('Home', world.address, { local });
  const { code } = await home.manager.createCode();
  const wrongs = ['222222', '333333', '444444', '555555', '666666'].filter((c) => c !== code).slice(0, 5);

  const first = await world.device('Laptop 1', null, { local });
  assert.deepEqual(await first.manager.pair(wrongs[0], 'Laptop 1'), { ok: false, error: "That code didn't work. Check it and try again." });
  assert.equal(home.manager.status().codePending, true);

  // Three through the relay.
  for (let i = 1; i <= 3; i++) {
    const viaRelay = await world.device(`Laptop ${i + 1}`);
    await sleep(100);
    assert.deepEqual(await viaRelay.manager.pair(wrongs[i], 'Laptop'), { ok: false, error: "That code didn't work. Check it and try again." });
  }
  assert.equal(home.manager.status().codePending, true);

  // The fifth, back on this network, and the code is over.
  const fifth = await world.device('Laptop 5', null, { local });
  assert.deepEqual(await fifth.manager.pair(wrongs[4], 'Laptop 5'), { ok: false, error: "That code didn't work. Check it and try again." });
  await waitFor('the code to be cancelled', () => home.manager.status().codePending === false, 5000);
  await listenerGone(net, listeners[0]);

  // The right code finds nothing now, either way.
  const late = await world.device('Late', null, { local });
  assert.match((await late.manager.pair(code, 'Late')).error, /Couldn't find a home PC/);
  const lateRelay = await world.device('Late relay');
  assert.match((await lateRelay.manager.pair(code, 'Late relay')).error, /cancelled/);
  assert.deepEqual(home.manager.status().devices, []);
});

test('on the same network, the listener is gone after cancelling, expiry and shutdown', async (t) => {
  const world = await startWorld(t);
  const { local, listeners } = await nearby();
  const clock = clockWithLongTimers();
  const home = await world.device('Home', world.address, { local, clock });

  await home.manager.createCode();
  assert.ok(await listeners[0].ready);
  home.manager.cancelCode();
  await listenerGone(net, listeners[0]);

  await home.manager.createCode();
  assert.ok(await listeners[1].ready);
  clock.fireLong();
  assert.equal(home.manager.status().codePending, false);
  await listenerGone(net, listeners[1]);

  await home.manager.createCode();
  assert.ok(await listeners[2].ready);
  home.manager.shutdown();
  await listenerGone(net, listeners[2]);
});
