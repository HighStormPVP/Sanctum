// The link layer: ordered, exactly-once delivery of opaque frames over two paths,
// a WebSocket relay and a WebRTC data channel. No Electron and no timers here, so
// test/remote-link.test.js runs it under plain Node.
//
// The link knows nothing about encryption. A frame is bytes in and the same bytes
// out, and a resend is byte-identical to the original because the buffer keeps the
// encoded wire frame, never re-encodes it. lib/remote/session.js decrypts above it.
//
// Wire format, 13 bytes of header then the payload:
//
//   [0]      type: 1 = data, 2 = ack
//   [1..4]   connection id: opaque, 4 bytes, the same on both ends
//   [5..12]  big-endian unsigned sequence number
//   [13..]   data: the caller's bytes. ack: nothing.
//
// An ack carries the next sequence number the receiver expects, which means "I have
// every frame before this one". It is cumulative, so a lost ack is covered by any
// later one. Acks are not themselves acknowledged, and they go out on whatever path
// is current. Both sides may receive on either path at any time, so a frame sent on
// both during a switch is delivered once and the second copy is dropped.
//
// The connection id keeps a new connection apart from the old one. Frames still in
// flight when reset() runs can't be recalled, and without an id a stale seq-0 frame
// would take the new stream's slot 0 and a stale ack would trim new frames from the
// buffer. A frame or ack with the wrong id is dropped before it touches any state.
// The manager derives the id from the session handshake and gives the same one to
// both ends: createLink({ ..., connectionId }) and reset(connectionId).
// The relay is untrusted and can forge these headers, so a matching id is not
// authentication. At worst a forged frame can stall the connection, which a relay
// can already do by dropping traffic. Don't rely on the id for security; the session
// layer's encryption is what authenticates.
//
// Sent frames stay in a buffer until acknowledged. Both buffers are bounded by
// bytes, charging each entry its wire size plus a fixed ENTRY_OVERHEAD so that
// empty frames aren't free, and by entry count. They are resent on every path
// change (everything unacknowledged), and by tick() for the head of the buffer only:
// at most TICK_WINDOW_FRAMES frames or TICK_WINDOW_BYTES, each frame backing off
// from 3 s to 30 s. Nothing here sets a timer: the caller drives tick().
//
// Overflow is tracked separately in each direction, and each asks for a resync once
// via onResyncNeeded.
//   Send side: the buffer would pass its caps. The stream can no longer be kept
//   whole, so send() returns false until reset(). The caller is expected to reset()
//   both ends and rebuild state from a snapshot.
//   Receive side: an early frame is too far ahead of the next expected one, or the
//   held frames would pass their caps. That frame is dropped. It is never
//   acknowledged, so the peer still has it and resends it, and this direction
//   recovers on its own; send() is unaffected. The request is advisory, and fires
//   again only once the stream has advanced and the held frames have drained.
//
// reset() is for a new connection and clears both directions. It leaves the path
// state alone, since which transports are up isn't part of the connection.

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const ENTRY_OVERHEAD = 64; // charged per buffered frame on top of its wire size
const MAX_ENTRIES = 65536; // frames the send buffer holds
const MAX_WINDOW = 16384; // how far past the next expected seq a frame may be held

const RESEND_AFTER_MS = 3000; // first tick() resend, and the backoff base
const RESEND_MAX_MS = 30000; // backoff ceiling
const TICK_WINDOW_FRAMES = 64;
const TICK_WINDOW_BYTES = 1024 * 1024;

const TYPE_DATA = 1;
const TYPE_ACK = 2;
const ID_LENGTH = 4;
const HEADER = 1 + ID_LENGTH + 8;
const SEQ_LIMIT = 2 ** 53; // sequence numbers stay exact integers

function copyId(id) {
  if (!(id instanceof Uint8Array) || id.length !== ID_LENGTH) throw new TypeError('connectionId is ' + ID_LENGTH + ' bytes');
  return Uint8Array.from(id);
}

function encode(type, id, seq, bytes) {
  const size = bytes ? bytes.length : 0;
  const frame = new Uint8Array(HEADER + size);
  const view = new DataView(frame.buffer);
  frame[0] = type;
  frame.set(id, 1);
  view.setUint32(1 + ID_LENGTH, Math.floor(seq / 2 ** 32));
  view.setUint32(5 + ID_LENGTH, seq % 2 ** 32);
  if (size) frame.set(bytes, HEADER);
  return frame;
}

// Returns { type, seq, payload } or null for anything that isn't a well-formed frame
// of this connection.
function decode(frame, id) {
  if (!(frame instanceof Uint8Array) || frame.length < HEADER) return null;
  const type = frame[0];
  if (type !== TYPE_DATA && type !== TYPE_ACK) return null;
  for (let i = 0; i < ID_LENGTH; i++) if (frame[1 + i] !== id[i]) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = view.getUint32(1 + ID_LENGTH) * 2 ** 32 + view.getUint32(5 + ID_LENGTH);
  if (seq >= SEQ_LIMIT) return null;
  return { type, seq, payload: frame.slice(HEADER) };
}

function createLink({ sendRelay, sendDirect = null, onFrame, onPathChange, onResyncNeeded, connectionId = new Uint8Array(ID_LENGTH), now = Date.now }) {
  let id = copyId(connectionId);
  const hasRelay = typeof sendRelay === 'function';
  const hasDirect = typeof sendDirect === 'function';
  let relayOk = hasRelay;
  let directOk = false;
  let path = computePath();

  // Sending.
  let nextSeq = 0;
  const unacked = new Map(); // seq -> { wire, cost, due, attempts }, in sequence order
  let bufferedBytes = 0;
  let sendOverflow = false;

  // Receiving.
  let expected = 0;
  const held = new Map(); // seq -> payload, for frames that arrived early
  let heldBytes = 0;
  let recvOverflow = false;

  function computePath() {
    if (directOk && hasDirect) return 'direct';
    if (relayOk && hasRelay) return 'relay';
    return 'offline';
  }

  // A transport that throws (a socket closing under us) just means the frame didn't
  // go. It's still in the buffer, so a path change or tick() sends it again.
  function transmit(wire) {
    try {
      if (path === 'direct') sendDirect(wire);
      else if (path === 'relay') sendRelay(wire);
    } catch { /* resent later */ }
  }

  function resendAll() {
    if (path === 'offline') return;
    const t = now();
    for (const entry of unacked.values()) {
      entry.due = t + RESEND_AFTER_MS;
      entry.attempts = 0;
      transmit(entry.wire);
    }
  }

  function updatePath() {
    const next = computePath();
    if (next === path) return;
    path = next;
    resendAll();
    if (onPathChange) onPathChange(path);
  }

  function sendAck() {
    transmit(encode(TYPE_ACK, id, expected, null));
  }

  function handleAck(seq) {
    if (seq > nextSeq) return; // acknowledges frames we never sent
    for (const [s, entry] of unacked) {
      if (s >= seq) break;
      unacked.delete(s);
      bufferedBytes -= entry.cost;
    }
  }

  function handleData(seq, payload, cost) {
    const ready = [];
    if (seq === expected) {
      ready.push(payload);
      expected++;
      while (held.has(expected)) {
        const next = held.get(expected);
        held.delete(expected);
        heldBytes -= next.cost;
        ready.push(next.payload);
        expected++;
      }
    } else if (seq > expected && !held.has(seq)) {
      if (seq - expected > MAX_WINDOW || heldBytes + cost > MAX_BUFFER_BYTES) {
        // Dropped and never acknowledged, so the peer resends it.
        if (!recvOverflow) {
          recvOverflow = true;
          if (onResyncNeeded) onResyncNeeded();
        }
      } else {
        held.set(seq, { payload, cost });
        heldBytes += cost;
      }
    }
    if (ready.length > 0 && held.size === 0) recvOverflow = false;
    // Acknowledge even a duplicate: its ack may be what got lost.
    sendAck();

    // State is settled before any handler runs, so a handler that throws or calls
    // send() can't leave the link half-updated. Every ready frame still gets
    // delivered, and the first error is rethrown afterwards.
    let failure = null;
    for (const frame of ready) {
      try {
        onFrame(frame);
      } catch (err) {
        if (!failure) failure = { err };
      }
    }
    if (failure) throw failure.err;
  }

  function receive(frame) {
    const msg = decode(frame, id);
    if (!msg) return;
    if (msg.type === TYPE_ACK) handleAck(msg.seq);
    else handleData(msg.seq, msg.payload, frame.length + ENTRY_OVERHEAD);
  }

  return {
    // Returns true if the frame is buffered for delivery, false if it was refused
    // because the send buffer overflowed and the stream needs a resync.
    send(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('send takes a Uint8Array');
      if (sendOverflow) return false;
      const cost = HEADER + bytes.length + ENTRY_OVERHEAD;
      if (bufferedBytes + cost > MAX_BUFFER_BYTES || unacked.size >= MAX_ENTRIES) {
        sendOverflow = true;
        if (onResyncNeeded) onResyncNeeded();
        return false;
      }
      const wire = encode(TYPE_DATA, id, nextSeq, bytes);
      unacked.set(nextSeq, { wire, cost, due: now() + RESEND_AFTER_MS, attempts: 0 });
      bufferedBytes += cost;
      nextSeq++;
      transmit(wire);
      return true;
    },

    receiveFromRelay: receive,
    receiveFromDirect: receive,

    directUp() { directOk = true; updatePath(); },
    directDown() { directOk = false; updatePath(); },
    relayUp() { relayOk = true; updatePath(); },
    relayDown() { relayOk = false; updatePath(); },

    // Resends from the head of the buffer, the frames the receiver is waiting on:
    // at most TICK_WINDOW_FRAMES frames or TICK_WINDOW_BYTES (always at least one).
    // A frame in that window goes out again only once it is due, and each resend
    // doubles its wait, from 3 s up to 30 s.
    tick() {
      if (path === 'offline') return;
      const t = now();
      let frames = 0;
      let bytes = 0;
      for (const entry of unacked.values()) {
        if (frames >= TICK_WINDOW_FRAMES) break;
        if (frames > 0 && bytes + entry.wire.length > TICK_WINDOW_BYTES) break;
        frames++;
        bytes += entry.wire.length;
        if (t < entry.due) continue;
        entry.attempts++;
        entry.due = t + Math.min(RESEND_AFTER_MS * 2 ** entry.attempts, RESEND_MAX_MS);
        transmit(entry.wire);
      }
    },

    // A new connection. Pass the new connection id; frames carrying the old one are
    // dropped from here on. Omitting it keeps the current id.
    reset(connectionId) {
      if (connectionId !== undefined) id = copyId(connectionId);
      nextSeq = 0;
      unacked.clear();
      bufferedBytes = 0;
      sendOverflow = false;
      expected = 0;
      held.clear();
      heldBytes = 0;
      recvOverflow = false;
    },

    get path() { return path; },
  };
}

module.exports = {
  createLink,
  MAX_BUFFER_BYTES, ENTRY_OVERHEAD, MAX_ENTRIES, MAX_WINDOW,
  RESEND_AFTER_MS, RESEND_MAX_MS, TICK_WINDOW_FRAMES, TICK_WINDOW_BYTES,
};
