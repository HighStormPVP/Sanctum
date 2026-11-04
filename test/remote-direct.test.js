// The direct path's rules, under plain Node with a fake hidden window and a fake clock:
// what goes to the window, what comes back, splitting, retries, and what it refuses. Real
// WebRTC in a real hidden window is e2e/direct.e2e.js.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createDirectPath, ICE_SERVERS, MAX_MESSAGE_BYTES, MAX_REASSEMBLED_BYTES,
  ATTEMPT_TIMEOUT_MS, RETRY_MAX_MS, STABLE_MS
} = require(path.join(__dirname, '..', 'lib', 'remote', 'direct-path.js'));

const ROOT = path.join(__dirname, '..');
const DEVICE = 'device-id-of-the-other-end';
const OTHER = 'device-id-of-a-third-device';
const KIB = 1024;

function fakeClock() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: time + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let next = null;
        for (const entry of timers) if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry;
        if (!next) break;
        time = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
      }
      time = end;
    },
    pending: () => timers.size
  };
}

// Stands in for main.js and the hidden window. Each window starts not ready, as a real one
// does until its page has loaded.
function fakeWindows() {
  const windows = {
    opened: [],
    refuse: false,
    open({ onEvent, onGone }) {
      if (windows.refuse) return null;
      const win = { commands: [], onEvent, onGone };
      windows.opened.push(win);
      return { send: (command) => win.commands.push(command) };
    },
    get current() {
      return windows.opened[windows.opened.length - 1];
    }
  };
  return windows;
}

function world(options = {}) {
  const clock = fakeClock();
  const windows = fakeWindows();
  const log = { signals: [], opens: [], closes: [], data: [] };
  const direct = createDirectPath({
    onSignal: (id, data) => log.signals.push({ id, data }),
    onOpen: (id) => log.opens.push(id),
    onClose: (id) => log.closes.push(id),
    onData: (id, bytes) => log.data.push({ id, bytes }),
    openTransport: windows.open,
    clock,
    ...options
  });
  const ready = () => windows.current.onEvent({ ev: 'ready' });
  const lastOpen = () => windows.current.commands.filter((c) => c.op === 'open').at(-1);
  const emit = (event) => windows.current.onEvent(event);
  return { clock, windows, log, direct, ready, lastOpen, emit };
}

// An initiator with its window ready and its channel open. Returns the channel's id.
function openInitiator(w, deviceId = DEVICE) {
  w.direct.connect(deviceId, true);
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'open', id });
  return id;
}

const offer = (attempt, sdp = 'v=0 offer') => ({ attempt, kind: 'offer', sdp });
const answer = (attempt, sdp = 'v=0 answer') => ({ attempt, kind: 'answer', sdp });
const candidate = (attempt, text = 'candidate:1 1 udp 1 192.0.2.1 5000 typ host') => ({
  attempt, kind: 'candidate', candidate: text, sdpMid: '0', sdpMLineIndex: 0
});

function sentMessages(win, id) {
  return win.commands.filter((c) => c.op === 'send' && c.id === id).map((c) => c.bytes);
}

test('uses the one STUN server and no TURN', () => {
  assert.deepEqual(ICE_SERVERS, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  assert.deepEqual(w.lastOpen().iceServers, ICE_SERVERS);
});

test('the window opens only when a connection first needs it, and one window serves every device', () => {
  const w = world();
  assert.equal(w.windows.opened.length, 0);
  w.direct.connect(DEVICE, true);
  assert.equal(w.windows.opened.length, 1);
  w.direct.connect(OTHER, true);
  assert.equal(w.windows.opened.length, 1);
  w.ready();
  assert.equal(w.windows.current.commands.filter((c) => c.op === 'open').length, 2);
});

test('commands wait for the page to say it is ready, then go in order', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  assert.deepEqual(w.windows.current.commands, []);
  w.ready();
  assert.deepEqual(w.windows.current.commands.map((c) => c.op), ['open']);
});

test('the side that initiates opens at once; the other side waits for an offer', () => {
  const w = world();
  w.direct.connect(DEVICE, false);
  assert.equal(w.windows.opened.length, 0);
  assert.equal(w.clock.pending(), 0);

  w.direct.signal(DEVICE, offer(1));
  w.ready();
  const { id, initiator } = w.lastOpen();
  assert.equal(initiator, false);
  assert.deepEqual(w.windows.current.commands.slice(1), [{ op: 'signal', id, data: { kind: 'offer', sdp: 'v=0 offer' } }]);
});

test("what the window sends to signal goes out carrying this attempt's number", () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'signal', id, data: { kind: 'offer', sdp: 'the offer' } });
  w.emit({ ev: 'signal', id, data: { kind: 'candidate', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(w.log.signals, [
    { id: DEVICE, data: { attempt: 1, kind: 'offer', sdp: 'the offer' } },
    { id: DEVICE, data: { attempt: 1, kind: 'candidate', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } }
  ]);
});

test('the window is never told which device it is carrying', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'open', id });
  w.direct.send(DEVICE, Uint8Array.of(1, 2, 3));
  w.direct.signal(DEVICE, answer(1));
  w.direct.close(DEVICE);
  const seen = JSON.stringify(w.windows.current.commands);
  assert.ok(!seen.includes(DEVICE));
  assert.ok(w.windows.current.commands.length >= 4);
});

test('open and closed are reported once each, for the right device', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  w.direct.connect(OTHER, true);
  const [first, second] = w.windows.current.commands.filter((c) => c.op === 'open');
  w.emit({ ev: 'open', id: second.id });
  assert.deepEqual(w.log.opens, [OTHER]);
  w.emit({ ev: 'open', id: first.id });
  w.emit({ ev: 'open', id: first.id });
  assert.deepEqual(w.log.opens, [OTHER, DEVICE]);
  w.emit({ ev: 'closed', id: first.id });
  w.emit({ ev: 'closed', id: first.id });
  assert.deepEqual(w.log.closes, [DEVICE]);
});

test('a channel that closes before it ever opened reports nothing, and is tried again', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'closed', id });
  assert.deepEqual(w.log.closes, []);
  w.clock.advance(2000);
  assert.notEqual(w.lastOpen().id, id);
});

test('close() ends it: the window is told, the close is reported, and no retry follows', () => {
  const w = world();
  const id = openInitiator(w);
  w.direct.close(DEVICE);
  assert.deepEqual(w.log.closes, [DEVICE]);
  assert.deepEqual(w.windows.current.commands.at(-1), { op: 'close', id });
  assert.equal(w.clock.pending(), 0);
  w.clock.advance(10 * 60 * 1000);
  assert.equal(w.windows.current.commands.filter((c) => c.op === 'open').length, 1);
});

test('connect() replaces whatever was there, starting the attempts over', () => {
  const w = world();
  const first = openInitiator(w);
  w.direct.connect(DEVICE, true);
  assert.deepEqual(w.log.closes, [DEVICE]);
  const { id } = w.lastOpen();
  assert.notEqual(id, first);
  w.emit({ ev: 'signal', id, data: { kind: 'offer', sdp: 's' } });
  assert.equal(w.log.signals.at(-1).data.attempt, 1);
});

test('events from a channel that has been replaced are dropped', () => {
  const w = world();
  const old = openInitiator(w);
  w.direct.connect(DEVICE, true);
  const { id } = w.lastOpen();
  const before = { opens: w.log.opens.length, closes: w.log.closes.length };

  w.emit({ ev: 'open', id: old });
  w.emit({ ev: 'closed', id: old });
  w.emit({ ev: 'data', id: old, bytes: Uint8Array.of(1, 9) });
  w.emit({ ev: 'signal', id: old, data: { kind: 'offer', sdp: 'stale' } });
  assert.equal(w.log.opens.length, before.opens);
  assert.equal(w.log.closes.length, before.closes);
  assert.deepEqual(w.log.data, []);
  assert.deepEqual(w.log.signals, []);
  assert.equal(w.lastOpen().id, id);
});

test('nonsense from the window is ignored', () => {
  const w = world();
  const id = openInitiator(w);
  const events = [
    null, 7, 'x', {}, { ev: 'open' }, { ev: 'nope', id },
    { ev: 'data', id, bytes: 'text' }, { ev: 'data', id },
    { ev: 'signal', id }, { ev: 'signal', id, data: { kind: 'bye' } },
    { ev: 'signal', id, data: { kind: 'answer', sdp: 5 } },
    { ev: 'data', id: 999, bytes: Uint8Array.of(1, 1) }
  ];
  for (const event of events) w.emit(event);
  assert.deepEqual(w.log.data, []);
  assert.deepEqual(w.log.signals, []);
  assert.deepEqual(w.log.closes, []);
});

// ---- Bytes ----

function roundTrip(size) {
  const w = world();
  const id = openInitiator(w);
  const bytes = new Uint8Array(crypto.randomBytes(size));
  w.direct.send(DEVICE, bytes);
  const messages = sentMessages(w.windows.current, id);
  for (const message of messages) w.emit({ ev: 'data', id, bytes: message });
  return { messages, bytes, received: w.log.data };
}

for (const size of [1, 13, MAX_MESSAGE_BYTES - 2, MAX_MESSAGE_BYTES - 1, MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES + 1, 256 * KIB + 45]) {
  test(`${size} bytes arrive whole, with no channel message over 64 KiB`, () => {
    const { messages, bytes, received } = roundTrip(size);
    assert.equal(MAX_MESSAGE_BYTES, 64 * KIB);
    for (const message of messages) assert.ok(message.length <= MAX_MESSAGE_BYTES, `${message.length}`);
    assert.equal(messages.length, Math.ceil(size / (MAX_MESSAGE_BYTES - 1)));
    assert.equal(received.length, 1);
    assert.equal(received[0].id, DEVICE);
    assert.ok(received[0].bytes instanceof Uint8Array);
    assert.deepEqual(Buffer.from(received[0].bytes), Buffer.from(bytes));
  });
}

test('messages from one device come back in order, and a Buffer works like any bytes', () => {
  const w = world();
  const id = openInitiator(w);
  w.emit({ ev: 'data', id, bytes: Buffer.from([1, 5]) });
  w.emit({ ev: 'data', id, bytes: Uint8Array.of(0, 6) });
  w.emit({ ev: 'data', id, bytes: Uint8Array.of(1, 7) });
  assert.deepEqual(w.log.data.map((d) => [...d.bytes]), [[5], [6, 7]]);
  assert.ok(w.log.data.every((d) => d.bytes.constructor === Uint8Array));
});

test('half a message is forgotten when its channel goes', () => {
  const w = world();
  const id = openInitiator(w);
  w.emit({ ev: 'data', id, bytes: Uint8Array.of(0, 1) });
  w.emit({ ev: 'closed', id });
  w.clock.advance(2000);
  const next = w.lastOpen().id;
  w.emit({ ev: 'open', id: next });
  w.emit({ ev: 'data', id: next, bytes: Uint8Array.of(1, 2) });
  assert.deepEqual(w.log.data.map((d) => [...d.bytes]), [[2]]);
});

test('a message past the size limit, or with an unknown marker, ends the channel, and it is tried again', () => {
  const part = new Uint8Array(MAX_MESSAGE_BYTES); // first byte 0: more to come
  const bad = [
    (w, id) => {
      for (let sent = 0; sent <= MAX_REASSEMBLED_BYTES; sent += part.length - 1) w.emit({ ev: 'data', id, bytes: part });
    },
    (w, id) => w.emit({ ev: 'data', id, bytes: Uint8Array.of(7, 1, 2) }),
    (w, id) => w.emit({ ev: 'data', id, bytes: new Uint8Array(0) }),
    (w, id) => w.emit({ ev: 'data', id, bytes: new Uint8Array(MAX_MESSAGE_BYTES + 1) })
  ];
  for (const flood of bad) {
    const w = world();
    const id = openInitiator(w);
    flood(w, id);
    assert.deepEqual(w.log.closes, [DEVICE]);
    assert.deepEqual(w.log.data, []);
    assert.ok(w.windows.current.commands.some((c) => c.op === 'close' && c.id === id));
    w.clock.advance(2000);
    assert.notEqual(w.lastOpen().id, id);
  }
});

test('sending with no open channel does nothing, and does not throw', () => {
  const w = world();
  w.direct.send(DEVICE, Uint8Array.of(1));
  w.direct.connect(DEVICE, true);
  w.ready();
  w.direct.send(DEVICE, Uint8Array.of(1));
  assert.ok(!w.windows.current.commands.some((c) => c.op === 'send'));
});

// ---- Retrying ----

test('retries back off from 2 seconds and stop growing at 60', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const delays = [];
  for (let i = 0; i < 8; i++) {
    const { id } = w.lastOpen();
    w.emit({ ev: 'closed', id });
    let waited = 0;
    while (w.lastOpen().id === id) {
      w.clock.advance(1000);
      waited += 1000;
      assert.ok(waited <= RETRY_MAX_MS, 'waited past the cap');
    }
    delays.push(waited);
  }
  assert.equal(RETRY_MAX_MS, 60000);
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test('an attempt that gets nowhere times out, closes in the window, and is retried', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.clock.advance(ATTEMPT_TIMEOUT_MS - 1);
  assert.ok(!w.windows.current.commands.some((c) => c.op === 'close'));
  w.clock.advance(1);
  assert.ok(w.windows.current.commands.some((c) => c.op === 'close' && c.id === id));
  assert.deepEqual(w.log.closes, []);
  w.clock.advance(2000);
  const next = w.lastOpen();
  assert.notEqual(next.id, id);
  w.emit({ ev: 'signal', id: next.id, data: { kind: 'offer', sdp: 's' } });
  assert.equal(w.log.signals.at(-1).data.attempt, 2);
});

test('a channel that opened in time does not time out', () => {
  const w = world();
  openInitiator(w);
  w.clock.advance(ATTEMPT_TIMEOUT_MS * 10);
  assert.deepEqual(w.log.closes, []);
});

test('a channel that stayed up for a while starts the backoff over; flapping does not', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const flap = (upFor) => {
    const { id } = w.lastOpen();
    w.emit({ ev: 'open', id });
    w.clock.advance(upFor);
    w.emit({ ev: 'closed', id });
    let waited = 0;
    while (w.lastOpen().id === id) {
      w.clock.advance(1000);
      waited += 1000;
    }
    return waited;
  };
  assert.equal(flap(100), 2000);
  assert.equal(flap(100), 4000);
  assert.equal(flap(100), 8000);
  assert.equal(flap(STABLE_MS - 1), 16000);
  assert.equal(flap(STABLE_MS), 2000);
});

test('the side that answers does not retry; it times out quietly and waits for the next offer', () => {
  const w = world();
  w.direct.connect(DEVICE, false);
  w.direct.signal(DEVICE, offer(1));
  w.ready();
  const { id } = w.lastOpen();
  w.clock.advance(ATTEMPT_TIMEOUT_MS);
  assert.ok(w.windows.current.commands.some((c) => c.op === 'close' && c.id === id));
  assert.equal(w.clock.pending(), 0);

  w.direct.signal(DEVICE, offer(2));
  assert.notEqual(w.lastOpen().id, id);
});

// ---- Signaling from the other end ----

test('an answer or candidate for this attempt reaches the window, without the attempt number', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.direct.signal(DEVICE, answer(1));
  w.direct.signal(DEVICE, candidate(1, 'cand'));
  assert.deepEqual(w.windows.current.commands.slice(1), [
    { op: 'signal', id, data: { kind: 'answer', sdp: 'v=0 answer' } },
    { op: 'signal', id, data: { kind: 'candidate', candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 } }
  ]);
});

test('signals for another attempt are dropped', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  w.direct.signal(DEVICE, answer(2));
  w.direct.signal(DEVICE, candidate(0));
  assert.equal(w.windows.current.commands.length, 1);
});

test('a newer offer replaces the channel, and an older one is dropped', () => {
  const w = world();
  w.direct.connect(DEVICE, false);
  w.direct.signal(DEVICE, offer(3));
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'open', id });

  const before = w.windows.current.commands.length;
  w.direct.signal(DEVICE, offer(2));
  w.direct.signal(DEVICE, offer(3));
  assert.equal(w.windows.current.commands.length, before);
  assert.deepEqual(w.log.closes, []);

  w.direct.signal(DEVICE, offer(4));
  assert.deepEqual(w.log.closes, [DEVICE]);
  assert.ok(w.windows.current.commands.some((c) => c.op === 'close' && c.id === id));
  assert.notEqual(w.lastOpen().id, id);

  w.direct.signal(DEVICE, candidate(3));
  assert.notEqual(w.windows.current.commands.at(-1).data?.kind, 'candidate');
  w.direct.signal(DEVICE, candidate(4));
  assert.equal(w.windows.current.commands.at(-1).data.kind, 'candidate');
});

test('each side only takes what its role expects', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  w.direct.signal(DEVICE, offer(1));
  w.direct.signal(DEVICE, offer(2));
  assert.equal(w.windows.current.commands.length, 1);

  const other = world();
  other.direct.connect(DEVICE, false);
  other.direct.signal(DEVICE, answer(1));
  other.direct.signal(DEVICE, candidate(1));
  assert.equal(other.windows.opened.length, 0);
});

test('signals that are not the right shape go no further, and a peer cannot add fields', () => {
  const w = world();
  w.direct.connect(DEVICE, true);
  w.ready();
  const bad = [
    undefined, null, 5, 'offer', [],
    {}, { attempt: 1 }, { attempt: 1, kind: 'answer' }, { attempt: 1, kind: 'answer', sdp: 5 },
    { attempt: '1', kind: 'answer', sdp: 's' }, { attempt: 1.5, kind: 'answer', sdp: 's' }, { attempt: -1, kind: 'answer', sdp: 's' },
    { attempt: 1, kind: 'bye', sdp: 's' }, { attempt: 1, kind: 'answer', sdp: 'x'.repeat(256 * KIB) },
    { attempt: 1, kind: 'candidate' }, { attempt: 1, kind: 'candidate', candidate: 5 },
    { attempt: 1, kind: 'candidate', candidate: 'x'.repeat(8 * KIB) },
    { attempt: 1, kind: 'candidate', candidate: 'c', sdpMid: 5, sdpMLineIndex: 0 },
    { attempt: 1, kind: 'candidate', candidate: 'c', sdpMid: '0', sdpMLineIndex: 'x' }
  ];
  for (const data of bad) w.direct.signal(DEVICE, data);
  assert.equal(w.windows.current.commands.length, 1);

  w.direct.signal(DEVICE, { attempt: 1, kind: 'answer', sdp: 's', evil: 'yes' });
  assert.deepEqual(w.windows.current.commands.at(-1).data, { kind: 'answer', sdp: 's' });
});

test('a signal for a device that has no connection is dropped', () => {
  const w = world();
  w.direct.signal(DEVICE, offer(1));
  assert.equal(w.windows.opened.length, 0);
});

test('blockCandidates sends none and takes none, so no path can form', () => {
  const w = world({ blockCandidates: true });
  w.direct.connect(DEVICE, true);
  w.ready();
  const { id } = w.lastOpen();
  w.emit({ ev: 'signal', id, data: { kind: 'offer', sdp: 's' } });
  w.emit({ ev: 'signal', id, data: { kind: 'candidate', candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(w.log.signals.map((s) => s.data.kind), ['offer']);
  w.direct.signal(DEVICE, candidate(1));
  assert.equal(w.windows.current.commands.length, 1);
});

// ---- The window going away ----

test('losing the window closes every channel, and the next try opens a new one', () => {
  const w = world();
  openInitiator(w);
  w.direct.connect(OTHER, false);
  const first = w.windows.current;
  first.onGone();
  assert.deepEqual(w.log.closes, [DEVICE]);
  assert.equal(w.windows.opened.length, 1);

  w.clock.advance(2000);
  assert.equal(w.windows.opened.length, 2);
  // Nothing reaches the new window before it's ready, and it carries on from there.
  assert.deepEqual(w.windows.current.commands, []);
  w.ready();
  assert.deepEqual(w.windows.current.commands.map((c) => c.op), ['open']);
  // Events from the old window mean nothing now.
  first.onEvent({ ev: 'open', id: w.lastOpen().id });
  assert.deepEqual(w.log.opens, [DEVICE]);
});

test('a page that loads again has lost its channels, and they are tried again', () => {
  const w = world();
  const id = openInitiator(w);
  w.ready();
  assert.deepEqual(w.log.closes, [DEVICE]);
  assert.ok(!w.windows.current.commands.some((c) => c.op === 'close'));
  w.clock.advance(2000);
  assert.notEqual(w.lastOpen().id, id);
});

test('no window available is not an error: the relay carries on and it tries again later', () => {
  const w = world();
  w.windows.refuse = true;
  w.direct.connect(DEVICE, true);
  assert.equal(w.windows.opened.length, 0);
  w.clock.advance(2000);
  assert.equal(w.windows.opened.length, 0);
  w.windows.refuse = false;
  w.clock.advance(4000);
  assert.equal(w.windows.opened.length, 1);

  // Nor does opening throwing take anything down.
  const broken = createDirectPath({
    onSignal() {}, onOpen() {}, onClose() {}, onData() {},
    openTransport: () => { throw new Error('no window'); },
    clock: fakeClock()
  });
  broken.connect(DEVICE, true);
  broken.signal(DEVICE, offer(1));
  broken.send(DEVICE, Uint8Array.of(1));
  broken.close(DEVICE);
});

test('a callback can close the path without leaving it half updated', () => {
  const clock = fakeClock();
  const windows = fakeWindows();
  const direct = createDirectPath({
    onSignal() {}, onOpen() {}, onData() {},
    onClose: (id) => direct.close(id),
    openTransport: windows.open,
    clock
  });
  direct.connect(DEVICE, true);
  windows.current.onEvent({ ev: 'ready' });
  const { id } = windows.current.commands[0];
  windows.current.onEvent({ ev: 'open', id });
  windows.current.onEvent({ ev: 'closed', id });
  assert.equal(clock.pending(), 0);
});

// ---- The hidden window's own files ----

test("the page's CSP is strict and its hash matches its one script, whatever the line endings", () => {
  const html = fs.readFileSync(path.join(ROOT, 'remote-transport.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  const directives = new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values];
  }));
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  // The HTML parser turns CRLF into LF before the browser hashes it, so a checkout with
  // either line ending runs.
  const text = scripts[0][1].replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('base64');
  assert.deepEqual(directives.get('script-src'), [`'sha256-${hash}'`], 'the script changed: update its hash in the CSP');
});

test('the preload exposes one small bridge, and neither file reaches for anything else', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'remote-transport-preload.js'), 'utf8');
  assert.deepEqual([...preload.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), ["'electron'"]);
  assert.equal([...preload.matchAll(/exposeInMainWorld\(/g)].length, 1);
  const html = fs.readFileSync(path.join(ROOT, 'remote-transport.html'), 'utf8');
  assert.ok(!/\brequire\s*\(/.test(html));
  assert.ok(!/\bipcRenderer\b/.test(html));
});

test("both of the hidden window's files ship in the build, and npm test stays out of e2e", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('remote-transport.html'));
  assert.ok(pkg.build.files.includes('remote-transport-preload.js'));
  assert.ok(pkg.build.files.includes('lib/**/*'));
  assert.equal(pkg.devDependencies['playwright-core'], '1.64.1');
  assert.equal(pkg.scripts.test, 'node --test test/');
});

test('direct-path.js does not need Electron', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'remote', 'direct-path.js'), 'utf8');
  assert.ok(!/require\(['"]electron['"]\)/.test(source));
});
