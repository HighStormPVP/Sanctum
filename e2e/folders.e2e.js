// Folders from a laptop, Run on a code block where it's clicked, and keeping the home PC available:
// the tray, keep-awake, start at login, and the suggestion after pairing. Real Electron instances,
// the relay Worker in Miniflare, and a fake Ollama. What really happened is read from temp folders
// made here and from the main process, never from what the page says about itself.
//
// Start at login is only ever a stand-in. In an unpackaged run Sanctum doesn't offer it at all, and
// every instance here has app.setLoginItemSettings and app.getLoginItemSettings replaced before
// anything happens, so a call that got through would be counted rather than reach the system.
//
//   node e2e/folders.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startRelay, launchDevice, pair, waitFor, sleep, PIN, MODEL, newChat, openChat, watch } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const FLAGS = 'log,no-stun,peek';
const KEEP_AWAKE = 'Keep this PC awake while a chat is shared';
const START_AT_LOGIN = 'Start Sanctum when I log in';
const PROFILE_REFUSED = "That is Sanctum's own data folder. A project can't use it.";
const LISTING_REFUSED = "The home PC's answer wasn't a folder listing, so it isn't shown.";

// A fake Ollama with one model said to be resident, so quitting's cleanup has one model to unload,
// and the unloads can be counted. A chat request stays open until the test finishes it.
async function startOllama({ unloadDelayMs = 0 } = {}) {
  const replies = [];
  const waiters = [];
  let unloads = 0;
  const json = (res, value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, size: 1000000000 }] });
      if (req.url === '/api/ps') return json(res, { models: [{ name: 'resident:latest' }] });
      if (req.url === '/api/show') return json(res, { model_info: { 'fake.context_length': 8192 }, details: {}, capabilities: ['completion', 'tools'] });
      if (req.url === '/api/generate') {
        if (JSON.parse(raw || '{}').keep_alive === 0) unloads += 1;
        setTimeout(() => json(res, {}), unloadDelayMs);
        return undefined;
      }
      if (req.url !== '/api/chat') return json(res, { models: [] });
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (body.options?.num_predict === 32) {
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'A title' } })}\n${JSON.stringify({ done: true })}\n`);
        return undefined;
      }
      res.flushHeaders();
      const reply = {
        body,
        say: (content) => res.write(`${JSON.stringify({ message: { role: 'assistant', content } })}\n`),
        call: (name, args) => res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } })}\n`),
        finish: () => res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`)
      };
      if (waiters.length) waiters.shift()(reply);
      else replies.push(reply);
      return undefined;
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    unloads: () => unloads,
    next: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no chat request reached the fake Ollama')), 20000);
      const got = (reply) => { clearTimeout(timer); resolve(reply); };
      if (replies.length) got(replies.shift());
      else waiters.push(got);
    }),
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

// Before anything else happens in that instance. A call that reaches these is counted, and nothing
// reaches the system's login items.
async function stubLoginItems(device) {
  await device.app.evaluate(({ app }) => {
    globalThis.__loginCalls = [];
    app.setLoginItemSettings = (settings) => { globalThis.__loginCalls.push(['set', settings]); };
    app.getLoginItemSettings = () => { globalThis.__loginCalls.push(['get']); return { openAtLogin: false }; };
  });
}
const loginCalls = (device) => device.app.evaluate(() => globalThis.__loginCalls);

async function launch(name, ollama, { flags = FLAGS, profile } = {}) {
  const device = await launchDevice(name, { flags, ollamaUrl: ollama.url, profile });
  await stubLoginItems(device);
  await waitFor(`${name} to finish starting`, () => device.page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));
  return device;
}

// As text: Playwright can lose an object handed back from the main process.
const peek = async (device, what, ...args) => {
  const said = await device.app.evaluate((_, [w, a]) => JSON.stringify(globalThis.__sanctumAvailability[w](...a) ?? null), [what, args]);
  return JSON.parse(said);
};
const mainWindowFacts = async (device) => JSON.parse(await device.app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
  return JSON.stringify(win ? { visible: win.isVisible(), destroyed: win.isDestroyed() } : null);
}));
const throttled = (device) => device.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).webContents.getBackgroundThrottling());
const closeMainWindow = (device) => device.app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).close();
}).catch(() => {});
const visible = (device, selector) => device.page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return Boolean(el) && !el.hidden && el.getClientRects().length > 0;
}, selector);
const textOf = (device, selector) => device.page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector);
const textsOf = (device, selector) => device.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent), selector);
const settingsOf = (device) => device.page.evaluate(() => window.api.app.getAvailabilitySettings());
const shareOne = (device, fields = {}) => newChat(device, { modality: 'chat', title: 'Shared', titleManual: true, remoteControl: true, ...fields });
const setShared = (device, id, on) => device.page.evaluate(([chatId, value]) => setChatShared(state.chats[chatId], value), [id, on]);
const sharingIs = (device, want) => waitFor(`main to hear sharing is ${want}`, async () => (await peek(device, 'sharing')) === want, 5000);
const exits = (device, ms = 20000) => waitFor(`${device.name} to exit`, () => device.exited, ms);

// ---------------------------------------------------------------------------------------------

test('keeping the home PC available', async (t) => {
  const relay = await startRelay();
  const ollama = await startOllama();
  const made = [];
  t.after(async () => {
    for (const device of made) await device.stop();
    await relay.stop();
    await ollama.stop();
  });
  const solo = async (name) => {
    const device = await launch(name, ollama);
    made.push(device);
    // Remote Control is on, which is what lets a chat be shared. Nothing is paired.
    assert.deepEqual(await device.remote('setAddress', relay.address), { ok: true });
    await waitFor('Remote Control to be on', () => device.page.evaluate(() => remoteStatusNow().enabled === true));
    return device;
  };

  await t.test('both settings are off by default, and start at login is refused in an unpackaged run without asking the system', async () => {
    const home = await solo('defaults');
    assert.deepEqual(await settingsOf(home), { keepAwake: false, startAtLogin: false, startAtLoginWorks: false, suggestionAnswered: false });
    const answer = await home.page.evaluate(() => window.api.app.setStartAtLogin(true));
    assert.equal(answer.ok, false);
    assert.equal(answer.error, 'Starting when you log in works in the installed app.');
    assert.equal(answer.settings.startAtLogin, false);

    // In Settings it's there, off, can't be turned on, and says why in plain words.
    await home.page.evaluate(() => openDevicesSettings());
    await waitFor('the settings', () => visible(home, '#availability-wrap'));
    const labels = await textsOf(home, '#availability-wrap .wd-label');
    assert.deepEqual(labels, [START_AT_LOGIN, KEEP_AWAKE], 'the spec\'s own words');
    assert.equal(await home.page.evaluate(() => document.querySelector('#setting-start-at-login').disabled), true);
    assert.equal(await home.page.evaluate(() => document.querySelector('#setting-start-at-login').checked), false);
    assert.equal(await textOf(home, '#setting-start-at-login-note'), 'This works in the installed app.');
    assert.equal(await home.page.evaluate(() => document.querySelector('#setting-keep-awake').checked), false);
    assert.deepEqual(await loginCalls(home), [], 'the system was never asked, either way');
    assert.equal((await settingsOf(home)).startAtLogin, false, 'and nothing says it is on');
  });

  await t.test('keep-awake runs only while it is on and a chat is shared, stops with the last one, and never runs two', async () => {
    const home = await solo('awake');
    await home.app.evaluate(({ powerSaveBlocker }) => {
      const log = { starts: [], stops: 0 };
      globalThis.__blockers = log;
      const start = powerSaveBlocker.start.bind(powerSaveBlocker);
      const stop = powerSaveBlocker.stop.bind(powerSaveBlocker);
      powerSaveBlocker.start = (type) => { log.starts.push(type); return start(type); };
      powerSaveBlocker.stop = (id) => { log.stops += 1; return stop(id); };
    });
    // As text: Playwright can lose an object handed back from the main process, and say its promise was
    // garbage collected.
    const blockers = async () => JSON.parse(await home.app.evaluate(({ powerSaveBlocker }) => {
      const id = globalThis.__sanctumAvailability.keepAwake();
      return JSON.stringify({ ...globalThis.__blockers, running: id !== null && powerSaveBlocker.isStarted(id) });
    }));
    const running = async (want, what) => waitFor(what, async () => (await blockers()).running === want, 5000);

    const first = await shareOne(home);
    await sharingIs(home, true);
    assert.equal((await blockers()).running, false, 'shared, but the setting is off');
    await setShared(home, first, false);
    await sharingIs(home, false);

    assert.equal((await home.page.evaluate(() => window.api.app.setKeepAwake(true))).ok, true);
    await sleep(300);
    assert.equal((await blockers()).running, false, 'on, but nothing is shared');

    await setShared(home, first, true);
    await running(true, 'it to start once a chat is shared');
    const second = await shareOne(home);
    await home.page.evaluate(() => window.api.app.setKeepAwake(true));
    await home.page.evaluate(() => window.api.app.setKeepAwake(true));
    await sleep(300);
    assert.deepEqual((await blockers()).starts, ['prevent-app-suspension'], 'one blocker, of the kind that lets the screen sleep');

    await setShared(home, first, false);
    await sleep(300);
    assert.equal((await blockers()).running, true, 'one chat is still shared');
    await setShared(home, second, false);
    await running(false, 'it to stop with the last shared chat');
    assert.equal((await blockers()).stops, 1);

    await setShared(home, second, true);
    await running(true, 'it to start again');
    await home.page.evaluate(() => window.api.app.setKeepAwake(false));
    await running(false, 'it to stop when the setting goes off');
    const after = await blockers();
    assert.equal(after.starts.length, after.stops, 'every start was stopped');

    // The setting is kept by main, and applies from the start.
    await home.page.evaluate(() => window.api.app.setKeepAwake(true));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home.profile, 'availability.json'), 'utf8')).keepAwake, true);
  });

  await t.test('closing with no chat shared quits as it always has, and the cleanup runs once', async () => {
    const home = await solo('plain');
    const before = ollama.unloads();
    assert.equal(await peek(home, 'tray'), false, 'no icon while nothing is shared');
    await closeMainWindow(home);
    await exits(home);
    await sleep(300);
    assert.equal(ollama.unloads() - before, 1, 'the resident model was unloaded once');
  });

  await t.test('closing while shared hides to the tray, says so once, the icon brings it back, and Quit quits with the cleanup once', async () => {
    const home = await solo('tray');
    const id = await shareOne(home);
    await sharingIs(home, true);
    await waitFor('the icon', () => peek(home, 'tray'), 5000);

    await closeMainWindow(home);
    await waitFor('the window to hide', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    await sleep(500);
    assert.equal(home.exited, false, 'still running');
    assert.deepEqual(await mainWindowFacts(home), { visible: false, destroyed: false });
    assert.equal(await peek(home, 'tray'), true);
    assert.deepEqual(await peek(home, 'notes'), ['A chat is shared, so Sanctum keeps running in the tray. Quit it from there.']);

    await peek(home, 'clickTrayIcon');
    await waitFor('the icon to bring it back', async () => (await mainWindowFacts(home))?.visible === true, 5000);
    await closeMainWindow(home);
    await waitFor('it to hide again', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    assert.equal((await peek(home, 'notes')).length, 1, 'the note is said once');
    await peek(home, 'clickTrayMenu', 'Open Sanctum');
    await waitFor('Open Sanctum to bring it back', async () => (await mainWindowFacts(home))?.visible === true, 5000);
    assert.ok(id);

    await closeMainWindow(home);
    await waitFor('hidden', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    const before = ollama.unloads();
    await peek(home, 'clickTrayMenu', 'Quit').catch(() => {});
    await exits(home);
    await sleep(300);
    assert.equal(ollama.unloads() - before, 1, 'the cleanup ran, once');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home.profile, 'availability.json'), 'utf8')).trayNoteShown, true, 'and the note stays said');
  });

  await t.test('a second launch on the same profile hands over to the first and exits, and other profiles run alongside', async () => {
    const home = await solo('single');
    const beside = await solo('beside');
    await shareOne(home);
    await sharingIs(home, true);
    await waitFor('the icon', () => peek(home, 'tray'), 5000);
    await closeMainWindow(home);
    await waitFor('hidden', async () => (await mainWindowFacts(home))?.visible === false, 5000);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const second = spawn(ELECTRON, [ROOT, `--user-data-dir=${home.profile}`], { env, stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { second.kill(); resolve('still running'); }, 20000);
      second.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, 'the second one went');
    await waitFor('the first window shown', async () => (await mainWindowFacts(home))?.visible === true, 5000);
    assert.equal(home.exited, false);
    assert.equal(await beside.page.evaluate(() => typeof state), 'object', 'one with its own profile runs alongside');
  });

  await t.test("if the system won't give a tray icon, closing quits as if nothing were shared, and says why once", async () => {
    const home = await launch('notray', ollama, { flags: `${FLAGS},tray-fails` });
    made.push(home);
    let said = '';
    home.app.process().stderr.on('data', (chunk) => { said += chunk; });
    assert.deepEqual(await home.remote('setAddress', relay.address), { ok: true });
    await waitFor('Remote Control to be on', () => home.page.evaluate(() => remoteStatusNow().enabled === true));
    await shareOne(home);
    await sharingIs(home, true);
    await waitFor('the line in the log', () => said.includes("[tray] Couldn't show a tray icon"), 5000);
    assert.equal(await peek(home, 'tray'), false);
    await closeMainWindow(home);
    await exits(home);
    assert.equal(said.split("[tray] Couldn't show a tray icon").length - 1, 1, 'said once');
  });

  await t.test('two Quits in a row, the second while the cleanup is running, clean up once', async () => {
    const slow = await startOllama({ unloadDelayMs: 1500 });
    t.after(() => slow.stop());
    const home = await launch('twice', slow);
    made.push(home);
    assert.deepEqual(await home.remote('setAddress', relay.address), { ok: true });
    await waitFor('Remote Control to be on', () => home.page.evaluate(() => remoteStatusNow().enabled === true));
    await shareOne(home);
    await sharingIs(home, true);
    await waitFor('the icon', () => peek(home, 'tray'), 5000);
    await closeMainWindow(home);
    await waitFor('hidden', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    await peek(home, 'clickTrayMenu', 'Quit').catch(() => {});
    await sleep(300);
    assert.equal(slow.unloads(), 1, 'the cleanup is under way');
    await home.app.evaluate(({ app }) => app.quit()).catch(() => {});
    await exits(home);
    await sleep(300);
    assert.equal(slow.unloads(), 1, 'and ran once');
  });

  await t.test('the icon goes when the last chat is unshared, but not while the window is hidden', async () => {
    const home = await solo('unshare');
    const id = await shareOne(home);
    await waitFor('the icon', () => peek(home, 'tray'), 5000);
    await setShared(home, id, false);
    await waitFor('the icon to go', async () => (await peek(home, 'tray')) === false, 5000);

    await setShared(home, id, true);
    await waitFor('the icon again', () => peek(home, 'tray'), 5000);
    await closeMainWindow(home);
    await waitFor('hidden', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    // As a laptop can do, by deleting the last shared chat.
    await home.page.evaluate((chatId) => deleteChat(chatId), id);
    await sharingIs(home, false);
    await sleep(300);
    assert.equal(await peek(home, 'tray'), true, 'a hidden window keeps its icon, or nobody could get it back');
    await peek(home, 'clickTrayIcon');
    await waitFor('shown, and then the icon goes', async () => (await mainWindowFacts(home))?.visible === true && (await peek(home, 'tray')) === false, 5000);

    // With nothing shared, closing quits again.
    await closeMainWindow(home);
    await exits(home);
  });
});

// ---------------------------------------------------------------------------------------------

test('pairing suggests the settings once, at home only', async (t) => {
  const relay = await startRelay();
  const ollama = await startOllama();
  const made = [];
  t.after(async () => {
    for (const device of made) await device.stop();
    await relay.stop();
    await ollama.stop();
  });
  const device = async (name, options) => {
    const d = await launch(name, ollama, options);
    made.push(d);
    assert.deepEqual(await d.remote('setAddress', relay.address), { ok: true });
    return d;
  };
  // Through the dialog at home, as a person does it.
  const pairThroughDialog = async (home, laptop) => {
    await home.page.evaluate(() => openCodeDialog('Add a device'));
    const code = await waitFor('a code', async () => {
      const text = await textOf(home, '#remote-code-value');
      return /^[A-Z0-9]{6}$/.test(text || '') ? text : null;
    }, 20000);
    for (let i = 0; i < 100; i++) {
      const answer = await laptop.remote('pair', code, laptop.name, PIN);
      if (answer.ok) break;
      if (!/cancelled/.test(answer.error)) assert.fail(`pairing failed: ${answer.error}`);
      await sleep(100);
    }
    await waitFor('home to say it is connected', async () => (await textOf(home, '#remote-code-message'))?.includes('is connected'), 20000);
  };

  let home = await device('home');
  const first = await device('first');
  await pairThroughDialog(home, first);
  await waitFor('the suggestion', () => visible(home, '#remote-suggest'), 5000);
  assert.deepEqual(await textsOf(home, '#remote-suggest-list li'), [KEEP_AWAKE], 'start at login can\'t be turned on here, so it isn\'t offered');
  assert.equal(await visible(first, '#remote-suggest'), false, 'never on the laptop');
  assert.equal((await settingsOf(first)).suggestionAnswered, false);

  await home.page.evaluate(() => document.querySelector('#remote-suggest-no').click());
  await waitFor('it to go', async () => !(await visible(home, '#remote-suggest')), 5000);
  await waitFor('the answer kept', async () => (await settingsOf(home)).suggestionAnswered === true, 5000);
  assert.equal((await settingsOf(home)).keepAwake, false, 'Not now turned nothing on');
  await home.page.evaluate(() => closeCodeDialog());

  // Not now sticks across a restart, and another pairing doesn't ask again.
  const profile = home.profile;
  await home.quit();
  made.splice(made.indexOf(home), 1);
  home = await launch('home', ollama, { profile });
  made.push(home);
  assert.equal((await settingsOf(home)).suggestionAnswered, true);
  const second = await device('second');
  await pairThroughDialog(home, second);
  await sleep(1000);
  assert.equal(await visible(home, '#remote-suggest'), false, 'not asked again');
  await home.page.evaluate(() => closeCodeDialog());

  await t.test('Turn on turns on what was offered, and a setting already on is not offered', async () => {
    // A stand-in for the system's login items, so start at login can be offered at all.
    const other = await device('other', { flags: `${FLAGS},fake-login-item` });
    await other.page.evaluate(() => window.api.app.setKeepAwake(true));
    const third = await device('third');
    await pairThroughDialog(other, third);
    await waitFor('the suggestion', () => visible(other, '#remote-suggest'), 5000);
    assert.deepEqual(await textsOf(other, '#remote-suggest-list li'), [START_AT_LOGIN]);
    await other.page.evaluate(() => document.querySelector('#remote-suggest-yes').click());
    await waitFor('it on', async () => (await settingsOf(other)).startAtLogin === true, 5000);
    assert.deepEqual(await settingsOf(other), { keepAwake: true, startAtLogin: true, startAtLoginWorks: true, suggestionAnswered: true });
    assert.equal(await peek(other, 'loginItem'), true, 'the stand-in has it');
    assert.deepEqual(await loginCalls(other), [], 'and the system never heard of it');
    assert.equal(await visible(other, '#remote-suggest'), false);
    await other.page.evaluate(() => closeCodeDialog());
  });

  await t.test('closing the dialog with the suggestion up counts as Not now', async () => {
    const fourth = await device('fourth');
    const fifth = await device('fifth');
    await pairThroughDialog(fourth, fifth);
    await waitFor('the suggestion', () => visible(fourth, '#remote-suggest'), 5000);
    await fourth.page.evaluate(() => document.querySelector('#remote-code-close').click());
    await waitFor('the answer kept', async () => (await settingsOf(fourth)).suggestionAnswered === true, 5000);
    assert.equal((await settingsOf(fourth)).keepAwake, false);
  });
});

// ---------------------------------------------------------------------------------------------

test('from a laptop', async (t) => {
  const relay = await startRelay();
  const ollama = await startOllama();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-folders-'));
  const tree = path.join(root, 'tree');
  const laptopDir = path.join(root, 'laptop-folder');
  const markers = path.join(root, 'markers');
  for (const dir of [tree, laptopDir, markers]) fs.mkdirSync(dir);
  const home = await launch('home', ollama);
  // A test below restarts the laptop, and everything after it uses the new one.
  let laptop = await launch('laptop', ollama);
  t.after(async () => {
    await home.stop();
    await laptop.stop();
    await relay.stop();
    await ollama.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  await pair(home, laptop, relay.address);
  await waitFor('the session on both ends', async () => (await home.entry())?.connected && (await laptop.entry())?.connected);
  const trio = { home, laptop, homeId: (await laptop.entry()).id, laptopId: (await home.entry()).id };
  await waitFor('the model to show as installed', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
  await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
  const homeName = (await home.remote('status')).name;
  const laptopName = (await laptop.remote('status')).name;
  const homePid = await home.app.evaluate(() => process.pid);
  let laptopPid = await laptop.app.evaluate(() => process.pid);
  const key = (id) => `remote:${trio.homeId}:${id}`;

  await t.test('a hidden home keeps a reply from a laptop streaming to it on time', async () => {
    assert.equal(await throttled(home), false, 'never slowed, with nothing shared too');
    const id = await shareOne(home, { model: MODEL });
    assert.equal(await throttled(home), false, 'nor with a chat shared');
    const rid = await watch(trio, id);
    await closeMainWindow(home);
    await waitFor('home to hide', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    // Playwright keeps a page it's attached to looking visible, so Chromium never slows this hidden
    // window in a test, and on-time pieces alone can't show it isn't slowed for real. What decides
    // that is the window's own setting, so that is read too.
    assert.equal(await throttled(home), false, 'a hidden window with a shared chat is not slowed');
    await sleep(1500);

    assert.equal((await laptop.remote('send', trio.homeId, { type: 'action', id: 'a_hidden1', chatId: id, kind: 'send', args: { text: 'Go' } })), true);
    const reply = await ollama.next();
    const lags = [];
    for (let i = 0; i < 8; i++) {
      const word = `piece${i} `;
      const saidAt = Date.now();
      reply.say(word);
      await waitFor(`${word} on the laptop`, () => laptop.page.evaluate(([chatId, w]) => state.chats[chatId]?.messages.at(-1)?.content.includes(w), [rid, word]), 5000);
      lags.push(Date.now() - saidAt);
      await sleep(120);
    }
    reply.finish();
    assert.ok(Math.max(...lags) < 600, `each piece reached the laptop soon after it was said: ${lags.join(', ')} ms`);
    await waitFor('the reply to finish', () => home.page.evaluate((chatId) => !state.runningChats.has(chatId), id), 10000);
    await peek(home, 'clickTrayIcon');
    await waitFor('home back', async () => (await mainWindowFacts(home))?.visible === true, 5000);
    await setShared(home, id, false);
    await sleep(300);
    assert.equal(await throttled(home), false, 'and still not once nothing is shared again');
  });

  // ---- The home folder browser ----

  // 300 files, listed before 250 folders, the way a big folder can come back.
  const big = path.join(tree, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(big, `a${String(i).padStart(3, '0')}.txt`), '');
  for (let i = 0; i < 250; i++) fs.mkdirSync(path.join(big, `z${String(i).padStart(3, '0')}`));
  const pick = path.join(tree, 'pick');
  fs.mkdirSync(pick);
  fs.writeFileSync(path.join(tree, 'not-a-folder.txt'), 'x');
  // Names a disk here can hold that still mean to mislead.
  const rtl = 'rtl‮gnp.exe';
  fs.mkdirSync(path.join(tree, rtl));
  fs.mkdirSync(path.join(tree, 'a&lt;b&gt;'));

  const project = { modality: 'agent', title: 'Project', titleManual: true, remoteControl: true, planMode: true, approvalMode: false, noApproval: false, readOnly: false, noFetch: false, maxSteps: 10 };
  const browserOpen = () => visible(laptop, '#folder-browser-overlay');
  const shownPath = () => textOf(laptop, '#fb-path');
  const names = () => textsOf(laptop, '#fb-list .fb-entry');
  const clickEntry = (name) => laptop.page.evaluate((n) => [...document.querySelectorAll('#fb-list .fb-entry')].find((el) => el.textContent === n).click(), name);
  const settled = () => waitFor('the browser to settle', async () => (await laptop.page.evaluate(() => remoteUi.folders && !remoteUi.folders.busy)), 10000);
  const goTo = async (folder) => {
    await laptop.page.evaluate((p) => browseHomeFolder(p), folder);
    await settled();
  };

  await t.test("the home folder browser starts at the chat's folder, lists folders only, and sets the home folder once home has", async () => {
    const id = await newChat(home, { ...project, projectFolder: tree, pathAllowlist: [tree] });
    const rid = await watch(trio, id);
    await laptop.page.evaluate(() => document.querySelector('#agent-folder-chip').click());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    assert.equal(await textOf(laptop, '#fb-home'), homeName);
    assert.equal(await shownPath(), tree, "home's default place for this chat");
    assert.deepEqual(await names(), ['a&lt;b&gt;', 'big', 'pick', 'rtl\\u202Egnp.exe'], 'folders only, and what hides shown as a code');
    assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('#fb-list b').length), 0);

    await clickEntry('big');
    await settled();
    assert.equal(await shownPath(), big);
    const inBig = await names();
    assert.equal(inBig.length, 200, 'capped after filtering, so the folders show even behind 300 files');
    assert.ok(inBig.every((n) => /^z\d{3}$/.test(n)));
    assert.equal(inBig[0], 'z000');
    assert.equal(await textOf(laptop, '#fb-more'), '50 more folders not shown.');

    await laptop.page.evaluate(() => document.querySelector('#fb-up').click());
    await settled();
    assert.equal(await shownPath(), tree, 'Up');
    const roots = await textsOf(laptop, '#fb-roots .fb-root');
    assert.ok(roots.length >= 1, 'the drives, or the root');
    if (process.platform === 'win32') assert.ok(roots.includes(`${tree.slice(0, 2).toUpperCase()}\\`), roots.join(' '));
    else assert.deepEqual(roots, ['/']);

    await clickEntry('pick');
    await settled();
    const before = await home.page.evaluate((chatId) => state.chats[chatId].projectFolder, id);
    assert.equal(before, tree);
    await laptop.page.evaluate(() => document.querySelector('#fb-choose').click());
    await waitFor('home to set it', () => home.page.evaluate(([chatId, p]) => state.chats[chatId].projectFolder === p, [id, pick]), 10000);
    await waitFor('the browser to close', async () => !(await browserOpen()), 5000);
    await waitFor('the laptop to show it through the mirror', () => laptop.page.evaluate(([k, p]) => state.chats[k].projectFolder === p, [rid, pick]), 5000);
    assert.deepEqual(await home.page.evaluate((chatId) => state.chats[chatId].pathAllowlist, id), [pick], 'the old folder no longer allowed');
    assert.equal(await textOf(laptop, '#fb-list'), '', 'nothing of it left in the page');
  });

  await t.test('a chat with no folder at home starts in the home folder, and refusals from home show and change nothing', async () => {
    const id = await newChat(home, { ...project });
    await watch(trio, id);
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    assert.equal(await shownPath(), os.homedir());

    await goTo(home.profile);
    assert.equal(await textOf(laptop, '#fb-error'), PROFILE_REFUSED);
    assert.equal(await shownPath(), os.homedir(), 'still where it was');

    const doomed = path.join(tree, 'doomed');
    fs.mkdirSync(doomed);
    await goTo(doomed);
    assert.equal(await shownPath(), doomed);
    fs.rmSync(doomed, { recursive: true });
    await laptop.page.evaluate(() => document.querySelector('#fb-choose').click());
    await settled();
    assert.equal(await textOf(laptop, '#fb-error'), "That folder isn't available on the home PC.");
    assert.equal(await browserOpen(), true);
    assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].projectFolder, id), undefined, 'nothing was set');

    // The switch on the laptop isn't what list-dir and set-folder are about.
    assert.equal((await laptop.remote('status')).controlAllowed, false);

    // A lock takes it down, and every name with it.
    await laptop.remote('lock');
    await waitFor('the browser to close', async () => !(await browserOpen()), 5000);
    assert.equal(await textOf(laptop, '#fb-list'), '');
    assert.equal(await textOf(laptop, '#fb-path'), '');
    assert.equal((await laptop.remote('unlock', PIN)).ok, true);
  });

  await t.test('whatever a home sends for a listing is checked: markup is text, odd names are shown or left out, other shapes are refused', async () => {
    const id = await newChat(home, { ...project, projectFolder: tree, pathAllowlist: [tree] });
    await watch(trio, id);
    await laptop.page.evaluate(() => {
      window.__realActionToHome = actionToHome;
      window.__forged = null;
      actionToHome = (deviceId, chatId, kind, args, options) => (kind === 'list-dir' && window.__forged ? Promise.resolve(window.__forged) : window.__realActionToHome(deviceId, chatId, kind, args, options));
    });
    const forge = (answer) => laptop.page.evaluate((a) => { window.__forged = a; }, answer);

    await forge({ ok: true, path: tree, entries: ['<img src=x onerror="window.__pwned=1">', 'line\nbreak', 'zero​width', 5, { name: 'x' }, '..', 'a/b', 'a\\b'], more: 0 });
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    assert.deepEqual(await names(), ['<img src=x onerror="window.__pwned=1">', 'line\\u000Abreak', 'zero\\u200Bwidth']);
    assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('#folder-browser-overlay img').length), 0);
    assert.equal(await laptop.page.evaluate(() => window.__pwned), undefined);
    assert.deepEqual(await laptop.page.evaluate(() => [...document.querySelectorAll('#fb-list .fb-entry')].map((el) => el.disabled)), [false, true, false], 'a name with a line break can\'t be used');

    // A drive's name is shown as text too, hidden characters and all.
    await forge({ ok: true, path: tree, entries: [], more: 0, roots: ['C:\\', '/\u202Ex'] });
    await laptop.page.evaluate(() => { remoteUi.folders.roots = []; });
    await goTo('');
    assert.deepEqual(await textsOf(laptop, '#fb-roots .fb-root'), ['C:\\', '/\\u202Ex']);
    await forge({ ok: true, path: tree, entries: Array.from({ length: 500 }, (_, i) => `d${i}`), more: 7 });
    await goTo(tree);
    assert.equal((await names()).length, 200);
    assert.equal(await textOf(laptop, '#fb-more'), '307 more folders not shown.');

    for (const bad of [{ ok: true, path: 'relative/place', entries: [] }, { ok: true, path: '\\\\server\\share', entries: [] }, { ok: true, path: tree, entries: 'a,b' }, { ok: true, path: `${tree}\n`, entries: [] }]) {
      await forge(bad);
      await goTo(tree);
      assert.equal(await textOf(laptop, '#fb-error'), LISTING_REFUSED, JSON.stringify(bad));
    }
    await forge({ ok: false, error: '<b>no</b>‮txt' });
    await goTo(tree);
    assert.equal(await textOf(laptop, '#fb-error'), '<b>no</b>\\u202Etxt');
    assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('#folder-browser-overlay b').length), 0);
    await laptop.page.evaluate(() => {
      closeFolderBrowser();
      window.__forged = null;
      actionToHome = window.__realActionToHome;
    });
  });

  await t.test("while home's kind of machine isn't known, Up, choosing and going in do nothing, and it says so", async () => {
    const id = await newChat(home, { ...project, projectFolder: tree, pathAllowlist: [tree] });
    await watch(trio, id);
    const saved = await laptop.page.evaluate((h) => { const os = mirror.homes.get(h).info.os; mirror.homes.get(h).info.os = null; return os; }, trio.homeId);
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    assert.equal(await visible(laptop, '#fb-wait'), true);
    assert.equal(await textOf(laptop, '#fb-wait'), 'Waiting for the home PC.');
    assert.deepEqual(await laptop.page.evaluate(() => ['#fb-up', '#fb-choose'].map((sel) => document.querySelector(sel).disabled)), [true, true]);
    assert.ok(await laptop.page.evaluate(() => [...document.querySelectorAll('#fb-list .fb-entry')].every((el) => el.disabled)));
    const asked = (await laptop.frames()).length;
    await laptop.page.evaluate(() => {
      const fb = remoteUi.folders;
      [...document.querySelectorAll('#fb-list .fb-entry')][0].click();
      document.querySelector('#fb-up').click();
      document.querySelector('#fb-choose').click();
      return fb.busy;
    });
    await sleep(500);
    assert.equal((await laptop.frames()).length, asked, 'nothing was asked of home');
    assert.equal(await shownPath(), tree);
    // Home's details arrive, as they do in a snapshot, and it works again.
    await laptop.page.evaluate(([h, os]) => { mirror.homes.get(h).info.os = os; paintFolderBrowser(); }, [trio.homeId, saved]);
    assert.equal(await visible(laptop, '#fb-wait'), false);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#fb-choose').disabled), false);
    await laptop.page.evaluate(() => closeFolderBrowser());
  });

  // ---- This laptop's own folder, recorded at home ----

  const laptopDir2 = path.join(root, 'laptop-folder-2');
  const otherDir = path.join(root, 'other-laptop-folder');
  fs.mkdirSync(laptopDir2);
  const OTHER_LAPTOP = 'aaaaaaaaaaaaaaaa';
  const pickOnLaptop = (folder) => laptop.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, folder);
  const laptopFolderAtHome = (id) => home.page.evaluate(([chatId, device]) => state.chats[chatId].projectFolders?.[device] ?? null, [id, trio.laptopId]);
  const actionResult = async (frame) => {
    assert.equal(await laptop.remote('send', trio.homeId, frame), true);
    return waitFor(`the answer to ${frame.id}`, async () => (await laptop.frames()).find((f) => f.type === 'action-result' && f.id === frame.id), 10000);
  };
  let laptopProject = null;

  await t.test("a laptop chooses its own folder with the system dialog, home records it under that laptop, and the mirror brings it back", async () => {
    // Another laptop already has a folder in this chat. This one mustn't read it as its own, or touch it.
    const id = await newChat(home, { ...project, projectFolder: tree, pathAllowlist: [tree], projectFolders: { [OTHER_LAPTOP]: otherDir }, pathAllowlists: { [trio.laptopId]: [laptopDir, laptopDir2], [OTHER_LAPTOP]: [otherDir] } });
    laptopProject = id;
    const rid = await watch(trio, id);
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    assert.equal(await textOf(laptop, '#fb-laptop-path'), 'None chosen');
    assert.equal(await visible(laptop, '#fb-laptop-clear'), false);

    await pickOnLaptop(laptopDir2);
    await laptop.page.evaluate(() => document.querySelector('#fb-laptop-choose').click());
    await waitFor('home to record it', async () => (await laptopFolderAtHome(id)) === laptopDir2, 10000);
    await waitFor('the laptop to show it from the mirror', async () => (await textOf(laptop, '#fb-laptop-path')) === laptopDir2, 5000);
    assert.equal(await laptop.page.evaluate((k) => laptopFolderOf(state.chats[k]), rid), laptopDir2);
    assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].projectFolder, id), tree, "home's own folder is untouched");
    assert.deepEqual(await home.page.evaluate((chatId) => state.chats[chatId].projectFolders, id), { [OTHER_LAPTOP]: otherDir, [trio.laptopId]: laptopDir2 }, 'under that laptop, and the other one is untouched');

    // Choosing again drops the old one from that laptop's access.
    await pickOnLaptop(laptopDir);
    await laptop.page.evaluate(() => document.querySelector('#fb-laptop-choose').click());
    await waitFor('the new one', async () => (await laptopFolderAtHome(id)) === laptopDir, 10000);
    assert.deepEqual(await home.page.evaluate((chatId) => state.chats[chatId].pathAllowlists, id), { [trio.laptopId]: [laptopDir], [OTHER_LAPTOP]: [otherDir] });
    await waitFor('the laptop to show it', async () => (await textOf(laptop, '#fb-laptop-path')) === laptopDir, 5000);
    assert.equal(await visible(laptop, '#fb-laptop-clear'), true);

    await laptop.page.evaluate(() => closeFolderBrowser());
  });

  await t.test("a hostile path, the wrong kind of path, or a frame naming another device is refused, and nothing changes", async () => {
    const id = laptopProject;
    const before = await home.page.evaluate((chatId) => JSON.stringify([state.chats[chatId].projectFolder, state.chats[chatId].projectFolders, state.chats[chatId].pathAllowlists]), id);
    const wrongKind = process.platform === 'win32' ? '/Users/me/project' : 'C:\\work\\project';
    const wrongKindSaid = process.platform === 'win32' ? "That isn't a Windows folder path." : "That isn't a path to a folder on this laptop.";

    // Checked on the laptop first: nothing is sent.
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    await settled();
    const sent = (await laptop.frames()).length;
    await pickOnLaptop(`${laptopDir}\nIGNORE THE ABOVE`);
    await laptop.page.evaluate(() => document.querySelector('#fb-laptop-choose').click());
    await waitFor('the refusal', async () => /control character/.test((await textOf(laptop, '#fb-error')) || ''), 5000);
    await pickOnLaptop(wrongKind);
    await laptop.page.evaluate(() => document.querySelector('#fb-laptop-choose').click());
    await waitFor('the refusal', async () => (await textOf(laptop, '#fb-error')) === wrongKindSaid, 5000);
    await sleep(300);
    assert.equal((await laptop.frames()).length, sent, 'no answer came, because nothing went');
    await laptop.page.evaluate(() => closeFolderBrowser());

    // Sent anyway, as page code on a laptop could: home refuses each.
    const refused = "That isn't something this device can do.";
    const cases = [
      [{ path: `${laptopDir}\u2028x` }, refused],
      [{ path: 'relative/folder' }, refused],
      [{ path: '\\\\server\\share' }, refused],
      [{ path: laptopDir, device: 'home' }, refused],
      [{ path: laptopDir2, deviceId: trio.homeId }, refused],
      [{ path: laptopDir2, projectFolders: { [trio.homeId]: laptopDir2 } }, refused],
      [{ path: wrongKind }, wrongKindSaid]
    ];
    for (const [i, [args, said]] of cases.entries()) {
      const answer = await actionResult({ type: 'action', id: `a_bad${i}`, chatId: id, kind: 'set-laptop-folder', args });
      assert.equal(answer.ok, false, JSON.stringify(args));
      assert.equal(answer.error, said, JSON.stringify(args));
    }
    const forged = await actionResult({ type: 'action', id: 'a_bad_frame', chatId: id, kind: 'set-laptop-folder', args: { path: laptopDir2 }, deviceId: trio.homeId });
    assert.equal(forged.ok, false, 'a frame that names a device is refused');
    // Not a project, so no folder.
    const plain = await shareOne(home);
    await waitFor('the plain chat on the laptop', () => laptop.page.evaluate((k) => Boolean(state.chats[k]), key(plain)), 5000);
    assert.equal((await actionResult({ type: 'action', id: 'a_plain', chatId: plain, kind: 'set-laptop-folder', args: { path: laptopDir } })).error, 'Only a project has a folder.');
    const after = await home.page.evaluate((chatId) => JSON.stringify([state.chats[chatId].projectFolder, state.chats[chatId].projectFolders, state.chats[chatId].pathAllowlists]), id);
    assert.equal(after, before);
    assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].projectFolders, plain), undefined);

    // And a home that mirrors back something for this laptop that couldn't have been chosen doesn't
    // get it used. The next snapshot puts the real one back.
    const used = await laptop.page.evaluate((k) => {
      const c = state.chats[k];
      const own = remoteStatusNow().deviceId;
      return ['relative/place', 'C:\\a\nb', '\\\\server\\share', 'C:\\a\\..\\b'].map((bad) => {
        ChatMirror.applyOps(c, [{ type: 'meta', set: { projectFolders: { [own]: bad } } }]);
        return laptopFolderOf(c);
      });
    }, key(id));
    assert.deepStrictEqual(used, [null, null, null, null]);
  });

  await t.test("the laptop's folder survives the laptop restarting, because home holds it", async () => {
    const rid = key(laptopProject);
    const profile = laptop.profile;
    await laptop.quit();
    laptop = await launch('laptop', ollama, { profile });
    trio.laptop = laptop;
    laptopPid = await laptop.app.evaluate(() => process.pid);
    assert.equal((await laptop.remote('unlock', PIN)).ok, true);
    await waitFor('the laptop back on', async () => (await laptop.entry(trio.homeId))?.connected && (await home.entry(trio.laptopId))?.connected, 30000);
    await waitFor('the chat back on the laptop', () => laptop.page.evaluate((k) => Boolean(state.chats[k]), rid), 15000);
    assert.equal(await laptop.page.evaluate((k) => laptopFolderOf(state.chats[k]), rid), laptopDir);
    assert.equal(await laptop.page.evaluate(() => remoteStatusNow().deviceId), trio.laptopId, 'found under the id home knows it by');

    // An empty path clears it, and only this laptop's.
    assert.equal((await actionResult({ type: 'action', id: 'a_clear', chatId: laptopProject, kind: 'set-laptop-folder', args: { path: '' } })).ok, true);
    await waitFor('it gone on the laptop', () => laptop.page.evaluate((k) => laptopFolderOf(state.chats[k]) === null, rid), 5000);
    assert.deepEqual(await home.page.evaluate((chatId) => state.chats[chatId].projectFolders, laptopProject), { [OTHER_LAPTOP]: otherDir });
    assert.deepEqual(await home.page.evaluate((chatId) => state.chats[chatId].pathAllowlists, laptopProject), { [trio.laptopId]: [], [OTHER_LAPTOP]: [otherDir] }, 'and its access with it');
  });

  await t.test("with its only folder on a laptop that isn't available, a call is a clear error, and naming home with a full path works", async () => {
    // Every command writes to a full path in this temp folder, so whatever happens, nothing can land
    // anywhere else. A command that ran in a default place would still only write here.
    const dir = path.join(root, 'only-on-laptop');
    fs.mkdirSync(dir);
    const marker = (name) => path.join(dir, name);
    const into = (name) => `"${marker(name).replace(/\\/g, '/')}"`;
    const UNAVAILABLE = `This chat's folder is on laptop, which isn't available right now. Wait for it to connect and allow control, or give device: "home" with a full path.`;
    const id = await newChat(home, { ...project, planMode: false, noApproval: true, projectFolders: { [trio.laptopId]: laptopDir }, pathAllowlists: { [trio.laptopId]: [laptopDir] } });
    // The model calls one tool, and what it gets back is read from its next request.
    const callOnce = async (args) => {
      await home.page.evaluate((chatId) => { submitToChat(state.chats[chatId], 'Go', []).catch(() => {}); }, id);
      const first = await ollama.next();
      first.call('run_command', args);
      first.finish();
      const second = await ollama.next();
      const tool = second.body.messages.filter((m) => m.role === 'tool').at(-1);
      second.say('Done.');
      second.finish();
      await waitFor('the reply to finish', () => home.page.evaluate((chatId) => !state.runningChats.has(chatId), id), 10000);
      return JSON.parse(tool.content);
    };
    const prompts = () => home.page.evaluate((chatId) => ({ folder: projectFolderPrompt(state.chats[chatId]), devices: devicesPrompt(state.chats[chatId]) }), id);
    const hears = (want) => waitFor(`home to hear the switch is ${want}`, () => home.page.evaluate(([d, v]) => (remoteTools.control.get(d)?.allowed === true) === v, [trio.laptopId, want]), 10000);
    const switchedOff = async () => {
      const said = await callOnce({ command: `echo x > ${into('no-device.txt')}` });
      assert.equal(said.error, UNAVAILABLE);
      assert.equal(fs.existsSync(marker('no-device.txt')), false, 'nothing ran');
      const { folder, devices } = await prompts();
      assert.match(folder, /on the device "laptop", which isn't available right now/);
      assert.ok(!/the project folder/i.test(folder), folder);
      assert.ok(!folder.includes(laptopDir), 'and no path that could be taken for a place to work');
      assert.equal(devices, null);
      fs.rmSync(marker('no-device.txt'), { force: true });
    };

    await switchedOff();
    const atHome = await callOnce({ command: `echo x > ${into('home-full.txt')}`, device: 'home', cwd: dir });
    assert.equal(atHome.error, undefined, JSON.stringify(atHome));
    assert.equal(fs.existsSync(marker('home-full.txt')), true, 'home, given a full cwd, runs there');
    const blank = await callOnce({ command: `echo x > ${into('home-blank.txt')}`, device: 'home' });
    assert.match(String(blank.error), /full path/);
    assert.equal(fs.existsSync(marker('home-blank.txt')), false, 'a blank cwd at home is an error, not the home folder');
    const relative = await callOnce({ command: `echo x > ${into('home-relative.txt')}`, device: 'home', cwd: 'sub' });
    assert.ok(relative.error);
    assert.equal(fs.existsSync(marker('home-relative.txt')), false);

    // Switch on: the laptop's folder is the default, and the call goes there.
    assert.deepEqual(await laptop.remote('setControlAllowed', true), { ok: true });
    await hears(true);
    const onLaptop = await callOnce({ command: `pwd > ${into('where.txt')}` });
    assert.equal(onLaptop.error, undefined, JSON.stringify(onLaptop));
    assert.match(fs.readFileSync(marker('where.txt'), 'utf8'), /laptop-folder/, "it ran in the laptop's folder");
    const on = await prompts();
    assert.ok(on.folder.includes(`PROJECT FOLDER: ${JSON.stringify(laptopDir)} (on the device "laptop")`), on.folder);
    assert.ok(on.devices.includes(`the project folder at the path ${JSON.stringify(laptopDir)}`), on.devices);
    // With a folder at home too, home's is the project folder and the laptop's is only a folder there.
    const both = await newChat(home, { ...project, projectFolder: tree, pathAllowlist: [tree], projectFolders: { [trio.laptopId]: laptopDir } });
    const bothSaid = await home.page.evaluate((chatId) => devicesPrompt(state.chats[chatId]), both);
    assert.ok(bothSaid.includes(`the project folder at the path ${JSON.stringify(tree)}`), bothSaid);
    assert.ok(bothSaid.includes(`a folder at the path ${JSON.stringify(laptopDir)}`), bothSaid);
    assert.ok(!bothSaid.includes(`the project folder at the path ${JSON.stringify(laptopDir)}`));

    // Switch off again: the error is back.
    assert.deepEqual(await laptop.remote('setControlAllowed', false), { ok: true });
    await hears(false);
    await switchedOff();

    // A chat with no folders anywhere is as it always was: a blank cwd is home's own default.
    const plain = await home.page.evaluate(() => {
      const c = { modality: 'agent', projectFolders: {} };
      return { target: toolTarget('run_command', { command: 'x' }, c).device?.id, fields: toolRunFields('run_command', { command: 'x' }, c, toolDevices()[0]) };
    });
    assert.deepEqual(plain, { target: 'home', fields: { fields: { command: 'x', cwd: '' } } });

    // The laptop says what that means, in one plain line.
    await watch(trio, id);
    await laptop.page.evaluate(() => pickProjectFolder());
    await waitFor('the browser', browserOpen, 5000);
    assert.equal(await textOf(laptop, '.fb-laptop .setting-help'), "When the home PC has no folder for this chat, the home PC's model works here while this laptop allows it.");
    await laptop.page.evaluate(() => closeFolderBrowser());
  });

  // ---- Run on a code block ----

  const markerFile = path.join(markers, 'runs.jsonl');
  const runs = () => (fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const snippet = `require('fs').appendFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ ppid: process.ppid, cwd: process.cwd() }) + '\\n');`;
  const withCode = async (code, fields = {}) => {
    const id = await shareOne(home, fields);
    await home.page.evaluate(([chatId, body]) => {
      const c = state.chats[chatId];
      c.messages.push({ role: 'user', content: 'Write some code' }, { role: 'assistant', content: '```js\n' + body + '\n```' });
      saveToStorage();
    }, [id, code]);
    const rid = await watch(trio, id);
    await waitFor('the code block on the laptop', () => laptop.page.evaluate(() => Boolean(document.querySelector('#thread button[data-cb-action="output"]'))), 5000);
    return { id, rid };
  };
  const clickRun = (device) => device.page.evaluate(() => document.querySelector('#thread button[data-cb-action="output"]').click());
  const confirmUp = () => waitFor('the Run confirmation', async () => (await visible(laptop, '#run-confirm-overlay')) && (await laptop.page.evaluate(() => document.querySelector('#run-confirm-overlay').dataset.shown === 'yes')), 5000);
  const outputDone = (device) => waitFor('the run to finish', async () => /^Ran on /.test((await textOf(device, '.output-overlay [data-foot-machine]')) || ''), 20000);
  const closeOutput = (device) => device.page.evaluate(() => document.querySelector('.output-overlay [data-out-action="close"]').click());

  await t.test('Run on the laptop asks first, showing the whole code, the machine, and the folder, with the guard', async () => {
    const framesBefore = (await home.frames()).length;
    await withCode(snippet);
    await clickRun(laptop);
    await confirmUp();
    assert.equal(await textOf(laptop, '#run-confirm-machine'), `This laptop, ${laptopName}`);
    assert.equal(await textOf(laptop, '#run-confirm-folder'), 'This chat has no folder on this laptop, so it runs in a temporary folder.');
    assert.equal(await textOf(laptop, '#run-confirm-lang'), 'JavaScript (Node)', 'and what it runs as');
    assert.equal(await textOf(laptop, '#run-confirm-code'), snippet);
    assert.ok((await textOf(laptop, '#run-confirm-desc')).includes(homeName));
    assert.equal(await textOf(laptop, '#run-confirm-run'), 'Run on this laptop');

    // Straight away is too soon: the guard holds every choice but Cancel.
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-run').click());
    await sleep(200);
    assert.equal(await visible(laptop, '#run-confirm-overlay'), true);
    assert.equal(await visible(laptop, '.output-overlay'), false);
    assert.deepEqual(runs(), []);

    await sleep(900);
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-run').click());
    await outputDone(laptop);
    assert.equal(await textOf(laptop, '.output-overlay [data-foot-machine]'), `Ran on ${laptopName}`);
    const ran = runs();
    assert.equal(ran.length, 1);
    assert.equal(ran[0].ppid, laptopPid, 'it ran on the laptop');
    assert.notEqual(ran[0].ppid, homePid);
    assert.equal(fs.realpathSync(ran[0].cwd), fs.realpathSync(os.tmpdir()), 'in the usual temporary folder');
    assert.equal(await textOf(laptop, '#run-confirm-code'), '', 'the pop-up took its words with it');
    await closeOutput(laptop);
    // Nothing went to home's tools for it.
    assert.ok(!(await home.frames()).slice(framesBefore).some((f) => f.type === 'tool-result' || f.type === 'tool-call'));
  });

  await t.test("in the laptop's folder for this chat, as home records it, without the switch, and Cancel runs nothing", async () => {
    const { id, rid } = await withCode(snippet, { ...project });
    assert.equal((await laptop.remote('status')).controlAllowed, false, 'the switch is off');
    const set = await actionResult({ type: 'action', id: 'a_run_folder', chatId: id, kind: 'set-laptop-folder', args: { path: laptopDir } });
    assert.equal(set.ok, true);
    await waitFor('the folder back through the mirror', () => laptop.page.evaluate(([k, dir]) => laptopFolderOf(state.chats[k]) === dir, [rid, laptopDir]), 5000);
    await laptop.page.evaluate(() => { remoteAsks.guardMs = 0; });
    t.after(() => laptop.page.evaluate(() => { remoteAsks.guardMs = 800; }).catch(() => {}));

    await clickRun(laptop);
    await confirmUp();
    assert.equal(await textOf(laptop, '#run-confirm-folder'), laptopDir);
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-cancel').click());
    await sleep(500);
    assert.equal(await visible(laptop, '.output-overlay'), false);
    const count = runs().length;

    await clickRun(laptop);
    await confirmUp();
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-run').click());
    await outputDone(laptop);
    const ran = runs();
    assert.equal(ran.length, count + 1);
    assert.equal(ran.at(-1).ppid, laptopPid);
    assert.equal(fs.realpathSync(ran.at(-1).cwd), fs.realpathSync(laptopDir));
    await closeOutput(laptop);
  });

  await t.test('Run at home is as it was: no question, and the panel names the home PC', async () => {
    const { id } = await withCode(snippet);
    await openChat(home, id);
    await waitFor('the code block at home', () => home.page.evaluate(() => Boolean(document.querySelector('#thread button[data-cb-action="output"]'))), 5000);
    const count = runs().length;
    await clickRun(home);
    await outputDone(home);
    assert.equal(await visible(home, '#run-confirm-overlay'), false);
    assert.equal(await textOf(home, '.output-overlay [data-foot-machine]'), `Ran on ${homeName}`);
    assert.equal(runs().length, count + 1);
    assert.equal(runs().at(-1).ppid, homePid);
    await closeOutput(home);
  });

  await t.test('hidden characters show as codes and a long block says how much is below', async () => {
    const long = `// first line\n${Array.from({ length: 80 }, (_, i) => `// line ${i}`).join('\n')}\nconsole.log('‮end')`;
    await withCode(long);
    await clickRun(laptop);
    await confirmUp();
    assert.equal(await textOf(laptop, '#run-confirm-overlay .ask-hidden-note'), 'This has hidden characters, shown here as codes.');
    assert.ok((await textOf(laptop, '#run-confirm-code')).includes('\\u202E'));
    assert.match(await textOf(laptop, '#run-confirm-overlay .ask-more-lines'), /^\d+ more lines below$/);
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-cancel').click());
  });

  await t.test('nothing runs while the laptop is locked', async () => {
    const { rid } = await withCode(snippet);
    const count = runs().length;
    await clickRun(laptop);
    await confirmUp();
    await laptop.remote('lock');
    await waitFor('the confirmation to go', async () => !(await visible(laptop, '#run-confirm-overlay')), 5000);
    assert.equal(await textOf(laptop, '#run-confirm-code'), '');
    // Asked again while locked, as page code could.
    await laptop.page.evaluate(([k, body]) => confirmLaptopRun(state.chats[k], { code: body, lang: 'js', filename: 'x.js' }), [rid, snippet]);
    await sleep(300);
    assert.equal(await visible(laptop, '#run-confirm-overlay'), false);
    assert.equal(await visible(laptop, '.output-overlay'), false);
    assert.equal(runs().length, count);
    assert.equal((await laptop.remote('unlock', PIN)).ok, true);
  });

  const runNow = () => laptop.page.evaluate(() => document.querySelector('#run-confirm-run').click());
  const panelGone = () => waitFor('the panel to go', () => laptop.page.evaluate(() => !document.querySelector('.output-overlay')), 5000);

  await t.test('a lock takes down output panels from home chats, and Rerun runs nothing while locked and asks first otherwise', async () => {
    await laptop.page.evaluate(() => { remoteAsks.guardMs = 0; });
    const { rid } = await withCode(snippet);
    await clickRun(laptop);
    await confirmUp();
    await runNow();
    await outputDone(laptop);
    const count = runs().length;
    await laptop.page.evaluate(() => { window.__panel = document.querySelector('.output-overlay'); });

    await laptop.page.evaluate(() => window.__panel.querySelector('[data-out-action="rerun"]').click());
    await confirmUp();
    assert.equal(await textOf(laptop, '#run-confirm-code'), snippet, 'Rerun shows the code again');
    await laptop.page.evaluate(() => document.querySelector('#run-confirm-cancel').click());
    await sleep(300);
    assert.equal(runs().length, count, 'Cancel ran nothing');

    await laptop.remote('lock');
    await panelGone();
    assert.equal(await laptop.page.evaluate(() => window.__panel.querySelector('[data-terminal]').textContent), '', 'and what it printed with it');
    await laptop.page.evaluate(() => document.querySelector('#remote-pin-later').click());
    assert.equal(await laptop.page.evaluate(() => remoteChatsHidden()), true);
    await laptop.page.evaluate(() => window.__panel.querySelector('[data-out-action="rerun"]').click());
    await sleep(1000);
    assert.equal(runs().length, count, 'nothing ran');
    assert.equal(await visible(laptop, '#run-confirm-overlay'), false);
    // A panel opened straight from page code while locked runs nothing either, and doesn't stay.
    await laptop.page.evaluate(([k, body]) => openOutputModal({ code: body, lang: 'js', filename: 'x.js', chatKey: k, machine: 'x' }), [rid, snippet]);
    await sleep(800);
    assert.equal(runs().length, count);
    assert.equal(await laptop.page.evaluate(() => Boolean(document.querySelector('.output-overlay'))), false);
    assert.equal((await laptop.remote('unlock', PIN)).ok, true);
  });

  await t.test('a Run confirmation or an output panel goes with its chat, and can run nothing after', async () => {
    await laptop.page.evaluate(() => { remoteAsks.guardMs = 0; });
    const first = await withCode(snippet);
    await clickRun(laptop);
    await confirmUp();
    await setShared(home, first.id, false);
    await waitFor('the confirmation to go', async () => !(await visible(laptop, '#run-confirm-overlay')), 5000);
    await runNow();

    const second = await withCode(snippet);
    await clickRun(laptop);
    await confirmUp();
    await runNow();
    await outputDone(laptop);
    const count = runs().length;
    await laptop.page.evaluate(() => { window.__panel = document.querySelector('.output-overlay'); });
    await home.page.evaluate((chatId) => deleteChat(chatId), second.id);
    await panelGone();
    await laptop.page.evaluate(() => window.__panel.querySelector('[data-out-action="rerun"]').click());
    await sleep(800);
    assert.equal(runs().length, count);
    assert.equal(await visible(laptop, '#run-confirm-overlay'), false);
  });

  await t.test('the Run confirmation guards again when the window comes back from minimized', async () => {
    await laptop.page.evaluate(() => { remoteAsks.guardMs = 800; });
    await withCode(snippet);
    await clickRun(laptop);
    await confirmUp();
    await sleep(1000);
    const count = runs().length;
    await laptop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).minimize());
    await waitFor('minimized', () => laptop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).isMinimized()), 5000);
    await laptop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html')).restore());
    await runNow();
    await sleep(300);
    assert.equal(runs().length, count, 'too soon after it came back');
    assert.equal(await visible(laptop, '#run-confirm-overlay'), true);
    await sleep(900);
    await runNow();
    await outputDone(laptop);
    assert.equal(runs().length, count + 1);
    await closeOutput(laptop);
  });

  await t.test("a home pop-up that arrived while hidden guards again once the window is shown", async () => {
    const dir = path.join(root, 'while-hidden');
    fs.mkdirSync(dir);
    const marker = path.join(dir, 'approved.txt');
    const id = await newChat(home, { ...project, planMode: false, approvalMode: true, projectFolder: dir, pathAllowlist: [dir] });
    await openChat(home, id);
    await closeMainWindow(home);
    await waitFor('home to hide', async () => (await mainWindowFacts(home))?.visible === false, 5000);
    await home.page.evaluate((chatId) => { submitToChat(state.chats[chatId], 'Go', []).catch(() => {}); }, id);
    const first = await ollama.next();
    first.call('run_command', { command: 'echo yes > approved.txt', cwd: dir });
    first.finish();
    await waitFor('the pop-up, painted while hidden', () => home.page.evaluate(() => document.querySelector('#approval-overlay').dataset.shown === 'yes'), 10000);
    await sleep(1200);

    await peek(home, 'clickTrayIcon');
    await waitFor('home shown', async () => (await mainWindowFacts(home))?.visible === true, 5000);
    await home.page.evaluate(() => document.querySelector('#approval-approve').click());
    await sleep(300);
    assert.equal(fs.existsSync(marker), false, 'nothing ran: nobody could have read it yet');
    assert.equal(await visible(home, '#approval-overlay'), true);

    await sleep(900);
    await home.page.evaluate(() => document.querySelector('#approval-approve').click());
    const second = await ollama.next();
    second.say('Done.');
    second.finish();
    await waitFor('the command to run', () => fs.existsSync(marker), 10000);
    await waitFor('the reply to finish', () => home.page.evaluate((chatId) => !state.runningChats.has(chatId), id), 10000);
  });

});
