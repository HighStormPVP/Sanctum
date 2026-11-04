const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ed25519 } = require('@noble/curves/ed25519');

const remote = (name) => path.join(__dirname, '..', 'lib', 'remote', name);
const remoteCrypto = require(remote('crypto.js'));
const { newIdentity, newEphemeral, sharedSecret, hkdf, sign, open } = remoteCrypto;

// The forward secrecy test needs a control: proof that its attacker derives keys
// correctly, so that its failures mean something. Only the real ephemeral secrets
// can show that, and a session never hands them out, so this file records them as
// they're made. It has to happen before session.js is loaded, which takes its own
// reference to newEphemeral. node --test runs each file in its own process.
const madeEphemerals = [];
remoteCrypto.newEphemeral = () => {
  const ephemeral = newEphemeral();
  madeEphemerals.push(ephemeral);
  return ephemeral;
};

function session() {
  return require(remote('session.js'));
}

const SECRET_TEXT = 'Marker-Plaintext-Do-Not-Leak';

const encodeText = (text) => new TextEncoder().encode(text);
const decodeText = (bytes) => new TextDecoder().decode(bytes);
const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromB64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));
const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));
const sameBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const REFUSED = { ready: false };

// Everything crosses the wire as JSON, so the tests do too. Bytes left in a
// message rather than base64 would come out the other side as something else.
const wire = (msg) => JSON.parse(JSON.stringify(msg));

function makeSide(role, identity, peerPublicKey) {
  return session().createSession({ identity, peerPublicKey, role });
}

function makePair(homeId = newIdentity(), laptopId = newIdentity()) {
  return {
    homeId,
    laptopId,
    home: makeSide('home', homeId, laptopId.publicKey),
    laptop: makeSide('laptop', laptopId, homeId.publicKey)
  };
}

// One side starts and the other answers. Returns each message as it was on the wire.
function handshake(starter, answerer) {
  const hello = wire(starter.hello);
  const answer = answerer.handleHello(hello);
  assert.strictEqual(answer.ready, false);
  assert.ok(answer.reply);
  const auth = wire(answer.reply);
  const finish = starter.handleHello(auth);
  assert.strictEqual(finish.ready, true);
  assert.ok(finish.reply);
  const lastAuth = wire(finish.reply);
  const last = answerer.handleHello(lastAuth);
  assert.deepStrictEqual(last, { ready: true });
  return { hello, auth, lastAuth };
}

// Both sides send their hello at once, so the hellos cross and so do the replies.
function crossedHandshake(a, b) {
  const helloA = wire(a.hello);
  const helloB = wire(b.hello);
  const answerA = a.handleHello(helloB);
  const answerB = b.handleHello(helloA);
  assert.strictEqual(answerA.ready, false);
  assert.strictEqual(answerB.ready, false);
  const authA = wire(answerA.reply);
  const authB = wire(answerB.reply);
  assert.deepStrictEqual(a.handleHello(authB), { ready: true });
  assert.deepStrictEqual(b.handleHello(authA), { ready: true });
  return { helloA, helloB, authA, authB };
}

function assertRoundTrips(from, to, text = 'hello there') {
  assert.strictEqual(decodeText(to.decrypt(from.encrypt(encodeText(text)))), text);
}

function assertTalking(a, b) {
  assertRoundTrips(a, b, 'a to b, first');
  assertRoundTrips(b, a, 'b to a, first');
  assertRoundTrips(a, b, 'a to b, second');
  assertRoundTrips(b, a, 'b to a, second');
}

function assertDead(side) {
  assert.throws(() => side.encrypt(encodeText('x')));
  assert.throws(() => side.decrypt(new Uint8Array(64)));
  assert.strictEqual(side.connectionId, null);
}

function flipBit(bytes, index) {
  const copy = Uint8Array.from(bytes);
  copy[index] ^= 1;
  return copy;
}

// --- What an attacker can compute from a recording, built here from the wire
// format rather than borrowed from session.js, so a change to it fails these tests.

const COUNTER_LENGTH = 8;

function withLength(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function attackerTranscript({ homePublic, laptopPublic, homeEphemeral, laptopEphemeral }) {
  return Buffer.concat(
    [
      encodeText('sanctum-session-transcript-v1'),
      encodeText('home'),
      homePublic,
      homeEphemeral,
      encodeText('laptop'),
      laptopPublic,
      laptopEphemeral
    ].map(withLength)
  );
}

function attackerSigned(signerRole, transcript) {
  return Buffer.concat([withLength(encodeText('sanctum-session-signature-v1')), withLength(encodeText(signerRole)), transcript]);
}

function attackerDirectionKeys(ikm, transcript) {
  return [
    hkdf(ikm, transcript, encodeText('sanctum-session-home-to-laptop-v1'), 32),
    hkdf(ikm, transcript, encodeText('sanctum-session-laptop-to-home-v1'), 32)
  ];
}

function attackerOpens(key, frame) {
  const nonce = new Uint8Array(24);
  nonce.set(frame.subarray(0, COUNTER_LENGTH), 24 - COUNTER_LENGTH);
  try {
    open(key, nonce, frame.subarray(COUNTER_LENGTH));
    return true;
  } catch {
    return false;
  }
}

// --- The handshake

test('Either side can start the handshake, and frames then go both ways', () => {
  const homeFirst = makePair();
  handshake(homeFirst.home, homeFirst.laptop);
  assertTalking(homeFirst.home, homeFirst.laptop);

  const laptopFirst = makePair();
  handshake(laptopFirst.laptop, laptopFirst.home);
  assertTalking(laptopFirst.laptop, laptopFirst.home);
});

test('Both sides can send their hello at once', () => {
  const { home, laptop } = makePair();
  crossedHandshake(home, laptop);
  assertTalking(home, laptop);
});

test('An auth that overtakes the hello it follows still completes the handshake', () => {
  const { home, laptop } = makePair();
  const helloFromLaptop = wire(laptop.hello);
  const authFromLaptop = wire(laptop.handleHello(wire(home.hello)).reply);

  const early = home.handleHello(authFromLaptop);
  assert.strictEqual(early.ready, true);
  assert.deepStrictEqual(laptop.handleHello(wire(early.reply)), { ready: true });

  // The late hello changes nothing and gets no second reply.
  assert.deepStrictEqual(home.handleHello(helloFromLaptop), { ready: true });
  assertTalking(home, laptop);
});

test('A hello delivered twice gets the same reply, not a refusal', () => {
  const { home, laptop } = makePair();
  const hello = wire(home.hello);
  const first = laptop.handleHello(hello);
  const second = laptop.handleHello(hello);
  assert.deepStrictEqual(second, first);

  const finish = home.handleHello(wire(first.reply));
  assert.deepStrictEqual(laptop.handleHello(wire(finish.reply)), { ready: true });
  assertTalking(home, laptop);
});

test('Once ready, handshake messages change nothing', () => {
  const pair = makePair();
  const recorded = handshake(pair.home, pair.laptop);
  const other = makePair(pair.homeId, pair.laptopId);
  const connectionId = pair.home.connectionId;

  for (const msg of [recorded.hello, recorded.auth, recorded.lastAuth, wire(other.home.hello), { t: 'junk' }, null]) {
    assert.deepStrictEqual(pair.home.handleHello(msg), { ready: true });
    assert.deepStrictEqual(pair.laptop.handleHello(msg), { ready: true });
  }
  assert.ok(sameBytes(pair.home.connectionId, connectionId));
  assertTalking(pair.home, pair.laptop);
});

test('Handshake messages are JSON text and carry no long-term key', () => {
  const pair = makePair();
  const recorded = handshake(pair.home, pair.laptop);
  for (const msg of Object.values(recorded)) {
    assert.deepStrictEqual(wire(msg), msg);
    const text = JSON.stringify(msg);
    for (const key of [pair.homeId.publicKey, pair.homeId.secretKey, pair.laptopId.publicKey, pair.laptopId.secretKey]) {
      assert.ok(!text.includes(toB64(key)));
    }
  }
});

test('Each session uses a fresh ephemeral key', () => {
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const first = makePair(homeId, laptopId);
  const second = makePair(homeId, laptopId);
  assert.notStrictEqual(first.home.hello.ephemeral, second.home.hello.ephemeral);
  assert.notStrictEqual(first.laptop.hello.ephemeral, second.laptop.hello.ephemeral);
  assert.strictEqual(fromB64(first.home.hello.ephemeral).length, 32);
});

test('A session refuses bad values from its own caller', () => {
  const identity = newIdentity();
  const peerPublicKey = newIdentity().publicKey;
  const { createSession } = session();
  assert.throws(() => createSession({ identity, peerPublicKey, role: 'phone' }), /role/);
  assert.throws(() => createSession({ identity, peerPublicKey }), /role/);
  assert.throws(() => createSession({ peerPublicKey, role: 'home' }), /identity/);
  assert.throws(() => createSession({ identity: { publicKey: identity.publicKey }, peerPublicKey, role: 'home' }), /identity/);
  assert.throws(() => createSession({ identity: { publicKey: new Uint8Array(3), secretKey: identity.secretKey }, peerPublicKey, role: 'home' }), /identity/);
  assert.throws(() => createSession({ identity: { publicKey: identity.publicKey, secretKey: new Uint8Array(3) }, peerPublicKey, role: 'home' }), /identity/);
  assert.throws(() => createSession({ identity, role: 'home' }), /peer/);
  assert.throws(() => createSession({ identity, peerPublicKey: new Uint8Array(31), role: 'home' }), /peer/);
});

// --- The connection id

test('Both ends get the same 4-byte connection id once ready', () => {
  const { home, laptop } = makePair();
  assert.strictEqual(home.connectionId, null);
  assert.strictEqual(laptop.connectionId, null);
  handshake(home, laptop);
  assert.ok(home.connectionId instanceof Uint8Array);
  assert.strictEqual(home.connectionId.length, 4);
  assert.ok(sameBytes(home.connectionId, laptop.connectionId));

  const crossed = makePair();
  crossedHandshake(crossed.home, crossed.laptop);
  assert.ok(sameBytes(crossed.home.connectionId, crossed.laptop.connectionId));
});

test('Two sessions between the same devices get different connection ids', () => {
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const first = makePair(homeId, laptopId);
  const second = makePair(homeId, laptopId);
  handshake(first.home, first.laptop);
  handshake(second.home, second.laptop);
  assert.ok(!sameBytes(first.home.connectionId, second.home.connectionId));
});

test('The connection id comes from the secret, the transcript, and its own label', () => {
  madeEphemerals.length = 0;
  const pair = makePair();
  const [homeEphemeral, laptopEphemeral] = madeEphemerals;
  handshake(pair.home, pair.laptop);

  const transcript = attackerTranscript({
    homePublic: pair.homeId.publicKey,
    laptopPublic: pair.laptopId.publicKey,
    homeEphemeral: homeEphemeral.publicKey,
    laptopEphemeral: laptopEphemeral.publicKey
  });
  const ikm = sharedSecret(homeEphemeral.secretKey, laptopEphemeral.publicKey);
  const expected = hkdf(ikm, transcript, encodeText('sanctum-session-connection-id-v1'), 4);
  assert.ok(sameBytes(pair.home.connectionId, expected));

  // Being seen by the relay is fine, because it isn't any part of a traffic key.
  for (const key of attackerDirectionKeys(ikm, transcript)) {
    assert.ok(!contains(key, pair.home.connectionId));
  }
});

// --- Who is on the other end

test('A session refuses a peer signing with a different long-term key', () => {
  for (const [victimRole, peerRole] of [['home', 'laptop'], ['laptop', 'home']]) {
    const victimId = newIdentity();
    const realPeerId = newIdentity();
    const imposterId = newIdentity();

    // The victim started, so the imposter's first answer is the one refused.
    const started = makeSide(victimRole, victimId, realPeerId.publicKey);
    const imposter = makeSide(peerRole, imposterId, victimId.publicKey);
    const answer = imposter.handleHello(wire(started.hello));
    assert.deepStrictEqual(started.handleHello(wire(answer.reply)), REFUSED);
    assertDead(started);

    // The imposter started, so the victim has already signed. Its auth names the real
    // peer, so an honest session on the imposter's side refuses it too.
    const imposter2 = makeSide(peerRole, imposterId, victimId.publicKey);
    const answered = makeSide(victimRole, victimId, realPeerId.publicKey);
    const victimAuth = wire(answered.handleHello(wire(imposter2.hello)).reply);
    assert.deepStrictEqual(imposter2.handleHello(victimAuth), REFUSED);

    // Signing exactly what the victim expects, with the wrong key. The control is
    // the same bytes signed with the right key, on a session in the same position.
    const attempt = (signerId) => {
      const victim = makeSide(victimRole, victimId, realPeerId.publicKey);
      const peerEphemeral = newEphemeral().publicKey;
      const own = { publicKey: victimId.publicKey, ephemeral: fromB64(victim.hello.ephemeral) };
      const peer = { publicKey: realPeerId.publicKey, ephemeral: peerEphemeral };
      const [homeSide, laptopSide] = victimRole === 'home' ? [own, peer] : [peer, own];
      const transcript = attackerTranscript({
        homePublic: homeSide.publicKey,
        laptopPublic: laptopSide.publicKey,
        homeEphemeral: homeSide.ephemeral,
        laptopEphemeral: laptopSide.ephemeral
      });
      const signature = toB64(sign(signerId.secretKey, attackerSigned(peerRole, transcript)));
      return victim.handleHello({ t: 'session-auth', ephemeral: toB64(peerEphemeral), signature });
    };
    assert.deepStrictEqual(attempt(imposterId), REFUSED);
    assert.strictEqual(attempt(realPeerId).ready, true);
  }
});

test('A signature made for a different pairing is refused', () => {
  const laptopId = newIdentity();
  const realHomeId = newIdentity();
  const otherHomeId = newIdentity();
  const laptopForRealHome = makeSide('laptop', laptopId, realHomeId.publicKey);
  const otherHome = makeSide('home', otherHomeId, laptopId.publicKey);

  // The relay shows the laptop the other home's hello as if it were the real one's.
  // The signature is the laptop's own and covers the right ephemerals, but it names
  // a different home.
  const answer = laptopForRealHome.handleHello(wire(otherHome.hello));
  assert.deepStrictEqual(otherHome.handleHello(wire(answer.reply)), REFUSED);
});

test('Two sides claiming the same role never finish', () => {
  for (const role of ['home', 'laptop']) {
    const aId = newIdentity();
    const bId = newIdentity();
    const a = makeSide(role, aId, bId.publicKey);
    const b = makeSide(role, bId, aId.publicKey);
    const answer = b.handleHello(wire(a.hello));
    assert.deepStrictEqual(a.handleHello(wire(answer.reply)), REFUSED);
  }
});

test('A session refuses its own messages sent back to it', () => {
  const { home } = makePair();
  assert.deepStrictEqual(home.handleHello(wire(home.hello)), REFUSED);
  assertDead(home);

  const { home: otherHome, laptop } = makePair();
  const auth = wire(laptop.handleHello(wire(otherHome.hello)).reply);
  assert.deepStrictEqual(laptop.handleHello(auth), REFUSED);
  assertDead(laptop);
});

test("A side's own signature is refused when sent back, even if it were paired with its own key", () => {
  // The worst case: the key that signed is the key being checked, and the transcript
  // is the same one, so the only thing stopping this is the signer's role.
  const sharedId = newIdentity();
  const victim = makeSide('home', sharedId, sharedId.publicKey);
  const relayEphemeral = toB64(newEphemeral().publicKey);
  const signedAsHome = wire(victim.handleHello({ t: 'session-hello', ephemeral: relayEphemeral }).reply);
  assert.deepStrictEqual(victim.handleHello({ ...signedAsHome, ephemeral: relayEphemeral }), REFUSED);
  assertDead(victim);

  // Control: the same message signed under the expected role is accepted.
  const control = makeSide('home', sharedId, sharedId.publicKey);
  control.handleHello({ t: 'session-hello', ephemeral: relayEphemeral });
  const transcript = attackerTranscript({
    homePublic: sharedId.publicKey,
    laptopPublic: sharedId.publicKey,
    homeEphemeral: fromB64(control.hello.ephemeral),
    laptopEphemeral: fromB64(relayEphemeral)
  });
  const signature = toB64(sign(sharedId.secretKey, attackerSigned('laptop', transcript)));
  assert.strictEqual(control.handleHello({ t: 'session-auth', ephemeral: relayEphemeral, signature }).ready, true);
});

// --- Replay

test('A recorded hello and auth do not complete a session', () => {
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const earlier = makePair(homeId, laptopId);
  const recorded = handshake(earlier.home, earlier.laptop);

  // Replayed in full to a new session on the home's side: the laptop's messages
  // from the earlier handshake.
  const newHome = makeSide('home', homeId, laptopId.publicKey);
  assert.deepStrictEqual(newHome.handleHello(recorded.auth), REFUSED);
  assertDead(newHome);

  // Replayed to a new session on the laptop's side: the home's messages. It answers
  // the hello, because it can't yet tell, and then refuses what's signed.
  const newLaptop = makeSide('laptop', laptopId, homeId.publicKey);
  const answer = newLaptop.handleHello(recorded.hello);
  assert.strictEqual(answer.ready, false);
  assert.ok(answer.reply);
  assert.deepStrictEqual(newLaptop.handleHello(recorded.lastAuth), REFUSED);
  assertDead(newLaptop);
});

test('A recorded auth sent alone to a new session is refused', () => {
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const earlier = makePair(homeId, laptopId);
  const recorded = crossedHandshake(earlier.home, earlier.laptop);

  const newLaptop = makeSide('laptop', laptopId, homeId.publicKey);
  assert.deepStrictEqual(newLaptop.handleHello(recorded.authA), REFUSED);
  assertDead(newLaptop);

  const newHome = makeSide('home', homeId, laptopId.publicKey);
  assert.deepStrictEqual(newHome.handleHello(recorded.authB), REFUSED);
  assertDead(newHome);
});

test('A signature on the wrong ephemeral key is refused', () => {
  const { home, laptop } = makePair();
  const answer = wire(laptop.handleHello(wire(home.hello)).reply);

  const swapped = { ...answer, ephemeral: toB64(newEphemeral().publicKey) };
  assert.deepStrictEqual(home.handleHello(swapped), REFUSED);
  assertDead(home);
});

test('A hello swapped in flight is caught when the signatures are checked', () => {
  const { home, laptop } = makePair();
  const relayEphemeral = newEphemeral();
  const forgedHello = { ...wire(home.hello), ephemeral: toB64(relayEphemeral.publicKey) };

  // The laptop signs over the relay's ephemeral, which the home never sent.
  const answer = laptop.handleHello(forgedHello);
  assert.deepStrictEqual(home.handleHello(wire(answer.reply)), REFUSED);
});

test('A peer changing its ephemeral key partway through is refused', () => {
  const { home, laptop } = makePair();
  laptop.handleHello(wire(home.hello));
  const changed = { ...wire(home.hello), ephemeral: toB64(newEphemeral().publicKey) };
  assert.deepStrictEqual(laptop.handleHello(changed), REFUSED);
  assertDead(laptop);
});

test('A refusal is final: the real peer can no longer finish', () => {
  const { home, laptop } = makePair();
  const hello = wire(home.hello);
  assert.deepStrictEqual(laptop.handleHello({ t: 'junk' }), REFUSED);
  assert.deepStrictEqual(laptop.handleHello(hello), REFUSED);
  assertDead(laptop);
});

test('Malformed handshake messages are refused without throwing', () => {
  const lowOrder = [new Uint8Array(32), Uint8Array.from([1, ...new Array(31).fill(0)])];
  const good = () => {
    const pair = makePair();
    return { ...pair, auth: wire(pair.laptop.handleHello(wire(pair.home.hello)).reply) };
  };
  const helloBuilders = [
    () => null,
    () => undefined,
    () => 'session-hello',
    () => 7,
    () => [],
    () => ({}),
    () => ({ t: 'pake' }),
    () => ({ t: 'session-hello' }),
    () => ({ t: 'session-hello', ephemeral: 5 }),
    () => ({ t: 'session-hello', ephemeral: toB64(new Uint8Array(31)) }),
    () => ({ t: 'session-hello', ephemeral: toB64(new Uint8Array(33)) }),
    () => ({ t: 'session-hello', ephemeral: 'not base64 at all!' }),
    () => ({ t: 'session-hello', ephemeral: toB64(newEphemeral().publicKey) + '\n' }),
    ...lowOrder.map((point) => () => ({ t: 'session-hello', ephemeral: toB64(point) }))
  ];
  for (const build of helloBuilders) {
    const { home } = makePair();
    assert.deepStrictEqual(home.handleHello(build()), REFUSED);
    assertDead(home);
  }

  const authBuilders = [
    (auth) => ({ ...auth, signature: undefined }),
    (auth) => ({ ...auth, signature: 5 }),
    (auth) => ({ ...auth, signature: toB64(new Uint8Array(64)) }),
    (auth) => ({ ...auth, signature: toB64(new Uint8Array(12)) }),
    (auth) => ({ ...auth, signature: auth.signature + '=' }),
    (auth) => ({ ...auth, signature: toB64(flipBit(fromB64(auth.signature), 3)) }),
    (auth) => ({ ...auth, ephemeral: undefined })
  ];
  for (const build of authBuilders) {
    const { home, auth } = good();
    assert.deepStrictEqual(home.handleHello(build(auth)), REFUSED);
    assertDead(home);
  }
});

// --- Frames

test('Frames round-trip any bytes, including none', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const payloads = [new Uint8Array(0), Uint8Array.from([0, 255, 1, 254]), new Uint8Array(70000).fill(7)];
  for (const payload of payloads) {
    assert.ok(sameBytes(laptop.decrypt(home.encrypt(payload)), payload));
    assert.ok(sameBytes(home.decrypt(laptop.encrypt(payload)), payload));
  }
  // Buffers are Uint8Arrays too, and can sit at an offset in a shared pool.
  const pooled = Buffer.from(home.encrypt(encodeText('pooled')));
  assert.strictEqual(decodeText(laptop.decrypt(pooled)), 'pooled');
});

test('Frames are refused before the handshake finishes', () => {
  const { home, laptop } = makePair();
  assert.throws(() => home.encrypt(encodeText('x')), /not ready/);
  assert.throws(() => home.decrypt(new Uint8Array(64)), /not ready/);

  // Having answered a hello is not enough. Nothing has yet proved who sent it.
  laptop.handleHello(wire(home.hello));
  assert.throws(() => laptop.encrypt(encodeText('x')), /not ready/);
  assert.throws(() => laptop.decrypt(new Uint8Array(64)), /not ready/);
});

test('A flipped bit anywhere in a frame throws, and the real frame still opens', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const frame = home.encrypt(encodeText('short'));
  for (let i = 0; i < frame.length; i++) {
    assert.throws(() => laptop.decrypt(flipBit(frame, i)));
  }
  // A forgery must not move the counter, or one bad frame would desync the stream.
  assert.strictEqual(decodeText(laptop.decrypt(frame)), 'short');
});

test('A frame with a repeated counter is refused', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const first = home.encrypt(encodeText('first'));
  assert.strictEqual(decodeText(laptop.decrypt(first)), 'first');
  assert.throws(() => laptop.decrypt(first), /counter/);
  assertRoundTrips(home, laptop);
});

test('A frame with any counter but the next one is refused', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const first = home.encrypt(encodeText('first'));
  const second = home.encrypt(encodeText('second'));
  assert.throws(() => laptop.decrypt(second), /counter/);
  assert.strictEqual(decodeText(laptop.decrypt(first)), 'first');
  assert.strictEqual(decodeText(laptop.decrypt(second)), 'second');
});

test("Rewriting a frame's counter to the expected value fails, because it is the nonce", () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const first = home.encrypt(encodeText('first'));
  const second = home.encrypt(encodeText('second'));

  const rewritten = Uint8Array.from(second);
  rewritten.set(first.subarray(0, COUNTER_LENGTH));
  assert.throws(() => laptop.decrypt(rewritten));

  assert.strictEqual(Buffer.from(first).readBigUInt64BE(0), 0n);
  assert.strictEqual(Buffer.from(second).readBigUInt64BE(0), 1n);
});

test('A frame sent back to its sender is refused', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  // Same counter, so only the direction in the key stops this.
  assert.throws(() => home.decrypt(home.encrypt(encodeText('reflected'))));
  assert.throws(() => laptop.decrypt(laptop.encrypt(encodeText('reflected'))));
});

test('The two directions never share a keystream', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const plaintext = encodeText('same text, same counter');
  const fromHome = home.encrypt(plaintext);
  const fromLaptop = laptop.encrypt(plaintext);
  assert.ok(sameBytes(fromHome.subarray(0, COUNTER_LENGTH), fromLaptop.subarray(0, COUNTER_LENGTH)));
  assert.ok(!sameBytes(fromHome, fromLaptop));
});

test('A frame from an earlier session between the same devices is refused', () => {
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const earlier = makePair(homeId, laptopId);
  handshake(earlier.home, earlier.laptop);
  const oldFrame = earlier.home.encrypt(encodeText('old'));

  const current = makePair(homeId, laptopId);
  handshake(current.home, current.laptop);
  assert.throws(() => current.laptop.decrypt(oldFrame));
  assertRoundTrips(current.home, current.laptop);
});

test('Frames too short to hold a counter and a tag are refused', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  for (const length of [0, 1, 7, 8, 23]) {
    assert.throws(() => laptop.decrypt(new Uint8Array(length)));
  }
  assert.throws(() => laptop.decrypt('not bytes'));
  assert.throws(() => laptop.decrypt(null));
  assertRoundTrips(home, laptop);
});

test('A plaintext that is not bytes throws and uses up no counter', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  assert.throws(() => home.encrypt('a string'));
  assert.strictEqual(Buffer.from(home.encrypt(encodeText('x'))).readBigUInt64BE(0), 0n);
});

test('The counter throws at exhaustion rather than wrapping', () => {
  const { nonceFor } = session();
  const last = 2n ** 64n - 1n;
  const nonce = nonceFor(last);
  assert.strictEqual(nonce.length, 24);
  assert.ok(sameBytes(nonce.subarray(0, 16), new Uint8Array(16)));
  assert.ok(sameBytes(nonce.subarray(16), new Uint8Array(8).fill(255)));
  assert.throws(() => nonceFor(last + 1n), /exhausted/);
  assert.throws(() => nonceFor(-1n));
});

test('Plaintext does not appear in the ciphertext', () => {
  const { home, laptop } = makePair();
  handshake(home, laptop);
  const plaintext = encodeText(`before ${SECRET_TEXT} after`);
  const frame = home.encrypt(plaintext);
  assert.ok(!contains(frame, encodeText(SECRET_TEXT)));
  assert.ok(!contains(frame, encodeText(toB64(encodeText(SECRET_TEXT)))));
  assert.ok(contains(laptop.decrypt(frame), encodeText(SECRET_TEXT)));
});

// --- Forward secrecy

test('Both long-term keys leaking later does not open recorded traffic', () => {
  madeEphemerals.length = 0;
  const homeId = newIdentity();
  const laptopId = newIdentity();
  const pair = makePair(homeId, laptopId);
  const [homeEphemeralKeys, laptopEphemeralKeys] = madeEphemerals;

  // What a relay records: every handshake message and every frame.
  const recorded = handshake(pair.home, pair.laptop);
  const framesFromHome = ['home one', 'home two'].map((text) => pair.home.encrypt(encodeText(text)));
  const framesFromLaptop = ['laptop one', 'laptop two'].map((text) => pair.laptop.encrypt(encodeText(text)));
  const frames = [...framesFromHome, ...framesFromLaptop];

  // The attacker's view of the ephemerals is the public half, read off the recording.
  const homeEphemeral = fromB64(recorded.hello.ephemeral);
  const laptopEphemeral = fromB64(recorded.auth.ephemeral);
  const transcript = attackerTranscript({
    homePublic: homeId.publicKey,
    laptopPublic: laptopId.publicKey,
    homeEphemeral,
    laptopEphemeral
  });

  // Control: with the secret that was actually used, this same derivation opens every
  // frame. So when it fails below, the keys are what's wrong, not the attacker's code.
  const realSecret = sharedSecret(homeEphemeralKeys.secretKey, laptopEphemeralKeys.publicKey);
  const [homeToLaptop, laptopToHome] = attackerDirectionKeys(realSecret, transcript);
  for (const frame of framesFromHome) assert.ok(attackerOpens(homeToLaptop, frame));
  for (const frame of framesFromLaptop) assert.ok(attackerOpens(laptopToHome, frame));

  // The attack: everything derivable from the two leaked secret keys and the
  // recording. Each secret key raw and in its X25519 form, against every public value
  // available, including each other's identity keys.
  const secrets = [homeId.secretKey, laptopId.secretKey].flatMap((secret) => [secret, ed25519.utils.toMontgomerySecret(secret)]);
  const publics = [
    homeEphemeral,
    laptopEphemeral,
    ed25519.utils.toMontgomery(homeId.publicKey),
    ed25519.utils.toMontgomery(laptopId.publicKey)
  ];
  const candidates = [...secrets, ...secrets.flatMap((secret) => publics.map((peer) => sharedSecret(secret, peer)))];
  assert.strictEqual(candidates.length, 4 + 4 * 4);
  for (const ikm of candidates) {
    for (const key of attackerDirectionKeys(ikm, transcript)) {
      for (const frame of frames) {
        assert.ok(!attackerOpens(key, frame));
      }
    }
  }

  // Using the leaked keys in the real protocol: the attacker impersonates the laptop
  // to a new home session, and the handshake succeeds. It doesn't help. That session
  // has a new ephemeral key, so it holds different traffic keys.
  const forged = makeSide('home', homeId, laptopId.publicKey);
  const forgedTranscript = attackerTranscript({
    homePublic: homeId.publicKey,
    laptopPublic: laptopId.publicKey,
    homeEphemeral: fromB64(forged.hello.ephemeral),
    laptopEphemeral
  });
  const forgedAuth = {
    t: 'session-auth',
    ephemeral: recorded.auth.ephemeral,
    signature: toB64(sign(laptopId.secretKey, attackerSigned('laptop', forgedTranscript)))
  };
  assert.strictEqual(forged.handleHello(forgedAuth).ready, true);
  for (const frame of framesFromLaptop) {
    assert.throws(() => forged.decrypt(frame));
  }
});
