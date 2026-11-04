// Thin wrappers over the audited noble libraries, so the rest of Remote Control
// never picks a curve, a cipher, or a parameter. No Electron here, so
// test/remote-crypto.test.js can run these under plain Node. Every value going
// in or out is a Uint8Array.
const { ed25519, x25519 } = require('@noble/curves/ed25519');
const { xchacha20poly1305 } = require('@noble/ciphers/chacha');
const { hkdf: nobleHkdf } = require('@noble/hashes/hkdf');
const { sha256 } = require('@noble/hashes/sha2');

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const DEVICE_ID_LENGTH = 16;

function newIdentity() {
  const secretKey = ed25519.utils.randomSecretKey();
  return { publicKey: ed25519.getPublicKey(secretKey), secretKey };
}

function sign(secretKey, msg) {
  return ed25519.sign(msg, secretKey);
}

// noble throws on malformed lengths rather than returning false. Anything that
// can't be checked hasn't been verified, and callers feed this bytes off the
// network, so all of those failures are a plain false. zip215 off selects
// RFC 8032's strict rules, which refuse non-canonical encodings.
function verify(publicKey, msg, sig) {
  try {
    return ed25519.verify(sig, msg, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

function newEphemeral() {
  const secretKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

// Throws on a low-order peer key, whose shared secret would be all zeros.
function sharedSecret(secretKey, peerPublic) {
  return x25519.getSharedSecret(secretKey, peerPublic);
}

function hkdf(ikm, salt, info, length) {
  return nobleHkdf(sha256, ikm, salt, info, length);
}

function seal(key, nonce, plaintext, aad) {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

function open(key, nonce, ciphertext, aad) {
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

// RFC 4648 base32 (lowercase, no padding) of the start of the key's SHA-256.
// 16 characters carry 80 bits, which is the first 10 bytes.
function deviceIdFromPublicKey(publicKey) {
  const digest = sha256(publicKey);
  let id = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; id.length < DEVICE_ID_LENGTH; i++) {
    buffer = (buffer << 8) | digest[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return id;
}

module.exports = {
  newIdentity,
  sign,
  verify,
  newEphemeral,
  sharedSecret,
  hkdf,
  seal,
  open,
  deviceIdFromPublicKey
};
