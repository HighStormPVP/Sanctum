const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const path = require('node:path');
const { p256 } = require('@noble/curves/nist');

const Point = p256.Point;
const ORDER = Point.Fn.ORDER;
const FIELD = Point.Fp.ORDER;

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const flipBit = (input, index = 0) => {
  const out = new Uint8Array(input);
  out[index] ^= 0x01;
  return out;
};
const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle));

function load(name) {
  return require(path.join(__dirname, '..', 'lib', 'remote', name));
}

// ---------------------------------------------------------------------------
// RFC 9382 Appendix B, pasted verbatim. Parsed below rather than retyped, so
// this block can be diffed against the RFC.
// ---------------------------------------------------------------------------
const RFC9382_APPENDIX_B = `
 spake2: A='server', B='client'
 w = 0x2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f
 x = 0x43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729
 pA = 0x04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470
 f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c
 y = 0xdcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be
 pB = 0x0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676
 d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7
 K = 0x0412af7e89717850671913e6b469ace67bd90a4df8ce45c2af19010175e37eed
 69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db277b715d3325
 TT = 0x06000000000000007365727665720600000000000000636c69656e744100000
 00000000004a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751
 470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c4
 1000000000000000406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf43
 67a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a
 1e0b741000000000000000412af7e89717850671913e6b469ace67bd90a4df8ce45c2a
 f19010175e37eed69f75897996d539356e2fa6a406d528501f907e04d97515fbe83db2
 77b715d332520000000000000002ee57912099d31560b3a44b1184b9b4866e904c49d1
 2ac5042c97dca461b1a5f
 HASH(TT) = 0x0e0672dc86f8e45565d338b0540abe6915bdf72e2b35b5c9e5663168e9
 60a91b
 Ke = 0x0e0672dc86f8e45565d338b0540abe69
 Ka = 0x15bdf72e2b35b5c9e5663168e960a91b
 KcA = 0x00c12546835755c86d8c0db7851ae86f
 KcB = 0xa9fa3406c3b781b93d804485430ca27a
 A conf = 0x58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281f
 ee38f0
 B conf = 0xd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26
 dc459b

 spake2: A='', B='client'
 w = 0x0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae
 x = 0x403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b
 pA = 0x04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd8
 5f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a
 y = 0x903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065
 pB = 0x04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974
 a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc
 K = 0x048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a735e
 bda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa6
 TT = 0x00000000000000000600000000000000636c69656e74410000000000000004a
 897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba9
 66578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a4100000000000
 00004e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b8
 81a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc4100000
 000000000048f83ec9f6e4f87cc6f9dc740bdc2769725f923364f01c84148c049a39a7
 35ebda82eac03e00112fd6a5710682767cff5361f7e819e53d8d3c3a2922e0d837aa62
 0000000000000000548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e
 883e2efae
 Hash(TT) = 0x642f05c473c2cd79909f9a841e2f30a70bf89b18180af97353ba198789
 c2b963
 Ke = 0x642f05c473c2cd79909f9a841e2f30a7
 Ka = 0x0bf89b18180af97353ba198789c2b963
 KcA = 0xc6be376fc7cd1301fd0a13adf3e7bffd
 KcB = 0xb7243f4ae60440a49b3f8cab3c1fba07
 A conf = 0x47d29e6666af1b7dd450d571233085d7a9866e4d49d2645e2df9754895
 21232b
 B conf = 0x3313c5cefc361d27fb16847a91c2a73b766ffa90a4839122a9b70a2f6b
 d1d6df

 spake2: A='server', B=''
 w = 0x626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254
 x = 0x07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633
 pA = 0x04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2
 e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0
 y = 0xb6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16
 pB = 0x040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101
 e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db
 K = 0x0445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986afa
 f3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe
 TT = 0x06000000000000007365727665720000000000000000410000000000000004f
 88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b2
 98503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b04100000000000
 000040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7c
 ca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db4100000
 0000000000445ee233b8ecb51ebd6e7da3f307e88a1616bae2166121221fdc0dadb986
 afaf3ec8a988dc9c626fa3b99f58a7ca7c9b844bb3e8dd9554aafc5b53813504c1cbe2
 000000000000000626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b1
 4eae8c254
 Hash(TT) = 0x005184ff460da2ce59062c87733c299c3521297d736598fc0a1127600e
 fa1afb
 Ke = 0x005184ff460da2ce59062c87733c299c
 Ka = 0x3521297d736598fc0a1127600efa1afb
 KcA = 0xf3da53604f0aeecea5a33be7bddf6edf
 KcB = 0x9e3f86848736f159bd92b6e107ec6799
 A conf = 0xbc9f9bbe99f26d0b2260e6456e05a86196a3307ec6663a18bf6ac8257365
 33b2
 B conf = 0xc2370e1bf813b086dff0d834e74425a06e6390f48f5411900276dcccc5a2
 97ec

 spake2: A='', B=''
 w = 0x7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca
 x = 0x8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473
 pA = 0x04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f4
 6ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66
 y = 0xd7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53
 pB = 0x04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494
 662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d
 K = 0x041a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40
 a994b4477f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e135543772
 TT = 0x00000000000000000000000000000000410000000000000004a65b367a3f613
 cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28
 de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66410000000000000004589f132
 18822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b6469
 2dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d4100000000000000041
 a3c03d51b452537ca2a1fea6110353c6d5ed483c4f0f86f4492ca3f378d40a994b4477
 f93c64d928edbbcd3e85a7c709b7ea73ee97986ce3d1438e1355437722000000000000
 0007bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca
 Hash(TT) = 0xfc6374762ba5cf11f4b2caa08b2cd1b9907ae0e26e8d6234318d91583c
 d74c86
 Ke = 0xfc6374762ba5cf11f4b2caa08b2cd1b9
 Ka = 0x907ae0e26e8d6234318d91583cd74c86
 KcA = 0x5dbd2f477166b7fb6d61febbd77a5563
 KcB = 0x7689b4654407a5faeffdc8f18359d8a3
 A conf = 0xdfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade9
 5dca
 B conf = 0xd0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0a
 e175
`;

function parseVectors(text) {
  return text.split(/^\s*spake2:/m).slice(1).map((chunk) => {
    const lines = chunk.split('\n');
    const header = /A='(.*?)', B='(.*?)'/.exec(lines[0]);
    const vector = { A: header[1], B: header[2] };
    let field = null;
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line) continue;
      const start = /^(.+?) = 0x([0-9a-f]+)$/.exec(line);
      if (start) {
        field = start[1].toLowerCase();
        vector[field] = start[2];
      } else {
        assert.match(line, /^[0-9a-f]+$/);
        vector[field] += line;
      }
    }
    return vector;
  });
}

const VECTORS = parseVectors(RFC9382_APPENDIX_B);

// RFC 9382 Section 6, the P-256 values and the seeds they were generated from.
const RFC_M = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const RFC_N = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';
const RFC_M_SEED = '1.2.840.10045.3.1.7 point generation seed (M)';
const RFC_N_SEED = '1.2.840.10045.3.1.7 point generation seed (N)';

// The derivation the brief fixes, written separately from lib/remote/pake.js so
// that a change to the scrypt settings there fails a test.
function expectedW(code) {
  const out = nodeCrypto.scryptSync(code, 'sanctum-pairing-v1', 64, {
    N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  });
  return BigInt('0x' + out.toString('hex')) % ORDER;
}

// A real curve point whose x is small enough that x + p still fits in 32 bytes.
function pointWithSmallX() {
  for (let x = 1n; x < 1000n; x++) {
    try {
      return Point.fromHex('02' + x.toString(16).padStart(64, '0'));
    } catch { /* no point at this x, try the next */ }
  }
  throw new Error('no small x found');
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------
test('all three noble packages and ws load through require', () => {
  assert.strictEqual(typeof require('@noble/curves/nist').p256.Point, 'function');
  assert.strictEqual(typeof require('@noble/curves/ed25519').ed25519.sign, 'function');
  assert.strictEqual(typeof require('@noble/ciphers/chacha').xchacha20poly1305, 'function');
  assert.strictEqual(typeof require('@noble/hashes/sha2').sha256, 'function');
  assert.strictEqual(typeof require('ws').WebSocket, 'function');
});

test('the dependencies are pinned to the verified versions', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  assert.strictEqual(pkg.dependencies['@noble/curves'], '1.9.7');
  assert.strictEqual(pkg.dependencies['@noble/ciphers'], '1.3.0');
  assert.strictEqual(pkg.dependencies['@noble/hashes'], '1.8.0');
  assert.strictEqual(pkg.dependencies.ws, '8.22.1');
});

// ---------------------------------------------------------------------------
// crypto.js
// ---------------------------------------------------------------------------
test('sign and verify round-trip, and a flipped bit fails', () => {
  const { newIdentity, sign, verify } = load('crypto.js');
  const id = newIdentity();
  assert.ok(id.publicKey instanceof Uint8Array);
  assert.ok(id.secretKey instanceof Uint8Array);
  assert.strictEqual(id.publicKey.length, 32);

  const msg = new TextEncoder().encode('hello home');
  const sig = sign(id.secretKey, msg);
  assert.ok(sig instanceof Uint8Array);
  assert.strictEqual(verify(id.publicKey, msg, sig), true);
  assert.strictEqual(verify(id.publicKey, flipBit(msg), sig), false);
  assert.strictEqual(verify(id.publicKey, msg, flipBit(sig)), false);
  assert.strictEqual(verify(flipBit(id.publicKey), msg, sig), false);
  assert.strictEqual(verify(newIdentity().publicKey, msg, sig), false);
});

test('verify returns false on malformed input instead of throwing', () => {
  const { newIdentity, sign, verify } = load('crypto.js');
  const id = newIdentity();
  const msg = new Uint8Array([1, 2, 3]);
  const sig = sign(id.secretKey, msg);
  assert.strictEqual(verify(id.publicKey, msg, sig.subarray(0, 63)), false);
  assert.strictEqual(verify(id.publicKey.subarray(0, 31), msg, sig), false);
  assert.strictEqual(verify(id.publicKey, msg, new Uint8Array(0)), false);
});

test('ephemeral X25519 keys agree, and a low-order peer key is refused', () => {
  const { newEphemeral, sharedSecret } = load('crypto.js');
  const a = newEphemeral();
  const b = newEphemeral();
  assert.ok(a.publicKey instanceof Uint8Array);
  assert.ok(a.secretKey instanceof Uint8Array);
  const ab = sharedSecret(a.secretKey, b.publicKey);
  assert.ok(ab instanceof Uint8Array);
  assert.strictEqual(ab.length, 32);
  assert.strictEqual(hex(ab), hex(sharedSecret(b.secretKey, a.publicKey)));
  assert.notStrictEqual(hex(ab), hex(sharedSecret(a.secretKey, newEphemeral().publicKey)));
  assert.throws(() => sharedSecret(a.secretKey, new Uint8Array(32)));
});

test('hkdf matches RFC 5869 test cases 1 and 3', () => {
  const { hkdf } = load('crypto.js');
  const one = hkdf(
    bytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
    bytes('000102030405060708090a0b0c'),
    bytes('f0f1f2f3f4f5f6f7f8f9'),
    42
  );
  assert.ok(one instanceof Uint8Array);
  assert.strictEqual(
    hex(one),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865'
  );
  // Zero-length salt and info: the case the RFC 9382 key schedule relies on.
  const three = hkdf(
    bytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
    new Uint8Array(0),
    new Uint8Array(0),
    42
  );
  assert.strictEqual(
    hex(three),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8'
  );
});

test('seal and open round-trip, and tampering throws', () => {
  const { seal, open } = load('crypto.js');
  const key = nodeCrypto.randomBytes(32);
  const nonce = nodeCrypto.randomBytes(24);
  const plaintext = new TextEncoder().encode('the home PC secret');
  const aad = new TextEncoder().encode('frame-1');

  const sealed = seal(key, nonce, plaintext, aad);
  assert.ok(sealed instanceof Uint8Array);
  assert.ok(!contains(sealed, plaintext));
  assert.strictEqual(hex(open(key, nonce, sealed, aad)), hex(plaintext));
  assert.strictEqual(hex(open(key, nonce, seal(key, nonce, plaintext))), hex(plaintext));

  assert.throws(() => open(key, nonce, flipBit(sealed), aad));
  assert.throws(() => open(key, nonce, flipBit(sealed, sealed.length - 1), aad));
  assert.throws(() => open(key, nonce, sealed, new TextEncoder().encode('frame-2')));
  assert.throws(() => open(key, flipBit(nonce), sealed, aad));
  assert.throws(() => open(flipBit(key), nonce, sealed, aad));
});

test('seal uses 32-byte keys and 24-byte nonces only', () => {
  const { seal } = load('crypto.js');
  const plaintext = new Uint8Array(4);
  assert.throws(() => seal(new Uint8Array(16), new Uint8Array(24), plaintext));
  assert.throws(() => seal(new Uint8Array(32), new Uint8Array(12), plaintext));
});

test('deviceIdFromPublicKey is 16 lowercase base32 characters of SHA-256', () => {
  const { deviceIdFromPublicKey, newIdentity } = load('crypto.js');
  // Known answer from Python: base64.b32encode(sha256(bytes(32)).digest()).lower()[:16]
  assert.strictEqual(deviceIdFromPublicKey(new Uint8Array(32)), 'mzuhvlpymk6xo3ep');

  const key = newIdentity().publicKey;
  assert.match(deviceIdFromPublicKey(key), /^[a-z2-7]{16}$/);
  assert.strictEqual(deviceIdFromPublicKey(key), deviceIdFromPublicKey(key));
  assert.notStrictEqual(deviceIdFromPublicKey(key), deviceIdFromPublicKey(flipBit(key)));
});

// ---------------------------------------------------------------------------
// pake.js: RFC 9382 conformance
// ---------------------------------------------------------------------------
test('the pasted RFC 9382 appendix holds four complete vectors', () => {
  assert.strictEqual(VECTORS.length, 4);
  assert.deepStrictEqual(
    VECTORS.map((v) => [v.A, v.B]),
    [['server', 'client'], ['', 'client'], ['server', ''], ['', '']]
  );
  for (const v of VECTORS) {
    for (const field of ['w', 'x', 'pa', 'y', 'pb', 'k', 'tt', 'hash(tt)', 'ke', 'ka', 'kca', 'kcb', 'a conf', 'b conf']) {
      assert.ok(v[field], `missing ${field}`);
    }
  }
});

for (const [index, v] of VECTORS.entries()) {
  const label = `RFC 9382 Appendix B vector ${index + 1} (A='${v.A}', B='${v.B}')`;
  const common = { w: BigInt('0x' + v.w), idA: v.A, idB: v.B, aad: '' };

  const assertSchedule = (result) => {
    assert.strictEqual(hex(result.K), v.k);
    assert.strictEqual(hex(result.transcript), v.tt);
    assert.strictEqual(hex(result.Ke) + hex(result.Ka), v['hash(tt)']);
    assert.strictEqual(hex(result.Ke), v.ke);
    assert.strictEqual(hex(result.Ka), v.ka);
    assert.strictEqual(hex(result.KcA), v.kca);
    assert.strictEqual(hex(result.KcB), v.kcb);
    assert.strictEqual(hex(result.confirmA), v['a conf']);
    assert.strictEqual(hex(result.confirmB), v['b conf']);
    assert.strictEqual(hex(result.sharedKey), v.ke);
  };

  test(`${label}, as A`, () => {
    const { spake2ForTest } = load('pake.js');
    const side = spake2ForTest({ ...common, x: BigInt('0x' + v.x), role: 'home' });
    assert.strictEqual(hex(side.message), v.pa);
    const result = side.finish(bytes(v.pb));
    assertSchedule(result);
    assert.strictEqual(hex(result.confirmMessage), v['a conf']);
    assert.strictEqual(result.verifyConfirm(bytes(v['b conf'])), true);
    assert.strictEqual(result.verifyConfirm(bytes(v['a conf'])), false);
  });

  test(`${label}, as B`, () => {
    const { spake2ForTest } = load('pake.js');
    const side = spake2ForTest({ ...common, x: BigInt('0x' + v.y), role: 'laptop' });
    assert.strictEqual(hex(side.message), v.pb);
    const result = side.finish(bytes(v.pa));
    assertSchedule(result);
    assert.strictEqual(hex(result.confirmMessage), v['b conf']);
    assert.strictEqual(result.verifyConfirm(bytes(v['a conf'])), true);
    assert.strictEqual(result.verifyConfirm(bytes(v['b conf'])), false);
  });
}

test('M and N in the code equal the RFC values', () => {
  const { M, N } = load('pake.js');
  assert.strictEqual(M, RFC_M);
  assert.strictEqual(N, RFC_N);
});

test('the RFC M and N regenerate from their seeds by the Appendix A algorithm', () => {
  // Proves the constants pasted above carry no transcription error.
  const { sha256 } = require('@noble/hashes/sha2');
  const generate = (seedText) => {
    const blocks = [sha256(new TextEncoder().encode(seedText))];
    for (let i = 0; i < 1000; i++) {
      blocks.push(sha256(blocks[i]));
      const candidate = Buffer.concat([blocks[i], blocks[i + 1]]).subarray(0, 33);
      candidate[0] = (candidate[0] & 1) | 2;
      try {
        Point.fromHex(candidate.toString('hex'));
        return candidate.toString('hex');
      } catch { /* not on the curve, take the next block */ }
    }
    throw new Error('no point found');
  };
  assert.strictEqual(generate(RFC_M_SEED), RFC_M);
  assert.strictEqual(generate(RFC_N_SEED), RFC_N);
});

test('AAD reaches KcA and KcB through HKDF info, and leaves Ke alone', () => {
  // The RFC's vectors all use an empty AAD, so this path needs its own check.
  // node:crypto's HKDF is the independent reference.
  const { spake2ForTest } = load('pake.js');
  const v = VECTORS[0];
  const run = (aad) => spake2ForTest({
    w: BigInt('0x' + v.w), x: BigInt('0x' + v.x), role: 'home', idA: v.A, idB: v.B, aad
  }).finish(bytes(v.pb));

  const plain = run('');
  const withAad = run('sanctum-pairing-v1');
  assert.strictEqual(hex(withAad.Ke), v.ke);
  assert.strictEqual(hex(withAad.Ka), v.ka);

  const expected = Buffer.from(nodeCrypto.hkdfSync(
    'sha256', bytes(v.ka), new Uint8Array(0), 'ConfirmationKeyssanctum-pairing-v1', 32
  ));
  assert.strictEqual(hex(withAad.KcA) + hex(withAad.KcB), expected.toString('hex'));
  assert.notStrictEqual(hex(withAad.KcA), hex(plain.KcA));
  assert.notStrictEqual(hex(withAad.confirmA), hex(plain.confirmA));
});

test('the transcript pads a small w to the full 32 bytes, big-endian', () => {
  // Every w in the RFC's vectors starts with a nonzero byte, so they don't cover
  // the padding the RFC requires.
  const { spake2ForTest } = load('pake.js');
  const { transcript } = spake2ForTest({ w: 5n, x: 7n, role: 'home', idA: 'a', idB: 'b', aad: '' })
    .finish(Point.BASE.multiply(11n).toBytes(false));
  const expected = '2000000000000000' + '00'.repeat(31) + '05';
  assert.strictEqual(hex(transcript.subarray(transcript.length - 40)), expected);
});

test('spake2ForTest refuses a zero or out-of-range w or x', () => {
  const { spake2ForTest } = load('pake.js');
  const base = { w: 5n, x: 7n, role: 'home', idA: 'a', idB: 'b', aad: '' };
  assert.throws(() => spake2ForTest({ ...base, w: 0n }), /w must be/);
  assert.throws(() => spake2ForTest({ ...base, w: ORDER }), /w must be/);
  assert.throws(() => spake2ForTest({ ...base, x: 0n }), /secret scalar/);
  assert.throws(() => spake2ForTest({ ...base, x: ORDER }), /secret scalar/);
});

// ---------------------------------------------------------------------------
// pake.js: the production entry point
// ---------------------------------------------------------------------------
test('pakeStart uses the fixed scrypt settings, identities and AAD', () => {
  const { pakeStart, spake2ForTest } = load('pake.js');
  const code = 'K7M2QX';

  const reference = spake2ForTest({
    w: expectedW(code),
    x: 0x1234567890abcdefn,
    role: 'laptop',
    idA: 'sanctum-home',
    idB: 'sanctum-laptop',
    aad: 'sanctum-pairing-v1'
  });
  const home = pakeStart(code, 'home');
  const homeResult = home.finish(reference.message);
  const referenceResult = reference.finish(home.message);

  assert.strictEqual(hex(homeResult.sharedKey), hex(referenceResult.sharedKey));
  assert.strictEqual(homeResult.verifyConfirm(referenceResult.confirmMessage), true);
  assert.strictEqual(referenceResult.verifyConfirm(homeResult.confirmMessage), true);
});

test('the same code on both roles gives an equal key and accepted confirmations', () => {
  const { pakeStart } = load('pake.js');
  const home = pakeStart('K7M2QX', 'home');
  const laptop = pakeStart('K7M2QX', 'laptop');
  assert.ok(home.message instanceof Uint8Array);
  assert.strictEqual(home.message.length, 65);
  assert.strictEqual(home.message[0], 0x04);

  const homeResult = home.finish(laptop.message);
  const laptopResult = laptop.finish(home.message);

  assert.ok(homeResult.sharedKey instanceof Uint8Array);
  assert.strictEqual(homeResult.sharedKey.length, 16); // RFC 9382: |Ke| is half of SHA-256
  assert.strictEqual(hex(homeResult.sharedKey), hex(laptopResult.sharedKey));
  assert.ok(homeResult.confirmMessage instanceof Uint8Array);
  assert.strictEqual(homeResult.confirmMessage.length, 32);
  assert.strictEqual(homeResult.verifyConfirm(laptopResult.confirmMessage), true);
  assert.strictEqual(laptopResult.verifyConfirm(homeResult.confirmMessage), true);
});

test('the production result exposes only the agreed fields', () => {
  const { pakeStart } = load('pake.js');
  const home = pakeStart('K7M2QX', 'home');
  const laptop = pakeStart('K7M2QX', 'laptop');
  assert.deepStrictEqual(Object.keys(home).sort(), ['finish', 'message']);
  assert.deepStrictEqual(
    Object.keys(home.finish(laptop.message)).sort(),
    ['confirmMessage', 'sharedKey', 'verifyConfirm']
  );
});

test('different codes give unequal keys, and verifyConfirm is false on both sides', () => {
  const { pakeStart } = load('pake.js');
  const home = pakeStart('K7M2QX', 'home');
  const laptop = pakeStart('K7M2QY', 'laptop');
  const homeResult = home.finish(laptop.message);
  const laptopResult = laptop.finish(home.message);
  assert.notStrictEqual(hex(homeResult.sharedKey), hex(laptopResult.sharedKey));
  assert.strictEqual(homeResult.verifyConfirm(laptopResult.confirmMessage), false);
  assert.strictEqual(laptopResult.verifyConfirm(homeResult.confirmMessage), false);
});

test('two sides on the same role do not agree', () => {
  const { pakeStart } = load('pake.js');
  const one = pakeStart('K7M2QX', 'home');
  const two = pakeStart('K7M2QX', 'home');
  const oneResult = one.finish(two.message);
  const twoResult = two.finish(one.message);
  assert.notStrictEqual(hex(oneResult.sharedKey), hex(twoResult.sharedKey));
  assert.strictEqual(oneResult.verifyConfirm(twoResult.confirmMessage), false);
});

test('finish throws on the identity, off-curve points, and wrong-length bytes', () => {
  const { spake2ForTest } = load('pake.js');
  const start = () => spake2ForTest({ w: 5n, x: 7n, role: 'home', idA: 'a', idB: 'b', aad: '' });
  const valid = Point.BASE.multiply(11n);
  const encoded = valid.toBytes(false);

  // Control: the base message is accepted, so each rejection below is caused by
  // its own tampering.
  assert.doesNotThrow(() => start().finish(encoded));
  assert.doesNotThrow(() => start().finish(Buffer.from(encoded)));

  const offCurve = new Uint8Array(encoded);
  offCurve[64] ^= 0x01;

  const hybrid = new Uint8Array(encoded);
  hybrid[0] = 0x06 | (encoded[64] & 1);

  const cases = {
    'all-zero uncompressed identity': bytes('04' + '00'.repeat(64)),
    'SEC1 identity byte': new Uint8Array([0x00]),
    'off-curve point': offCurve,
    'empty': new Uint8Array(0),
    '64 bytes': encoded.subarray(0, 64),
    '66 bytes': new Uint8Array([...encoded, 0]),
    'compressed encoding of a valid point': valid.toBytes(true),
    'hybrid encoding of a valid point': hybrid
  };
  for (const [name, message] of Object.entries(cases)) {
    assert.throws(() => start().finish(message), undefined, name);
  }
  for (const notBytes of [undefined, null, 'abc', hex(encoded), Array.from(encoded)]) {
    assert.throws(() => start().finish(notBytes));
  }
});

test('finish throws on a coordinate that is not reduced modulo the field prime', () => {
  const { spake2ForTest } = load('pake.js');
  const start = () => spake2ForTest({ w: 5n, x: 7n, role: 'home', idA: 'a', idB: 'b', aad: '' });
  const point = pointWithSmallX();
  const { x, y } = point.toAffine();
  const encode = (xValue) => bytes(
    '04' + xValue.toString(16).padStart(64, '0') + y.toString(16).padStart(64, '0')
  );
  assert.doesNotThrow(() => start().finish(encode(x)));
  assert.throws(() => start().finish(encode(x + FIELD)));
});

test('finish throws when the peer point is the identity after the mask is removed', () => {
  const { spake2ForTest, pakeStart, M, N } = load('pake.js');
  const w = 5n;
  const mPoint = Point.fromHex(M);
  const nPoint = Point.fromHex(N);

  const asHome = spake2ForTest({ w, x: 7n, role: 'home', idA: 'a', idB: 'b', aad: '' });
  assert.throws(() => asHome.finish(nPoint.multiply(w).toBytes(false)), /identity/);

  const asLaptop = spake2ForTest({ w, x: 7n, role: 'laptop', idA: 'a', idB: 'b', aad: '' });
  assert.throws(() => asLaptop.finish(mPoint.multiply(w).toBytes(false)), /identity/);

  // And through the production path, with the real derivation of w.
  const code = 'K7M2QX';
  const realW = expectedW(code);
  assert.throws(() => pakeStart(code, 'home').finish(nPoint.multiply(realW).toBytes(false)), /identity/);
  assert.throws(() => pakeStart(code, 'laptop').finish(mPoint.multiply(realW).toBytes(false)), /identity/);
});

test('verifyConfirm returns false for tampered or malformed confirmations', () => {
  const { pakeStart } = load('pake.js');
  const home = pakeStart('K7M2QX', 'home');
  const laptop = pakeStart('K7M2QX', 'laptop');
  const homeResult = home.finish(laptop.message);
  const laptopResult = laptop.finish(home.message);
  const good = laptopResult.confirmMessage;

  assert.strictEqual(homeResult.verifyConfirm(flipBit(good)), false);
  assert.strictEqual(homeResult.verifyConfirm(flipBit(good, good.length - 1)), false);
  assert.strictEqual(homeResult.verifyConfirm(good.subarray(0, 31)), false);
  assert.strictEqual(homeResult.verifyConfirm(new Uint8Array(0)), false);
  assert.strictEqual(homeResult.verifyConfirm(new Uint8Array([...good, 0])), false);
  assert.strictEqual(homeResult.verifyConfirm(undefined), false);
  assert.strictEqual(homeResult.verifyConfirm(hex(good)), false);
  // A side's own confirmation reflected back at it is not the peer's.
  assert.strictEqual(homeResult.verifyConfirm(homeResult.confirmMessage), false);
  // The real one still passes, so the checks above held no state.
  assert.strictEqual(homeResult.verifyConfirm(good), true);
  assert.strictEqual(homeResult.verifyConfirm(Buffer.from(good)), true);
});

test('a pakeStart secret is used for one exchange only', () => {
  // RFC 9382 Section 7: x and y MUST NOT be reused, and an endpoint MUST abort
  // on an invalid public value.
  const { pakeStart } = load('pake.js');
  const home = pakeStart('K7M2QX', 'home');
  const laptop = pakeStart('K7M2QX', 'laptop');
  home.finish(laptop.message);
  assert.throws(() => home.finish(laptop.message));

  const aborted = pakeStart('K7M2QX', 'home');
  assert.throws(() => aborted.finish(new Uint8Array(65)));
  assert.throws(() => aborted.finish(laptop.message));
});

test('no message contains the code or an unsalted hash of it', () => {
  const { pakeStart } = load('pake.js');
  const code = 'K7M2QX';
  const sha256 = nodeCrypto.createHash('sha256').update(code).digest();
  const sha512 = nodeCrypto.createHash('sha512').update(code).digest();
  for (const role of ['home', 'laptop']) {
    const { message } = pakeStart(code, role);
    assert.ok(!contains(message, code));
    assert.ok(!contains(message, code.toLowerCase()));
    assert.ok(!contains(message, sha256));
    assert.ok(!contains(message, sha256.subarray(0, 16)));
    assert.ok(!contains(message, sha512.subarray(0, 32)));
    assert.ok(!Buffer.from(message).toString('hex').includes(sha256.toString('hex')));
  }
});

test('two pakeStart calls with one code give different messages', () => {
  const { pakeStart } = load('pake.js');
  assert.notStrictEqual(hex(pakeStart('K7M2QX', 'home').message), hex(pakeStart('K7M2QX', 'home').message));
  assert.notStrictEqual(hex(pakeStart('K7M2QX', 'laptop').message), hex(pakeStart('K7M2QX', 'laptop').message));
});

test('pakeStart refuses an unknown role or an empty code', () => {
  const { pakeStart } = load('pake.js');
  assert.throws(() => pakeStart('K7M2QX', 'server'));
  assert.throws(() => pakeStart('K7M2QX', undefined));
  assert.throws(() => pakeStart('', 'home'));
  assert.throws(() => pakeStart(undefined, 'home'));
});
