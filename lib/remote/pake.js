// Pairing key agreement: RFC 9382, ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC, on
// @noble/curves P-256. This is the only cryptography Sanctum writes itself, so
// it follows the RFC line by line and adds nothing of its own. No Electron here,
// so test/remote-crypto.test.js can run it under plain Node against the RFC's
// Appendix B vectors.
//
// The 'home' side is the RFC's A and the 'laptop' side is its B.
const nodeCrypto = require('node:crypto');
const { p256 } = require('@noble/curves/nist');
const { hmac } = require('@noble/hashes/hmac');
const { sha256 } = require('@noble/hashes/sha2');
const { hkdf } = require('./crypto.js');

const Point = p256.Point;
const Fn = Point.Fn;

const ROLE_A = 'home';
const ROLE_B = 'laptop';

// RFC 9382 Section 6, the P-256 row. Nobody knows their discrete logs, which
// the protocol's security depends on, so they are copied and never derived here.
const M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';
const M = Point.fromHex(M_HEX);
const N = Point.fromHex(N_HEX);

const ID_A = 'sanctum-home';
const ID_B = 'sanctum-laptop';
const AAD = 'sanctum-pairing-v1';

// RFC 9382 leaves the password hash to the protocol using it (Section 3.2).
// Node's default maxmem sits just below what N = 2^15, r = 8 needs. The output
// is 64 bytes, far past the 64 extra bits the RFC suggests, so reducing it
// modulo the group order leaves no usable bias.
const SCRYPT_SALT = 'sanctum-pairing-v1';
const SCRYPT_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const POINT_LENGTH = 65; // SEC1 uncompressed: 0x04 || x || y
const POINT_PREFIX = 0x04;

function encodeText(text) {
  return new TextEncoder().encode(text);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// RFC 9382 Section 3.2: len(S) is an eight-byte little-endian length.
function withLength(bytes) {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
  return concat(length, bytes);
}

function assertRole(role) {
  if (role !== ROLE_A && role !== ROLE_B) {
    throw new Error(`Unknown pairing role: ${role}`);
  }
}

// The RFC's transcript and vectors use the uncompressed form only. Accepting
// another encoding of the same point would give the two sides different
// transcripts, so anything else is refused before the library sees it. The
// library then refuses off-curve points, unreduced coordinates and the identity.
function decodePeerMessage(message) {
  if (!(message instanceof Uint8Array) || message.length !== POINT_LENGTH || message[0] !== POINT_PREFIX) {
    throw new Error('Invalid pairing message: not an uncompressed P-256 point');
  }
  return Point.fromBytes(message);
}

// Compares in constant time. The expected length is public, so returning early
// on a wrong length gives nothing away.
function macEquals(expected, received) {
  return received instanceof Uint8Array
    && received.length === expected.length
    && nodeCrypto.timingSafeEqual(expected, received);
}

// One side of RFC 9382 Section 3.3. `scalar` is x on side A and y on side B.
// finish returns the whole key schedule, and pakeStart narrows it to the
// agreed interface.
function exchange({ w, scalar, role, idA, idB, aad }) {
  assertRole(role);
  if (!Fn.isValidNot0(w)) throw new Error('w must be a nonzero scalar below the group order');
  if (!Fn.isValidNot0(scalar)) throw new Error('The secret scalar must be nonzero and below the group order');

  const isA = role === ROLE_A;
  const ownMask = isA ? M : N;
  const peerMask = isA ? N : M;

  // pA = w*M + x*P on side A, pB = w*N + y*P on side B.
  const message = ownMask.multiply(w).add(Point.BASE.multiply(scalar)).toBytes(false);
  let finished = false;

  function finish(peerMessage) {
    // Section 7: x and y MUST NOT be reused, and an endpoint MUST abort on a bad
    // public value. So every call uses up this secret, even one that throws.
    if (finished) throw new Error('This pairing exchange has already finished');
    finished = true;

    const unmasked = decodePeerMessage(peerMessage).subtract(peerMask.multiply(w));
    if (unmasked.is0()) throw new Error('Invalid pairing message: identity after removing the mask');

    // K = h*x*(pB - w*N) on side A, h*y*(pA - w*M) on side B. P-256's cofactor
    // h is 1.
    const K = unmasked.multiply(scalar).toBytes(false);

    const pA = isA ? message : peerMessage;
    const pB = isA ? peerMessage : message;
    const transcript = concat(
      withLength(encodeText(idA)),
      withLength(encodeText(idB)),
      withLength(pA),
      withLength(pB),
      withLength(K),
      withLength(Fn.toBytes(w)) // big-endian, padded to the length of p
    );

    // Section 4: Ke || Ka = Hash(TT), then
    // KcA || KcB = KDF(Ka, nil, "ConfirmationKeys" || AAD).
    const digest = sha256(transcript);
    const Ke = digest.slice(0, 16);
    const Ka = digest.slice(16);
    const confirmationKeys = hkdf(
      Ka,
      new Uint8Array(0),
      concat(encodeText('ConfirmationKeys'), encodeText(aad)),
      32
    );
    const KcA = confirmationKeys.slice(0, 16);
    const KcB = confirmationKeys.slice(16);
    const confirmA = hmac(sha256, KcA, transcript);
    const confirmB = hmac(sha256, KcB, transcript);

    const confirmMessage = isA ? confirmA : confirmB;
    const expectedConfirm = isA ? confirmB : confirmA;
    return {
      K, transcript, Ke, Ka, KcA, KcB, confirmA, confirmB,
      sharedKey: Ke,
      confirmMessage,
      verifyConfirm: (peerConfirm) => macEquals(expectedConfirm, peerConfirm)
    };
  }

  return { message, finish };
}

function deriveW(code) {
  const out = nodeCrypto.scryptSync(code, SCRYPT_SALT, SCRYPT_LENGTH, SCRYPT_OPTIONS);
  return BigInt('0x' + out.toString('hex')) % Fn.ORDER;
}

// Runs scrypt synchronously, so this blocks the calling thread while it does.
function pakeStart(code, role) {
  if (typeof code !== 'string' || code.length === 0) throw new Error('Pairing code is required');
  assertRole(role);

  const { message, finish } = exchange({
    w: deriveW(code),
    scalar: Fn.fromBytes(p256.utils.randomSecretKey()),
    role,
    idA: ID_A,
    idB: ID_B,
    aad: AAD
  });
  return {
    message,
    finish(peerMessage) {
      const { sharedKey, confirmMessage, verifyConfirm } = finish(peerMessage);
      return { sharedKey, confirmMessage, verifyConfirm };
    }
  };
}

// For the RFC's test vectors, which fix the values that are otherwise secret or
// random. Not used in production paths. w and x are bigints, and x is the RFC's
// y when role is 'laptop'. idA, idB and aad are strings.
function spake2ForTest({ w, x, role, idA, idB, aad }) {
  return exchange({ w, scalar: x, role, idA, idB, aad });
}

module.exports = { pakeStart, spake2ForTest, M: M_HEX, N: N_HEX };
