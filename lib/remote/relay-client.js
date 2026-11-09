// One WebSocket to the relay, for the connection manager. Two kinds, both built on the
// same channel:
//
//   connectDevice    /<secret>/device/<deviceId>: answers the challenge, waits for ready,
//                    then sends to and receives from other devices.
//   connectPairing   /<secret>/pair/host|guest: the one pairing slot, with no auth.
//
// The address holds the relay's secret, so nothing here logs it or puts it in an error.
//
// Everything arriving here is from an untrusted relay and gets checked for shape only.
// Authenticating it is the session layer's job. The secret key is used for one signature
// per connection, over a domain-separated label, and this client lets go of it after that.
//
// A channel doesn't reconnect. It reports onClose once, unless its owner closed it, and
// the manager decides what happens next. onClose gets a reason: an HTTP status, an error
// code, or 'closed' (see reasonFrom).
const WebSocket = require('ws');
const { sign, deviceIdFromPublicKey } = require('./crypto.js');

const AUTH_LABEL = 'sanctum-relay-auth-v1:';
const MAX_NONCE_LENGTH = 1024;

// The relay refuses a frame over 1 MiB, and allows 120 messages a second per device.
// Staying under that leaves room for the fixed window's boundaries.
const MAX_OUTBOUND_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_SECOND = 100;
const WINDOW_MS = 1000;
const SLOW_DOWN_MS = 1000;

// An inbound frame is under the relay's limit plus its envelope, so more is a bad relay.
const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

// The link holds at most 64 MiB, or about 85 MiB as base64, with some duplicates from
// resends on top. Past this a send is refused, and the link sends it again later.
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
// Past this the socket isn't keeping up, so messages wait in the queue instead.
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const BACKED_UP_RETRY_MS = 250;

const HANDSHAKE_TIMEOUT_MS = 15000;
const PING_EVERY_MS = 30000;

// What `ws` says when the handshake runs out of time. It carries no code of its own.
const HANDSHAKE_TIMED_OUT = 'Opening handshake has timed out';

// Why a channel ended, for onClose: the HTTP status if the relay answered with a page instead
// of a WebSocket (404 is the relay refusing the address), an error's system code such as
// ENOTFOUND or CERT_HAS_EXPIRED, or 'closed'. Only a status number or a plain code, so nothing
// from the address can ride along.
function reasonFrom(err) {
  const code = err?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  if (err?.message === HANDSHAKE_TIMED_OUT) return 'ETIMEDOUT';
  return 'closed';
}

function createChannel({ url, clock, WebSocketImpl, onOpen, onMessage, onClose }) {
  const ws = new WebSocketImpl(url, {
    maxPayload: MAX_INBOUND_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS
  });

  let opened = false;
  let finished = false;
  let reason = null;
  let queue = [];
  let queuedBytes = 0;
  let windowStart = -Infinity;
  let sentInWindow = 0;
  let pausedUntil = -Infinity;
  let pumpTimer = null;
  let closeWhenDrained = false;
  let alive = true;
  let pingTimer = null;

  function stopTimers() {
    if (pumpTimer !== null) clock.clearTimeout(pumpTimer);
    if (pingTimer !== null) clock.clearInterval(pingTimer);
    pumpTimer = null;
    pingTimer = null;
  }

  function finish() {
    if (finished) return;
    finished = true;
    stopTimers();
    queue = [];
    // The close frame may have come without the TCP connection ending, so end it here.
    try {
      ws.terminate();
    } catch { /* already gone */ }
    onClose(reason ?? 'closed');
  }

  function pumpLater(ms) {
    if (pumpTimer !== null) return;
    pumpTimer = clock.setTimeout(() => {
      pumpTimer = null;
      pump();
    }, ms);
  }

  function pump() {
    if (finished || !opened) return;
    while (queue.length) {
      const t = clock.now();
      if (t < pausedUntil) return pumpLater(pausedUntil - t);
      if (t - windowStart >= WINDOW_MS) {
        windowStart = t;
        sentInWindow = 0;
      }
      if (sentInWindow >= MAX_MESSAGES_PER_SECOND) return pumpLater(windowStart + WINDOW_MS - t);
      if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) return pumpLater(BACKED_UP_RETRY_MS);

      const text = queue.shift();
      queuedBytes -= text.length;
      sentInWindow += 1;
      try {
        ws.send(text);
      } catch {
        return finish();
      }
    }
    if (closeWhenDrained) closeSocket();
  }

  // Marked finished first, because the owner has asked for this and needs no onClose.
  function closeSocket() {
    finished = true;
    stopTimers();
    queue = [];
    try {
      ws.close(1000);
    } catch { /* already closing */ }
  }

  function ping() {
    if (!alive) return finish();
    alive = false;
    try {
      ws.ping();
    } catch {
      finish();
    }
  }

  ws.on('open', () => {
    if (finished) return;
    opened = true;
    // The close frame is what counts. A socket the Worker closes outside a message
    // handler may never end its TCP connection, and then `ws` never emits 'close'.
    if (ws._receiver) ws._receiver.once('conclude', finish);
    pingTimer = clock.setInterval(ping, PING_EVERY_MS);
    onOpen();
    pump();
  });
  ws.on('pong', () => {
    alive = true;
  });
  ws.on('message', (raw, isBinary) => {
    if (finished) return;
    alive = true;
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg !== null && typeof msg === 'object') onMessage(msg);
  });
  // A 'close' follows an error, or ends things here if it doesn't. Never logged: an
  // error from `ws` can carry the URL, and the URL holds the secret. Only its code is kept.
  ws.on('error', (err) => {
    if (reason === null) reason = reasonFrom(err);
    finish();
  });
  ws.on('close', () => finish());
  // With this listened for, `ws` leaves ending the request to finish(), whose terminate() does.
  ws.on('unexpected-response', (req, res) => {
    if (finished) {
      try {
        ws.terminate();
      } catch { /* already gone */ }
      return;
    }
    const status = res?.statusCode;
    if (reason === null) reason = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'closed';
    finish();
  });

  return {
    // True if it's queued for sending. False means it won't go, and the caller's own
    // retry applies: the link resends, and a handshake restarts.
    send(value) {
      if (finished || closeWhenDrained) return false;
      const text = JSON.stringify(value);
      if (text.length > MAX_OUTBOUND_BYTES || queuedBytes + text.length > MAX_QUEUED_BYTES) return false;
      queue.push(text);
      queuedBytes += text.length;
      pump();
      return true;
    },
    pause(ms) {
      pausedUntil = clock.now() + ms;
    },
    close({ flush = false } = {}) {
      if (finished) return;
      if (flush && opened && queue.length) {
        closeWhenDrained = true;
        return;
      }
      closeSocket();
    }
  };
}

function connectDevice({ address, identity, clock, onReady, onMessage, onOffline, onClose, WebSocketImpl = WebSocket }) {
  const publicKey = Buffer.from(identity.publicKey).toString('base64');
  let secretKey = identity.secretKey;
  let stage = 'challenge';

  function answerChallenge(msg) {
    if (msg.t !== 'challenge' || typeof msg.nonce !== 'string' || msg.nonce.length > MAX_NONCE_LENGTH) return;
    const signed = sign(secretKey, new TextEncoder().encode(AUTH_LABEL + msg.nonce));
    secretKey = null;
    stage = 'auth';
    channel.send({ t: 'auth', publicKey, sig: Buffer.from(signed).toString('base64') });
  }

  const channel = createChannel({
    url: `${address}/device/${deviceIdFromPublicKey(identity.publicKey)}`,
    clock,
    WebSocketImpl,
    onOpen() {},
    onClose,
    onMessage(msg) {
      if (stage === 'challenge') return answerChallenge(msg);
      if (stage === 'auth') {
        if (msg.t !== 'ready') return;
        stage = 'ready';
        return onReady();
      }
      if (msg.t === 'recv') {
        if (typeof msg.from === 'string' && 'data' in msg) onMessage(msg.from, msg.data);
      } else if (msg.t === 'offline') {
        if (typeof msg.to === 'string') onOffline(msg.to);
      } else if (msg.t === 'slow-down') {
        channel.pause(SLOW_DOWN_MS);
      }
    }
  });

  return {
    send(to, data) {
      return stage === 'ready' && channel.send({ t: 'send', to, data });
    },
    close(options) {
      secretKey = null;
      channel.close(options);
    }
  };
}

function connectPairing({ address, role, clock, onOpen, onMessage, onNone, onClose, WebSocketImpl = WebSocket }) {
  const channel = createChannel({
    url: `${address}/pair/${role}`,
    clock,
    WebSocketImpl,
    onOpen,
    onClose,
    onMessage(msg) {
      if (msg.t === 'pair') {
        if ('data' in msg) onMessage(msg.data);
      } else if (msg.t === 'pair-none') {
        onNone();
      } else if (msg.t === 'slow-down') {
        channel.pause(SLOW_DOWN_MS);
      }
    }
  });

  return {
    send(data) {
      return channel.send({ t: 'pair', data });
    },
    close: channel.close
  };
}

module.exports = { connectDevice, connectPairing };
