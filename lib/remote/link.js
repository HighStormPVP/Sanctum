// The link layer: ordered, exactly-once delivery of opaque frames over two paths,
// a WebSocket relay and a WebRTC data channel. No Electron and no timers here, so
// test/remote-link.test.js runs it under plain Node.
//
// The link knows nothing about encryption. A frame is bytes in and the same bytes
// out, and a resend is byte-identical to the original because the buffer keeps the
// encoded wire frame, never re-encodes it. lib/remote/session.js decrypts above it.
//
// Wire format, 9 bytes of header then the payload:
//
//   [0]     type: 1 = data, 2 = ack
//   [1..8]  big-endian unsigned sequence number
//   [9..]   data: the caller's bytes. ack: nothing.
//
// An ack carries the next sequence number the receiver expects, which means "I have
// every frame before this one". It is cumulative, so a lost ack is covered by any
// later one. Acks are not themselves acknowledged, and they go out on whatever path
// is current. Both sides may receive on either path at any time, so a frame sent on
// both during a switch is delivered once and the second copy is dropped.
//
// Sent frames stay in a buffer until acknowledged, capped at 64 MiB of payload.
// They are resent on every path change, and by tick() when one has gone unacked for
// a while. Nothing here sets a timer: the caller drives tick().
//
// Two things end up asking for a resync, once, via onResyncNeeded: the send buffer
// would pass its cap, or the receiver is holding more than the cap of out-of-order
// frames. Either way the stream can no longer be kept whole, so after a send-side
// overflow send() returns false until reset(). The caller is expected to reset()
// both ends and rebuild state from a snapshot.
//
// reset() is for a new connection and clears both directions. It leaves the path
// state alone, since which transports are up isn't part of the connection.
// Stale frames from the old connection that show up afterwards can't be told apart
// from new ones here, so the caller shouldn't feed the link until both ends reset.

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const RESEND_AFTER_MS = 3000;

const TYPE_DATA = 1;
const TYPE_ACK = 2;
const HEADER = 9;
const SEQ_LIMIT = 2 ** 53; // sequence numbers stay exact integers

function encode(type, seq, bytes) {
  const size = bytes ? bytes.length : 0;
  const frame = new Uint8Array(HEADER + size);
  const view = new DataView(frame.buffer);
  frame[0] = type;
  view.setUint32(1, Math.floor(seq / 2 ** 32));
  view.setUint32(5, seq % 2 ** 32);
  if (size) frame.set(bytes, HEADER);
  return frame;
}

// Returns { type, seq, payload } or null for anything that isn't a well-formed frame.
function decode(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < HEADER) return null;
  const type = frame[0];
  if (type !== TYPE_DATA && type !== TYPE_ACK) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const seq = view.getUint32(1) * 2 ** 32 + view.getUint32(5);
  if (seq >= SEQ_LIMIT) return null;
  return { type, seq, payload: frame.slice(HEADER) };
}

function createLink({ sendRelay, sendDirect = null, onFrame, onPathChange, onResyncNeeded, now = Date.now }) {
  const hasRelay = typeof sendRelay === 'function';
  const hasDirect = typeof sendDirect === 'function';
  let relayOk = hasRelay;
  let directOk = false;
  let path = computePath();

  // Sending.
  let nextSeq = 0;
  const unacked = new Map(); // seq -> { wire, size, sentAt }, in sequence order
  let bufferedBytes = 0;
  let resyncRequested = false;

  // Receiving.
  let expected = 0;
  const held = new Map(); // seq -> payload, for frames that arrived early
  let heldBytes = 0;

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
      entry.sentAt = t;
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

  function requestResync() {
    if (resyncRequested) return;
    resyncRequested = true;
    if (onResyncNeeded) onResyncNeeded();
  }

  function sendAck() {
    transmit(encode(TYPE_ACK, expected, null));
  }

  function handleAck(seq) {
    if (seq > nextSeq) return; // acknowledges frames we never sent
    for (const [s, entry] of unacked) {
      if (s >= seq) break;
      unacked.delete(s);
      bufferedBytes -= entry.size;
    }
  }

  function handleData(seq, payload) {
    const ready = [];
    if (seq === expected) {
      ready.push(payload);
      expected++;
      while (held.has(expected)) {
        const next = held.get(expected);
        held.delete(expected);
        heldBytes -= next.length;
        ready.push(next);
        expected++;
      }
    } else if (seq > expected && !held.has(seq)) {
      if (heldBytes + payload.length > MAX_BUFFER_BYTES) {
        requestResync();
      } else {
        held.set(seq, payload);
        heldBytes += payload.length;
      }
    }
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
    const msg = decode(frame);
    if (!msg) return;
    if (msg.type === TYPE_ACK) handleAck(msg.seq);
    else handleData(msg.seq, msg.payload);
  }

  return {
    // Returns true if the frame is buffered for delivery, false if it was refused
    // because the stream needs a resync.
    send(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('send takes a Uint8Array');
      if (resyncRequested) return false;
      if (bufferedBytes + bytes.length > MAX_BUFFER_BYTES) {
        requestResync();
        return false;
      }
      const wire = encode(TYPE_DATA, nextSeq, bytes);
      unacked.set(nextSeq, { wire, size: bytes.length, sentAt: now() });
      bufferedBytes += bytes.length;
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

    // Resends whatever has gone unacknowledged for a while, on the current path.
    tick() {
      if (path === 'offline') return;
      const t = now();
      for (const entry of unacked.values()) {
        if (t - entry.sentAt < RESEND_AFTER_MS) continue;
        entry.sentAt = t;
        transmit(entry.wire);
      }
    },

    reset() {
      nextSeq = 0;
      unacked.clear();
      bufferedBytes = 0;
      resyncRequested = false;
      expected = 0;
      held.clear();
      heldBytes = 0;
    },

    get path() { return path; },
  };
}

module.exports = { createLink, MAX_BUFFER_BYTES, RESEND_AFTER_MS };
