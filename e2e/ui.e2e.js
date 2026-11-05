// The Remote Control interface, on real instances against the real relay Worker in Miniflare.
// Everything a person does here is a real click or real typing, except where a test has to
// reach a state nothing else can produce, which it says where it does so.
//
//   node e2e/ui.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  startRelay, startFakeOllama, startScriptedOllama, launchDevice, waitFor, sleep, PIN, SECRET, newChat, openChat, submit, remoteId, hasChat, threadOf
} = require('./harness.js');

const HOSTILE = '<img src=x onerror="window.__xss=1">';
const WRONG_CODE = "That code didn't work. Check it and try again.";
const CANCELLED = 'That code was cancelled. Get a new one.';
const CODE_HINT = 'Enter this code on your laptop. It works once and expires in 10 minutes.';
const MINUTE = 60 * 1000;

const isVisible = (device, selector) =>
  device.page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }, selector);

const textOf = (device, selector) => device.page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
const count = (device, selector) => device.page.evaluate((s) => document.querySelectorAll(s).length, selector);
const click = (device, selector) => device.page.click(selector, { timeout: 10000 });
const fill = (device, selector, value) => device.page.fill(selector, value, { timeout: 10000 });
const domHas = (device, text) => device.page.evaluate((t) => document.documentElement.outerHTML.includes(t), text);
// Where in the page some text is, or null, which makes for a failure that says.
const foundIn = (device, text) =>
  device.page.evaluate((t) => {
    const html = document.documentElement.outerHTML;
    const at = html.indexOf(t);
    return at < 0 ? null : html.slice(Math.max(0, at - 120), at + t.length + 40);
  }, text);
const status = (device) => device.remote('status');
const appeared = (device, selector, ms = 5000) => waitFor(`${device.name} to show ${selector}`, () => isVisible(device, selector), ms);
const gone = (device, selector, ms = 5000) => waitFor(`${device.name} to stop showing ${selector}`, async () => !(await isVisible(device, selector)), ms);
const said = (device, selector, text, ms = 5000) => waitFor(`${device.name} to say ${JSON.stringify(text)} in ${selector}`, async () => (await textOf(device, selector)) === text, ms);

async function openDevices(device) {
  await click(device, '#open-settings');
  await click(device, '.set-nav-btn[data-panel="devices"]');
  await appeared(device, '#remote-address');
}

const closeSettings = (device) => click(device, '#settings-close');

async function saveAddress(device, address) {
  await fill(device, '#remote-address', address);
  await click(device, '#remote-address-save');
  await waitFor(`${device.name}'s address to take`, async () => (await status(device)).enabled === true);
}

async function toggleShare(device) {
  if (!(await isVisible(device, '#toggle-remote'))) await click(device, '#tools-menu-btn');
  await click(device, '#toggle-remote');
}

const closeToolsMenu = (device) => device.page.evaluate(() => { if (!document.querySelector('#tools-menu').hidden) document.querySelector('#tools-menu-btn').click(); });

// A code is good from when the host's connection to the relay opens, a moment after it's shown.
// "Cancelled" before that means nobody is waiting yet, which never counts against the code, so
// asking again is safe. A person can't type six characters that fast.
async function submitCode(device, code, { pin, pin2 = pin, untilOpen = true } = {}) {
  const deadline = Date.now() + 10000;
  for (;;) {
    await fill(device, '#remote-connect-code', code);
    if (pin !== undefined) {
      await fill(device, '#remote-connect-pin', pin);
      await fill(device, '#remote-connect-pin2', pin2);
    }
    await click(device, '#remote-connect-submit');
    await waitFor('the attempt to finish', () =>
      device.page.evaluate(() => document.querySelector('#remote-connect-overlay').hidden || !document.querySelector('#remote-connect-submit').disabled), 40000);
    const error = await device.page.evaluate(() => (document.querySelector('#remote-connect-overlay').hidden ? null : document.querySelector('#remote-connect-error').textContent));
    if (error !== CANCELLED || !untilOpen || Date.now() > deadline) return error;
    await sleep(100);
  }
}

async function shownCode(device) {
  await appeared(device, '#remote-code-value', 15000);
  const code = await textOf(device, '#remote-code-value');
  assert.match(code, /^[2-9A-Z]{6}$/);
  return code;
}

// Moves this page's clock on, for whatever draws from it and for the idle check. Everything
// that isn't this page keeps real time.
const shiftClock = (device, ms) =>
  device.page.evaluate((by) => {
    if (!window.__realNow) window.__realNow = Date.now.bind(Date);
    window.__clockShift = (window.__clockShift || 0) + by;
    Date.now = () => window.__realNow() + window.__clockShift;
  }, ms);

const resetClock = (device) =>
  device.page.evaluate(() => {
    if (window.__realNow) Date.now = window.__realNow;
    window.__realNow = null;
    window.__clockShift = 0;
    // A fresh start, since nothing a test did with the clock was a person being idle.
    remoteUi.lastInputAt = Date.now();
  });

// Stands where the service would be, and writes down anything that reaches it.
async function startRecorder() {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    seen += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: `ws://127.0.0.1:${server.address().port}/${SECRET}`,
    seen: () => seen,
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

test('with no address', async (t) => {
  const recorder = await startRecorder();
  const ollama = await startFakeOllama();
  const device = await launchDevice('plain', { ollamaUrl: ollama.url });
  t.after(async () => {
    await device.stop();
    await ollama.stop();
    await recorder.stop();
  });
  await newChat(device, { modality: 'chat', title: 'A plain chat', webEnabled: false });

  await t.test('no Remote Control UI exists anywhere but the place to paste the address, and nothing connects', async () => {
    assert.equal((await status(device)).enabled, false);

    await click(device, '#tools-menu-btn');
    assert.equal(await isVisible(device, '#toggle-web'), true);
    assert.equal(await isVisible(device, '#toggle-remote'), false);
    await closeToolsMenu(device);

    // Not even for a chat that says it's shared.
    await device.page.evaluate(() => { currentChat().remoteControl = true; renderChatList(); renderActiveChat(); });
    assert.equal(await isVisible(device, '#chat-shared-marker'), false);
    assert.equal(await count(device, '.chat-shared-dot'), 0);
    await device.page.evaluate(() => { currentChat().remoteControl = false; renderChatList(); renderActiveChat(); });

    for (const selector of ['#remote-pin-overlay', '#remote-code-overlay', '#remote-connect-overlay', '#remote-running', '#remote-offline', '#new-remote-chat', '#remote-lock-row']) {
      assert.equal(await isVisible(device, selector), false, selector);
    }
    assert.equal(await count(device, '.remote-home'), 0);
    assert.equal(await count(device, '.remote-indicator'), 0);

    await openDevices(device);
    for (const selector of ['#remote-add-device', '#remote-connect-home', '#remote-device-list', '#remote-own-fingerprint', '#remote-control-wrap']) {
      assert.equal(await isVisible(device, selector), false, selector);
    }
    await closeSettings(device);

    await sleep(1500);
    assert.equal(await device.windowCount(), 1, 'no hidden window for connections');
    assert.equal(recorder.seen(), 0, 'nothing reached the service');
  });

  await t.test('a bad address is refused where it was typed', async () => {
    await openDevices(device);
    await fill(device, '#remote-address', 'not an address');
    await click(device, '#remote-address-save');
    await said(device, '#remote-address-note', "That doesn't look like a Remote Control address.");
    assert.equal((await status(device)).enabled, false);
    await closeSettings(device);
  });

  await t.test('pasting the address brings the interface up, and a code is what first reaches the service', async () => {
    await openDevices(device);
    await saveAddress(device, recorder.address);
    assert.equal(await device.page.evaluate(() => document.querySelector('#remote-address').value), '', 'the secret is not left on screen');
    await appeared(device, '#remote-add-device');
    await appeared(device, '#remote-connect-home');
    assert.equal(await isVisible(device, '#remote-control-wrap'), false, 'no home PC, so no control switch');

    await click(device, '#remote-add-device');
    await waitFor('the code to reach the service', () => recorder.seen() > 0, 10000);
    await device.page.keyboard.press('Escape');
    await gone(device, '#remote-code-overlay');
    await closeSettings(device);

    await click(device, '#tools-menu-btn');
    assert.equal(await isVisible(device, '#toggle-remote'), true);
    await closeToolsMenu(device);
  });

  await t.test('keys that were reset get explained, with Remove as the next step', async () => {
    // status() hands this out once, at the start after it happened. A test can't damage the
    // keys from here, and the manager's own tests cover that it's reported.
    await device.page.evaluate(async () => mirrorOnStatus({ ...(await window.api.remote.status()), keysReset: true }));
    await appeared(device, '#remote-reset-overlay');
    const words = await textOf(device, '#remote-reset-overlay');
    assert.match(words, /keys were reset/);
    assert.match(words, /paired again/);
    assert.match(words, /Remove/);
    assert.equal(await device.page.evaluate(() => state.remoteKeysReset), true);

    await click(device, '#remote-reset-devices');
    await gone(device, '#remote-reset-overlay');
    await appeared(device, '#remote-reset-notice');
    assert.match(await textOf(device, '#remote-reset-notice'), /Remove/);
    await closeSettings(device);
    // Once only.
    await device.page.evaluate(async () => mirrorOnStatus(await window.api.remote.status()));
    assert.equal(await isVisible(device, '#remote-reset-overlay'), false);
  });
});

test('two devices, through the interface', async (t) => {
  const relay = await startRelay();
  const homeOllama = await startScriptedOllama();
  const laptopOllama = await startFakeOllama();
  const home = await launchDevice('home', { ollamaUrl: homeOllama.url });
  let laptop = await launchDevice('laptop', { ollamaUrl: laptopOllama.url });
  let visitor = null;
  t.after(async () => {
    await Promise.all([home.stop(), laptop.stop(), visitor?.stop()]);
    await relay.stop();
    await homeOllama.stop();
    await laptopOllama.stop();
  });

  let sharedId;
  let homeName;
  let homeId;
  let laptopId;
  const rid = () => `remote:${homeId}:${sharedId}`;

  await t.test('pairing all the way through, with a lowercase code', async () => {
    await openDevices(home);
    await saveAddress(home, relay.address);
    await closeSettings(home);

    sharedId = await newChat(home, { modality: 'chat', title: 'Shared plans', titleManual: true, webEnabled: false });
    await toggleShare(home);

    // The first share with nobody paired.
    await appeared(home, '#remote-code-overlay');
    assert.equal(await textOf(home, '#remote-code-title'), 'Connect a device');
    assert.equal(await textOf(home, '#remote-code-hint'), CODE_HINT);
    const code = await shownCode(home);
    assert.match(await textOf(home, '#remote-code-expiry'), /^Expires in (10:00|9:\d\d)$/);

    await openDevices(laptop);
    await saveAddress(laptop, relay.address);
    await click(laptop, '#remote-connect-home');
    await appeared(laptop, '#remote-connect-overlay');
    assert.equal(await isVisible(laptop, '#remote-connect-pin'), true, 'the first pairing sets the PIN');

    assert.equal(await submitCode(laptop, code.toLowerCase(), { pin: '123456', pin2: '654321', untilOpen: false }), "Those PINs don't match.");
    assert.equal(await submitCode(laptop, code.toLowerCase(), { pin: '123', untilOpen: false }), 'The PIN must be at least 6 digits.');
    assert.equal((await status(laptop)).devices.length, 0);

    assert.equal(await submitCode(laptop, 'ZZZZZZ', { pin: PIN }), WRONG_CODE);
    assert.equal((await status(laptop)).hasPin, false, 'a mistyped code changes nothing');

    assert.equal(await submitCode(laptop, code.toLowerCase(), { pin: PIN }), null);
    await gone(laptop, '#remote-connect-overlay');
    const after = await status(laptop);
    assert.equal(after.hasPin, true);
    assert.equal(after.devices.length, 1);
    assert.equal(after.devices[0].role, 'home');
    homeId = after.devices[0].id;
    homeName = after.devices[0].name;

    // The other end says so, and the used code is gone from the screen.
    await waitFor('home to hear', async () => (await status(home)).devices.length === 1, 10000);
    laptopId = (await status(home)).devices[0].id;
    await waitFor('the dialog to say it worked', async () => /is connected/.test((await textOf(home, '#remote-code-message')) ?? ''));
    assert.equal(await domHas(home, code), false, 'no dead code left up');
    await click(home, '#remote-code-close');
    await gone(home, '#remote-code-overlay');
  });

  await t.test('Settings lists each device with its state and fingerprint, to compare', async () => {
    await waitFor('both ends connected', async () => (await status(home)).devices[0]?.connected && (await status(laptop)).devices[0]?.connected, 20000);
    const homeStatus = await status(home);
    const laptopStatus = await status(laptop);

    await waitFor('the laptop to list the home PC', async () => (await count(laptop, '.remote-device')) === 1);
    await waitFor('the state to show', async () => ['Direct', 'Through relay'].includes(await textOf(laptop, '.remote-device-path')));
    assert.equal(await textOf(laptop, '.remote-device-fingerprint'), `Fingerprint ${laptopStatus.devices[0].fingerprint}`);
    assert.equal(await textOf(laptop, '#remote-own-fingerprint'), `This device's fingerprint: ${laptopStatus.fingerprint}`);
    assert.match(laptopStatus.fingerprint, /^[^-]{4}-[^-]{4}$/);
    assert.equal(await isVisible(laptop, '.remote-device-remove'), true);
    await closeSettings(laptop);

    await openDevices(home);
    assert.equal(await textOf(home, '#remote-own-fingerprint'), `This device's fingerprint: ${laptopStatus.devices[0].fingerprint}`);
    assert.equal(await textOf(home, '.remote-device-fingerprint'), `Fingerprint ${laptopStatus.fingerprint}`);
    assert.equal(homeStatus.fingerprint, laptopStatus.devices[0].fingerprint);
    await closeSettings(home);
  });

  await t.test('the plain words are the only words', async () => {
    await openDevices(laptop);
    const words = await textOf(laptop, '.set-panel[data-panel="devices"]');
    for (const banned of [/\bpeer\b/i, /webrtc/i, /\bturn\b(?! off| on)/i, /relay server/i, /\bsession\b/i]) {
      assert.doesNotMatch(words, banned);
    }
    await closeSettings(laptop);
  });

  await t.test('the shared chat is marked at home, and sits under its home PC above local chats', async () => {
    assert.equal(await isVisible(home, '#chat-shared-marker'), true);
    assert.equal(await count(home, '.chat-item.active .chat-shared-dot'), 1);
    const saved = await home.page.evaluate((id) => {
      saveToStorage();
      return JSON.parse(localStorage.getItem('localai.state.v1')).chats[id].remoteControl;
    }, sharedId);
    assert.equal(saved, true, 'persisted');

    await waitFor('the chat to reach the laptop', () => hasChat(laptop, rid()), 10000);
    await newChat(laptop, { modality: 'chat', title: 'Local notes', webEnabled: false });
    await waitFor('the group to draw', async () => (await count(laptop, '.remote-home .chat-item')) === 1);
    assert.equal(await textOf(laptop, '.remote-home-name'), homeName);
    assert.match(await textOf(laptop, '.remote-home .chat-item'), /Shared plans/);
    assert.equal(await count(laptop, '.chat-shared-dot'), 0, 'every chat in that group is shared, so a dot would say nothing');
    const above = await laptop.page.evaluate(() => {
      const list = [...document.querySelectorAll('#chat-list .chat-item')];
      return list[0].closest('.remote-home') !== null && list.some((item) => !item.closest('.remote-home'));
    });
    assert.equal(above, true);
    await said(laptop, '.remote-indicator', `Connected to ${homeName}`);
  });

  await t.test('the switch turns sharing off and on, the laptop follows, and a paired home PC shows no code', async () => {
    await toggleShare(home);
    assert.equal(await home.page.evaluate((id) => state.chats[id].remoteControl, sharedId), false);
    assert.equal(await isVisible(home, '#chat-shared-marker'), false);
    assert.equal(await count(home, '.chat-shared-dot'), 0);
    await waitFor('the laptop to lose it', async () => !(await hasChat(laptop, rid())), 5000);

    await toggleShare(home);
    assert.equal(await home.page.evaluate((id) => state.chats[id].remoteControl, sharedId), true);
    assert.equal(await isVisible(home, '#chat-shared-marker'), true);
    assert.equal(await count(home, '.chat-item.active .chat-shared-dot'), 1);
    assert.equal(await isVisible(home, '#remote-code-overlay'), false);
    await closeToolsMenu(home);
    await waitFor('the laptop to get it back', () => hasChat(laptop, rid()), 5000);
  });

  await t.test('on a remote chat the switch is never there, whatever the address', async () => {
    await openChat(laptop, rid());
    await click(laptop, '#tools-menu-btn');
    assert.equal(await isVisible(laptop, '#toggle-web'), true);
    assert.equal(await isVisible(laptop, '#toggle-remote'), false);
    await closeToolsMenu(laptop);
    assert.equal(await isVisible(laptop, '#chat-shared-marker'), false);
  });

  await t.test('five wrong codes cancel it, on both screens', async () => {
    await openDevices(home);
    await click(home, '#remote-add-device');
    await appeared(home, '#remote-code-overlay');
    assert.equal(await textOf(home, '#remote-code-title'), 'Add a device');
    const code = await shownCode(home);

    await openDevices(laptop);
    await click(laptop, '#remote-connect-home');
    assert.equal(await isVisible(laptop, '#remote-connect-pin'), false, 'the PIN is already set');
    const wrong = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE'];
    for (const guess of wrong) {
      assert.equal(await submitCode(laptop, guess), WRONG_CODE, guess);
    }
    await said(home, '#remote-code-message', CANCELLED, 20000);
    assert.equal(await isVisible(home, '#remote-code-value'), false);
    assert.equal(await domHas(home, code), false, 'no dead code left up');

    assert.equal(await submitCode(laptop, code, { untilOpen: false }), CANCELLED);
    await click(laptop, '#remote-connect-cancel');
    await gone(laptop, '#remote-connect-overlay');
    await closeSettings(laptop);

    await click(home, '#remote-code-again');
    const fresh = await shownCode(home);
    assert.notEqual(fresh, code);
    assert.equal(await textOf(home, '#remote-code-message'), '');
    // Leaving means nobody can read the code, so it stops working.
    await click(home, '#remote-code-close');
    await gone(home, '#remote-code-overlay');
    await waitFor('the code to end', async () => (await status(home)).codePending === false);
  });

  await t.test('a code that runs out leaves the screen, and so does one a new code replaced', async () => {
    await click(home, '#remote-add-device');
    const code = await shownCode(home);
    await shiftClock(home, 10 * MINUTE + 1000);
    await said(home, '#remote-code-message', 'That code expired. Get a new one.');
    assert.equal(await domHas(home, code), false);
    assert.equal(await isVisible(home, '#remote-code-value'), false);
    await waitFor('the code to end', async () => (await status(home)).codePending === false);
    await resetClock(home);

    await click(home, '#remote-code-again');
    const next = await shownCode(home);
    // One at a time across every device, so a new one elsewhere ends this one.
    const other = await laptop.remote('createCode');
    assert.ok(other.code);
    await said(home, '#remote-code-message', CANCELLED, 10000);
    assert.equal(await domHas(home, next), false);
    await laptop.remote('cancelCode');
    await click(home, '#remote-code-close');
    await closeSettings(home);
  });

  await t.test('the control switch is off, only on the laptop, and no frame can turn it on', async () => {
    await openDevices(laptop);
    await appeared(laptop, '#remote-control-wrap');
    assert.equal(await textOf(laptop, '#remote-control-switch strong'), 'Let my home PC control this laptop');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-pressed')), 'false');
    assert.equal((await status(laptop)).controlAllowed, false);

    await openDevices(home);
    assert.equal(await isVisible(home, '#remote-control-wrap'), false, 'a home PC has nobody controlling it');
    await closeSettings(home);

    const before = await laptop.frameCount();
    const attempts = [
      { type: 'set-control-allowed', allowed: true },
      { type: 'setControlAllowed', allowed: true },
      { type: 'control', controlAllowed: true },
      { type: 'action', id: 'a1', kind: 'set-control', args: { allowed: true } }
    ];
    for (const frame of attempts) assert.equal(await home.remote('send', laptopId, frame), true);
    await waitFor('the frames to arrive', async () => (await laptop.frameCount()) > before + 3, 5000);
    await sleep(200);
    assert.equal((await status(laptop)).controlAllowed, false);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-pressed')), 'false');

    await click(laptop, '#remote-control-switch');
    await waitFor('the switch to turn on', async () => (await status(laptop)).controlAllowed === true);
    await waitFor('the switch to show it', () => laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-pressed') === 'true'));
    await closeSettings(laptop);
  });

  await t.test('the stronger indicator says what is happening, and Turn off turns it off', async () => {
    await laptop.page.evaluate((name) => setLaptopRunning(name), homeName);
    await appeared(laptop, '#remote-running');
    assert.equal(await textOf(laptop, '#remote-running-text'), `${homeName} is running a command on this laptop`);
    await click(laptop, '#remote-running-off');
    await waitFor('control to go off', async () => (await status(laptop)).controlAllowed === false);
    await gone(laptop, '#remote-running');
  });

  await t.test('after 15 minutes idle the PIN is asked for, the chat leaves the DOM, the connection stays, and the draft survives', async () => {
    await openChat(laptop, rid());
    await laptop.page.fill('#composer-input', 'Words I was typing');
    await laptop.page.evaluate(() => {
      state.pendingAttachments.push({ kind: 'text', name: 'notes.txt', text: 'body', ext: 'txt', size: 4 });
      renderAttachments();
    });

    // Not yet, and activity starts the wait over.
    await shiftClock(laptop, 14 * MINUTE);
    await laptop.page.evaluate(() => checkRemoteIdle());
    assert.equal((await status(laptop)).idleLocked, false);
    await laptop.page.keyboard.press('Shift');
    await shiftClock(laptop, 14 * MINUTE);
    await laptop.page.evaluate(() => checkRemoteIdle());
    assert.equal((await status(laptop)).idleLocked, false, 'typing counted as being here');

    // The timer does this by itself.
    await shiftClock(laptop, 2 * MINUTE);
    await waitFor('the idle lock', async () => (await status(laptop)).idleLocked === true, 8000);
    await appeared(laptop, '#remote-pin-overlay');
    assert.equal(await textOf(laptop, '#remote-pin-title'), 'Enter your PIN');
    await resetClock(laptop);

    await waitFor('the chat to leave the DOM', async () => !(await domHas(laptop, 'Shared plans')));
    assert.equal(await foundIn(laptop, homeName), null, 'nor the name of the home PC');
    assert.equal(await domHas(laptop, 'Words I was typing'), false, 'nor what was being typed');
    assert.equal(await count(laptop, '.remote-home'), 0);
    assert.equal(await laptop.page.evaluate((id) => homeBlockedReason(id), homeId), 'Remote Control is locked. Unlock it to send anything.');

    // The connection stays up, and frames keep arriving out of sight.
    assert.equal((await status(laptop)).devices[0].connected, true);
    assert.equal((await status(home)).devices[0].connected, true);
    await openChat(home, sharedId);
    await submit(home, 'Said at home during the lock');
    const reply = await homeOllama.next();
    reply.say('Answered during the lock.');
    reply.finish();
    await waitFor('the frames to land out of sight', () =>
      laptop.page.evaluate((id) => state.chats[id].messages.at(-1)?.content === 'Answered during the lock.', rid()), 5000);
    assert.equal(await domHas(laptop, 'Answered during the lock.'), false);
  });

  await t.test('a code can be refused, and the dialog says why with no code in it', async () => {
    await laptop.page.evaluate(() => openCodeDialog('Add a device'));
    await said(laptop, '#remote-code-message', 'Remote Control is locked. Enter the PIN first.');
    assert.equal(await isVisible(laptop, '#remote-code-value'), false);
    await laptop.page.evaluate(() => closeCodeDialog());
  });

  await t.test('a wrong PIN is refused, and the right one shows the chat as it is now, with the draft back', async () => {
    await fill(laptop, '#remote-pin-input', '999999');
    await click(laptop, '#remote-pin-submit');
    await said(laptop, '#remote-pin-error', "That PIN isn't right.", 15000);
    assert.equal(await isVisible(laptop, '#remote-pin-overlay'), true);

    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the chat to come back', () => laptop.page.evaluate((id) => state.activeId === id, rid()), 5000);
    assert.ok((await threadOf(laptop)).includes('Answered during the lock.'), 'current on the first frame');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').value), 'Words I was typing');
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments.map((a) => a.name)), ['notes.txt']);
    assert.equal(await count(laptop, '#attachments .attachment-chip, #attachments > *'), 1);
    await laptop.page.fill('#composer-input', '');
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
  });

  await t.test('Not now keeps the home PC out of reach, leaves local chats usable, and the PIN is one click away', async () => {
    await openChat(laptop, rid());
    await laptop.page.fill('#composer-input', 'Meant for home');
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    await click(laptop, '#remote-pin-later');
    await gone(laptop, '#remote-pin-overlay');
    assert.equal(await domHas(laptop, 'Shared plans'), false);
    assert.equal(await domHas(laptop, 'Meant for home'), false, 'none of that goes to a local chat');
    assert.equal(await count(laptop, '.remote-home'), 0);
    assert.equal(await laptop.page.evaluate(() => !currentChat().remote), true);
    await appeared(laptop, '#remote-lock-row');

    // Went on with something of its own, so unlocking doesn't pull them away from it.
    await laptop.page.fill('#composer-input', 'A local thought');
    await click(laptop, '#remote-lock-row button');
    await appeared(laptop, '#remote-pin-overlay');
    await fill(laptop, '#remote-pin-input', PIN);
    await laptop.page.keyboard.press('Enter');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the group to come back', async () => (await count(laptop, '.remote-home .chat-item')) === 1);
    assert.equal(await laptop.page.evaluate(() => !currentChat().remote), true);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').value), 'A local thought');

    // What was typed for home waits in its chat.
    await laptop.page.fill('#composer-input', '');
    await openChat(laptop, rid());
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').value), 'Meant for home');
    await laptop.page.fill('#composer-input', '');
  });

  await t.test('with the screen locked, the control switch can still be turned off, at once', async () => {
    await openDevices(laptop);
    await click(laptop, '#remote-control-switch');
    await waitFor('control on', async () => (await status(laptop)).controlAllowed === true);
    await closeSettings(laptop);

    await laptop.page.evaluate((name) => setLaptopRunning(name), homeName);
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    // Above the PIN screen, and it can be clicked there.
    await click(laptop, '#remote-running-off');
    await waitFor('control to go off', async () => (await status(laptop)).controlAllowed === false);
    await gone(laptop, '#remote-running');
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
  });

  await t.test('a home PC with only laptops is never asked for a PIN, and never idle-locks', async () => {
    const before = await status(home);
    assert.equal(before.hasPin, false);
    assert.equal(before.needsPin, false);
    assert.equal(await isVisible(home, '#remote-pin-overlay'), false);
    await shiftClock(home, 60 * MINUTE);
    await home.page.evaluate(() => checkRemoteIdle());
    await sleep(200);
    assert.equal((await status(home)).idleLocked, false);
    assert.equal(await isVisible(home, '#remote-pin-overlay'), false);
    await resetClock(home);
  });

  await t.test('offline: the chat stays, the banner names the home PC, the box is disabled, and typed words survive', async () => {
    await openChat(laptop, rid());
    await laptop.page.fill('#composer-input', 'Typed before the drop');
    await laptop.page.focus('#composer-input');

    // Moving to a relay that isn't there ends every connection this device has.
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('the laptop to go offline', async () => (await status(laptop)).devices[0].connected === false, 10000);
    await appeared(laptop, '#remote-offline');
    assert.equal(await textOf(laptop, '#remote-offline'), `${homeName} is offline. Reconnecting…`);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').disabled), true);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-form').classList.contains('disabled')), true);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').value), 'Typed before the drop');
    assert.ok((await threadOf(laptop)).includes('Answered during the lock.'), 'the chat stays visible');
    await said(laptop, '.remote-indicator', `${homeName} is offline`);
    assert.equal(await isVisible(laptop, '.remote-home-state'), true);

    // A redraw while offline keeps all of that.
    await laptop.page.evaluate(() => renderActiveChat());
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').disabled), true);
    assert.equal(await isVisible(laptop, '#remote-offline'), true);

    assert.deepEqual(await laptop.remote('setAddress', relay.address), { ok: true });
    await gone(laptop, '#remote-offline', 30000);
    await waitFor('the box to come back', () => laptop.page.evaluate(() => !document.querySelector('#composer-input').disabled), 3000);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').value), 'Typed before the drop');
    assert.equal(await laptop.page.evaluate(() => document.activeElement?.id), 'composer-input', 'they can carry on typing');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-form').classList.contains('disabled')), false);
    await said(laptop, '.remote-indicator', `Connected to ${homeName}`);
    await laptop.page.fill('#composer-input', '');
    await closeToolsMenu(laptop);
  });

  await t.test('another chat never inherits the banner or the disabled box', async () => {
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('the laptop to go offline', async () => (await status(laptop)).devices[0].connected === false, 10000);
    await appeared(laptop, '#remote-offline');
    await laptop.page.evaluate(() => {
      const local = state.order.map((id) => state.chats[id]).find((c) => c && !c.remote && c.modality === 'chat');
      setActive(local.id);
    });
    assert.equal(await isVisible(laptop, '#remote-offline'), false);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').disabled), false);
    assert.deepEqual(await laptop.remote('setAddress', relay.address), { ok: true });
    await waitFor('the laptop to reconnect', async () => (await status(laptop)).devices[0].connected === true, 30000);
    await waitFor('the chat to be back', () => hasChat(laptop, rid()), 5000);
  });

  await t.test('after a local chat is deleted, or the space changes, the next chat is a local one', async () => {
    const first = await newChat(laptop, { modality: 'chat', title: 'First local', webEnabled: false });
    const second = await newChat(laptop, { modality: 'chat', title: 'Second local', webEnabled: false });
    await laptop.page.evaluate((id) => setActive(id), second);
    const sortedFirst = await laptop.page.evaluate(() => { sortRemoteChats(); return !!chatsInCurrentSpace()[0].remote; });
    assert.equal(sortedFirst, true, 'a remote chat really is first in the list');

    await laptop.page.evaluate((id) => deleteChat(id), second);
    assert.equal(await laptop.page.evaluate(() => !!currentChat()?.remote), false, 'deleting landed on a local chat');
    assert.ok(await laptop.page.evaluate(() => !!currentChat()));
    await laptop.page.evaluate((id) => deleteChat(id), first);
    assert.equal(await laptop.page.evaluate(() => !!currentChat()?.remote), false);

    // A shared project at home, and nothing of its own in that space here.
    const project = await newChat(home, { modality: 'agent', title: 'Shared project', projectFolder: 'C:\\somewhere', remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await waitFor('the project to arrive', () => hasChat(laptop, `remote:${homeId}:${project}`), 5000);
    const localProjects = await laptop.page.evaluate(() => state.order.map((id) => state.chats[id]).filter((c) => c?.modality === 'agent' && !c.remote).length);
    assert.equal(localProjects, 0);
    await laptop.page.evaluate(() => switchSpace('code'));
    assert.equal(await laptop.page.evaluate(() => !!currentChat()?.remote), false, 'switching space landed on no remote chat');
    await waitFor('the project under its home PC', async () => /Shared project/.test((await textOf(laptop, '.remote-home')) ?? ''));
    await laptop.page.evaluate(() => switchSpace('home'));
    assert.equal(await laptop.page.evaluate(() => !!currentChat()?.remote), false, 'nor on the way back');
    await home.page.evaluate((id) => { state.chats[id].remoteControl = false; markMirrorDirty(); }, project);
    await openChat(home, sharedId);
  });

  await t.test('chats group under each of several home PCs', async () => {
    // A second real home PC would add nothing to this, since it's only a sidebar being drawn,
    // and two homes reaching one laptop is covered in the transport tests.
    await laptop.page.evaluate(async () => {
      const real = await window.api.remote.status();
      mirrorOnStatus({ ...real, devices: [...real.devices, { id: 'second-home', name: 'Cabin PC', role: 'home', path: 'offline', connected: false, fingerprint: 'abcd-efgh' }] });
      const c = addRemoteChat('second-home', 'c1');
      c.title = 'Cabin notes';
      c.modality = 'chat';
      c.updatedAt = Date.now();
      sortRemoteChats();
      renderChatList();
    });
    const groups = await laptop.page.evaluate(() => [...document.querySelectorAll('.remote-home')].map((g) => ({
      name: g.querySelector('.remote-home-name').textContent,
      chats: [...g.querySelectorAll('.chat-title')].map((x) => x.textContent),
      offline: !!g.querySelector('.remote-home-state')
    })));
    assert.equal(groups.length, 2);
    const cabin = groups.find((g) => g.name === 'Cabin PC');
    const own = groups.find((g) => g.name === homeName);
    assert.deepEqual(cabin.chats, ['Cabin notes']);
    assert.equal(cabin.offline, true);
    assert.ok(own.chats.includes('Shared plans'));
    assert.ok(!own.chats.includes('Cabin notes'));
    await laptop.page.evaluate(async () => mirrorOnStatus(await window.api.remote.status()));
    await waitFor('that home to go', async () => (await count(laptop, '.remote-home')) === 1);
  });

  await t.test('a paired laptop with no PIN can only set one, or remove the home PC', async () => {
    // Happens when setting the PIN fails after a pairing has worked, which can't be arranged
    // from here. Everything after this status is real.
    await laptop.page.evaluate(async () => mirrorOnStatus({ ...(await window.api.remote.status()), hasPin: false, needsPin: true }));
    await appeared(laptop, '#remote-pin-overlay');
    assert.equal(await textOf(laptop, '#remote-pin-title'), 'Set a PIN for this device');
    assert.equal(await isVisible(laptop, '#remote-pin-later'), false, 'no way to skip it');
    assert.equal(await isVisible(laptop, '#remote-pin-remove'), true);
    await laptop.page.keyboard.press('Escape');
    assert.equal(await isVisible(laptop, '#remote-pin-overlay'), true);
    assert.equal(await domHas(laptop, 'Shared plans'), false, "the home PC's chats wait for it");
    assert.equal(await laptop.page.evaluate((id) => homeBlockedReason(id), homeId), 'Remote Control is locked. Unlock it to send anything.');

    await fill(laptop, '#remote-pin-input', PIN);
    await fill(laptop, '#remote-pin-input2', '000000');
    await click(laptop, '#remote-pin-submit');
    await said(laptop, '#remote-pin-error', "Those PINs don't match.");
    await fill(laptop, '#remote-pin-input2', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the chats to come back', async () => (await count(laptop, '.remote-home .chat-item')) >= 1);
  });

  await t.test('what a home PC or a laptop names itself is only ever text', async () => {
    // A laptop's name, for real, in the list and the dialog at home.
    await openDevices(home);
    await click(home, '#remote-add-device');
    const code = await shownCode(home);
    visitor = await launchDevice('visitor', { ollamaUrl: laptopOllama.url });
    assert.deepEqual(await visitor.remote('setAddress', relay.address), { ok: true });
    await waitFor('the pairing', async () => {
      const answer = await visitor.remote('pair', code, HOSTILE, PIN);
      if (!answer.ok && !/cancelled/.test(answer.error)) assert.fail(answer.error);
      return answer.ok;
    }, 10000);
    await waitFor('the dialog to say it worked', async () => (await textOf(home, '#remote-code-message')) === `${HOSTILE} is connected.`);
    await click(home, '#remote-code-close');
    await waitFor('the list', async () => (await home.page.evaluate((name) => [...document.querySelectorAll('.remote-device-name')].some((n) => n.textContent === name), HOSTILE)));

    // A chat's title from a home PC, for real.
    await home.page.evaluate(([id, title]) => { state.chats[id].title = title; state.chats[id].titleManual = true; renderChatList(); saveToStorage(); }, [sharedId, HOSTILE]);
    await closeSettings(home);
    await waitFor('the title to reach the laptop', () => laptop.page.evaluate(([id, title]) => state.chats[id]?.title === title, [rid(), HOSTILE]), 5000);
    await openChat(laptop, rid());
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#chat-title').value), HOSTILE);
    await waitFor('the title in the list', () => laptop.page.evaluate((name) => [...document.querySelectorAll('.chat-title')].some((n) => n.textContent === name), HOSTILE));

    // The name a home PC gave at pairing is fixed by then, so this is that name arriving as if
    // it had been the one given. The drawing code can't tell the difference.
    const hostileStatus = () => laptop.page.evaluate(async (name) => {
      const real = await window.api.remote.status();
      mirrorOnStatus({ ...real, devices: real.devices.map((d) => ({ ...d, name, connected: false, path: 'offline' })) });
    }, HOSTILE);
    await hostileStatus();
    await appeared(laptop, '#remote-offline');
    assert.equal(await textOf(laptop, '#remote-offline'), `${HOSTILE} is offline. Reconnecting…`);
    assert.equal(await textOf(laptop, '.remote-home-name'), HOSTILE);
    assert.equal(await textOf(laptop, '.remote-indicator'), `${HOSTILE} is offline`);
    await openDevices(laptop);
    await hostileStatus();
    assert.equal(await textOf(laptop, '.remote-device-name'), HOSTILE);
    await closeSettings(laptop);
    await laptop.page.evaluate((name) => setLaptopRunning(name), HOSTILE);
    assert.equal(await textOf(laptop, '#remote-running-text'), `${HOSTILE} is running a command on this laptop`);
    await laptop.page.evaluate(() => setLaptopRunning(null));

    await laptop.page.evaluate(async (name) => {
      const real = await window.api.remote.status();
      mirrorOnStatus({ ...real, hasPin: false, needsPin: true, devices: real.devices.map((d) => ({ ...d, name })) });
    }, HOSTILE);
    await appeared(laptop, '#remote-pin-remove');
    assert.ok((await textOf(laptop, '#remote-pin-remove')).includes(HOSTILE));

    for (const device of [home, laptop]) {
      assert.equal(await count(device, 'img[src="x"]'), 0, `${device.name} made no element from a name`);
      assert.equal(await device.page.evaluate(() => window.__xss), undefined, `${device.name} ran nothing`);
    }
    await laptop.page.evaluate(async () => mirrorOnStatus(await window.api.remote.status()));
    await gone(laptop, '#remote-pin-overlay');
  });

  await t.test('Remove takes a second click, and ends it at once', async () => {
    await openDevices(home);
    const visitorRow = '.remote-device[data-name="visitor"]';
    await home.page.evaluate((name) => {
      const row = [...document.querySelectorAll('.remote-device')].find((r) => r.querySelector('.remote-device-name').textContent === name);
      row.dataset.name = 'visitor';
    }, HOSTILE);
    await click(home, `${visitorRow} .remote-device-remove`);
    assert.equal((await status(home)).devices.length, 2, 'not on the first click');
    const armed = await home.page.evaluate(() => {
      const row = [...document.querySelectorAll('.remote-device')].find((r) => r.querySelector('.remote-device-remove.armed'));
      return row.querySelector('.remote-device-remove.armed').textContent;
    });
    assert.equal(armed, 'Remove this device');
    await home.page.click('.remote-device-remove.armed');
    await waitFor('it to go', async () => (await status(home)).devices.length === 1);
    await waitFor('the list to follow', async () => (await count(home, '.remote-device')) === 1);
    await waitFor('the other end to stop', async () => (await status(visitor)).devices.every((d) => !d.connected), 10000);
    await closeSettings(home);
    await visitor.stop();
    visitor = null;
  });

  await t.test('the PIN is asked for at start, and nothing connects until it is entered', async () => {
    await laptop.quit();
    await waitFor('home to see it go', async () => (await status(home)).devices[0].connected === false, 60000);
    laptop = await launchDevice('laptop', { ollamaUrl: laptopOllama.url, profile: laptop.profile });

    await appeared(laptop, '#remote-pin-overlay', 15000);
    assert.equal(await textOf(laptop, '#remote-pin-title'), 'Enter your PIN');
    const locked = await status(laptop);
    assert.equal(locked.locked, true);
    assert.equal(locked.devices.length, 0);
    await sleep(1500);
    assert.equal((await status(home)).devices[0].connected, false, 'no connection before the PIN');
    assert.equal(await count(laptop, '.remote-home'), 0);
    assert.equal(await domHas(laptop, 'Shared plans'), false);

    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the connection', async () => (await status(home)).devices[0].connected === true, 30000);
    await waitFor('the group', async () => (await count(laptop, '.remote-home .chat-item')) >= 1, 15000);
    await said(laptop, '.remote-indicator', `Connected to ${homeName}`);
  });
});
