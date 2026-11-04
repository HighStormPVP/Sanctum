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

module.exports = { startPair, startRelay, startFakeOllama, launchDevice, pair, waitFor, sleep, PIN, SECRET, TRANSPORT_PAGE };
