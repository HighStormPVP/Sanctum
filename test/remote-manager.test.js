// The connection manager, with a fake relay and a fake clock, so a test decides what
// gets delivered, what gets lost, and how much time passes. Everything below the relay
// is real: keystore, pairing, sessions and links. The real relay client talks to the
// real Worker in relay/test/manager.test.js.
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = (name) => require(path.join(__dirname, '..', 'lib', 'remote', name));
const { createManager, fingerprintOf, cleanName } = lib('manager.js');
const { connectDevice, connectPairing } = lib('relay-client.js');
const { createKeystore } = lib('keystore.js');
const { newIdentity, verify, deviceIdFromPublicKey } = lib('crypto.js');
const { createPairingGuest, createPairingHost } = lib('pairing.js');
const { createSession } = lib('session.js');

const FAST = { N: 16, r: 8, p: 1 };
const PIN = '123456';
const ADDRESS = 'wss://relay.example/secret-part-of-the-address';
const WRONG_CODE_RETRY = "That code didn't work. Check it and try again.";
const WRONG_CODE_FINAL = "That code didn't work. Get a new one.";
const MINUTES = 60 * 1000;
const MIB = 1024 * 1024;

function fakeClock() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: time + Math.max(0, ms), every: null });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: time + ms, every: ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    // This device wasn't running for a while: time passed, and no timer had a chance to fire.
    stall(ms) {
      time += ms;
    },
    // Runs what falls due, in order. `after` runs after each one, so what a timer sent
    // arrives at the time it was sent rather than after the whole advance.
    advance(ms, after = () => {}) {
      const end = time + ms;
      after();
      for (;;) {
        let nextEntry = null;
        for (const entry of timers) {
          if (entry[1].due <= end && (!nextEntry || entry[1].due < nextEntry[1].due)) nextEntry = entry;
        }
        if (!nextEntry) break;
        const [id, timer] = nextEntry;
        time = Math.max(time, timer.due);
        if (timer.every) timer.due += timer.every;
        else timers.delete(id);
        timer.fn();
        after();
      }
      time = end;
    },
    pendingTimers: () => timers.size
  };
  return clock;
}

// Behaves as the Worker does, with a queue in the middle. Nothing arrives until pump()
// runs. Every payload goes through JSON, as it would on a real socket. There's no
// pairing TTL here: the manager has to do its own expiry.
function fakeRelay() {
  const queue = [];
  const devices = new Map();
  const slot = { host: null, guest: null };
  const relay = {
    log: [],
    pairLog: [],
    deviceConnects: [],
    pairConnects: [],
    refuse: false,
    drop: () => false,
    dropPair: () => false,
    pump() {
      while (queue.length) queue.shift()();
    },
    inject(from, to, data) {
      queue.push(() => {
        const client = devices.get(to);
        if (client) client.opts.onMessage(from, JSON.parse(JSON.stringify(data)));
      });
    },
    kill(deviceId) {
      const client = devices.get(deviceId);
      if (!client) return;
      devices.delete(deviceId);
      client.closed = true;
      client.opts.onClose();
    },
    connectDevice(opts) {
      const deviceId = deviceIdFromPublicKey(opts.identity.publicKey);
      const client = {
        deviceId,
        opts,
        closed: false,
        send(to, data) {
          if (client.closed) return false;
          if (relay.drop({ from: deviceId, to, data })) return true;
          relay.log.push({ from: deviceId, to, data });
          const text = JSON.stringify(data);
          queue.push(() => {
            const target = devices.get(to);
            if (target) target.opts.onMessage(deviceId, JSON.parse(text));
            else if (!client.closed) opts.onOffline(to);
          });
          return true;
        },
        close() {
          client.closed = true;
          if (devices.get(deviceId) === client) devices.delete(deviceId);
        }
      };
      relay.deviceConnects.push(client);
      queue.push(() => {
        if (client.closed) return;
        if (relay.refuse) {
          client.closed = true;
          opts.onClose();
          return;
        }
        const previous = devices.get(deviceId);
        devices.set(deviceId, client);
        if (previous) {
          previous.closed = true;
          previous.opts.onClose();
        }
        opts.onReady();
      });
      return client;
    },
    connectPairing(opts) {
      const { role } = opts;
      const other = role === 'host' ? 'guest' : 'host';
      const client = {
        role,
        opts,
        closed: false,
        send(data) {
          if (client.closed) return;
          if (relay.dropPair({ role, data })) return;
          relay.pairLog.push({ role, data });
          const text = JSON.stringify(data);
          queue.push(() => {
            const target = slot[other];
            if (target && !target.closed) target.opts.onMessage(JSON.parse(text));
          });
        },
        // Queued, so what this client already sent arrives first, as on a real socket.
        close() {
          client.closed = true;
          queue.push(() => {
            if (slot[role] === client) slot[role] = null;
            if (role === 'host' && slot.guest) retire(slot.guest);
          });
        }
      };
      function retire(old) {
        old.closed = true;
        if (slot[old.role] === old) slot[old.role] = null;
        queue.push(() => old.opts.onClose());
      }
      relay.pairConnects.push(client);
      queue.push(() => {
        if (client.closed) return;
        if (role === 'host') {
          if (slot.host) retire(slot.host);
          if (slot.guest) retire(slot.guest);
        } else if (!slot.host) {
          opts.onOpen();
          opts.onNone();
          retire(client);
          return;
        } else if (slot.guest) {
          retire(slot.guest);
        }
        slot[role] = client;
        opts.onOpen();
      });
      return client;
    }
  };
  return relay;
}

// The secret's file, in memory, with sealing that visibly changes the bytes.
function fakeAutoUnlock() {
  const store = { bytes: null, writes: 0, reads: 0, failProtect: false, failUnprotect: false, failRead: false, garble: false };
  return {
    store,
    read() {
      store.reads += 1;
      if (store.failRead) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return store.bytes;
    },
    write(bytes) {
      store.bytes = Buffer.from(bytes);
      store.writes += 1;
    },
    remove() {
      store.bytes = null;
    },
    protect(bytes) {
      if (store.failProtect) throw new Error('no secure storage');
      return Buffer.concat([Buffer.from('sealed:'), Buffer.from(bytes).reverse()]);
    },
    unprotect(bytes) {
      if (store.failUnprotect) throw new Error('no secure storage');
      if (store.garble) return Buffer.from('not-the-secret');
      return Buffer.from(bytes).subarray('sealed:'.length).reverse();
    }
  };
}

// Lets the manager's queue of key operations run what needs no thread pool.
const tick = () => new Promise((resolve) => setImmediate(resolve));
// The wrong-guess counter, off the disk. These tests' protect leaves the file as plain JSON.
const failedOnDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed;

// For what finishes on the thread pool: the keystore's scrypt.
async function until(what, check) {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function newWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-manager-'));
  const world = { clock: fakeClock(), relay: fakeRelay(), devices: [], keystoreOffset: 0 };
  t.after(() => {
    for (const device of world.devices) device.manager?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let count = 0;
  world.newFile = () => path.join(dir, `keys-${count++}.json`);
  world.keystore = (file = world.newFile()) =>
    createKeystore({
      file,
      protect: (bytes) => bytes,
      unprotect: (bytes) => bytes,
      kdfCost: FAST,
      now: () => Date.now() + world.keystoreOffset
    });
  // A device with a PIN set, whose manager isn't running yet, so a test can seed peers.
  world.device = async (name, { pin = true, address = ADDRESS, file = world.newFile(), keystore = world.keystore(file) } = {}) => {
    if (pin) assert.deepEqual(await keystore.setPin(PIN), { ok: true });
    const device = { name, keystore, file, autoUnlock: fakeAutoUnlock(), frames: [], statuses: [], refusals: [], address };
    device.identity = () => keystore.getIdentity();
    device.id = pin ? deviceIdFromPublicKey(keystore.getIdentity().publicKey) : null;
    device.start = () => {
      device.manager = createManager({
        keystore,
        relay: world.relay,
        addressStore: {
          load: () => device.address,
          save: (url) => {
            device.address = url;
          }
        },
        autoUnlock: device.autoUnlock,
        clock: world.clock,
        deviceName: name,
        createDirect: device.createDirect,
        onToolRefused: (info) => device.refusals.push(info)
      });
      const send = device.manager.send;
      device.manager.send = (id, frame) => {
        if (frame === null || typeof frame !== 'object' || 'type' in frame) return send(id, frame);
        const type = device.entry(id)?.role === 'laptop' ? 'mirror-ops' : 'mirror-resync-request';
        return send(id, { ...frame, type, testFrame: true });
      };
      device.manager.onFrame((id, frame) => {
        if (frame?.testFrame !== true) {
          device.frames.push({ id, frame });
          return;
        }
        const { type, testFrame, ...sent } = frame;
        device.frames.push({ id, frame: sent });
      });
      device.manager.onStatus((status) => device.statuses.push(status));
      return device;
    };
    device.entry = (id) => device.manager.status().devices.find((entry) => entry.id === id);
    // The app restarting: same files, nothing in memory.
    device.restart = () => {
      device.manager.shutdown();
      device.keystore = world.keystore(device.file);
      device.identity = () => device.keystore.getIdentity();
      keystore = device.keystore;
      return device.start();
    };
    world.devices.push(device);
    return device;
  };
  world.run = (ms) => world.clock.advance(ms, () => world.relay.pump());
  return world;
}

function seedPair(home, laptop) {
  home.keystore.addPeer({ deviceId: laptop.id, publicKey: laptop.identity().publicKey, name: laptop.name, role: 'laptop' });
  laptop.keystore.addPeer({ deviceId: home.id, publicKey: home.identity().publicKey, name: home.name, role: 'home' });
}

// Two devices paired before their managers started, already connected.
async function connected(t) {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  home.start();
  laptop.start();
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
  return { world, home, laptop };
}

const fromRelayB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const linkMessages = (relay, from, to) => relay.log.filter((m) => m.from === from && m.to === to && m.data.t === 'link');
const hellos = (relay, from, to) => relay.log.filter((m) => m.from === from && m.to === to && m.data.t === 'session-hello');
const auths = (relay, from, to) => relay.log.filter((m) => m.from === from && m.to === to && m.data.t === 'session-auth');
const DATA = 1;
const ACK = 2;

// A link frame built by hand, to stand in for a relay forging headers.
function forgeLink(type, connectionId, seq, body = new Uint8Array(0)) {
  const frame = new Uint8Array(13 + body.length);
  const view = new DataView(frame.buffer);
  frame[0] = type;
  frame.set(connectionId, 1);
  view.setUint32(5, Math.floor(seq / 2 ** 32));
  view.setUint32(9, seq % 2 ** 32);
  frame.set(body, 13);
  return { t: 'link', b: Buffer.from(frame).toString('base64') };
}

// The connection id and the next sequence number `from` will use toward `to`, read off
// the wire by making it send a frame.
function liveLinkState(world, from, to) {
  assert.equal(from.manager.send(to.id, { probe: true }), true);
  world.relay.pump();
  const dataFrames = linkMessages(world.relay, from.id, to.id)
    .map((m) => fromRelayB64(m.data.b))
    .filter((bytes) => bytes[0] === DATA);
  const last = dataFrames[dataFrames.length - 1];
  const view = new DataView(last.buffer, last.byteOffset);
  return {
    connectionId: last.slice(1, 5),
    nextSeq: view.getUint32(5) * 2 ** 32 + view.getUint32(9) + 1
  };
}

// A guest not backed by a manager, for driving a home device directly.
function rawGuest(relay, { code, identity = newIdentity(), name = 'Guest' }) {
  const guest = createPairingGuest({ code, identity, name });
  const raw = { guest, identity, received: [] };
  raw.client = relay.connectPairing({
    role: 'guest',
    onOpen: () => raw.client.send(guest.first),
    onMessage: (data) => raw.received.push(data),
    onNone: () => {
      raw.none = true;
    },
    onClose: () => {}
  });
  return raw;
}

function rawHost(relay, { code, identity = newIdentity(), name = 'Host' }) {
  const host = createPairingHost({ code, identity, name });
  const raw = { host, identity, peers: [] };
  raw.client = relay.connectPairing({
    role: 'host',
    onOpen: () => {},
    onNone: () => {},
    onClose: () => {},
    onMessage: (data) => {
      const result = host.handle(data);
      if (result.peer) raw.peers.push(result.peer);
      if (result.reply) raw.client.send(result.reply);
    }
  });
  return raw;
}

// Pairs through the real flow and returns what `pair` answered.
async function pairNow(world, home, laptop, name = 'Laptop') {
  const { code } = await home.manager.createCode();
  assert.ok(code);
  world.relay.pump();
  const answer = laptop.manager.pair(code, name);
  world.relay.pump();
  return { code, answer: await answer };
}

// ---- Fail closed: no address, and locked ----

test('with no address, status says disabled and no client is created', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { address: null });
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.start();
  world.run(5 * MINUTES);

  const status = device.manager.status();
  assert.equal(status.enabled, false);
  assert.equal(world.relay.deviceConnects.length, 0);
  assert.equal(world.relay.pairConnects.length, 0);
  assert.ok((await device.manager.createCode()).error);
  assert.equal(world.relay.pairConnects.length, 0);
  const paired = await device.manager.pair('ABCDEF', 'Device');
  assert.equal(paired.ok, false);
  assert.equal(world.relay.pairConnects.length, 0);
});

test('setting the address starts the connection, and the address is never in status', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { address: null });
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.start();

  assert.deepEqual(device.manager.setAddress(ADDRESS), { ok: true });
  assert.equal(device.address, ADDRESS);
  assert.equal(device.manager.status().enabled, true);
  assert.equal(world.relay.deviceConnects.length, 1);
  assert.equal(world.relay.deviceConnects[0].opts.address, ADDRESS);
  assert.ok(!JSON.stringify(device.manager.status()).includes('secret-part'));
});

test('an address that is not a relay address is refused, and its text is not repeated', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { address: null });
  device.start();
  for (const bad of ['nonsense', 'ftp://relay.example/abc', 'ws://relay.example/abc', 'wss://relay.example/', 'wss://relay.example/a/b', 'wss://u:p@relay.example/abc', 'wss://relay.example/abc?x=1', 7]) {
    const result = device.manager.setAddress(bad);
    assert.equal(result.ok, false, String(bad));
    assert.ok(!result.error.includes(String(bad)), String(bad));
  }
  assert.equal(device.manager.status().enabled, false);
  assert.equal(device.address, null);

  // An https link works, as does plain ws to this machine, which is how tests reach a local Worker.
  assert.deepEqual(device.manager.setAddress('https://relay.example/abc/'), { ok: true });
  assert.equal(device.address, 'wss://relay.example/abc');
  assert.deepEqual(device.manager.setAddress('ws://127.0.0.1:8787/abc'), { ok: true });
  assert.deepEqual(device.manager.setAddress(''), { ok: true });
  assert.equal(device.manager.status().enabled, false);
});

test('while locked no connection starts, and unlock starts them', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.keystore.lock();
  device.start();
  world.run(5 * MINUTES);

  const locked = device.manager.status();
  assert.equal(locked.enabled, true);
  assert.equal(locked.locked, true);
  assert.equal(locked.hasPin, true);
  assert.deepEqual(locked.devices, []);
  assert.equal(world.relay.deviceConnects.length, 0);

  // Nothing that opens a connection works yet.
  assert.ok((await device.manager.createCode()).error);
  assert.equal((await device.manager.pair('ABCDEF', 'Device')).ok, false);
  assert.equal(world.relay.pairConnects.length, 0);

  assert.equal((await device.manager.unlock('000000')).ok, false);
  world.run(MINUTES);
  assert.equal(world.relay.deviceConnects.length, 0);

  assert.equal((await device.manager.unlock(PIN)).ok, true);
  world.relay.pump();
  assert.equal(device.manager.status().locked, false);
  assert.equal(world.relay.deviceConnects.length, 1);
  assert.equal(device.manager.status().devices.length, 1);
});

test('setting a first PIN unlocks, and a device with no peers holds no connection', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  assert.equal(device.manager.status().hasPin, false);
  assert.equal(device.manager.status().locked, true);
  assert.equal((await device.manager.setPin(PIN)).ok, true);
  assert.equal(device.manager.status().hasPin, true);
  assert.equal(device.manager.status().locked, false);
  world.run(MINUTES);
  assert.equal(world.relay.deviceConnects.length, 0);
});

test('status reports storageAvailable, and retries when secure storage becomes available', async (t) => {
  const world = newWorld(t);
  let available = false;
  const keystore = createKeystore({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-manager-storage-')), 'keys.json'),
    protect: (bytes) => bytes,
    unprotect: (bytes) => bytes,
    kdfCost: FAST,
    isProtectionAvailable: () => available
  });
  const device = await world.device('Device', { pin: false, keystore });
  device.start();
  assert.equal(device.manager.status().storageAvailable, false);
  assert.equal(device.manager.status().hasPin, false);
  assert.equal((await device.manager.setPin(PIN)).ok, false);

  available = true;
  assert.equal(device.manager.status().storageAvailable, true);
  assert.equal((await device.manager.setPin(PIN)).ok, true);
});

// ---- Pairing ----

test('a pairing on both ends lists each device with the right role and fingerprint', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  const created = await home.manager.createCode();
  assert.match(created.code, /^[2-9A-Z]{6}$/);
  assert.equal(created.expiresAt, world.clock.now() + 10 * MINUTES);
  assert.equal(home.manager.status().codePending, true);
  world.relay.pump();

  const pairing = laptop.manager.pair(created.code.toLowerCase(), 'My laptop');
  world.relay.pump();
  const answer = await pairing;
  assert.equal(answer.ok, true);
  assert.equal(answer.device.id, home.id);
  assert.equal(answer.device.name, 'Home');
  assert.equal(answer.device.role, 'home');
  assert.equal(home.manager.status().codePending, false);

  world.relay.pump();
  const atHome = home.entry(laptop.id);
  assert.equal(atHome.name, 'My laptop');
  assert.equal(atHome.role, 'laptop');
  assert.equal(atHome.fingerprint, `${laptop.id.slice(0, 4)}-${laptop.id.slice(4, 8)}`);
  assert.equal(atHome.connected, true);
  assert.equal(atHome.path, 'relay');
  const atLaptop = laptop.entry(home.id);
  assert.equal(atLaptop.role, 'home');
  assert.equal(atLaptop.fingerprint, `${home.id.slice(0, 4)}-${home.id.slice(4, 8)}`);
  assert.equal(atLaptop.connected, true);

  // And the pairing is real: they can talk.
  assert.equal(laptop.manager.send(home.id, { hello: 'home' }), true);
  assert.equal(home.manager.send(laptop.id, { hello: 'laptop' }), true);
  world.relay.pump();
  assert.deepEqual(home.frames, [{ id: laptop.id, frame: { hello: 'home' } }]);
  assert.deepEqual(laptop.frames, [{ id: home.id, frame: { hello: 'laptop' } }]);
});

test('fingerprintOf groups the first eight characters of a device id', () => {
  assert.equal(fingerprintOf('abcdefghijklmnop'), 'abcd-efgh');
});

test('home side: the manager discards a code after 10 minutes without the relay saying so', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const hostClient = world.relay.pairConnects[0];

  world.run(10 * MINUTES - 1);
  assert.equal(home.manager.status().codePending, true);
  assert.equal(hostClient.closed, false);

  world.run(1);
  assert.equal(home.manager.status().codePending, false);
  assert.equal(hostClient.closed, true);

  // The right code does nothing now.
  const late = rawGuest(world.relay, { code });
  world.relay.pump();
  assert.equal(late.none, true);
  assert.deepEqual(late.received, []);
  assert.deepEqual(home.manager.status().devices, []);
});

test('home side: attempts running out and then 15 seconds of nothing cancels the code', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const wrong = code === '222222' ? '333333' : '222222';

  // A guest with a wrong code goes silent, so no failure ever reaches the host.
  for (let i = 0; i < 5; i++) {
    rawGuest(world.relay, { code: wrong });
    world.relay.pump();
  }
  assert.equal(home.manager.status().codePending, true);
  world.run(15 * 1000 - 1);
  assert.equal(home.manager.status().codePending, true);
  world.run(1);
  assert.equal(home.manager.status().codePending, false);
  assert.equal(world.relay.pairConnects[0].closed, true);
});

test('home side: the fifth attempt can still complete inside those 15 seconds', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const wrong = code === '222222' ? '333333' : '222222';
  for (let i = 0; i < 4; i++) {
    rawGuest(world.relay, { code: wrong });
    world.relay.pump();
  }

  const fifth = rawGuest(world.relay, { code, name: 'Fifth' });
  world.relay.pump();
  assert.equal(fifth.received.length, 1);
  world.run(14 * 1000);
  const { reply } = fifth.guest.handle(fifth.received[0]);
  fifth.client.send(reply);
  world.relay.pump();

  const id = deviceIdFromPublicKey(fifth.identity.publicKey);
  assert.equal(home.entry(id).name, 'Fifth');
  world.run(MINUTES);
  assert.ok(home.keystore.listPeers().some((peer) => peer.deviceId === id));
});

test('home side: a failed result with no attempts left cancels the code at once', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const wrong = code === '222222' ? '333333' : '222222';
  for (let i = 0; i < 5; i++) {
    rawGuest(world.relay, { code: wrong });
    world.relay.pump();
  }
  assert.equal(home.manager.status().codePending, true);

  // Something bad in place of the confirmation that attempt was waiting for.
  const last = rawGuest(world.relay, { code: wrong });
  world.relay.pump();
  assert.deepEqual(last.received, []);
  assert.equal(home.manager.status().codePending, false);
});

test('home side: a new code replaces the old one, and cancelCode ends it', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  const first = await home.manager.createCode();
  world.relay.pump();
  const second = await home.manager.createCode();
  world.relay.pump();
  assert.notEqual(first.code, second.code);
  assert.equal(world.relay.pairConnects[0].closed, true);
  assert.equal(home.manager.status().codePending, true);

  // Nothing lands on the first expiry timer.
  world.run(9 * MINUTES);
  assert.equal(home.manager.status().codePending, true);

  const old = laptop.manager.pair(first.code, 'Laptop');
  world.relay.pump();
  assert.deepEqual(await old, { ok: false, error: WRONG_CODE_RETRY });

  await home.manager.createCode();
  world.relay.pump();
  home.manager.cancelCode();
  assert.equal(home.manager.status().codePending, false);
  assert.equal(world.relay.pairConnects[world.relay.pairConnects.length - 1].closed, true);
});

test('home side: the relay ending the slot ends the code', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  await home.manager.createCode();
  world.relay.pump();
  world.relay.pairConnects[0].opts.onClose();
  assert.equal(home.manager.status().codePending, false);
});

test('laptop side: pair gives up after 30 seconds, since a host failure sends nothing back', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  // A host that takes messages and never answers.
  world.relay.connectPairing({ role: 'host', onOpen() {}, onNone() {}, onClose() {}, onMessage() {} });
  world.relay.pump();

  let settled = null;
  const pairing = laptop.manager.pair('ABCDEF', 'Laptop').then((answer) => {
    settled = answer;
    return answer;
  });
  world.relay.pump();
  world.run(30 * 1000 - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, null);

  world.run(1);
  const answer = await pairing;
  assert.equal(answer.ok, false);
  assert.match(answer.error, /didn't answer/);
  assert.equal(world.relay.pairConnects[1].closed, true);

  // Silence tested nothing about this code, so trying it again is allowed.
  const before = world.relay.pairConnects.length;
  const retry = laptop.manager.pair('ABCDEF', 'Laptop');
  assert.equal(world.relay.pairConnects.length, before + 1);
  world.relay.pump();
  world.run(30 * 1000);
  assert.match((await retry).error, /didn't answer/);
});

test('laptop side: no code waiting gets a clear answer, not a wait', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  const pairing = laptop.manager.pair('ABCDEF', 'Laptop');
  world.relay.pump();
  assert.deepEqual(await pairing, { ok: false, error: 'That code was cancelled. Get a new one.' });

  // Nothing was tested, so this isn't remembered as a failed code.
  const before = world.relay.pairConnects.length;
  const again = laptop.manager.pair('ABCDEF', 'Laptop');
  assert.equal(world.relay.pairConnects.length, before + 1);
  world.relay.pump();
  await again;
});

test('laptop side: a code that is malformed never reaches the network', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  for (const bad of ['', 'ABC', 'ABCDEFG', 'ABC0EF', null, 12]) {
    assert.deepEqual(await laptop.manager.pair(bad, 'Laptop'), { ok: false, error: WRONG_CODE_RETRY });
  }
  assert.equal(world.relay.pairConnects.length, 0);
});

test('laptop side: only one pairing runs at a time', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  world.relay.connectPairing({ role: 'host', onOpen() {}, onNone() {}, onClose() {}, onMessage() {} });
  world.relay.pump();
  const first = laptop.manager.pair('ABCDEF', 'Laptop');
  const second = await laptop.manager.pair('ABCDEG', 'Laptop');
  assert.equal(second.ok, false);
  world.relay.pump();
  world.run(30 * 1000);
  await first;
});

test('a one-sided pairing: home has the peer, laptop reports failure, and the entry can be removed', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  // The last message is lost.
  world.relay.dropPair = ({ role, data }) => role === 'host' && data.t === 'identity';
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop');
  world.relay.pump();
  world.run(30 * 1000);
  const answer = await pairing;
  assert.equal(answer.ok, false);
  assert.ok(answer.error);
  assert.deepEqual(laptop.manager.status().devices, []);

  const entry = home.entry(laptop.id);
  assert.equal(entry.connected, false);
  assert.equal(entry.path, 'offline');

  assert.deepEqual(home.manager.removeDevice(laptop.id), { ok: true });
  assert.deepEqual(home.manager.status().devices, []);
  assert.deepEqual(home.keystore.listPeers(), []);
});

test('a one-sided pairing: pairing again works and does not create a duplicate', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  world.relay.dropPair = ({ role, data }) => role === 'host' && data.t === 'identity';
  const first = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(first.code, 'Laptop');
  world.relay.pump();
  world.run(30 * 1000);
  assert.equal((await pairing).ok, false);
  assert.equal(home.keystore.listPeers().length, 1);

  world.relay.dropPair = () => false;
  const { answer } = await pairNow(world, home, laptop);
  assert.equal(answer.ok, true);
  world.relay.pump();
  assert.equal(home.keystore.listPeers().length, 1);
  assert.equal(home.manager.status().devices.length, 1);
  assert.equal(home.entry(laptop.id).connected, true);
});

test("a peer's name is untrusted: empty becomes Unnamed device, and it stops at 64 characters", async (t) => {
  assert.equal(cleanName(''), 'Unnamed device');
  assert.equal(cleanName('   \n '), 'Unnamed device');
  assert.equal(cleanName(undefined), 'Unnamed device');
  assert.equal(cleanName(' Fine '), 'Fine');
  assert.equal(cleanName('x'.repeat(500)).length, 64);
  // An astral character stays whole.
  assert.equal(cleanName('\u{1F600}'.repeat(100)), '\u{1F600}'.repeat(64));

  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();

  async function pairRaw(name) {
    const { code } = await home.manager.createCode();
    world.relay.pump();
    const raw = rawGuest(world.relay, { code, name });
    world.relay.pump();
    raw.client.send(raw.guest.handle(raw.received[0]).reply);
    world.relay.pump();
    return deviceIdFromPublicKey(raw.identity.publicKey);
  }

  const empty = await pairRaw('');
  assert.equal(home.entry(empty).name, 'Unnamed device');
  assert.equal(home.keystore.listPeers().find((peer) => peer.deviceId === empty).name, 'Unnamed device');

  const long = await pairRaw('y'.repeat(500));
  assert.equal(home.entry(long).name, 'y'.repeat(64));
  assert.equal(home.keystore.listPeers().find((peer) => peer.deviceId === long).name.length, 64);

  // Laptop side, from a home PC that names itself nothing.
  const laptop = await world.device('Laptop');
  laptop.start();
  home.manager.cancelCode();
  world.relay.pump();
  rawHost(world.relay, { code: 'ABCDEF', name: '' });
  world.relay.pump();
  const pairing = laptop.manager.pair('ABCDEF', 'Laptop');
  world.relay.pump();
  const answer = await pairing;
  assert.equal(answer.ok, true);
  assert.equal(answer.device.name, 'Unnamed device');
});

test('laptop side: a code that failed here is refused without contacting anyone, then forgotten', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  rawHost(world.relay, { code: 'ABCDEF' });
  world.relay.pump();

  const first = laptop.manager.pair('ZZZZZZ', 'Laptop');
  world.relay.pump();
  assert.deepEqual(await first, { ok: false, error: WRONG_CODE_RETRY });

  const contacts = world.relay.pairConnects.length;
  const sent = world.relay.pairLog.length;
  assert.deepEqual(await laptop.manager.pair('ZZZZZZ', 'Laptop'), { ok: false, error: WRONG_CODE_FINAL });
  assert.deepEqual(await laptop.manager.pair('zzzzzz', 'Laptop'), { ok: false, error: WRONG_CODE_FINAL });
  assert.equal(world.relay.pairConnects.length, contacts);
  assert.equal(world.relay.pairLog.length, sent);

  world.run(10 * MINUTES - 1);
  assert.deepEqual(await laptop.manager.pair('ZZZZZZ', 'Laptop'), { ok: false, error: WRONG_CODE_FINAL });
  world.run(1);
  const later = laptop.manager.pair('ZZZZZZ', 'Laptop');
  assert.equal(world.relay.pairConnects.length, contacts + 1);
  world.relay.pump();
  await later;
});

test('laptop side: a fake home PC gets one guess per code, whatever it answers', async (t) => {
  const world = newWorld(t);
  const laptop = await world.device('Laptop');
  laptop.start();
  const fake = world.relay.connectPairing({
    role: 'host',
    onOpen() {},
    onNone() {},
    onClose() {},
    onMessage: () => fake.send({ t: 'pake-reply', pake: 'AAAA', confirm: 'AAAA' })
  });
  world.relay.pump();

  const pairing = laptop.manager.pair('ABCDEF', 'Laptop');
  world.relay.pump();
  assert.deepEqual(await pairing, { ok: false, error: WRONG_CODE_RETRY });
  assert.deepEqual(await laptop.manager.pair('ABCDEF', 'Laptop'), { ok: false, error: WRONG_CODE_FINAL });
});

test('a device can never pair with itself', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.start();
  const { code } = await device.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Device');
  world.relay.pump();
  world.run(30 * 1000);
  assert.equal((await pairing).ok, false);
  assert.deepEqual(device.keystore.listPeers(), []);
  assert.deepEqual(device.manager.status().devices, []);

  // The laptop side refuses it too, without relying on the other end to have noticed.
  rawHost(world.relay, { code: 'ABCDEF', identity: device.identity() });
  world.relay.pump();
  const second = device.manager.pair('ABCDEF', 'Device');
  world.relay.pump();
  assert.equal((await second).ok, false);
  assert.deepEqual(device.keystore.listPeers(), []);
});

test('a home-side entry stays provisional until the first session completes', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  // Hold every handshake message back.
  world.relay.drop = ({ data }) => data.t === 'session-hello' || data.t === 'session-auth';
  const { answer } = await pairNow(world, home, laptop);
  assert.equal(answer.ok, true);
  world.relay.pump();

  assert.equal(home.keystore.listPeers()[0].provisional, true);
  assert.equal(laptop.keystore.listPeers()[0].provisional, undefined);
  assert.equal(home.entry(laptop.id).connected, false);

  world.relay.drop = () => false;
  world.run(20 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.keystore.listPeers()[0].provisional, undefined);

  // Confirmed, so the 10 minutes no longer applies.
  world.run(20 * MINUTES);
  assert.equal(home.keystore.listPeers().length, 1);
  assert.equal(home.entry(laptop.id).connected, true);
});

test('a provisional entry that never connects is dropped after 10 minutes', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const raw = rawGuest(world.relay, { code });
  world.relay.pump();
  raw.client.send(raw.guest.handle(raw.received[0]).reply);
  world.relay.pump();
  const id = deviceIdFromPublicKey(raw.identity.publicKey);
  assert.equal(home.keystore.listPeers()[0].provisional, true);

  world.run(10 * MINUTES - 1);
  assert.ok(home.entry(id));
  world.run(1);
  assert.equal(home.entry(id), undefined);
  assert.deepEqual(home.keystore.listPeers(), []);
  assert.equal(world.relay.deviceConnects[world.relay.deviceConnects.length - 1].closed, true);
});

test('a provisional entry found at unlock gets its own 10 minutes', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'laptop', provisional: true });
  home.keystore.lock();
  home.start();
  world.run(30 * MINUTES);
  assert.equal((await home.manager.unlock(PIN)).ok, true);
  assert.ok(home.entry('aaaaaaaaaaaaaaaa'));
  world.run(10 * MINUTES);
  assert.equal(home.entry('aaaaaaaaaaaaaaaa'), undefined);
  assert.deepEqual(home.keystore.listPeers(), []);
});

test('pairing again with the same key does not duplicate a provisional entry, and restarts its time', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.start();
  const identity = newIdentity();
  const id = deviceIdFromPublicKey(identity.publicKey);

  async function pairRaw() {
    const { code } = await home.manager.createCode();
    world.relay.pump();
    const raw = rawGuest(world.relay, { code, identity });
    world.relay.pump();
    raw.client.send(raw.guest.handle(raw.received[0]).reply);
    world.relay.pump();
  }

  await pairRaw();
  world.run(9 * MINUTES);
  await pairRaw();
  assert.equal(home.keystore.listPeers().length, 1);
  assert.equal(home.manager.status().devices.length, 1);

  world.run(9 * MINUTES);
  assert.ok(home.entry(id));
  world.run(MINUTES);
  assert.equal(home.entry(id), undefined);
});

test('one install can be home to one device and laptop to another, and frames go only where they are sent', async (t) => {
  const world = newWorld(t);
  const top = await world.device('Top');
  const middle = await world.device('Middle');
  const bottom = await world.device('Bottom');
  const other = await world.device('Other');
  seedPair(top, middle); // Top is home to Middle
  seedPair(middle, bottom); // Middle is home to Bottom
  seedPair(middle, other); // and to Other
  for (const device of [top, middle, bottom, other]) device.start();
  world.relay.pump();

  assert.equal(middle.entry(top.id).role, 'home');
  assert.equal(middle.entry(bottom.id).role, 'laptop');
  for (const id of [top.id, bottom.id, other.id]) assert.equal(middle.entry(id).connected, true);

  middle.manager.send(bottom.id, { to: 'bottom' });
  middle.manager.send(top.id, { to: 'top' });
  bottom.manager.send(middle.id, { from: 'bottom' });
  world.relay.pump();
  assert.deepEqual(bottom.frames, [{ id: middle.id, frame: { to: 'bottom' } }]);
  assert.deepEqual(top.frames, [{ id: middle.id, frame: { to: 'top' } }]);
  assert.deepEqual(other.frames, []);
  assert.deepEqual(middle.frames, [{ id: bottom.id, frame: { from: 'bottom' } }]);

  // Removing one leaves the others as they were.
  middle.manager.removeDevice(bottom.id);
  world.relay.pump();
  assert.equal(middle.entry(other.id).connected, true);
  assert.equal(middle.entry(top.id).connected, true);
  assert.deepEqual(bottom.keystore.listPeers(), []);
  assert.equal(other.keystore.listPeers().length, 1);
});

// ---- Who can talk ----

test('a frame or handshake from an unknown device is dropped, with no answer', async (t) => {
  const { world, home, laptop } = await connected(t);
  const stranger = newIdentity();
  const strangerId = deviceIdFromPublicKey(stranger.publicKey);
  const before = world.relay.log.length;

  const session = createSession({ identity: stranger, peerPublicKey: home.identity().publicKey, role: 'laptop' });
  world.relay.inject(strangerId, home.id, session.hello);
  world.relay.inject(strangerId, home.id, { t: 'link', b: 'AAAA' });
  const { connectionId, nextSeq } = liveLinkState(world, laptop, home);
  world.relay.inject(strangerId, home.id, forgeLink(DATA, connectionId, nextSeq, new Uint8Array(40)));
  world.relay.pump();

  assert.deepEqual(world.relay.log.slice(before).filter((m) => m.to === strangerId), []);
  assert.equal(home.manager.status().devices.length, 1);
  assert.deepEqual(home.frames.map((f) => f.id), [laptop.id]);
  assert.equal(home.entry(laptop.id).connected, true);
});

test('messages of no known kind from a paired device do nothing', async (t) => {
  const { world, home, laptop } = await connected(t);
  for (const data of [null, 7, 'text', [], {}, { t: 'bogus' }, { t: 'link' }, { t: 'link', b: 7 }, { t: 'link', b: 'not base64!' }]) {
    world.relay.inject(laptop.id, home.id, data);
  }
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.deepEqual(home.frames, []);
});

test('someone using a paired id without its key never gets a session', async (t) => {
  const { world, home, laptop } = await connected(t);
  const impostor = newIdentity();
  world.run(1000);
  const before = auths(world.relay, home.id, laptop.id).length;

  const session = createSession({ identity: impostor, peerPublicKey: home.identity().publicKey, role: 'laptop' });
  world.relay.inject(laptop.id, home.id, session.hello);
  world.relay.pump();
  // A hello is unsigned, so it gets an answer. What it can't do is finish: the answer
  // isn't signed for this key, and the impostor's own signature won't check out at home.
  const answer = auths(world.relay, home.id, laptop.id)[before].data;
  const signing = createSession({ identity: impostor, peerPublicKey: home.identity().publicKey, role: 'laptop' });
  const forged = signing.handleHello({ t: 'session-hello', ephemeral: answer.ephemeral });
  assert.equal(forged.reply.t, 'session-auth');
  world.relay.inject(laptop.id, home.id, forged.reply);
  world.relay.pump();

  // The session that was already running never noticed.
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.manager.send(home.id, { still: 'here' }), true);
  world.relay.pump();
  assert.deepEqual(home.frames.map((f) => f.frame), [{ still: 'here' }]);
});

test('removing a device closes it, tells the other end, and the other end removes it too', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(home.manager.removeDevice(laptop.id), { ok: true });

  // At once on this end, before anything has been delivered.
  assert.equal(home.entry(laptop.id), undefined);
  assert.deepEqual(home.keystore.listPeers(), []);
  assert.equal(home.manager.send(laptop.id, { too: 'late' }), false);

  world.relay.pump();
  assert.equal(laptop.entry(home.id), undefined);
  assert.deepEqual(laptop.keystore.listPeers(), []);
  assert.equal(laptop.manager.send(home.id, { too: 'late' }), false);
  assert.deepEqual(laptop.frames, []);

  // Neither end keeps trying.
  const before = world.relay.log.length;
  world.run(5 * MINUTES);
  assert.equal(world.relay.log.length, before);
});

test('removal works from the laptop end too', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.removeDevice(home.id), { ok: true });
  world.relay.pump();
  assert.deepEqual(home.keystore.listPeers(), []);
  assert.deepEqual(home.manager.status().devices, []);
});

test('frames already on their way from a removed device are dropped', async (t) => {
  const { world, home, laptop } = await connected(t);
  // Sent while still paired, and still queued when the removal happens.
  assert.equal(laptop.manager.send(home.id, { in: 'flight' }), true);
  home.manager.removeDevice(laptop.id);
  world.relay.pump();
  assert.deepEqual(home.frames, []);
});

test('a removed device cannot reconnect, whatever it signs', async (t) => {
  const { world, home, laptop } = await connected(t);
  const laptopKeys = laptop.identity();
  const homeKey = home.identity().publicKey;
  home.manager.removeDevice(laptop.id);
  world.relay.pump();

  const before = world.relay.log.length;
  // It holds a genuine key, so its signatures are good. The list is what refuses it.
  const session = createSession({ identity: laptopKeys, peerPublicKey: homeKey, role: 'laptop' });
  world.relay.inject(laptop.id, home.id, session.hello);
  world.relay.pump();
  world.run(MINUTES);
  assert.equal(world.relay.log.length, before);
  assert.deepEqual(home.manager.status().devices, []);
});

test('a removal notice cannot be forged by the relay', async (t) => {
  const { world, home, laptop } = await connected(t);
  for (const data of [{ t: 'removed' }, { t: 'peer-removed' }, { t: 'remove', id: home.id }]) {
    world.relay.inject(home.id, laptop.id, data);
  }
  world.relay.pump();
  assert.equal(laptop.keystore.listPeers().length, 1);
  assert.equal(laptop.entry(home.id).connected, true);
});

test('a device that was away when it was removed keeps its entry, and cannot get back in', async (t) => {
  const { world, home, laptop } = await connected(t);
  world.relay.kill(laptop.id);
  home.manager.removeDevice(laptop.id);
  world.run(40 * 1000);
  // The laptop was never told. It still lists the home PC, but can't get back in.
  assert.equal(laptop.keystore.listPeers().length, 1);
  assert.equal(laptop.entry(home.id).connected, false);
  assert.equal(home.keystore.listPeers().length, 0);
});

test('removing an unknown device is harmless, and while locked it is refused', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(home.manager.removeDevice('nobodynobodynobo'), { ok: true });
  assert.equal(home.manager.status().devices.length, 1);
  home.manager.lock();
  const result = home.manager.removeDevice(laptop.id);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  world.relay.pump();
  assert.equal(laptop.keystore.listPeers().length, 1);
});

test('frames from a device of either role only ever reach the renderer, and none can set the control switch', async (t) => {
  const { world, home, laptop } = await connected(t);
  const attempts = [
    { t: 'setControlAllowed', allowed: true },
    { t: 'set-control-allowed', value: true },
    { setControlAllowed: true },
    { t: 'control-state', allowed: true },
    { method: 'setControlAllowed', args: [true] }
  ];
  for (const frame of attempts) {
    assert.equal(home.manager.send(laptop.id, frame), true);
    assert.equal(laptop.manager.send(home.id, frame), true);
  }
  world.relay.pump();

  assert.deepEqual(home.frames.map((f) => f.frame), attempts);
  assert.deepEqual(laptop.frames.map((f) => f.frame), attempts);
  assert.equal(home.keystore.getControlAllowed(), false);
  assert.equal(laptop.keystore.getControlAllowed(), false);
  assert.equal(laptop.manager.status().controlAllowed, false);
});

test('the manager has no route from a frame to anything but onFrame listeners', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.start();
  assert.deepEqual(Object.keys(device.manager).sort(), [
    'cancelCode', 'createCode', 'lock', 'onFrame', 'onStatus', 'pair', 'refreshStatus', 'removeDevice',
    'send', 'setAddress', 'setControlAllowed', 'setPin', 'shutdown', 'status', 'toolCallRefusal', 'unlock'
  ]);

  // The code that handles what arrives never mentions the switch, and doesn't branch on what
  // a frame says, but for the one test that hands signaling to the direct path.
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote', 'manager.js'), 'utf8');
  const receiving = source.slice(source.indexOf('// ---- Receiving ----'), source.indexOf('// ---- Pairing, home side ----'));
  assert.ok(receiving.includes('notify(frameListeners'));
  assert.ok(!/control/i.test(receiving));
  const signaling = 'if (frame.type === FRAME_RTC) return receiveSignal(conn, frame.data);';
  assert.equal(receiving.split(signaling).length, 2);
  assert.ok(!/frame\.(t|type|method|kind)\b/.test(receiving.replace(signaling, '')));

  // Tool calls are the one kind of frame looked at before the listeners. That section may read the
  // switch, once, and nothing else about a frame can come to matter without this test saying so.
  const admitting = source.slice(source.indexOf('// ---- Tool calls ----'), source.indexOf('// ---- Pairing, home side ----'));
  assert.ok(admitting.includes('function admitFrame'));
  assert.ok(!/setControlAllowed/.test(admitting), 'nothing here can set the switch');
  assert.ok(!/\bpeer(\.\w+)*\s*=[^=]/.test(admitting), 'nothing here can change who a device is');
  assert.equal(admitting.split('getControlAllowed()').length, 2, 'the switch is read in one place');
  assert.deepEqual(
    [...admitting.matchAll(/frame\.type\s*[!=]==\s*\w+/g)].map((m) => m[0]).sort(),
    [
      'frame.type !== FRAME_TOOL_CALL',
      'frame.type === FRAME_RTC',
      'frame.type === FRAME_TOOL_CALL',
      'frame.type === FRAME_TOOL_CANCEL',
      'frame.type === FRAME_TOOL_RESULT',
      'frame.type === FRAME_TOOL_RESULT'
    ],
    'the frame types looked at are exactly these'
  );
  const read = new Set([...admitting.matchAll(/\bframe\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), ['data', 'id', 'type'], 'and only these fields of a frame are read here');
});

test('setControlAllowed is refused unless the caller says it is the local UI', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.start();

  for (const origin of [undefined, {}, { fromLocalUi: false }, { fromLocalUi: 'yes' }, { fromLocalUi: 1 }]) {
    const result = device.manager.setControlAllowed(true, origin);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(device.keystore.getControlAllowed(), false);
  }

  assert.deepEqual(device.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  assert.equal(device.keystore.getControlAllowed(), true);
  assert.equal(device.manager.status().controlAllowed, true);
  assert.equal(device.manager.setControlAllowed('yes', { fromLocalUi: true }).ok, false);
  assert.equal(device.keystore.getControlAllowed(), true);
});

test('while locked the control switch can be turned off but not on', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.start();
  device.manager.lock();
  assert.equal(device.manager.setControlAllowed(true, { fromLocalUi: true }).ok, false);
  assert.equal(device.keystore.getControlAllowed(), false);

  await device.manager.unlock(PIN);
  device.manager.setControlAllowed(true, { fromLocalUi: true });
  device.manager.lock();
  assert.equal(device.manager.status().controlAllowed, true);
  assert.deepEqual(device.manager.setControlAllowed(false, { fromLocalUi: true }), { ok: true });
  assert.equal(device.keystore.getControlAllowed(), false);
});

// ---- Frames ----

test('frames arrive in order, and frames that cannot be serialized are refused', async (t) => {
  const { world, home, laptop } = await connected(t);
  for (let i = 0; i < 50; i++) assert.equal(home.manager.send(laptop.id, { i }), true);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame.i), [...Array(50).keys()]);

  const circular = {};
  circular.self = circular;
  assert.equal(home.manager.send(laptop.id, circular), false);
  assert.equal(home.manager.send(laptop.id, undefined), false);
  assert.equal(home.manager.send(laptop.id, 'not an object'), false);
  assert.equal(home.manager.send('nobodynobodynobo', { a: 1 }), false);
});

test('a 2 MiB frame arrives whole through splitting, in pieces the relay accepts', async (t) => {
  const { world, home, laptop } = await connected(t);
  const big = { text: 'café\u{1F600} '.repeat(Math.ceil((2 * MIB) / 10)), after: true };
  const size = Buffer.byteLength(JSON.stringify(big));
  assert.ok(size >= 2 * MIB);

  assert.equal(home.manager.send(laptop.id, big), true);
  assert.equal(home.manager.send(laptop.id, { next: 1 }), true);
  world.relay.pump();

  assert.equal(laptop.frames.length, 2);
  assert.equal(laptop.frames[0].frame.text, big.text);
  assert.deepEqual(laptop.frames[1].frame, { next: 1 });

  const pieces = linkMessages(world.relay, home.id, laptop.id).filter((m) => fromRelayB64(m.data.b)[0] === DATA);
  assert.ok(pieces.length >= 9, `${pieces.length} pieces`);
  for (const piece of pieces) assert.ok(JSON.stringify(piece.data).length < MIB);
  for (const piece of pieces) assert.ok(fromRelayB64(piece.data.b).length <= 256 * 1024 + 64);
});

test('a frame of exactly the split size and of one byte over both arrive whole', async (t) => {
  const { world, home, laptop } = await connected(t);
  const shell = JSON.stringify({ type: 'sized', s: '' }).length;
  for (const size of [256 * 1024, 256 * 1024 + 1, 512 * 1024]) {
    const frame = { type: 'sized', s: 'x'.repeat(size - shell) };
    assert.equal(home.manager.send(laptop.id, frame), true);
    world.relay.pump();
    assert.deepEqual(laptop.frames.pop().frame, frame);
  }
});

test('a frame too large to send is refused rather than filling the link', async (t) => {
  const { world, home, laptop } = await connected(t);
  const before = world.relay.log.length;
  assert.equal(home.manager.send(laptop.id, { s: 'x'.repeat(49 * MIB) }), false);
  assert.equal(world.relay.log.length, before);
  assert.equal(home.entry(laptop.id).connected, true);
});

test('nothing readable crosses the relay', async (t) => {
  const { world, home, laptop } = await connected(t);
  const marker = 'a-plain-text-marker-in-a-frame';
  home.manager.send(laptop.id, { marker });
  world.run(30 * 1000);
  assert.equal(laptop.frames[0].frame.marker, marker);
  for (const message of world.relay.log) {
    if (message.data.t === 'link') assert.ok(!Buffer.from(message.data.b, 'base64').includes(marker));
    assert.ok(!JSON.stringify(message).includes(marker));
  }
});

test('a listener that throws does not stop other listeners or the stream', async (t) => {
  const { world, home, laptop } = await connected(t);
  const seen = [];
  laptop.manager.onFrame(() => {
    throw new Error('renderer problem');
  });
  const off = laptop.manager.onFrame((id, frame) => seen.push(frame.n));
  home.manager.send(laptop.id, { n: 1 });
  home.manager.send(laptop.id, { n: 2 });
  world.relay.pump();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(laptop.entry(home.id).connected, true);

  off();
  home.manager.send(laptop.id, { n: 3 });
  world.relay.pump();
  assert.deepEqual(seen, [1, 2]);
});

// ---- Staying connected ----

test('reconnecting backs off, capped at 30 seconds', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  world.relay.refuse = true;
  const times = [];
  const realConnect = world.relay.connectDevice;
  world.relay.connectDevice = (opts) => {
    times.push(world.clock.now());
    return realConnect(opts);
  };
  device.start();
  world.run(4 * MINUTES);

  const gaps = times.slice(1).map((time, i) => time - times[i]);
  assert.deepEqual(gaps.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.ok(gaps.every((gap) => gap <= 30000));
});

test('a connection that stays up resets the backoff, and one that flaps does not', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  const times = [];
  const realConnect = world.relay.connectDevice;
  world.relay.connectDevice = (opts) => {
    times.push(world.clock.now());
    return realConnect(opts);
  };
  device.start();

  // Each connection is accepted, then dropped at once.
  function dropNow() {
    world.relay.pump();
    world.relay.kill(device.id);
  }
  dropNow();
  world.clock.advance(1000);
  dropNow();
  world.clock.advance(2000);
  dropNow();
  world.clock.advance(4000);
  assert.deepEqual(times.slice(1).map((time, i) => time - times[i]), [1000, 2000, 4000]);

  // This one stays up long enough to count, so the next retry is quick again.
  world.run(60 * 1000);
  world.relay.kill(device.id);
  const count = times.length;
  world.run(1000);
  assert.equal(times.length, count + 1);
});

test('a relay that never says ready is given up on, and retried', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  const clients = [];
  world.relay.connectDevice = (opts) => {
    const client = { opts, closed: false, send: () => false, close() { client.closed = true; } };
    clients.push(client);
    return client;
  };
  device.start();
  world.run(19 * 1000);
  assert.equal(clients.length, 1);
  world.run(1000);
  assert.equal(clients[0].closed, true);
  world.run(1000);
  assert.equal(clients.length, 2);
});

test('both ends reconnect after a relay outage and frames flow again', async (t) => {
  const { world, home, laptop } = await connected(t);
  world.relay.kill(home.id);
  world.relay.refuse = true;
  assert.equal(home.entry(laptop.id).connected, false);
  assert.equal(home.entry(laptop.id).path, 'offline');

  world.run(10 * 1000);
  world.relay.refuse = false;
  world.run(30 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.entry(laptop.id).path, 'relay');

  home.manager.send(laptop.id, { back: true });
  world.relay.pump();
  assert.deepEqual(laptop.frames.pop().frame, { back: true });
});

test('a short relay outage keeps the session, and what was sent during it still arrives', async (t) => {
  const { world, home, laptop } = await connected(t);
  const hellosBefore = hellos(world.relay, home.id, laptop.id).length;
  world.relay.kill(home.id);
  assert.equal(home.manager.send(laptop.id, { during: 'outage' }), true);
  assert.deepEqual(laptop.frames, []);

  world.run(1000);
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ during: 'outage' }]);
  assert.equal(hellos(world.relay, home.id, laptop.id).length, hellosBefore);
});

test('offline from the relay shows the device as offline until it is heard from again', async (t) => {
  const { world, home, laptop } = await connected(t);
  world.relay.kill(laptop.id);
  world.relay.refuse = true;
  home.manager.send(laptop.id, { to: 'nobody' });
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, false);
  assert.equal(home.entry(laptop.id).path, 'offline');

  world.relay.refuse = false;
  world.run(35 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.entry(laptop.id).path, 'relay');
});

test('a restarted peer gets a new session, and a status change marks it', async (t) => {
  const { world, home, laptop } = await connected(t);
  const old = liveLinkState(world, home, laptop);

  // The laptop restarts: a new manager on the same keys, with nothing of the old session.
  laptop.manager.shutdown();
  laptop.start();
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.entry(laptop.id).connected, true);

  const fresh = liveLinkState(world, home, laptop);
  assert.notDeepEqual(fresh.connectionId, old.connectionId);
  assert.equal(fresh.nextSeq, 1);
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ probe: true }, { probe: true }]);

  // The renderer takes its cue for a new snapshot from this: down, then up.
  const seen = home.statuses.map((status) => status.devices[0]?.connected);
  assert.ok(seen.lastIndexOf(false) > seen.indexOf(true));
  assert.equal(seen[seen.length - 1], true);
});

test('a hello alone does not disturb a running session', async (t) => {
  const { world, home, laptop } = await connected(t);
  const statusesBefore = home.statuses.length;
  const forged = createSession({ identity: newIdentity(), peerPublicKey: home.identity().publicKey, role: 'laptop' });
  world.relay.inject(laptop.id, home.id, forged.hello);
  world.relay.pump();

  assert.equal(home.statuses.length, statusesBefore);
  assert.equal(home.entry(laptop.id).connected, true);
  laptop.manager.send(home.id, { still: 'fine' });
  home.manager.send(laptop.id, { also: 'fine' });
  world.relay.pump();
  assert.deepEqual(home.frames.map((f) => f.frame), [{ still: 'fine' }]);
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ also: 'fine' }]);

  // The attempt it started is abandoned quietly, with no hello of our own.
  const before = hellos(world.relay, home.id, laptop.id).length;
  world.run(25 * 1000);
  assert.equal(hellos(world.relay, home.id, laptop.id).length, before);
});

test('a flood of hellos only does the work of a few answers', async (t) => {
  const { world, home, laptop } = await connected(t);
  const before = auths(world.relay, home.id, laptop.id).length;
  for (let i = 0; i < 200; i++) {
    const session = createSession({ identity: newIdentity(), peerPublicKey: home.identity().publicKey, role: 'laptop' });
    world.relay.inject(laptop.id, home.id, session.hello);
  }
  world.relay.pump();
  assert.ok(auths(world.relay, home.id, laptop.id).length - before <= 2);
  assert.equal(home.entry(laptop.id).connected, true);
});

// ---- Heartbeat ----

test('an encrypted heartbeat goes out every 15 seconds, and is not delivered as a frame', async (t) => {
  const { world, home, laptop } = await connected(t);
  const dataFrames = () =>
    linkMessages(world.relay, home.id, laptop.id).filter((m) => fromRelayB64(m.data.b)[0] === DATA).length;
  assert.equal(dataFrames(), 0);
  world.run(15 * 1000 - 1);
  assert.equal(dataFrames(), 0);
  world.run(1);
  assert.equal(dataFrames(), 1);
  world.run(15 * 1000);
  assert.equal(dataFrames(), 2);
  world.run(5 * MINUTES);
  assert.deepEqual(laptop.frames, []);
  assert.deepEqual(home.frames, []);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
});

test('45 seconds with nothing decrypted ends the connection and starts a new session', async (t) => {
  const { world, home, laptop } = await connected(t);
  const old = liveLinkState(world, home, laptop);
  world.run(15 * 1000);

  // A relay that passes handshakes and swallows the link frames going to the laptop.
  world.relay.drop = ({ to, data }) => to === laptop.id && data.t === 'link';
  const hellosBefore = hellos(world.relay, laptop.id, home.id).length;
  const start = world.clock.now();
  const ended = [];
  laptop.manager.onStatus((status) => {
    if (!status.devices[0]?.connected && !ended.length) ended.push(world.clock.now() - start);
  });

  world.run(45 * 1000 - 1);
  assert.equal(hellos(world.relay, laptop.id, home.id).length, hellosBefore);
  world.run(15 * 1000);
  assert.ok(ended.length === 1);
  assert.ok(ended[0] <= 45 * 1000, `ended after ${ended[0]} ms`);
  assert.equal(hellos(world.relay, laptop.id, home.id).length, hellosBefore + 1);

  // Once the relay behaves again, the new session works, with a new connection id.
  world.relay.drop = () => false;
  world.run(30 * 1000);
  assert.equal(laptop.entry(home.id).connected, true);
  const fresh = liveLinkState(world, home, laptop);
  assert.notDeepEqual(fresh.connectionId, old.connectionId);
  assert.deepEqual(laptop.frames.pop().frame, { probe: true });
});

test('forged link traffic does not count as being heard from', async (t) => {
  const { world, home, laptop } = await connected(t);
  const { connectionId } = liveLinkState(world, home, laptop);
  world.relay.drop = ({ to, data }) => to === laptop.id && data.t === 'link';
  const before = hellos(world.relay, laptop.id, home.id).length;

  // Acks and early frames carrying the right id, every few seconds, all the way through.
  for (let i = 0; i < 30; i++) {
    world.relay.inject(home.id, laptop.id, forgeLink(ACK, connectionId, 0));
    world.relay.inject(home.id, laptop.id, forgeLink(DATA, connectionId, 100 + i, new Uint8Array(40)));
    world.run(2 * 1000);
  }
  assert.equal(hellos(world.relay, laptop.id, home.id).length, before + 1);
});

test('any decrypt failure ends the connection and starts a new session', async (t) => {
  const { world, home, laptop } = await connected(t);
  const { connectionId, nextSeq } = liveLinkState(world, home, laptop);
  const before = hellos(world.relay, laptop.id, home.id).length;

  // The right id, the right sequence number, and bytes that aren't from the session.
  world.relay.inject(home.id, laptop.id, forgeLink(DATA, connectionId, nextSeq, new Uint8Array(64)));
  world.relay.pump();

  assert.equal(hellos(world.relay, laptop.id, home.id).length, before + 1);
  assert.equal(laptop.entry(home.id).connected, true);
  const fresh = liveLinkState(world, home, laptop);
  assert.notDeepEqual(fresh.connectionId, connectionId);
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ probe: true }, { probe: true }]);
  assert.ok(!laptop.frames.some((f) => f.frame.forged));
});

test('a send the link refuses because it is full ends the connection and starts a new session', async (t) => {
  const { world, home, laptop } = await connected(t);
  const old = liveLinkState(world, home, laptop);

  // Nothing is acknowledged, so the send buffer can only fill.
  world.relay.drop = ({ from, data }) => from === home.id && data.t === 'link';
  const before = hellos(world.relay, home.id, laptop.id).length;
  const frame = { s: 'x'.repeat(MIB) };
  let accepted = 0;
  while (home.manager.send(laptop.id, frame) && accepted < 200) accepted++;
  assert.ok(accepted > 30 && accepted < 200, `${accepted} accepted`);

  assert.equal(hellos(world.relay, home.id, laptop.id).length, before + 1);

  world.relay.drop = () => false;
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  const fresh = liveLinkState(world, home, laptop);
  assert.notDeepEqual(fresh.connectionId, old.connectionId);
  assert.deepEqual(laptop.frames.pop().frame, { probe: true });
});

test('a receive-side resync request is advisory: nothing resets, and no frame is produced', async (t) => {
  const { world, home, laptop } = await connected(t);
  const { connectionId, nextSeq } = liveLinkState(world, home, laptop);
  const framesBefore = laptop.frames.length;
  const statusesBefore = laptop.statuses.length;
  const before = hellos(world.relay, laptop.id, home.id).length;
  const sentBefore = linkMessages(world.relay, laptop.id, home.id).filter((m) => fromRelayB64(m.data.b)[0] === DATA).length;

  // Further ahead than the link will hold, which is what makes it ask for a resync.
  world.relay.inject(home.id, laptop.id, forgeLink(DATA, connectionId, nextSeq + 20000, new Uint8Array(40)));
  world.relay.pump();

  assert.equal(laptop.frames.length, framesBefore);
  assert.equal(laptop.statuses.length, statusesBefore);
  assert.equal(hellos(world.relay, laptop.id, home.id).length, before);
  assert.equal(linkMessages(world.relay, laptop.id, home.id).filter((m) => fromRelayB64(m.data.b)[0] === DATA).length, sentBefore);
  assert.equal(laptop.entry(home.id).connected, true);

  // And the stream carries on.
  home.manager.send(laptop.id, { next: true });
  world.relay.pump();
  assert.deepEqual(laptop.frames.pop().frame, { next: true });
});

// ---- Handshakes ----

test('only hello and auth reach the session, so other messages cannot kill a handshake', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);

  // Home's hello goes out, and nothing of the laptop's is running. The other side is played
  // by hand, with the role a laptop has, which also pins the role home takes for itself.
  home.start();
  world.relay.pump();
  const [hello] = hellos(world.relay, home.id, laptop.id);
  const peer = createSession({ identity: laptop.identity(), peerPublicKey: home.identity().publicKey, role: 'laptop' });
  const { reply: auth } = peer.handleHello(hello.data);

  // Each of these would end the session waiting for that auth, if it got that far.
  for (const data of [{ t: 'bogus' }, { t: 'link', b: 'AAAA' }, { t: 'session-other' }, { t: 'session' }]) {
    world.relay.inject(laptop.id, home.id, data);
  }
  world.relay.drop = ({ from, data }) => from === home.id && data.t === 'session-auth';
  world.relay.inject(laptop.id, home.id, auth);
  world.relay.pump();

  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(hellos(world.relay, home.id, laptop.id).length, 1);
});

test('each end signs for its own role, not the role it lists the other device under', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);

  // The laptop listed as 'home' here would mean the laptop's manager signs as a laptop.
  laptop.start();
  world.relay.pump();
  const [hello] = hellos(world.relay, laptop.id, home.id);
  const peer = createSession({ identity: home.identity(), peerPublicKey: laptop.identity().publicKey, role: 'home' });
  const { reply: auth } = peer.handleHello(hello.data);
  world.relay.drop = ({ from, data }) => from === laptop.id && data.t === 'session-auth';
  world.relay.inject(home.id, laptop.id, auth);
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
});

test('a handshake that has not finished after 20 seconds starts again with a new session', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);

  // Hellos get through. The auth that answers them doesn't.
  world.relay.drop = ({ data }) => data.t === 'session-auth';
  home.start();
  laptop.start();
  world.relay.pump();
  // Whichever end's time runs out first says hello again, and the other answers that.
  const sent = () => [...hellos(world.relay, home.id, laptop.id), ...hellos(world.relay, laptop.id, home.id)];
  assert.equal(sent().length, 2);

  world.run(20 * 1000 - 1);
  assert.equal(sent().length, 2);
  world.run(1);
  assert.equal(sent().length, 3);
  assert.equal(new Set(sent().map((m) => m.data.ephemeral)).size, 3);

  world.relay.drop = () => false;
  world.run(20 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
});

test('a lost final auth is recovered by the 20-second restart', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);

  // Home connects first, so only the laptop's hello starts the exchange. The laptop's auth is lost.
  home.start();
  world.relay.pump();
  world.relay.drop = ({ from, data }) => from === laptop.id && data.t === 'session-auth';
  laptop.start();
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.entry(laptop.id).connected, false);

  world.relay.drop = () => false;
  world.run(20 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
  home.manager.send(laptop.id, { n: 1 });
  laptop.manager.send(home.id, { n: 2 });
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ n: 1 }]);
  assert.deepEqual(home.frames.map((f) => f.frame), [{ n: 2 }]);
});

test('after a refused auth the next hello waits, so answers still in flight cannot refuse that one too', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  const answerTo = (hello) =>
    createSession({ identity: laptop.identity(), peerPublicKey: home.identity().publicKey, role: 'laptop' }).handleHello(hello.data).reply;
  world.relay.drop = ({ from, data }) => from === home.id && data.t === 'session-auth';

  // Two hellos out, and answers to both on their way, each a session behind.
  home.start();
  world.relay.pump();
  const first = answerTo(hellos(world.relay, home.id, laptop.id)[0]);
  world.run(20 * 1000);
  const second = answerTo(hellos(world.relay, home.id, laptop.id)[1]);
  assert.equal(hellos(world.relay, home.id, laptop.id).length, 2);

  world.relay.inject(laptop.id, home.id, first);
  world.run(1000);
  world.relay.inject(laptop.id, home.id, second);
  world.run(999);
  assert.equal(hellos(world.relay, home.id, laptop.id).length, 2);

  // Both have landed and been ignored, so the next hello gets a clean answer.
  world.run(1);
  const sent = hellos(world.relay, home.id, laptop.id);
  assert.equal(sent.length, 3);
  world.relay.inject(laptop.id, home.id, answerTo(sent[2]));
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
});

test('a stale auth arriving at a restarted handshake does not chase its own tail', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);

  // A slow relay: each direction holds messages a little, so answers arrive after a restart.
  const delayed = [];
  const send = world.relay.connectDevice;
  world.relay.connectDevice = (opts) => {
    const client = send(opts);
    const realSend = client.send;
    client.send = (to, data) => {
      delayed.push(() => realSend(to, data));
      return true;
    };
    return client;
  };
  home.start();
  laptop.start();
  world.relay.pump();

  let waited = 0;
  while (!(home.entry(laptop.id).connected && laptop.entry(home.id).connected) && waited < 5 * MINUTES) {
    // A 25-second trip is longer than the 20 seconds a handshake gets, at first.
    const trip = waited < 60 * 1000 ? 25 * 1000 : 500;
    world.clock.advance(trip, () => world.relay.pump());
    waited += trip;
    for (const release of delayed.splice(0)) release();
    world.relay.pump();
  }
  assert.ok(home.entry(laptop.id).connected && laptop.entry(home.id).connected, `never connected (${waited} ms)`);
});

// ---- Locking ----

test('while idle-locked, a live connection stays up and works', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  const status = laptop.manager.status();
  assert.equal(status.locked, true);
  assert.equal(status.idleLocked, true);
  assert.equal(status.devices[0].connected, true);
  assert.equal(laptop.keystore.getIdentity(), null);

  home.manager.send(laptop.id, { tool: 'call' });
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ tool: 'call' }]);
  assert.equal(laptop.manager.send(home.id, { tool: 'result' }), true);
  world.relay.pump();
  assert.deepEqual(home.frames.map((f) => f.frame), [{ tool: 'result' }]);

  // Heartbeats carry on, so nothing times out.
  world.run(5 * MINUTES);
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.entry(laptop.id).connected, true);
});

test('while idle-locked, a restarted home PC gets a new session with no PIN entered', async (t) => {
  const { world, home, laptop } = await connected(t);
  const old = liveLinkState(world, home, laptop);
  laptop.manager.lock();

  home.manager.shutdown();
  home.start();
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(laptop.keystore.isUnlocked(), false);
  assert.equal(laptop.manager.status().idleLocked, true);

  const fresh = liveLinkState(world, home, laptop);
  assert.notDeepEqual(fresh.connectionId, old.connectionId);
  assert.deepEqual(laptop.frames.pop().frame, { probe: true });

  // And it still holds well past the old session's timeouts.
  world.run(5 * MINUTES);
  assert.equal(laptop.entry(home.id).connected, true);
});
test('lock with nothing live closes the relay, cancels a code, and aborts a pairing', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  await home.manager.createCode();
  world.relay.pump();
  home.manager.lock();
  assert.equal(home.manager.status().codePending, false);
  assert.equal(world.relay.pairConnects[0].closed, true);

  // A pair in flight when the lock comes.
  world.relay.connectPairing({ role: 'host', onOpen() {}, onNone() {}, onClose() {}, onMessage() {} });
  world.relay.pump();
  const pairing = laptop.manager.pair('ABCDEF', 'Laptop');
  world.relay.pump();
  laptop.manager.lock();
  const answer = await pairing;
  assert.equal(answer.ok, false);
  assert.match(answer.error, /locked/);
});

test('a lock that lands during an unlock wins', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.keystore.lock();
  device.start();
  const unlocking = device.manager.unlock(PIN);
  device.manager.lock();
  const result = await unlocking;
  assert.equal(result.ok, false);
  assert.equal(device.manager.status().locked, true);
  assert.equal(device.keystore.isUnlocked(), false);
  world.run(MINUTES);
  assert.equal(world.relay.deviceConnects.length, 0);
});

test('a client still connecting when the idle lock comes carries on and signs in', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.start();
  assert.equal(world.relay.deviceConnects.length, 1);
  device.manager.lock();
  assert.equal(world.relay.deviceConnects[0].closed, false);
  world.relay.pump();
  assert.equal(hellos(world.relay, device.id, 'aaaaaaaaaaaaaaaa').length, 1);
});
test('a reconnect still signing in when the idle lock comes finishes, and the session resumes', async (t) => {
  const { world, home, laptop } = await connected(t);
  world.relay.kill(laptop.id);
  world.clock.advance(1000); // the retry has started, and nothing has been delivered to it
  const client = world.relay.deviceConnects[world.relay.deviceConnects.length - 1];
  assert.equal(client.deviceId, laptop.id);
  assert.equal(client.closed, false);

  laptop.manager.lock();
  assert.equal(client.closed, false);
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
  home.manager.send(laptop.id, { back: true });
  world.relay.pump();
  assert.deepEqual(laptop.frames.pop().frame, { back: true });
});
test('a relay drop while idle-locked reconnects by itself, with backoff', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  const count = world.relay.deviceConnects.length;
  world.relay.kill(laptop.id);
  assert.equal(laptop.entry(home.id).connected, false);

  // Long enough that the session is gone too, so this needs a new one.
  world.relay.refuse = true;
  world.run(60 * 1000);
  assert.ok(world.relay.deviceConnects.length > count + 1);
  world.relay.refuse = false;
  world.run(30 * 1000);

  assert.equal(laptop.manager.status().locked, true);
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.entry(laptop.id).connected, true);
  home.manager.send(laptop.id, { back: true });
  laptop.manager.send(home.id, { back: true });
  world.relay.pump();
  assert.deepEqual(laptop.frames.pop().frame, { back: true });
  assert.deepEqual(home.frames.pop().frame, { back: true });
});

test('after a restart with no PIN entered, no connection starts, even if it was idle-locked before', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  world.relay.pump();
  const sent = auths(world.relay, laptop.id, home.id).length;

  laptop.restart();
  home.manager.shutdown();
  home.start();
  world.run(5 * MINUTES);

  const status = laptop.manager.status();
  assert.equal(status.locked, true);
  assert.equal(status.idleLocked, false);
  assert.deepEqual(status.devices, []);
  assert.equal(world.relay.deviceConnects.filter((client) => client.deviceId === laptop.id).length, 1);
  assert.equal(auths(world.relay, laptop.id, home.id).length, sent);
  assert.equal(home.entry(laptop.id).connected, false);

  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
  world.run(25 * 1000);
  assert.equal(laptop.entry(home.id).connected, true);
});

test('lock() on a device locked at start grants nothing', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'home' });
  device.keystore.lock();
  device.start();
  device.manager.lock();
  world.run(5 * MINUTES);
  assert.equal(device.manager.status().idleLocked, false);
  assert.equal(world.relay.deviceConnects.length, 0);
});

test('while idle-locked, any end of a session brings a new one, with no PIN', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();

  // A decrypt failure.
  const first = liveLinkState(world, home, laptop);
  world.relay.inject(home.id, laptop.id, forgeLink(DATA, first.connectionId, first.nextSeq, new Uint8Array(64)));
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
  const second = liveLinkState(world, home, laptop);
  assert.notDeepEqual(second.connectionId, first.connectionId);

  // 45 seconds of silence.
  world.relay.drop = ({ to, data }) => to === laptop.id && data.t === 'link';
  world.run(45 * 1000);
  world.relay.drop = () => false;
  world.run(30 * 1000);
  assert.equal(laptop.entry(home.id).connected, true);
  const third = liveLinkState(world, home, laptop);
  assert.notDeepEqual(third.connectionId, second.connectionId);
  assert.equal(laptop.keystore.isUnlocked(), false);
});

test('while idle-locked, a stranger still gets nothing', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  const stranger = newIdentity();
  const strangerId = deviceIdFromPublicKey(stranger.publicKey);
  const session = createSession({ identity: stranger, peerPublicKey: newIdentity().publicKey, role: 'home' });
  world.relay.inject(strangerId, laptop.id, session.hello);
  world.relay.pump();
  assert.deepEqual(world.relay.log.filter((m) => m.to === strangerId), []);
  assert.equal(laptop.manager.status().devices.length, 1);
});

test('while idle-locked, what a person does stays refused, except turning control off', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.setControlAllowed(true, { fromLocalUi: true });
  laptop.manager.setControlAllowed(false, { fromLocalUi: true });
  laptop.manager.lock();
  const contacts = world.relay.pairConnects.length;

  assert.ok((await laptop.manager.createCode()).error);
  assert.equal((await laptop.manager.pair('ABCDEF', 'Laptop', PIN)).ok, false);
  assert.equal(laptop.manager.removeDevice(home.id).ok, false);
  assert.equal(laptop.manager.setAddress('wss://other.example/abc').ok, false);
  assert.equal(laptop.manager.setControlAllowed(true, { fromLocalUi: true }).ok, false);
  assert.equal(world.relay.pairConnects.length, contacts);
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(laptop.address, ADDRESS);
  assert.equal(laptop.keystore.getControlAllowed(), false);

  await laptop.manager.unlock(PIN);
  laptop.manager.setControlAllowed(true, { fromLocalUi: true });
  laptop.manager.lock();
  assert.deepEqual(laptop.manager.setControlAllowed(false, { fromLocalUi: true }), { ok: true });
  assert.equal(laptop.keystore.getControlAllowed(), false);
});

test('unlock ends the idle lock and leaves running connections alone', async (t) => {
  const { world, home, laptop } = await connected(t);
  const before = liveLinkState(world, home, laptop);
  laptop.manager.lock();
  const hellosBefore = hellos(world.relay, laptop.id, home.id).length;

  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
  world.relay.pump();
  const status = laptop.manager.status();
  assert.equal(status.locked, false);
  assert.equal(status.idleLocked, false);
  assert.equal(hellos(world.relay, laptop.id, home.id).length, hellosBefore);
  const after = liveLinkState(world, home, laptop);
  assert.deepEqual(after.connectionId, before.connectionId);
  assert.ok((await laptop.manager.createCode()).code);
});

test('a second unlock queued behind the first changes nothing', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  home.start();
  world.relay.pump();
  laptop.keystore.lock();
  laptop.start();

  // Locked at start: one relay connection and one hello, however many unlocks land.
  const results = await Promise.all([laptop.manager.unlock(PIN), laptop.manager.unlock(PIN), laptop.manager.unlock('000000')]);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true]);
  assert.equal(world.relay.deviceConnects.filter((client) => client.deviceId === laptop.id).length, 1);
  world.relay.pump();
  assert.equal(hellos(world.relay, laptop.id, home.id).length, 1);
  assert.equal(laptop.entry(home.id).connected, true);

  // Idle-locked with a live session: the session isn't touched.
  const before = liveLinkState(world, home, laptop);
  const timers = world.clock.pendingTimers();
  laptop.manager.lock();
  await Promise.all([laptop.manager.unlock(PIN), laptop.manager.unlock(PIN)]);
  world.relay.pump();
  assert.equal(world.clock.pendingTimers(), timers);
  assert.equal(hellos(world.relay, laptop.id, home.id).length, 1);
  assert.deepEqual(liveLinkState(world, home, laptop).connectionId, before.connectionId);
  assert.equal(laptop.manager.status().devices.length, 1);
});

test('a provisional peer that goes live during an idle lock is confirmed at unlock', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  const { provisional: _none, ...entry } = home.keystore.listPeers()[0];
  home.keystore.addPeer({ ...entry, provisional: true });

  world.relay.drop = ({ data }) => data.t === 'session-hello' || data.t === 'session-auth';
  home.start();
  laptop.start();
  world.relay.pump();
  home.manager.lock();

  world.relay.drop = () => false;
  world.run(25 * 1000);
  assert.equal(home.entry(laptop.id).connected, true);

  // Past its 10 minutes, and nothing has ended it, since it proved itself.
  world.run(15 * MINUTES);
  assert.equal(home.entry(laptop.id).connected, true);

  assert.equal((await home.manager.unlock(PIN)).ok, true);
  assert.equal(home.keystore.listPeers()[0].provisional, undefined);
  world.run(15 * MINUTES);
  assert.equal(home.keystore.listPeers().length, 1);
  assert.equal(home.entry(laptop.id).connected, true);

  // And it's on disk, so a restart agrees.
  home.restart();
  assert.equal((await home.manager.unlock(PIN)).ok, true);
  assert.equal(home.keystore.listPeers()[0].provisional, undefined);
});

test('a provisional peer that never connects during an idle lock goes at 10 minutes, and is written at unlock', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  home.keystore.addPeer({ deviceId: 'aaaaaaaaaaaaaaaa', publicKey: newIdentity().publicKey, name: 'Other', role: 'laptop', provisional: true });
  home.start();
  world.relay.pump();
  home.manager.lock();

  world.run(10 * MINUTES);
  assert.equal(home.entry('aaaaaaaaaaaaaaaa'), undefined);
  assert.equal(world.relay.deviceConnects[0].closed, true);

  assert.equal((await home.manager.unlock(PIN)).ok, true);
  assert.deepEqual(home.keystore.listPeers(), []);
  assert.deepEqual(home.manager.status().devices, []);
});

test('shutdown during an idle lock leaves nothing behind', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  laptop.manager.shutdown();
  home.manager.shutdown();
  world.run(5 * MINUTES);
  assert.equal(world.clock.pendingTimers(), 0);
  assert.ok(world.relay.deviceConnects.every((client) => client.closed));
});
test('being removed while locked ends the connection at once, and is saved at unlock', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  home.manager.removeDevice(laptop.id);
  world.relay.pump();
  assert.deepEqual(laptop.manager.status().devices, []);

  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
  world.relay.pump();
  assert.deepEqual(laptop.keystore.listPeers(), []);
  assert.deepEqual(laptop.manager.status().devices, []);
});

test('ten wrong PINs delete the keys and end every connection', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  let result;
  for (let i = 0; i < 10; i++) {
    // The keystore's delays run on its own clock, so jump it past each wait.
    world.keystoreOffset += 10 * MINUTES;
    result = await laptop.manager.unlock('000000');
  }
  assert.equal(result.wiped, true);
  assert.deepEqual(laptop.manager.status().devices, []);
  assert.equal(laptop.manager.status().hasPin, false);
  assert.equal(laptop.manager.status().idleLocked, false);
  assert.equal(laptop.manager.send(home.id, { a: 1 }), false);
  world.relay.pump();
  assert.equal(world.relay.deviceConnects[1].closed, true);
  const count = world.relay.deviceConnects.length;
  world.run(5 * MINUTES);
  assert.equal(world.relay.deviceConnects.length, count);
  assert.deepEqual(laptop.manager.status().devices, []);
});

test('unlock when already unlocked does not spend an attempt', async (t) => {
  const { laptop } = await connected(t);
  assert.deepEqual(await laptop.manager.unlock('000000'), { ok: true });
  laptop.manager.lock();
  assert.deepEqual(await laptop.manager.unlock(PIN), { ok: true });
});

test('changing the address while locked is refused', async (t) => {
  const { world, laptop } = await connected(t);
  laptop.manager.lock();
  assert.equal(laptop.manager.setAddress('wss://other.example/abc').ok, false);
  assert.equal(laptop.address, ADDRESS);
  world.relay.pump();
});

test('changing the address moves every connection to the new relay', async (t) => {
  const { world, home, laptop } = await connected(t);
  const oldClient = world.relay.deviceConnects.find((client) => client.deviceId === home.id && !client.closed);
  assert.deepEqual(home.manager.setAddress('wss://other.example/abc'), { ok: true });
  assert.equal(oldClient.closed, true);
  world.relay.pump();
  const newClient = world.relay.deviceConnects[world.relay.deviceConnects.length - 1];
  assert.equal(newClient.opts.address, 'wss://other.example/abc');
  world.run(1000);
  assert.equal(home.entry(laptop.id).connected, true);

  assert.deepEqual(home.manager.setAddress(''), { ok: true });
  assert.equal(newClient.closed, true);
  assert.equal(home.entry(laptop.id).connected, false);
});

test('shutdown closes everything and leaves no timers behind', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  home.start();
  laptop.start();
  world.relay.pump();
  await home.manager.createCode();
  world.relay.pump();
  laptop.manager.shutdown();
  home.manager.shutdown();
  world.relay.pump();
  assert.equal(world.clock.pendingTimers(), 0);
  assert.ok(world.relay.deviceConnects.every((client) => client.closed));
  assert.ok(world.relay.pairConnects.every((client) => client.closed));
});

// ---- A device with nobody there to type a PIN ----

test('the first code on a device with no PIN makes a sealed secret, and it shows nowhere', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  assert.equal(home.autoUnlock.store.bytes, null);

  const created = await home.manager.createCode();
  assert.match(created.code, /^[2-9A-Z]{6}$/);
  const sealed = home.autoUnlock.store.bytes;
  assert.ok(sealed);
  assert.equal(sealed.subarray(0, 7).toString(), 'sealed:');
  const secret = Buffer.from(sealed.subarray(7)).reverse().toString();
  assert.match(secret, /^[0-9]{40}$/);
  assert.equal(home.keystore.hasPin(), true);

  const status = home.manager.status();
  assert.equal(status.hasPin, false);
  assert.equal(status.needsPin, false);
  assert.equal(status.locked, false);
  assert.equal(status.idleLocked, false);
  for (const seen of [status, ...home.statuses]) assert.ok(!JSON.stringify(seen).includes(secret));

  // A second code doesn't make a second secret.
  await home.manager.createCode();
  assert.equal(home.autoUnlock.store.writes, 1);
  assert.deepEqual(home.autoUnlock.store.bytes, sealed);
});

test('secrets differ from one device to the next', async (t) => {
  const world = newWorld(t);
  const one = await world.device('One', { pin: false });
  const two = await world.device('Two', { pin: false });
  one.start();
  two.start();
  await one.manager.createCode();
  await two.manager.createCode();
  assert.notDeepEqual(one.autoUnlock.store.bytes, two.autoUnlock.store.bytes);
});

test('no address means no secret', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false, address: null });
  home.start();
  assert.ok((await home.manager.createCode()).error);
  assert.equal(home.autoUnlock.store.writes, 0);
  assert.equal(home.keystore.hasPin(), false);
});

test('a new manager on the same files unlocks itself and reconnects, with no PIN', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { answer } = await pairNow(world, home, laptop);
  assert.equal(answer.ok, true);
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.manager.status().hasPin, false);

  home.restart();
  assert.equal(home.manager.status().locked, true);
  assert.equal(home.manager.status().hasPin, false);
  await until('the home PC to unlock itself', () => !home.manager.status().locked);
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(answer.device.id).connected, true);
  assert.equal(home.autoUnlock.store.writes, 1);

  home.manager.send(laptop.id, { back: true });
  world.relay.pump();
  assert.deepEqual(laptop.frames.pop().frame, { back: true });
});

test('a device on a secret never idle-locks', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  await home.manager.createCode();
  home.manager.lock();
  const status = home.manager.status();
  assert.equal(status.locked, false);
  assert.equal(status.idleLocked, false);
  assert.equal(status.codePending, true);
  assert.equal(home.keystore.isUnlocked(), true);
});

test('pair with a PIN replaces the secret, the file goes, and the device follows the laptop rules', async (t) => {
  const world = newWorld(t);
  const realHome = await world.device('Real home');
  const device = await world.device('Both', { pin: false });
  const laptop = await world.device('Its laptop');
  realHome.start();
  device.start();
  laptop.start();

  // It serves a laptop first, on its secret.
  const served = await pairNow(world, device, laptop);
  assert.equal(served.answer.ok, true);
  world.relay.pump();
  assert.ok(device.autoUnlock.store.bytes);

  const { code } = await realHome.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Both', '424242');
  world.relay.pump();
  const answer = await pairing;
  assert.equal(answer.ok, true, answer.error);
  assert.equal(answer.device.role, 'home');
  assert.equal(device.autoUnlock.store.bytes, null);

  const status = device.manager.status();
  assert.equal(status.hasPin, true);
  assert.equal(status.needsPin, false);
  world.relay.pump();
  assert.equal(device.entry(laptop.id).connected, true);
  assert.equal(device.entry(laptop.id).role, 'laptop');
  assert.equal(device.entry(realHome.id).role, 'home');

  // Now it idle-locks.
  device.manager.lock();
  assert.equal(device.manager.status().idleLocked, true);
  assert.equal(device.entry(laptop.id).connected, true);

  // And it wants the PIN at start, with no connection until then.
  const connects = world.relay.deviceConnects.length;
  device.restart();
  world.run(MINUTES);
  assert.equal(device.manager.status().locked, true);
  assert.equal(device.manager.status().hasPin, true);
  assert.equal(world.relay.deviceConnects.length, connects);
  assert.equal((await device.manager.unlock('424242')).ok, true);
  world.run(25 * 1000);
  assert.equal(device.entry(laptop.id).connected, true);
});

test('a first pairing with a home PC with no PIN is refused without contacting anyone, and status says why', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  await home.manager.createCode();
  home.manager.cancelCode();
  const contacts = world.relay.pairConnects.length;

  for (const pin of [undefined, null, '']) {
    const answer = await home.manager.pair('ABCDEF', 'Home', pin);
    assert.equal(answer.ok, false);
    assert.match(answer.error, /PIN/);
  }
  assert.equal(world.relay.pairConnects.length, contacts);
  assert.equal(home.manager.status().needsPin, true);
  assert.equal(home.manager.status().hasPin, false);
  assert.ok(home.autoUnlock.store.bytes);

  // Setting it directly clears that too, and the secret with it.
  assert.equal((await home.manager.setPin('424242')).ok, true);
  const status = home.manager.status();
  assert.equal(status.needsPin, false);
  assert.equal(status.hasPin, true);
  assert.equal(home.autoUnlock.store.bytes, null);
});

test('a request for a PIN lapses if nobody follows it up, and the next pair settles it', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  await home.manager.createCode();
  home.manager.cancelCode();
  rawHost(world.relay, { code: 'ABCDEF' });
  world.relay.pump();

  assert.equal((await home.manager.pair('ABCDEF', 'Home')).ok, false);
  assert.equal(home.manager.status().needsPin, true);
  world.run(10 * MINUTES - 1);
  assert.equal(home.manager.status().needsPin, true);
  world.run(1);
  assert.equal(home.manager.status().needsPin, false);
  assert.equal(home.statuses[home.statuses.length - 1].needsPin, false);

  // Asked again, then a pair with a PIN that fails on the code.
  assert.equal((await home.manager.pair('ABCDEF', 'Home')).ok, false);
  assert.equal(home.manager.status().needsPin, true);
  const pairing = home.manager.pair('ZZZZZZ', 'Home', '424242');
  world.relay.pump();
  assert.equal((await pairing).ok, false);
  assert.equal(home.manager.status().needsPin, false);
  assert.equal(home.manager.status().hasPin, false);

  // A PIN in the wrong format is still a person being asked.
  assert.equal((await home.manager.pair('ABCDEG', 'Home')).ok, false);
  assert.equal((await home.manager.pair('ABCDEG', 'Home', '123')).ok, false);
  assert.equal(home.manager.status().needsPin, true);
});

test("a bad PIN to pair leaves everything as it was", async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const sealed = device.autoUnlock.store.bytes;
  const contacts = world.relay.pairConnects.length;

  const answer = await device.manager.pair('ABCDEF', 'Device', '123');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /PIN/);
  assert.equal(world.relay.pairConnects.length, contacts);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
  assert.equal(device.manager.status().hasPin, false);
  assert.equal(device.manager.status().locked, false);

  // Still the same secret that opens it.
  device.restart();
  await until('it to unlock itself', () => !device.manager.status().locked);
  assert.equal(device.manager.status().hasPin, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
});

test('a brand new device pairing with a PIN ends up with that PIN and no secret file', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop', { pin: false });
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop', PIN);
  await until('its identity to exist', () => laptop.keystore.hasPin());
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  assert.equal(laptop.autoUnlock.store.bytes, null);
  assert.equal(laptop.manager.status().hasPin, true);
  assert.equal(laptop.manager.status().locked, false);

  laptop.manager.lock();
  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
});
test('pair on a device that already has a PIN ignores the argument', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop', '999999');
  world.relay.pump();
  assert.equal((await pairing).ok, true);

  laptop.manager.lock();
  assert.equal((await laptop.manager.unlock('999999')).ok, false);
  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
});

test('with no secure storage, nothing is written and status says so', async (t) => {
  const world = newWorld(t);
  const keystore = createKeystore({
    file: world.newFile(),
    protect: (bytes) => bytes,
    unprotect: (bytes) => bytes,
    kdfCost: FAST,
    isProtectionAvailable: () => false
  });
  const home = await world.device('Home', { pin: false, keystore });
  home.start();

  assert.ok((await home.manager.createCode()).error);
  assert.equal((await home.manager.pair('ABCDEF', 'Home', PIN)).ok, false);
  assert.equal(home.autoUnlock.store.writes, 0);
  assert.equal(home.manager.status().storageAvailable, false);
  assert.equal(world.relay.pairConnects.length, 0);
});

test('a protect that fails writes nothing and sets no PIN', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.autoUnlock.store.failProtect = true;
  home.start();
  assert.ok((await home.manager.createCode()).error);
  assert.equal(home.autoUnlock.store.bytes, null);
  assert.equal(home.keystore.hasPin(), false);
  assert.equal(world.relay.pairConnects.length, 0);
});

test('a keystore that refuses the secret leaves no file behind', async (t) => {
  const world = newWorld(t);
  const real = world.keystore();
  const refusing = { ...real, setPin: async () => ({ ok: false, error: 'Could not save the PIN.' }) };
  const home = await world.device('Home', { pin: false, keystore: refusing });
  home.start();
  assert.equal((await home.manager.createCode()).error, 'Could not save the PIN.');
  assert.equal(home.autoUnlock.store.writes, 1);
  assert.equal(home.autoUnlock.store.bytes, null);
  assert.equal(home.manager.status().hasPin, false);
  assert.equal(world.relay.pairConnects.length, 0);
});

test('secure storage that turns up late gets the device going', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  let available = true;
  const make = () =>
    createKeystore({
      file,
      protect: (bytes) => bytes,
      unprotect: (bytes) => bytes,
      kdfCost: FAST,
      isProtectionAvailable: () => available
    });
  const home = await world.device('Home', { pin: false, keystore: make() });
  home.start();
  await home.manager.createCode();
  const sealed = home.autoUnlock.store.bytes;
  home.manager.shutdown();

  available = false;
  home.keystore = make();
  const device = await world.device('Home again', { pin: false, keystore: home.keystore });
  device.autoUnlock.store.bytes = sealed;
  device.start();
  assert.equal(device.manager.status().storageAvailable, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);

  available = true;
  assert.equal(device.manager.status().storageAvailable, true);
  await until('it to unlock itself', () => !device.manager.status().locked);
  assert.equal(device.manager.status().hasPin, false);
});

test('a crash before the secret was sealed under leaves a file that the next start clears', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.autoUnlock.store.bytes = Buffer.from('sealed:leftover');
  home.start();
  await tick();
  assert.equal(home.autoUnlock.store.bytes, null);
  assert.equal(home.manager.status().keysReset, false);
  assert.equal(home.manager.status().hasPin, false);
  assert.ok((await home.manager.createCode()).code);
  assert.ok(home.autoUnlock.store.bytes);
});

test('a crash just after a real PIN leaves a file that is removed without a guess', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.lock();
  device.autoUnlock.store.bytes = Buffer.concat([Buffer.from('sealed:'), Buffer.from('0'.repeat(40))]);
  const calls = [];
  const realUnlock = device.keystore.unlock;
  device.keystore.unlock = (...args) => {
    calls.push(args);
    return realUnlock(...args);
  };
  device.start();
  await until('the leftover file to go', () => device.autoUnlock.store.bytes === null);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(failedOnDisk(device.file), 0);
  assert.equal(device.manager.status().keysReset, false);
  assert.equal(device.manager.status().hasPin, true);
  assert.equal(device.manager.status().locked, true);
  assert.equal((await device.manager.unlock(PIN)).ok, true);
  assert.equal(device.manager.status().locked, false);
});

test('a secret file the system cannot open, with protection available, means damage: start unpaired and say so once', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  assert.equal((await pairNow(world, home, laptop)).answer.ok, true);
  world.relay.pump();
  const oldId = deviceIdFromPublicKey(home.keystore.getIdentity().publicKey);

  home.autoUnlock.store.failUnprotect = true;
  home.restart();
  await tick();

  // The file is gone, and the keystore's is set aside the way a corrupt one is.
  assert.equal(home.autoUnlock.store.bytes, null);
  assert.equal(fs.existsSync(home.file), false);
  const asideDir = path.dirname(home.file);
  assert.equal(fs.readdirSync(asideDir).filter((name) => name.startsWith(`${path.basename(home.file)}.unreadable.`)).length, 1);

  const first = home.manager.status();
  assert.equal(first.keysReset, true);
  assert.equal(first.locked, true);
  assert.equal(first.hasPin, false);
  assert.equal(first.needsPin, false);
  assert.equal(first.storageAvailable, true);
  assert.deepEqual(first.devices, []);
  assert.equal(home.manager.status().keysReset, false);

  // Not stuck: it works as a new device, with a new identity and nobody paired.
  assert.equal((await home.manager.unlock(PIN)).error, 'No PIN has been set.');
  home.autoUnlock.store.failUnprotect = false;
  assert.ok((await home.manager.createCode()).code);
  assert.notEqual(deviceIdFromPublicKey(home.keystore.getIdentity().publicKey), oldId);
  assert.deepEqual(home.keystore.listPeers(), []);
  assert.equal(home.manager.status().locked, false);
  assert.equal(home.manager.status().keysReset, false);
});

test('keysReset waits for status(), however many status events go out first', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  await home.manager.createCode();
  home.manager.cancelCode();

  home.autoUnlock.store.failUnprotect = true;
  home.statuses.length = 0;
  home.restart();
  await tick();
  home.autoUnlock.store.failUnprotect = false;
  await home.manager.createCode();
  home.manager.cancelCode();

  assert.ok(home.statuses.length > 0);
  assert.ok(home.statuses.every((status) => status.keysReset === true));
  assert.equal(home.manager.status().keysReset, true);
  assert.equal(home.manager.status().keysReset, false);
});

test('a device that never had a damaged file never says keysReset', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  assert.equal(home.manager.status().keysReset, false);
  await home.manager.createCode();
  assert.equal(home.manager.status().keysReset, false);
  home.restart();
  await until('it to unlock itself', () => !home.manager.status().locked);
  assert.equal(home.manager.status().keysReset, false);
});

test('with protection unavailable, a secret file stays and nothing resets', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  let available = true;
  const make = () =>
    createKeystore({ file, protect: (bytes) => bytes, unprotect: (bytes) => bytes, kdfCost: FAST, isProtectionAvailable: () => available });
  const first = await world.device('First', { pin: false, keystore: make() });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();
  const sealed = first.autoUnlock.store.bytes;

  available = false;
  const device = await world.device('Device', { pin: false, keystore: make() });
  device.autoUnlock.store.bytes = sealed;
  device.autoUnlock.store.failUnprotect = true;
  device.start();
  const status = device.manager.status();
  assert.equal(status.storageAvailable, false);
  assert.equal(status.keysReset, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
  assert.equal(fs.existsSync(file), true);

  // Back again and readable: nothing was lost.
  available = true;
  device.autoUnlock.store.failUnprotect = false;
  assert.equal(device.manager.status().storageAvailable, true);
  await until('it to unlock itself', () => !device.manager.status().locked);
  assert.equal(device.manager.status().keysReset, false);
});

test('protection going away at the moment of the failure is not taken for damage', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  let available = true;
  const make = () =>
    createKeystore({ file, protect: (bytes) => bytes, unprotect: (bytes) => bytes, kdfCost: FAST, isProtectionAvailable: () => available });
  const first = await world.device('First', { pin: false, keystore: make() });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();
  const sealed = first.autoUnlock.store.bytes;

  const device = await world.device('Device', { pin: false, keystore: make() });
  device.autoUnlock.store.bytes = sealed;
  const realUnprotect = device.autoUnlock.unprotect;
  device.autoUnlock.unprotect = () => {
    available = false;
    throw new Error('no secure storage');
  };
  device.start();
  await tick();
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
  assert.equal(fs.existsSync(file), true);
  assert.equal(device.manager.status().keysReset, false);
  assert.equal(device.manager.status().storageAvailable, false);

  available = true;
  device.autoUnlock.unprotect = realUnprotect;
  assert.equal(device.manager.status().storageAvailable, true);
  await until('it to unlock itself', () => !device.manager.status().locked);
});

test('a self-unlock the keystore could not finish tries again, and guesses never reach it', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  const first = await world.device('First', { pin: false, file });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();

  const real = world.keystore(file);
  const calls = [];
  const flaky = {
    ...real,
    unlock(pin, options) {
      calls.push(pin);
      return calls.length === 1 ? Promise.resolve({ ok: false, error: 'Could not record the attempt.' }) : real.unlock(pin, options);
    }
  };
  const device = await world.device('Device', { pin: false, keystore: flaky });
  device.autoUnlock.store.bytes = first.autoUnlock.store.bytes;
  device.start();
  await until('the first try', () => calls.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(device.manager.status().locked, true);
  assert.ok(device.autoUnlock.store.bytes);

  assert.equal((await device.manager.unlock('000000')).ok, false);
  assert.equal(calls.length, 1);

  world.run(5000);
  await until('the second try', () => calls.length === 2);
  await until('it to unlock itself', () => !device.manager.status().locked);
  assert.equal(device.manager.status().hasPin, false);
});

test('shutdown cancels a self-unlock waiting to try again', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  const first = await world.device('First', { pin: false, file });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();

  let calls = 0;
  const real = world.keystore(file);
  const failing = {
    ...real,
    unlock() {
      calls += 1;
      return Promise.resolve({ ok: false, error: 'Could not record the attempt.' });
    }
  };
  const device = await world.device('Device', { pin: false, keystore: failing });
  device.autoUnlock.store.bytes = first.autoUnlock.store.bytes;
  device.start();
  await until('the first try', () => calls === 1);
  await new Promise((resolve) => setImmediate(resolve));
  device.manager.shutdown();
  world.run(MINUTES);
  assert.equal(calls, 1);
  assert.equal(world.clock.pendingTimers(), 0);
});

test('a wrong code leaves the secret in place and the device self-unlocking, with the PIN unused', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const sealed = device.autoUnlock.store.bytes;
  rawHost(world.relay, { code: 'ABCDEF' });
  world.relay.pump();

  const pairing = device.manager.pair('ZZZZZZ', 'Device', '424242');
  world.relay.pump();
  assert.deepEqual(await pairing, { ok: false, error: WRONG_CODE_RETRY });

  const status = device.manager.status();
  assert.equal(status.hasPin, false);
  assert.equal(status.needsPin, false);
  assert.equal(status.locked, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
  device.manager.lock();
  assert.equal(device.manager.status().idleLocked, false);

  device.restart();
  await until('it to unlock itself', () => !device.manager.status().locked);
  assert.equal(device.manager.status().hasPin, false);
});

test('a home PC that goes silent, or no code waiting, also leaves the secret in place', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  world.relay.pump();
  const sealed = device.autoUnlock.store.bytes;

  const none = device.manager.pair('ABCDEF', 'Device', '424242');
  world.relay.pump();
  assert.equal((await none).ok, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);

  world.relay.connectPairing({ role: 'host', onOpen() {}, onNone() {}, onClose() {}, onMessage() {} });
  world.relay.pump();
  const silent = device.manager.pair('ABCDEG', 'Device', '424242');
  world.relay.pump();
  world.run(30 * 1000);
  assert.equal((await silent).ok, false);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);
  assert.equal(device.manager.status().hasPin, false);
});

test('a brand new device that types a wrong code keeps no PIN, and can serve as a home PC after all', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  rawHost(world.relay, { code: 'ABCDEF' });
  world.relay.pump();

  const pairing = device.manager.pair('ZZZZZZ', 'Device', '424242');
  await until('its identity to exist', () => device.keystore.hasPin());
  world.relay.pump();
  assert.deepEqual(await pairing, { ok: false, error: WRONG_CODE_RETRY });
  assert.equal(device.manager.status().hasPin, false);
  assert.ok(device.autoUnlock.store.bytes);
  assert.equal(device.manager.status().locked, false);
  device.restart();
  await until('it to unlock itself', () => !device.manager.status().locked);
});

test('a PIN in the wrong format is refused up front, before anyone is contacted', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const contacts = world.relay.pairConnects.length;
  for (const pin of ['123', 'abcdef', '12345', 123456]) {
    const answer = await device.manager.pair('ABCDEF', 'Device', pin);
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'The PIN must be at least 6 digits.');
  }
  assert.equal(world.relay.pairConnects.length, contacts);

  // And a brand new device doesn't make a secret for one.
  const fresh = await world.device('Fresh', { pin: false });
  fresh.start();
  assert.equal((await fresh.manager.pair('ABCDEF', 'Fresh', '123')).ok, false);
  assert.equal(fresh.autoUnlock.store.writes, 0);
  assert.equal(fresh.keystore.hasPin(), false);
});

test('a PIN that cannot be set after pairing keeps the pairing, says so, and can be set again', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const real = world.keystore();
  let refuse = false;
  const keystore = {
    ...real,
    setPin: (pin, options) => (refuse ? Promise.resolve({ ok: false, error: 'Could not save the PIN.' }) : real.setPin(pin, options))
  };
  const device = await world.device('Device', { pin: false, keystore });
  home.start();
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const sealed = device.autoUnlock.store.bytes;

  refuse = true;
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Device', '424242');
  world.relay.pump();
  const answer = await pairing;
  assert.equal(answer.ok, true);
  assert.equal(answer.device.id, home.id);
  assert.equal(answer.device.role, 'home');
  assert.equal(answer.pinError, 'Could not save the PIN.');

  world.relay.pump();
  assert.equal(real.listPeers()[0].deviceId, home.id);
  const status = device.manager.status();
  assert.equal(status.needsPin, true);
  assert.equal(status.hasPin, false);
  assert.equal(status.devices[0].connected, true);
  assert.deepEqual(device.autoUnlock.store.bytes, sealed);

  // The same path works from here.
  refuse = false;
  assert.equal((await device.manager.setPin('12')).ok, false);
  assert.equal(device.manager.status().needsPin, true);
  assert.deepEqual((await device.manager.setPin('424242')), { ok: true });
  const after = device.manager.status();
  assert.equal(after.needsPin, false);
  assert.equal(after.hasPin, true);
  assert.equal(device.autoUnlock.store.bytes, null);
  assert.equal(after.devices[0].connected, true);

  device.manager.lock();
  assert.equal(device.manager.status().idleLocked, true);
  assert.equal((await device.manager.unlock('424242')).ok, true);
});

test('needsPin survives a restart while a home PC is paired on the secret', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const file = world.newFile();
  const real = world.keystore(file);
  let refuse = false;
  const keystore = {
    ...real,
    setPin: (pin, options) => (refuse ? Promise.resolve({ ok: false, error: 'Could not save the PIN.' }) : real.setPin(pin, options))
  };
  const device = await world.device('Device', { pin: false, keystore, file });
  home.start();
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  refuse = true;
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Device', '424242');
  world.relay.pump();
  assert.equal((await pairing).ok, true);

  device.restart();
  await until('it to unlock itself', () => !device.manager.status().locked);
  world.relay.pump();
  const status = device.manager.status();
  assert.equal(status.needsPin, true);
  assert.equal(status.hasPin, false);
  assert.equal(status.devices[0].role, 'home');
  assert.equal(status.devices[0].connected, true);
  assert.deepEqual(await device.manager.setPin('424242'), { ok: true });
  assert.equal(device.manager.status().needsPin, false);
  assert.equal(device.autoUnlock.store.bytes, null);
});
// ---- The kind of PIN decides what the secret file means ----

// A device on its secret, stopped, ready for a restart on the same files.
async function deviceOnSecret(t) {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  home.start();
  await home.manager.createCode();
  home.manager.cancelCode();
  home.manager.shutdown();
  return { world, home, sealed: Buffer.from(home.autoUnlock.store.bytes) };
}

test('counted failures on a device on its secret do not stop it, and its good file stays', async (t) => {
  const { home, sealed } = await deviceOnSecret(t);
  const guesses = createKeystoreLike(home);
  for (let i = 0; i < 4; i++) await guesses.unlock('000000');
  assert.equal(failedOnDisk(home.file), 4);

  home.restart();
  await until('it to unlock itself', () => !home.manager.status().locked);
  assert.deepEqual(home.autoUnlock.store.bytes, sealed);
  const status = home.manager.status();
  assert.equal(status.hasPin, false);
  assert.equal(status.keysReset, false);
  assert.equal(status.storageAvailable, true);
});

function createKeystoreLike(device) {
  return createKeystore({ file: device.file, protect: (bytes) => bytes, unprotect: (bytes) => bytes, kdfCost: FAST });
}

test('a self-unlock never counts as a guess, even if it is killed partway through', async (t) => {
  const { home, sealed } = await deviceOnSecret(t);
  for (let boot = 0; boot < 6; boot++) {
    home.restart();
    await tick();
    // The moment the old code wrote the count, before scrypt.
    assert.equal(failedOnDisk(home.file), 0);
    await until('it to unlock itself', () => !home.manager.status().locked);
    assert.equal(failedOnDisk(home.file), 0);
  }
  assert.deepEqual(home.autoUnlock.store.bytes, sealed);
});

test('a persistent error during self-unlock burns nothing, keeps the file, and backs off to 60 seconds', async (t) => {
  const { world, home, sealed } = await deviceOnSecret(t);
  const realScrypt = nodeCrypto.scrypt;
  nodeCrypto.scrypt = (...args) => setImmediate(() => args[args.length - 1](new Error('memory limit exceeded')));
  t.after(() => {
    nodeCrypto.scrypt = realScrypt;
  });

  const tries = [];
  home.restart();
  const realUnlock = home.keystore.unlock;
  home.keystore.unlock = (...args) => {
    tries.push(world.clock.now());
    return realUnlock(...args);
  };
  await until('the first try', () => tries.length === 1);
  await tick();

  for (let i = 0; i < 40; i++) {
    world.run(15 * 1000);
    await tick();
    await tick();
  }
  const gaps = tries.slice(1).map((time, i) => time - tries[i]);
  assert.ok(gaps.length >= 5, `${gaps.length} retries`);
  assert.ok(gaps.every((gap) => gap <= 75 * 1000), gaps.join());
  assert.ok(gaps[gaps.length - 1] >= 60 * 1000, gaps.join());
  assert.ok(gaps[0] < gaps[gaps.length - 1], gaps.join());

  assert.deepEqual(home.autoUnlock.store.bytes, sealed);
  assert.equal(failedOnDisk(home.file), 0);
  const status = home.manager.status();
  assert.equal(status.locked, true);
  assert.equal(status.hasPin, false);
  assert.equal(status.storageAvailable, false);
  assert.equal(status.keysReset, false);

  nodeCrypto.scrypt = realScrypt;
  world.run(60 * 1000);
  await until('it to unlock itself', () => !home.manager.status().locked);
  assert.equal(home.manager.status().storageAvailable, true);
});

test('a read error at boot that passes is retried on a timer, and never looks like a PIN device', async (t) => {
  const { world, home, sealed } = await deviceOnSecret(t);
  home.autoUnlock.store.failRead = true;
  home.restart();
  await tick();
  home.autoUnlock.store.failRead = false;

  const waiting = home.manager.status();
  assert.equal(waiting.locked, true);
  assert.equal(waiting.hasPin, false);
  assert.equal(waiting.storageAvailable, false);
  assert.equal((await home.manager.unlock('000000')).ok, false);
  assert.equal(failedOnDisk(home.file), 0);
  assert.deepEqual(home.autoUnlock.store.bytes, sealed);

  world.run(5000);
  await until('it to unlock itself', () => !home.manager.status().locked);
  assert.equal(home.manager.status().storageAvailable, true);
  assert.equal(home.manager.status().hasPin, false);
});

test('a keystore unavailable at boot comes back on a timer, with nobody calling status()', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  let available = true;
  const make = () =>
    createKeystore({ file, protect: (bytes) => bytes, unprotect: (bytes) => bytes, kdfCost: FAST, isProtectionAvailable: () => available });
  const first = await world.device('First', { pin: false, keystore: make() });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();

  available = false;
  const keystore = make();
  const device = await world.device('Device', { pin: false, keystore });
  device.autoUnlock.store.bytes = first.autoUnlock.store.bytes;
  device.start();
  await tick();
  world.run(30 * 1000);
  await tick();
  assert.equal(keystore.isUnlocked(), false);
  assert.deepEqual(device.autoUnlock.store.bytes, first.autoUnlock.store.bytes);

  available = true;
  world.run(60 * 1000);
  await until('it to unlock itself', () => keystore.isUnlocked());
  assert.equal(device.manager.status().hasPin, false);
  assert.equal(device.manager.status().keysReset, false);
});

test('a timed retry stops once there is nothing left to wait for', async (t) => {
  const { world, home } = await deviceOnSecret(t);
  home.autoUnlock.store.failRead = true;
  home.restart();
  await tick();
  home.autoUnlock.store.failRead = false;
  const reads = home.autoUnlock.store.reads;
  world.run(5000);
  await until('it to unlock itself', () => !home.manager.status().locked);
  assert.equal(home.autoUnlock.store.reads, reads + 1);
  world.run(10 * MINUTES);
  await tick();
  assert.equal(home.autoUnlock.store.reads, reads + 1);
});

test('a secret that opens to something else counts as damage', async (t) => {
  const { home } = await deviceOnSecret(t);
  home.autoUnlock.store.garble = true;
  home.restart();
  await tick();
  assert.equal(home.autoUnlock.store.bytes, null);
  assert.equal(fs.existsSync(home.file), false);
  const status = home.manager.status();
  assert.equal(status.keysReset, true);
  assert.equal(status.hasPin, false);
});

test('forty digits that do not open the keystore count as damage, not a PIN prompt', async (t) => {
  const { home } = await deviceOnSecret(t);
  home.autoUnlock.store.bytes = Buffer.concat([Buffer.from('sealed:'), Buffer.from('7'.repeat(40))]);
  home.restart();
  await until('the reset', () => home.autoUnlock.store.bytes === null);
  await until('the keystore set aside', () => !fs.existsSync(home.file));
  const status = home.manager.status();
  assert.equal(status.keysReset, true);
  assert.equal(status.hasPin, false);
  assert.equal(status.locked, true);
  assert.ok((await home.manager.createCode()).code);
});

test('a device on its secret whose file has gone resets, rather than asking for a PIN that does not exist', async (t) => {
  const { home } = await deviceOnSecret(t);
  home.autoUnlock.store.bytes = null;
  home.restart();
  await tick();
  assert.equal(fs.existsSync(home.file), false);
  const status = home.manager.status();
  assert.equal(status.keysReset, true);
  assert.equal(status.hasPin, false);
  assert.ok((await home.manager.createCode()).code);
});

test('a missing file with protection gone is not taken for damage', async (t) => {
  const world = newWorld(t);
  const file = world.newFile();
  let available = true;
  const make = () =>
    createKeystore({ file, protect: (bytes) => bytes, unprotect: (bytes) => bytes, kdfCost: FAST, isProtectionAvailable: () => available });
  const first = await world.device('First', { pin: false, keystore: make() });
  first.start();
  await first.manager.createCode();
  first.manager.shutdown();

  const device = await world.device('Device', { pin: false, keystore: make() });
  device.autoUnlock.read = () => {
    available = false;
    return null;
  };
  device.start();
  await tick();
  assert.equal(fs.existsSync(file), true);
  assert.equal(device.manager.status().keysReset, false);
  assert.equal(device.manager.status().storageAvailable, false);
});

test('losing the OS key says so: keys set aside at load set keysReset, on a device on its secret', async (t) => {
  const { home } = await deviceOnSecret(t);
  const keystore = createKeystore({
    file: home.file,
    protect: (bytes) => bytes,
    unprotect: () => {
      throw new Error('the OS key has gone');
    },
    kdfCost: FAST
  });
  const device = await newWorld(t).device('Device', { pin: false, keystore });
  device.autoUnlock.store.bytes = home.autoUnlock.store.bytes;
  device.autoUnlock.store.failUnprotect = true;
  device.start();
  await tick();

  assert.equal(device.autoUnlock.store.bytes, null);
  const status = device.manager.status();
  assert.equal(status.keysReset, true);
  assert.equal(status.hasPin, false);
  assert.equal(device.manager.status().keysReset, false);
});

test('losing the OS key says so on a device with a PIN too, and a first run says nothing', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  const keystore = createKeystore({
    file: device.file,
    protect: (bytes) => bytes,
    unprotect: () => {
      throw new Error('the OS key has gone');
    },
    kdfCost: FAST
  });
  const lost = await world.device('Lost', { pin: false, keystore });
  lost.start();
  assert.equal(lost.manager.status().keysReset, true);
  assert.equal(lost.manager.status().keysReset, false);

  const fresh = await world.device('Fresh', { pin: false });
  fresh.start();
  assert.equal(fresh.manager.status().keysReset, false);
});

test('a damaged secret file does nothing to a device with a working PIN', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.lock();
  device.autoUnlock.store.bytes = Buffer.from('junk');
  device.autoUnlock.store.failUnprotect = true;
  device.start();
  await tick();

  assert.equal(fs.existsSync(device.file), true);
  assert.equal(device.autoUnlock.store.bytes, null);
  const status = device.manager.status();
  assert.equal(status.keysReset, false);
  assert.equal(status.hasPin, true);
  assert.equal(status.locked, true);
  assert.equal(failedOnDisk(device.file), 0);
  assert.equal((await device.manager.unlock(PIN)).ok, true);
});

test('a read error on a device with a PIN holds nothing up', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.lock();
  device.autoUnlock.store.failRead = true;
  device.start();
  await tick();
  assert.equal(device.manager.status().storageAvailable, true);
  assert.equal(device.manager.status().hasPin, true);
  assert.equal((await device.manager.unlock(PIN)).ok, true);
});

test('a keystore from before kinds existed counts as a PIN a person chose', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.lock();
  const outer = JSON.parse(fs.readFileSync(device.file, 'utf8'));
  delete outer.pinKind;
  fs.writeFileSync(device.file, JSON.stringify(outer));

  const keystore = world.keystore(device.file);
  const old = await world.device('Old', { pin: false, keystore });
  old.autoUnlock.store.bytes = Buffer.concat([Buffer.from('sealed:'), Buffer.from('0'.repeat(40))]);
  old.start();
  await tick();
  assert.equal(old.autoUnlock.store.bytes, null);
  assert.equal(old.manager.status().hasPin, true);
  assert.equal((await old.manager.unlock(PIN)).ok, true);
});

// ---- One queue for everything that changes the keys ----

test('setPin then createCode at once keeps the chosen PIN', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  const [pinResult, code] = await Promise.all([device.manager.setPin('424242'), device.manager.createCode()]);
  assert.deepEqual(pinResult, { ok: true });
  assert.ok(code.code);
  assert.equal(device.autoUnlock.store.bytes, null);
  assert.equal(device.autoUnlock.store.writes, 0);
  assert.equal(device.manager.status().hasPin, true);

  device.restart();
  await tick();
  assert.equal(device.manager.status().hasPin, true);
  assert.equal(device.manager.status().keysReset, false);
  assert.equal((await device.manager.unlock('424242')).ok, true);
});

test('createCode then setPin at once ends on the chosen PIN, with no secret left', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  const [code, pinResult] = await Promise.all([device.manager.createCode(), device.manager.setPin('424242')]);
  assert.ok(code.code);
  assert.deepEqual(pinResult, { ok: true });
  assert.equal(device.autoUnlock.store.bytes, null);
  assert.equal(device.manager.status().hasPin, true);

  device.restart();
  await tick();
  assert.equal((await device.manager.unlock('424242')).ok, true);
});

test('two createCodes at once make one secret', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device', { pin: false });
  device.start();
  const [one, two] = await Promise.all([device.manager.createCode(), device.manager.createCode()]);
  assert.ok(one.code && two.code);
  assert.equal(device.autoUnlock.store.writes, 1);
  device.restart();
  await until('it to unlock itself', () => !device.manager.status().locked);
});

test('setPin during a pair on a brand new device: the PIN set first stays, and pair does not replace it', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const device = await world.device('Device', { pin: false });
  home.start();
  device.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();

  const pinning = device.manager.setPin('111111');
  const pairing = device.manager.pair(code, 'Device', '222222');
  assert.deepEqual(await pinning, { ok: true });
  await until('pairing to start', () => world.relay.pairConnects.some((client) => client.role === 'guest'));
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  assert.equal(device.autoUnlock.store.bytes, null);

  device.restart();
  await tick();
  assert.equal((await device.manager.unlock('222222')).ok, false);
  assert.equal((await device.manager.unlock('111111')).ok, true);
});

test('setPin during the PIN step at the end of a pair: the one set first stays', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const device = await world.device('Device', { pin: false });
  home.start();
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const { code } = await home.manager.createCode();
  world.relay.pump();

  const pairing = device.manager.pair(code, 'Device', '222222');
  world.relay.pump();
  assert.deepEqual(await device.manager.setPin('111111'), { ok: true });
  assert.equal((await pairing).ok, true);
  device.restart();
  await tick();
  assert.equal((await device.manager.unlock('111111')).ok, true);
});

// ---- The real relay client, against a fake socket ----

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.pings = 0;
    this.bufferedAmount = 0;
    this.terminated = false;
    this.closeCalls = [];
    this._receiver = new EventEmitter();
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  receive(value) {
    this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  ping() {
    this.pings++;
  }
  close(code) {
    this.closeCalls.push(code);
    this.readyState = 2;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
}

function deviceClient(overrides = {}) {
  FakeSocket.instances.length = 0;
  const clock = fakeClock();
  const events = { ready: 0, messages: [], offline: [], closed: 0 };
  const identity = newIdentity();
  const client = connectDevice({
    address: 'wss://relay.example/abc',
    identity,
    clock,
    WebSocketImpl: FakeSocket,
    onReady: () => events.ready++,
    onMessage: (from, data) => events.messages.push({ from, data }),
    onOffline: (to) => events.offline.push(to),
    onClose: () => events.closed++,
    ...overrides
  });
  const socket = FakeSocket.instances[0];
  return { client, clock, events, identity, socket };
}

function readyClient(overrides) {
  const parts = deviceClient(overrides);
  parts.socket.open();
  parts.socket.receive({ t: 'challenge', nonce: 'bm9uY2U=' });
  parts.socket.receive({ t: 'ready' });
  parts.socket.sent.length = 0;
  // A new second, so the answer to the challenge doesn't count against what a test sends.
  parts.clock.advance(1000);
  return parts;
}

test('relay client: the URL names the device, and the challenge is answered with a good signature', () => {
  const { socket, identity, events } = deviceClient();
  assert.equal(socket.url, `wss://relay.example/abc/device/${deviceIdFromPublicKey(identity.publicKey)}`);
  socket.open();
  assert.deepEqual(socket.sent, []);

  const nonce = 'c29tZS1ub25jZQ==';
  socket.receive({ t: 'challenge', nonce });
  assert.equal(socket.sent.length, 1);
  const [auth] = socket.sent;
  assert.equal(auth.t, 'auth');
  assert.equal(auth.publicKey, Buffer.from(identity.publicKey).toString('base64'));
  const signed = new TextEncoder().encode(`sanctum-relay-auth-v1:${nonce}`);
  assert.equal(verify(identity.publicKey, signed, new Uint8Array(Buffer.from(auth.sig, 'base64'))), true);

  assert.equal(events.ready, 0);
  socket.receive({ t: 'ready' });
  assert.equal(events.ready, 1);
});

test('relay client: signs only once per connection, and only a string nonce of a sane size', () => {
  const { socket } = deviceClient();
  socket.open();
  socket.receive({ t: 'challenge', nonce: 7 });
  socket.receive({ t: 'challenge', nonce: 'x'.repeat(5000) });
  assert.equal(socket.sent.length, 0);
  socket.receive({ t: 'challenge', nonce: 'first' });
  socket.receive({ t: 'challenge', nonce: 'second' });
  assert.equal(socket.sent.length, 1);
});

test('relay client: nothing is passed on or sent before ready', () => {
  const { client, socket, events } = deviceClient();
  socket.open();
  socket.receive({ t: 'recv', from: 'a', data: {} });
  socket.receive({ t: 'ready' });
  assert.equal(events.ready, 0);
  assert.equal(client.send('a', { x: 1 }), false);
  socket.receive({ t: 'challenge', nonce: 'n' });
  socket.receive({ t: 'recv', from: 'a', data: {} });
  assert.deepEqual(events.messages, []);
  assert.equal(client.send('a', { x: 1 }), false);
  assert.equal(socket.sent.length, 1);
});

test('relay client: routes recv, offline and ignores the malformed', () => {
  const { socket, events } = readyClient();
  socket.receive({ t: 'recv', from: 'dev', data: { a: 1 } });
  socket.receive({ t: 'recv', from: 7, data: {} });
  socket.receive({ t: 'recv', from: 'dev' });
  socket.receive({ t: 'offline', to: 'dev' });
  socket.receive({ t: 'offline', to: 7 });
  socket.receive('not json');
  socket.receive('null');
  socket.emit('message', Buffer.from([1, 2, 3]), true);
  assert.deepEqual(events.messages, [{ from: 'dev', data: { a: 1 } }]);
  assert.deepEqual(events.offline, ['dev']);
  assert.equal(events.closed, 0);
});

test('relay client: sends are paced under the relay limit of 120 a second, in order', () => {
  const { client, clock, socket } = readyClient();
  for (let i = 0; i < 350; i++) assert.equal(client.send('dev', { i }), true);
  assert.equal(socket.sent.length, 100);
  clock.advance(999);
  assert.equal(socket.sent.length, 100);
  clock.advance(1);
  assert.equal(socket.sent.length, 200);
  clock.advance(2000);
  assert.equal(socket.sent.length, 350);
  assert.deepEqual(socket.sent.map((m) => m.data.i), [...Array(350).keys()]);
  assert.deepEqual(socket.sent[0], { t: 'send', to: 'dev', data: { i: 0 } });
});

test('relay client: slow-down pauses sending for a moment', () => {
  const { client, clock, socket } = readyClient();
  socket.receive({ t: 'slow-down' });
  assert.equal(client.send('dev', { i: 1 }), true);
  assert.equal(socket.sent.length, 0);
  clock.advance(1000);
  assert.equal(socket.sent.length, 1);
});

test('relay client: waits while the socket is backed up', () => {
  const { client, clock, socket } = readyClient();
  socket.bufferedAmount = 64 * MIB;
  client.send('dev', { i: 1 });
  clock.advance(1000);
  assert.equal(socket.sent.length, 0);
  socket.bufferedAmount = 0;
  clock.advance(1000);
  assert.equal(socket.sent.length, 1);
});

test('relay client: a message the relay would refuse is not sent', () => {
  const { client, socket } = readyClient();
  assert.equal(client.send('dev', { s: 'x'.repeat(MIB) }), false);
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.options.maxPayload > MIB, true);
  assert.equal(socket.options.maxPayload <= 4 * MIB, true);
});

test('relay client: a close frame counts as closed, without waiting for TCP', () => {
  const { client, socket, events } = readyClient();
  socket._receiver.emit('conclude', 1000, Buffer.from('replaced'));
  assert.equal(events.closed, 1);
  assert.equal(socket.terminated, true);
  assert.equal(client.send('dev', {}), false);
  socket.emit('close', 1000, Buffer.alloc(0));
  assert.equal(events.closed, 1);
});

test('relay client: an error or a close ends it once', () => {
  const first = deviceClient();
  first.socket.emit('error', new Error('refused'));
  first.socket.emit('close', 1006, Buffer.alloc(0));
  assert.equal(first.events.closed, 1);

  const second = readyClient();
  second.socket.emit('close', 1006, Buffer.alloc(0));
  assert.equal(second.events.closed, 1);
});

test('relay client: a socket that stops answering pings is treated as closed', () => {
  const { clock, socket, events } = readyClient();
  clock.advance(30 * 1000);
  assert.equal(socket.pings, 1);
  socket.emit('pong');
  clock.advance(30 * 1000);
  assert.equal(socket.pings, 2);
  assert.equal(events.closed, 0);
  clock.advance(30 * 1000);
  assert.equal(events.closed, 1);
  assert.equal(socket.terminated, true);
});

test('relay client: traffic counts as life, so a busy socket is not closed for a late pong', () => {
  const { clock, socket, events } = readyClient();
  clock.advance(30 * 1000);
  socket.receive({ t: 'recv', from: 'dev', data: {} });
  clock.advance(30 * 1000);
  assert.equal(events.closed, 0);
});

test('relay client: close by the owner is quiet, and flush sends what is queued first', () => {
  const quiet = readyClient();
  quiet.client.close();
  assert.deepEqual(quiet.socket.closeCalls, [1000]);
  quiet.socket.emit('close', 1000, Buffer.alloc(0));
  assert.equal(quiet.events.closed, 0);
  assert.equal(quiet.clock.pendingTimers(), 0);

  const flushing = readyClient();
  for (let i = 0; i < 150; i++) flushing.client.send('dev', { i });
  flushing.client.close({ flush: true });
  assert.equal(flushing.socket.sent.length, 100);
  assert.deepEqual(flushing.socket.closeCalls, []);
  flushing.clock.advance(1000);
  assert.equal(flushing.socket.sent.length, 150);
  assert.deepEqual(flushing.socket.closeCalls, [1000]);
  assert.equal(flushing.events.closed, 0);

  const dropped = readyClient();
  for (let i = 0; i < 150; i++) dropped.client.send('dev', { i });
  dropped.client.close();
  dropped.clock.advance(5000);
  assert.equal(dropped.socket.sent.length, 100);
});

test('relay client: the pairing channel opens on the right path and wraps its messages', () => {
  FakeSocket.instances.length = 0;
  const events = { open: 0, messages: [], none: 0, closed: 0 };
  const clock = fakeClock();
  const client = connectPairing({
    address: 'wss://relay.example/abc',
    role: 'guest',
    clock,
    WebSocketImpl: FakeSocket,
    onOpen: () => events.open++,
    onMessage: (data) => events.messages.push(data),
    onNone: () => events.none++,
    onClose: () => events.closed++
  });
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://relay.example/abc/pair/guest');
  socket.open();
  assert.equal(events.open, 1);

  client.send({ t: 'pake', pake: 'x' });
  assert.deepEqual(socket.sent, [{ t: 'pair', data: { t: 'pake', pake: 'x' } }]);

  socket.receive({ t: 'pair', data: { t: 'pake-reply' } });
  socket.receive({ t: 'pair' });
  socket.receive({ t: 'pair-none' });
  assert.deepEqual(events.messages, [{ t: 'pake-reply' }]);
  assert.equal(events.none, 1);

  socket._receiver.emit('conclude', 1000, Buffer.from('no pairing in progress'));
  assert.equal(events.closed, 1);
});

// ---- Direct connections, with a fake direct path ----

// Stands in for lib/remote/direct-path.js on one device, and records what the manager asks.
function fakeDirect() {
  const fake = {
    calls: [],
    sent: [],
    throwOnSend: false,
    throwOnSignal: false,
    create(callbacks) {
      fake.callbacks = callbacks;
      return {
        connect: (id, initiator) => fake.calls.push(['connect', id, initiator]),
        signal: (id, data) => {
          if (fake.throwOnSignal) throw new Error('boom');
          fake.calls.push(['signal', id, data]);
        },
        send: (id, bytes) => {
          if (fake.throwOnSend) throw new Error('channel closed');
          fake.sent.push({ id, bytes: Uint8Array.from(bytes) });
        },
        close: (id) => fake.calls.push(['close', id])
      };
    },
    of: (op) => fake.calls.filter((call) => call[0] === op)
  };
  return fake;
}

async function connectedWithDirect(t, { laptopHasDirect = true } = {}) {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.direct = fakeDirect();
  home.createDirect = home.direct.create;
  if (laptopHasDirect) {
    laptop.direct = fakeDirect();
    laptop.createDirect = laptop.direct.create;
  }
  seedPair(home, laptop);
  home.start();
  laptop.start();
  world.relay.pump();
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(laptop.entry(home.id).connected, true);
  return { world, home, laptop };
}

// Hands over what each end's direct path has been given to send, as the channel would.
function pumpDirect({ home, laptop }) {
  for (let moved = true; moved;) {
    moved = false;
    for (const [from, to] of [[home, laptop], [laptop, home]]) {
      for (const { bytes } of from.direct.sent.splice(0)) {
        moved = true;
        to.direct.callbacks.onData(from.id, bytes);
      }
    }
  }
}

function goDirect(ends) {
  ends.home.direct.callbacks.onOpen(ends.laptop.id);
  ends.laptop.direct.callbacks.onOpen(ends.home.id);
  pumpDirect(ends);
}

// Ends the home side's connection with a frame that won't decrypt, and lets a new session
// form. It goes over the relay, so the laptop's direct path has to be down for this.
function breakSession({ world, home, laptop }) {
  laptop.direct.callbacks.onClose(home.id);
  const { connectionId, nextSeq } = liveLinkState(world, laptop, home);
  world.relay.inject(laptop.id, home.id, forgeLink(DATA, connectionId, nextSeq, new Uint8Array(64)));
  world.relay.pump();
}

test('the home-role side initiates, and each side connects when the session goes live', async (t) => {
  const { home, laptop } = await connectedWithDirect(t);
  assert.deepEqual(home.direct.of('connect'), [['connect', laptop.id, true]]);
  assert.deepEqual(laptop.direct.of('connect'), [['connect', home.id, false]]);
  assert.deepEqual(home.direct.of('close'), []);
});

test('a device of both roles decides who initiates per connection, by the peer', async (t) => {
  const world = newWorld(t);
  const middle = await world.device('Middle');
  const above = await world.device('Above');
  const below = await world.device('Below');
  middle.direct = fakeDirect();
  middle.createDirect = middle.direct.create;
  seedPair(above, middle);
  seedPair(middle, below);
  above.start();
  middle.start();
  below.start();
  world.relay.pump();
  const connects = new Map(middle.direct.of('connect').map(([, id, initiator]) => [id, initiator]));
  assert.equal(connects.get(above.id), false);
  assert.equal(connects.get(below.id), true);
});

test('signaling crosses inside the encrypted session and never reaches the renderer', async (t) => {
  const { world, home, laptop } = await connectedWithDirect(t);
  const data = { attempt: 1, kind: 'offer', sdp: 'a-very-recognizable-session-description' };
  const start = world.relay.log.length;
  home.direct.callbacks.onSignal(laptop.id, data);
  world.relay.pump();

  assert.deepEqual(laptop.direct.of('signal'), [['signal', home.id, data]]);
  assert.deepEqual(laptop.frames, []);
  const sent = world.relay.log.slice(start).filter((m) => m.from === home.id);
  assert.ok(sent.length > 0);
  for (const message of sent) {
    assert.equal(message.data.t, 'link');
    const raw = Buffer.from(message.data.b, 'base64').toString('latin1');
    assert.ok(!raw.includes('recognizable'));
    assert.ok(!raw.includes('rtc'));
  }
});

test('a device with no direct path still keeps signaling away from the renderer', async (t) => {
  const { world, home, laptop } = await connectedWithDirect(t, { laptopHasDirect: false });
  home.direct.callbacks.onSignal(laptop.id, { attempt: 1, kind: 'offer', sdp: 's' });
  world.relay.pump();
  assert.deepEqual(laptop.frames, []);
  assert.equal(home.manager.send(laptop.id, { type: 'chat' }), true);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ type: 'chat' }]);
  assert.equal(laptop.entry(home.id).path, 'relay');
});

test('the renderer cannot send a frame the other end would take as signaling', async (t) => {
  const { world, home, laptop } = await connectedWithDirect(t);
  assert.equal(home.manager.send(laptop.id, { type: 'rtc', data: { attempt: 1, kind: 'offer', sdp: 's' } }), false);
  world.relay.pump();
  assert.deepEqual(laptop.direct.of('signal'), []);
  // Other frames are as they were, including ones merely called something like it.
  assert.equal(home.manager.send(laptop.id, { type: 'RTC' }), true);
  assert.equal(home.manager.send(laptop.id, { t: 'rtc' }), true);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ type: 'RTC' }, { t: 'rtc' }]);
});

test('signaling with bad data is left for the path to check, and a path that throws costs nothing', async (t) => {
  const { world, home, laptop } = await connectedWithDirect(t);
  home.direct.callbacks.onSignal(laptop.id, 'nonsense');
  world.relay.pump();
  assert.deepEqual(laptop.direct.of('signal').map((call) => call[2]), ['nonsense']);
  assert.deepEqual(laptop.frames, []);

  laptop.direct.throwOnSignal = true;
  home.direct.callbacks.onSignal(laptop.id, { boom: true });
  world.relay.pump();
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.manager.send(laptop.id, { still: 'working' }), true);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame), [{ still: 'working' }]);
});

test('status follows the path: direct when open, relay when closed, and it stays connected throughout', async (t) => {
  const { home, laptop } = await connectedWithDirect(t);
  assert.equal(home.entry(laptop.id).path, 'relay');
  home.statuses.length = 0;

  home.direct.callbacks.onOpen(laptop.id);
  assert.equal(home.entry(laptop.id).path, 'direct');
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.statuses.at(-1).devices[0].path, 'direct');

  home.direct.callbacks.onClose(laptop.id);
  assert.equal(home.entry(laptop.id).path, 'relay');
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.statuses.at(-1).devices[0].path, 'relay');
  assert.ok(home.statuses.every((status) => status.devices[0].connected));
});

test('while direct, frames go over it and not the relay, and arrive once and in order across switches', async (t) => {
  const ends = await connectedWithDirect(t);
  const { world, home, laptop } = ends;
  goDirect(ends);
  const relayed = world.relay.log.length;

  for (let n = 0; n < 5; n++) assert.equal(home.manager.send(laptop.id, { n }), true);
  assert.equal(home.direct.sent.length, 5);
  pumpDirect(ends);
  assert.equal(world.relay.log.length, relayed);

  // Frames lost with the channel: the link still has them, so the relay carries them.
  for (let n = 5; n < 10; n++) home.manager.send(laptop.id, { n });
  home.direct.sent.length = 0;
  home.direct.callbacks.onClose(laptop.id);
  laptop.direct.callbacks.onClose(home.id);
  for (let n = 10; n < 15; n++) home.manager.send(laptop.id, { n });
  world.relay.pump();

  // And back again, with some of the same frames on their way down both paths.
  for (let n = 15; n < 20; n++) home.manager.send(laptop.id, { n });
  goDirect(ends);
  for (let n = 20; n < 25; n++) home.manager.send(laptop.id, { n });
  pumpDirect(ends);
  world.relay.pump();

  assert.deepEqual(laptop.frames.map((f) => f.frame.n), Array.from({ length: 25 }, (_, n) => n));
});

test('a frame split into parts arrives whole over the direct path', async (t) => {
  const ends = await connectedWithDirect(t);
  const { home, laptop } = ends;
  goDirect(ends);
  const text = 'x'.repeat(2 * MIB);
  assert.equal(home.manager.send(laptop.id, { text }), true);
  pumpDirect(ends);
  assert.equal(laptop.frames.length, 1);
  assert.equal(laptop.frames[0].frame.text, text);
});

test('what a direct path carries is the same sealed bytes the relay would carry', async (t) => {
  const ends = await connectedWithDirect(t);
  const { home, laptop } = ends;
  goDirect(ends);
  home.manager.send(laptop.id, { secret: 'something-that-must-stay-sealed' });
  assert.equal(home.direct.sent.length, 1);
  assert.ok(!Buffer.from(home.direct.sent[0].bytes).toString('latin1').includes('must-stay-sealed'));
  pumpDirect(ends);
  assert.equal(laptop.frames[0].frame.secret, 'something-that-must-stay-sealed');
});

test('a connection that ends closes its direct path, and the new one starts another', async (t) => {
  const ends = await connectedWithDirect(t);
  const { home, laptop } = ends;
  goDirect(ends);
  breakSession(ends);

  for (const [device, peer, initiator] of [[home, laptop, true], [laptop, home, false]]) {
    assert.deepEqual(device.direct.of('close'), [['close', peer.id]]);
    assert.deepEqual(device.direct.of('connect'), [['connect', peer.id, initiator], ['connect', peer.id, initiator]]);
    assert.equal(device.entry(peer.id).connected, true);
    assert.equal(device.entry(peer.id).path, 'relay', 'a new link starts on the relay');
    // Closed before the next one connects, so the two can't overlap.
    const ops = device.direct.calls.map((call) => call[0]);
    assert.deepEqual(ops, ['connect', 'close', 'connect']);
  }
});

test('what a replaced connection left behind can do nothing to the new one', async (t) => {
  const ends = await connectedWithDirect(t);
  const { world, home, laptop } = ends;
  goDirect(ends);
  // Sealed under the old connection, and not delivered yet.
  home.manager.send(laptop.id, { n: 'old' });
  const stale = home.direct.sent.splice(0).map((entry) => entry.bytes);
  breakSession(ends);
  assert.equal(laptop.entry(home.id).connected, true);

  laptop.frames.length = 0;
  for (const bytes of stale) laptop.direct.callbacks.onData(home.id, bytes);
  assert.deepEqual(laptop.frames, []);
  assert.equal(laptop.entry(home.id).connected, true);
  assert.equal(home.manager.send(laptop.id, { n: 'new' }), true);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame.n), ['new']);
});

test('events for a device with nothing live are harmless', async (t) => {
  const { home, laptop } = await connectedWithDirect(t);
  assert.equal(home.manager.removeDevice(laptop.id).ok, true);
  assert.deepEqual(home.direct.of('close'), [['close', laptop.id]]);
  const { callbacks } = home.direct;
  callbacks.onOpen(laptop.id);
  callbacks.onClose(laptop.id);
  callbacks.onData(laptop.id, Uint8Array.of(1, 2, 3));
  callbacks.onSignal(laptop.id, { attempt: 1, kind: 'offer', sdp: 's' });
  callbacks.onOpen('someone-else');
  callbacks.onSignal('someone-else', {});
  assert.deepEqual(home.manager.status().devices, []);
});

test('junk bytes from the direct path are dropped by the link, and the connection stays', async (t) => {
  const ends = await connectedWithDirect(t);
  const { home, laptop } = ends;
  goDirect(ends);
  home.direct.callbacks.onData(laptop.id, new Uint8Array(0));
  home.direct.callbacks.onData(laptop.id, Uint8Array.of(9, 9, 9));
  home.direct.callbacks.onData(laptop.id, new Uint8Array(100));
  assert.equal(home.entry(laptop.id).connected, true);
  assert.equal(home.entry(laptop.id).path, 'direct');
});

test('with the relay gone the direct path carries on, and the session with it', async (t) => {
  const ends = await connectedWithDirect(t);
  const { world, home, laptop } = ends;
  goDirect(ends);
  world.relay.kill(home.id);
  assert.equal(home.entry(laptop.id).path, 'direct');
  assert.equal(home.entry(laptop.id).connected, true);
  assert.deepEqual(home.direct.of('close'), []);
  assert.equal(home.manager.send(laptop.id, { n: 1 }), true);
  pumpDirect(ends);
  assert.deepEqual(laptop.frames.map((f) => f.frame.n), [1]);
});

test('a channel that throws on send loses nothing, once the close arrives', async (t) => {
  const ends = await connectedWithDirect(t);
  const { world, home, laptop } = ends;
  goDirect(ends);
  home.direct.throwOnSend = true;
  assert.equal(home.manager.send(laptop.id, { n: 1 }), true);
  assert.equal(home.entry(laptop.id).path, 'direct');
  home.direct.callbacks.onClose(laptop.id);
  world.relay.pump();
  assert.deepEqual(laptop.frames.map((f) => f.frame.n), [1]);
});

test('shutting down closes the direct path', async (t) => {
  const { home, laptop } = await connectedWithDirect(t);
  home.manager.shutdown();
  assert.deepEqual(home.direct.of('close'), [['close', laptop.id]]);
});

test('status names this device, so a home PC can tell its laptops what it is called', async (t) => {
  const world = newWorld(t);
  const device = await world.device('  Study PC  ');
  device.start();
  assert.equal(device.manager.status().name, 'Study PC');
});

// ---- This device's fingerprint ----

test('status gives this device its own fingerprint, the same one the other end shows for it', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();

  const created = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(created.code, 'Laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();

  assert.equal(laptop.manager.status().fingerprint, home.entry(laptop.id).fingerprint);
  assert.equal(home.manager.status().fingerprint, laptop.entry(home.id).fingerprint);
  assert.equal(laptop.manager.status().fingerprint, fingerprintOf(laptop.id));

  // An idle lock leaves the connection up, so this device is still the one it was.
  laptop.manager.lock();
  assert.equal(laptop.manager.status().idleLocked, true);
  assert.equal(laptop.manager.status().fingerprint, fingerprintOf(laptop.id));
});

test('nothing gives a fingerprint while the keys are sealed', async (t) => {
  const world = newWorld(t);
  const device = await world.device('Device');
  device.keystore.lock();
  device.start();
  assert.equal(device.manager.status().locked, true);
  assert.strictEqual(device.manager.status().fingerprint, null);
});


// ---- What a locked device can send ----

const ACTION_FRAME = { type: 'action', id: 'a1', kind: 'new-chat', args: { modality: 'chat' } };

test('an idle-locked device sends no action, and the frames that keep a mirror going still go', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();

  assert.equal(laptop.manager.send(home.id, ACTION_FRAME), true, 'unlocked, it goes');
  world.relay.pump();
  assert.equal(home.frames.filter((f) => f.frame.type === 'action').length, 1);

  laptop.manager.lock();
  assert.equal(laptop.manager.status().idleLocked, true);
  assert.equal(laptop.manager.send(home.id, ACTION_FRAME), false);
  for (const frame of [{ type: 'mirror-resync-request' }, { type: 'mirror-part-ack', part: 1, transfer: 1 }, { type: 'queued-returned-ack', id: 'q1' }]) {
    assert.equal(laptop.manager.send(home.id, frame), true, frame.type);
  }
  world.relay.pump();
  assert.equal(home.frames.filter((f) => f.frame.type === 'action').length, 1, 'nothing more reached home');
  assert.equal(home.frames.filter((f) => f.frame.type === 'mirror-resync-request').length, 1);

  assert.equal((await laptop.manager.unlock(PIN)).ok, true);
  assert.equal(laptop.manager.send(home.id, ACTION_FRAME), true, 'and after the PIN it goes again');
});

test('pop-ups go out from a locked home PC, and an answer never leaves a locked laptop', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();
  const answer = { type: 'answer', id: 'ask_1', value: true };

  assert.equal(laptop.manager.send(home.id, answer), true, 'unlocked, it goes');
  world.relay.pump();
  assert.equal(home.frames.filter((f) => f.frame.type === 'answer').length, 1);

  laptop.manager.lock();
  assert.equal(laptop.manager.send(home.id, answer), false, 'idle-locked');
  assert.equal(laptop.manager.send(home.id, { ...answer, type: new String('answer') }), false, 'a String object'); // eslint-disable-line no-new-wrappers
  assert.equal(laptop.manager.send(home.id, { ...answer, type: ['answer'] }), false, 'a list');
  assert.equal(laptop.manager.send(home.id, { type: 'ask', id: 'x' }), false, 'nor does a laptop ask anything of its home PC');
  world.relay.pump();
  assert.equal(home.frames.filter((f) => f.frame.type === 'answer').length, 1, 'nothing more reached home');
  assert.equal((await laptop.manager.unlock(PIN)).ok, true);

  home.manager.lock();
  assert.equal(home.manager.send(laptop.id, { type: 'ask', id: 'ask_2', kind: 'approval' }), true, 'its lock is about someone using it, and this is it serving');
  assert.equal(home.manager.send(laptop.id, { type: 'ask-closed', id: 'ask_2', value: null }), true);
  world.relay.pump();
  assert.ok(laptop.frames.some(({ frame }) => frame.type === 'ask'));
  assert.ok(laptop.frames.some(({ frame }) => frame.type === 'ask-closed'));
});

test('a laptop owing a PIN sends no action, though its keys are open, until the PIN is set', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const real = world.keystore();
  let refuse = true;
  const keystore = {
    ...real,
    setPin: (pin, options) => (refuse && options?.kind === 'user' ? Promise.resolve({ ok: false, error: 'Could not save the PIN.' }) : real.setPin(pin, options))
  };
  const device = await world.device('Device', { pin: false, keystore });
  home.start();
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Device', '424242');
  world.relay.pump();
  assert.equal((await pairing).pinError, 'Could not save the PIN.');
  world.relay.pump();

  const status = device.manager.status();
  assert.equal(status.needsPin, true);
  assert.equal(status.locked, false, "the keys are open, so being unlocked can't be the whole check");
  assert.equal(device.manager.send(home.id, ACTION_FRAME), false);
  assert.equal(device.manager.send(home.id, { type: 'mirror-resync-request' }), true);

  refuse = false;
  assert.deepEqual(await device.manager.setPin('424242'), { ok: true });
  assert.equal(device.manager.send(home.id, ACTION_FRAME), true);
});

test('a home PC with only laptops still answers them while it has no PIN of its own', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home', { pin: false });
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();
  assert.equal(home.manager.send(laptop.id, { type: 'action-result', id: 'a1', ok: true }), true);
});


// ---- Only what a locked device has to send ----

const NEW_CHAT = { id: 'a1', kind: 'new-chat', args: { modality: 'chat' } };
// None of these is a plain 'action' until something serialises it, or at all.
const TRICKS = {
  'a String object': () => ({ ...NEW_CHAT, type: new String('action') }),
  'another spelling': () => ({ ...NEW_CHAT, type: 'ACTION' }),
  'an array': () => ({ ...NEW_CHAT, type: ['action'] }),
  'a nested type': () => ({ ...NEW_CHAT, type: { type: 'action' } }),
  'an inherited type': () => Object.assign(Object.create({ type: 'action' }), NEW_CHAT),
  'a toJSON on an allowed type': () => ({ type: 'mirror-part-ack', toJSON: () => ({ ...NEW_CHAT, type: 'action' }) }),
  'a toJSON that throws': () => ({ type: 'mirror-part-ack', toJSON() { throw new Error('no'); } }),
  'a plain action': () => ({ ...NEW_CHAT, type: 'action' })
};

async function pairedForLocking(t) {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  home.start();
  laptop.start();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = laptop.manager.pair(code, 'Laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();
  return { world, home, laptop };
}

const framesAtHome = (home) => home.frames.map((f) => f.frame);

test('an idle-locked laptop sends only its closed set, and the plain copy of it', async (t) => {
  const { world, home, laptop } = await pairedForLocking(t);
  laptop.manager.lock();
  for (const [name, make] of Object.entries(TRICKS)) {
    assert.equal(laptop.manager.send(home.id, make()), false, name);
  }
  assert.equal(laptop.manager.send(home.id, { type: 'mirror-snapshot', seq: 1, chats: [] }), false, 'nothing a laptop has no business sending');
  assert.equal(laptop.manager.send(home.id, { type: 'answer', id: 'x', allow: true }), false, 'nor anything not thought of yet');
  assert.equal(laptop.manager.send(home.id, { type: 'mirror-resync-request', padding: 'x'.repeat(70 * 1024) }), false, 'too big to be what it says');
  world.relay.pump();
  assert.deepEqual(framesAtHome(home), []);

  const withAString = { type: 'mirror-part-ack', part: 1, transfer: 1, note: new String('kept plain') };
  for (const frame of [{ type: 'mirror-resync-request' }, withAString, { type: 'queued-returned-ack', id: 'q1' }]) {
    assert.equal(laptop.manager.send(home.id, frame), true, frame.type);
  }
  world.relay.pump();
  assert.deepEqual(framesAtHome(home).map((f) => f.type), ['mirror-resync-request', 'mirror-part-ack', 'queued-returned-ack']);
  assert.equal(framesAtHome(home)[1].note, 'kept plain');
});

test('a laptop owing a PIN sends only that closed set too', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const real = world.keystore();
  const keystore = { ...real, setPin: (pin, options) => (options?.kind === 'user' ? Promise.resolve({ ok: false, error: 'Could not save the PIN.' }) : real.setPin(pin, options)) };
  const device = await world.device('Device', { pin: false, keystore });
  home.start();
  device.start();
  await device.manager.createCode();
  device.manager.cancelCode();
  const { code } = await home.manager.createCode();
  world.relay.pump();
  const pairing = device.manager.pair(code, 'Device', '424242');
  world.relay.pump();
  assert.equal((await pairing).pinError, 'Could not save the PIN.');
  world.relay.pump();
  assert.equal(device.manager.status().needsPin, true);
  for (const [name, make] of Object.entries(TRICKS)) {
    assert.equal(device.manager.send(home.id, make()), false, name);
  }
  world.relay.pump();
  assert.deepEqual(framesAtHome(home), []);
  assert.equal(device.manager.send(home.id, { type: 'mirror-resync-request' }), true);

  // And the control switch can't go on until there's a PIN. Off always works.
  const on = device.manager.setControlAllowed(true, { fromLocalUi: true });
  assert.equal(on.ok, false);
  assert.match(on.error, /PIN/);
  assert.equal(device.manager.status().controlAllowed, false);
  assert.deepEqual(device.manager.setControlAllowed(false, { fromLocalUi: true }), { ok: true });
});

test('at any time, a type that is not a plain string goes nowhere, and a plain action goes when unlocked', async (t) => {
  const { world, home, laptop } = await pairedForLocking(t);
  for (const type of [new String('action'), new String('rtc'), ['action'], { type: 'action' }, 7, null, undefined]) {
    assert.equal(laptop.manager.send(home.id, { ...NEW_CHAT, type }), false, String(type));
  }
  assert.equal(laptop.manager.send(home.id, { type: 'rtc' }), false);
  world.relay.pump();
  assert.deepEqual(framesAtHome(home), []);
  assert.equal(laptop.manager.send(home.id, { ...NEW_CHAT, type: 'action' }), true);
  world.relay.pump();
  assert.equal(framesAtHome(home).length, 1);
});

test('a device that is locked as a laptop goes on serving its own laptops', async (t) => {
  const { world, home: other, laptop: serving } = await pairedForLocking(t);
  // serving is a laptop of other. Now it's also a home PC to a laptop of its own.
  const own = await world.device('Own laptop');
  own.start();
  const { code } = await serving.manager.createCode();
  world.relay.pump();
  const pairing = own.manager.pair(code, 'Own laptop');
  world.relay.pump();
  assert.equal((await pairing).ok, true);
  world.relay.pump();
  serving.manager.lock();
  assert.equal(serving.manager.status().idleLocked, true);

  const servingFrames = ['mirror-snapshot', 'mirror-ops', 'mirror-run', 'mirror-remove', 'mirror-too-large', 'mirror-part-fence', 'action-result', 'queued-returned'];
  for (const type of servingFrames) {
    assert.equal(serving.manager.send(own.id, { type, seq: 1, big: 'x'.repeat(70 * 1024) }), true, type);
  }
  assert.equal(serving.manager.send(own.id, { ...NEW_CHAT, type: 'action' }), false, 'an action is still no business of a locked device');
  assert.equal(serving.manager.send(own.id, { type: 'something-new' }), false);
  // To its own home PC, the short list.
  assert.equal(serving.manager.send(other.id, { type: 'mirror-ops', seq: 1 }), false);
  world.relay.pump();
  assert.deepEqual(own.frames.map((f) => f.frame.type), servingFrames);
});

// ---- Tool calls ----

const TOOL_CALL = (id = 'call1') => ({ type: 'tool-call', id, name: 'run_command', args: { command: 'ls' }, chatTitle: 'A chat' });
const toolFrames = (device) => device.frames.filter(({ frame }) => frame.type === 'tool-call' || frame.type === 'tool-result');

test('a tool call is refused in the manager while the switch is off, and the renderer never sees it', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.equal(home.manager.send(laptop.id, TOOL_CALL()), true);
  world.run(1);
  assert.deepEqual(toolFrames(laptop), [], 'it never reached a listener');
  const [{ frame }] = toolFrames(home);
  assert.equal(frame.type, 'tool-result');
  assert.equal(frame.id, 'call1');
  assert.equal(frame.ok, false);
  assert.match(frame.result.error, /switch/);
  assert.equal(laptop.refusals.length, 1);
  assert.equal(laptop.refusals[0].deviceId, home.id);
  assert.equal(laptop.refusals[0].frame.name, 'run_command');
  assert.match(laptop.refusals[0].reason, /switch/);
});

test('a tool call reaches the renderer once the switch is on, and stops again the moment it is off', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL('on'));
  world.run(1);
  assert.deepEqual(toolFrames(laptop).map(({ frame }) => frame.id), ['on']);
  assert.deepEqual(laptop.refusals, []);
  assert.equal(laptop.manager.toolCallRefusal(home.id), null);

  assert.deepEqual(laptop.manager.setControlAllowed(false, { fromLocalUi: true }), { ok: true });
  assert.match(laptop.manager.toolCallRefusal(home.id), /switch/);
  home.manager.send(laptop.id, TOOL_CALL('off'));
  world.run(1);
  assert.deepEqual(toolFrames(laptop).map(({ frame }) => frame.id), ['on']);
  assert.equal(laptop.refusals.length, 1);
});

test("a device paired as this device's laptop can never ask, even with this device's own switch on", async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(home.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  laptop.manager.send(home.id, TOOL_CALL('backwards'));
  world.run(1);
  assert.deepEqual(toolFrames(home), []);
  assert.equal(home.refusals.length, 1);
  assert.match(home.refusals[0].reason, /doesn't take/);
  assert.match(home.manager.toolCallRefusal(laptop.id), /doesn't take/);
  const [{ frame }] = toolFrames(laptop);
  assert.equal(frame.ok, false);
});

test('a device nobody knows has no answer about what it may ask', async (t) => {
  const { laptop } = await connected(t);
  assert.ok(laptop.manager.toolCallRefusal('no-such-device'));
});

test("a tool call with an id it can't answer to gets no answer, and is still recorded", async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  for (const id of ['a b', '', 'x'.repeat(65), 7, null]) home.manager.send(laptop.id, { ...TOOL_CALL(), id });
  world.run(1);
  assert.deepEqual(toolFrames(laptop), []);
  assert.deepEqual(toolFrames(home), []);
  assert.equal(laptop.refusals.length, 5);
});

test('a device owing a PIN refuses a tool call, whatever its switch says', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  // The one way to get there with the switch already on: the keystore no longer says a person set it.
  laptop.keystore.pinKind = () => 'device';
  assert.equal(laptop.manager.status().needsPin, true);
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  assert.deepEqual(toolFrames(laptop), []);
  assert.match(laptop.refusals[0].reason, /PIN/);
  assert.match(toolFrames(home)[0].frame.result.error, /PIN/);
});

test('an idle-locked laptop keeps taking tool calls and answering them', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  laptop.manager.lock();
  assert.equal(laptop.manager.status().idleLocked, true);

  home.manager.send(laptop.id, TOOL_CALL('locked'));
  world.run(1);
  assert.deepEqual(toolFrames(laptop).map(({ frame }) => frame.id), ['locked']);

  assert.equal(laptop.manager.send(home.id, { type: 'tool-result', id: 'locked', result: { a: 1 }, summary: 's', ok: true }), true);
  assert.equal(laptop.manager.send(home.id, { type: 'control-state', allowed: true, mcpTools: [], os: 'win32', shell: 'Bash' }), true);
  world.run(1);
  const got = home.frames.map(({ frame }) => frame.type);
  assert.ok(got.includes('tool-result') && got.includes('control-state'), got.join());

  // Turning it off still works, and takes effect.
  assert.deepEqual(laptop.manager.setControlAllowed(false, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL('after'));
  world.run(1);
  assert.deepEqual(toolFrames(laptop).filter(({ frame }) => frame.type === 'tool-call').map(({ frame }) => frame.id), ['locked']);
});

test('while locked a tool result may be 8 MiB, on the plain copy, and nothing else gets past 64 KiB', async (t) => {
  const { world, home, laptop } = await connected(t);
  laptop.manager.lock();
  const pad = (size) => 'x'.repeat(size);
  assert.equal(laptop.manager.send(home.id, { type: 'tool-result', id: 'r1', result: { text: pad(7 * MIB) }, summary: '', ok: true }), true);
  assert.equal(laptop.manager.send(home.id, { type: 'tool-result', id: 'r2', result: { text: pad(8 * MIB) }, summary: '', ok: true }), false);
  assert.equal(laptop.manager.send(home.id, { type: 'tool-result', id: 'r3', result: { text: 'é'.repeat(4.2 * MIB) }, summary: '', ok: true }), false, 'counted in bytes');
  assert.equal(laptop.manager.send(home.id, { type: 'control-state', allowed: true, mcpTools: [pad(70 * 1024)] }), false);
  assert.equal(laptop.manager.send(home.id, { type: 'mirror-part-ack', pad: pad(70 * 1024) }), false);
  assert.equal(laptop.manager.send(home.id, { type: 'action', id: 'a', kind: 'stop', chatId: 'c' }), false);
  assert.equal(laptop.manager.send(home.id, { type: 'tool-call', id: 'x', name: 'run_command', args: {} }), false);
  assert.equal(laptop.manager.send(home.id, { type: new String('tool-result'), id: 'r4' }), false); // eslint-disable-line no-new-wrappers
  world.run(1);
  assert.deepEqual(home.frames.filter(({ frame }) => frame.type === 'tool-result').map(({ frame }) => frame.id), ['r1']);
});

test("a locked device with laptops of its own can stop a call, and can't start one", async (t) => {
  const world = newWorld(t);
  const above = await world.device('Above');
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(above, home);
  seedPair(home, laptop);
  above.start();
  home.start();
  laptop.start();
  world.relay.pump();
  assert.equal(home.entry(above.id).connected, true);
  assert.equal(home.entry(laptop.id).connected, true);
  home.manager.lock();
  assert.equal(home.manager.status().idleLocked, true);
  assert.equal(home.manager.send(laptop.id, TOOL_CALL()), false);
  assert.equal(home.manager.send(laptop.id, { type: 'tool-cancel', id: 'call1' }), true);
  world.run(1);
  assert.ok(laptop.frames.some(({ frame }) => frame.type === 'tool-cancel'));
});

// Everything sent from here on goes nowhere, as if the other end had vanished without a word.
function losingEverything(world, ms, stopWhen = () => false) {
  const { drop } = world.relay;
  world.relay.drop = () => true;
  world.relay.pump();
  let elapsed = 0;
  while (elapsed < ms && !stopWhen()) {
    world.clock.advance(100);
    elapsed += 100;
  }
  world.relay.drop = drop;
  return elapsed;
}

test('while a call is out, a device that goes quiet shows as quiet within 5 seconds, and stays connected', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  assert.equal(home.entry(laptop.id).quiet, false);

  // Busy isn't gone: it answers its probes for as long as anyone likes.
  world.run(20000);
  assert.equal(home.entry(laptop.id).quiet, false, 'a working device is not quiet');

  // Now a closed lid, a lost network, or a direct path that has died with nothing to say so.
  const before = home.statuses.length;
  const took = losingEverything(world, 10000, () => home.entry(laptop.id).quiet);
  assert.ok(took <= 5000, `took ${took} ms`);
  const entry = home.statuses.at(-1).devices.find((d) => d.id === laptop.id);
  assert.equal(entry.quiet, true, 'a status said so');
  assert.equal(entry.connected, true, 'and being quiet is not being offline, so it costs no snapshot');
  assert.ok(home.statuses.length > before);
  assert.ok(home.statuses.slice(before).every((s) => s.devices.find((d) => d.id === laptop.id).connected), 'connected never changed');

  // Hearing from it again ends that, on the same session.
  world.run(16000);
  assert.equal(home.entry(laptop.id).quiet, false);
  assert.equal(home.entry(laptop.id).connected, true);
});

test('quiet for 30 s says so separately, which is what ends a command, and nothing short of that does', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  losingEverything(world, 29000);
  assert.equal(laptop.entry(home.id).quiet, true);
  assert.equal(laptop.entry(home.id).longQuiet, false, 'not yet');
  losingEverything(world, 1500);
  const entry = laptop.entry(home.id);
  assert.equal(entry.longQuiet, true);
  assert.equal(entry.connected, true);
  assert.equal(laptop.statuses.at(-1).devices.find((d) => d.id === home.id).longQuiet, true, 'and a status said so');

  world.run(16000);
  assert.equal(laptop.entry(home.id).quiet, false);
  assert.equal(laptop.entry(home.id).longQuiet, false, 'hearing from it ends both');
});

test('a device that stalled itself does not blame the other end', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1500);
  // Everything from the other end has been waiting to be read while this one wasn't running.
  world.clock.stall(4500);
  world.clock.advance(1000);
  assert.equal(home.entry(laptop.id).quiet, false, 'its own late timer is no sign of anything');
  world.run(1000);
  assert.equal(home.entry(laptop.id).quiet, false);
});

test('anything heard over the direct path counts', async (t) => {
  const world = newWorld(t);
  const home = await world.device('Home');
  const laptop = await world.device('Laptop');
  seedPair(home, laptop);
  home.direct = fakeDirect();
  laptop.direct = fakeDirect();
  home.createDirect = home.direct.create;
  laptop.createDirect = laptop.direct.create;
  home.start();
  laptop.start();
  world.relay.pump();
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.direct.callbacks.onOpen(laptop.id);
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);

  // The relay carries nothing from here on, and only what this test hands over crosses by direct.
  world.relay.drop = () => true;
  const before = home.statuses.length;
  for (let i = 0; i < 80; i++) {
    world.clock.advance(100);
    home.direct.callbacks.onData(laptop.id, Uint8Array.of(9, 9, 9));
  }
  assert.equal(home.entry(laptop.id).quiet, false, 'it was being heard from');
  assert.ok(home.statuses.slice(before).every((s) => !s.devices.find((d) => d.id === laptop.id).quiet));
  for (let i = 0; i < 50; i++) world.clock.advance(100);
  assert.equal(home.entry(laptop.id).quiet, true, 'and this test does tell silence apart');
});

test('each end answers a probe with a heartbeat of its own', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  const dataFrom = (device, to) => linkMessages(world.relay, device.id, to.id).filter((m) => fromRelayB64(m.data.b)[0] === DATA).length;
  const before = dataFrom(laptop, home);
  world.run(5000); // no heartbeat of the regular kind falls due in this
  // Its own probe once a second, and one answer to each of the other end's.
  const sent = dataFrom(laptop, home) - before;
  assert.ok(sent >= 8 && sent <= 12, `${sent} data frames in 5 s`);
});

test('a laptop running a call notices its home PC going quiet too', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  const took = losingEverything(world, 10000, () => laptop.entry(home.id).quiet);
  assert.ok(took <= 5000, `took ${took} ms`);
  assert.equal(laptop.entry(home.id).connected, true);
});

test('with no call out, nothing watches, and nothing extra goes over the relay', async (t) => {
  const { world, home, laptop } = await connected(t);
  world.run(1);
  const before = world.relay.log.length;
  world.run(5000);
  assert.equal(world.relay.log.length, before);
  losingEverything(world, 14000);
  assert.equal(home.entry(laptop.id).quiet, false, 'silence means nothing with no call out');
});

test('a result ends the watching, and so does a cancel with nothing left out', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL('first'));
  world.run(1);
  laptop.manager.send(home.id, { type: 'tool-result', id: 'first', result: {}, summary: '', ok: true });
  world.run(1);
  world.run(1100); // one tick for each end to notice
  const count = world.relay.log.length;
  world.run(4000);
  assert.equal(world.relay.log.length, count, 'no probes once it has answered');

  home.manager.send(laptop.id, TOOL_CALL('second'));
  world.run(1);
  home.manager.send(laptop.id, { type: 'tool-cancel', id: 'second' });
  laptop.manager.send(home.id, { type: 'tool-result', id: 'second', result: {}, summary: '', ok: false });
  world.run(1);
  world.run(1100);
  const later = world.relay.log.length;
  world.run(4000);
  assert.equal(world.relay.log.length, later);
});

test('a call that never gets an answer stops being watched in the end', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  home.manager.send(laptop.id, TOOL_CALL());
  world.run(1);
  world.run(6 * MINUTES);
  const count = world.relay.log.length;
  world.run(2000);
  assert.equal(world.relay.log.length, count, 'nothing but heartbeats, and none are due in this gap');
  assert.equal(home.entry(laptop.id).connected, true);
});

test('a tool call from a home PC gets through unchanged', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  const frame = TOOL_CALL('whole');
  home.manager.send(laptop.id, frame);
  world.run(1);
  assert.deepEqual(toolFrames(laptop)[0].frame, frame);
});

test('the watch timer goes when a call ends it, and when the session does', async (t) => {
  const { world, home, laptop } = await connected(t);
  assert.deepEqual(laptop.manager.setControlAllowed(true, { fromLocalUi: true }), { ok: true });
  world.run(1);
  const before = world.clock.pendingTimers();
  home.manager.send(laptop.id, TOOL_CALL('a'));
  world.run(1);
  assert.equal(world.clock.pendingTimers(), before + 2, 'one timer watching at each end');

  // The session goes under it, and no timer is left behind.
  laptop.manager.shutdown();
  home.manager.shutdown();
  assert.equal(world.clock.pendingTimers(), 0, 'nothing is left running after a session ends');
});

test('refreshStatus tells listeners again, without using up what status() reports once', async (t) => {
  const { laptop } = await connected(t);
  const before = laptop.statuses.length;
  laptop.manager.refreshStatus();
  assert.equal(laptop.statuses.length, before + 1);
  laptop.manager.shutdown();
  laptop.manager.refreshStatus();
  assert.equal(laptop.statuses.length, before + 1);
});
