// Encrypted sessions: turns two devices' long-term identity keys into fresh traffic
// keys for one connection, then encrypts frames above lib/remote/link.js. No Electron
// here, so test/remote-session.test.js can run it under plain Node.
//
// A session lives for one connection and is never reused. Make a new one to reconnect.
//
// Handshake messages travel beside the link, before it starts, and are JSON-safe with
// base64 fields. An untrusted relay can read them and they tell it nothing it can use:
// ephemeral public keys and signatures, and no long-term key.
//
//   hello   { t:'session-hello', ephemeral }
//   auth    { t:'session-auth', ephemeral, signature }
//
// Either side may start, and both may start at once. Everything is checked against
// the role a side was created with, never one claimed on the wire. A hello isn't signed,
// because a signature has to cover the peer's fresh ephemeral key, which isn't known yet
// when a hello goes out. So answering a hello proves nothing about who sent it, and
// nothing counts as authenticated until the auth checks out.
//
//   One side starts:             Both at once:
//     A -> B  hello                A -> B  hello     B -> A  hello
//     B -> A  auth                 A -> B  auth      B -> A  auth
//     A -> B  auth
//
// handleHello's result says what to do next:
//   { reply, ready: false }  Send the reply. It's the auth, and waiting on the peer's.
//   { reply, ready: true }   Send the reply before any frame, then start the link.
//   { ready: true }          Start the link. Also what every message gets from a session
//                            that's already ready, so treat it as idempotent. Nothing
//                            that arrives after ready has any effect.
//   { ready: false }         Refused, and final. The session is dead, and only a new one
//                            can retry. handleHello never throws on what it's sent.
//
// The transcript fixes one order however the messages arrived: home's values come
// first, then laptop's. So both sides build the same bytes when the hellos cross, and
// neither needs to know who started.
//
// Each side signs the transcript under its own role. It covers both roles, both identity
// keys, and both ephemeral keys, which gives three properties:
//   - Replay: the signature covers the other side's fresh ephemeral key, so a recorded
//     auth checks out against no later session.
//   - Reflection: the signer's role is in what's signed, so a side's signature is never
//     what it expects from its peer, even if a device were paired with its own key.
//   - Misbinding: both identity keys are in it, so one meant for another pairing fails.
//
// Forward secrecy: traffic keys come from the ephemeral X25519 secret alone, with the
// transcript as salt. Long-term keys only sign. The ephemeral secret is dropped as soon
// as the shared secret exists, and the shared secret when the handshake ends. JavaScript
// can't reliably zero memory, so that means no references kept, not memory scrubbed.
//
// Frames, as bytes:
//
//   [0..7]   big-endian unsigned counter
//   [8..]    XChaCha20-Poly1305 ciphertext and tag
//
// Each direction has its own key, so the two can never collide on a nonce. The nonce
// is the counter alone, in the last 8 of its 24 bytes. The counter is on the wire but
// can't be chosen: decrypt takes only the exact next value, and since it's the nonce,
// changing it breaks the tag. A failed decrypt leaves the expected counter alone, so a
// forged frame can't desync the stream. link.js has already retired that frame's
// sequence number though, so the caller should treat a throw as the connection's end.
const { newEphemeral, sharedSecret, hkdf, seal, open, sign, verify } = require('./crypto.js');

const ROLE_HOME = 'home';
const ROLE_LAPTOP = 'laptop';

const TRANSCRIPT_LABEL = 'sanctum-session-transcript-v1';
const SIGNATURE_LABEL = 'sanctum-session-signature-v1';
const HOME_TO_LAPTOP_INFO = 'sanctum-session-home-to-laptop-v1';
const LAPTOP_TO_HOME_INFO = 'sanctum-session-laptop-to-home-v1';
const CONNECTION_ID_INFO = 'sanctum-session-connection-id-v1';

const KEY_LENGTH = 32;
const TRAFFIC_KEY_LENGTH = 32;
const CONNECTION_ID_LENGTH = 4;
const NONCE_LENGTH = 24;
const COUNTER_LENGTH = 8;
const TAG_LENGTH = 16;
const MAX_COUNTER = 2n ** 64n - 1n;

const MSG_HELLO = 'session-hello';
const MSG_AUTH = 'session-auth';

const encodeText = (text) => new TextEncoder().encode(text);
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const isKey = (value) => value instanceof Uint8Array && value.length === KEY_LENGTH;

// Refuses any spelling but the canonical one. Buffer.from alone skips junk and
// takes the URL-safe alphabet, so the same bytes could arrive many ways.
function fromBase64(value) {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
}

// Eight-byte little-endian length, as pairing's transcript has it, so no two sequences
// of fields can run together into the same bytes.
function withLength(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function buildTranscript({ home, laptop }) {
  return Buffer.concat(
    [
      encodeText(TRANSCRIPT_LABEL),
      encodeText(ROLE_HOME),
      home.identity,
      home.ephemeral,
      encodeText(ROLE_LAPTOP),
      laptop.identity,
      laptop.ephemeral
    ].map(withLength)
  );
}

function signedBytes(signerRole, transcript) {
  return Buffer.concat([withLength(encodeText(SIGNATURE_LABEL)), withLength(encodeText(signerRole)), transcript]);
}

// The one way from a counter to a nonce, for both directions, so nothing can wrap.
// Exported so a test can reach exhaustion, which no real session ever will.
function nonceFor(counter) {
  if (counter > MAX_COUNTER) throw new Error('Session frame counter exhausted');
  if (counter < 0n) throw new RangeError('A frame counter is never negative');
  const nonce = new Uint8Array(NONCE_LENGTH);
  new DataView(nonce.buffer).setBigUint64(NONCE_LENGTH - COUNTER_LENGTH, counter);
  return nonce;
}

function deriveKeys(secret, transcript, role) {
  const directionKey = (info) => hkdf(secret, transcript, encodeText(info), TRAFFIC_KEY_LENGTH);
  const homeToLaptop = directionKey(HOME_TO_LAPTOP_INFO);
  const laptopToHome = directionKey(LAPTOP_TO_HOME_INFO);
  return role === ROLE_HOME
    ? { send: homeToLaptop, receive: laptopToHome }
    : { send: laptopToHome, receive: homeToLaptop };
}

// These are the caller's own values, not the network's, so a bad one throws here
// rather than surfacing later as a handshake that mysteriously fails.
function checkArguments({ identity, peerPublicKey, role }) {
  if (role !== ROLE_HOME && role !== ROLE_LAPTOP) throw new Error('A role of home or laptop is required');
  if (!isKey(identity?.publicKey) || !isKey(identity?.secretKey)) throw new Error('An identity key pair is required');
  if (!isKey(peerPublicKey)) throw new Error('A peer public key is required');
}

function createSession({ identity, peerPublicKey, role } = {}) {
  checkArguments({ identity, peerPublicKey, role });
  const peerRole = role === ROLE_HOME ? ROLE_LAPTOP : ROLE_HOME;

  const { publicKey: ownEphemeral, secretKey: ephemeralSecret } = newEphemeral();

  // Everything secret or only useful to the handshake. Dropped whole when it ends, either
  // way, and `ephemeralSecret` sooner, as soon as the shared secret exists.
  let handshake = {
    ephemeralSecret,
    peerEphemeral: null,
    secret: null,
    transcript: null,
    auth: null,
    authSent: false
  };

  let keys = null;
  let connectionId = null;
  let sendCounter = 0n;
  let receiveCounter = 0n;

  // Binds this session to the first ephemeral key the peer shows. A different one later
  // is refused. Builds the auth here, so it's the same bytes however often it's asked for.
  function learnPeerEphemeral(peerEphemeral) {
    if (!peerEphemeral) return false;
    if (handshake.peerEphemeral) return sameBytes(handshake.peerEphemeral, peerEphemeral);
    if (peerEphemeral.length !== KEY_LENGTH || sameBytes(peerEphemeral, ownEphemeral)) return false;

    // Before signing anything, because this refuses a low-order key.
    let secret;
    try {
      secret = sharedSecret(handshake.ephemeralSecret, peerEphemeral);
    } catch {
      return false;
    }

    const own = { identity: identity.publicKey, ephemeral: ownEphemeral };
    const peer = { identity: peerPublicKey, ephemeral: peerEphemeral };
    const transcript = buildTranscript(role === ROLE_HOME ? { home: own, laptop: peer } : { home: peer, laptop: own });

    handshake.ephemeralSecret = null;
    handshake.secret = secret;
    handshake.peerEphemeral = peerEphemeral;
    handshake.transcript = transcript;
    handshake.auth = {
      t: MSG_AUTH,
      ephemeral: toBase64(ownEphemeral),
      signature: toBase64(sign(identity.secretKey, signedBytes(role, transcript)))
    };
    return true;
  }

  function refuse() {
    handshake = null;
    return { ready: false };
  }

  function receiveHello(msg) {
    if (!learnPeerEphemeral(fromBase64(msg.ephemeral))) return refuse();
    handshake.authSent = true;
    return { reply: handshake.auth, ready: false };
  }

  function receiveAuth(msg) {
    if (!learnPeerEphemeral(fromBase64(msg.ephemeral))) return refuse();
    const signature = fromBase64(msg.signature);
    if (!signature || !verify(peerPublicKey, signedBytes(peerRole, handshake.transcript), signature)) return refuse();

    const { secret, transcript, auth, authSent } = handshake;
    keys = deriveKeys(secret, transcript, role);
    connectionId = hkdf(secret, transcript, encodeText(CONNECTION_ID_INFO), CONNECTION_ID_LENGTH);
    handshake = null;
    return authSent ? { ready: true } : { reply: auth, ready: true };
  }

  return {
    hello: { t: MSG_HELLO, ephemeral: toBase64(ownEphemeral) },

    get connectionId() {
      return connectionId;
    },

    handleHello(msg) {
      if (keys) return { ready: true };
      if (!handshake) return { ready: false };
      if (msg?.t === MSG_HELLO) return receiveHello(msg);
      if (msg?.t === MSG_AUTH) return receiveAuth(msg);
      return refuse();
    },

    encrypt(plaintext) {
      if (!keys) throw new Error('Session is not ready');
      const nonce = nonceFor(sendCounter);
      const sealed = seal(keys.send, nonce, plaintext);
      sendCounter += 1n;

      const frame = new Uint8Array(COUNTER_LENGTH + sealed.length);
      frame.set(nonce.subarray(NONCE_LENGTH - COUNTER_LENGTH));
      frame.set(sealed, COUNTER_LENGTH);
      return frame;
    },

    decrypt(frame) {
      if (!keys) throw new Error('Session is not ready');
      if (!(frame instanceof Uint8Array) || frame.length < COUNTER_LENGTH + TAG_LENGTH) {
        throw new Error('Session frame is malformed');
      }
      const counter = new DataView(frame.buffer, frame.byteOffset, COUNTER_LENGTH).getBigUint64(0);
      if (counter !== receiveCounter) throw new Error('Session frame has the wrong counter');

      const plaintext = open(keys.receive, nonceFor(counter), frame.subarray(COUNTER_LENGTH));
      receiveCounter += 1n;
      return plaintext;
    }
  };
}

module.exports = { createSession, nonceFor };
