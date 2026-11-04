const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = (f) => require(path.join(__dirname, '..', 'lib', f));
const { isWithinRoots, applyExactPatch } = lib('fs-rules.js');
const { isPrivateAddress, checkUrl, safeFetchText } = lib('url-rules.js');
const { grepInWorker } = lib('grep-runner.js');
const { detectRepetitionLoop, splitOutputLines, quoteWindowsArg, encodePowerShell } = lib('text-rules.js');

const win = { pathMod: path.win32, platform: 'win32', realpath: (p) => p };
const posix = { pathMod: path.posix, platform: 'linux', realpath: (p) => p };

test('.. cannot escape an allowed root', () => {
  assert.ok(!isWithinRoots('C:\\proj\\..\\Windows\\win.ini', ['C:\\proj'], win));
  assert.ok(!isWithinRoots('/proj/../../etc/passwd', ['/proj'], posix));
  assert.ok(isWithinRoots('C:\\proj\\sub\\..\\a.txt', ['C:\\proj'], win));
});

test('a sibling that shares a prefix is outside', () => {
  assert.ok(!isWithinRoots('C:\\proj-secret\\a.txt', ['C:\\proj'], win));
});

test('Windows paths compare regardless of case and slash style', () => {
  assert.ok(isWithinRoots('C:/proj/a.txt', ['C:\\proj'], win));
  assert.ok(isWithinRoots('c:\\PROJ\\a.txt', ['C:\\proj\\'], win));
  assert.ok(!isWithinRoots('/Proj/a.txt', ['/proj'], posix));
});

test('no allowed roots means nothing is allowed', () => {
  assert.ok(!isWithinRoots('C:\\anything.txt', [], win));
  assert.ok(!isWithinRoots('C:\\anything.txt', undefined, win));
});

test('a symlink pointing out of the root is outside', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  const link = path.join(root, 'link');
  try { fs.symlinkSync(outside, link, 'junction'); }
  catch { t.skip('this machine cannot create links'); return; }
  assert.ok(!isWithinRoots(path.join(link, 'secret.txt'), [root]));
  assert.ok(isWithinRoots(path.join(root, 'new-file.txt'), [root]), 'a file that does not exist yet is checked by its parent');
});

test('apply_patch keeps $ patterns literally', () => {
  assert.strictEqual(applyExactPatch('a X b', 'X', 'echo $$ $& $1 done'), 'a echo $$ $& $1 done b');
  assert.strictEqual(applyExactPatch('a X b', 'X', undefined), 'a  b');
});

test('private and loopback addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111', '100.128.0.1', '::ffff:8.8.8.8']) {
    assert.ok(!isPrivateAddress(ip), ip);
  }
});

const publicDns = async () => [{ address: '93.184.216.34' }];
const localDns = async () => [{ address: '127.0.0.1' }];

test('checkUrl refuses non-web schemes, local names, and private lookups', async () => {
  assert.strictEqual((await checkUrl('file:///etc/passwd', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('http://localhost:3000', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('http://foo.localhost/', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('http://127.0.0.1/', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('http://2130706433/', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('http://[::1]/', publicDns)).ok, false);
  assert.strictEqual((await checkUrl('https://sneaky.example/', localDns)).ok, false);
  assert.strictEqual((await checkUrl('https://example.com/', publicDns)).ok, true);
});

const textResponse = (body, init = {}) => new Response(body, { status: 200, ...init });

test('a redirect to a private address is refused', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } });
  const r = await safeFetchText('https://example.com/', { fetchImpl, lookup: publicDns });
  assert.match(r.error, /private|local/i);
});

test('redirect loops stop', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.com/again' } }); };
  const r = await safeFetchText('https://example.com/', { fetchImpl, lookup: publicDns });
  assert.match(r.error, /redirect/i);
  assert.ok(calls <= 6, `made ${calls} requests`);
});

test('large responses are cut off at the cap', async () => {
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(64 * 1024).fill(97)); }
  });
  const fetchImpl = async () => new Response(stream, { status: 200 });
  const r = await safeFetchText('https://example.com/', { fetchImpl, lookup: publicDns, maxBytes: 200 * 1024 });
  assert.ok(r.truncated);
  assert.ok(r.text.length <= 300 * 1024, `kept ${r.text.length}`);
});

test('a server that never answers times out', async () => {
  const fetchImpl = (u, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const r = await safeFetchText('https://example.com/', { fetchImpl, lookup: publicDns, timeoutMs: 50 });
  assert.match(r.error, /timed out/i);
});

test('a normal page comes back with its content type', async () => {
  const fetchImpl = async () => textResponse('hello', { headers: { 'content-type': 'text/html' } });
  const r = await safeFetchText('https://example.com/', { fetchImpl, lookup: publicDns });
  assert.strictEqual(r.text, 'hello');
  assert.match(r.contentType, /html/);
});

test('a catastrophic regex times out instead of freezing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-grep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a'.repeat(40) + 'b\n');
  const started = Date.now();
  const r = await grepInWorker({ pattern: '(a+)+$', root: dir, allowlist: [dir], timeoutMs: 400 });
  assert.match(r.error, /too long/i);
  assert.ok(Date.now() - started < 5000);
});

test('grep finds matches, honours the glob, and skips outside roots', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-grep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'one\nneedle here\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'needle too\n');
  const r = await grepInWorker({ pattern: 'needle', root: dir, globFilter: '*.js', allowlist: [dir] });
  assert.deepStrictEqual(r.matches.map(m => [m.file, m.line]), [['a.js', 2]]);
});

test('repetition guard ignores long but ordinary repeated output', () => {
  assert.strictEqual(detectRepetitionLoop('0, '.repeat(500)), null);
  assert.strictEqual(detectRepetitionLoop('-'.repeat(1500)), null);
  assert.strictEqual(detectRepetitionLoop('A'.repeat(3000)), null);
});

test('repetition guard stops a real spiral', () => {
  assert.ok(detectRepetitionLoop('Let me think about this again. '.repeat(400)));
});

test('output lines lose Windows line endings', () => {
  assert.deepStrictEqual(splitOutputLines('MARK\r\n{"a":1}\r\nEND'), { lines: ['MARK', '{"a":1}'], rest: 'END' });
  assert.deepStrictEqual(splitOutputLines('x\n'), { lines: ['x'], rest: '' });
});

test('Windows arguments with spaces stay in one piece', () => {
  assert.strictEqual(quoteWindowsArg('C:\\CLAUDE IDEAS nobackup\\x'), '"C:\\CLAUDE IDEAS nobackup\\x"');
  assert.strictEqual(quoteWindowsArg('-y'), '-y');
  assert.strictEqual(quoteWindowsArg('a&b'), '"a&b"');
  assert.strictEqual(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.throws(() => quoteWindowsArg('a"b'), /quote/i);
});

test('PowerShell scripts are encoded the way -EncodedCommand expects', () => {
  const encoded = encodePowerShell('Write-Output "a|b"');
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output "a|b"');
});

// ---- The main window only ever shows the app's own page ----

const { isAppPage } = lib('url-rules.js');
const { pathToFileURL } = require('url');

test('isAppPage takes only the exact file, however its URL is spelled', () => {
  const index = path.join(os.tmpdir(), 'Sanctum Test', 'index.html');
  const url = pathToFileURL(index).href;
  assert.strictEqual(isAppPage(url, index), true);
  assert.strictEqual(isAppPage(`${url}#frag`, index), true);
  assert.strictEqual(isAppPage(pathToFileURL(path.join(os.tmpdir(), 'Sanctum Test', 'other', '..', 'index.html')).href, index), true);

  const others = [
    pathToFileURL(path.join(os.tmpdir(), 'Sanctum Test', 'evil.html')).href,
    pathToFileURL(path.join(os.tmpdir(), 'index.html')).href,
    pathToFileURL(`${index}.html`).href,
    `${url}?next=1`,
    url.replace('file:///', 'file://evil.example/'),
    url.replace('index.html', 'index%2Ehtml%5C..%5Cevil.html'),
    url.replace('file:', 'https:'),
    'aio-preview://abc/',
    'about:blank',
    'javascript:alert(1)',
    'not a url',
    '',
    undefined
  ];
  for (const other of others) assert.strictEqual(isAppPage(other, index), false, String(other));
});
