// The connection manager: this is where pairing, sessions, the link, the keystore and
// the relay become "these devices can talk". No Electron here. Its clients and clock are
// injected, so test/remote-manager.test.js runs it under plain Node.
//
// The layers, from the top down:
//
//   frames (JSON) -> splitting -> session.encrypt -> link.send -> relay client
//
// and the reverse on the way up. Handshake messages travel directly over the relay,
// beside the link, before the link starts. What goes in the relay's `data`:
//
//   { t:'session-hello' | 'session-auth', ... }   handshake, from session.js
//   { t:'link', b }                               one link frame, base64
//
// What's inside a session, as bytes, with the first byte saying which:
//
//   0  part of a frame, more to follow     1  the last part of a frame
//   2  heartbeat                           3  "I've removed you"
//
// Parts need no numbering, because send() queues all of a frame's parts at once and the
// link delivers in order, so they can't interleave.
//
// WHO CAN TALK. A message is looked at only if its sender is in `conns`, and `conns` is
// built from the keystore's peers, so unknown and removed devices get no work and no
// answer. A session is created only with the key listed for that device and while
// unlocked. The relay's `from` is only a routing hint: the relay is untrusted and can
// forge it, and what authenticates a device is its signature in the session handshake.
//
// A frame only ever reaches onFrame listeners. There's nothing here that a frame can
// call, and in particular no route to the control switch. The two control messages
// above do nothing but stay connected or forget the sender.
//
// LOCKING has two states, and the difference is whether the PIN has been entered since
// the app started.
//   Locked at start: nothing is available, because the identity and peers are sealed
//   under the PIN. No relay connection, no session, no pairing.
//   Idle-locked, from lock(): the keystore locks and PIN checks work as usual, but this
//   file keeps a private hold on the identity and peers, because the design says an
//   idle-locked device stays connected and reconnects by itself, and the home model can
//   still reach it. Only what keeps connections up may use the hold. Whatever a person
//   does stays refused until the PIN: codes, pairing, removing a device, changing the
//   address, and turning the control switch on. A wipe or shutdown drops the hold.
//
// A DEVICE THAT ONLY SERVES AS A HOME PC has nobody there to type a PIN, and it has to
// come back by itself after a reboot, but the keystore needs a PIN to seal the identity.
// So its first code makes a long random secret and uses that as the PIN, with the secret
// itself sealed by the system's secure storage in a file of its own. Such a device unlocks
// itself at start and never idle-locks. The first time it pairs with a home PC of its own,
// a person is there, so a real PIN replaces the secret and the file goes.
//
// A CONNECTION is one session and one link. Anything wrong with it (a decrypt failure,
// a full link, 45 seconds of silence) ends it and starts a new session, and frames still
// in the old link's buffers go with it. Connected going false and then true is how a
// layer above knows to rebuild its state from a snapshot.
//
// A hello is unsigned, so one arriving during a live session proves nothing. It gets its
// own session alongside, and the live one is only replaced once the new one authenticates.
// That way a forged hello can't end a working connection.
const nodeCrypto = require('node:crypto');
const { deviceIdFromPublicKey } = require('./crypto.js');
const { createSession } = require('./session.js');
const { createLink } = require('./link.js');
const { newCode, normalizeCode, createPairingHost, createPairingGuest } = require('./pairing.js');

const FRAME_PART_BYTES = 256 * 1024;
// Smaller than the link's 64 MiB buffer, so one frame can't overflow an empty link.
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

const KIND_MORE = 0;
const KIND_LAST = 1;
const KIND_HEARTBEAT = 2;
const KIND_REMOVED = 3;

const MSG_HELLO = 'session-hello';
const MSG_AUTH = 'session-auth';
const MSG_LINK = 'link';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RELAY_READY_TIMEOUT_MS = 20000;
// Up for this long counts as having worked, so the next drop starts the backoff over.
const RELAY_STABLE_MS = 30000;

const HANDSHAKE_TIMEOUT_MS = 20000;
// After an auth is refused. Long enough for a stale answer still in flight to land, so
// it can't refuse the next attempt too, and the two ends don't chase each other.
const REFUSED_RETRY_MS = 2000;
// Each hello that needs a new session costs a key agreement and a signature, and a
// hostile relay can send any number of them.
const MIN_NEW_SESSION_GAP_MS = 200;

const LINK_TICK_MS = 2000;
const HEARTBEAT_MS = 15000;
const NOTHING_DECRYPTED_MS = 45000;

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const NO_ATTEMPTS_GRACE_MS = 15000;
const PAIR_TIMEOUT_MS = 30000;
const FAILED_CODE_MEMORY_MS = 10 * 60 * 1000;
const PROVISIONAL_LIFETIME_MS = 10 * 60 * 1000;

const ROLE_HOME = 'home';
const ROLE_LAPTOP = 'laptop';

const NAME_MAX = 64;
const UNNAMED = 'Unnamed device';

// Digits, because that's what the keystore takes as a PIN. Forty is about 132 bits.
const AUTO_SECRET_DIGITS = 40;

const NOT_SET_UP = "Remote Control isn't set up on this device yet.";
const STORAGE_UNAVAILABLE = "Remote Control's keys can't be opened right now because the system's secure storage isn't available yet. Try again in a moment.";
const NEEDS_PIN = 'Set a PIN for this device before connecting it to a home PC.';
const NO_PIN_HERE = "This device doesn't use a PIN.";
const LOCKED = 'Remote Control is locked. Enter the PIN first.';
const WRONG_CODE_RETRY = "That code didn't work. Check it and try again.";
const WRONG_CODE_FINAL = "That code didn't work. Get a new one.";
const CODE_CANCELLED = 'That code was cancelled. Get a new one.';
const NO_ANSWER = "The home PC didn't answer. Check that the code is still showing, and try again.";
const STOPPED_ANSWERING = 'The home PC stopped answering. Get a new code and try again.';
const COULD_NOT_REACH = "Couldn't reach the Remote Control service. Check your connection, and try again.";
const ALREADY_PAIRING = 'Already connecting to a home PC.';
const SAME_DEVICE = 'That code is from this device. Enter it on the other one.';
const BAD_ADDRESS = "That doesn't look like a Remote Control address.";

const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle)
};

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

// Refuses any spelling but the canonical one. Buffer.from alone skips junk and
// takes the URL-safe alphabet, so the same bytes could arrive many ways.
function fromBase64(value) {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
}

function fingerprintOf(deviceId) {
  return `${deviceId.slice(0, 4)}-${deviceId.slice(4, 8)}`;
}

// A peer names itself, so this is untrusted text. Escaping it is the UI's job. Counted
// in characters, so an astral character is never cut in half.
function cleanName(name) {
  if (typeof name !== 'string') return UNNAMED;
  const trimmed = Array.from(name.trim()).slice(0, NAME_MAX).join('').trim();
  return trimmed || UNNAMED;
}

// The address is one path segment, the relay's secret, on a host. Returns it in its one
// spelling, or null. Plain ws would show the secret to the network, so it's only for
// this machine, which is how tests reach a local Worker.
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let scheme;
  if (url.protocol === 'wss:' || url.protocol === 'https:') scheme = 'wss:';
  else if ((url.protocol === 'ws:' || url.protocol === 'http:') && loopback) scheme = 'ws:';
  else return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  return `${scheme}//${url.host}/${segments[0]}`;
}

function createManager({ keystore, relay, addressStore, autoUnlock = null, clock = systemClock, deviceName = '' }) {
  const conns = new Map(); // deviceId -> connection, for every device allowed to talk
  const frameListeners = new Set();
  const statusListeners = new Set();
  // Removed but not yet written, because that needs the keystore unlocked. Kept out of
  // `conns` in the meantime.
  const pendingRemovals = new Set();
  // Proved themselves in a first session during an idle lock, and written at unlock.
  const pendingConfirms = new Set();
  const failedCodes = new Map(); // salted hash -> timer
  const failedCodeSalt = nodeCrypto.randomBytes(16);

  let address = loadAddress();
  let deviceClient = null;
  let relayReady = false;
  let relayReadyAt = null;
  let reconnects = 0;
  let reconnectTimer = null;
  let readyTimer = null;
  let hostPairing = null;
  let guestPairing = null;
  let lockEpoch = 0;
  let stopped = false;
  // { identity, peers }, only while idle-locked.
  let hold = null;
  // The keystore's PIN is the secret in autoUnlock's file, not one a person chose.
  let usesAutoSecret = false;
  // A pairing with a home PC asked for a PIN and hasn't had one yet.
  let pinRequested = false;
  let autoSecretInFlight = null;

  function loadAddress() {
    try {
      return normalizeAddress(addressStore.load());
    } catch {
      return null;
    }
  }

  function refreshStorage() {
    if (!keystore.isAvailable() && keystore.reload()) startAutoUnlock();
  }

  // Keeping connections up is the only thing the hold is for. Anything a person asks for
  // checks keystore.isUnlocked() or getIdentity() directly.
  function mayKeepConnections() {
    return keystore.isUnlocked() || hold !== null;
  }

  function connectionIdentity() {
    return keystore.getIdentity() ?? hold?.identity ?? null;
  }

  function hasUserPin() {
    return keystore.hasPin() && !usesAutoSecret;
  }

  // ---- Status ----

  function deviceEntry(conn) {
    const { peer, live } = conn;
    const up = Boolean(live) && live.link.path !== 'offline' && !live.peerAway;
    return {
      id: peer.deviceId,
      name: peer.name,
      role: peer.role,
      path: up ? live.link.path : 'offline',
      connected: up,
      fingerprint: fingerprintOf(peer.deviceId)
    };
  }

  function status() {
    refreshStorage();
    return {
      enabled: Boolean(address),
      locked: !keystore.isUnlocked(),
      idleLocked: hold !== null,
      hasPin: hasUserPin(),
      needsPin: pinRequested && !hasUserPin(),
      storageAvailable: keystore.isAvailable(),
      controlAllowed: keystore.getControlAllowed(),
      codePending: hostPairing !== null,
      devices: [...conns.values()].map(deviceEntry)
    };
  }

  function notify(listeners, ...args) {
    for (const listener of [...listeners]) {
      try {
        listener(...args);
      } catch { /* one listener's problem stays its own */ }
    }
  }

  function emitStatus() {
    if (!stopped && statusListeners.size) notify(statusListeners, status());
  }

  // ---- The relay connection ----

  function relaySend(deviceId, data) {
    if (relayReady && deviceClient) deviceClient.send(deviceId, data);
  }

  function clearRelayTimers() {
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer);
    if (readyTimer !== null) clock.clearTimeout(readyTimer);
    reconnectTimer = null;
    readyTimer = null;
  }

  function openRelay() {
    let client = null;
    const current = () => client !== null && deviceClient === client;
    try {
      client = relay.connectDevice({
        address,
        identity: connectionIdentity(),
        clock,
        onReady: () => {
          if (current()) relayIsUp();
        },
        onMessage: (from, data) => {
          if (current()) receiveFromRelay(from, data);
        },
        onOffline: (to) => {
          if (current()) peerIsAway(to);
        },
        onClose: () => {
          if (current()) relayIsDown();
        }
      });
    } catch {
      return scheduleReconnect();
    }
    deviceClient = client;
    readyTimer = clock.setTimeout(() => {
      readyTimer = null;
      closeDeviceClient();
      relayIsDown();
    }, RELAY_READY_TIMEOUT_MS);
  }

  function closeDeviceClient(options) {
    const client = deviceClient;
    deviceClient = null;
    if (client) client.close(options);
  }

  function relayIsUp() {
    relayReady = true;
    relayReadyAt = clock.now();
    clearRelayTimers();
    for (const conn of conns.values()) {
      if (conn.live) conn.live.link.relayUp();
      else startAttempt(conn, { announce: true });
    }
    emitStatus();
  }

  function relayIsDown() {
    deviceClient = null;
    relayReady = false;
    if (relayReadyAt !== null && clock.now() - relayReadyAt >= RELAY_STABLE_MS) reconnects = 0;
    relayReadyAt = null;
    clearRelayTimers();
    for (const conn of conns.values()) {
      clearAttempt(conn);
      // The session may yet survive this: if the relay comes back soon the link resends,
      // and if it doesn't, the heartbeat's timeout ends it.
      if (conn.live) conn.live.link.relayDown();
    }
    emitStatus();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopped || !address || conns.size === 0 || !mayKeepConnections() || reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnects, RECONNECT_MAX_MS);
    reconnects += 1;
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      syncRelay();
    }, delay);
  }

  // Opens the relay if there's someone to talk to and it's allowed, and closes it if
  // there's nobody left.
  function syncRelay(closeOptions) {
    if (stopped || !address || conns.size === 0) {
      clearRelayTimers();
      closeDeviceClient(closeOptions);
      relayReady = false;
      relayReadyAt = null;
      reconnects = 0;
      return;
    }
    if (!deviceClient && reconnectTimer === null && mayKeepConnections()) openRelay();
  }

  // ---- Connections ----

  // peer.role is what they are to me, and a session takes what I am to them.
  function ownRoleWith(peer) {
    return peer.role === ROLE_LAPTOP ? ROLE_HOME : ROLE_LAPTOP;
  }

  function clearAttempt(conn) {
    if (conn.attempt) clock.clearTimeout(conn.attempt.timer);
    if (conn.retryTimer !== null) clock.clearTimeout(conn.retryTimer);
    conn.attempt = null;
    conn.retryTimer = null;
  }

  function clearProvisionalTimer(conn) {
    if (conn.provisionalTimer !== null) clock.clearTimeout(conn.provisionalTimer);
    conn.provisionalTimer = null;
  }

  function stopLive(conn) {
    const { live } = conn;
    if (!live) return;
    conn.live = null;
    clock.clearInterval(live.heartbeatTimer);
    clock.clearInterval(live.tickTimer);
    clock.clearTimeout(live.watchdogTimer);
    live.parts = [];
  }

  function dropConn(conn) {
    clearAttempt(conn);
    clearProvisionalTimer(conn);
    stopLive(conn);
    if (conns.get(conn.peer.deviceId) === conn) conns.delete(conn.peer.deviceId);
  }

  // Makes `conns` match the peer list, which is sealed unless unlocked or held.
  function syncConns() {
    const known = keystore.isUnlocked() ? keystore.listPeers() : hold?.peers ?? [];
    const peers = known.filter((peer) => !pendingRemovals.has(peer.deviceId));
    const listed = new Set(peers.map((peer) => peer.deviceId));
    for (const conn of [...conns.values()]) {
      if (!listed.has(conn.peer.deviceId)) dropConn(conn);
    }
    for (const peer of peers) {
      let conn = conns.get(peer.deviceId);
      if (conn) {
        conn.peer = peer;
      } else {
        conn = { peer, attempt: null, retryTimer: null, provisionalTimer: null, live: null, lastNewSessionAt: -Infinity };
        conns.set(peer.deviceId, conn);
      }
      if (peer.provisional && conn.provisionalTimer === null) armProvisional(conn);
    }
  }

  function armProvisional(conn) {
    conn.provisionalTimer = clock.setTimeout(() => {
      conn.provisionalTimer = null;
      forgetPeer(conn);
      syncRelay();
      emitStatus();
    }, PROVISIONAL_LIFETIME_MS);
  }

  // The first session proves both ends finished pairing.
  function confirmPeer(conn) {
    if (!conn.peer.provisional) return;
    if (!keystore.isUnlocked()) {
      pendingConfirms.add(conn.peer.deviceId);
      clearProvisionalTimer(conn);
      return;
    }
    const { provisional, ...confirmed } = conn.peer;
    try {
      keystore.addPeer(confirmed);
    } catch {
      return; // stays provisional, and a later session tries again
    }
    conn.peer = confirmed;
    clearProvisionalTimer(conn);
  }

  // Writes it now if the keystore allows, and otherwise at the next unlock. Either way
  // the connection ends here, and syncConns won't bring it back.
  function forgetPeer(conn) {
    pendingRemovals.add(conn.peer.deviceId);
    pendingConfirms.delete(conn.peer.deviceId);
    dropConn(conn);
    flushRemovals();
  }

  function flushRemovals() {
    if (!keystore.isUnlocked()) return;
    for (const deviceId of [...pendingRemovals]) {
      try {
        keystore.removePeer(deviceId);
        pendingRemovals.delete(deviceId);
      } catch { /* kept out of `conns` for now, and tried again at the next unlock */ }
    }
  }

  function flushConfirms() {
    for (const deviceId of pendingConfirms) {
      const peer = keystore.listPeers().find((listed) => listed.deviceId === deviceId);
      if (!peer?.provisional) continue;
      const { provisional, ...confirmed } = peer;
      try {
        keystore.addPeer(confirmed);
      } catch { /* stays provisional, and syncConns gives it its 10 minutes again */ }
    }
    pendingConfirms.clear();
  }

  // A new session for this device. Returns null when one isn't allowed.
  function startAttempt(conn, { announce }) {
    clearAttempt(conn);
    const identity = connectionIdentity();
    if (!identity || !relayReady) return null;
    const session = createSession({ identity, peerPublicKey: conn.peer.publicKey, role: ownRoleWith(conn.peer) });
    conn.attempt = {
      session,
      timer: clock.setTimeout(() => {
        clearAttempt(conn);
        if (!conn.live) startAttempt(conn, { announce: true });
      }, HANDSHAKE_TIMEOUT_MS)
    };
    if (announce) relaySend(conn.peer.deviceId, session.hello);
    return conn.attempt;
  }

  function mayStartAnother(conn) {
    const t = clock.now();
    if (t - conn.lastNewSessionAt < MIN_NEW_SESSION_GAP_MS) return false;
    conn.lastNewSessionAt = t;
    return true;
  }

  // Waits for what's in flight to land before trying again. A hello arriving meanwhile
  // starts its own session, which clears this.
  function retryAfterRefusal(conn) {
    clearAttempt(conn);
    if (conn.live) return;
    conn.retryTimer = clock.setTimeout(() => {
      conn.retryTimer = null;
      startAttempt(conn, { announce: true });
    }, REFUSED_RETRY_MS);
  }

  function receiveHandshake(conn, msg) {
    if (!mayKeepConnections() || !relayReady) return;
    const isHello = msg.t === MSG_HELLO;

    if (!conn.attempt) {
      // An auth with no session waiting for it is late, and there's nothing to do with it.
      if (!isHello || !mayStartAnother(conn)) return;
      startAttempt(conn, { announce: false });
      if (!conn.attempt) return;
    }

    let result = conn.attempt.session.handleHello(msg);
    if (!result.ready && !result.reply) {
      // Refused, and a refused session is finished. A hello means the peer has started
      // over, so a new session answers it. A bad auth tells us nothing but to wait.
      if (!isHello || !mayStartAnother(conn)) return retryAfterRefusal(conn);
      startAttempt(conn, { announce: false });
      if (!conn.attempt) return;
      result = conn.attempt.session.handleHello(msg);
    }

    if (result.reply) relaySend(conn.peer.deviceId, result.reply);
    if (result.ready) goLive(conn, conn.attempt.session);
  }

  function armWatchdog(conn, live) {
    const wait = live.lastDecryptedAt + NOTHING_DECRYPTED_MS - clock.now();
    live.watchdogTimer = clock.setTimeout(() => {
      if (clock.now() - live.lastDecryptedAt >= NOTHING_DECRYPTED_MS) endLive(conn);
      else armWatchdog(conn, live);
    }, Math.max(wait, 0));
  }

  function goLive(conn, session) {
    clearAttempt(conn);
    if (conn.live) {
      stopLive(conn);
      emitStatus();
    }
    const { deviceId } = conn.peer;
    const live = { session, parts: [], partBytes: 0, lastDecryptedAt: clock.now(), peerAway: false };
    live.link = createLink({
      sendRelay: (bytes) => relaySend(deviceId, { t: MSG_LINK, b: toBase64(bytes) }),
      onFrame: (bytes) => receiveSealed(conn, live, bytes),
      onPathChange: emitStatus,
      // Advisory on the receive side: the peer resends what was dropped. A full send
      // buffer also lands here, and send() returning false is what handles that.
      onResyncNeeded: () => {},
      connectionId: session.connectionId,
      now: clock.now
    });
    conn.live = live;
    live.heartbeatTimer = clock.setInterval(() => sendSealed(conn, live, Uint8Array.of(KIND_HEARTBEAT)), HEARTBEAT_MS);
    live.tickTimer = clock.setInterval(() => live.link.tick(), LINK_TICK_MS);
    armWatchdog(conn, live);
    confirmPeer(conn);
    emitStatus();
  }

  // This connection is finished, for any reason. A new session follows, if one can.
  function endLive(conn) {
    stopLive(conn);
    if (mayKeepConnections()) {
      startAttempt(conn, { announce: true });
    } else {
      dropConn(conn);
      syncRelay();
    }
    emitStatus();
  }

  // ---- Sending ----

  // False means the connection has ended. Encrypting takes a counter, so a frame the link
  // refuses would leave a gap that fails every later decrypt. That can't be repaired,
  // only replaced.
  function sendSealed(conn, live, plaintext) {
    if (conn.live !== live) return false;
    let accepted = false;
    try {
      accepted = live.link.send(live.session.encrypt(plaintext));
    } catch { /* counts as refused */ }
    if (!accepted) endLive(conn);
    return accepted;
  }

  function send(deviceId, frame) {
    const conn = conns.get(deviceId);
    if (!conn || !conn.live || frame === null || typeof frame !== 'object') return false;
    let text;
    try {
      text = JSON.stringify(frame);
    } catch {
      return false;
    }
    if (typeof text !== 'string') return false;
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_FRAME_BYTES) return false;

    const { live } = conn;
    for (let offset = 0; offset < bytes.length; offset += FRAME_PART_BYTES) {
      const part = bytes.subarray(offset, offset + FRAME_PART_BYTES);
      const plaintext = new Uint8Array(1 + part.length);
      plaintext[0] = offset + FRAME_PART_BYTES >= bytes.length ? KIND_LAST : KIND_MORE;
      plaintext.set(part, 1);
      if (!sendSealed(conn, live, plaintext)) return false;
    }
    return true;
  }

  // ---- Receiving ----

  // The only way in from the network. Anything not from a device in `conns` stops here.
  function receiveFromRelay(from, data) {
    const conn = conns.get(from);
    if (!conn || data === null || typeof data !== 'object') return;
    if (data.t === MSG_HELLO || data.t === MSG_AUTH) {
      receiveHandshake(conn, data);
    } else if (data.t === MSG_LINK && conn.live) {
      const bytes = fromBase64(data.b);
      if (!bytes) return;
      try {
        conn.live.link.receiveFromRelay(bytes);
      } catch { /* listeners are already guarded, and the link settles before it rethrows */ }
    }
  }

  function peerIsAway(deviceId) {
    const live = conns.get(deviceId)?.live;
    if (!live || live.peerAway) return;
    live.peerAway = true;
    emitStatus();
  }

  function receiveSealed(conn, live, wire) {
    if (conn.live !== live) return;
    let plaintext;
    try {
      plaintext = live.session.decrypt(wire);
    } catch {
      // The link has already retired this frame's sequence number, so the stream can't
      // recover from here.
      return endLive(conn);
    }
    live.lastDecryptedAt = clock.now();
    if (live.peerAway) {
      live.peerAway = false;
      emitStatus();
    }

    const kind = plaintext[0];
    if (kind === KIND_MORE || kind === KIND_LAST) {
      receivePart(conn, live, plaintext.subarray(1), kind === KIND_LAST);
    } else if (kind === KIND_REMOVED) {
      forgetPeer(conn);
      syncRelay();
      emitStatus();
    }
  }

  function receivePart(conn, live, part, last) {
    live.partBytes += part.length;
    if (live.partBytes > MAX_FRAME_BYTES) return endLive(conn);
    live.parts.push(part);
    if (!last) return;

    const bytes = Buffer.concat(live.parts);
    live.parts = [];
    live.partBytes = 0;
    let frame;
    try {
      frame = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    if (frame !== null && typeof frame === 'object') notify(frameListeners, conn.peer.deviceId, frame);
  }

  // ---- Pairing, home side ----

  function endHostPairing(closeOptions) {
    const pairing = hostPairing;
    if (!pairing) return;
    hostPairing = null;
    clock.clearTimeout(pairing.expiryTimer);
    if (pairing.graceTimer !== null) clock.clearTimeout(pairing.graceTimer);
    if (pairing.client) pairing.client.close(closeOptions);
  }

  function cancelCode() {
    const had = hostPairing !== null;
    endHostPairing();
    if (had) emitStatus();
    return { ok: true };
  }

  function removeAutoSecretFile() {
    try {
      autoUnlock?.remove();
    } catch { /* a leftover file is found out at the next start */ }
  }

  // The file is written before the keystore takes the secret. A crash between the two
  // leaves a file with nothing sealed under it, which the next start clears up, whereas
  // the other order could seal the identity under a secret nobody has.
  async function makeAutoSecret() {
    if (!autoUnlock) return { error: LOCKED };
    let secret = '';
    for (let i = 0; i < AUTO_SECRET_DIGITS; i++) secret += nodeCrypto.randomInt(10);
    try {
      autoUnlock.write(autoUnlock.protect(Buffer.from(secret, 'utf8')));
    } catch {
      removeAutoSecretFile();
      return { error: STORAGE_UNAVAILABLE };
    }
    const result = await keystore.setPin(secret);
    if (!result.ok) {
      removeAutoSecretFile();
      return { error: result.error };
    }
    usesAutoSecret = true;
    afterUnlock();
    return {};
  }

  function ensureAutoSecret() {
    autoSecretInFlight ??= makeAutoSecret().finally(() => {
      autoSecretInFlight = null;
    });
    return autoSecretInFlight;
  }

  // At start, and again when secure storage turns up late.
  function startAutoUnlock() {
    if (!autoUnlock || !keystore.isAvailable()) return;
    let sealed;
    try {
      sealed = autoUnlock.read();
    } catch {
      return;
    }
    if (!sealed) return;
    if (!keystore.hasPin()) return removeAutoSecretFile(); // nothing was sealed under it
    usesAutoSecret = true;
    if (keystore.isUnlocked()) return;

    let secret;
    try {
      secret = Buffer.from(autoUnlock.unprotect(sealed)).toString('utf8');
    } catch {
      return; // may be passing, so the file stays and the next start tries again
    }
    keystore.unlock(secret).then((result) => {
      if (stopped) return;
      if (result.ok) {
        afterUnlock();
      } else if (!result.error) {
        // A wrong answer, so the file is left over from a crash just after a real PIN
        // replaced it. Stopping here costs one attempt, and the PIN works from now on.
        usesAutoSecret = false;
        removeAutoSecretFile();
      }
      emitStatus();
    }, () => {});
  }

  async function createCode() {
    refreshStorage();
    if (!address) return { error: NOT_SET_UP };
    if (!keystore.isAvailable()) return { error: STORAGE_UNAVAILABLE };
    if (!keystore.hasPin()) {
      const made = await ensureAutoSecret();
      if (made.error) return made;
      if (!address) return { error: NOT_SET_UP };
    }
    const identity = keystore.getIdentity();
    if (!identity) return { error: LOCKED };

    endHostPairing();
    const code = newCode();
    const expiresAt = clock.now() + CODE_LIFETIME_MS;
    const pairing = {
      host: createPairingHost({ code, identity, name: cleanName(deviceName) }),
      client: null,
      graceTimer: null,
      expiryTimer: clock.setTimeout(cancelCode, CODE_LIFETIME_MS)
    };
    hostPairing = pairing;
    try {
      pairing.client = relay.connectPairing({
        address,
        role: 'host',
        clock,
        onOpen: () => {},
        onNone: () => {},
        onMessage: (data) => {
          if (hostPairing === pairing) receivePairingAsHost(pairing, data);
        },
        // Without its slot the code can't be used, so it's over, whoever ended it.
        onClose: () => {
          if (hostPairing === pairing) {
            pairing.client = null;
            cancelCode();
          }
        }
      });
    } catch {
      endHostPairing();
      return { error: COULD_NOT_REACH };
    }
    emitStatus();
    return { code, expiresAt };
  }

  function receivePairingAsHost(pairing, data) {
    const result = pairing.host.handle(data);
    if (result.peer) return finishPairingAsHost(pairing, result);
    if (result.reply) pairing.client.send(result.reply);
    if (pairing.host.attemptsLeft > 0) return;

    // Out of attempts, though the last one may still be live. A guest with a wrong code
    // just goes silent, so a failed result can't be the only thing that ends this.
    if (result.failed) {
      cancelCode();
    } else if (pairing.graceTimer === null) {
      pairing.graceTimer = clock.setTimeout(cancelCode, NO_ATTEMPTS_GRACE_MS);
    }
  }

  // Saved before the last message goes, so the identity is never given to a device this
  // end failed to record. If that message is lost, this end has a provisional entry and
  // the other has nothing, which a new pairing or the 10-minute limit clears up.
  function finishPairingAsHost(pairing, { peer, reply }) {
    if (peer.deviceId === deviceIdFromPublicKey(keystore.getIdentity().publicKey)) return cancelCode();
    try {
      addPairedPeer({ ...peer, name: cleanName(peer.name), role: ROLE_LAPTOP, provisional: true });
    } catch {
      return cancelCode();
    }
    pairing.client.send(reply);
    endHostPairing({ flush: true });
    emitStatus();
  }

  // Replaces any older entry for this device, since its role may have changed.
  function addPairedPeer(entry) {
    keystore.addPeer(entry);
    pendingRemovals.delete(entry.deviceId);
    const old = conns.get(entry.deviceId);
    if (old) dropConn(old);
    syncConns();
    syncRelay();
    const conn = conns.get(entry.deviceId);
    if (relayReady) startAttempt(conn, { announce: true });
    return conn;
  }

  // ---- Pairing, laptop side ----

  function hashCode(code) {
    return nodeCrypto.createHash('sha256').update(failedCodeSalt).update(code).digest('base64');
  }

  function rememberFailedCode(code) {
    const hash = hashCode(code);
    if (failedCodes.has(hash)) return;
    failedCodes.set(hash, clock.setTimeout(() => failedCodes.delete(hash), FAILED_CODE_MEMORY_MS));
  }

  // The one place a device gets a home PC of its own, so a real PIN is required here.
  // Set before pairing starts, so a refused PIN leaves everything as it was. An argument
  // given to a device that already has one is ignored.
  async function pair(code, name, pin) {
    const normalized = normalizeCode(code);
    if (!normalized) return { ok: false, error: WRONG_CODE_RETRY };
    refreshStorage();
    if (!address) return { ok: false, error: NOT_SET_UP };
    if (!keystore.isAvailable()) return { ok: false, error: STORAGE_UNAVAILABLE };
    if (guestPairing) return { ok: false, error: ALREADY_PAIRING };
    if (failedCodes.has(hashCode(normalized))) return { ok: false, error: WRONG_CODE_FINAL };

    if (!hasUserPin()) {
      if (pin === undefined || pin === null || pin === '') {
        pinRequested = true;
        emitStatus();
        return { ok: false, error: NEEDS_PIN };
      }
      const result = await setUserPin(pin);
      if (!result.ok) return { ok: false, error: result.error };
      if (guestPairing) return { ok: false, error: ALREADY_PAIRING };
      if (!address) return { ok: false, error: NOT_SET_UP };
    }

    const identity = keystore.getIdentity();
    if (!identity) return { ok: false, error: LOCKED };

    const guest = createPairingGuest({ code: normalized, identity, name: cleanName(name ?? deviceName) });
    return new Promise((resolve) => {
      // Only a reply tests the code. The relay or a fake home PC learns one guess from how
      // this end reacts to a reply, so that's what has to be limited. Silence tests nothing.
      let tested = false;
      let client = null;

      const attempt = {
        finish(answer) {
          if (guestPairing !== attempt) return;
          guestPairing = null;
          clock.clearTimeout(attempt.timer);
          if (client) client.close();
          if (!answer.ok && tested) rememberFailedCode(normalized);
          resolve(answer);
        },
        timer: clock.setTimeout(() => attempt.finish({ ok: false, error: tested ? STOPPED_ANSWERING : NO_ANSWER }), PAIR_TIMEOUT_MS)
      };
      guestPairing = attempt;

      function receive(data) {
        tested = true;
        const result = guest.handle(data);
        if (result.failed) return attempt.finish({ ok: false, error: WRONG_CODE_RETRY });
        if (result.reply) return client.send(result.reply);

        if (result.peer.deviceId === deviceIdFromPublicKey(identity.publicKey)) {
          return attempt.finish({ ok: false, error: SAME_DEVICE });
        }
        let conn;
        try {
          conn = addPairedPeer({ ...result.peer, name: cleanName(result.peer.name), role: ROLE_HOME });
        } catch (err) {
          return attempt.finish({ ok: false, error: err.message });
        }
        attempt.finish({ ok: true, device: deviceEntry(conn) });
        emitStatus();
      }

      try {
        client = relay.connectPairing({
          address,
          role: 'guest',
          clock,
          onOpen: () => client.send(guest.first),
          onNone: () => attempt.finish({ ok: false, error: CODE_CANCELLED }),
          onMessage: (data) => {
            if (guestPairing === attempt) receive(data);
          },
          onClose: () => {
            client = null;
            attempt.finish({ ok: false, error: tested ? STOPPED_ANSWERING : COULD_NOT_REACH });
          }
        });
      } catch {
        attempt.finish({ ok: false, error: COULD_NOT_REACH });
      }
    });
  }

  // ---- Keys and locking ----

  // Safe to run more than once: a second unlock queued behind the first also gets here,
  // and anything already live or connecting is left alone.
  function afterUnlock() {
    hold = null;
    flushRemovals();
    flushConfirms();
    syncConns();
    syncRelay();
    if (relayReady) {
      for (const conn of conns.values()) {
        if (!conn.live && !conn.attempt && conn.retryTimer === null) startAttempt(conn, { announce: true });
      }
    }
  }

  // The keys are gone, so nothing can be kept.
  function tearDown() {
    hold = null;
    for (const conn of [...conns.values()]) dropConn(conn);
    pendingRemovals.clear();
    pendingConfirms.clear();
    endHostPairing();
    if (guestPairing) guestPairing.finish({ ok: false, error: LOCKED });
    syncRelay();
  }

  // On success any secret this device used is gone, and it follows the laptop rules.
  async function setUserPin(pin) {
    const result = await keystore.setPin(pin);
    if (result.ok) {
      usesAutoSecret = false;
      pinRequested = false;
      removeAutoSecretFile();
      if (keystore.isUnlocked()) afterUnlock();
    }
    emitStatus();
    return result;
  }

  function setPin(pin) {
    refreshStorage();
    return setUserPin(pin);
  }

  async function unlock(pin) {
    refreshStorage();
    // A guess while already unlocked would prove nothing.
    if (keystore.isUnlocked()) return { ok: true };
    // Still unlocking itself. A guess here could only use up attempts.
    if (usesAutoSecret) return { ok: false, error: NO_PIN_HERE };
    const epoch = lockEpoch;
    const result = await keystore.unlock(pin);
    if (result.ok && epoch !== lockEpoch) {
      // Locked while the PIN was being checked. The lock came later, so the lock wins.
      keystore.lock();
      return { ok: false, error: LOCKED };
    }
    if (result.ok) afterUnlock();
    if (result.wiped) {
      tearDown();
      pinRequested = false;
      removeAutoSecretFile();
    }
    emitStatus();
    return result;
  }

  // The idle lock. Connections carry on with the hold, and only a device that had the
  // PIN entered gets one, so calling this while locked at start grants nothing. A device
  // with no person's PIN has nothing to lock against.
  function lock() {
    if (usesAutoSecret) return;
    lockEpoch += 1;
    if (keystore.isUnlocked()) hold = { identity: keystore.getIdentity(), peers: keystore.listPeers() };
    keystore.lock();
    endHostPairing();
    if (guestPairing) guestPairing.finish({ ok: false, error: LOCKED });
    emitStatus();
  }

  function setAddress(url) {
    refreshStorage();
    if (keystore.hasPin() && !keystore.isUnlocked()) return { ok: false, error: LOCKED };
    const cleared = url === '' || url === null || url === undefined;
    const next = cleared ? null : normalizeAddress(url);
    if (!cleared && !next) return { ok: false, error: BAD_ADDRESS };
    if (next === address) return { ok: true };
    try {
      addressStore.save(next);
    } catch {
      return { ok: false, error: "Couldn't save the address." };
    }

    // Everything on the old relay is over.
    address = next;
    endHostPairing();
    if (guestPairing) guestPairing.finish({ ok: false, error: COULD_NOT_REACH });
    clearRelayTimers();
    closeDeviceClient();
    relayReady = false;
    relayReadyAt = null;
    reconnects = 0;
    for (const conn of conns.values()) {
      clearAttempt(conn);
      stopLive(conn);
    }
    syncConns();
    syncRelay();
    emitStatus();
    return { ok: true };
  }

  function removeDevice(deviceId) {
    if (!keystore.isUnlocked()) return { ok: false, error: LOCKED };
    const conn = conns.get(deviceId);
    try {
      keystore.removePeer(deviceId);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (conn) {
      // Sent once and not resent, since the connection ends here. If it's lost or the
      // other end is away, that end keeps its entry and stays offline, because this end
      // no longer answers it.
      if (conn.live) sendSealed(conn, conn.live, Uint8Array.of(KIND_REMOVED));
      dropConn(conn);
    }
    syncRelay({ flush: true });
    emitStatus();
    return { ok: true };
  }

  // A caller has to say this comes from this machine's own UI, and main.js only says so
  // after checking who sent the IPC. Nothing in the frame path calls this. Turning it on
  // needs the PIN, and turning it off never does, because that has to work at once.
  function setControlAllowed(allowed, origin) {
    if (origin?.fromLocalUi !== true) return { ok: false, error: 'This can only be changed on this device.' };
    if (typeof allowed !== 'boolean') return { ok: false, error: 'Expected on or off.' };
    if (allowed && !keystore.isUnlocked()) return { ok: false, error: LOCKED };
    try {
      keystore.setControlAllowed(allowed);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    emitStatus();
    return { ok: true };
  }

  function subscribe(listeners, callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function shutdown() {
    if (stopped) return;
    tearDown();
    stopped = true;
    clearRelayTimers();
    closeDeviceClient();
    for (const timer of failedCodes.values()) clock.clearTimeout(timer);
    failedCodes.clear();
    frameListeners.clear();
    statusListeners.clear();
  }

  if (keystore.isUnlocked()) afterUnlock();
  startAutoUnlock();

  return {
    status,
    setAddress,
    setPin,
    unlock,
    lock,
    createCode,
    cancelCode,
    pair,
    removeDevice,
    setControlAllowed,
    send,
    onFrame: (callback) => subscribe(frameListeners, callback),
    onStatus: (callback) => subscribe(statusListeners, callback),
    shutdown
  };
}

module.exports = { createManager, fingerprintOf, cleanName, normalizeAddress };
