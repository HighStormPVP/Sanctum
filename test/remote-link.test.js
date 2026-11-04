const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  createLink, MAX_BUFFER_BYTES, ENTRY_OVERHEAD, MAX_ENTRIES, MAX_WINDOW,
  RESEND_AFTER_MS, RESEND_MAX_MS, TICK_WINDOW_FRAMES, TICK_WINDOW_BYTES,
} = require(path.join(__dirname, '..', 'lib', 'remote', 'link.js'));

const MIB = 1024 * 1024;
const HEADER = 13;
const ID_A = Uint8Array.from([1, 2, 3, 4]);
const ID_B = Uint8Array.from([5, 6, 7, 8]);

// One end of a connection. Each path is a queue, so a test decides what gets
// delivered, in what order, how many times, and what is lost in flight.
function endpoint({ direct = true, connectionId } = {}) {
  const ep = { relayOut: [], directOut: [], got: [], paths: [], resync: 0, clock: 0 };
  ep.link = createLink({
    sendRelay: (bytes) => ep.relayOut.push(bytes),
    sendDirect: direct ? (bytes) => ep.directOut.push(bytes) : null,
    onFrame: (bytes) => ep.got.push(bytes),
    onPathChange: (p) => ep.paths.push(p),
    onResyncNeeded: () => { ep.resync++; },
    connectionId,
    now: () => ep.clock,
  });
  return ep;
}

// Delivers everything queued on either path, in both directions, until the
// queues are empty. Acknowledgements travel the same queues.
function pump(a, b) {
  let moved = true;
  while (moved) {
    moved = false;
    for (const [from, to] of [[a, b], [b, a]]) {
      while (from.relayOut.length) { to.link.receiveFromRelay(from.relayOut.shift()); moved = true; }
      while (from.directOut.length) { to.link.receiveFromDirect(from.directOut.shift()); moved = true; }
    }
  }
}

// A payload that carries its index in the first four bytes.
const payload = (i) => Uint8Array.from([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255, i % 251, 0, 255]);
const indexOf = (bytes) => ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
const indexes = (ep) => ep.got.map(indexOf);
// A frame built by hand, so a test can put any sequence number on the wire.
function forge(type, id, seq, body = new Uint8Array(0)) {
  const frame = new Uint8Array(HEADER + body.length);
  const view = new DataView(frame.buffer);
  frame[0] = type;
  frame.set(id, 1);
  view.setUint32(5, Math.floor(seq / 2 ** 32));
  view.setUint32(9, seq % 2 ** 32);
  frame.set(body, HEADER);
  return frame;
}
const DATA = 1;
const ACK = 2;
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('a link starts on the relay, and the direct path takes over and gives back', () => {
  const a = endpoint();
  assert.strictEqual(a.link.path, 'relay');

  a.link.send(payload(0));
  assert.strictEqual(a.relayOut.length, 1);
  assert.strictEqual(a.directOut.length, 0);

  a.link.directUp();
  assert.strictEqual(a.link.path, 'direct');
  assert.deepStrictEqual(a.paths, ['direct']);

  a.relayOut.length = 0;
  a.directOut.length = 0;
  a.link.send(payload(1));
  assert.strictEqual(a.directOut.length, 1);
  assert.strictEqual(a.relayOut.length, 0);

  a.link.directUp(); // already up: nothing changes
  assert.deepStrictEqual(a.paths, ['direct']);

  a.link.directDown();
  assert.strictEqual(a.link.path, 'relay');
  assert.deepStrictEqual(a.paths, ['direct', 'relay']);
});

test('without a direct path, directUp changes nothing', () => {
  const a = endpoint({ direct: false });
  a.link.directUp();
  assert.strictEqual(a.link.path, 'relay');
  assert.deepStrictEqual(a.paths, []);
});

test('arbitrary bytes, including none, arrive unchanged', () => {
  const a = endpoint();
  const b = endpoint();
  const everything = Uint8Array.from({ length: 256 }, (_, i) => i);
  a.link.send(everything);
  a.link.send(new Uint8Array(0));
  a.link.send(Buffer.from('plain buffer'));
  pump(a, b);
  assert.strictEqual(b.got.length, 3);
  assert.deepStrictEqual(Array.from(b.got[0]), Array.from(everything));
  assert.strictEqual(b.got[1].length, 0);
  assert.strictEqual(Buffer.from(b.got[2]).toString(), 'plain buffer');
});

test('send takes bytes only, and a caller changing them afterwards changes nothing', () => {
  const a = endpoint();
  const b = endpoint();
  assert.throws(() => a.link.send('text'), TypeError);
  const bytes = Uint8Array.from([1, 2, 3]);
  a.link.send(bytes);
  bytes.fill(9);
  a.link.directUp();
  a.link.directDown(); // resends from the buffer
  pump(a, b);
  assert.deepStrictEqual(Array.from(b.got[0]), [1, 2, 3]);
});

test('directDown mid-stream, 1,000 frames in flight, delivers each once and in order', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.directUp();
  b.link.directUp();
  for (let i = 0; i < 1000; i++) a.link.send(payload(i));
  assert.strictEqual(a.directOut.length, 1000);

  // 400 get through; the other 600 are lost with the path.
  for (let i = 0; i < 400; i++) b.link.receiveFromDirect(a.directOut.shift());
  a.directOut.length = 0;
  b.directOut.length = 0; // the acknowledgements are lost too

  a.link.directDown();
  b.link.directDown();
  pump(a, b);

  assert.deepStrictEqual(indexes(b), range(1000));
});

test('every frame delivered twice, or in reversed blocks, still comes out once and in order', () => {
  const a = endpoint();
  const b = endpoint();
  for (let i = 0; i < 100; i++) a.link.send(payload(i));
  const frames = a.relayOut.splice(0);

  for (const f of frames) { b.link.receiveFromRelay(f); b.link.receiveFromRelay(f); }
  assert.deepStrictEqual(indexes(b), range(100));

  const c = endpoint();
  const blocks = [];
  for (let i = 0; i < frames.length; i += 10) blocks.push(...frames.slice(i, i + 10).reverse());
  for (const f of blocks) { c.link.receiveFromRelay(f); c.link.receiveFromRelay(f); }
  assert.deepStrictEqual(indexes(c), range(100));

  const d = endpoint();
  for (const f of [...frames].reverse()) d.link.receiveFromRelay(f);
  assert.deepStrictEqual(indexes(d), range(100));
});

test('both paths carrying the same frames during a switch gives no duplicates', () => {
  const a = endpoint();
  const b = endpoint();
  for (let i = 0; i < 50; i++) a.link.send(payload(i)); // on the relay, still in flight
  a.link.directUp(); // resends all 50 on direct
  for (let i = 50; i < 100; i++) a.link.send(payload(i)); // direct only
  a.link.directDown(); // resends what's unacknowledged on the relay
  b.link.directUp();
  // Everything that was ever sent on either path arrives, interleaved.
  const relay = a.relayOut.splice(0);
  const direct = a.directOut.splice(0);
  assert.ok(relay.length > 0 && direct.length > 0);
  for (let i = 0; i < Math.max(relay.length, direct.length); i++) {
    if (direct[i]) b.link.receiveFromDirect(direct[i]);
    if (relay[i]) b.link.receiveFromRelay(relay[i]);
  }
  pump(a, b);
  assert.deepStrictEqual(indexes(b), range(100));
});

test('a resent frame is byte-identical to the original', () => {
  const a = endpoint();
  a.link.send(Uint8Array.from([7, 7, 7, 0, 255]));
  const original = Array.from(a.relayOut[0]);
  a.link.directUp();
  assert.deepStrictEqual(Array.from(a.directOut[0]), original);
});

test('both paths down for a while, then the relay back: everything unacknowledged arrives once', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.directUp();
  b.link.directUp();
  for (let i = 0; i < 30; i++) a.link.send(payload(i));
  for (let i = 0; i < 10; i++) b.link.receiveFromDirect(a.directOut.shift());
  a.directOut.length = 0; // 20 lost in flight
  b.directOut.length = 0;

  a.link.directDown();
  a.relayOut.length = 0; // the relay died with them, so those resends are lost too
  a.link.relayDown();
  assert.strictEqual(a.link.path, 'offline');
  assert.deepStrictEqual(a.paths, ['direct', 'relay', 'offline']);

  for (let i = 30; i < 60; i++) a.link.send(payload(i)); // sent while offline
  assert.strictEqual(a.relayOut.length, 0);
  assert.strictEqual(a.directOut.length, 0);

  a.link.relayUp();
  assert.strictEqual(a.link.path, 'relay');
  assert.strictEqual(a.paths.at(-1), 'relay');
  pump(a, b);
  assert.deepStrictEqual(indexes(b), range(60));

  // Everything is acknowledged now, so a later path change resends nothing.
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 0);
});

test('when sendRelay is unavailable the link starts offline, and relayUp brings it online', () => {
  const paths = [];
  const link = createLink({ sendRelay: null, sendDirect: null, onFrame() {}, onPathChange: (p) => paths.push(p) });
  assert.strictEqual(link.path, 'offline');
  assert.strictEqual(link.send(payload(0)), true);
  link.relayUp(); // still no way to send
  assert.strictEqual(link.path, 'offline');
  assert.deepStrictEqual(paths, []);
});

test('direct up while the relay is down still works, and goes offline when it drops', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.relayDown();
  assert.strictEqual(a.link.path, 'offline');
  a.link.send(payload(0));
  a.link.directUp();
  assert.strictEqual(a.link.path, 'direct');
  a.link.directDown();
  assert.strictEqual(a.link.path, 'offline');
  a.link.relayUp();
  pump(a, b);
  assert.deepStrictEqual(indexes(b), [0]);
});

test('exceeding the 64 MiB buffer fires onResyncNeeded instead of growing', () => {
  const a = endpoint();
  const chunk = new Uint8Array(MIB);
  const fits = Math.floor(MAX_BUFFER_BYTES / (HEADER + MIB + ENTRY_OVERHEAD));
  assert.ok(fits >= 60 && fits < 64, 'headers and overhead count against the cap');
  for (let i = 0; i < fits; i++) assert.strictEqual(a.link.send(chunk), true);
  assert.strictEqual(a.resync, 0);

  assert.strictEqual(a.link.send(chunk), false);
  assert.strictEqual(a.resync, 1);
  assert.strictEqual(a.link.send(new Uint8Array(1)), false); // the stream is broken until reset
  assert.strictEqual(a.resync, 1, 'asked once, not on every send');

  // The buffer didn't grow: a path change resends exactly what was accepted.
  a.relayOut.length = 0;
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, fits);

  a.link.reset();
  a.relayOut.length = 0;
  assert.strictEqual(a.link.send(chunk), true);
  assert.strictEqual(a.relayOut.length, 1);
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 2); // 1 sent + 1 resent, so nothing old survived the reset
});

test('empty frames are not free: the send buffer caps their count', () => {
  const a = endpoint();
  const empty = new Uint8Array(0);
  for (let i = 0; i < MAX_ENTRIES; i++) assert.strictEqual(a.link.send(empty), true);
  assert.strictEqual(a.resync, 0);
  assert.strictEqual(a.link.send(empty), false);
  assert.strictEqual(a.resync, 1);
  a.relayOut.length = 0;
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, MAX_ENTRIES, 'the buffer did not grow past its cap');
});

test('a single frame bigger than the cap also asks for a resync', () => {
  const a = endpoint();
  assert.strictEqual(a.link.send(new Uint8Array(64 * MIB + 1)), false);
  assert.strictEqual(a.resync, 1);
});

test('acknowledged frames free the buffer', () => {
  const a = endpoint();
  const b = endpoint();
  const chunk = new Uint8Array(MIB);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 40; i++) assert.strictEqual(a.link.send(chunk), true);
    pump(a, b);
  }
  assert.strictEqual(a.resync, 0);
  assert.strictEqual(b.got.length, 120);
});

test('too many frames held waiting for a missing one asks for a resync', () => {
  const a = endpoint();
  const b = endpoint();
  const sink = endpoint(); // acknowledges for a, so a can send past its own cap
  const chunk = new Uint8Array(MIB);
  const frames = [];
  for (let i = 0; i < 66; i++) {
    a.link.send(chunk);
    const frame = a.relayOut.shift();
    frames.push(frame);
    sink.link.receiveFromRelay(frame);
    a.link.receiveFromRelay(sink.relayOut.shift());
  }
  for (const f of frames.slice(1)) b.link.receiveFromRelay(f); // frame 0 never comes
  assert.strictEqual(b.got.length, 0);
  assert.strictEqual(b.resync, 1);
});

test('tick resends what has gone unacknowledged for a while, and only that', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.send(payload(0));
  a.relayOut.length = 0; // lost

  a.clock = 1000;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 0, 'too soon');

  a.clock = 60000;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 1);

  a.link.tick();
  assert.strictEqual(a.relayOut.length, 1, 'just resent, so not again');

  pump(a, b);
  assert.deepStrictEqual(indexes(b), [0]);
  a.clock = 200000;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 0, 'acknowledged, so nothing to resend');
});

test('tick sends nothing while offline', () => {
  const a = endpoint();
  a.link.relayDown();
  a.link.send(payload(0));
  a.clock = 1e9;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 0);
});

test('a lost acknowledgement is repaired when the frame arrives again', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.send(payload(0));
  b.link.receiveFromRelay(a.relayOut.shift());
  b.relayOut.length = 0; // the ack is lost
  a.clock = 60000;
  a.link.tick(); // resend
  pump(a, b);
  assert.deepStrictEqual(indexes(b), [0]);
  // The sender now knows it arrived.
  a.clock = 200000;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 0);
});

test('acknowledgements are cumulative, so a later one covers an earlier lost one', () => {
  const a = endpoint();
  const b = endpoint();
  for (let i = 0; i < 5; i++) a.link.send(payload(i));
  for (const f of a.relayOut.splice(0)) b.link.receiveFromRelay(f);
  const acks = b.relayOut.splice(0);
  assert.strictEqual(acks.length, 5);
  a.link.receiveFromRelay(acks[4]); // only the last arrives
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 0);
});

test('acknowledgements work from either path', () => {
  const a = endpoint();
  const b = endpoint();
  a.link.send(payload(0));
  b.link.receiveFromRelay(a.relayOut.shift());
  a.link.receiveFromDirect(b.relayOut.shift()); // the ack came the other way
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 0);
});

test('reset starts both directions over', () => {
  const a = endpoint({ connectionId: ID_A });
  const b = endpoint({ connectionId: ID_A });
  for (let i = 0; i < 5; i++) a.link.send(payload(i));
  pump(a, b);
  a.link.send(payload(5));
  a.relayOut.length = 0; // sequence 5, never delivered

  a.link.reset(ID_B);
  b.link.reset(ID_B);
  b.got.length = 0;

  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 0, 'nothing from before the reset is resent');

  a.link.send(payload(100));
  a.link.send(payload(101));
  pump(a, b);
  assert.deepStrictEqual(indexes(b), [100, 101]);
});

test('reset clears frames held out of order', () => {
  const a = endpoint({ connectionId: ID_A });
  const b = endpoint({ connectionId: ID_A });
  for (let i = 0; i < 3; i++) a.link.send(payload(i));
  const frames = a.relayOut.splice(0);
  b.link.receiveFromRelay(frames[2]); // held
  b.link.reset(ID_B);
  a.link.reset(ID_B);
  a.link.send(payload(10));
  a.link.send(payload(11));
  a.link.send(payload(12));
  pump(a, b);
  assert.deepStrictEqual(indexes(b), [10, 11, 12]);
});

test('stale data frames replayed after reset take no sequence slot', () => {
  const a = endpoint({ connectionId: ID_A });
  const b = endpoint({ connectionId: ID_A });
  for (let i = 0; i < 5; i++) a.link.send(payload(i));
  const stale = a.relayOut.splice(0); // sequences 0 to 4 of the old connection, still in flight

  a.link.reset(ID_B);
  b.link.reset(ID_B);
  for (const f of stale) b.link.receiveFromRelay(f); // arrive late
  assert.deepStrictEqual(b.got, []);
  assert.strictEqual(b.relayOut.length, 0, 'not even acknowledged');

  for (let i = 100; i < 105; i++) a.link.send(payload(i));
  pump(a, b);
  assert.deepStrictEqual(indexes(b), range(5).map((i) => 100 + i), 'the genuine sequence 0 was not taken for a duplicate');

  for (const f of stale) b.link.receiveFromRelay(f); // and again, after the new stream is under way
  assert.strictEqual(b.got.length, 5);
});

test('stale acks replayed after reset trim nothing', () => {
  const a = endpoint({ connectionId: ID_A });
  const b = endpoint({ connectionId: ID_A });
  for (let i = 0; i < 5; i++) a.link.send(payload(i));
  for (const f of a.relayOut.splice(0)) b.link.receiveFromRelay(f);
  const staleAcks = b.relayOut.splice(0); // the last one says "I have 5"

  a.link.reset(ID_B);
  b.link.reset(ID_B);
  b.got.length = 0;
  for (let i = 0; i < 5; i++) a.link.send(payload(i));
  a.relayOut.length = 0; // lost
  for (const f of staleAcks) a.link.receiveFromRelay(f);
  for (const f of staleAcks) a.link.receiveFromDirect(f);

  a.clock = RESEND_AFTER_MS;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 5, 'all five are still unacknowledged');
  pump(a, b);
  assert.deepStrictEqual(indexes(b), range(5));
});

test('frames of another connection are dropped without touching state', () => {
  const a = endpoint({ connectionId: ID_A });
  a.link.send(payload(0));
  a.relayOut.length = 0;
  a.link.receiveFromRelay(forge(DATA, ID_B, 0, payload(9)));
  a.link.receiveFromRelay(forge(ACK, ID_B, 1));
  assert.deepStrictEqual(a.got, []);
  assert.strictEqual(a.relayOut.length, 0, 'no ack');
  a.link.receiveFromRelay(forge(DATA, ID_A, 0, payload(9)));
  assert.deepStrictEqual(indexes(a), [9], 'the matching id still works');
});

test('the connection id is 4 bytes', () => {
  const ok = { sendRelay() {}, onFrame() {} };
  for (const bad of [new Uint8Array(3), new Uint8Array(5), [1, 2, 3, 4], 'abcd', null]) {
    assert.throws(() => createLink({ ...ok, connectionId: bad }), TypeError);
  }
  const a = endpoint();
  assert.throws(() => a.link.reset(new Uint8Array(2)), TypeError);
  a.link.reset(); // no id: keeps the current one
  const copy = Uint8Array.from(ID_A);
  const c = endpoint({ connectionId: copy });
  copy.fill(0); // the caller's array isn't the link's
  c.link.send(payload(0));
  const b = endpoint({ connectionId: ID_A });
  b.link.receiveFromRelay(c.relayOut[0]);
  assert.deepStrictEqual(indexes(b), [0]);
});

test('far-ahead frames are dropped, and empty ones cannot fill memory', () => {
  const b = endpoint({ connectionId: ID_A });
  b.link.receiveFromRelay(forge(DATA, ID_A, 2 ** 40));
  b.link.receiveFromRelay(forge(DATA, ID_A, MAX_WINDOW + 1));
  assert.strictEqual(b.resync, 1);
  for (let seq = 1; seq <= 100000; seq++) b.link.receiveFromRelay(forge(DATA, ID_A, seq)); // all empty
  b.link.receiveFromRelay(forge(DATA, ID_A, 0));
  assert.strictEqual(b.got.length, MAX_WINDOW + 1, 'sequence 0 plus the MAX_WINDOW frames inside the window');
});

test('frames the receiver drops at a cap come back through resend', () => {
  const a = endpoint({ connectionId: ID_A });
  const b = endpoint({ connectionId: ID_A });
  const total = MAX_WINDOW + 3000;
  for (let i = 0; i < total; i++) a.link.send(payload(i));
  const frames = a.relayOut.splice(0);

  for (const f of frames.slice(1)) b.link.receiveFromRelay(f); // frame 0 is lost
  assert.strictEqual(b.got.length, 0);
  assert.strictEqual(b.resync, 1, 'the cap was hit');
  assert.strictEqual(a.link.send(payload(total)), true, 'the receiver overflowing does not stop this end sending');
  a.relayOut.length = 0;
  b.relayOut.length = 0;

  a.clock = RESEND_AFTER_MS;
  a.link.tick(); // resends frame 0 (and the rest of its window; the held ones are duplicates)
  pump(a, b);
  for (let i = 0; i < 200 && b.got.length <= total; i++) {
    a.clock += RESEND_AFTER_MS;
    a.link.tick();
    pump(a, b);
  }
  assert.deepStrictEqual(indexes(b), range(total + 1), 'everything, including the frame sent in between');
  assert.strictEqual(b.resync, 1);
  b.link.receiveFromRelay(frames[5]); // late duplicate
  assert.strictEqual(b.got.length, total + 1);
});

test('tick backs off per frame, from 3 s up to 30 s', () => {
  const a = endpoint();
  a.link.send(payload(0));
  a.relayOut.length = 0;
  const resends = [];
  for (let t = 0; t <= 200000; t += 500) {
    a.clock = t;
    a.link.tick();
    if (a.relayOut.length) { resends.push(t); a.relayOut.length = 0; }
  }
  assert.deepStrictEqual(resends, [3000, 9000, 21000, 45000, 75000, 105000, 135000, 165000, 195000]);
  assert.strictEqual(RESEND_MAX_MS, 30000);
});

test('a path change resets the backoff, and resends everything unacknowledged', () => {
  const a = endpoint();
  a.link.send(payload(0));
  for (const t of [3000, 9000, 21000, 45000]) { a.clock = t; a.link.tick(); }
  a.relayOut.length = 0;
  a.clock = 50000;
  a.link.directUp();
  a.link.directDown();
  assert.strictEqual(a.relayOut.length, 1);
  a.relayOut.length = 0;
  a.clock = 50000 + RESEND_AFTER_MS - 1;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 0);
  a.clock = 50000 + RESEND_AFTER_MS;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 1);
});

test('tick resends only a head-of-line window of frames', () => {
  const a = endpoint();
  for (let i = 0; i < 200; i++) a.link.send(payload(i));
  a.relayOut.length = 0;
  a.clock = RESEND_AFTER_MS;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, TICK_WINDOW_FRAMES);
  assert.deepStrictEqual(a.relayOut.map((f) => f[HEADER + 3]), range(TICK_WINDOW_FRAMES), 'the oldest ones');

  // A path change still resends the lot.
  a.relayOut.length = 0;
  a.link.relayDown();
  a.link.relayUp();
  assert.strictEqual(a.relayOut.length, 200);
});

test('tick resends at most about 1 MiB, and always at least one frame', () => {
  const a = endpoint();
  const size = 100000;
  const wire = HEADER + size;
  const fit = Math.floor(TICK_WINDOW_BYTES / wire);
  assert.ok(fit > 1 && fit < TICK_WINDOW_FRAMES);
  for (let i = 0; i < 30; i++) a.link.send(new Uint8Array(size));
  a.relayOut.length = 0;
  a.clock = RESEND_AFTER_MS;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, fit);

  const big = endpoint();
  big.link.send(new Uint8Array(2 * MIB));
  big.link.send(new Uint8Array(2 * MIB));
  big.relayOut.length = 0;
  big.clock = RESEND_AFTER_MS;
  big.link.tick();
  assert.strictEqual(big.relayOut.length, 1, 'a frame over the window still gets resent');
});

test('the acknowledged head moves the tick window along', () => {
  const a = endpoint();
  const b = endpoint();
  for (let i = 0; i < 150; i++) a.link.send(payload(i));
  const frames = a.relayOut.splice(0);
  for (const f of frames.slice(0, 100)) b.link.receiveFromRelay(f); // 100 arrive
  for (const f of b.relayOut.splice(0)) a.link.receiveFromRelay(f);
  a.clock = RESEND_AFTER_MS;
  a.link.tick();
  assert.strictEqual(a.relayOut.length, 50, 'only what is left, which fits the window');
  pump(a, b);
  assert.deepStrictEqual(indexes(b), range(150));
});

test('malformed input is ignored rather than thrown', () => {
  const a = endpoint();
  for (const junk of [new Uint8Array(0), Uint8Array.from([1]), Uint8Array.from([9, 0, 0, 0, 0, 0, 0, 0, 0, 1]), new Uint8Array(9).fill(255), 'text', null, undefined, 42]) {
    a.link.receiveFromRelay(junk);
    a.link.receiveFromDirect(junk);
  }
  assert.deepStrictEqual(a.got, []);
  a.link.send(payload(0));
  assert.strictEqual(a.relayOut.length, 1);
});

test('an acknowledgement for frames never sent is ignored', () => {
  const a = endpoint();
  const b = endpoint();
  for (let i = 0; i < 10; i++) b.link.send(payload(i));
  const farAhead = b.relayOut.splice(0);
  for (const f of farAhead) a.link.receiveFromRelay(f); // a's receiver is now at 10
  const ack = a.relayOut.pop(); // "I have 10"
  const c = endpoint();
  c.link.send(payload(0));
  c.link.receiveFromRelay(ack); // c has sent only 1
  c.link.relayDown();
  c.link.relayUp();
  assert.strictEqual(c.relayOut.length, 2, 'frame 0 is still unacknowledged');
});

test('a throw in onFrame does not lose the frames behind it', () => {
  const a = endpoint();
  const got = [];
  let boom = true;
  const b = createLink({
    sendRelay() {},
    onFrame: (bytes) => {
      if (boom) { boom = false; throw new Error('handler failed'); }
      got.push(indexOf(bytes));
    },
  });
  for (let i = 0; i < 3; i++) a.link.send(payload(i));
  const frames = a.relayOut.splice(0);
  b.receiveFromRelay(frames[1]);
  b.receiveFromRelay(frames[2]);
  assert.throws(() => b.receiveFromRelay(frames[0]), /handler failed/);
  assert.deepStrictEqual(got, [1, 2]);
  b.receiveFromRelay(frames[0]); // a duplicate now: not delivered again
  assert.deepStrictEqual(got, [1, 2]);
});

test('onFrame may send on the same link', () => {
  const b = endpoint();
  const echo = createLink({
    sendRelay: (bytes) => b.link.receiveFromRelay(bytes),
    onFrame: (bytes) => { echo.send(bytes); },
  });
  b.link.send(payload(1));
  echo.receiveFromRelay(b.relayOut.shift());
  assert.deepStrictEqual(indexes(b), [1]);
});
