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
  const name = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
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

  // A wss address anywhere else. On the placeholder host, the secret is the placeholder too.
  for (const m of text.matchAll(/wss:\/\/([^\s/"'`)\]]*)(\/[^\s"'`)\]]*)?/gi)) {
    const [, host, rest = ''] = m;
    if (!allowedHost(host)) found.push({ index: m.index, kind: 'a wss address', value: host });
    else if (host === PLACEHOLDER_HOST && rest !== '' && !rest.startsWith(`/${PLACEHOLDER_SECRET}`)) {
      found.push({ index: m.index, kind: 'a secret in the placeholder address', value: rest });
    }
  }

  // 32 bytes in URL-safe base64, on its own: 43 characters, mixed case as random is, and not a
  // piece of standard base64 (one with a + or =), which is how a lockfile's hashes would match.
  for (const m of text.matchAll(/[A-Za-z0-9_-]+/g)) {
    const token = m[0];
    if (token.length !== 43 || !/[A-Z]/.test(token) || !/[a-z]/.test(token)) continue;
    let start = m.index;
    let end = m.index + token.length;
    while (start > 0 && /[A-Za-z0-9+/=_-]/.test(text[start - 1])) start -= 1;
    while (end < text.length && /[A-Za-z0-9+/=_-]/.test(text[end])) end += 1;
    if (/[+=]/.test(text.slice(start, end))) continue;
    found.push({ index: m.index, kind: 'a 32-byte secret', value: token });
  }

  // ACCESS_SECRET given a value, in code, JSON, TOML, or a .dev.vars file. Empty is the relay
  // test's "no secret set".
  for (const m of text.matchAll(/ACCESS_SECRET["']?\s*[:=]\s*(["'`])(.*?)\1/g)) {
    if (m[2] !== '') found.push({ index: m.index, kind: 'an ACCESS_SECRET value', value: m[2] });
  }
  for (const m of text.matchAll(/^[ \t]*ACCESS_SECRET[ \t]*=[ \t]*([^\s"'`]+)/gm)) {
    found.push({ index: m.index, kind: 'an ACCESS_SECRET value', value: m[1] });
  }
  return found;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
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

function scan(files) {
  const problems = [];
  for (const rel of new Set(files)) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), 'latin1');
    } catch (err) {
      if (err.code === 'ENOENT') continue; // tracked, but deleted in this checkout
      throw err;
    }
    for (const f of findingsIn(text)) {
      const line = text.slice(0, f.index).split('\n').length;
      problems.push(`${rel}:${line}: ${f.kind}: ${masked(f.value)}`);
    }
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

// ---- The repo, and a build ----

test('no tracked file holds a relay address or secret', () => {
  const files = trackedFiles();
  assert.ok(files.includes('relay/wrangler.toml') && files.includes('relay/README.md'), 'the relay and its runbook are read');
  assert.deepEqual(scan(files), []);
});

test('nothing a build would pack holds a relay address or secret', () => {
  assert.deepEqual(scan(packedFiles()), []);
});
