const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKeystore, DEFAULT_KDF_COST, waitAfter, pinFormatError } = require(path.join(__dirname, '..', 'lib', 'remote', 'keystore.js'));

// Cheap scrypt so the suite stays fast. One test checks the production default.
const FAST = { N: 16, r: 8, p: 1 };
const PIN = '123456';
const WRONG = '654321';

const identityFns = { protect: (bytes) => bytes, unprotect: (bytes) => bytes };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-keystore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(t, extra = {}) {
  const dir = tempDir(t);
  const file = path.join(dir, 'remote.keys');
  const clock = { t: 1_000_000 };
  const make = (overrides = {}) => createKeystore({
    file, ...identityFns, now: () => clock.t, kdfCost: FAST, ...extra, ...overrides
  });
  return { dir, file, clock, make };
}

function peer(n, overrides = {}) {
  return {
    deviceId: `device${n}`.padEnd(16, 'x'),
    publicKey: new Uint8Array(32).fill(n),
    name: `Laptop ${n}`,
    role: 'laptop',
    ...overrides
  };
}

const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

async function failTimes(ks, clock, count) {
  let last;
  for (let i = 0; i < count; i++) {
    last = await ks.unlock(WRONG);
    clock.t += 10 * 60 * 1000; // let any wait expire
  }
  return last;
}

test('production defaults are scrypt N=2^17, r=8, p=1', async (t) => {
  assert.deepStrictEqual({ ...DEFAULT_KDF_COST }, { N: 131072, r: 8, p: 1 });
  const dir = tempDir(t);
  const file = path.join(dir, 'remote.keys');
  const ks = createKeystore({ file, ...identityFns });
  assert.deepStrictEqual(await ks.setPin(PIN), { ok: true });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).pin;
  assert.deepStrictEqual({ N: stored.N, r: stored.r, p: stored.p }, { N: 131072, r: 8, p: 1 });
  assert.strictEqual(Buffer.from(stored.salt, 'base64').length, 16);
  ks.lock();
  assert.deepStrictEqual(await createKeystore({ file, ...identityFns }).unlock(PIN), { ok: true, tested: true });
});

test('delays: none for 3 wrong, then 1 s doubling, capped at 5 minutes', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(waitAfter), [0, 0, 0, 1000, 2000, 4000, 8000, 16000, 32000]);
  assert.strictEqual(waitAfter(30), 300000);
});

test('setPin refuses short PINs and anything but digits, and returns a promise', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  const pending = ks.setPin('123456');
  assert.ok(pending instanceof Promise);
  await pending;
  for (const bad of ['12345', '', 'abcdef', '12345a', '123 456', '１２３４５６', 123456, null, undefined]) {
    const fresh = fixture(t).make();
    const result = await fresh.setPin(bad);
    assert.strictEqual(result.ok, false, `refused ${String(bad)}`);
    assert.ok(result.error);
    assert.strictEqual(fresh.hasPin(), false);
  }
  const longer = fixture(t).make();
  assert.deepStrictEqual(await longer.setPin('1234567890'), { ok: true });
});

test('a new install has no PIN, no identity, nothing unlocked, control off', (t) => {
  const ks = fixture(t).make();
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(ks.isUnlocked(), false);
  assert.strictEqual(ks.getIdentity(), null);
  assert.deepStrictEqual(ks.listPeers(), []);
  assert.strictEqual(ks.getControlAllowed(), false);
});

test('the identity is created by the first setPin and is unlocked after it', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  assert.deepStrictEqual(await ks.setPin(PIN), { ok: true });
  assert.strictEqual(ks.hasPin(), true);
  assert.strictEqual(ks.isUnlocked(), true);
  const id = ks.getIdentity();
  assert.strictEqual(id.publicKey.length, 32);
  assert.strictEqual(id.secretKey.length, 32);
});

test('the file holds no identity or peer bytes, and without the PIN yields nothing', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const id = ks.getIdentity();
  const friend = peer(7);
  ks.addPeer(friend);
  const onDisk = fs.readFileSync(file);
  for (const secret of [id.secretKey, id.publicKey, friend.publicKey]) {
    assert.ok(!contains(onDisk, secret), 'raw bytes absent');
    assert.ok(!contains(onDisk, Buffer.from(secret).toString('base64')), 'base64 absent');
    assert.ok(!contains(onDisk, Buffer.from(secret).toString('hex')), 'hex absent');
  }
  assert.ok(!contains(onDisk, friend.name));
  assert.ok(!contains(onDisk, friend.deviceId));

  const reopened = make();
  assert.strictEqual(reopened.hasPin(), true);
  assert.strictEqual(reopened.isUnlocked(), false);
  assert.strictEqual(reopened.getIdentity(), null);
  assert.deepStrictEqual(reopened.listPeers(), []);
});

test('the file goes through protect on write and unprotect on read', async (t) => {
  const { file, make } = fixture(t);
  const MARK = Buffer.from('PROTECTED:');
  const protect = (bytes) => Buffer.concat([MARK, Buffer.from(bytes).reverse()]);
  const unprotect = (bytes) => {
    assert.ok(Buffer.from(bytes).subarray(0, MARK.length).equals(MARK), 'unprotect is given protected bytes');
    return Buffer.from(bytes).subarray(MARK.length).reverse();
  };
  const ks = make({ protect, unprotect });
  await ks.setPin(PIN);
  ks.setControlAllowed(true);
  assert.ok(fs.readFileSync(file).subarray(0, MARK.length).equals(MARK));
  const reopened = make({ protect, unprotect });
  assert.strictEqual(reopened.getControlAllowed(), true);
  assert.deepStrictEqual(await reopened.unlock(PIN), { ok: true, tested: true });
  assert.deepStrictEqual(reopened.getIdentity().publicKey, ks.getIdentity().publicKey);
});

test('the right PIN unlocks after a restart with the same identity and peers', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const original = ks.getIdentity();
  ks.addPeer(peer(1, { role: 'home' }));
  ks.addPeer(peer(2, { provisional: true }));
  ks.lock();
  assert.strictEqual(ks.isUnlocked(), false);
  assert.strictEqual(ks.getIdentity(), null);
  assert.deepStrictEqual(ks.listPeers(), []);

  const reopened = make();
  assert.deepStrictEqual(await reopened.unlock(PIN), { ok: true, tested: true });
  assert.deepStrictEqual(reopened.getIdentity().secretKey, original.secretKey);
  assert.deepStrictEqual(reopened.getIdentity().publicKey, original.publicKey);
  assert.deepStrictEqual(reopened.listPeers(), [peer(1, { role: 'home' }), peer(2, { provisional: true })]);
});

test('a wrong PIN does not unlock, and waits grow, including across a restart', async (t) => {
  const { clock, make } = fixture(t);
  let ks = make();
  await ks.setPin(PIN);
  ks.lock();

  // Three free wrong guesses.
  for (let i = 0; i < 3; i++) {
    const result = await ks.unlock(WRONG);
    assert.deepStrictEqual(result, { ok: false, waitMs: 0, tested: true });
  }
  assert.strictEqual(ks.isUnlocked(), false);

  // Then 1 s, 2 s, 4 s, 8 s. Restart between each to show it is persisted.
  for (const expected of [1000, 2000, 4000, 8000]) {
    ks = make();
    const result = await ks.unlock(WRONG);
    assert.deepStrictEqual(result, { ok: false, waitMs: expected, tested: true });

    // During the wait, even the right PIN is refused without being tried.
    clock.t += expected - 1;
    ks = make();
    const early = await ks.unlock(PIN);
    assert.deepStrictEqual(early, { ok: false, waitMs: 1 });
    assert.strictEqual(ks.isUnlocked(), false);
    clock.t += 1;
  }
});

test('a call during the wait does not count as an attempt', async (t) => {
  const { clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  for (let i = 0; i < 4; i++) await ks.unlock(WRONG); // fourth sets a 1 s wait
  for (let i = 0; i < 20; i++) {
    const r = await ks.unlock(WRONG);
    assert.strictEqual(r.ok, false);
    assert.ok(r.waitMs > 0);
  }
  clock.t += 1000;
  assert.deepStrictEqual(await ks.unlock(WRONG), { ok: false, waitMs: 2000, tested: true }); // fifth wrong, not twenty-fifth
});

test('waits cap at five minutes', async (t) => {
  const { file, clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  // Edit the file (protect is the identity here) to a long streak, which a real run never reaches.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.attempts = { failed: 40, lastAt: clock.t };
  fs.writeFileSync(file, JSON.stringify(doc));
  const reopened = make();
  assert.deepStrictEqual(await reopened.unlock(PIN), { ok: false, waitMs: 300000 });
});

test('a clock moved backwards restarts the wait in full', async (t) => {
  const { clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  for (let i = 0; i < 6; i++) {
    await ks.unlock(WRONG);
    if (i < 5) clock.t += 10 * 60 * 1000;
  }
  // The sixth wrong guess was just made; the wait after it is 4 s.
  clock.t -= 3_600_000; // an hour back
  assert.deepStrictEqual(await make().unlock(PIN), { ok: false, waitMs: 4000 });
  // The wait now runs from the new time, so it ends 4 s later and not an hour later.
  clock.t += 3999;
  assert.deepStrictEqual(await make().unlock(PIN), { ok: false, waitMs: 1 });
  clock.t += 1;
  assert.deepStrictEqual(await make().unlock(PIN), { ok: true, tested: true });
});

test('a correct PIN resets the counter', async (t) => {
  const { clock, make } = fixture(t);
  let ks = make();
  await ks.setPin(PIN);
  ks.lock();
  await failTimes(ks, clock, 5);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
  ks.lock();
  // Back to three free guesses, also after a restart.
  ks = make();
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(await ks.unlock(WRONG), { ok: false, waitMs: 0, tested: true });
});

test('ten wrong in a row wipes the keys, even if the right PIN follows', async (t) => {
  const { file, clock, make } = fixture(t);
  let ks = make();
  await ks.setPin(PIN);
  const before = ks.getIdentity().publicKey;
  ks.addPeer(peer(3));
  ks.setControlAllowed(true);
  ks.lock();

  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await ks.unlock(WRONG));
    clock.t += 10 * 60 * 1000;
  }
  assert.deepStrictEqual(results[9], { ok: false, wiped: true, tested: true });
  assert.ok(results.slice(0, 9).every((r) => !r.wiped));

  for (const view of [ks, make()]) {
    assert.strictEqual(view.hasPin(), false);
    assert.strictEqual(view.getIdentity(), null);
    assert.strictEqual(view.isUnlocked(), false);
    assert.strictEqual(view.getControlAllowed(), false);
    assert.deepStrictEqual(view.listPeers(), []);
    assert.deepStrictEqual(await view.unlock(PIN), { ok: false, error: 'No PIN has been set.' });
    assert.deepStrictEqual(view.listPeers(), []);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(doc.pin, null);
  assert.ok(!contains(fs.readFileSync(file), before));

  // A fresh start is possible and makes a different identity.
  ks = make();
  assert.deepStrictEqual(await ks.setPin(PIN), { ok: true });
  assert.notDeepStrictEqual(ks.getIdentity().publicKey, before);
  assert.deepStrictEqual(ks.listPeers(), []);
});

test('the tenth guess is only a wipe if it is wrong', async (t) => {
  const { clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  await failTimes(ks, clock, 9);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
});

test('a wrong PIN is never treated as a damaged file', async (t) => {
  const { dir, file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  const before = fs.readFileSync(file, 'utf8');
  await ks.unlock(WRONG);
  const reopened = make();
  assert.strictEqual(reopened.hasPin(), true);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after.pin, JSON.parse(before).pin);
});

test('the control switch is stored outside the PIN, so a locked store honours it', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  assert.strictEqual(ks.getControlAllowed(), false);
  await ks.setPin(PIN);
  ks.setControlAllowed(true);
  ks.lock();
  assert.strictEqual(ks.getControlAllowed(), true);
  ks.setControlAllowed(false); // reachable while locked, from the local UI
  assert.strictEqual(make().getControlAllowed(), false);
  ks.setControlAllowed(true);
  const restarted = make();
  assert.strictEqual(restarted.isUnlocked(), false);
  assert.strictEqual(restarted.getControlAllowed(), true);
  assert.throws(() => ks.setControlAllowed('yes'), TypeError);
  assert.strictEqual(restarted.getControlAllowed(), true);
});

test('control can be set before any PIN exists and survives a restart', (t) => {
  const { make } = fixture(t);
  const ks = make();
  ks.setControlAllowed(true);
  assert.strictEqual(make().getControlAllowed(), true);
});

test('a corrupt file gives an unpaired start and a kept copy instead of throwing', async (t) => {
  const bad = {
    garbage: Buffer.from('this is not a keystore'),
    empty: Buffer.alloc(0),
    wrongShape: Buffer.from(JSON.stringify({ v: 1, hello: 'world' })),
    newerVersion: Buffer.from(JSON.stringify({ v: 2, controlAllowed: true, attempts: { failed: 0, lastAt: 0 }, pin: null })),
    hugeCost: Buffer.from(JSON.stringify({
      v: 1, controlAllowed: false, attempts: { failed: 0, lastAt: 0 },
      pin: { salt: 'AAAAAAAAAAAAAAAAAAAAAA==', nonce: 'A'.repeat(32), ct: 'AAAA', N: 2 ** 30, r: 8, p: 1 }
    }))
  };
  for (const [name, contents] of Object.entries(bad)) {
    const { dir, file, clock, make } = fixture(t);
    fs.writeFileSync(file, contents);
    let ks;
    assert.doesNotThrow(() => { ks = make(); }, name);
    assert.strictEqual(ks.hasPin(), false, name);
    assert.strictEqual(ks.getIdentity(), null, name);
    assert.strictEqual(ks.getControlAllowed(), false, name);
    assert.deepStrictEqual(ks.listPeers(), [], name);
    const kept = fs.readdirSync(dir).filter((f) => f.startsWith('remote.keys.unreadable.'));
    assert.deepStrictEqual(kept, [`remote.keys.unreadable.${clock.t}`], name);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, kept[0])), contents, name);
    assert.ok(!fs.existsSync(file), name);
    // And it can start over.
    assert.deepStrictEqual(await ks.setPin(PIN), { ok: true }, name);
  }
});

test('a file that unprotect cannot open is set aside too', (t) => {
  const { dir, file, make } = fixture(t);
  fs.writeFileSync(file, 'sealed by another account');
  const ks = make({ unprotect: () => { throw new Error('cannot decrypt'); } });
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.unreadable.')).length, 1);
});

test('a missing file is a clean start with nothing set aside', (t) => {
  const { dir, make } = fixture(t);
  make();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('setPin changes the PIN when unlocked, keeping the identity and peers', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const id = ks.getIdentity();
  ks.addPeer(peer(5));
  assert.deepStrictEqual(await ks.setPin('987654'), { ok: true });
  assert.strictEqual(ks.isUnlocked(), true);
  ks.lock();

  const reopened = make();
  const old = await reopened.unlock(PIN);
  assert.strictEqual(old.ok, false);
  assert.deepStrictEqual(await reopened.unlock('987654'), { ok: true, tested: true });
  assert.deepStrictEqual(reopened.getIdentity().secretKey, id.secretKey);
  assert.deepStrictEqual(reopened.listPeers(), [peer(5)]);
});

test('setPin when locked is refused and changes nothing', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  const before = fs.readFileSync(file);
  const result = await ks.setPin('987654');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
});

test('a device added while the PIN is being changed is not lost', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const changing = ks.setPin('987654');
  ks.addPeer(peer(9)); // runs while scrypt is working
  assert.deepStrictEqual(await changing, { ok: true });
  ks.lock();
  const reopened = make();
  await reopened.unlock('987654');
  assert.deepStrictEqual(reopened.listPeers(), [peer(9)]);
});

test('locking while the PIN is being changed abandons the change', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const changing = ks.setPin('987654');
  ks.lock();
  const result = await changing;
  assert.strictEqual(result.ok, false);
  assert.strictEqual(ks.isUnlocked(), false);
  assert.deepStrictEqual(await make().unlock(PIN), { ok: true, tested: true });
});

test('peers: add, replace by deviceId, remove, and they persist', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  ks.addPeer(peer(2));
  ks.addPeer(peer(1, { name: 'Renamed', role: 'home', provisional: true }));
  assert.deepStrictEqual(ks.listPeers(), [peer(2), peer(1, { name: 'Renamed', role: 'home', provisional: true })]);
  ks.removePeer(peer(2).deviceId);
  ks.removePeer('nobody');
  assert.deepStrictEqual(ks.listPeers().map((p) => p.name), ['Renamed']);

  const reopened = make();
  await reopened.unlock(PIN);
  assert.deepStrictEqual(reopened.listPeers(), [peer(1, { name: 'Renamed', role: 'home', provisional: true })]);
  assert.ok(reopened.listPeers()[0].publicKey instanceof Uint8Array);
});

test('listPeers returns copies, so callers cannot edit the stored list', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  const listed = ks.listPeers();
  listed[0].name = 'tampered';
  listed[0].publicKey[0] = 255;
  listed.pop();
  assert.deepStrictEqual(ks.listPeers(), [peer(1)]);
});

test('peer changes while locked throw a clear error and change nothing', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  ks.lock();
  const before = fs.readFileSync(file);
  assert.throws(() => ks.addPeer(peer(2)), /locked/i);
  assert.throws(() => ks.removePeer(peer(1).deviceId), /locked/i);
  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.throws(() => make().addPeer(peer(2)), /locked/i);
});

test('addPeer rejects malformed peers', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  assert.throws(() => ks.addPeer(null), TypeError);
  assert.throws(() => ks.addPeer(peer(1, { deviceId: '' })), TypeError);
  assert.throws(() => ks.addPeer(peer(1, { publicKey: new Uint8Array(31) })), TypeError);
  assert.throws(() => ks.addPeer(peer(1, { publicKey: 'abc' })), TypeError);
  assert.throws(() => ks.addPeer(peer(1, { name: 5 })), TypeError);
  assert.throws(() => ks.addPeer(peer(1, { role: 'admin' })), TypeError);
  assert.deepStrictEqual(ks.listPeers(), []);
});

test('parallel unlock calls are checked one at a time, so they cannot skip a wait', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  const results = await Promise.all(Array.from({ length: 8 }, () => ks.unlock(WRONG)));
  // Three free, the fourth sets a wait, the other four hit it.
  assert.deepStrictEqual(results.map((r) => r.waitMs), [0, 0, 0, 1000, 1000, 1000, 1000, 1000]);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 4);
});

// --- atomic writes -----------------------------------------------------------

function patched(object, name, replacement, run) {
  const original = object[name];
  object[name] = replacement(original);
  let result;
  try {
    result = run();
  } catch (err) {
    object[name] = original;
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(() => { object[name] = original; });
  }
  object[name] = original;
  return result;
}

test('a failed rename leaves the old file intact, no temp files, and memory unchanged', async (t) => {
  const { dir, file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  const before = fs.readFileSync(file);

  patched(fs, 'renameSync', () => () => { throw new Error('disk gone'); }, () => {
    assert.throws(() => ks.addPeer(peer(2)), /disk gone/);
    assert.throws(() => ks.setControlAllowed(true), /disk gone/);
  });

  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
  assert.deepStrictEqual(ks.listPeers(), [peer(1)]);
  assert.strictEqual(ks.getControlAllowed(), false);
});

test('a crash partway through writing leaves the old file intact', async (t) => {
  const { dir, file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  const before = fs.readFileSync(file);

  patched(fs, 'writeSync', (real) => (fd, buf, off, len) => {
    real(fd, buf, off, Math.min(len, 10)); // a few bytes land, then the machine dies
    throw new Error('power cut');
  }, () => {
    assert.throws(() => ks.addPeer(peer(2)), /power cut/);
  });

  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
  const reopened = make();
  assert.strictEqual(reopened.hasPin(), true);
});

test('a write goes to a temp file in the same folder, then is renamed over the target', async (t) => {
  const { dir, file, make } = fixture(t);
  const ks = make();
  const seen = [];
  await patched(fs, 'renameSync', (real) => (from, to) => {
    seen.push([path.dirname(from), from === to ? 'same' : 'temp', to]);
    return real(from, to);
  }, () => ks.setPin(PIN));
  assert.ok(seen.length >= 1);
  for (const [fromDir, kind, to] of seen) {
    assert.strictEqual(fromDir, dir);
    assert.strictEqual(kind, 'temp');
    assert.strictEqual(to, file);
  }
});

test('if the attempt cannot be recorded, the PIN is not tested', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  const result = await patched(fs, 'renameSync', () => () => { throw new Error('disk full'); }, () => ks.unlock(PIN));
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
  assert.strictEqual(ks.isUnlocked(), false);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
});

test('the guess is counted before it is tested, so a kill mid-check still costs a try', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  // Read the file the moment the first write lands, which is before scrypt has run.
  const snapshots = [];
  await patched(fs, 'renameSync', (real) => (from, to) => {
    real(from, to);
    snapshots.push(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed);
  }, () => ks.unlock(WRONG));
  assert.strictEqual(snapshots[0], 1);
});

test('makes the folder if it does not exist yet', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'deeper', 'remote.keys');
  const ks = createKeystore({ file, ...identityFns, kdfCost: FAST });
  assert.deepStrictEqual(await ks.setPin(PIN), { ok: true });
  assert.ok(fs.existsSync(file));
});


// --- transient Windows file locks -------------------------------------------

function lockError(code) {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code });
}

// Throws `code` for the first `failures` calls, then behaves normally.
function flaky(failures, code, counter) {
  return (real) => (...args) => {
    counter.calls++;
    if (counter.calls <= failures) throw lockError(code);
    return real(...args);
  };
}

test('a rename that fails briefly with EPERM, EBUSY or EACCES is retried', async (t) => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const { dir, file, make } = fixture(t);
    const ks = make();
    await ks.setPin(PIN);
    const counter = { calls: 0 };
    patched(fs, 'renameSync', flaky(4, code, counter), () => ks.addPeer(peer(1)));
    assert.strictEqual(counter.calls, 5, `${code}: four failures then success`);
    assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
    ks.lock();
    const reopened = make();
    await reopened.unlock(PIN);
    assert.deepStrictEqual(reopened.listPeers(), [peer(1)], code);
    assert.ok(fs.existsSync(file));
  }
});

test('a brief lock while recording an attempt does not stop the right PIN', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  const counter = { calls: 0 };
  const result = await patched(fs, 'renameSync', flaky(2, 'EPERM', counter), () => ks.unlock(PIN));
  assert.deepStrictEqual(result, { ok: true, tested: true });
});

test('setPin survives a brief lock too', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  const counter = { calls: 0 };
  const result = await patched(fs, 'renameSync', flaky(3, 'EBUSY', counter), () => ks.setPin(PIN));
  assert.deepStrictEqual(result, { ok: true });
});

test('a rename that never succeeds fails cleanly: old file, memory and folder untouched', async (t) => {
  const { dir, file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.addPeer(peer(1));
  const before = fs.readFileSync(file);
  const counter = { calls: 0 };
  patched(fs, 'renameSync', flaky(Infinity, 'EPERM', counter), () => {
    assert.throws(() => ks.addPeer(peer(2)), /EPERM/);
  });
  assert.strictEqual(counter.calls, 5, 'one try plus four retries');
  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
  assert.deepStrictEqual(ks.listPeers(), [peer(1)]);
});

test('other rename errors are not retried', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const counter = { calls: 0 };
  patched(fs, 'renameSync', flaky(Infinity, 'ENOSPC', counter), () => {
    assert.throws(() => ks.setControlAllowed(true), /ENOSPC/);
  });
  assert.strictEqual(counter.calls, 1);
});

test('the wipe retries its fallback delete when the rewrite is blocked', async (t) => {
  const { file, clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  await failTimes(ks, clock, 9);
  const renames = { calls: 0 };
  const unlinks = { calls: 0 };
  // The first rename records the attempt; every later one (the wipe's rewrite) is blocked.
  const blockAfterFirst = (real) => (...args) => {
    renames.calls++;
    if (renames.calls > 1) throw lockError('EPERM');
    return real(...args);
  };
  const result = await patched(fs, 'renameSync', blockAfterFirst, () =>
    patched(fs, 'unlinkSync', (real) => (target, ...rest) => {
      // Temp-file clean-up also uses unlinkSync; only the keystore itself is locked.
      if (target !== file) return real(target, ...rest);
      unlinks.calls++;
      if (unlinks.calls <= 2) throw lockError('EBUSY');
      return real(target, ...rest);
    }, () => ks.unlock(WRONG)));
  // The rewrite could not land, but the delete got through on the third try.
  assert.deepStrictEqual(result, { ok: false, wiped: true, tested: true });
  assert.strictEqual(unlinks.calls, 3);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(make().hasPin(), false);
});

// --- secure storage not available yet ---------------------------------------

test('while protection is unavailable the file is left alone and everything is refused', async (t) => {
  const { dir, file, make } = fixture(t);
  const first = make();
  await first.setPin(PIN);
  first.addPeer(peer(1));
  first.setControlAllowed(true);
  const before = fs.readFileSync(file);

  const ks = make({
    isProtectionAvailable: () => false,
    unprotect: () => { throw new Error('keychain locked'); }
  });
  assert.strictEqual(ks.isAvailable(), false);
  assert.strictEqual(ks.getControlAllowed(), false);
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(ks.isUnlocked(), false);
  assert.strictEqual(ks.getIdentity(), null);
  assert.deepStrictEqual(ks.listPeers(), []);
  assert.throws(() => ks.setControlAllowed(false), /secure storage/i);
  assert.throws(() => ks.addPeer(peer(2)), /secure storage/i);
  assert.throws(() => ks.removePeer(peer(1).deviceId), /secure storage/i);
  for (const result of [await ks.setPin('987654'), await ks.unlock(PIN)]) {
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /secure storage/i);
  }
  assert.deepStrictEqual(fs.readFileSync(file), before, 'byte-identical');
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys'], 'nothing set aside');
});

test('reload brings the pairing back once protection is available', async (t) => {
  const { dir, file, make } = fixture(t);
  const first = make();
  await first.setPin(PIN);
  first.addPeer(peer(1));
  first.setControlAllowed(true);
  const identity = first.getIdentity();
  const before = fs.readFileSync(file);

  let ready = false;
  const ks = make({
    isProtectionAvailable: () => ready,
    unprotect: (bytes) => {
      if (!ready) throw new Error('keychain locked');
      return bytes;
    }
  });
  assert.strictEqual(ks.isAvailable(), false);
  assert.strictEqual(ks.reload(), false);
  assert.deepStrictEqual(fs.readFileSync(file), before);

  ready = true;
  assert.strictEqual(ks.reload(), true);
  assert.strictEqual(ks.isAvailable(), true);
  assert.strictEqual(ks.hasPin(), true);
  assert.strictEqual(ks.getControlAllowed(), true);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
  assert.deepStrictEqual(ks.getIdentity().publicKey, identity.publicKey);
  assert.deepStrictEqual(ks.listPeers(), [peer(1)]);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
});

test('reload locks the store and re-reads the file', async (t) => {
  const { make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  assert.strictEqual(ks.reload(), true);
  assert.strictEqual(ks.isUnlocked(), false);
  assert.strictEqual(ks.hasPin(), true);
});

test('a failure while protection IS available still counts as corruption', (t) => {
  const { dir, file, make } = fixture(t);
  fs.writeFileSync(file, 'not sealed by anything we know');
  const ks = make({
    isProtectionAvailable: () => true,
    unprotect: () => { throw new Error('bad data'); }
  });
  assert.strictEqual(ks.isAvailable(), true);
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.unreadable.')).length, 1);
  assert.ok(!fs.existsSync(file));
});

test('a throwing availability check counts as unavailable', (t) => {
  const { dir, file, make } = fixture(t);
  fs.writeFileSync(file, 'whatever');
  const ks = make({ isProtectionAvailable: () => { throw new Error('boom'); } });
  assert.strictEqual(ks.isAvailable(), false);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'whatever');
});

// --- unlock racing lock(), reload() and protection going down ---------------

const nodeCrypto = require('node:crypto');

// Holds scrypt's result back until release() is called, so a test can run
// lock() or reload() while an unlock is in flight.
function gatedScrypt() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const install = () => {
    const real = nodeCrypto.scrypt;
    nodeCrypto.scrypt = (...args) => {
      const done = args.pop();
      real(...args, (err, key) => { reached(); gate.then(() => done(err, key)); });
    };
    return () => { nodeCrypto.scrypt = real; };
  };
  return { install, arrived, release: () => release() };
}

async function inFlight(ks, pin, interfere) {
  const gated = gatedScrypt();
  const restore = gated.install();
  try {
    const pending = ks.unlock(pin);
    await gated.arrived;
    interfere();
    gated.release();
    return await pending;
  } finally {
    restore();
  }
}

test('lock() or reload() during an in-flight correct PIN keeps the store locked', async (t) => {
  for (const interfere of ['lock', 'reload']) {
    const { file, make } = fixture(t);
    const ks = make();
    await ks.setPin(PIN);
    ks.lock();
    const result = await inFlight(ks, PIN, () => ks[interfere]());
    assert.strictEqual(result.ok, false, interfere);
    assert.ok(result.error, interfere);
    assert.strictEqual(ks.isUnlocked(), false, interfere);
    assert.strictEqual(ks.getIdentity(), null, interfere);
    // The guess was counted and is not refunded.
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 1, interfere);
    assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true }, interfere);
  }
});

test('lock() or reload() during an in-flight tenth wrong PIN does not wipe', async (t) => {
  for (const interfere of ['lock', 'reload']) {
    const { file, clock, make } = fixture(t);
    const ks = make();
    await ks.setPin(PIN);
    ks.lock();
    await failTimes(ks, clock, 9);
    const result = await inFlight(ks, WRONG, () => ks[interfere]());
    assert.strictEqual(result.wiped, undefined, interfere);
    assert.strictEqual(result.ok, false, interfere);
    assert.strictEqual(ks.hasPin(), true, interfere);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notStrictEqual(doc.pin, null, interfere);
    assert.strictEqual(doc.attempts.failed, 10, 'counted, not refunded');
    // One more wrong guess (after the wait) does wipe.
    clock.t += 10 * 60 * 1000;
    assert.deepStrictEqual(await ks.unlock(WRONG), { ok: false, wiped: true, tested: true }, interfere);
  }
});

test('a tenth wrong PIN finishing after protection went down deletes nothing', async (t) => {
  const { file, clock, make } = fixture(t);
  let ready = true;
  const ks = make({ isProtectionAvailable: () => ready });
  await ks.setPin(PIN);
  ks.lock();
  await failTimes(ks, clock, 9);
  const pinBefore = JSON.parse(fs.readFileSync(file, 'utf8')).pin;
  const result = await inFlight(ks, WRONG, () => { ready = false; ks.reload(); });
  assert.strictEqual(ks.isAvailable(), false);
  assert.strictEqual(result.wiped, undefined);
  assert.strictEqual(result.ok, false);
  // Only the attempt record changed; the keys are still there.
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pin, pinBefore);
  ready = true;
  assert.strictEqual(ks.reload(), true);
  assert.strictEqual(ks.hasPin(), true);
});

test('unlock while already unlocked returns ok without testing or counting', async (t) => {
  const { file, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  const before = fs.readFileSync(file);
  for (let i = 0; i < 12; i++) assert.deepStrictEqual(await ks.unlock(WRONG), { ok: true });
  assert.deepStrictEqual(await ks.unlock(undefined), { ok: true });
  assert.strictEqual(ks.isUnlocked(), true);
  assert.strictEqual(ks.hasPin(), true);
  assert.deepStrictEqual(fs.readFileSync(file), before);
  ks.addPeer(peer(1));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 0);
});

// --- transient read errors at load ------------------------------------------

function readOnlyFor(target, behave) {
  return (real) => (given, ...rest) => (given === target ? behave(real, given, ...rest) : real(given, ...rest));
}

test('a read that fails briefly with EBUSY is retried at load', async (t) => {
  const { dir, file, make } = fixture(t);
  const first = make();
  await first.setPin(PIN);
  let calls = 0;
  const ks = patched(fs, 'readFileSync', readOnlyFor(file, (real, ...args) => {
    if (++calls <= 2) throw lockError('EBUSY');
    return real(...args);
  }), () => make());
  assert.strictEqual(calls, 3);
  assert.strictEqual(ks.isAvailable(), true);
  assert.strictEqual(ks.hasPin(), true);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);
});

test('a read that keeps failing with EPERM leaves the file alone until reload() recovers', async (t) => {
  const { dir, file, make } = fixture(t);
  const first = make();
  await first.setPin(PIN);
  first.addPeer(peer(1));
  first.setControlAllowed(true);
  const before = fs.readFileSync(file);

  let blocked = true;
  const guard = readOnlyFor(file, (real, ...args) => {
    if (blocked) throw lockError('EPERM');
    return real(...args);
  });
  const ks = patched(fs, 'readFileSync', guard, () => make());
  assert.strictEqual(ks.isAvailable(), false);
  assert.strictEqual(ks.hasPin(), false);
  assert.strictEqual(ks.getControlAllowed(), false);
  assert.throws(() => ks.setControlAllowed(false), /in use by another program/i);
  const refused = await ks.unlock(PIN);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /in use by another program/i);
  assert.deepStrictEqual(fs.readFileSync(file), before);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys'], 'nothing set aside');

  // Still blocked on reload(): still unavailable, still untouched.
  assert.strictEqual(patched(fs, 'readFileSync', guard, () => ks.reload()), false);
  assert.deepStrictEqual(fs.readdirSync(dir), ['remote.keys']);

  blocked = false;
  assert.strictEqual(ks.reload(), true);
  assert.strictEqual(ks.hasPin(), true);
  assert.strictEqual(ks.getControlAllowed(), true);
  assert.deepStrictEqual(await ks.unlock(PIN), { ok: true, tested: true });
  assert.deepStrictEqual(ks.listPeers(), [peer(1)]);
});

test('an unreadable path that is not a transient lock is still set aside', (t) => {
  const { dir, file, make } = fixture(t);
  fs.writeFileSync(file, 'x');
  const ks = patched(fs, 'readFileSync', readOnlyFor(file, () => { throw lockError('EIO'); }), () => make());
  assert.strictEqual(ks.isAvailable(), true);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.unreadable.')).length, 1);
});

// --- the counter reset after a correct PIN ----------------------------------

test('if the reset write fails after a correct PIN, the next successful write carries it', async (t) => {
  const { file, clock, make } = fixture(t);
  const ks = make();
  await ks.setPin(PIN);
  ks.lock();
  await failTimes(ks, clock, 5);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 5);

  // The first write (recording the attempt) lands; the second (the reset) fails.
  let renames = 0;
  const result = await patched(fs, 'renameSync', (real) => (...args) => {
    if (++renames === 2) throw lockError('ENOSPC');
    return real(...args);
  }, () => ks.unlock(PIN));
  assert.deepStrictEqual(result, { ok: true, tested: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 6, 'disk still high');

  ks.setControlAllowed(true); // any successful write
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 0);

  // In memory it was already clear, so three free guesses follow.
  ks.lock();
  for (let i = 0; i < 3; i++) assert.deepStrictEqual(await ks.unlock(WRONG), { ok: false, waitMs: 0, tested: true });
});

test('setAsideAsDamaged moves the file away, keeps a copy, and leaves an empty unpaired store', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.deepEqual(await store.setPin(PIN), { ok: true });
  store.setControlAllowed(true);
  store.lock();

  assert.equal(store.setAsideAsDamaged(), true);
  assert.equal(store.hasPin(), false);
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.getControlAllowed(), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith('keys.json.unreadable.')).length, 1);

  // A new store on the same path agrees, and it can start over.
  const again = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.equal(again.hasPin(), false);
  assert.deepEqual(await again.setPin(PIN), { ok: true });
});

test('setAsideAsDamaged also locks a store that was open', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  await store.setPin(PIN);
  assert.equal(store.isUnlocked(), true);
  assert.equal(store.setAsideAsDamaged(), true);
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.getIdentity(), null);
});

test('setAsideAsDamaged touches nothing while secure storage is unavailable', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'keys.json');
  const first = createKeystore({ file, kdfCost: FAST, ...identityFns });
  await first.setPin(PIN);

  const store = createKeystore({ file, kdfCost: FAST, ...identityFns, isProtectionAvailable: () => false });
  assert.equal(store.setAsideAsDamaged(), false);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(dir), ['keys.json']);
});

test('pinFormatError is the rule setPin uses', async (t) => {
  for (const good of ['123456', '0000000000', '1'.repeat(40)]) assert.equal(pinFormatError(good), null);
  const store = createKeystore({ file: path.join(tempDir(t), 'keys.json'), kdfCost: FAST, ...identityFns });
  for (const bad of ['12345', 'abcdef', '12345a', '', 123456, null, undefined]) {
    assert.ok(pinFormatError(bad));
    assert.deepEqual(await store.setPin(bad), { ok: false, error: pinFormatError(bad) });
  }
});

test('pinKind records what setPin was told, reads while locked and after a restart, and a person is the default', async (t) => {
  const file = path.join(tempDir(t), 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.equal(store.pinKind(), null);

  assert.deepEqual(await store.setPin('1'.repeat(40), { kind: 'device' }), { ok: true });
  assert.equal(store.pinKind(), 'device');
  store.lock();
  assert.equal(store.pinKind(), 'device');
  assert.equal(createKeystore({ file, kdfCost: FAST, ...identityFns }).pinKind(), 'device');

  await store.unlock('1'.repeat(40));
  assert.deepEqual(await store.setPin(PIN), { ok: true });
  assert.equal(store.pinKind(), 'user');
  store.lock();
  assert.equal(createKeystore({ file, kdfCost: FAST, ...identityFns }).pinKind(), 'user');
});

test('a refused setPin does not change the kind, and a file with no kind means a person', async (t) => {
  const file = path.join(tempDir(t), 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  await store.setPin('1'.repeat(40), { kind: 'device' });
  assert.equal((await store.setPin('12', { kind: 'user' })).ok, false);
  assert.equal(store.pinKind(), 'device');

  const outer = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete outer.pinKind;
  fs.writeFileSync(file, JSON.stringify(outer));
  assert.equal(createKeystore({ file, kdfCost: FAST, ...identityFns }).pinKind(), 'user');
});

test('the kind is only a hint: it opens nothing, and the PIN is what unlocks', async (t) => {
  const file = path.join(tempDir(t), 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  await store.setPin(PIN);
  store.lock();
  const outer = JSON.parse(fs.readFileSync(file, 'utf8'));
  outer.pinKind = 'device';
  fs.writeFileSync(file, JSON.stringify(outer));

  const changed = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.equal((await changed.unlock(WRONG)).ok, false);
  assert.equal(changed.isUnlocked(), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed, 1);
  assert.equal((await changed.unlock(PIN)).ok, true);
});

test('wiping and setting aside clear the kind', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, ...identityFns });
  await store.setPin(PIN);
  store.setAsideAsDamaged();
  assert.equal(store.pinKind(), null);

  let time = 0;
  const counted = createKeystore({
    file: path.join(dir, 'other.json'),
    kdfCost: FAST,
    now: () => {
      time += 10 * 60 * 1000;
      return time;
    },
    ...identityFns
  });
  await counted.setPin(PIN);
  counted.lock();
  let result;
  for (let i = 0; i < 10; i++) result = await counted.unlock(WRONG);
  assert.equal(result.wiped, true);
  assert.equal(counted.pinKind(), null);
});

test('unlock says tested only when the PIN was actually tried', async (t) => {
  let time = 1000;
  const file = path.join(tempDir(t), 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, now: () => time, ...identityFns });
  await store.setPin(PIN);

  // Already unlocked: nothing was tried.
  assert.deepEqual(await store.unlock(WRONG), { ok: true });
  store.lock();

  for (let i = 0; i < 4; i++) {
    const result = await store.unlock(WRONG);
    assert.equal(result.ok, false);
    assert.equal(result.tested, true);
  }
  // Inside the wait: refused without being tried.
  const refused = await store.unlock(PIN);
  assert.equal(refused.ok, false);
  assert.ok(refused.waitMs > 0);
  assert.equal(refused.tested, undefined);

  time += 60 * 1000;
  assert.deepEqual(await store.unlock(PIN), { ok: true, tested: true });
  store.lock();

  // No PIN to try, and not a string.
  assert.equal((await createKeystore({ file: `${file}.none`, kdfCost: FAST, ...identityFns }).unlock(PIN)).tested, undefined);
  assert.equal((await store.unlock(7)).tested, undefined);

  // A result thrown away because of a lock wasn't a test either.
  const racing = store.unlock(PIN);
  await new Promise((resolve) => setImmediate(resolve));
  store.lock();
  const raced = await racing;
  if (!raced.ok) assert.equal(raced.tested, undefined);
});

test('an uncounted unlock writes no count, ignores the wait, and a wrong one wipes nothing', async (t) => {
  let time = 1000;
  const file = path.join(tempDir(t), 'keys.json');
  const store = createKeystore({ file, kdfCost: FAST, now: () => time, ...identityFns });
  await store.setPin(PIN);
  store.lock();
  const failed = () => JSON.parse(fs.readFileSync(file, 'utf8')).attempts.failed;

  for (let i = 0; i < 4; i++) await store.unlock(WRONG);
  assert.equal(failed(), 4);
  time += 1;

  for (let i = 0; i < 20; i++) {
    const result = await store.unlock(WRONG, { uncounted: true });
    assert.deepEqual(result, { ok: false, tested: true });
  }
  assert.equal(failed(), 4);
  assert.equal(store.hasPin(), true);

  // Inside the wait a counted guess is refused, and an uncounted one is still tried.
  assert.ok((await store.unlock(PIN)).waitMs > 0);
  assert.deepEqual(await store.unlock(PIN, { uncounted: true }), { ok: true, tested: true });
  assert.equal(failed(), 0);
});

test('consumeSetAside reports a file set aside at load, once, and a clean start reports nothing', async (t) => {
  const file = path.join(tempDir(t), 'keys.json');
  const first = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.equal(first.consumeSetAside(), false);
  await first.setPin(PIN);
  assert.equal(createKeystore({ file, kdfCost: FAST, ...identityFns }).consumeSetAside(), false);

  fs.writeFileSync(file, 'not json');
  const damaged = createKeystore({ file, kdfCost: FAST, ...identityFns });
  assert.equal(damaged.consumeSetAside(), true);
  assert.equal(damaged.consumeSetAside(), false);
});
