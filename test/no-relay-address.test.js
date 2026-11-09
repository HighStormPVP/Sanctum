// The relay's address holds its secret, and neither may ever be in the repo or in a build: public
// installs must not reach the owner's Cloudflare account. This reads every tracked file, and every
// file package.json's build.files would pack apart from node_modules, tracked or not.
//
// Docs may write the address in one form only, PLACEHOLDER_ADDRESS below, and nothing else that
// names a workers.dev host. Anything shaped like the secret relay/README.md tells the owner to
// make, 32 random bytes in URL-safe base64, is refused wherever it appears.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const PLACEHOLDER_HOST = 'sanctum-relay.<your-subdomain>.workers.dev';
const PLACEHOLDER_SECRET = '<your-secret>';
const PLACEHOLDER_ADDRESS = `wss://${PLACEHOLDER_HOST}/${PLACEHOLDER_SECRET}`;
const WORKERS_DEV = ['.workers', 'dev'].join('.'); // in pieces, or this line would be a finding

// Hosts a wss address may name: the placeholder, this machine, and names kept for examples. No
// host at all, as in prose about the scheme, and a host code builds from a variable name nothing.
// A literal workers.dev host inside code is still caught by the first rule below.
function allowedHost(host) {
  if (host === PLACEHOLDER_HOST || host === '' || host.startsWith('${')) return true;
  // Without any user part, and without a port, or a port code fills in.
  const bare = host.replace(/^[^@]*@/, '').toLowerCase();
  // A bracketed IPv6 host may arrive without its ], which ends a host in the pattern below.
  const name = bare.startsWith('[') ? bare.replace(/^\[([^\]]*)\]?.*$/, '[$1]') : bare.replace(/:.*$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.example');
}

// Shown in a failure without giving the value away, since a failure ends up in logs.
const masked = (value) => `${value.slice(0, 4)}... (${value.length} characters)`;

// Every finding in a text, as { index, kind, value }.
function findingsIn(text) {
  const found = [];

  // A workers.dev host, other than the placeholder. "workers.dev" on its own names no address.
  for (const m of text.matchAll(/\.workers\.dev/gi)) {
    const start = m.index + WORKERS_DEV.length - PLACEHOLDER_HOST.length;
    const host = text.slice(Math.max(0, start), m.index + WORKERS_DEV.length);
    if (host !== PLACEHOLDER_HOST) found.push({ index: m.index, kind: 'a workers.dev address', value: host });
  }

  // A ws or wss address anywhere else. On the placeholder host, the path is exactly the
  // placeholder secret, or nothing.
  for (const m of text.matchAll(/wss?:\/\/([^\s/"'`)\]]*)(\/[^\s"'`)\]]*)?/gi)) {
    const [, host, rest = ''] = m;
    if (!allowedHost(host)) found.push({ index: m.index, kind: 'a wss address', value: host });
    else if (host === PLACEHOLDER_HOST && rest !== '' && rest !== `/${PLACEHOLDER_SECRET}`) {
      found.push({ index: m.index, kind: 'a secret in the placeholder address', value: rest });
    }
  }

  // 32 bytes in URL-safe base64: any 43 characters in a run of the URL-safe alphabet, so one glued
  // to something is found too, in mixed case with a digit, - or _, as random is and long names
  // aren't. Each is judged by its own span, so nothing before it excuses it. The one excuse is
  // being part of a complete standard base64 value, such as a lockfile's hash: a run of the
  // standard alphabet with = or == right after, a whole number of 4-character groups long. That
  // can't hold a - or _, and = ends a run, so `RELAY_SECRET=` before a secret doesn't join it.
  const paddedBase64 = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/]+(={1,2})/g)) {
    if (m[0].length % 4 === 0) paddedBase64.push([m.index, m.index + m[0].length - m[1].length]);
  }
  // A subresource-integrity hash, as npm's lockfiles hold, counts as a whole, prefix and all, when
  // its base64 is exactly that digest's length.
  const DIGEST_BYTES = { 1: 20, 256: 32, 384: 48, 512: 64 };
  for (const m of text.matchAll(/sha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})/g)) {
    if (m[2].length % 4 === 0 && Buffer.from(m[2], 'base64').length === DIGEST_BYTES[m[1]]) paddedBase64.push([m.index, m.index + m[0].length]);
  }
  const insidePadded = (start, end) => paddedBase64.some(([from, to]) => start >= from && end <= to);
  for (const m of text.matchAll(/[A-Za-z0-9_-]{43,}/g)) {
    for (let i = 0; i + 43 <= m[0].length; i += 1) {
      const token = m[0].slice(i, i + 43);
      if (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/[0-9_-]/.test(token)) continue;
      if (insidePadded(m.index + i, m.index + i + 43)) continue;
      found.push({ index: m.index + i, kind: 'a 32-byte secret', value: token });
      break; // one finding per run
    }
  }

  // ACCESS_SECRET given anything, anywhere on a line: in code, JSON, TOML, YAML, a .dev.vars file,
  // or a shell's export, set, or $env:. Nothing at all, the placeholder, and the test files' SECRET
  // constant, unquoted, are the only values allowed.
  for (const m of text.matchAll(/ACCESS_SECRET["'`]?[ \t]*[:=][ \t]*(?:(["'`])(.*?)\1|([^\s"'`,;)}\]]*))/g)) {
    const value = m[1] ? m[2] : m[3];
    const allowed = value === '' || value === PLACEHOLDER_SECRET || (!m[1] && value === 'SECRET');
    if (!allowed) found.push({ index: m.index, kind: 'an ACCESS_SECRET value', value });
  }
  return found;
}

// A file's bytes as text: as they are, and as UTF-16 when they look like it, by a byte-order mark
// or by every other byte being NUL. Each of those also percent-decoded, and with JSON's \/ made /,
// since an address can be stored either way.
function textsOf(bytes) {
  const texts = [bytes.toString('latin1')];
  const head = bytes.subarray(0, 4096);
  const nulsAt = (parity) => {
    let nuls = 0;
    for (let i = parity; i < head.length; i += 2) if (head[i] === 0) nuls += 1;
    return nuls / Math.max(1, Math.floor(head.length / 2));
  };
  if ((head[0] === 0xff && head[1] === 0xfe) || (nulsAt(1) > 0.4 && nulsAt(0) < 0.05)) texts.push(bytes.toString('utf16le'));
  else if ((head[0] === 0xfe && head[1] === 0xff) || (nulsAt(0) > 0.4 && nulsAt(1) < 0.05)) {
    const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
    texts.push(Buffer.from(even).swap16().toString('utf16le'));
  }
  const decoded = texts.map((t) => t.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\\//g, '/'));
  return [...texts, ...decoded.filter((t, i) => t !== texts[i])];
}

// Every finding in every text of a file, once each.
function findingsInBytes(bytes) {
  const seen = new Set();
  const found = [];
  for (const text of textsOf(bytes)) {
    for (const f of findingsIn(text)) {
      const key = `${f.kind}\0${f.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...f, line: text.slice(0, f.index).split('\n').length });
    }
  }
  return found;
}

// What git tracks, and what it would add: new files that aren't ignored.
function repoFiles(root) {
  const list = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return [...new Set([...list(), ...list('--others', '--exclude-standard')])];
}

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

// What electron-builder would pack, from the patterns this repo uses. A pattern of any other shape
// fails here rather than being skipped. Exclusions only make the set smaller, so they're ignored.
function packedFiles() {
  const { files } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build;
  const found = [];
  for (const pattern of files) {
    if (pattern.startsWith('!') || pattern === 'node_modules/**/*') continue;
    const dir = pattern.match(/^([\w.-]+(?:\/[\w.-]+)*)\/\*\*\/\*$/);
    if (dir) found.push(...walk(dir[1]));
    else if (/^[\w.-]+(?:\/[\w.-]+)*$/.test(pattern)) found.push(pattern);
    else assert.fail(`build.files has a pattern this test can't read: ${pattern}`);
  }
  return found;
}

// Strings in real files that look random to the rules above and aren't, each exact and in its one
// file. A test below checks each is still where it says, and would be a finding without this.
const EXCEPTIONS = [
  // In pieces, or this file would hold it too.
  { file: 'e2e/direct.e2e.js', text: ['CANARY', 'chat-text-that-must-only-cross-sealed'].join('-') }
];
// The TLS test fixtures are base64 throughout, so every line looks random. A file there is
// excused from the secret rule only while it is nothing but PEM blocks, and each block is a real
// certificate or key that parses: a line slipped into one breaks its DER, so it can't hide there.
// Addresses are still checked.
const PEM_FIXTURE = /^test\/fixtures\/tls\/[\w-]+\.pem$/;
const ONLY_PEM = /^(?:-----BEGIN (CERTIFICATE|PRIVATE KEY)-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END \1-----\r?\n?)+$/;
const PEM_BLOCK = /-----BEGIN (CERTIFICATE|PRIVATE KEY)-----[\s\S]+?-----END \1-----/g;
function pemParses(text) {
  const blocks = [...text.matchAll(PEM_BLOCK)];
  if (!blocks.length) return false;
  try {
    for (const [block, kind] of blocks) {
      if (kind === 'CERTIFICATE') new crypto.X509Certificate(block);
      else crypto.createPrivateKey(block);
    }
    return true;
  } catch {
    return false;
  }
}
const pemOnly = (text) => ONLY_PEM.test(text) && pemParses(text);
const onlyPem = (rel) => PEM_FIXTURE.test(rel) && pemOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const excused = (rel, f) => (f.kind === 'a 32-byte secret' && onlyPem(rel))
  || EXCEPTIONS.some((e) => e.file === rel && f.kind === 'a 32-byte secret' && e.text.includes(f.value));

function scan(files) {
  const problems = [];
  for (const rel of new Set(files)) {
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(ROOT, rel));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // tracked, but deleted in this checkout
      throw err;
    }
    for (const f of findingsInBytes(bytes)) if (!excused(rel, f)) problems.push(`${rel}:${f.line}: ${f.kind}: ${masked(f.value)}`);
  }
  return problems;
}

// ---- The rules, on known cases ----

// Made here, so this file holds none of them as they'd appear.
const realHost = `sanctum-relay.someone${WORKERS_DEV}`;
const realSecret = () => crypto.randomBytes(32).toString('base64url');
const assignment = (rest) => `ACCESS_${'SECRET'}${rest}`;

test('a real-looking address, secret, or secret setting is found', () => {
  const kinds = (text) => findingsIn(text).map((f) => f.kind);
  for (let i = 0; i < 50; i++) {
    const secret = realSecret();
    if (!/[A-Z]/.test(secret) || !/[a-z]/.test(secret)) continue;
    assert.ok(kinds(`wss://${realHost}/${secret}`).includes('a 32-byte secret'));
    assert.ok(kinds(`  secret: ${secret}\n`).includes('a 32-byte secret'));
    assert.ok(kinds(`"${secret}"`).includes('a 32-byte secret'));
  }
  assert.deepEqual(kinds(`wss://${realHost}/x`), ['a workers.dev address', 'a wss address']);
  assert.deepEqual(kinds(`https://other.someone${WORKERS_DEV}/`), ['a workers.dev address']);
  assert.deepEqual(kinds(`SANCTUM-RELAY.SOMEONE${WORKERS_DEV.toUpperCase()}`), ['a workers.dev address']);
  assert.deepEqual(kinds(`wss://${['relay', 'my-domain', 'com'].join('.')}/abc`), ['a wss address']);
  assert.deepEqual(kinds(`wss://${PLACEHOLDER_HOST}/abc`), ['a secret in the placeholder address']);
  assert.deepEqual(kinds(assignment(' = "hunter2"')), ['an ACCESS_SECRET value']);
  assert.deepEqual(kinds(`{ ${assignment(": 'hunter2'")} }`), ['an ACCESS_SECRET value']);
  assert.deepEqual(kinds(`{ "${assignment('": "hunter2"')} }`), ['an ACCESS_SECRET value']);
  assert.deepEqual(kinds(`[vars]\n${assignment('=hunter2')}\n`), ['an ACCESS_SECRET value']);
});

// A secret that standard base64 could never hold, since it has a - or _. Without one, `<secret>=`
// is exactly 32 bytes of standard base64, which the next test has to let through.
function urlSafeSecret() {
  for (;;) {
    const secret = realSecret();
    if (/[A-Z]/.test(secret) && /[a-z]/.test(secret) && /[-_]/.test(secret)) return secret;
  }
}

test('the shapes the first review found are found', () => {
  const kinds = (text) => findingsInBytes(Buffer.from(text, 'utf8')).map((f) => f.kind);
  const has = (text, kind) => assert.ok(kinds(text).includes(kind), `${kind} in ${text.slice(0, 60)}: ${JSON.stringify(kinds(text))}`);
  const otherHost = ['relay', 'mydomain', 'com'].join('.');
  for (let i = 0; i < 30; i++) {
    const secret = urlSafeSecret();
    has(`RELAY_SECRET=${secret}`, 'a 32-byte secret');
    has(`export ${assignment(`=${secret}`)}`, 'a 32-byte secret');
    has(`https://${otherHost}/?key=${secret}`, 'a 32-byte secret');
    has(`https://${otherHost}/${secret}`, 'a 32-byte secret');
    has(`${secret}=`, 'a 32-byte secret');
    has(`"x"+"${secret}"`, 'a 32-byte secret');
    // A hash's prefix with a secret after it is no hash.
    has(`sha512-${secret}`, 'a 32-byte secret');
    has(`sha256-${secret}=`, 'a 32-byte secret');
    // Glued to something, so the run is longer than the secret.
    has(`key${secret}`, 'a 32-byte secret');
    has(`${secret}${secret.slice(0, 10)}`, 'a 32-byte secret');
    // Percent-encoded, and escaped as JSON.
    const encoded = encodeURIComponent(`wss://${otherHost}/${secret}`);
    has(encoded, 'a wss address');
    has(encoded, 'a 32-byte secret');
    has(JSON.stringify({ address: `wss://${otherHost}/${secret}` }).replace(/\//g, '\\/'), 'a wss address');
    // Text after the placeholder's secret.
    has(`wss://${PLACEHOLDER_HOST}/${PLACEHOLDER_SECRET}${secret.slice(0, 10)}`, 'a secret in the placeholder address');
  }
  has(`wss://${PLACEHOLDER_HOST}/${PLACEHOLDER_SECRET}/more`, 'a secret in the placeholder address');
  // A hash's prefix before a secret with no - or _: its base64 is the wrong length for that hash,
  // so the prefix doesn't make it one.
  for (let i = 0; i < 30; i++) {
    let plain;
    do plain = realSecret(); while (/[-_]/.test(plain) || !/[A-Z]/.test(plain) || !/[a-z]/.test(plain));
    has(`sha1-${plain}=`, 'a 32-byte secret');
    has(`sha512-${plain}=`, 'a 32-byte secret');
  }
  has(`WSS://${otherHost}/abc`, 'a wss address');
  has(`ws://${otherHost}/abc`, 'a wss address');
  // ACCESS_SECRET given anything, however it's written.
  for (const form of [
    assignment('=hunter2'),
    `export ${assignment('=hunter2')}`,
    `set ${assignment('=hunter2')}`,
    `$env:${assignment(' = "hunter2"')}`,
    `$env:${assignment('="hunter2"')}`,
    `  ${assignment(': hunter2')}`,
    `${assignment(": 'hunter2'")}`,
    `x; ${assignment(' = hunter2')} # later on a line`,
    `{ ${assignment(': process.env.SOMETHING')} }`
  ]) {
    has(form, 'an ACCESS_SECRET value');
  }
});

test('the placeholder, examples, and test secrets are not', () => {
  for (const text of [
    PLACEHOLDER_ADDRESS,
    `Paste ${PLACEHOLDER_ADDRESS} into Settings.`,
    `(\`${PLACEHOLDER_ADDRESS}\`)`,
    `https://${PLACEHOLDER_HOST}`,
    "Cloudflare gives every account a workers.dev subdomain.",
    'wss://relay.example/secret-part-of-the-address',
    'wss://u:p@relay.example/abc',
    'Put together `wss://`, the host, and the secret.',
    'const address = `wss://${url.host}/${secret}`;',
    'ws://127.0.0.1:8787/test-secret-not-a-real-one-0123456789',
    `bindings: { ${assignment(': SECRET')} }`,
    `bindings: { ${assignment(": ''")} }`,
    `npx wrangler secret put ${assignment('')}`,
    `${assignment('=')}`,
    `${assignment(`=${PLACEHOLDER_SECRET}`)}`,
    `the \`${assignment('`')} Worker secret`,
    // Long names, with digits or not, that aren't random.
    'remoteDeviceListFingerprintHelpTextForTheSettingsPanel',
    'remote-device-list-fingerprint-help-text-for-the-settings-panel',
    'THE_LONGEST_CONSTANT_NAME_IN_THE_WHOLE_OF_SANCTUM',
    // npm's integrity hashes, of every kind it writes.
    ...[['sha1', 20], ['sha256', 32], ['sha384', 48], ['sha512', 64]].map(([name, bytes]) => `"integrity": "${name}-${crypto.randomBytes(bytes).toString('base64')}"`),
    // Loopback, with a port or one code fills in.
    'ws://127.0.0.1:${server.address().port}${target.pathname}',
    "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
    // Long standard base64, padded, as a data URL or a key would be.
    `data:image/png;base64,${crypto.randomBytes(301).toString('base64')}`,
    // A lockfile's hash, and a hex digest of 32 bytes.
    'sha512-0ZYGXZMBFDSnGNp4HJY0RuuH+D27pnfFmTqNpUA6Ylu0AW7ffPDOs82ci4k9DtcmHcmnSU9tO8pkkGmsNXxCWA==',
    crypto.randomBytes(32).toString('hex'),
    // 32 bytes in standard base64, as a key in a test would be.
    crypto.randomBytes(32).toString('base64')
  ]) {
    assert.deepEqual(findingsIn(text), [], text);
  }
});

test('the packed set is read the way electron-builder would read it', () => {
  const packed = packedFiles();
  for (const file of ['main.js', 'preload.js', 'renderer.js', 'package.json', 'lib/window-rules.js', 'lib/remote/manager.js']) {
    assert.ok(packed.includes(file), file);
  }
  assert.ok(packed.some((file) => file.startsWith('assets/')), 'assets are walked');
  assert.ok(!packed.some((file) => file.startsWith('node_modules/')));
});

test('a UTF-16 file is read as text, with a byte-order mark or without', () => {
  const secret = urlSafeSecret();
  const text = `wss://${realHost}/${secret}\n`;
  for (const bytes of [
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
    Buffer.from(text, 'utf16le'),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    Buffer.from(text, 'utf16le').swap16()
  ]) {
    const kinds = findingsInBytes(bytes).map((f) => f.kind);
    for (const kind of ['a workers.dev address', 'a 32-byte secret']) assert.ok(kinds.includes(kind), `${kind}: ${JSON.stringify(kinds)}`);
  }
  // And an ordinary file isn't taken for UTF-16.
  assert.deepEqual(findingsInBytes(Buffer.from('plain text, nothing here\n')), []);
});

test('files git would add are read, and ignored ones are not', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sanctum-scan-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'x');
    git('add', '.gitignore', 'tracked.txt');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x');
    assert.deepEqual(repoFiles(dir).sort(), ['.gitignore', 'new.txt', 'tracked.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the relay's config keeps request logging off, since the secret is in every URL", () => {
  const toml = fs.readFileSync(path.join(ROOT, 'relay', 'wrangler.toml'), 'utf8').replace(/\r\n/g, '\n');
  const lines = toml.split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
  const section = lines.indexOf('[observability]');
  assert.ok(section >= 0, 'there is an [observability] section');
  const body = lines.slice(section + 1, lines.findIndex((line, i) => i > section && line.startsWith('[')) >>> 0);
  assert.ok(body.includes('enabled = false'), 'and it says enabled = false');
  assert.ok(!lines.some((line) => /^enabled\s*=\s*true$/.test(line)), 'nothing turns any of it on');
  assert.ok(!lines.some((line) => /^\[observability\./.test(line)), 'no part of it is set apart');
  assert.ok(!lines.some((line) => /logpush|tail_consumers/.test(line)), 'no Logpush or tail Worker');
});

test('each exception is still in its file, and only it keeps that string from being a finding', () => {
  for (const { file, text } of EXCEPTIONS) {
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(text), `${file} still has ${text}`);
    const found = findingsIn(text);
    assert.ok(found.length > 0 && found.every((f) => excused(file, f)), `${text} is a finding, and excused only in ${file}`);
    assert.ok(!found.some((f) => excused('some/other/file.js', f)), 'and nowhere else');
  }
});

// ---- The repo, and a build ----

test('no file in the repo, tracked or about to be, holds a relay address or secret', () => {
  const files = repoFiles(ROOT);
  assert.ok(files.includes('relay/wrangler.toml') && files.includes('relay/README.md'), 'the relay and its runbook are read');
  assert.deepEqual(scan(files), []);
});

test('nothing a build would pack holds a relay address or secret', () => {
  assert.deepEqual(scan(packedFiles()), []);
});

test('the TLS fixtures are excused only while they are nothing but certificate and key blocks', () => {
  const fixtures = fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'tls')).map((name) => `test/fixtures/tls/${name}`);
  assert.deepEqual(fixtures.sort(), ['test/fixtures/tls/ca.pem', 'test/fixtures/tls/server-key.pem', 'test/fixtures/tls/server.pem']);
  for (const rel of fixtures) assert.ok(onlyPem(rel), rel);
  // A line added to one of them, or the same text anywhere else, isn't excused.
  const pem = fs.readFileSync(path.join(ROOT, 'test/fixtures/tls/ca.pem'), 'utf8');
  assert.equal(pemOnly(`${pem}secret: ${crypto.randomBytes(32).toString('base64url')}\n`), false);
  // A secret with no - or _ fits a base64 line; slipped inside a block, the block stops parsing.
  let secret;
  do secret = crypto.randomBytes(32).toString('base64url'); while (/[-_]/.test(secret));
  const lines = pem.replace(/\r\n/g, '\n').split('\n');
  lines.splice(3, 0, secret);
  assert.equal(ONLY_PEM.test(lines.join('\n')), true, 'the shape alone would let it through');
  assert.equal(pemOnly(lines.join('\n')), false, 'but it no longer parses');
  assert.equal(PEM_FIXTURE.test('lib/remote/ca.pem'), false);
  assert.equal(PEM_FIXTURE.test('test/fixtures/tls/../../x.pem'), false);
});
