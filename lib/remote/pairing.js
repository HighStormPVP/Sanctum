// Pairing: the code rules, and the message exchange that turns a short shared
// code into each device knowing the other's identity key. No Electron here, so
// test/remote-pairing.test.js can run it under plain Node.
//
// The host is the 'home' side and the guest is the 'laptop' side. Messages are
// JSON-safe, with base64 fields, and opaque to the relay:
//
//   1. guest -> host  { t:'pake', pake }
//   2. host -> guest  { t:'pake-reply', pake, confirm }
//   3. guest -> host  { t:'confirm', confirm, nonce, box }
//   4. host -> guest  { t:'identity', nonce, box }
//
// Each side checks the other's confirmation before it uses the shared key at all,
// so neither reveals its identity to someone who doesn't hold the code. `handle`
// never throws on what it's sent: anything wrong is `{ failed: true }`, which sends
// nothing and says nothing about why.
//
// Message 4 has no answer, so if it's lost or tampered with, the host has its peer
// and the guest has failed. No protocol can close that gap, and what the host holds
// is still the real guest's verified identity.
//
// For an attempt that came over the local network, message 4 also carries the home
// PC's service address, inside the seal, so a laptop that has only the code learns it.
// The manager says which messages came that way, through handle's second argument, and
// the address goes only if the pake and the confirmation both did. By then both
// confirmations have verified, so nobody without the code ever sees it.
const nodeCrypto = require('node:crypto');
const { sha256 } = require('@noble/hashes/sha2');
const { sign, verify, hkdf, seal, open, deviceIdFromPublicKey } = require('./crypto.js');
const { pakeStart } = require('./pake.js');

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;

const ROLE_HOME = 'home';
const ROLE_LAPTOP = 'laptop';

const SEAL_KEY_INFO = 'sanctum-pairing-seal-v1';
const SEAL_KEY_LENGTH = 32;
const IDENTITY_LABEL = 'sanctum-pairing-identity-v1';
const NONCE_LENGTH = 24;

const encodeText = (text) => new TextEncoder().encode(text);
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const failed = () => ({ failed: true });

// Refuses any spelling but the canonical one. Buffer.from alone skips junk and
// takes the URL-safe alphabet, so the same bytes could arrive many ways.
function fromBase64(value) {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? new Uint8Array(decoded) : null;
}

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[nodeCrypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// Checks for ASCII before uppercasing, because toUpperCase turns some other
// characters into valid ones: long s into S, and sharp s into SS.
function normalizeCode(input) {
  if (typeof input !== 'string' || !/^[0-9A-Za-z]+$/.test(input) || input.length !== CODE_LENGTH) return null;
  const code = input.toUpperCase();
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

// These are the caller's own values, not the network's, so a bad one throws here
// rather than surfacing later as a pairing that mysteriously fails.
function checkedCode({ code, identity, name }) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error('Invalid pairing code');
  if (typeof name !== 'string') throw new Error('A device name is required');
  if (!(identity?.publicKey instanceof Uint8Array) || !(identity?.secretKey instanceof Uint8Array)) {
    throw new Error('An identity key pair is required');
  }
  return normalized;
}

// sharedKey is 16 bytes, and seal needs 32.
function deriveSealKey(sharedKey) {
  return hkdf(sharedKey, undefined, encodeText(SEAL_KEY_INFO), SEAL_KEY_LENGTH);
}

// RFC 9382 Section 3.2: len(S) is an eight-byte little-endian length.
function withLength(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

// What a device signs to prove it holds its identity key for this exchange. It
// names the signer's role, so a signature can't be sent back to its maker, and
// both pake messages, so it can't be replayed into another exchange.
function identityProof(role, { homePake, laptopPake }) {
  const digest = sha256(Buffer.concat([withLength(homePake), withLength(laptopPake)]));
  return Buffer.concat([encodeText(IDENTITY_LABEL), encodeText(role), digest]);
}

function sealIdentity({ sealKey, role, identity, name, pakes, address }) {
  const nonce = nodeCrypto.randomBytes(NONCE_LENGTH);
  const plaintext = JSON.stringify({
    publicKey: toBase64(identity.publicKey),
    name,
    signature: toBase64(sign(identity.secretKey, identityProof(role, pakes))),
    ...(typeof address === 'string' ? { address } : {})
  });
  const box = seal(sealKey, nonce, encodeText(plaintext), encodeText(role));
  return { nonce: toBase64(nonce), box: toBase64(box) };
}

// Returns the peer `role` claims to be, or null unless it proves it. An address, if
// there is one, comes back beside the peer, and has to be a string.
function openIdentity({ sealKey, role, msg, pakes }) {
  const nonce = fromBase64(msg.nonce);
  const box = fromBase64(msg.box);
  if (!nonce || !box) return null;

  let claim;
  try {
    claim = JSON.parse(new TextDecoder().decode(open(sealKey, nonce, box, encodeText(role))));
  } catch {
    return null;
  }

  const publicKey = fromBase64(claim?.publicKey);
  const signature = fromBase64(claim?.signature);
  if (!publicKey || !signature || typeof claim.name !== 'string') return null;
  if ('address' in claim && typeof claim.address !== 'string') return null;
  if (!verify(publicKey, identityProof(role, pakes), signature)) return null;
  const peer = { deviceId: deviceIdFromPublicKey(publicKey), publicKey, name: claim.name };
  return 'address' in claim ? { peer, address: claim.address } : { peer };
}

// Runs `finish` on bytes off the network. It throws on an invalid point.
function finishPake(pake, peerMessage) {
  try {
    return pake.finish(peerMessage);
  } catch {
    return null;
  }
}

function localAddress(options) {
  return typeof options?.address === 'string' ? options.address : null;
}

function createPairingHost({ code, identity, name }) {
  const normalized = checkedCode({ code, identity, name });
  let attemptsLeft = MAX_ATTEMPTS;
  let inFlight = null;
  let paired = false;

  function startAttempt(msg, options) {
    const laptopPake = fromBase64(msg.pake);
    if (!laptopPake || attemptsLeft === 0) return failed();

    // Charged now, not when a confirmation fails. The reply lets the sender test
    // one guess at the code, and a sender who walks away with it would otherwise
    // have guessed for free. This also caps the blocking pakeStart below, whatever
    // the message turns out to hold.
    attemptsLeft -= 1;
    const pake = pakeStart(normalized, ROLE_HOME);
    const keys = finishPake(pake, laptopPake);
    if (!keys) return failed();

    inFlight = { keys, pakes: { homePake: pake.message, laptopPake }, address: localAddress(options) };
    return {
      reply: { t: 'pake-reply', pake: toBase64(pake.message), confirm: toBase64(keys.confirmMessage) }
    };
  }

  function finishAttempt({ keys, pakes, address: startedWith }, msg, options) {
    const confirm = fromBase64(msg.confirm);
    if (!confirm || !keys.verifyConfirm(confirm)) return failed();

    const sealKey = deriveSealKey(keys.sharedKey);
    // Whatever the laptop says about an address is dropped: only home sends one.
    const opened = openIdentity({ sealKey, role: ROLE_LAPTOP, msg, pakes });
    if (!opened) return failed();

    paired = true;
    attemptsLeft += 1; // this one didn't fail
    const address = startedWith !== null && localAddress(options) === startedWith ? startedWith : null;
    return { reply: { t: 'identity', ...sealIdentity({ sealKey, role: ROLE_HOME, identity, name, pakes, address }) }, peer: opened.peer };
  }

  return {
    // Reaches 0 while the fifth attempt is still in flight, and that attempt can
    // still succeed. The code is cancelled once a result is failed and this is 0, or
    // once this has been 0 for 15 seconds with no pairing, because a guest with a wrong
    // code goes silent and no failed result ever comes. The manager applies both.
    get attemptsLeft() {
      return attemptsLeft;
    },
    // `options.address` only for a message that came over the local network.
    handle(msg, options) {
      if (paired) return failed();
      // Whatever arrives ends the attempt in flight, so each one gets a single try
      // at its confirmation.
      const attempt = inFlight;
      inFlight = null;
      if (msg?.t === 'pake') return startAttempt(msg, options);
      if (msg?.t === 'confirm' && attempt) return finishAttempt(attempt, msg, options);
      return failed();
    }
  };
}

function createPairingGuest({ code, identity, name }) {
  const pake = pakeStart(checkedCode({ code, identity, name }), ROLE_LAPTOP);
  const laptopPake = pake.message;
  // A guest gets one try. Only a step that succeeds sets this again.
  let next = receiveReply;

  function receiveReply(msg) {
    if (msg?.t !== 'pake-reply') return failed();
    const homePake = fromBase64(msg.pake);
    const confirm = fromBase64(msg.confirm);
    if (!homePake || !confirm) return failed();

    const keys = finishPake(pake, homePake);
    if (!keys || !keys.verifyConfirm(confirm)) return failed();

    const sealKey = deriveSealKey(keys.sharedKey);
    const pakes = { homePake, laptopPake };
    next = (identityMsg) => receiveIdentity(identityMsg, sealKey, pakes);
    return {
      reply: {
        t: 'confirm',
        confirm: toBase64(keys.confirmMessage),
        ...sealIdentity({ sealKey, role: ROLE_LAPTOP, identity, name, pakes })
      }
    };
  }

  function receiveIdentity(msg, sealKey, pakes) {
    if (msg?.t !== 'identity') return failed();
    return openIdentity({ sealKey, role: ROLE_HOME, msg, pakes }) ?? failed();
  }

  return {
    first: { t: 'pake', pake: toBase64(laptopPake) },
    handle(msg) {
      const step = next;
      next = null;
      return step ? step(msg) : failed();
    }
  };
}

module.exports = { CODE_ALPHABET, newCode, normalizeCode, createPairingHost, createPairingGuest };
