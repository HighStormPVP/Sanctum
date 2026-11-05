const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = (f) => require(path.join(__dirname, '..', 'lib', f));
const { isWithinRoots, isInProfile, applyExactPatch, walkFiles } = lib('fs-rules.js');
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

test("Sanctum's own data folder and everything in it counts as the profile", () => {
  const profile = 'C:\\Users\\A\\AppData\\Roaming\\sanctum';
  assert.ok(isInProfile(profile, profile, win));
  assert.ok(isInProfile(`${profile}\\`, profile, win));
  assert.ok(isInProfile(`${profile}\\Local Storage\\leveldb\\000003.log`, profile, win));
  assert.ok(isInProfile('c:\\users\\a\\APPDATA\\roaming\\SANCTUM\\mcp_config.json', profile, win), 'case does not matter on Windows');
  assert.ok(isInProfile('C:/Users/A/AppData/Roaming/sanctum/mcp_config.json', profile, win));
  assert.ok(isInProfile('C:\\proj\\..\\Users\\A\\AppData\\Roaming\\sanctum\\a', profile, win), 'dots are walked');
  assert.ok(!isInProfile('C:\\Users\\A\\AppData\\Roaming\\sanctum-old\\a', profile, win), 'a name that only starts the same');
  assert.ok(!isInProfile('C:\\Users\\A\\AppData\\Roaming', profile, win), 'a parent is not the profile');
  assert.ok(!isInProfile('C:\\Users\\A\\AppData\\Roaming\\sanctum\\..\\other\\a', profile, win));
  assert.ok(isInProfile('/home/a/.config/sanctum/x', '/home/a/.config/sanctum', posix));
  assert.ok(!isInProfile('/home/a/.config/Sanctum/x', '/home/a/.config/sanctum', posix), 'case matters here');
  assert.ok(!isInProfile('C:\\anything', '', win));
  assert.ok(!isInProfile('C:\\anything', undefined, win));
});

test('a link into the profile counts as the profile', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'project');
  fs.mkdirSync(profile); fs.mkdirSync(project);
  fs.writeFileSync(path.join(profile, 'secret.txt'), 'x');
  const link = path.join(project, 'link');
  try { fs.symlinkSync(profile, link, 'junction'); }
  catch { t.skip('this machine cannot create links'); return; }
  assert.ok(isInProfile(path.join(link, 'secret.txt'), profile));
  assert.ok(isInProfile(link, profile));
  assert.ok(!isInProfile(path.join(project, 'mine.txt'), profile));
});

test('a walk or a search from a parent folder goes around the profile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-walk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'AppData', 'sanctum');
  fs.mkdirSync(path.join(profile, 'Local Storage'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(profile, 'Local Storage', 'keys.log'), 'CANARY in the profile');
  fs.writeFileSync(path.join(profile, 'mcp_config.json'), 'CANARY in the profile');
  fs.writeFileSync(path.join(dir, 'AppData', 'beside.txt'), 'CANARY beside the profile');
  fs.writeFileSync(path.join(dir, 'work', 'mine.txt'), 'CANARY in the work folder');
  const skipDir = (d) => isInProfile(d, profile);

  const walked = walkFiles(dir, { skipDir }).map((f) => path.relative(dir, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(walked, ['AppData/beside.txt', 'work/mine.txt']);
  assert.equal(walkFiles(dir).length, 4, 'without being told to, a walk still finds everything');

  const found = await grepInWorker({ pattern: 'CANARY', root: dir, profile });
  assert.deepEqual(found.matches.map((m) => m.file).sort(), ['AppData/beside.txt', 'work/mine.txt']);
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

// ---- Paths that can reach out, I9 ----

const { isLexicallyWithin, checkAgentPath } = lib('fs-rules.js');

function spied(pathMod, platform) {
  const calls = [];
  return { calls, pathMod, platform, realpath: (p) => { calls.push(p); return p; } };
}

const NETWORK_SHAPES = [
  '\\\\192.0.2.1\\share\\x.txt',
  '//192.0.2.1/share/x.txt',
  '\\/192.0.2.1/share/x.txt',
  '/\\192.0.2.1\\share\\x.txt',
  '\\\\?\\UNC\\192.0.2.1\\share\\x.txt',
  '\\\\.\\C:\\x.txt',
  '\\\\?\\C:\\x.txt'
];

test('a path outside every allowed folder is refused before anything looks at it', () => {
  for (const shape of NETWORK_SHAPES) {
    const opts = spied(path.win32, 'win32');
    assert.equal(isWithinRoots(shape, ['C:\\work'], opts), false, shape);
    assert.deepEqual(opts.calls, [], `${shape} reached realpath`);
    assert.equal(checkAgentPath(shape, { roots: ['C:\\work'], profile: 'C:\\profile', ...opts }), 'outside', shape);
    assert.deepEqual(opts.calls, [], `${shape} reached realpath by way of the profile check`);
  }
  const noRoots = spied(path.win32, 'win32');
  assert.equal(checkAgentPath('\\\\192.0.2.1\\share\\x.txt', { roots: [], profile: 'C:\\profile', ...noRoots }), 'outside');
  assert.deepEqual(noRoots.calls, []);
});

test('a roots list holding a network path costs nothing unless the path is inside it', () => {
  const opts = spied(path.win32, 'win32');
  assert.equal(isWithinRoots('C:\\work\\a.txt', ['\\\\192.0.2.1\\share', 'C:\\work'], opts), true);
  assert.ok(!opts.calls.some((p) => p.includes('192.0.2.1')), opts.calls.join());
});

test('a folder a person deliberately allowed on a NAS keeps working', () => {
  const opts = spied(path.win32, 'win32');
  assert.equal(checkAgentPath('\\\\192.0.2.1\\share\\a.txt', { roots: ['\\\\192.0.2.1\\share'], profile: 'C:\\profile', ...opts }), null);
  assert.ok(opts.calls.length > 0, 'an allowed path still goes on to be canonicalized');
});

test('the profile stays refused: plainly, by case, and through a link', () => {
  const profile = 'C:\\Users\\A\\sanctum';
  const plain = spied(path.win32, 'win32');
  assert.equal(checkAgentPath(`${profile}\\keys.json`, { roots: [], profile, ...plain }), 'profile', 'with no pop-up to offer');
  assert.deepEqual(plain.calls, [], 'and with no need to look');
  assert.equal(checkAgentPath(`c:\\users\\a\\SANCTUM\\keys.json`, { roots: ['C:\\'], profile, ...spied(path.win32, 'win32') }), 'profile');

  const link = 'C:\\work\\link';
  const realpath = (p) => (p.toLowerCase().startsWith(link.toLowerCase()) ? profile + p.slice(link.length) : p);
  const opts = { pathMod: path.win32, platform: 'win32', realpath };
  assert.equal(checkAgentPath(`${link}\\keys.json`, { roots: ['C:\\work'], profile, ...opts }), 'profile', 'a link inside an allowed folder');
  assert.equal(checkAgentPath(`${link}\\keys.json`, { roots: [], profile, ...opts }), 'outside', 'and not looked into unless allowed');
});

test('being inside a folder lexically is about the words, and case only on Windows', () => {
  assert.ok(isLexicallyWithin('C:\\proj\\a\\..\\b.txt', ['c:/PROJ'], { pathMod: path.win32, platform: 'win32' }));
  assert.ok(!isLexicallyWithin('C:\\proj-other\\b.txt', ['C:\\proj'], { pathMod: path.win32, platform: 'win32' }));
  assert.ok(!isLexicallyWithin('/Proj/a', ['/proj'], { pathMod: path.posix, platform: 'linux' }));
  assert.ok(!isLexicallyWithin('/proj/a', [], { pathMod: path.posix, platform: 'linux' }));
});

// ---- Links inside an allowed folder, by checkAgentPath, which all six file tools go through ----

test('a link inside an allowed folder that points outside it is refused, for a read and for a write to a target not there yet', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-agent-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  const link = path.join(root, 'link');
  try { fs.symlinkSync(outside, link, 'junction'); }
  catch { t.skip('this machine cannot create links'); return; }
  const profile = path.join(dir, 'profile');
  const opts = { roots: [root], profile };
  assert.equal(checkAgentPath(path.join(link, 'secret.txt'), opts), 'outside', 'a read through the link');
  assert.equal(checkAgentPath(path.join(link, 'new.txt'), opts), 'outside', 'a write through the link, to a file not there yet');
  assert.equal(checkAgentPath(path.join(link, 'new', 'deeper', 'new.txt'), opts), 'outside', 'and to a folder not there yet');
  assert.equal(checkAgentPath(link, opts), 'outside', 'the link itself');
  assert.equal(checkAgentPath(path.join(root, 'new.txt'), opts), null, 'a new file that really is inside');
  assert.equal(checkAgentPath(path.join(root, 'a', 'new.txt'), opts), null);
});

// ---- Walking in a worker, I2 ----

const { globInWorker } = lib('grep-runner.js');

// One tree for these tests, since making it is what takes the time. It has to be large enough that
// the same walk on the main thread would break the limit the tests set, or they prove nothing. So
// it's measured, and grown until it is, on however fast a machine this runs.
const ALLOWED_GAP_MS = 300;
const REQUIRED_SYNC_WALK_MS = ALLOWED_GAP_MS * 3;
let sharedTree = null;
function largeTree() {
  if (sharedTree) return sharedTree;
  sharedTree = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-walk-large-'));
  let folders = 0;
  let walkMs = 0;
  while (walkMs < REQUIRED_SYNC_WALK_MS && folders < 48000) {
    for (const end = folders + 8000; folders < end; folders++) fs.mkdirSync(path.join(sharedTree, `a${folders % 50}`, `b${folders}`), { recursive: true });
    const started = Date.now();
    walkFiles(sharedTree);
    walkMs = Date.now() - started;
  }
  assert.ok(walkMs >= REQUIRED_SYNC_WALK_MS, `a walk of ${folders} folders on this thread took ${walkMs} ms, too little for these tests to mean anything`);
  fs.writeFileSync(path.join(sharedTree, 'a0', 'found.txt'), 'needle');
  return sharedTree;
}
test.after(() => {
  if (sharedTree) fs.rmSync(sharedTree, { recursive: true, force: true, maxRetries: 5 });
});

function watchStall(t) {
  const watch = { worst: 0 };
  let last = Date.now();
  const ticker = setInterval(() => {
    watch.worst = Math.max(watch.worst, Date.now() - last);
    last = Date.now();
  }, 10);
  t.after(() => clearInterval(ticker));
  return watch;
}

test('glob walks in a worker: it finds what it should, and goes around the profile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-glob-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(path.join(profile), { recursive: true });
  fs.mkdirSync(path.join(dir, 'work', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'keys.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'work', 'deep', 'mine.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'work', 'other.md'), 'x');
  const found = await globInWorker({ pattern: '**/*.txt', root: dir, profile });
  assert.equal(found.root, dir);
  assert.deepEqual(found.matches, ['work/deep/mine.txt']);
  assert.equal(found.partial, undefined);
});

test('the main thread stays responsive while a glob walks a large tree', async (t) => {
  const dir = largeTree();
  const watch = watchStall(t);
  const started = Date.now();
  const found = await globInWorker({ pattern: '**/*.nothing', root: dir });
  assert.deepEqual(found.matches, []);
  assert.ok(watch.worst < ALLOWED_GAP_MS, `the event loop stalled for ${watch.worst} ms during a ${Date.now() - started} ms walk`);
});

test('so does grep, which walks first as well', async (t) => {
  const dir = largeTree();
  const watch = watchStall(t);
  const found = await grepInWorker({ pattern: 'needle', root: dir });
  assert.equal(found.matches.length, 1);
  assert.ok(watch.worst < ALLOWED_GAP_MS, `the event loop stalled for ${watch.worst} ms`);
});

test('a walk past its time gives what it has and says so, and past its limit gives a clear error', async () => {
  const dir = largeTree();
  const partial = await globInWorker({ pattern: '**/*', root: dir, walkMs: 1 });
  assert.equal(partial.partial, true, JSON.stringify(partial).slice(0, 200));
  assert.match(partial.note, /only part/);
  assert.ok(Array.isArray(partial.matches));

  const stopped = await globInWorker({ pattern: '**/*', root: dir, timeoutMs: 1 });
  assert.match(stopped.error, /took too long/);

  const grepped = await grepInWorker({ pattern: 'needle', root: dir, walkMs: 1 });
  assert.equal(grepped.partial, true);
  const grepStopped = await grepInWorker({ pattern: 'needle', root: dir, timeoutMs: 1 });
  assert.match(grepStopped.error, /took too long/);
});

// ---- Ending a process, I3 and I4 ----

const { killTree, startInOwnGroup, runShellCommand, KILL_SETTLES_WITHIN_MS } = lib('kill-tree.js');
const { spawn: realSpawn } = require('node:child_process');

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('POSIX: a process starts in its own group, and a kill reaches the whole group', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 42 };
  };
  startInOwnGroup('sleep 100', { cwd: '/tmp', shell: '/bin/sh' }, { platform: 'darwin', spawnImpl });
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.shell, '/bin/sh');
  assert.equal(calls[0].options.cwd, '/tmp');
  assert.equal(calls[0].command, 'sleep 100');

  const signals = [];
  const proc = { pid: 42, kill: () => assert.fail('the group was there, so this should not be needed') };
  await killTree(proc, { platform: 'darwin', killImpl: (pid, signal) => signals.push([pid, signal]) });
  assert.deepEqual(signals, [[-42, 'SIGKILL']]);
});

test('POSIX: with no group to signal, a kill falls back to the process', async () => {
  const signals = [];
  const proc = { pid: 42, kill: (signal) => signals.push(signal) };
  await killTree(proc, { platform: 'linux', killImpl: () => { throw new Error('ESRCH'); } });
  assert.deepEqual(signals, ['SIGKILL']);
  await killTree({ pid: 42, kill: () => { throw new Error('gone'); } }, { platform: 'linux', killImpl: () => { throw new Error('ESRCH'); } });
});

test('Windows does as it did: no group, and taskkill on the tree', async () => {
  const calls = [];
  const { EventEmitter } = require('node:events');
  startInOwnGroup('dir', { shell: 'cmd.exe' }, { platform: 'win32', spawnImpl: (c, a, options) => { calls.push(options); return { pid: 1 }; } });
  assert.notEqual(calls[0].detached, true);

  const killer = new EventEmitter();
  let args = null;
  let settled = false;
  const promise = killTree({ pid: 7 }, {
    platform: 'win32',
    spawnImpl: (command, list) => {
      args = [command, ...list];
      return killer;
    }
  }).then(() => { settled = true; });
  assert.deepEqual(args, ['taskkill', '/pid', '7', '/T', '/F']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'it has not finished until taskkill has');
  killer.emit('exit', 0);
  await promise;
  assert.equal(settled, true);
});

test('a kill settles whatever happens, and nothing to kill is nothing to wait for', async () => {
  await killTree(null);
  await killTree({});
  const { EventEmitter } = require('node:events');
  const killer = new EventEmitter();
  let fellBack = false;
  const promise = killTree({ pid: 7, kill: () => { fellBack = true; } }, { platform: 'win32', spawnImpl: () => killer });
  killer.emit('error', new Error('no taskkill'));
  await promise;
  assert.equal(fellBack, true);
  await killTree({ pid: 7, kill: () => {} }, { platform: 'win32', spawnImpl: () => { throw new Error('cannot spawn'); } });
});

test('a kill settles even if taskkill never exits, after 5 s by default', async () => {
  const { EventEmitter } = require('node:events');
  assert.equal(KILL_SETTLES_WITHIN_MS, 5000);
  const started = Date.now();
  await killTree({ pid: 7 }, { platform: 'win32', spawnImpl: () => new EventEmitter(), settlesWithinMs: 100 });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);

  // And that default is what's used. This waits out the real limit.
  const byDefault = Date.now();
  await killTree({ pid: 7 }, { platform: 'win32', spawnImpl: () => new EventEmitter() });
  const took = Date.now() - byDefault;
  assert.ok(took >= 4900 && took < 6000, `took ${took} ms`);
});

test('a kill that finishes leaves no timer behind', async () => {
  const { EventEmitter } = require('node:events');
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timers();
  const killer = new EventEmitter();
  const promise = killTree({ pid: 7 }, { platform: 'win32', spawnImpl: () => killer, settlesWithinMs: 60000 });
  assert.equal(timers(), before + 1, 'the limit is running');
  killer.emit('exit', 0);
  await promise;
  assert.equal(timers(), before, 'and it stops when the kill is done');
});

test('a real process tree: a kill ends the children too', { skip: process.platform === 'win32' ? 'POSIX only, for Task 15 to run on a Mac' : false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'grandchild.pid');
  const proc = startInOwnGroup(`sh -c 'sleep 100 & echo $! > "${file}"; wait'`, { shell: '/bin/sh', stdio: 'ignore' });
  let grandchild = null;
  for (let i = 0; i < 200 && !grandchild; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { grandchild = Number(fs.readFileSync(file, 'utf8')) || null; } catch { /* not yet */ }
  }
  assert.ok(grandchild && pidAlive(grandchild));
  await killTree(proc);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pidAlive(grandchild), false, 'the grandchild outlived the kill');
});

test('a real process: when a kill has settled, it has ended', async () => {
  const proc = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  await new Promise((resolve) => proc.once('spawn', resolve));
  assert.equal(pidAlive(proc.pid), true);
  await killTree(proc);
  for (let i = 0; i < 40 && pidAlive(proc.pid); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pidAlive(proc.pid), false);
});

const SHELL_FOR_TEST = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

test('runShellCommand gives what exec gave: output, exit code, and the caps', async () => {
  const ok = await runShellCommand({ command: 'echo hello', cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 20000 });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello/);
  assert.equal(ok.timedOut, false);

  const failed = await runShellCommand({ command: 'exit 3', cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 20000 });
  assert.equal(failed.exitCode, 3);

  const noFolder = await runShellCommand({ command: 'echo x', cwd: path.join(os.tmpdir(), 'sanctum-no-such-folder'), shell: SHELL_FOR_TEST, timeoutMs: 20000 });
  assert.equal(noFolder.exitCode, 1, 'a command that could not start reads as a failure, as it did');

  const script = 'process.stdout.write("x".repeat(100000))';
  const long = await runShellCommand({ command: `"${process.execPath}" -e "${script.replace(/"/g, process.platform === 'win32' ? '""' : '\\"')}"`, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 20000, env: { ...process.env } });
  assert.equal(long.stdout.length, 20000, 'what comes back is capped as before');

});

// Scripts in a temp folder, with what each does named. Everything they start ends by itself or is ended here.
function scripts(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return (name, source) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return `"${process.execPath}" "${file}"`;
  };
}
// The shell exits and leaves this running, holding its stdout: `x &`, or cmd's `start /b`.
const leftBehind = (command) => (process.platform === 'win32' ? `start /b "" ${command}` : `${command} &`);

test('past the buffer the process is ended, not left to finish', async (t) => {
  const write = scripts(t);
  const command = write('over.js', `process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);`);
  const started = Date.now();
  let child = null;
  const answer = await runShellCommand({ command, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 8000, maxBuffer: 1000, onStart: (c) => { child = c; } });
  assert.equal(answer.exitCode, 1, 'past the buffer it reads as a failure, as it did');
  assert.equal(answer.timedOut, false, 'the buffer ended it, not the time limit');
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  for (let i = 0; i < 40 && pidAlive(child.pid); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pidAlive(child.pid), false);
});

test('the buffer counts bytes, not characters', async (t) => {
  const write = scripts(t);
  // 3,000 characters and 9,000 bytes.
  const wide = write('wide.js', `process.stdout.write('\u20ac'.repeat(3000)); setInterval(() => {}, 1000);`);
  const over = await runShellCommand({ command: wide, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 8000, maxBuffer: 6000 });
  assert.equal(over.exitCode, 1);
  assert.equal(over.timedOut, false);

  const fits = write('fits.js', `process.stdout.write('\u20ac'.repeat(1000));`);
  const under = await runShellCommand({ command: fits, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 8000, maxBuffer: 6000 });
  assert.equal(under.exitCode, 0);
  assert.equal(under.stdout.trim().length, 1000);
});

test('a grandchild flooding output after its shell has exited can\'t hold up the answer past the buffer', async (t) => {
  const write = scripts(t);
  const command = leftBehind(write('flood.js', `const end = Date.now() + 3000; const s = 'f'.repeat(65536); const go = () => { if (Date.now() < end) process.stdout.write(s, go); else process.exit(0); }; go();`));
  const started = Date.now();
  const answer = await runShellCommand({ command, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 30000, maxBuffer: 1000 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(answer.exitCode, 1);
});

test('a grandchild holding output open after its shell has exited can\'t hold up the answer past the time limit', async (t) => {
  const write = scripts(t);
  const command = leftBehind(write('holds.js', `setTimeout(() => process.exit(0), 3000);`));
  const started = Date.now();
  const answer = await runShellCommand({ command, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 500 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(answer.timedOut, true);
});

test('nothing injected can reach a real process kill', () => {
  assert.equal(runShellCommand.length, 1);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kill-tree.js'), 'utf8');
  assert.ok(!source.includes('spawnOptions'), 'a spawn that can be faked beside a kill that can\'t');
});

test('runShellCommand has a time limit, which ends the process', async () => {
  const started = [];
  const script = 'setInterval(function () {}, 1000)';
  const answer = await runShellCommand({
    command: `"${process.execPath}" -e "${script}"`, cwd: os.tmpdir(), shell: SHELL_FOR_TEST, timeoutMs: 400, onStart: (child) => started.push(child)
  });
  assert.equal(answer.timedOut, true);
  assert.equal(started.length, 1);
  assert.equal(pidAlive(started[0].pid), false);
});

const { McpClient } = lib('mcp-client.js');

test('stopping an MCP client that ignores its stdin closing has ended it by the time it settles', async (t) => {
  const write = scripts(t);
  const server = write('stub-server.js', `
    const fs = require('fs');
    const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') say({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { pid: process.pid } } });
      else if (m.method === 'tools/list') say({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
    });
    setInterval(() => {}, 1000);
  `);
  const file = server.split('" "')[1].slice(0, -1);
  const client = new McpClient({ name: 'stub', command: process.execPath, args: [file], env: {} });
  await client.start();
  const pid = client.serverInfo.pid;
  assert.equal(pidAlive(pid), true);
  const stopped = client.stop();
  assert.ok(stopped instanceof Promise);
  await stopped;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pidAlive(pid), false, 'it was still running when stop() settled');
});
