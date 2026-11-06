// The connection manager: this is where pairing, sessions, the link, the keystore and
// the relay become "these devices can talk". No Electron here. Its clients and clock are
// injected, so test/remote-manager.test.js runs it under plain Node.
//
// The layers, from the top down:
//
//   frames (JSON) -> splitting -> session.encrypt -> link.send -> relay client or direct path
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
//   4  "are you there?", answered with a heartbeat
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
// TOOL CALLS are the one kind of frame looked at here, because this is what stands between a
// paired device and running something on this machine, and the renderer can't be what decides
// that. A call goes no further unless it comes from a device this one treats as its home PC, the
// switch is on, and no PIN is owed. Otherwise it gets a refusal and a line in the audit log.
//
// While a call is out, both ends watch each other. Heartbeats are 15 seconds apart, and a call
// that has nobody at the other end can't wait that long to find out. So each end asks every second
// and counts anything heard at all, because a long transfer can hold up an answer without anything
// being wrong. Gone quiet shows in status as `quiet`, until it's heard from again. It says nothing
// about the connection: `connected` stays as it is, the session isn't touched, and a Wi-Fi gap costs
// no snapshot. Home takes quiet as a reason to stop waiting. The laptop keeps a command going until
// it's told otherwise or the session really ends, and gives up after much longer: `longQuiet`.
//
// THE DIRECT PATH is a second way out for the link's bytes, set up in the background once a
// session is live, by signaling that crosses that session as frames of type rtc. Those go
// to the direct path instead of the listeners, and the path treats them as untrusted, so
// they can't do anything but try for a data channel. lib/remote/direct-path.js has the
// rules. It belongs to one connection: it starts when a session goes live and closes when
// that session stops. The chat sees none of this, since the link makes a switch between
// paths lose nothing, and `connected` doesn't change.
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
// a person is there, so a real PIN replaces the secret and the file goes. That happens only
// once pairing has worked, so a mistyped code leaves an unattended home PC unattended.
//
// The keystore records which kind of PIN seals it, and only a 'device' keystore ever looks
// at the secret's file. On anything else that file is a leftover, and goes without a guess.
// A self-unlock is never counted as a guess, so nothing that goes wrong with it can use up
// attempts. If it can't happen yet, for instance because the file is busy, it retries on a
// timer with nobody involved, and shows as storage that isn't available, not as a PIN prompt.
//
// If the file is missing, or doesn't open to the secret, while secure storage works, the
// identity sealed under it is out of reach for good. Rather than leave the device stuck, the
// keys are set aside and it starts unpaired, with status() saying so once. The same notice
// goes out when the keystore finds at load that it can't read keys it used to have.
//
// Everything that changes the key state runs through serial(): setting a PIN, making the
// secret, unlocking, resetting, wiping. Each re-checks the state when its turn comes, since
// that may have changed while it waited.
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
const { pinFormatError } = require('./keystore.js');

const FRAME_PART_BYTES = 256 * 1024;
// Smaller than the link's 64 MiB buffer, so one frame can't overflow an empty link.
const MAX_FRAME_BYTES = 48 * 1024 * 1024;

const KIND_MORE = 0;
const KIND_LAST = 1;
const KIND_HEARTBEAT = 2;
const KIND_REMOVED = 3;
const KIND_PROBE = 4;

const MSG_HELLO = 'session-hello';
const MSG_AUTH = 'session-auth';
const MSG_LINK = 'link';

const FRAME_RTC = 'rtc';
const FRAME_TOOL_CALL = 'tool-call';
const FRAME_TOOL_RESULT = 'tool-result';
const FRAME_TOOL_CANCEL = 'tool-cancel';
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
// What this device may send while locked or owing a PIN. A closed list, so anything not thought of
// is refused, and each one is named for why it has to go on.
// To a home PC of this device's own, only what keeps its mirror current. None of it asks that
// home PC to do anything but send again.
const LOCKED_FRAMES_TO_HOME = new Set([
  'mirror-resync-request', // a part went missing, so the chats kept out of sight fall behind
  'mirror-part-ack', // the home PC holds back the next part of a snapshot until it hears this
  'queued-returned-ack', // the home PC sends words back until it hears this
  // The home PC can still run commands here while the screen is locked, as the design says, so the
  // answer has to get back, or its model waits on it.
  'tool-result',
  // What the home PC may ask for changes with the switch, which can be turned off while locked, and
  // it can't go on what it heard before a reconnect.
  'control-state',
  // A locked laptop can be over its limit of pop-ups too. Home has to know this one can't answer, or
  // a run nobody's at home for waits on it. It carries an id and nothing else, and asks for nothing.
  'ask-unheld'
]);
const LOCKED_FRAME_TO_HOME_MAX_BYTES = 64 * 1024;
// A tool's output is more than the rest of that list ever needs.
const LOCKED_TOOL_RESULT_MAX_BYTES = 8 * 1024 * 1024;
// To a laptop of this device's. A device that's a home PC as well as a laptop goes on serving, since
// its lock is about someone using its own home PC. This is its side of the mirror and of actions.
const LOCKED_FRAMES_TO_LAPTOP = new Set([
  'mirror-snapshot', 'mirror-ops', 'mirror-run', 'mirror-remove', 'mirror-too-large', 'mirror-part-fence',
  'action-result', 'queued-returned',
  // Stopping something must always work. Starting something isn't on this list: a lock is about
  // someone using this device, so its model has to wait for the PIN to reach a laptop.
  'tool-cancel',
  // A pop-up is this device serving a chat, and the person who can answer may be on that laptop.
  // Its `answer` is on neither list: someone at a locked laptop has no say in anything.
  'ask', 'ask-closed'
]);

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

const WATCH_TICK_MS = 1000;
// With the tick, this has to come in under the 5 seconds a call gets to find out.
const WATCH_QUIET_MS = 3500;
// How long a laptop goes on with a command when nothing at all is heard from the home PC that asked.
const SILENCE_ENDS_COMMAND_MS = 30000;
// A call that's never answered, because the page that made it has gone, stops counting after this.
const WATCH_CALL_MAX_MS = 5 * 60 * 1000;
const WATCH_CALLS_MAX = 256;

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
const AUTO_SECRET_PATTERN = new RegExp(`^[0-9]{${AUTO_SECRET_DIGITS}}$`);
// While a self-unlock can't happen yet, for a reason that may pass, such as a busy disk.
const SELF_UNLOCK_RETRY_MS = 5000;
const SELF_UNLOCK_RETRY_MAX_MS = 60000;
// How long a refused pair keeps asking for a PIN. A code doesn't outlast this anyway.
const PIN_REQUEST_MS = 10 * 60 * 1000;

const NOT_SET_UP = "Remote Control isn't set up on this device yet.";
const STORAGE_UNAVAILABLE = "Remote Control's keys can't be opened right now because the system's secure storage isn't available yet. Try again in a moment.";
const NEEDS_PIN = 'Set a PIN for this device before connecting it to a home PC.';
const NEEDS_PIN_FOR_CONTROL = 'Set a PIN for this device first.';
const TOOLS_SWITCH_OFF = "This device's switch for being controlled from home is off, so nothing ran.";
const TOOLS_OWE_PIN = 'This device needs a PIN before it can be controlled from home, so nothing ran.';
const TOOLS_NOT_FROM_HOME = "This device doesn't take commands from that one, so nothing ran.";
const TOOLS_BAD_ID = 'That request had no id it could be answered by.';
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

function createManager({ keystore, relay, addressStore, autoUnlock = null, clock = systemClock, deviceName = '', createDirect = null, onToolRefused = null }) {
  const conns = new Map(); // deviceId -> connection, for every device allowed to talk
  // Whatever arrives from it is for the device's live connection, if there still is one.
  // Bytes left over from an earlier connection carry its id, and the link drops them.
  const direct = createDirect && createDirect({
    onSignal(deviceId, data) {
      const conn = conns.get(deviceId);
      if (conn?.live) sendFrame(conn, { type: FRAME_RTC, data });
    },
    onOpen: (deviceId) => conns.get(deviceId)?.live?.link.directUp(),
    onClose: (deviceId) => conns.get(deviceId)?.live?.link.directDown(),
    onData(deviceId, bytes) {
      try {
        const conn = conns.get(deviceId);
        if (conn) heardFrom(conn);
        conn?.live?.link.receiveFromDirect(bytes);
      } catch { /* listeners are already guarded, and the link settles before it rethrows */ }
    }
  });
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
  // A pairing with a home PC asked for a PIN and hasn't had one yet.
  let pinRequested = false;
  let pinRequestTimer = null;
  let keyQueue = Promise.resolve();
  let selfUnlockQueued = false;
  let selfUnlockTimer = null;
  let selfUnlockRetries = 0;
  // It should unlock itself, and for now it can't.
  let selfUnlockWaiting = false;
  // The keys were set aside as damaged, and nobody has asked for status() since.
  let keysReset = false;

  function loadAddress() {
    try {
      return normalizeAddress(addressStore.load());
    } catch {
      return null;
    }
  }

  // One at a time, in the order asked, for anything that changes the key state.
  function serial(task) {
    const run = keyQueue.then(task, task);
    keyQueue = run.catch(() => {});
    return run;
  }

  function noteSetAside() {
    if (keystore.consumeSetAside()) keysReset = true;
  }

  function refreshStorage() {
    if (!keystore.isAvailable() && keystore.reload()) {
      noteSetAside();
      selfUnlockWaiting = false; // until the step below finds otherwise
      kickSelfUnlock();
    }
  }

  function storageReady() {
    return keystore.isAvailable() && !selfUnlockWaiting;
  }

  function onDeviceSecret() {
    return keystore.pinKind() === 'device';
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
    return keystore.pinKind() === 'user';
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
      quiet: live?.quiet === true,
      longQuiet: live?.longQuiet === true,
      fingerprint: fingerprintOf(peer.deviceId)
    };
  }

  function owesPin() {
    return !hasUserPin() && (pinRequested || [...conns.values()].some((conn) => conn.peer.role === ROLE_HOME));
  }

  // To compare with what the other end lists for this device. An idle lock leaves this device
  // connected as the same identity, and until keys are unsealed there's nothing to say.
  function ownFingerprint() {
    const id = ownDeviceId();
    return id ? fingerprintOf(id) : null;
  }

  // The id a home PC knows this device by, so a laptop can find its own folder in a mirrored chat.
  // It's the hash of the public key, like every id in status.
  function ownDeviceId() {
    const identity = keystore.getIdentity() ?? hold?.identity;
    return identity ? deviceIdFromPublicKey(identity.publicKey) : null;
  }

  // Stays set until a person's code can have seen it: a status event may go out before the
  // window is listening, so only an explicit status() call counts as having been told.
  function status() {
    const current = currentStatus();
    keysReset = false;
    return current;
  }

  function currentStatus() {
    refreshStorage();
    return {
      name: cleanName(deviceName),
      enabled: Boolean(address),
      locked: !keystore.isUnlocked(),
      idleLocked: hold !== null,
      hasPin: hasUserPin(),
      // Worked out from the peers too, so it survives a restart: a device with a home PC
      // of its own is meant to have a PIN.
      needsPin: owesPin(),
      keysReset,
      storageAvailable: storageReady(),
      fingerprint: ownFingerprint(),
      deviceId: ownDeviceId(),
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
    if (!stopped && statusListeners.size) notify(statusListeners, currentStatus());
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
    if (live.watchTimer !== null) clock.clearInterval(live.watchTimer);
    live.watchTimer = null;
    live.calls.clear();
    live.parts = [];
    direct?.close(conn.peer.deviceId);
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
    const live = {
      session, parts: [], partBytes: 0, lastDecryptedAt: clock.now(), peerAway: false,
      lastHeardAt: clock.now(), quiet: false, longQuiet: false, calls: new Map(), watchTimer: null, watchFrom: 0, lastTickAt: 0
    };
    live.link = createLink({
      sendRelay: (bytes) => relaySend(deviceId, { t: MSG_LINK, b: toBase64(bytes) }),
      sendDirect: direct && ((bytes) => direct.send(deviceId, bytes)),
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
    // The home-role side initiates, by what this peer is to me.
    direct?.connect(deviceId, conn.peer.role === ROLE_LAPTOP);
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

  // Serialising turns a String object into a plain string, so a type is only what it looks like
  // if it's a plain string already. Signaling is the direct path's own, so nothing else gets to
  // send a frame of that type.
  function send(deviceId, frame) {
    const conn = conns.get(deviceId);
    if (!conn || !conn.live || frame === null || typeof frame !== 'object') return false;
    if (typeof frame.type !== 'string' || frame.type === FRAME_RTC) return false;
    const { live } = conn;
    const plain = keystore.isUnlocked() && !owesPin() ? frame : plainLockedFrame(conn, frame);
    if (!plain || !sendFrame(conn, plain)) return false;
    noteToolFrameSent(conn, live, plain);
    return true;
  }

  // The PIN stands in front of using a home PC, and the renderer can't be what enforces that.
  // Being unlocked isn't enough, because a laptop that still owes a PIN has its keys open. The
  // decision is made on a plain copy, which is also what goes, so what was checked is what's sent.
  function plainLockedFrame(conn, frame) {
    const toHome = conn.peer.role === ROLE_HOME;
    let text;
    let plain;
    try {
      text = JSON.stringify(frame);
      if (toHome && text.length > LOCKED_TOOL_RESULT_MAX_BYTES) return null;
      plain = JSON.parse(text);
    } catch {
      return null;
    }
    if (plain === null || typeof plain !== 'object' || typeof plain.type !== 'string') return null;
    if (toHome) {
      const limit = plain.type === FRAME_TOOL_RESULT ? LOCKED_TOOL_RESULT_MAX_BYTES : LOCKED_FRAME_TO_HOME_MAX_BYTES;
      if (Buffer.byteLength(text, 'utf8') > limit) return null;
    }
    return (toHome ? LOCKED_FRAMES_TO_HOME : LOCKED_FRAMES_TO_LAPTOP).has(plain.type) ? plain : null;
  }

  function sendFrame(conn, frame) {
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

  // ---- Tool calls ----

  // Why this device can't ask this one to run something, or null if it can. Checked for each
  // call as it arrives, and again by main.js when a call comes to starting a process.
  function toolCallRefusal(deviceId) {
    const conn = conns.get(deviceId);
    if (!conn || conn.peer.role !== ROLE_HOME) return TOOLS_NOT_FROM_HOME;
    if (!keystore.getControlAllowed()) return TOOLS_SWITCH_OFF;
    if (owesPin()) return TOOLS_OWE_PIN;
    return null;
  }

  // False if the frame stops here. A frame from the network is JSON, so a type is only ever a
  // plain string by now.
  function admitFrame(conn, live, frame) {
    if (frame.type === FRAME_TOOL_RESULT) {
      live.calls.delete(frame.id);
      return true;
    }
    if (frame.type !== FRAME_TOOL_CALL) return true;
    const answerable = typeof frame.id === 'string' && TOOL_CALL_ID.test(frame.id);
    const reason = toolCallRefusal(conn.peer.deviceId) ?? (answerable ? null : TOOLS_BAD_ID);
    if (reason === null) {
      watchCall(conn, live, frame.id);
      return true;
    }
    refuseToolCall(conn, frame, answerable, reason);
    return false;
  }

  function refuseToolCall(conn, frame, answerable, reason) {
    try {
      onToolRefused?.({ deviceId: conn.peer.deviceId, deviceName: conn.peer.name, reason, frame });
    } catch { /* the refusal stands whether or not it could be written down */ }
    if (answerable) sendFrame(conn, { type: FRAME_TOOL_RESULT, id: frame.id, result: { error: reason }, summary: 'refused', ok: false });
  }

  function noteToolFrameSent(conn, live, frame) {
    if (conn.live !== live) return;
    if (frame.type === FRAME_TOOL_CALL && typeof frame.id === 'string') watchCall(conn, live, frame.id);
    else if (frame.type === FRAME_TOOL_RESULT || frame.type === FRAME_TOOL_CANCEL) live.calls.delete(frame.id);
  }

  function watchCall(conn, live, id) {
    if (live.calls.size >= WATCH_CALLS_MAX) live.calls.delete(live.calls.keys().next().value);
    live.calls.set(id, clock.now());
    if (live.watchTimer !== null) return;
    live.watchFrom = clock.now();
    live.lastTickAt = clock.now();
    live.watchTimer = clock.setInterval(() => watchTick(conn, live), WATCH_TICK_MS);
    sendSealed(conn, live, Uint8Array.of(KIND_PROBE));
  }

  function watchTick(conn, live) {
    if (conn.live !== live) return;
    // A tick this late means it's this device that wasn't running. What the other end said is still
    // waiting to be read, so its silence means nothing yet.
    if (clock.now() - live.lastTickAt > WATCH_TICK_MS * 2) live.watchFrom = clock.now();
    live.lastTickAt = clock.now();
    for (const [id, since] of live.calls) {
      if (clock.now() - since >= WATCH_CALL_MAX_MS) live.calls.delete(id);
    }
    // Quiet goes on being asked about, so it ends as soon as it can.
    if (!live.calls.size && !live.quiet) {
      clock.clearInterval(live.watchTimer);
      live.watchTimer = null;
      return;
    }
    const silent = clock.now() - Math.max(live.lastHeardAt, live.watchFrom);
    const quiet = silent >= WATCH_QUIET_MS;
    const longQuiet = silent >= SILENCE_ENDS_COMMAND_MS;
    if (quiet !== live.quiet || longQuiet !== live.longQuiet) {
      live.quiet = quiet;
      live.longQuiet = longQuiet;
      emitStatus();
    }
    sendSealed(conn, live, Uint8Array.of(KIND_PROBE));
  }

  // Anything at all from that way, even an acknowledgement. The relay could forge one of those to
  // keep a device looking present, but it could as easily just stall the connection.
  function heardFrom(conn) {
    const { live } = conn;
    if (!live) return;
    live.lastHeardAt = clock.now();
    if (live.quiet) {
      live.quiet = false;
      live.longQuiet = false;
      emitStatus();
    }
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
      heardFrom(conn);
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
    } else if (kind === KIND_PROBE) {
      sendSealed(conn, live, Uint8Array.of(KIND_HEARTBEAT));
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
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === FRAME_RTC) return receiveSignal(conn, frame.data);
    if (admitFrame(conn, live, frame)) notify(frameListeners, conn.peer.deviceId, frame);
  }

  // Whoever is at the other end wrote this, and the path checks it.
  function receiveSignal(conn, data) {
    try {
      direct?.signal(conn.peer.deviceId, data);
    } catch { /* the relay is still carrying everything */ }
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

  function requestPin() {
    pinRequested = true;
    if (pinRequestTimer !== null) clock.clearTimeout(pinRequestTimer);
    pinRequestTimer = clock.setTimeout(() => {
      clearPinRequest();
      emitStatus();
    }, PIN_REQUEST_MS);
  }

  function clearPinRequest() {
    pinRequested = false;
    if (pinRequestTimer !== null) clock.clearTimeout(pinRequestTimer);
    pinRequestTimer = null;
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
    const result = await keystore.setPin(secret, { kind: 'device' });
    if (!result.ok) {
      removeAutoSecretFile();
      return { error: result.error };
    }
    afterUnlock();
    return {};
  }

  // Asked for when no PIN was seen, but something ahead in the queue may have set one.
  function ensureAutoSecret() {
    return serial(() => (keystore.hasPin() ? {} : makeAutoSecret()));
  }

  // At start, whenever secure storage turns up, and on its own timer while it has to wait.
  function kickSelfUnlock() {
    if (!autoUnlock || stopped || selfUnlockQueued) return;
    if (selfUnlockTimer !== null) clock.clearTimeout(selfUnlockTimer);
    selfUnlockTimer = null;
    selfUnlockQueued = true;
    serial(async () => {
      selfUnlockQueued = false;
      try {
        await selfUnlockStep();
      } catch {
        waitForSelfUnlock();
      }
    });
  }

  function waitForSelfUnlock(atLeastMs = 0) {
    selfUnlockWaiting = true;
    const backoff = Math.min(SELF_UNLOCK_RETRY_MS * 2 ** selfUnlockRetries, SELF_UNLOCK_RETRY_MAX_MS);
    selfUnlockRetries += 1;
    selfUnlockTimer = clock.setTimeout(() => {
      selfUnlockTimer = null;
      kickSelfUnlock();
    }, Math.max(backoff, atLeastMs));
    emitStatus();
  }

  function selfUnlockSettled() {
    selfUnlockWaiting = false;
    selfUnlockRetries = 0;
  }

  async function selfUnlockStep() {
    if (stopped) return;
    if (!keystore.isAvailable() && !keystore.reload()) return waitForSelfUnlock();
    noteSetAside();

    if (!onDeviceSecret()) {
      // A person's PIN, or none at all, so the file is left over from a crash between
      // writing it and the keystore taking it, or between a real PIN and deleting it.
      selfUnlockSettled();
      removeAutoSecretFile();
      return emitStatus();
    }
    if (keystore.isUnlocked()) return selfUnlockSettled();

    let sealed;
    try {
      sealed = autoUnlock.read();
    } catch {
      return waitForSelfUnlock();
    }
    if (!sealed) return resetDamagedKeys();
    let secret;
    try {
      secret = Buffer.from(autoUnlock.unprotect(sealed)).toString('utf8');
    } catch {
      return resetDamagedKeys();
    }
    if (!AUTO_SECRET_PATTERN.test(secret)) return resetDamagedKeys();

    const result = await keystore.unlock(secret, { uncounted: true });
    if (stopped) return;
    if (result.ok) {
      selfUnlockSettled();
      afterUnlock();
      return emitStatus();
    }
    if (result.tested) return resetDamagedKeys();
    return waitForSelfUnlock(result.waitMs);
  }

  // Secure storage can look fine at load and be gone by now, and then nothing is known
  // about this file, so it's checked afresh. The keystore goes first: a crash before the
  // secret's file is removed leaves a file with nothing sealed under it, which the next
  // start clears, whereas the other order would leave keys nobody can open.
  function resetDamagedKeys() {
    if (!keystore.reload()) return waitForSelfUnlock();
    noteSetAside();
    if (!keystore.setAsideAsDamaged()) return waitForSelfUnlock();
    removeAutoSecretFile();
    selfUnlockSettled();
    clearPinRequest();
    keysReset = true;
    return emitStatus();
  }

  async function createCode() {
    refreshStorage();
    if (!address) return { error: NOT_SET_UP };
    if (!storageReady()) return { error: STORAGE_UNAVAILABLE };
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

  // The one place a device gets a home PC of its own, so a real PIN is required here. Its
  // format is checked up front, and it's only set once pairing has worked, so a mistyped
  // code leaves everything as it was. The identity comes from the secret until then. If it
  // can't be set after that, the pairing stands, and pinError and status().needsPin ask
  // again. An argument given to a device that already has a PIN is ignored.
  async function pair(code, name, pin) {
    const normalized = normalizeCode(code);
    if (!normalized) return { ok: false, error: WRONG_CODE_RETRY };
    refreshStorage();
    if (!address) return { ok: false, error: NOT_SET_UP };
    if (!storageReady()) return { ok: false, error: STORAGE_UNAVAILABLE };
    if (guestPairing) return { ok: false, error: ALREADY_PAIRING };
    if (failedCodes.has(hashCode(normalized))) return { ok: false, error: WRONG_CODE_FINAL };

    const pinToSet = hasUserPin() ? null : pin;
    if (!hasUserPin()) {
      if (pin === undefined || pin === null || pin === '') {
        requestPin();
        emitStatus();
        return { ok: false, error: NEEDS_PIN };
      }
      const formatError = pinFormatError(pin);
      if (formatError) return { ok: false, error: formatError };
      if (!keystore.hasPin()) {
        const made = await ensureAutoSecret();
        if (made.error) return { ok: false, error: made.error };
        if (guestPairing) return { ok: false, error: ALREADY_PAIRING };
        if (!address) return { ok: false, error: NOT_SET_UP };
      }
    }

    const identity = keystore.getIdentity();
    if (!identity) return { ok: false, error: LOCKED };

    const guest = createPairingGuest({ code: normalized, identity, name: cleanName(name ?? deviceName) });
    const answer = await new Promise((resolve) => {
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
    if (pinToSet === null) return answer;
    if (!answer.ok) {
      clearPinRequest();
      emitStatus();
      return answer;
    }

    // Someone may have set one while this was pairing, and that one stands.
    const result = await serial(() => (hasUserPin() ? { ok: true } : setUserPin(pinToSet)));
    return result.ok ? answer : { ...answer, pinError: result.error };
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
  // Only to be called from inside serial().
  async function setUserPin(pin) {
    const result = await keystore.setPin(pin, { kind: 'user' });
    if (result.ok) {
      clearPinRequest();
      removeAutoSecretFile();
      if (keystore.isUnlocked()) afterUnlock();
    }
    emitStatus();
    return result;
  }

  function setPin(pin) {
    refreshStorage();
    return serial(() => setUserPin(pin));
  }

  function unlock(pin) {
    refreshStorage();
    const epoch = lockEpoch;
    return serial(async () => {
      // A guess while already unlocked would prove nothing.
      if (keystore.isUnlocked()) return { ok: true };
      // There's no PIN here for a person to know, and a guess could only use up attempts.
      if (onDeviceSecret()) return { ok: false, error: NO_PIN_HERE };
      if (epoch !== lockEpoch) return { ok: false, error: LOCKED };
      const { tested, ...result } = await keystore.unlock(pin);
      if (result.ok && epoch !== lockEpoch) {
        // Locked while the PIN was being checked. The lock came later, so the lock wins.
        keystore.lock();
        return { ok: false, error: LOCKED };
      }
      if (result.ok) afterUnlock();
      if (result.wiped) {
        tearDown();
        clearPinRequest();
        removeAutoSecretFile();
      }
      emitStatus();
      return result;
    });
  }

  // The idle lock. Connections carry on with the hold, and only a device that had the
  // PIN entered gets one, so calling this while locked at start grants nothing. A device
  // with no person's PIN has nothing to lock against.
  function lock() {
    if (onDeviceSecret()) return;
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
    if (allowed && owesPin()) return { ok: false, error: NEEDS_PIN_FOR_CONTROL };
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
    if (selfUnlockTimer !== null) clock.clearTimeout(selfUnlockTimer);
    selfUnlockTimer = null;
    clearPinRequest();
    closeDeviceClient();
    for (const timer of failedCodes.values()) clock.clearTimeout(timer);
    failedCodes.clear();
    frameListeners.clear();
    statusListeners.clear();
  }

  noteSetAside();
  if (keystore.isUnlocked()) afterUnlock();
  kickSelfUnlock();

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
    toolCallRefusal,
    refreshStatus: emitStatus,
    send,
    onFrame: (callback) => subscribe(frameListeners, callback),
    onStatus: (callback) => subscribe(statusListeners, callback),
    shutdown
  };
}

module.exports = { createManager, fingerprintOf, cleanName, normalizeAddress };
