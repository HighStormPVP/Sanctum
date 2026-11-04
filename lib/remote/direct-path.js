// The direct path: a WebRTC data channel per device, below the encryption, beside the relay.
// No Electron here and no WebRTC either, so test/remote-direct.test.js runs it under plain
// Node. Electron only offers WebRTC in a renderer, so the channels themselves live in a hidden
// window (remote-transport.html) that main.js opens when this first asks. What crosses to it:
//
//   to the page:    { op:'open', id, initiator, iceServers }   { op:'signal', id, data }
//                   { op:'send', id, bytes }                   { op:'close', id }
//   from the page:  { ev:'ready' }                             { ev:'signal', id, data }
//                   { ev:'open', id }  { ev:'closed', id }     { ev:'data', id, bytes }
//
// THE WINDOW ONLY SEES CIPHERTEXT. The bytes given to send() are link frames, each already
// sealed by the session. It isn't told which device it's carrying either, only a number that
// is new for every peer connection. That number is also what makes late events harmless: an
// event from a channel that has since been replaced names nothing here. Everything it says is
// checked for shape, the same as what a peer says.
//
// SIGNALING goes through the encrypted session, as the manager's rtc frames, so the relay can't
// read it or swap a fingerprint. Between the two ends it looks like
//
//   { attempt, kind:'offer' | 'answer', sdp }
//   { attempt, kind:'candidate', candidate, sdpMid, sdpMLineIndex }
//
// `attempt` counts the initiator's tries since connect(). Sessions are replaced as a whole and
// connect() runs at both ends for each one, so a count can't carry over from an earlier session,
// and the link's ordering means a signal can't overtake a newer one.
//
// RETRIES are the initiator's job, and the other end just answers offers. Any failure to get
// started, a channel that closes, or the window going away all lead to the same place: waiting
// out a backoff from 2 s up to 60 s, then trying again from nothing. A channel that stayed up
// for STABLE_MS starts the backoff over, so one that keeps flapping doesn't hammer the peer.
// All of this is best effort, since the relay is carrying the traffic in the meantime.
//
// MESSAGES over 64 KiB are split, because that's the most a data channel can be relied on to
// take between browsers and versions. Each one on the channel is one marker byte, then bytes.
// Channels are ordered and reliable, so parts need no numbering. The link above has its own
// sequencing, and is what makes a switch between paths lose nothing: frames dropped with a
// channel are still in its buffer, and it sends them again down whichever path comes next.
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const MAX_MESSAGE_BYTES = 64 * 1024;
// The manager's parts are 256 KiB, plus a session's and a link's overhead. More than this
// isn't from a working peer.
const MAX_REASSEMBLED_BYTES = 1024 * 1024;

const PART_MORE = 0;
const PART_LAST = 1;

const ATTEMPT_TIMEOUT_MS = 20000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;
const STABLE_MS = 30000;

const MAX_SDP_LENGTH = 128 * 1024;
const MAX_CANDIDATE_LENGTH = 4 * 1024;
const MAX_MID_LENGTH = 256;

const KIND_OFFER = 'offer';
const KIND_ANSWER = 'answer';
const KIND_CANDIDATE = 'candidate';

const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

// Keeps only the fields that belong, so neither a peer nor the window can pass along anything
// else. Returns null for anything not the right shape.
function cleanSignal(data) {
  if (data === null || typeof data !== 'object') return null;
  if (data.kind === KIND_OFFER || data.kind === KIND_ANSWER) {
    if (typeof data.sdp !== 'string' || data.sdp.length > MAX_SDP_LENGTH) return null;
    return { kind: data.kind, sdp: data.sdp };
  }
  if (data.kind === KIND_CANDIDATE) {
    const { candidate, sdpMid, sdpMLineIndex } = data;
    if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LENGTH) return null;
    if (sdpMid !== null && (typeof sdpMid !== 'string' || sdpMid.length > MAX_MID_LENGTH)) return null;
    if (sdpMLineIndex !== null && !Number.isSafeInteger(sdpMLineIndex)) return null;
    return { kind: KIND_CANDIDATE, candidate, sdpMid, sdpMLineIndex };
  }
  return null;
}

// `openTransport({ onEvent, onGone })` opens the hidden window and returns { send(command) }, or
// null if it can't now. `iceServers` and `blockCandidates` are for tests that have to control
// which paths can form, and come from main.js, never from a frame.
function createDirectPath({
  onSignal, onOpen, onClose, onData, openTransport,
  clock = systemClock, iceServers = ICE_SERVERS, blockCandidates = false
}) {
  const devices = new Map(); // deviceId -> this device's state, while it has a connection
  const channels = new Map(); // id in the window -> device
  let transport = null; // { send, ready, waiting }
  let nextId = 1;

  function sendToWindow(command) {
    if (!transport) return;
    if (transport.ready) transport.send(command);
    else transport.waiting.push(command);
  }

  function ensureTransport() {
    if (transport) return true;
    const opening = { send: null, ready: false, waiting: [] };
    let handle = null;
    try {
      handle = openTransport({
        onEvent: (event) => {
          if (transport === opening) fromWindow(event);
        },
        onGone: () => {
          if (transport === opening) transportGone();
        }
      });
    } catch {
      return false;
    }
    if (!handle) return false;
    opening.send = (command) => handle.send(command);
    transport = opening;
    return true;
  }

  function transportGone() {
    transport = null;
    channelsGone();
  }

  function channelsGone() {
    for (const device of devices.values()) {
      if (device.channelId !== null) endChannel(device, { tellWindow: false });
    }
  }

  function fromWindow(event) {
    if (event === null || typeof event !== 'object') return;
    if (event.ev === 'ready') {
      // Saying it twice means the page started over, and its channels went with the old one.
      if (transport.ready) channelsGone();
      const { waiting } = transport;
      transport.ready = true;
      transport.waiting = [];
      for (const command of waiting) transport.send(command);
      return;
    }
    const device = channels.get(event.id);
    if (!device) return;
    if (event.ev === 'signal') signalFromWindow(device, event.data);
    else if (event.ev === 'open') channelOpened(device);
    else if (event.ev === 'closed') endChannel(device, { tellWindow: false });
    else if (event.ev === 'data' && ArrayBuffer.isView(event.bytes)) receiveMessage(device, event.bytes);
  }

  function signalFromWindow(device, data) {
    const clean = cleanSignal(data);
    if (!clean || (blockCandidates && clean.kind === KIND_CANDIDATE)) return;
    onSignal(device.deviceId, { attempt: device.attempt, ...clean });
  }

  // ---- A channel's life ----

  function clearTimers(device) {
    if (device.attemptTimer !== null) clock.clearTimeout(device.attemptTimer);
    if (device.retryTimer !== null) clock.clearTimeout(device.retryTimer);
    device.attemptTimer = null;
    device.retryTimer = null;
  }

  // False if there's no window to do it in. For the initiator that's one more thing to wait out.
  function startChannel(device) {
    clearTimers(device);
    if (!ensureTransport()) return false;
    const id = nextId++;
    device.channelId = id;
    device.opened = false;
    device.openedAt = null;
    device.parts = [];
    device.partBytes = 0;
    channels.set(id, device);
    device.attemptTimer = clock.setTimeout(() => {
      device.attemptTimer = null;
      endChannel(device, { tellWindow: true });
    }, ATTEMPT_TIMEOUT_MS);
    sendToWindow({ op: 'open', id, initiator: device.initiator, iceServers });
    return true;
  }

  function channelOpened(device) {
    if (device.opened) return;
    device.opened = true;
    device.openedAt = clock.now();
    if (device.attemptTimer !== null) clock.clearTimeout(device.attemptTimer);
    device.attemptTimer = null;
    onOpen(device.deviceId);
  }

  // State is settled before anyone hears about it, since onClose can call straight back in.
  function endChannel(device, { tellWindow, retry = true }) {
    const id = device.channelId;
    const { opened, openedAt } = device;
    channels.delete(id);
    device.channelId = null;
    device.opened = false;
    device.parts = [];
    device.partBytes = 0;
    clearTimers(device);
    if (tellWindow) sendToWindow({ op: 'close', id });
    if (opened && clock.now() - openedAt >= STABLE_MS) device.retries = 0;
    if (retry && device.initiator) scheduleRetry(device);
    if (opened) onClose(device.deviceId);
  }

  function scheduleRetry(device) {
    const delay = Math.min(RETRY_BASE_MS * 2 ** device.retries, RETRY_MAX_MS);
    device.retries += 1;
    device.retryTimer = clock.setTimeout(() => {
      device.retryTimer = null;
      attempt(device);
    }, delay);
  }

  function attempt(device) {
    device.attempt += 1;
    if (!startChannel(device)) scheduleRetry(device);
  }

  // ---- The other end's signals ----

  function signal(deviceId, data) {
    const device = devices.get(deviceId);
    const clean = cleanSignal(data);
    if (!device || !clean || !Number.isSafeInteger(data.attempt) || data.attempt < 1) return;
    if (blockCandidates && clean.kind === KIND_CANDIDATE) return;

    if (clean.kind === KIND_OFFER) {
      if (device.initiator || data.attempt <= device.attempt) return;
      if (device.channelId !== null) endChannel(device, { tellWindow: true });
      // An offer it can't take leaves things as they were, for the next one to try.
      if (!startChannel(device)) return;
      device.attempt = data.attempt;
    } else {
      if (data.attempt !== device.attempt || device.channelId === null) return;
      if (clean.kind === KIND_ANSWER && !device.initiator) return;
    }
    sendToWindow({ op: 'signal', id: device.channelId, data: clean });
  }

  // ---- Bytes ----

  function send(deviceId, bytes) {
    const device = devices.get(deviceId);
    if (!device || !device.opened) return;
    const room = MAX_MESSAGE_BYTES - 1;
    for (let offset = 0; offset < bytes.length; offset += room) {
      const part = bytes.subarray(offset, offset + room);
      const message = new Uint8Array(1 + part.length);
      message[0] = offset + room >= bytes.length ? PART_LAST : PART_MORE;
      message.set(part, 1);
      sendToWindow({ op: 'send', id: device.channelId, bytes: message });
    }
  }

  function receiveMessage(device, view) {
    const message = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const marker = message[0];
    const tooLarge = message.length > MAX_MESSAGE_BYTES || device.partBytes + message.length - 1 > MAX_REASSEMBLED_BYTES;
    if ((marker !== PART_MORE && marker !== PART_LAST) || tooLarge) {
      // Empty lands here too, with no marker. Only a broken or hostile peer sends any of these.
      return endChannel(device, { tellWindow: true });
    }
    device.parts.push(message.subarray(1));
    device.partBytes += message.length - 1;
    if (marker === PART_MORE) return undefined;

    const whole = new Uint8Array(device.partBytes);
    let offset = 0;
    for (const part of device.parts) {
      whole.set(part, offset);
      offset += part.length;
    }
    device.parts = [];
    device.partBytes = 0;
    return onData(device.deviceId, whole);
  }

  // ---- The manager's side ----

  // For one session, replacing whatever this device had. A new session starts the attempts over.
  function connect(deviceId, initiator) {
    close(deviceId);
    const device = {
      deviceId,
      initiator: initiator === true,
      attempt: 0,
      retries: 0,
      channelId: null,
      opened: false,
      openedAt: null,
      parts: [],
      partBytes: 0,
      attemptTimer: null,
      retryTimer: null
    };
    devices.set(deviceId, device);
    if (device.initiator) attempt(device);
  }

  function close(deviceId) {
    const device = devices.get(deviceId);
    if (!device) return;
    devices.delete(deviceId);
    clearTimers(device);
    if (device.channelId !== null) endChannel(device, { tellWindow: true, retry: false });
  }

  return { connect, signal, send, close };
}

module.exports = {
  createDirectPath,
  ICE_SERVERS, MAX_MESSAGE_BYTES, MAX_REASSEMBLED_BYTES,
  ATTEMPT_TIMEOUT_MS, RETRY_BASE_MS, RETRY_MAX_MS, STABLE_MS
};
