// What the Electron tests share: a local relay Worker in Miniflare, a fake Ollama, and real
// app instances with their own temporary profiles. Run a test file with node, for example
// `node e2e/direct.e2e.js`, after `npm ci` and `npm ci --prefix relay`. `npm test` doesn't
// run these. Needs Node 22 or later, for Miniflare.
//
// Instances are only ever stopped through the handles made here, by their own process, so
// a Sanctum the owner has running is never touched. A fresh profile hard-killed soon after
// first use loses its keys, so this quits cleanly and only then falls back to killing.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const SECRET = 'test-secret-not-a-real-one-0123456789';
const PIN = '123456';
const TRANSPORT_PAGE = 'remote-transport.html';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// Miniflare comes from the relay's own dependencies, which are kept out of the app's.
async function startRelay() {
  const relayRoot = path.join(ROOT, 'relay');
  const { Miniflare } = require(path.join(relayRoot, 'node_modules', 'miniflare'));
  const toml = fs.readFileSync(path.join(relayRoot, 'wrangler.toml'), 'utf8');
  const mf = new Miniflare({
    modules: true,
    scriptPath: path.join(relayRoot, 'src', 'index.js'),
    modulesRoot: path.join(relayRoot, 'src'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: toml.match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1],
    durableObjects: {
      MAILBOX: { className: 'Mailbox', useSQLite: true },
      PAIRING_SLOT: { className: 'PairingSlot', useSQLite: true }
    },
    durableObjectsPersist: false,
    bindings: { ACCESS_SECRET: SECRET }
  });
  const url = new URL(await mf.ready);
  return { address: `ws://${url.host}/${SECRET}`, stop: () => mf.dispose() };
}

// So nothing ever reaches a real model, including the unload the app does on its way out. A
// chat never answers, which is a local model still generating, for as long as a test needs.
async function startFakeOllama() {
  let chats = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/api/chat') {
      chats += 1;
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    chats: () => chats,
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// `flags` become SANCTUM_REMOTE_TEST, which main.js reads only in an unpackaged app. The
// default keeps to this machine's own networking. Without no-stun an instance also asks the
// real STUN server for its address, as the shipped app does. Passing the `profile` of an
// instance that has quit restarts that instance.
async function launchDevice(name, { flags = 'log,no-stun', ollamaUrl, profile = fs.mkdtempSync(path.join(os.tmpdir(), `sanctum-e2e-${name}-`)) }) {
  const env = { ...process.env, OLLAMA_URL: ollamaUrl, SANCTUM_REMOTE_TEST: flags };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, `--user-data-dir=${profile}`],
    env,
    cwd: ROOT,
    timeout: 60000
  });
  const child = app.process();
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitFor(`${name}'s window.api.remote`, () => page.evaluate(() => Boolean(window.api?.remote)));
  // Keep everything the renderer is handed, to look at later. The app's mirror talks over any
  // live connection by itself, so its frames go in a list of their own, and __frames holds
  // only what a test sent.
  const record = () =>
    page.evaluate(() => {
      window.__frames = [];
      window.__mirrorFrames = [];
      window.__statuses = [];
      window.api.remote.onFrame((deviceId, frame) => {
        const mirrored = typeof frame.type === 'string' && frame.type.startsWith('mirror-');
        (mirrored ? window.__mirrorFrames : window.__frames).push(frame);
      });
      window.api.remote.onStatus((status) => window.__statuses.push(status));
    });
  await record();

  const device = {
    record,
    name,
    app,
    page,
    profile,
    get exited() {
      return exited;
    },
    remote: (method, ...args) => page.evaluate(([m, a]) => window.api.remote[m](...a), [method, args]),
    entry: async (id) => (await device.remote('status')).devices.find((d) => !id || d.id === id),
    path: async () => (await device.entry())?.path,
    waitForPath: (want, ms) => waitFor(`${name} to reach path ${want}`, async () => (await device.path()) === want, ms),
    // Comes up the first time a connection needs it.
    transport: () => waitFor(`${name}'s hidden window`, () => app.windows().find((w) => w.url().includes(TRANSPORT_PAGE))),
    frames: () => page.evaluate(() => window.__frames),
    mirrorFrames: () => page.evaluate(() => window.__mirrorFrames),
    frameCount: () => page.evaluate(() => window.__frames.length),
    windowCount: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    hiddenWindowFacts: () =>
      app.evaluate(({ BrowserWindow, session }, pageName) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(pageName));
        if (!win) return null;
        const prefs = win.webContents.getLastWebPreferences();
        return {
          visible: win.isVisible(),
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          nodeIntegration: prefs.nodeIntegration,
          ownSession: win.webContents.session !== session.defaultSession,
          sessionPersists: win.webContents.session.isPersistent()
        };
      }, TRANSPORT_PAGE),
    async quit() {
      if (!exited) {
        await Promise.race([app.close().catch(() => {}), sleep(20000)]);
        if (!exited) child.kill();
      }
      await waitFor(`${name} to exit`, () => exited, 10000).catch(() => {});
      await sleep(100); // Windows holds the profile's files for a moment after exit
    },
    async stop() {
      await device.quit();
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  return device;
}

// There's no UI for this yet. The host's relay socket opens in the background, and "no
// pairing waiting" doesn't count as a failed code, so asking again is fine.
async function pair(home, laptop, address) {
  assert.deepEqual(await home.remote('setAddress', address), { ok: true });
  assert.deepEqual(await laptop.remote('setAddress', address), { ok: true });
  const { code } = await home.remote('createCode');
  assert.ok(code, 'createCode gave a code');
  for (let i = 0; i < 100; i++) {
    const answer = await laptop.remote('pair', code, laptop.name, PIN);
    if (answer.ok) return answer;
    if (!/cancelled/.test(answer.error)) assert.fail(`pairing failed: ${answer.error}`);
    await sleep(100);
  }
  return assert.fail('the pairing slot never opened');
}

// A relay, a fake Ollama, and two paired instances with live sessions. A test that needs its
// own fake Ollama at home passes it as `homeOllama`, and stops it itself.
async function startPair({ flags, homeOllama } = {}) {
  const relay = await startRelay();
  const ollama = await startFakeOllama();
  const home = await launchDevice('home', { flags, ollamaUrl: (homeOllama ?? ollama).url });
  const laptop = await launchDevice('laptop', { flags, ollamaUrl: ollama.url });
  await pair(home, laptop, relay.address);
  await waitFor('the session on both ends', async () => (await home.entry())?.connected && (await laptop.entry())?.connected);
  const homeId = (await laptop.entry()).id;
  const laptopId = (await home.entry()).id;
  return {
    relay,
    ollama,
    home,
    laptop,
    homeId,
    laptopId,
    async stop() {
      // Through the object, since a test that restarts an instance puts the new one there.
      await Promise.all([this.home.stop(), this.laptop.stop()]);
      await relay.stop();
      await ollama.stop();
    }
  };
}

const MODEL = 'fake:latest';
const TITLE = 'Mirrored Title Here';

// A chat request stays open until the test finishes it, so what's on screen can be looked at
// between any two chunks. A title request is answered at once, because nothing waits on it.
async function startScriptedOllama() {
  const models = [MODEL];
  const replies = [];
  const waiters = [];
  const json = (res, value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      if (req.url === '/api/tags') return json(res, { models: models.map((name) => ({ name, model: name, size: 1000000000 })) });
      if (req.url === '/api/show') {
        return json(res, { model_info: { 'fake.context_length': 8192 }, details: {}, capabilities: ['completion', 'tools', 'thinking'] });
      }
      if (req.url !== '/api/chat') return json(res, { models: [] });

      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (body.options?.num_predict === 32) {
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: TITLE } })}\n${JSON.stringify({ done: true })}\n`);
        return undefined;
      }
      res.flushHeaders();
      const line = (value) => res.write(`${JSON.stringify(value)}\n`);
      const reply = {
        body,
        closed: false,
        think: (thinking) => line({ message: { role: 'assistant', content: '', thinking } }),
        say: (content) => line({ message: { role: 'assistant', content } }),
        call: (...calls) => line({ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })) } }),
        finish: () => res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 7, eval_count: 9 })}\n`)
      };
      res.on('close', () => {
        reply.closed = true;
      });
      if (waiters.length) waiters.shift()(reply);
      else replies.push(reply);
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    models,
    // The next chat request if one has come in, without waiting for one.
    poll: () => replies.shift() ?? null,
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no chat request reached the fake Ollama')), 20000);
        const got = (reply) => {
          clearTimeout(timer);
          resolve(reply);
        };
        if (replies.length) got(replies.shift());
        else waiters.push(got);
      }),
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// ---- Looking at the two screens ----

// The only things that are allowed to differ: the running seconds, which each machine paints
// from its own clock.
const normalize = (html) =>
  html.replace(/(class="msg-status-time">)[^<]*/g, '$1').replace(/(class="msg-silent-time">)[^<]*/g, '$1');

const threadOf = (device) => device.page.evaluate(() => document.querySelector('#thread').innerHTML);

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}\n  home:   ...${JSON.stringify(a.slice(Math.max(0, i - 80), i + 160))}\n  laptop: ...${JSON.stringify(b.slice(Math.max(0, i - 80), i + 160))}`;
}

// Settles within this, or it's a failure. Text that has to be there stops two stale screens
// that happen to agree from passing.
async function threadsMatch(pair, what, ...mustInclude) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const a = normalize(await threadOf(pair.home));
    const b = normalize(await threadOf(pair.laptop));
    const present = mustInclude.every((text) => a.includes(text));
    if (present && a === b) return a;
    if (Date.now() > deadline) {
      assert.ok(present, `${what}: home's thread never showed ${JSON.stringify(mustInclude)}:\n${a}`);
      assert.fail(`${what}: threads differ ${firstDifference(a, b)}`);
    }
    await sleep(25);
  }
}

const stopShowing = (device) => device.page.evaluate(() => document.querySelector('.composer .send').classList.contains('stopping'));

async function stopButtonsAre(pair, want, what) {
  await waitFor(`${what}: Stop ${want ? 'showing' : 'gone'} on both ends`, async () => (await stopShowing(pair.home)) === want && (await stopShowing(pair.laptop)) === want, 5000);
}

const secondsOn = (device, selector) =>
  device.page.evaluate((sel) => document.querySelector(`#thread ${sel}`)?.textContent ?? null, selector);

async function timersAgree(pair, selector) {
  const seconds = (text) => {
    assert.match(text ?? '', /^\d+s$/, `${selector} shows a running time`);
    return parseInt(text, 10);
  };
  const a = seconds(await secondsOn(pair.home, selector));
  const b = seconds(await secondsOn(pair.laptop, selector));
  assert.ok(Math.abs(a - b) <= 2, `${selector}: home ${a}s, laptop ${b}s`);
}

// ---- Driving the two ends ----

const newChat = (device, fields) =>
  device.page.evaluate(([model, extra]) => {
    createChat(model, extra.modality, extra);
    return state.activeId;
  }, [MODEL, fields]);

const openChat = (device, id) =>
  device.page.evaluate((chatId) => {
    state.space = chatSpace(state.chats[chatId]);
    applySpaceChrome();
    setActive(chatId);
  }, id);

const submit = (device, text) =>
  device.page.evaluate((value) => {
    const input = document.querySelector('#composer-input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    document.querySelector('#composer-form').requestSubmit();
  }, text);

const clickStop = (device) => device.page.evaluate(() => document.querySelector('.composer .send').click());

const remoteId = (pair, chatId) => `remote:${pair.homeId}:${chatId}`;

const hasChat = (device, id) => device.page.evaluate((chatId) => Boolean(state.chats[chatId]), id);

// Opens the chat on the laptop, once it's there.
async function watch(pair, chatId) {
  const id = remoteId(pair, chatId);
  await waitFor(`${chatId} to reach the laptop`, () => hasChat(pair.laptop, id), 5000);
  await openChat(pair.laptop, id);
  return id;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  }
  return value;
}

// The data behind the screens, as well as the screens.
async function chatDataMatches(pair, chatId) {
  const read = (device, key) =>
    device.page.evaluate((id) => {
      const { id: _id, ...rest } = ChatMirror.snapshotChat(state.chats[id]);
      return rest;
    }, key);
  await waitFor('the chat data to match', async () => {
    const a = await read(pair.home, chatId);
    const b = await read(pair.laptop, remoteId(pair, chatId));
    return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  }, 5000);
}

const offlineMark = (device) => device.page.evaluate(() => document.querySelector('#thread').getAttribute('data-remote-offline'));

const snapshotsSeen = async (device) => (await device.mirrorFrames()).filter((f) => f.type === 'mirror-snapshot').length;

module.exports = {
  startPair, startRelay, startFakeOllama, startScriptedOllama, launchDevice, pair, waitFor, sleep, PIN, SECRET, TRANSPORT_PAGE, MODEL, TITLE,
  normalize, threadOf, threadsMatch, stopShowing, stopButtonsAre, secondsOn, timersAgree, newChat, openChat, submit, clickStop, remoteId, hasChat, watch, sorted, chatDataMatches, offlineMark, snapshotsSeen
};
