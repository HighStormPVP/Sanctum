const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const path = require('node:path');

const remote = (name) => path.join(__dirname, '..', 'lib', 'remote', name);
const { newIdentity, sign, verify, seal, open, deviceIdFromPublicKey } = require(remote('crypto.js'));
const { pakeStart } = require(remote('pake.js'));

function pairing() {
  return require(remote('pairing.js'));
}

const CODE = 'K7M2QX';
const WRONG_CODE = 'K7M2QY';
const HOME_NAME = 'Marker-Home-Desktop';
const LAPTOP_NAME = 'Marker-Laptop-Travel';

const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

// Everything crosses the wire as JSON, so the tests do too. Bytes left in a
// message rather than base64 would come out the other side as something else.
const wire = (msg) => JSON.parse(JSON.stringify(msg));

function makeHost(code = CODE) {
  const identity = newIdentity();
  return { identity, name: HOME_NAME, side: pairing().createPairingHost({ code, identity, name: HOME_NAME }) };
}

function makeGuest(code = CODE) {
  const identity = newIdentity();
  return { identity, name: LAPTOP_NAME, side: pairing().createPairingGuest({ code, identity, name: LAPTOP_NAME }) };
}

// Runs the exchange and stops at a sender's message number `tamperAt` (0 to 3)
// to change it in flight. Each message goes to the other side, which either
// replies or ends the run.
function run(host, guest, tamperAt = -1, tamper = (msg) => msg) {
  const messages = [];
  let current = guest.first;
  let toHost = true;
  let hostResult = null;
  let guestResult = null;
  while (current) {
    let sent = wire(current);
    if (messages.length === tamperAt) sent = wire(tamper(sent));
    messages.push(sent);
    const result = (toHost ? host : guest).handle(sent);
    if (toHost) hostResult = result;
    else guestResult = result;
    current = result.reply;
    toHost = !toHost;
  }
  return { messages, hostResult, guestResult };
}

function assertFailed(result) {
  assert.ok(result.failed, 'expected failed');
  assert.strictEqual(result.peer, undefined, 'a failed result must carry no peer');
  assert.strictEqual(result.reply, undefined, 'a failed result must send nothing');
}

function assertPeer(peer, expected) {
  assert.deepStrictEqual(Object.keys(peer).sort(), ['deviceId', 'name', 'publicKey']);
  assert.ok(peer.publicKey instanceof Uint8Array);
  assert.deepStrictEqual(toB64(peer.publicKey), toB64(expected.identity.publicKey));
  assert.strictEqual(peer.deviceId, deviceIdFromPublicKey(expected.identity.publicKey));
  assert.strictEqual(peer.name, expected.name);
}

function flipField(field, index = 0) {
  return (msg) => {
    const bytes = fromB64(msg[field]);
    bytes[index] ^= 0x01;
    return { ...msg, [field]: toB64(bytes) };
  };
}

// ---------------------------------------------------------------------------
// The protocol as the brief writes it, built here from independent parts (Node's
// hkdf and SHA-256) rather than from pairing.js. A hostile peer is this with one
// thing changed. Honest runs against the real sides pin the wire format and every
// label, and they prove each forgery below fails for its one change alone.
// ---------------------------------------------------------------------------
function deriveSealKey(sharedKey, label = 'sanctum-pairing-seal-v1') {
  return new Uint8Array(nodeCrypto.hkdfSync('sha256', sharedKey, new Uint8Array(32), label, 32));
}

function lengthPrefixed(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function pakeDigest(first, second) {
  return nodeCrypto.createHash('sha256')
    .update(lengthPrefixed(first))
    .update(lengthPrefixed(second))
    .digest();
}

function identityProof(role, homePake, laptopPake, label = 'sanctum-pairing-identity-v1') {
  return Buffer.concat([Buffer.from(label), Buffer.from(role), pakeDigest(homePake, laptopPake)]);
}

function sealPlain(sealKey, role, plaintext) {
  const nonce = nodeCrypto.randomBytes(24);
  const box = seal(sealKey, nonce, Buffer.from(plaintext), Buffer.from(role));
  return { nonce: toB64(nonce), box: toB64(box) };
}

function honestIdentity({ role, sharedKey, homePake, laptopPake, identity, name }) {
  const signature = sign(identity.secretKey, identityProof(role, homePake, laptopPake));
  return sealPlain(deriveSealKey(sharedKey), role, JSON.stringify({
    publicKey: toB64(identity.publicKey),
    name,
    signature: toB64(signature)
  }));
}

// Plays the laptop against a real host: the right code, a good confirmation, then
// whatever identity message `build` makes.
function laptopAttack(host, build) {
  const pake = pakeStart(CODE, 'laptop');
  const { reply } = host.handle({ t: 'pake', pake: toB64(pake.message) });
  const keys = pake.finish(fromB64(reply.pake));
  assert.ok(keys.verifyConfirm(fromB64(reply.confirm)));
  const context = {
    role: 'laptop',
    otherRole: 'home',
    sharedKey: keys.sharedKey,
    homePake: fromB64(reply.pake),
    laptopPake: pake.message
  };
  return host.handle({ t: 'confirm', confirm: toB64(keys.confirmMessage), ...build(context) });
}

// Plays the home PC against a real guest, the same way.
function homeAttack(guest, build) {
  const pake = pakeStart(CODE, 'home');
  const keys = pake.finish(fromB64(guest.first.pake));
  const { reply } = guest.handle({
    t: 'pake-reply',
    pake: toB64(pake.message),
    confirm: toB64(keys.confirmMessage)
  });
  assert.ok(keys.verifyConfirm(fromB64(reply.confirm)));
  const context = {
    role: 'home',
    otherRole: 'laptop',
    sharedKey: keys.sharedKey,
    homePake: pake.message,
    laptopPake: fromB64(guest.first.pake)
  };
  return guest.handle({ t: 'identity', ...build(context) });
}

// Builds an identity message from `attacker`, with parts overridden per case.
function identityMessage(context, attacker, overrides = {}) {
  const { role, sharedKey, homePake, laptopPake } = context;
  const proof = overrides.proof || identityProof(role, homePake, laptopPake);
  const signature = overrides.signature || sign((overrides.signer || attacker).secretKey, proof);
  const plaintext = overrides.plaintext || JSON.stringify({
    publicKey: toB64(overrides.publicKey || attacker.publicKey),
    name: 'name' in overrides ? overrides.name : 'Attacker',
    signature: toB64(signature)
  });
  return sealPlain(overrides.sealKey || deriveSealKey(sharedKey), overrides.aad || role, plaintext);
}

const ID_POINT = new Uint8Array(32);
ID_POINT[0] = 1;

// Each entry changes one thing about an otherwise valid identity message.
const FORGERIES = {
  'claims a key it does not hold': (ctx, attacker, victim) => identityMessage(ctx, attacker, {
    publicKey: victim.publicKey
  }),
  'signs as the other role': (ctx, attacker) => identityMessage(ctx, attacker, {
    proof: identityProof(ctx.otherRole, ctx.homePake, ctx.laptopPake)
  }),
  'signs under another label': (ctx, attacker) => identityMessage(ctx, attacker, {
    proof: identityProof(ctx.role, ctx.homePake, ctx.laptopPake, 'sanctum-pairing-identity-v2')
  }),
  'signs the pake messages in the other order': (ctx, attacker) => identityMessage(ctx, attacker, {
    proof: identityProof(ctx.role, ctx.laptopPake, ctx.homePake)
  }),
  'signs an earlier exchange': (ctx, attacker) => identityMessage(ctx, attacker, {
    proof: identityProof(ctx.role, pakeStart(CODE, 'home').message, ctx.laptopPake)
  }),
  'signs without the length prefixes': (ctx, attacker) => identityMessage(ctx, attacker, {
    proof: Buffer.concat([
      Buffer.from('sanctum-pairing-identity-v1'),
      Buffer.from(ctx.role),
      nodeCrypto.createHash('sha256').update(ctx.homePake).update(ctx.laptopPake).digest()
    ])
  }),
  'flips a bit of its signature': (ctx, attacker) => {
    const signature = sign(attacker.secretKey, identityProof(ctx.role, ctx.homePake, ctx.laptopPake));
    signature[10] ^= 0x01;
    return identityMessage(ctx, attacker, { signature });
  },
  'truncates its signature': (ctx, attacker) => {
    const signature = sign(attacker.secretKey, identityProof(ctx.role, ctx.homePake, ctx.laptopPake));
    return identityMessage(ctx, attacker, { signature: signature.slice(0, 63) });
  },
  // Verifies against any message unless small-order keys are refused.
  'uses a small-order key that matches every signature': (ctx, attacker) => {
    const signature = new Uint8Array(64);
    signature.set(ID_POINT, 0);
    return identityMessage(ctx, attacker, { publicKey: ID_POINT, signature });
  },
  'seals under the other role': (ctx, attacker) => identityMessage(ctx, attacker, { aad: ctx.otherRole }),
  'seals under another key label': (ctx, attacker) => identityMessage(ctx, attacker, {
    sealKey: deriveSealKey(ctx.sharedKey, 'sanctum-pairing-seal-v2')
  }),
  'gives a name that is not a string': (ctx, attacker) => identityMessage(ctx, attacker, { name: 42 }),
  'gives no name': (ctx, attacker) => identityMessage(ctx, attacker, { name: undefined }),
  'seals something that is not JSON': (ctx, attacker) => identityMessage(ctx, attacker, { plaintext: 'not json' }),
  'seals a JSON null': (ctx, attacker) => identityMessage(ctx, attacker, { plaintext: 'null' }),
  'seals a key that is not base64': (ctx, attacker) => identityMessage(ctx, attacker, {
    plaintext: JSON.stringify({ publicKey: 7, name: 'Attacker', signature: 'AAAA' })
  })
};

// ---------------------------------------------------------------------------
// Code rules
// ---------------------------------------------------------------------------
test('CODE_ALPHABET is the agreed alphabet and has no ambiguous characters', () => {
  const { CODE_ALPHABET } = pairing();
  assert.strictEqual(CODE_ALPHABET, '23456789ABCDEFGHJKMNPQRSTUVWXYZ');
  for (const ch of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!CODE_ALPHABET.includes(ch), `alphabet has ${ch}`);
  }
});

test('newCode makes 6 characters from the alphabet, and they vary', () => {
  const { CODE_ALPHABET, newCode, normalizeCode } = pairing();
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const code = newCode();
    assert.strictEqual(code.length, 6);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
    assert.strictEqual(normalizeCode(code), code);
    seen.add(code);
  }
  assert.ok(seen.size > 290, `only ${seen.size} distinct codes in 300`);
});

test('normalizeCode uppercases a valid code', () => {
  const { normalizeCode } = pairing();
  assert.strictEqual(normalizeCode('k7m2qx'), 'K7M2QX');
  assert.strictEqual(normalizeCode('K7M2QX'), 'K7M2QX');
  assert.strictEqual(normalizeCode('k7M2qX'), 'K7M2QX');
});

test('normalizeCode refuses a wrong length', () => {
  const { normalizeCode } = pairing();
  for (const input of ['', 'K7M2Q', 'K7M2QXA', ' K7M2QX', 'K7M2QX ', 'K7M2QX\n', 'K7M 2QX']) {
    assert.strictEqual(normalizeCode(input), null, JSON.stringify(input));
  }
});

test('normalizeCode refuses characters outside the alphabet, in either case', () => {
  const { normalizeCode } = pairing();
  for (const input of ['K7M2Q0', 'K7M2QO', 'K7M2Q1', 'K7M2QI', 'K7M2QL', 'k7m2qo', 'k7m2qi', 'k7m2ql', 'K7M-QX', 'K7M2Q!']) {
    assert.strictEqual(normalizeCode(input), null, input);
  }
});

test('normalizeCode refuses text that only uppercases into the alphabet', () => {
  const { normalizeCode } = pairing();
  // Uppercasing these gives valid text: long s to S, sharp s to SS, ligature ff to FF.
  assert.strictEqual('ſ'.toUpperCase(), 'S');
  assert.strictEqual('ß'.toUpperCase(), 'SS');
  assert.strictEqual('ﬀ'.toUpperCase(), 'FF');
  for (const input of ['ſAAAAA', 'ßAAAA', 'ﬀAAAA', 'Ｋ7M2QX']) {
    assert.strictEqual(normalizeCode(input), null, input);
  }
});

test('normalizeCode refuses anything but a string', () => {
  const { normalizeCode } = pairing();
  for (const input of [undefined, null, 123456, {}, [], ['K7M2QX'], true]) {
    assert.strictEqual(normalizeCode(input), null);
  }
});

test('both sides refuse a bad code, name or identity when created', () => {
  const { createPairingHost, createPairingGuest } = pairing();
  const identity = newIdentity();
  for (const create of [createPairingHost, createPairingGuest]) {
    assert.throws(() => create({ code: 'K7M2Q0', identity, name: 'A' }));
    assert.throws(() => create({ code: undefined, identity, name: 'A' }));
    assert.throws(() => create({ code: CODE, identity, name: undefined }));
    assert.throws(() => create({ code: CODE, identity: undefined, name: 'A' }));
    assert.throws(() => create({ code: CODE, identity: {}, name: 'A' }));
  }
});

// ---------------------------------------------------------------------------
// A full exchange
// ---------------------------------------------------------------------------
test('host and guest each end with the other as their peer', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { hostResult, guestResult } = run(host.side, guest.side);
  assertPeer(hostResult.peer, guest);
  assertPeer(guestResult.peer, host);
  assert.strictEqual(hostResult.failed, undefined);
  assert.strictEqual(guestResult.failed, undefined);
  assert.strictEqual(guestResult.reply, undefined);
});

test('the exchange runs in the agreed order with the agreed fields', () => {
  const { messages } = run(makeHost().side, makeGuest().side);
  assert.deepStrictEqual(messages.map((m) => Object.keys(m).sort()), [
    ['pake', 't'],
    ['confirm', 'pake', 't'],
    ['box', 'confirm', 'nonce', 't'],
    ['box', 'nonce', 't']
  ]);
  assert.deepStrictEqual(messages.map((m) => m.t), ['pake', 'pake-reply', 'confirm', 'identity']);
  assert.strictEqual(fromB64(messages[0].pake).length, 65);
  assert.strictEqual(fromB64(messages[1].pake).length, 65);
  assert.strictEqual(fromB64(messages[2].nonce).length, 24);
  assert.strictEqual(fromB64(messages[3].nonce).length, 24);
});

test('every message survives JSON and carries only strings', () => {
  const host = makeHost();
  const guest = makeGuest();
  const raw = [];
  let current = guest.side.first;
  let toHost = true;
  while (current) {
    raw.push(current);
    current = (toHost ? host.side : guest.side).handle(current).reply;
    toHost = !toHost;
  }
  assert.strictEqual(raw.length, 4);
  for (const msg of raw) {
    assert.deepStrictEqual(wire(msg), { ...msg });
    for (const value of Object.values(msg)) assert.strictEqual(typeof value, 'string');
  }
});

// Both directions share one key, so a repeated nonce would reuse its keystream.
test('nonces differ between the two sealed messages and between exchanges', () => {
  const a = run(makeHost().side, makeGuest().side).messages;
  const b = run(makeHost().side, makeGuest().side).messages;
  const nonces = [a[2].nonce, a[3].nonce, b[2].nonce, b[3].nonce];
  assert.strictEqual(new Set(nonces).size, 4);
});

test('the guest types the code in lowercase and it still pairs', () => {
  const host = makeHost('K7M2QX');
  const guest = makeGuest('k7m2qx');
  const { hostResult, guestResult } = run(host.side, guest.side);
  assertPeer(hostResult.peer, guest);
  assertPeer(guestResult.peer, host);
});

test('a name outside ASCII arrives intact', () => {
  const identity = newIdentity();
  const name = 'Aidén’s ノート 💻';
  const host = pairing().createPairingHost({ code: CODE, identity, name });
  const { guestResult } = run(host, makeGuest().side);
  assert.strictEqual(guestResult.peer.name, name);
});

test('handle works detached and attemptsLeft stays live', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { handle } = host.side;
  assert.strictEqual(host.side.attemptsLeft, 5);
  assert.ok(handle(wire(guest.side.first)).reply);
  assert.strictEqual(host.side.attemptsLeft, 4);
});

test('no message carries the code, a name or a key as plaintext', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { messages, hostResult, guestResult } = run(host.side, guest.side);
  assert.ok(hostResult.peer && guestResult.peer, 'the exchange must complete for this to mean anything');

  const secrets = [
    CODE,
    CODE.toLowerCase(),
    HOME_NAME,
    LAPTOP_NAME,
    host.identity.publicKey,
    host.identity.secretKey,
    guest.identity.publicKey,
    guest.identity.secretKey
  ];
  const forms = secrets.flatMap((secret) => (
    typeof secret === 'string'
      ? [Buffer.from(secret)]
      : [Buffer.from(secret), Buffer.from(toB64(secret)), Buffer.from(Buffer.from(secret).toString('hex'))]
  ));
  const leaksIn = (msg) => {
    const haystacks = [
      Buffer.from(JSON.stringify(msg)),
      ...Object.values(msg).map((value) => Buffer.from(value, 'base64'))
    ];
    return forms.filter((form) => haystacks.some((haystack) => contains(haystack, form)));
  };

  // The search has to be able to find each thing, in the clear or in a base64 field.
  assert.strictEqual(leaksIn({ box: `x${HOME_NAME}x` }).length, 1);
  assert.strictEqual(leaksIn({ box: toB64(Buffer.from(`x${CODE}x`)) }).length, 1);
  assert.strictEqual(leaksIn({ box: toB64(guest.identity.secretKey) }).length >= 1, true);

  for (const msg of messages) {
    assert.deepStrictEqual(leaksIn(msg), [], `a leak in message ${msg.t}`);
  }
});

test('independent build of the protocol pairs with a real host', () => {
  const host = makeHost();
  const attacker = newIdentity();
  const result = laptopAttack(host.side, (ctx) => honestIdentity({ ...ctx, identity: attacker, name: 'Independent' }));
  assert.ok(result.peer, 'the real host must accept the protocol as written');
  assert.strictEqual(toB64(result.peer.publicKey), toB64(attacker.publicKey));
  assert.strictEqual(result.peer.name, 'Independent');
  assert.strictEqual(result.reply.t, 'identity');
});

test('independent build of the protocol pairs with a real guest', () => {
  const guest = makeGuest();
  const attacker = newIdentity();
  const result = homeAttack(guest.side, (ctx) => honestIdentity({ ...ctx, identity: attacker, name: 'Independent' }));
  assert.ok(result.peer, 'the real guest must accept the protocol as written');
  assert.strictEqual(toB64(result.peer.publicKey), toB64(attacker.publicKey));
  assert.strictEqual(result.peer.name, 'Independent');
});

test('the real sides seal and sign exactly what the brief says', () => {
  const host = makeHost();
  const guest = makeGuest();

  const pakeHome = pakeStart(CODE, 'home');
  const keysHome = pakeHome.finish(fromB64(guest.side.first.pake));
  const { reply: confirmMsg } = guest.side.handle({
    t: 'pake-reply',
    pake: toB64(pakeHome.message),
    confirm: toB64(keysHome.confirmMessage)
  });
  const sealedLaptop = JSON.parse(Buffer.from(open(
    deriveSealKey(keysHome.sharedKey),
    fromB64(confirmMsg.nonce),
    fromB64(confirmMsg.box),
    Buffer.from('laptop')
  )).toString());
  assert.deepStrictEqual(Object.keys(sealedLaptop).sort(), ['name', 'publicKey', 'signature']);
  assert.strictEqual(sealedLaptop.name, LAPTOP_NAME);
  assert.strictEqual(sealedLaptop.publicKey, toB64(guest.identity.publicKey));
  assert.ok(verify(
    guest.identity.publicKey,
    identityProof('laptop', pakeHome.message, fromB64(guest.side.first.pake)),
    fromB64(sealedLaptop.signature)
  ));

  const pakeLaptop = pakeStart(CODE, 'laptop');
  const { reply: pakeReply } = host.side.handle({ t: 'pake', pake: toB64(pakeLaptop.message) });
  const keysLaptop = pakeLaptop.finish(fromB64(pakeReply.pake));
  const { reply: identityMsg } = host.side.handle({
    t: 'confirm',
    confirm: toB64(keysLaptop.confirmMessage),
    ...honestIdentity({
      role: 'laptop',
      sharedKey: keysLaptop.sharedKey,
      homePake: fromB64(pakeReply.pake),
      laptopPake: pakeLaptop.message,
      identity: guest.identity,
      name: LAPTOP_NAME
    })
  });
  const sealedHome = JSON.parse(Buffer.from(open(
    deriveSealKey(keysLaptop.sharedKey),
    fromB64(identityMsg.nonce),
    fromB64(identityMsg.box),
    Buffer.from('home')
  )).toString());
  assert.strictEqual(sealedHome.name, HOME_NAME);
  assert.strictEqual(sealedHome.publicKey, toB64(host.identity.publicKey));
  assert.ok(verify(
    host.identity.publicKey,
    identityProof('home', fromB64(pakeReply.pake), pakeLaptop.message),
    fromB64(sealedHome.signature)
  ));
});

// ---------------------------------------------------------------------------
// Wrong code
// ---------------------------------------------------------------------------
test('a wrong code fails with no peer on the guest, sends nothing, and spends an attempt', () => {
  const host = makeHost();
  const guest = makeGuest(WRONG_CODE);
  const { messages, guestResult } = run(host.side, guest.side);
  assertFailed(guestResult);
  assert.strictEqual(messages.length, 2, 'the guest must not send its identity after a bad confirmation');
  assert.strictEqual(host.side.attemptsLeft, 4);
});

test('a wrong code that sends a confirmation anyway fails on the host, for one attempt', () => {
  const host = makeHost();
  const pake = pakeStart(WRONG_CODE, 'laptop');
  const { reply } = host.side.handle({ t: 'pake', pake: toB64(pake.message) });
  const keys = pake.finish(fromB64(reply.pake));
  const result = host.side.handle({
    t: 'confirm',
    confirm: toB64(keys.confirmMessage),
    ...honestIdentity({
      role: 'laptop',
      sharedKey: keys.sharedKey,
      homePake: fromB64(reply.pake),
      laptopPake: pake.message,
      identity: newIdentity(),
      name: 'Attacker'
    })
  });
  assertFailed(result);
  assert.strictEqual(host.side.attemptsLeft, 4, 'one wrong guess costs one attempt, not two');
});

test('the host sends no identity until the guest has proved the code', () => {
  const host = makeHost();
  const guest = makeGuest(WRONG_CODE);
  const reply = host.side.handle(wire(guest.side.first)).reply;
  assert.deepStrictEqual(Object.keys(reply).sort(), ['confirm', 'pake', 't']);
});

test('a guess abandoned after seeing the host confirmation still spends an attempt', () => {
  const host = makeHost();
  const guess = () => host.side.handle({ t: 'pake', pake: toB64(pakeStart(WRONG_CODE, 'laptop').message) });
  for (let left = 4; left >= 0; left--) {
    assert.ok(guess().reply, 'each of the five guesses gets its one answer');
    assert.strictEqual(host.side.attemptsLeft, left);
  }
  assertFailed(guess());
  assert.strictEqual(host.side.attemptsLeft, 0);

  const realGuest = makeGuest();
  assertFailed(host.side.handle(wire(realGuest.side.first)));
});

test('a new attempt replaces one in flight, and the old confirmation no longer works', () => {
  const host = makeHost();
  const first = makeGuest();
  const second = makeGuest();
  const firstReply = host.side.handle(wire(first.side.first)).reply;
  assert.ok(host.side.handle(wire(second.side.first)).reply);
  assert.strictEqual(host.side.attemptsLeft, 3);

  const staleConfirm = first.side.handle(wire(firstReply)).reply;
  assertFailed(host.side.handle(wire(staleConfirm)));
  assert.strictEqual(host.side.attemptsLeft, 3);
});

test('after five wrong codes the correct code also fails', () => {
  const host = makeHost();
  for (let i = 0; i < 5; i++) {
    assertFailed(run(host.side, makeGuest(WRONG_CODE).side).guestResult);
    assert.strictEqual(host.side.attemptsLeft, 4 - i);
  }
  const good = makeGuest();
  const { messages, hostResult, guestResult } = run(host.side, good.side);
  assertFailed(hostResult);
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(guestResult, null);
  assert.strictEqual(host.side.attemptsLeft, 0);
});

test('a cancelled code stays cancelled and attemptsLeft never goes below zero', () => {
  const host = makeHost();
  for (let i = 0; i < 5; i++) run(host.side, makeGuest(WRONG_CODE).side);
  const good = makeGuest();
  for (let i = 0; i < 3; i++) {
    assertFailed(host.side.handle(wire(good.side.first)));
    assert.strictEqual(host.side.attemptsLeft, 0);
  }
});

test('the correct code on the fifth attempt pairs, and only failures count', () => {
  const host = makeHost();
  for (let i = 0; i < 4; i++) run(host.side, makeGuest(WRONG_CODE).side);
  assert.strictEqual(host.side.attemptsLeft, 1);
  const good = makeGuest();
  const { hostResult, guestResult } = run(host.side, good.side);
  assertPeer(hostResult.peer, good);
  assertPeer(guestResult.peer, host);
  assert.strictEqual(host.side.attemptsLeft, 1);
});

test('a clean first pairing leaves every attempt unspent', () => {
  const host = makeHost();
  run(host.side, makeGuest().side);
  assert.strictEqual(host.side.attemptsLeft, 5);
});

// ---------------------------------------------------------------------------
// Tampering, at each step and on each field
// ---------------------------------------------------------------------------
const FIELDS_BY_STEP = [
  { step: 0, receiver: 'host', fields: ['pake'] },
  { step: 1, receiver: 'guest', fields: ['pake', 'confirm'] },
  { step: 2, receiver: 'host', fields: ['confirm', 'nonce', 'box'] },
  { step: 3, receiver: 'guest', fields: ['nonce', 'box'] }
];

const TAMPERINGS = {
  'a flipped bit': (field) => flipField(field),
  'a flipped bit near the end': (field) => (msg) => flipField(field, fromB64(msg[field]).length - 1)(msg),
  'a missing field': (field) => (msg) => {
    const out = { ...msg };
    delete out[field];
    return out;
  },
  // The same bytes, spelled in a way strict base64 refuses.
  'a second spelling of the same bytes': (field) => (msg) => ({ ...msg, [field]: `${msg[field]}\n` })
};

for (const { step, receiver, fields } of FIELDS_BY_STEP) {
  for (const field of fields) {
    for (const [how, make] of Object.entries(TAMPERINGS)) {
      test(`step ${step}: ${how} in ${field} fails on the ${receiver} with no peer`, () => {
        const host = makeHost();
        const guest = makeGuest();
        const { messages, hostResult, guestResult } = run(host.side, guest.side, step, make(field));
        assert.strictEqual(messages.length, step + 1, 'the receiver must not answer a tampered message');
        assertFailed(receiver === 'host' ? hostResult : guestResult);
        if (step < 3) {
          // Nothing has been accepted by either side yet.
          assert.ok(!hostResult || !hostResult.peer, 'the host must have no peer');
          assert.ok(!guestResult || !guestResult.peer, 'the guest must have no peer');
        } else {
          // The last message has no answer, so only the guest can notice. The host
          // has the real guest's verified identity, and nothing forged.
          assertPeer(hostResult.peer, guest);
        }
      });
    }
  }
}

test('replacing a pake message with a valid point of another code leaves both sides without a peer', () => {
  const swap = (role) => (msg) => ({ ...msg, pake: toB64(pakeStart(WRONG_CODE, role).message) });

  const toHost = run(makeHost().side, makeGuest().side, 0, swap('laptop'));
  assertFailed(toHost.guestResult);
  assert.ok(!toHost.hostResult.peer);

  const toGuest = run(makeHost().side, makeGuest().side, 1, swap('home'));
  assertFailed(toGuest.guestResult);
  assert.ok(!toGuest.hostResult.peer);
});

test('a tampered message also ends the attempt it was aimed at', () => {
  const host = makeHost();
  const guest = makeGuest();
  const reply = host.side.handle(wire(guest.side.first)).reply;
  const confirmMsg = guest.side.handle(wire(reply)).reply;
  assertFailed(host.side.handle(flipField('confirm')(wire(confirmMsg))));
  assert.strictEqual(host.side.attemptsLeft, 4);
  assertFailed(host.side.handle(wire(confirmMsg)));
});

test('a tampered box after a good confirmation is a failed attempt, and the code still works', () => {
  const host = makeHost();
  const { hostResult } = run(host.side, makeGuest().side, 2, flipField('box'));
  assertFailed(hostResult);
  assert.strictEqual(host.side.attemptsLeft, 4);

  const good = makeGuest();
  assertPeer(run(host.side, good.side).hostResult.peer, good);
});

// ---------------------------------------------------------------------------
// Forged identity signatures, from either side
// ---------------------------------------------------------------------------
// The control: with nothing overridden, the helper every forgery uses is accepted.
// So each forgery below fails for its own change, not because the helper is wrong.
test('an unforged identity message from the same helper pairs with both real sides', () => {
  const attacker = newIdentity();
  const onHost = laptopAttack(makeHost().side, (ctx) => identityMessage(ctx, attacker));
  assert.strictEqual(toB64(onHost.peer.publicKey), toB64(attacker.publicKey));
  assert.strictEqual(onHost.peer.name, 'Attacker');

  const onGuest = homeAttack(makeGuest().side, (ctx) => identityMessage(ctx, attacker));
  assert.strictEqual(toB64(onGuest.peer.publicKey), toB64(attacker.publicKey));
  assert.strictEqual(onGuest.peer.name, 'Attacker');
});

for (const [how, forge] of Object.entries(FORGERIES)) {
  test(`a laptop that ${how} fails on the host with no peer`, () => {
    const host = makeHost();
    const attacker = newIdentity();
    const victim = newIdentity();
    assertFailed(laptopAttack(host.side, (ctx) => forge(ctx, attacker, victim)));
    assert.strictEqual(host.side.attemptsLeft, 4);
  });

  test(`a home PC that ${how} fails on the guest with no peer`, () => {
    const guest = makeGuest();
    const attacker = newIdentity();
    const victim = newIdentity();
    assertFailed(homeAttack(guest.side, (ctx) => forge(ctx, attacker, victim)));
  });
}

test('a forged identity costs one attempt, and the real device can still pair', () => {
  const host = makeHost();
  const attacker = newIdentity();
  assertFailed(laptopAttack(host.side, (ctx) => identityMessage(ctx, attacker, {
    publicKey: newIdentity().publicKey
  })));
  assert.strictEqual(host.side.attemptsLeft, 4);

  const good = makeGuest();
  assertPeer(run(host.side, good.side).hostResult.peer, good);
  assert.strictEqual(host.side.attemptsLeft, 4);
});

test('the small-order forgery is one a loose verifier would accept', () => {
  const { ed25519 } = require('@noble/curves/ed25519');
  const signature = new Uint8Array(64);
  signature.set(ID_POINT, 0);
  assert.ok(ed25519.verify(signature, Buffer.from('anything'), ID_POINT, { zip215: true }));
  assert.strictEqual(verify(ID_POINT, Buffer.from('anything'), signature), false);
});

test('a guest that claims the host key cannot pass the host its own identity back', () => {
  const host = makeHost();
  const attacker = newIdentity();
  assertFailed(laptopAttack(host.side, (ctx) => identityMessage(ctx, attacker, {
    publicKey: host.identity.publicKey
  })));
});

// ---------------------------------------------------------------------------
// Replay, reflection, order and junk
// ---------------------------------------------------------------------------
test('replaying a whole recorded exchange to a new host gets nowhere', () => {
  const { messages } = run(makeHost().side, makeGuest().side);
  const fresh = makeHost();
  assert.ok(fresh.side.handle(messages[0]).reply, 'the old pake message starts a new attempt');
  assertFailed(fresh.side.handle(messages[2]));
  assert.strictEqual(fresh.side.attemptsLeft, 4);
});

test('replaying a recorded host reply to a new guest gets nowhere', () => {
  const { messages } = run(makeHost().side, makeGuest().side);
  assertFailed(makeGuest().side.handle(messages[1]));
});

test('a guest refuses its own pake message sent back to it', () => {
  const guest = makeGuest();
  const stolen = pakeStart(CODE, 'laptop').finish(fromB64(guest.side.first.pake));
  assertFailed(guest.side.handle({
    t: 'pake-reply',
    pake: guest.side.first.pake,
    confirm: toB64(stolen.confirmMessage)
  }));
});

test('a host refuses its own confirmation sent back to it', () => {
  const host = makeHost();
  const guest = makeGuest();
  const reply = host.side.handle(wire(guest.side.first)).reply;
  const confirmMsg = guest.side.handle(wire(reply)).reply;
  assertFailed(host.side.handle({ ...wire(confirmMsg), confirm: reply.confirm }));
});

test('a host refuses a confirmation with no attempt in flight, at no cost', () => {
  const { messages } = run(makeHost().side, makeGuest().side);
  const fresh = makeHost();
  assertFailed(fresh.side.handle(messages[2]));
  assert.strictEqual(fresh.side.attemptsLeft, 5);
});

test('a guest refuses the identity message before the reply, and is then finished', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { messages } = run(makeHost().side, makeGuest().side);
  assertFailed(guest.side.handle(messages[3]));
  const reply = host.side.handle(wire(guest.side.first)).reply;
  assertFailed(guest.side.handle(wire(reply)));
});

test('a guest has one try: a failure stays final', () => {
  const host = makeHost();
  const guest = makeGuest();
  const reply = host.side.handle(wire(guest.side.first)).reply;
  assertFailed(guest.side.handle(flipField('confirm')(wire(reply))));
  assertFailed(guest.side.handle(wire(reply)));
});

const JUNK = [
  undefined,
  null,
  0,
  '',
  'pake',
  true,
  [],
  {},
  { t: 'nonsense' },
  { t: 'confirm' },
  { t: 'identity' },
  { t: 'pake-reply' },
  { t: 'confirm', confirm: 12, nonce: {}, box: [] },
  { t: 'identity', nonce: null, box: 'AAAA' },
  { t: 'pake-reply', pake: 'AAAA', confirm: 'AAAA' },
  { t: 'pake-reply', pake: [], confirm: {} }
];

test('a host answers junk with failed, never throwing and at no cost', () => {
  const host = makeHost();
  for (const junk of JUNK) {
    assertFailed(host.side.handle(junk));
    assert.strictEqual(host.side.attemptsLeft, 5);
  }
  for (const pake of [undefined, null, 12, {}, 'not base64!']) {
    assertFailed(host.side.handle({ t: 'pake', pake }));
    assert.strictEqual(host.side.attemptsLeft, 5);
  }
});

test('a pake message that decodes but is no point spends an attempt, so it cannot burn CPU for free', () => {
  const host = makeHost();
  for (let left = 4; left >= 0; left--) {
    assertFailed(host.side.handle({ t: 'pake', pake: 'AAAA' }));
    assert.strictEqual(host.side.attemptsLeft, left);
  }
  assertFailed(host.side.handle({ t: 'pake', pake: 'AAAA' }));
  assert.strictEqual(host.side.attemptsLeft, 0);
});

test('a guest answers junk with failed, at each step, never throwing', () => {
  const guest = makeGuest();
  for (const junk of JUNK) assertFailed(guest.side.handle(junk));

  const afterReply = [null, 'pake', {}, { t: 'pake-reply' }, { t: 'identity', nonce: null, box: 'AAAA' }];
  for (const junk of afterReply) {
    const host = makeHost();
    const fresh = makeGuest();
    assert.ok(fresh.side.handle(wire(host.side.handle(wire(fresh.side.first)).reply)).reply);
    assertFailed(fresh.side.handle(junk));
  }
});

test('junk during an attempt ends it', () => {
  const host = makeHost();
  const guest = makeGuest();
  const reply = host.side.handle(wire(guest.side.first)).reply;
  const confirmMsg = guest.side.handle(wire(reply)).reply;
  assertFailed(host.side.handle({ t: 'nonsense' }));
  assertFailed(host.side.handle(wire(confirmMsg)));
  assert.strictEqual(host.side.attemptsLeft, 4);
});

// ---------------------------------------------------------------------------
// Works once
// ---------------------------------------------------------------------------
test('a code that has paired refuses everything afterwards', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { messages, hostResult } = run(host.side, guest.side);
  assert.ok(hostResult.peer);

  assertFailed(host.side.handle(messages[2]));
  assertFailed(host.side.handle(messages[0]));
  const second = makeGuest();
  assertFailed(host.side.handle(wire(second.side.first)));
  assert.strictEqual(host.side.attemptsLeft, 5);
});

test('a guest that has paired refuses everything afterwards', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { messages, guestResult } = run(host.side, guest.side);
  assert.ok(guestResult.peer);
  assertFailed(guest.side.handle(messages[3]));
  assertFailed(guest.side.handle(messages[1]));
});

test('the sides expose no key material', () => {
  const host = makeHost();
  const guest = makeGuest();
  assert.deepStrictEqual(Object.keys(host.side).sort(), ['attemptsInFlight', 'attemptsLeft', 'end', 'handle']);
  assert.deepStrictEqual(Object.keys(guest.side).sort(), ['first', 'handle']);
});

// ---------------------------------------------------------------------------
// The service address, sealed into the home PC's identity for a pairing that came
// over the local network, so a laptop with only the code learns it
// ---------------------------------------------------------------------------
const SERVICE_ADDRESS = 'wss://relay.example/marker-secret-segment';

// As run(), with options for the host on every message, as the manager passes them
// for a message that arrived over the local network.
function runLocal(host, guest, { pake, confirm } = {}, tamperAt = -1, tamper = (msg) => msg) {
  const messages = [];
  let current = guest.first;
  let toHost = true;
  let hostResult = null;
  let guestResult = null;
  while (current) {
    let sent = wire(current);
    if (messages.length === tamperAt) sent = wire(tamper(sent));
    messages.push(sent);
    let result;
    if (toHost) result = host.handle(sent, sent.t === 'pake' ? pake : confirm);
    else result = guest.handle(sent);
    if (toHost) hostResult = result;
    else guestResult = result;
    current = result.reply;
    toHost = !toHost;
  }
  return { messages, hostResult, guestResult };
}

const local = { address: SERVICE_ADDRESS };

test('an attempt over the local network seals the address into the identity, and the guest gets it beside the peer', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { hostResult, guestResult } = runLocal(host.side, guest.side, { pake: local, confirm: local });
  assertPeer(guestResult.peer, host);
  assert.strictEqual(guestResult.address, SERVICE_ADDRESS);
  // The host's own record of the laptop never carries one.
  assertPeer(hostResult.peer, guest);
});

test('without the local option no address is sealed, and the result has no address at all', () => {
  const { guestResult } = run(makeHost().side, makeGuest().side);
  assert.ok(guestResult.peer);
  assert.ok(!('address' in guestResult));
});

test('the address goes only when both the pake and the confirmation came over the local network', () => {
  for (const options of [{ pake: local }, { confirm: local }]) {
    const { guestResult } = runLocal(makeHost().side, makeGuest().side, options);
    assert.ok(guestResult.peer);
    assert.ok(!('address' in guestResult), JSON.stringify(Object.keys(options)));
  }
});

test('the address is never readable on the wire, and a wrong code never gets a sealed one', () => {
  const right = runLocal(makeHost().side, makeGuest().side, { pake: local, confirm: local });
  const wrong = runLocal(makeHost().side, makeGuest(WRONG_CODE).side, { pake: local, confirm: local });
  assert.strictEqual(wrong.messages.length, 2, 'the wrong code stops after the reply');
  assert.ok(!wrong.messages.some((m) => m.t === 'identity'));
  for (const { messages } of [right, wrong]) {
    const text = JSON.stringify(messages);
    assert.ok(!text.includes(SERVICE_ADDRESS));
    assert.ok(!text.includes('marker-secret-segment'));
    assert.ok(!text.includes(toB64(Buffer.from(SERVICE_ADDRESS))));
  }
});

test('a tampered identity carrying the address fails the seal on the guest', () => {
  for (const index of [0, 40, 80]) {
    const { guestResult } = runLocal(makeHost().side, makeGuest().side, { pake: local, confirm: local }, 3, flipField('box', index));
    assertFailed(guestResult);
    assert.ok(!('address' in guestResult));
  }
});

test('an identity sealed with an address that is not a string fails, and a string one passes', () => {
  const home = newIdentity();
  const build = (address) => (ctx) => identityMessage(ctx, home, {
    plaintext: JSON.stringify({
      publicKey: toB64(home.publicKey),
      name: 'Home',
      signature: toB64(sign(home.secretKey, identityProof(ctx.role, ctx.homePake, ctx.laptopPake))),
      address
    })
  });
  for (const bad of [42, null, {}, ['wss://relay.example/x'], true]) assertFailed(homeAttack(makeGuest().side, build(bad)));
  const good = homeAttack(makeGuest().side, build(SERVICE_ADDRESS));
  assert.strictEqual(good.address, SERVICE_ADDRESS);
  assert.strictEqual(toB64(good.peer.publicKey), toB64(home.publicKey));
});

test('a host ignores an address in the laptop identity', () => {
  const attacker = newIdentity();
  const result = laptopAttack(makeHost().side, (ctx) => identityMessage(ctx, attacker, {
    plaintext: JSON.stringify({
      publicKey: toB64(attacker.publicKey),
      name: 'Laptop',
      signature: toB64(sign(attacker.secretKey, identityProof(ctx.role, ctx.homePake, ctx.laptopPake))),
      address: SERVICE_ADDRESS
    })
  }));
  assert.deepStrictEqual(Object.keys(result.peer).sort(), ['deviceId', 'name', 'publicKey']);
  assert.ok(!('address' in result));
});

// ---------------------------------------------------------------------------
// One attempt in flight per channel, so a line on one connection can never end
// another's. The budget is still one for the code.
// ---------------------------------------------------------------------------
test('junk on another channel does not end an attempt in flight', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { reply } = host.side.handle(wire(guest.side.first), { channel: 'laptop' });
  assert.ok(reply);
  assertFailed(host.side.handle({ t: 'junk' }, { channel: 'stranger' }));
  assertFailed(host.side.handle({ t: 'pake', pake: 'AAAA' }, { channel: 'stranger' }));
  const confirm = guest.side.handle(wire(reply)).reply;
  const done = host.side.handle(wire(confirm), { channel: 'laptop' });
  assertPeer(done.peer, guest);
});

test('an attempt can only be finished on the channel that started it, and a stray confirm costs nothing', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { reply } = host.side.handle(wire(guest.side.first), { channel: 'a' });
  const confirm = wire(guest.side.handle(wire(reply)).reply);
  assertFailed(host.side.handle(confirm, { channel: 'b' }));
  assert.strictEqual(host.side.attemptsLeft, 4);
  assertPeer(host.side.handle(confirm, { channel: 'a' }).peer, guest);
});

test('anything else on the same channel still ends its attempt', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { reply } = host.side.handle(wire(guest.side.first), { channel: 'a' });
  const confirm = wire(guest.side.handle(wire(reply)).reply);
  assertFailed(host.side.handle({ t: 'junk' }, { channel: 'a' }));
  assertFailed(host.side.handle(confirm, { channel: 'a' }));
});

test('attempts in flight are counted per channel, and end() lets one go without a cost back', () => {
  const host = makeHost();
  host.side.handle(wire(makeGuest().side.first), { channel: 'a' });
  host.side.handle(wire(makeGuest().side.first), { channel: 'b' });
  host.side.handle(wire(makeGuest().side.first));
  assert.strictEqual(host.side.attemptsInFlight, 3);
  assert.strictEqual(host.side.attemptsLeft, 2);
  host.side.end('a');
  assert.strictEqual(host.side.attemptsInFlight, 2);
  assert.strictEqual(host.side.attemptsLeft, 2, 'a try is charged when it starts, and stays charged');
});

test('the address still needs both messages on one local channel', () => {
  const host = makeHost();
  const guest = makeGuest();
  const { reply } = host.side.handle(wire(guest.side.first), { channel: 'a', address: SERVICE_ADDRESS });
  const confirm = wire(guest.side.handle(wire(reply)).reply);
  const done = host.side.handle(confirm, { channel: 'a', address: SERVICE_ADDRESS });
  assert.strictEqual(guest.side.handle(wire(done.reply)).address, SERVICE_ADDRESS);
});
