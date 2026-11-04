// This device's Remote Control identity and paired devices, on disk.
//
// The file is JSON that has been through `protect` (Electron's safeStorage in
// production, so a copy of the disk is useless on another account). The JSON
// has two parts:
//   - the outside: the control switch, the wrong-PIN counter, and the PIN
//     record's salt, nonce and cost. Readable once `protect` is undone, with no
//     PIN, because a PIN-locked laptop must still honour its control switch and
//     the delay between guesses must survive a restart.
//   - the inside: the identity's secret key and the peer list, sealed with
//     XChaCha20-Poly1305 under a key scrypt derives from the PIN. A wrong PIN
//     fails that authentication, which is how it stays distinct from a damaged
//     file (a damaged outside fails to parse or unprotect).
//
// No Electron here: `protect`/`unprotect` are injected so this runs under
// plain Node in tests. The PIN is short, so the work factor is the defence
// against someone holding the file; the attempt delays and the wipe are the
// defence against someone typing.
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { newIdentity, seal, open } = require('./crypto');

const FORMAT_VERSION = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
const KEY_LENGTH = 32;

// Production cost. 2^17 * 8 * 128 bytes = 128 MiB and a few tenths of a second.
const DEFAULT_KDF_COST = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

// Bounds for a cost read back from disk or injected, so a damaged or tampered
// file can't ask for gigabytes.
const MIN_N = 2 ** 4;
const MAX_N = 2 ** 18;

const PIN_PATTERN = /^[0-9]{6,}$/;
const STORAGE_UNAVAILABLE_MESSAGE = "Remote Control's keys can't be opened right now because the system's secure storage isn't available yet. Try again in a moment.";
const FILE_BUSY_MESSAGE = "Remote Control's keys file is in use by another program right now. Try again in a moment.";
const MAX_WRONG_PINS = 10;
const FREE_WRONG_PINS = 3;
const MAX_WAIT_MS = 5 * 60 * 1000;
const ROLES = new Set(['home', 'laptop']);
const AAD_LABEL = Buffer.from('sanctum-keystore-v1\0', 'utf8');

// After the Nth wrong PIN in a row: nothing for N <= 3, then 1 s, 2 s, 4 s...
function waitAfter(wrongInARow) {
  if (wrongInARow <= FREE_WRONG_PINS) return 0;
  return Math.min(MAX_WAIT_MS, 1000 * 2 ** (wrongInARow - FREE_WRONG_PINS - 1));
}

function validCost(cost) {
  return Boolean(cost)
    && Number.isInteger(cost.N) && cost.N >= MIN_N && cost.N <= MAX_N && (cost.N & (cost.N - 1)) === 0
    && Number.isInteger(cost.r) && cost.r >= 1 && cost.r <= 16
    && Number.isInteger(cost.p) && cost.p >= 1 && cost.p <= 4;
}

function deriveKey(pin, salt, cost) {
  return new Promise((resolve, reject) => {
    const maxmem = 160 * cost.N * cost.r + (1 << 20);
    nodeCrypto.scrypt(Buffer.from(pin, 'utf8'), salt, KEY_LENGTH, { N: cost.N, r: cost.r, p: cost.p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(new Uint8Array(key));
    });
  });
}

// Binds the sealed part to this file's salt and cost, so neither can be
// swapped underneath it.
function aadFor(salt, cost) {
  return Buffer.concat([AAD_LABEL, salt, Buffer.from(`${cost.N}:${cost.r}:${cost.p}`, 'utf8')]);
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(text, length) {
  if (typeof text !== 'string') throw new Error('not base64');
  const bytes = Buffer.from(text, 'base64');
  if (length !== undefined && bytes.length !== length) throw new Error('wrong length');
  return new Uint8Array(bytes);
}

function sealInner(key, salt, cost, identity, peers) {
  const plain = Buffer.from(JSON.stringify({
    secretKey: b64(identity.secretKey),
    publicKey: b64(identity.publicKey),
    peers: peers.map((peer) => ({
      deviceId: peer.deviceId,
      publicKey: b64(peer.publicKey),
      name: peer.name,
      role: peer.role,
      ...(peer.provisional ? { provisional: true } : {})
    }))
  }), 'utf8');
  const nonce = new Uint8Array(nodeCrypto.randomBytes(NONCE_LENGTH));
  return { nonce, ct: seal(key, nonce, plain, aadFor(salt, cost)) };
}

// Returns { identity, peers } or null when the key is wrong (authentication
// failed). Throws if the authenticated contents are somehow malformed.
function openInner(key, pinRecord) {
  let plain;
  try {
    plain = open(key, pinRecord.nonce, pinRecord.ct, aadFor(pinRecord.salt, pinRecord.cost));
  } catch {
    return null;
  }
  const data = JSON.parse(Buffer.from(plain).toString('utf8'));
  const identity = { publicKey: fromB64(data.publicKey, 32), secretKey: fromB64(data.secretKey, 32) };
  if (!Array.isArray(data.peers)) throw new Error('peers missing');
  const peers = data.peers.map((peer) => normalizePeer({ ...peer, publicKey: fromB64(peer.publicKey, 32) }));
  return { identity, peers };
}

function normalizePeer(peer) {
  if (!peer || typeof peer.deviceId !== 'string' || !peer.deviceId) throw new TypeError('peer.deviceId must be a non-empty string');
  if (!(peer.publicKey instanceof Uint8Array) || peer.publicKey.length !== 32) throw new TypeError('peer.publicKey must be 32 bytes');
  if (typeof peer.name !== 'string') throw new TypeError('peer.name must be a string');
  if (!ROLES.has(peer.role)) throw new TypeError("peer.role must be 'home' or 'laptop'");
  return {
    deviceId: peer.deviceId,
    publicKey: new Uint8Array(peer.publicKey),
    name: peer.name,
    role: peer.role,
    ...(peer.provisional ? { provisional: true } : {})
  };
}

function clonePeer(peer) {
  return { ...peer, publicKey: new Uint8Array(peer.publicKey) };
}

// Antivirus and the search indexer briefly hold files on Windows, which makes a
// rename or delete fail with one of these although nothing is wrong. The store
// is single-threaded and the wait is tens of milliseconds, so block.
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [25, 50, 75, 100];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retryTransient(action) {
  for (let attempt = 0; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (!TRANSIENT_CODES.has(err.code) || attempt >= RETRY_DELAYS_MS.length) throw err;
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Temp file in the same folder, flushed, then renamed over the target. A crash
// leaves either the old file or the new one, never half of one.
function writeFileAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${nodeCrypto.randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    retryTransient(() => fs.renameSync(temp, file));
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already failing */ } }
    try { fs.unlinkSync(temp); } catch { /* may not exist */ }
    throw err;
  }
}

function emptyOuter() {
  return { controlAllowed: false, attempts: { failed: 0, lastAt: 0 }, pin: null };
}

function serializeOuter(outer) {
  return JSON.stringify({
    v: FORMAT_VERSION,
    controlAllowed: outer.controlAllowed,
    attempts: outer.attempts,
    pin: outer.pin && {
      salt: b64(outer.pin.salt),
      nonce: b64(outer.pin.nonce),
      ct: b64(outer.pin.ct),
      N: outer.pin.cost.N,
      r: outer.pin.cost.r,
      p: outer.pin.cost.p
    }
  });
}

// Throws on anything that isn't a well-formed version-1 file.
function parseOuter(text) {
  const data = JSON.parse(text);
  if (!data || data.v !== FORMAT_VERSION || typeof data.controlAllowed !== 'boolean') throw new Error('unrecognised keystore');
  const { attempts } = data;
  if (!attempts || !Number.isInteger(attempts.failed) || attempts.failed < 0 || !Number.isFinite(attempts.lastAt)) throw new Error('bad attempts');
  let pin = null;
  if (data.pin !== null) {
    const cost = { N: data.pin?.N, r: data.pin?.r, p: data.pin?.p };
    if (!validCost(cost)) throw new Error('bad cost');
    pin = {
      salt: fromB64(data.pin.salt, SALT_LENGTH),
      nonce: fromB64(data.pin.nonce, NONCE_LENGTH),
      ct: fromB64(data.pin.ct),
      cost
    };
  }
  return { controlAllowed: data.controlAllowed, attempts: { failed: attempts.failed, lastAt: attempts.lastAt }, pin };
}

function createKeystore({ file, protect, unprotect, now = Date.now, kdfCost = DEFAULT_KDF_COST, isProtectionAvailable = () => true } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('file is required');
  if (typeof protect !== 'function' || typeof unprotect !== 'function') throw new TypeError('protect and unprotect are required');
  if (!validCost(kdfCost)) throw new RangeError('kdfCost is outside the allowed range');

  let outer = emptyOuter();
  // False while `protect`/`unprotect` can't work yet (early boot, locked
  // keychain). The file is then left alone, since it may be perfectly good.
  let available = true;
  let unavailableMessage = STORAGE_UNAVAILABLE_MESSAGE;
  // Present only while unlocked: { key, identity, peers }.
  let unlocked = null;
  // Bumped by lock(), so an operation that was waiting on scrypt can tell.
  let lockEpoch = 0;
  // One PIN operation at a time, so parallel calls can't skip the delay.
  let queue = Promise.resolve();

  function setAside() {
    const copy = `${file}.unreadable.${now()}`;
    try {
      retryTransient(() => fs.renameSync(file, copy));
    } catch {
      try { fs.copyFileSync(file, copy); } catch { /* best effort: nothing more to try */ }
    }
  }

  function protectionAvailable() {
    try {
      return Boolean(isProtectionAvailable());
    } catch {
      return false;
    }
  }

  function load() {
    outer = emptyOuter();
    if (!protectionAvailable()) {
      available = false;
      unavailableMessage = STORAGE_UNAVAILABLE_MESSAGE;
      return;
    }
    available = true;
    let raw;
    try {
      raw = retryTransient(() => fs.readFileSync(file));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (TRANSIENT_CODES.has(err.code)) {
        // Something else holds the file (antivirus, indexer). The data may be
        // fine, so leave it be and let reload() try again.
        available = false;
        unavailableMessage = FILE_BUSY_MESSAGE;
        return;
      }
      setAside();
      return;
    }
    // Protection works, so a failure from here on is the file's fault.
    try {
      const plain = unprotect(new Uint8Array(raw));
      outer = parseOuter(Buffer.from(plain).toString('utf8'));
    } catch {
      outer = emptyOuter();
      setAside();
    }
  }

  // Writes first and updates memory only if the write worked, so memory never
  // claims something the disk doesn't have.
  function commit(patch) {
    if (!available) throw new Error(unavailableMessage);
    const next = { ...outer, ...patch };
    writeFileAtomic(file, Buffer.from(protect(Buffer.from(serializeOuter(next), 'utf8'))));
    outer = next;
  }

  function clearUnlocked() {
    if (unlocked) unlocked.key.fill(0);
    unlocked = null;
  }

  function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  function persistPeers(peers) {
    const { nonce, ct } = sealInner(unlocked.key, outer.pin.salt, outer.pin.cost, unlocked.identity, peers);
    commit({ pin: { ...outer.pin, nonce, ct } });
    unlocked.peers = peers;
  }

  function requireUnlocked() {
    if (!available) throw new Error(unavailableMessage);
    if (!unlocked) throw new Error('Remote Control is locked. Enter the PIN first.');
  }

  async function doSetPin(pin) {
    if (!available) return { ok: false, error: unavailableMessage };
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return { ok: false, error: 'The PIN must be at least 6 digits.' };
    if (outer.pin && !unlocked) return { ok: false, error: 'Enter the current PIN before changing it.' };
    const epoch = lockEpoch;
    const cost = kdfCost;
    const salt = new Uint8Array(nodeCrypto.randomBytes(SALT_LENGTH));
    let key;
    try {
      key = await deriveKey(pin, salt, cost);
    } catch (err) {
      return { ok: false, error: `Could not derive a key from the PIN: ${err.message}` };
    }
    // The peer list is read after the wait, so a device added meanwhile isn't lost.
    if (epoch !== lockEpoch || Boolean(outer.pin) !== Boolean(unlocked)) {
      key.fill(0);
      return { ok: false, error: 'Remote Control was locked while the PIN was being changed.' };
    }
    const identity = unlocked ? unlocked.identity : newIdentity();
    const peers = unlocked ? unlocked.peers : [];
    const { nonce, ct } = sealInner(key, salt, cost, identity, peers);
    try {
      commit({ pin: { salt, nonce, ct, cost }, attempts: { failed: 0, lastAt: 0 } });
    } catch (err) {
      key.fill(0);
      return { ok: false, error: `Could not save the PIN: ${err.message}` };
    }
    clearUnlocked();
    unlocked = { key, identity, peers };
    return { ok: true };
  }

  function wipe() {
    if (!available) return { ok: false, error: unavailableMessage };
    const erased = { pin: null, controlAllowed: false, attempts: { failed: 0, lastAt: 0 } };
    try {
      commit(erased);
    } catch {
      // Could not rewrite. Deleting the file is the next best way to lose the keys.
      try {
        retryTransient(() => fs.unlinkSync(file));
        outer = { ...outer, ...erased };
      } catch {
        return { ok: false, error: 'Could not erase the keys.' };
      }
    }
    clearUnlocked();
    lockEpoch++;
    return { ok: false, wiped: true };
  }

  // A failed reset must not leave the count high after a correct PIN. Memory
  // takes the reset anyway, so the next successful write (every commit saves
  // all of `outer`) carries it to disk.
  function resetAttempts() {
    const cleared = { failed: 0, lastAt: 0 };
    try {
      commit({ attempts: cleared });
    } catch {
      outer = { ...outer, attempts: cleared };
    }
  }

  async function doUnlock(pin) {
    if (!available) return { ok: false, error: unavailableMessage };
    // Already in: nothing to test, and a typo here must not count toward a wipe.
    if (unlocked) return { ok: true };
    if (!outer.pin) return { ok: false, error: 'No PIN has been set.' };
    if (typeof pin !== 'string') return { ok: false, error: 'Enter the PIN.' };
    const epoch = lockEpoch;

    // Wrong guesses are rate-limited from the stored counter, not a timer.
    const t = now();
    const { failed, lastAt } = outer.attempts;
    const delay = waitAfter(failed);
    if (delay > 0) {
      if (t < lastAt) {
        // The clock went backwards. Restart the wait in full from here.
        try { commit({ attempts: { failed, lastAt: t } }); } catch { /* still refuse */ }
        return { ok: false, waitMs: delay };
      }
      const left = lastAt + delay - t;
      if (left > 0) return { ok: false, waitMs: left };
    }

    // Count the guess before testing it, so killing the app mid-check doesn't
    // hand out a free try. If it can't be recorded, don't test it.
    const wrongSoFar = failed + 1;
    try {
      commit({ attempts: { failed: wrongSoFar, lastAt: t } });
    } catch {
      return { ok: false, error: 'Could not record the attempt, so the PIN was not checked.' };
    }

    const pinRecord = outer.pin;
    let key;
    try {
      key = await deriveKey(pin, pinRecord.salt, pinRecord.cost);
    } catch (err) {
      return { ok: false, error: `Could not derive a key from the PIN: ${err.message}` };
    }
    // lock() or reload() ran while scrypt was working, so whatever this check
    // found is about a state that no longer exists. The guess stays counted.
    if (epoch !== lockEpoch) {
      key.fill(0);
      return { ok: false, error: 'Remote Control was locked or reloaded while the PIN was being checked. Try again.' };
    }
    let contents;
    try {
      contents = openInner(key, pinRecord);
    } catch {
      key.fill(0);
      return { ok: false, error: 'The saved keys are damaged.' };
    }
    if (!contents) {
      key.fill(0);
      if (wrongSoFar >= MAX_WRONG_PINS) return wipe();
      return { ok: false, waitMs: waitAfter(wrongSoFar) };
    }

    clearUnlocked();
    unlocked = { key, identity: contents.identity, peers: contents.peers };
    resetAttempts();
    return { ok: true };
  }

  load();

  return {
    // False when the system's secure storage can't be used yet. Everything is
    // then refused and nothing on disk is touched; call reload() to try again.
    isAvailable() {
      return available;
    },

    // Reads the file again, locking first. Returns isAvailable().
    reload() {
      lockEpoch++;
      clearUnlocked();
      load();
      return available;
    },

    hasPin() {
      return outer.pin !== null;
    },

    // Async because scrypt at this cost would freeze the main process.
    setPin(pin) {
      return serial(() => doSetPin(pin));
    },

    unlock(pin) {
      return serial(() => doUnlock(pin));
    },

    lock() {
      lockEpoch++;
      clearUnlocked();
    },

    isUnlocked() {
      return unlocked !== null;
    },

    getIdentity() {
      return unlocked ? unlocked.identity : null;
    },

    // Empty while locked: the list is inside the PIN-sealed part.
    listPeers() {
      return unlocked ? unlocked.peers.map(clonePeer) : [];
    },

    addPeer(peer) {
      requireUnlocked();
      const entry = normalizePeer(peer);
      const peers = unlocked.peers.filter((existing) => existing.deviceId !== entry.deviceId);
      peers.push(entry);
      persistPeers(peers);
    },

    removePeer(deviceId) {
      requireUnlocked();
      persistPeers(unlocked.peers.filter((peer) => peer.deviceId !== deviceId));
    },

    getControlAllowed() {
      return available && outer.controlAllowed;
    },

    setControlAllowed(allowed) {
      if (typeof allowed !== 'boolean') throw new TypeError('allowed must be a boolean');
      commit({ controlAllowed: allowed });
    }
  };
}

module.exports = { createKeystore, DEFAULT_KDF_COST, waitAfter };
