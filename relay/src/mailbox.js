// One Mailbox per device. It holds that device's single live WebSocket and hands
// it frames from other devices. Nothing is stored, so there is nothing to read
// later and nothing to deliver late: a frame for a device that isn't connected is
// answered with `offline` and forgotten.
//
// Sockets use the Hibernation API, so an idle device costs nothing. That rules
// out timers and in-memory per-socket state: what has to outlive a sleep lives in
// the socket's attachment, and the only timer is a Durable Object alarm.
//
// Auth: the Worker sends `{ t:'challenge', nonce }` and the device replies
// `{ t:'auth', publicKey, sig }`, all fields base64. `sig` is Ed25519 over the
// UTF-8 bytes of AUTH_LABEL + nonce (the nonce exactly as sent), and the device id
// in the URL must be the one derived from `publicKey`. Once that checks out the
// Worker sends `{ t:'ready' }`. Clients wait for it before sending.
import { DurableObject } from 'cloudflare:workers';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_MESSAGES_PER_SECOND = 120;

const AUTH_LABEL = 'sanctum-relay-auth-v1:';
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const DEVICE_ID = /^[a-z2-7]{16}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

const encoder = new TextEncoder();

// For the test bindings that shorten lifetimes. Anything unusable falls back.
export function millisecondsFrom(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Measured in bytes. A UTF-16 unit is at least one byte and at most three, which
// settles most strings without encoding them.
export function isOversize(message) {
  if (typeof message !== 'string') return message.byteLength > MAX_FRAME_BYTES;
  if (message.length > MAX_FRAME_BYTES) return true;
  if (message.length * 3 <= MAX_FRAME_BYTES) return false;
  return encoder.encode(message).byteLength > MAX_FRAME_BYTES;
}

// A fixed one-second window. 'warn' comes once per window, on the first frame
// over the limit, so the warning can't itself become a flood.
export function createRateLimiter(limit = MAX_MESSAGES_PER_SECOND, windowMs = 1000) {
  let start = 0;
  let count = 0;
  let warned = false;
  return function check(now = Date.now()) {
    if (now - start >= windowMs) {
      start = now;
      count = 0;
      warned = false;
    }
    count += 1;
    if (count <= limit) return 'ok';
    if (warned) return 'drop';
    warned = true;
    return 'warn';
  };
}

// Canonical base64 only, so one key or signature has one spelling.
function fromBase64(value, length) {
  if (typeof value !== 'string') return null;
  try {
    const binary = atob(value);
    if (binary.length !== length) return null;
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return btoa(binary) === value ? bytes : null;
  } catch {
    return null;
  }
}

// Same derivation as lib/remote/crypto.js: RFC 4648 base32, lowercase, no padding,
// of the first 10 bytes (80 bits, so exactly 16 characters) of SHA-256(publicKey).
async function deviceIdFromPublicKey(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  let id = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest.subarray(0, 10)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return id;
}

async function proves({ deviceId, nonce }, msg) {
  const publicKey = fromBase64(msg.publicKey, PUBLIC_KEY_BYTES);
  const sig = fromBase64(msg.sig, SIGNATURE_BYTES);
  if (!publicKey || !sig) return false;
  try {
    if ((await deviceIdFromPublicKey(publicKey)) !== deviceId) return false;
    const key = await crypto.subtle.importKey('raw', publicKey, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig, encoder.encode(AUTH_LABEL + nonce));
  } catch {
    return false;
  }
}

function randomNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

// Answers the other side's close so the connection ends now rather than after a
// timeout. A status code that can't be sent back (1005 for "none given") becomes 1000,
// and a socket that is already fully closed has nothing left to answer.
export function acknowledgeClose(ws, code, reason) {
  closeQuietly(ws, code === 1005 ? 1000 : code, reason);
}

// An alarm that throws is retried, so a socket that is already going away mustn't fail one.
export function closeQuietly(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
}

function trySend(ws, value) {
  try {
    ws.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class Mailbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Per Mailbox rather than per socket, so reconnecting doesn't reset the count.
    // After a hibernation it starts empty, which is right: nothing was arriving.
    this.rate = createRateLimiter();
  }

  async fetch(request) {
    const deviceId = new URL(request.url).pathname.split('/').pop();
    const deadline = Date.now() + millisecondsFrom(this.env.AUTH_TIMEOUT_MS, DEFAULT_AUTH_TIMEOUT_MS);
    const nonce = randomNonce();
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ deviceId, nonce, deadline, authed: false });
    this.ctx.acceptWebSocket(server);
    trySend(server, { t: 'challenge', nonce });
    // One alarm covers every unauthenticated socket; it re-arms for the rest.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Drops connections that never answered the challenge.
  async alarm() {
    const now = Date.now();
    let next = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || att.authed || typeof att.deadline !== 'number') continue;
      if (att.deadline <= now) closeQuietly(ws, CLOSE_POLICY, 'auth timeout');
      else next = next === null ? att.deadline : Math.min(next, att.deadline);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async webSocketMessage(ws, message) {
    if (isOversize(message)) return ws.close(CLOSE_TOO_BIG, 'frame too large');
    const att = ws.deserializeAttachment();
    if (!att) return ws.close(CLOSE_POLICY, 'unknown connection');
    if (att.authed) {
      const verdict = this.rate();
      if (verdict === 'warn') trySend(ws, { t: 'slow-down' });
      if (verdict !== 'ok') return;
    }
    if (typeof message !== 'string') return ws.close(CLOSE_UNSUPPORTED, 'text only');

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return ws.close(CLOSE_POLICY, 'bad frame');
    }
    if (msg === null || typeof msg !== 'object') return ws.close(CLOSE_POLICY, 'bad frame');

    if (!att.authed) return this.#authenticate(ws, att, msg);
    if (msg.t === 'send') await this.#send(ws, att.deviceId, msg);
  }

  async webSocketClose(ws, code, reason) {
    acknowledgeClose(ws, code, reason);
  }

  async #authenticate(ws, att, msg) {
    if (msg.t !== 'auth' || !(await proves(att, msg))) return ws.close(CLOSE_POLICY, 'auth failed');
    // Only a device that proved its key can push out the current connection, so
    // someone who merely knows an id can't knock a real device offline. This runs
    // without yielding, so two logins racing each other can't both stay.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && other.deserializeAttachment()?.authed) {
        other.serializeAttachment({ deviceId: att.deviceId, authed: false });
        other.close(1000, 'replaced');
      }
    }
    ws.serializeAttachment({ deviceId: att.deviceId, authed: true });
    trySend(ws, { t: 'ready' });
  }

  async #send(ws, from, msg) {
    const { to, data } = msg;
    if (typeof to !== 'string' || !DEVICE_ID.test(to) || !('data' in msg)) return;
    let delivered = false;
    try {
      delivered = to === from
        ? await this.deliver(from, data)
        : await this.env.MAILBOX.get(this.env.MAILBOX.idFromName(to)).deliver(from, data);
    } catch {
      // A target that can't be reached is the same as one that isn't there.
    }
    if (!delivered) trySend(ws, { t: 'offline', to });
  }

  // Called by other Mailboxes (Durable Object RPC). True only if a live socket took it.
  async deliver(from, data) {
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.authed && trySend(ws, { t: 'recv', from, data })) delivered = true;
    }
    return delivered;
  }
}
