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
// What's in the page, and what's in its fields, since outerHTML doesn't hold a field's live value.
const pageText = `document.documentElement.outerHTML + '\\n' + [...document.querySelectorAll('input, textarea')].map((field) => field.value).join('\\n')`;
const domHas = (device, text) => device.page.evaluate(([t, source]) => (0, eval)(source).includes(t), [text, pageText]);
// Where in the page some text is, or null, which makes for a failure that says.
const foundIn = (device, text) =>
  device.page.evaluate(([t, source]) => {
    const html = (0, eval)(source);
    const at = html.indexOf(t);
    return at < 0 ? null : html.slice(Math.max(0, at - 120), at + t.length + 40);
  }, [text, pageText]);
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

// Built in the page and sent by the page, as anyone at it could, because a String object or a
// toJSON wouldn't survive the trip through this test. Each answer is what send gave, or 'threw'.
const sendTricks = (device, deviceId) =>
  device.page.evaluate(async (id) => {
    const body = { id: 'a_trick', kind: 'new-chat', args: { modality: 'chat' } };
    const frames = {
      stringObject: { ...body, type: new String('action') },
      otherSpelling: { ...body, type: 'ACTION' },
      array: { ...body, type: ['action'] },
      nested: { ...body, type: { type: 'action' } },
      inherited: Object.assign(Object.create({ type: 'action' }), body),
      toJSON: { type: 'mirror-part-ack', toJSON: () => ({ ...body, type: 'action' }) },
      plain: { ...body, type: 'action' }
    };
    const answers = {};
    for (const [name, frame] of Object.entries(frames)) {
      try {
        answers[name] = await window.api.remote.send(id, frame);
      } catch {
        answers[name] = 'threw';
      }
    }
    return answers;
  }, deviceId);

function allRefused(answers) {
  for (const [name, answer] of Object.entries(answers)) assert.ok(answer === false || answer === 'threw', `${name} gave ${answer}`);
}

// The bar for words whose chat has gone.
const barSays = (device) => device.page.evaluate(() => {
  const bar = document.querySelector('#remote-stranded');
  return bar.hidden ? null : { text: bar.querySelector('.remote-stranded-text')?.textContent, more: bar.querySelector('.remote-stranded-more')?.textContent ?? null };
});
const barGone = (device) => device.page.evaluate(() => document.querySelector('#remote-stranded').children.length === 0 && document.querySelector('#remote-stranded').hidden);

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
  });

  await t.test('what the page holds includes what is typed in its fields', async () => {
    const words = 'SOMETHING-ONLY-IN-A-FIELD-41b7';
    assert.equal(await domHas(device, words), false);
    await device.page.evaluate((w) => { document.querySelector('#composer-input').value = w; }, words);
    assert.equal(await domHas(device, words), true, 'a textarea');
    assert.match(await foundIn(device, words), new RegExp(words));
    await device.page.evaluate(() => { document.querySelector('#composer-input').value = ''; });
    await device.page.evaluate((w) => { document.querySelector('#chat-title').value = w; }, words);
    assert.equal(await domHas(device, words), true, 'an input');
    await device.page.evaluate(() => renderActiveChat());
    assert.equal(await domHas(device, words), false);
  });

  await t.test('this run can still debug, because it is not a packaged build', async () => {
    // The rule itself, and that every window follows it, are in test/window-rules.test.js. A
    // window can't be asked whether it has DevTools: the answer doesn't say.
    const roles = await device.app.evaluate(({ Menu }) => {
      const found = [];
      const walk = (menu) => { for (const item of menu?.items || []) { if (item.role) found.push(item.role.toLowerCase()); walk(item.submenu); } };
      walk(Menu.getApplicationMenu());
      return found;
    });
    assert.ok(roles.includes('toggledevtools'));
  });

  await t.test('a bad address is refused where it was typed', async () => {
    await openDevices(device);
    await fill(device, '#remote-address', 'not an address');
    await click(device, '#remote-address-save');
    await said(device, '#remote-address-note', "That doesn't look like a Remote Control address.");
    assert.equal((await status(device)).enabled, false);
    await closeSettings(device);

    // It was about that attempt, and closing Settings ends that.
    await openDevices(device);
    assert.doesNotMatch(await textOf(device, '#remote-address-note'), /doesn't look like/);
    assert.equal(await device.page.evaluate(() => document.querySelector('#remote-address-note').classList.contains('remote-note-error')), false);
    assert.equal(await device.page.evaluate(() => document.querySelector('#remote-address').value), '');
    await closeSettings(device);
  });

  await t.test('pasting the address brings the interface up, and a code is what first reaches the service', async () => {
    await openDevices(device);
    await saveAddress(device, recorder.address);
    assert.equal(await device.page.evaluate(() => document.querySelector('#remote-address').value), '', 'the secret is not left on screen');
    await appeared(device, '#remote-add-device');
    await appeared(device, '#remote-connect-home');
    assert.equal(await isVisible(device, '#remote-control-wrap'), false, 'no home PC, so no control switch');

    // Knowing the address connects nothing by itself.
    await sleep(1500);
    assert.equal(recorder.seen(), 0, 'nothing has reached the service yet');

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

    // The switch is asked about here, and stays off unless it's turned on.
    await appeared(laptop, '#remote-control-ask-overlay');
    assert.equal(await textOf(laptop, '#remote-control-ask-title'), 'Let my home PC control this laptop?');
    assert.equal(await laptop.page.evaluate(() => document.activeElement?.id), 'remote-control-ask-off', 'the safe answer is the one a stray Enter gives');
    assert.equal((await status(laptop)).controlAllowed, false);
    await click(laptop, '#remote-control-ask-off');
    await gone(laptop, '#remote-control-ask-overlay');
    assert.equal((await status(laptop)).controlAllowed, false);

    await laptop.page.evaluate(() => askAboutControl());
    await appeared(laptop, '#remote-control-ask-overlay');
    await laptop.page.keyboard.press('Escape');
    await gone(laptop, '#remote-control-ask-overlay');
    assert.equal((await status(laptop)).controlAllowed, false, 'closing it leaves it off');

    await laptop.page.evaluate(() => askAboutControl());
    await click(laptop, '#remote-control-ask-on');
    await gone(laptop, '#remote-control-ask-overlay');
    await waitFor('the switch to take', async () => (await status(laptop)).controlAllowed === true);
    assert.deepEqual(await laptop.remote('setControlAllowed', false), { ok: true });

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
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('role')), 'switch');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-checked')), 'false');
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
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-checked')), 'false');

    await click(laptop, '#remote-control-switch');
    await waitFor('the switch to turn on', async () => (await status(laptop)).controlAllowed === true);
    await waitFor('the switch to show it', () => laptop.page.evaluate(() => document.querySelector('#remote-control-switch').getAttribute('aria-checked') === 'true'));
    await closeSettings(laptop);
  });

  await t.test('unlocked, a plain action goes, and a type that is no plain string still does not', async () => {
    const before = await home.page.evaluate(() => Object.keys(state.chats).length);
    assert.equal(await laptop.page.evaluate((id) => window.api.remote.send(id, { type: new String('rtc'), candidate: 'x' }), homeId), false);
    assert.equal(await laptop.remote('send', homeId, { no: 'type' }), false);
    assert.equal(await laptop.page.evaluate((id) => window.api.remote.send(id, { type: new String('action'), id: 'a_open_s', kind: 'new-chat', args: { modality: 'chat' } }), homeId), false);
    await sleep(500);
    assert.equal(await home.page.evaluate(() => Object.keys(state.chats).length), before);
    assert.equal(await laptop.remote('send', homeId, { type: 'action', id: 'a_open_new', kind: 'new-chat', args: { modality: 'chat' } }), true);
    await waitFor('home to make the chat', () => home.page.evaluate((n) => Object.keys(state.chats).length === n + 1, before), 5000);
    await home.page.evaluate((id) => {
      const made = Object.keys(state.chats).find((c) => c !== id && state.chats[c].remoteControl === true && !state.chats[c].messages.length);
      deleteChat(made);
      setActive(id);
    }, sharedId);
    await waitFor('it to be gone', () => home.page.evaluate((n) => Object.keys(state.chats).length === n, before), 3000);
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

  await t.test('while idle-locked, the page itself can send the home PC no action, and the rest still goes', async () => {
    const before = await home.page.evaluate(() => Object.keys(state.chats).length);
    allRefused(await sendTricks(laptop, homeId));
    assert.equal(await laptop.page.evaluate(([id, chat]) => window.api.remote.send(id, { type: new String('action'), id: 'a_locked_send', chatId: chat, kind: 'send', args: { text: 'Sent past the lock' } }), [homeId, sharedId]), false);
    assert.equal(await laptop.remote('send', homeId, { type: 'action', id: 'a_locked_send', chatId: sharedId, kind: 'send', args: { text: 'Sent past the lock' } }), false);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await sleep(1000);
    assert.equal(await home.page.evaluate(() => Object.keys(state.chats).length), before);
    assert.equal((await home.page.evaluate((id) => JSON.stringify(state.chats[id].messages), sharedId)).includes('Sent past the lock'), false);
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

    await home.page.evaluate((id) => { state.chats[id].title = 'Shared plans'; renderChatList(); saveToStorage(); }, sharedId);
    await waitFor('the title to go back', () => laptop.page.evaluate((id) => state.chats[id]?.title === 'Shared plans', rid()), 5000);
  });

  await t.test("a name from a home PC's own snapshot is only ever text", async () => {
    await home.page.evaluate((name) => { state.remoteStatus = { ...state.remoteStatus, name }; }, HOSTILE);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('the name to arrive', () => laptop.page.evaluate(([id, name]) => mirror.homes.get(id)?.info?.name === name, [homeId, HOSTILE]), 5000);
    await said(laptop, '#new-remote-chat span', `New chat on ${HOSTILE}`);
    assert.equal(await count(laptop, 'img[src="x"]'), 0);
    assert.equal(await laptop.page.evaluate(() => window.__xss), undefined);
    await home.page.evaluate(async () => mirrorOnStatus(await window.api.remote.status()));
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('the name to go back', () => laptop.page.evaluate(([id, name]) => mirror.homes.get(id)?.info?.name !== name, [homeId, HOSTILE]), 5000);
  });

  const localChat = () => laptop.page.evaluate(() => {
    const local = state.order.map((id) => state.chats[id]).find((c) => c && !c.remote && chatSpace(c) === state.space);
    setActive(local.id);
  });
  const shareAt = (id, on) => home.page.evaluate(([c, value]) => { state.chats[c].remoteControl = value; markMirrorDirty(); }, [id, on]);
  const boxOn = () => laptop.page.evaluate(() => document.querySelector('#composer-input').value);

  await t.test('a chat asked for, arriving during a lock, waits behind it and opens on unlock', async () => {
    await localChat();
    const title = 'Awaited secret title';
    const awaited = await home.page.evaluate((name) => {
      const before = state.activeId;
      createChat(state.chats[before].model, 'chat', { title: name, titleManual: true, webEnabled: false });
      const made = state.activeId;
      setActive(before);
      return made;
    }, title);
    const key = `remote:${homeId}:${awaited}`;
    await laptop.page.evaluate((k) => armAwaitedChat(k, state.activeId, Date.now()), key);
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    await shareAt(awaited, true);
    await waitFor('it to arrive', () => hasChat(laptop, key), 5000);
    await sleep(200);
    assert.notEqual(await laptop.page.evaluate(() => state.activeId), key);
    assert.equal(await foundIn(laptop, title), null);

    await click(laptop, '#remote-pin-later');
    await gone(laptop, '#remote-pin-overlay');
    assert.notEqual(await laptop.page.evaluate(() => state.activeId), key);
    assert.equal(await foundIn(laptop, title), null, 'nor after Not now');

    await click(laptop, '#remote-lock-row button');
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('it to open', () => laptop.page.evaluate((k) => state.activeId === k, key), 3000);
    assert.equal(await laptop.page.evaluate(() => mirror.awaited), null);
    await localChat();
    await shareAt(awaited, false);
    await waitFor('it to go', async () => !(await hasChat(laptop, key)), 5000);
  });

  await t.test('words typed in a chat that stops being shared go to no other chat, and come back with it', async () => {
    const other = await newChat(home, { modality: 'chat', title: 'Chat B', titleManual: true, webEnabled: false, remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await openChat(home, sharedId);
    const otherKey = `remote:${homeId}:${other}`;
    await waitFor('chat B', () => hasChat(laptop, otherKey), 5000);
    await home.page.evaluate((id) => { state.chats[id].updatedAt = Date.now() + 100000; markMirrorDirty(); }, other);

    await openChat(laptop, rid());
    await laptop.page.fill('#composer-input', 'Words for the first chat');
    await laptop.page.evaluate(() => {
      state.pendingAttachments.push({ kind: 'text', name: 'first.txt', text: 'body', ext: 'txt', size: 4 });
      renderAttachments();
    });
    await shareAt(sharedId, false);
    await waitFor('it to leave', async () => !(await hasChat(laptop, rid())), 5000);

    assert.equal(await laptop.page.evaluate(() => !!currentChat()?.remote), false, 'landed on a local chat');
    assert.equal(await boxOn(), '', 'not in the local box');
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments), [], 'nor its file');
    await appeared(laptop, '#remote-gone');
    assert.equal(await textOf(laptop, '#remote-gone span'), 'This chat is no longer shared.');
    assert.deepEqual(await barSays(laptop), { text: "Your message to Shared plans wasn't sent.", more: null });
    await click(laptop, '#remote-gone button');
    await appeared(laptop, '#remote-stranded-put');

    await openChat(laptop, otherKey);
    assert.equal(await boxOn(), '', 'not in the other chat');
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments), []);
    await localChat();

    await shareAt(sharedId, true);
    await waitFor('it to come back', () => hasChat(laptop, rid()), 5000);
    await waitFor('the bar to go, since they went back to that chat', () => barGone(laptop), 3000);
    assert.equal(await laptop.page.evaluate(() => mirror.heldForGone.size), 0);
    await openChat(laptop, rid());
    assert.equal(await boxOn(), 'Words for the first chat');
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments.map((a) => a.name)), ['first.txt']);
    await laptop.page.fill('#composer-input', '');
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
    await localChat();
    await shareAt(other, false);
    await waitFor('chat B to go', async () => !(await hasChat(laptop, otherKey)), 5000);
  });

  await t.test('Put in the message box adds to what is there, on a new line, with the files, and sends nothing', async () => {
    await localChat();
    const made = await newChat(home, { modality: 'chat', title: 'Deleted at home', titleManual: true, webEnabled: false, remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await openChat(home, sharedId);
    const key = `remote:${homeId}:${made}`;
    await waitFor('it to arrive', () => hasChat(laptop, key), 5000);
    await openChat(laptop, key);
    await laptop.page.fill('#composer-input', 'For the chat about to be deleted');
    await laptop.page.evaluate(() => {
      state.pendingAttachments.push({ kind: 'text', name: 'second.txt', text: 'body', ext: 'txt', size: 4 });
      renderAttachments();
    });
    const sentBefore = await home.page.evaluate(() => Object.values(state.chats).reduce((n, c) => n + c.messages.length, 0));

    // Case: deleted at home.
    await home.page.evaluate((id) => deleteChat(id), made);
    await waitFor('the bar', async () => (await barSays(laptop))?.text === "Your message to Deleted at home wasn't sent.", 5000);
    assert.equal(await boxOn(), '');
    await click(laptop, '#remote-gone button');

    await laptop.page.fill('#composer-input', 'Already here');
    await click(laptop, '#remote-stranded-put');
    assert.equal(await boxOn(), 'Already here\nFor the chat about to be deleted');
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments.map((a) => a.name)), ['second.txt']);
    assert.equal(await laptop.page.evaluate(() => document.activeElement?.id), 'composer-input');
    assert.equal(await barGone(laptop), true);
    assert.equal(await laptop.page.evaluate(() => mirror.heldForGone.size), 0);
    await sleep(300);
    assert.equal(await home.page.evaluate(() => Object.values(state.chats).reduce((n, c) => n + c.messages.length, 0)), sentBefore, 'nothing went');
    await laptop.page.fill('#composer-input', '');
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
  });

  await t.test('a frame or a failed send for a chat that has gone comes to the same bar, and Discard ends it', async () => {
    await localChat();
    // Case: a queued-returned frame. The chat isn't known here, so nor is its title.
    assert.equal(await home.remote('send', laptopId, { type: 'queued-returned', id: 'gone_q1', chatId: 'never-seen-here', text: 'Handed back for a gone chat' }), true);
    await waitFor('the bar', async () => (await barSays(laptop))?.text === "Your message to a shared chat wasn't sent.", 3000);
    assert.equal(await boxOn(), '', 'not in the box on its own');

    // Case: a failed send.
    const made = await newChat(home, { modality: 'chat', title: 'Failed send', titleManual: true, webEnabled: false, remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await openChat(home, sharedId);
    const key = `remote:${homeId}:${made}`;
    await waitFor('it to arrive', () => hasChat(laptop, key), 5000);
    await openChat(laptop, key);
    await home.page.evaluate(() => {
      window.__realHandle = window.handleRemoteAction;
      window.handleRemoteAction = (d, frame) => setTimeout(() => window.__realHandle(d, frame), 500);
    });
    await submit(laptop, 'On its way when the chat went');
    await shareAt(made, false);
    await waitFor('it to leave', async () => !(await hasChat(laptop, key)), 5000);
    await waitFor('the words to be held', async () => (await barSays(laptop))?.text === "Your message to Failed send wasn't sent.", 5000);
    await home.page.evaluate(() => { window.handleRemoteAction = window.__realHandle; });
    assert.equal(await boxOn(), '');
    assert.equal((await barSays(laptop)).more, 'and 1 more', 'the newest, and a count');
    await click(laptop, '#remote-gone button');

    await click(laptop, '#remote-stranded-discard');
    assert.equal((await barSays(laptop)).text, "Your message to a shared chat wasn't sent.");
    assert.equal((await barSays(laptop)).more, null);
    await click(laptop, '#remote-stranded-discard');
    assert.equal(await barGone(laptop), true);
    assert.equal(await boxOn(), '');
    assert.equal(await domHas(laptop, 'Handed back for a gone chat'), false);

    // A title is a home PC's to choose, so it's only ever text.
    await laptop.page.evaluate((name) => strandWords('remote:x:y', { text: 'w', attachments: [] }, name), HOSTILE);
    assert.equal((await barSays(laptop)).text, `Your message to ${HOSTILE} wasn't sent.`);
    assert.equal(await count(laptop, 'img[src="x"]'), 0);
    await click(laptop, '#remote-stranded-discard');

    // Twenty at most, oldest going first, and it says so. The newest is never the one dropped.
    await laptop.page.evaluate(() => { for (let i = 0; i < 22; i++) strandWords(`remote:x:${i}`, { text: `w${i}`, attachments: [] }, `Chat ${i}`); });
    assert.equal(await laptop.page.evaluate(() => mirror.heldForGone.size), 20);
    assert.equal((await barSays(laptop)).text, "Your message to Chat 21 wasn't sent.");
    assert.equal((await barSays(laptop)).more, 'and 19 more');
    assert.ok(await laptop.page.evaluate(() => !mirror.heldForGone.has('remote:x:0') && !mirror.heldForGone.has('remote:x:1')));
    await waitFor('the toast', () => laptop.page.evaluate(() => [...document.querySelectorAll('.toast')].some((x) => /no room/.test(x.textContent))), 2000);
    await laptop.page.evaluate(() => {
      mirror.heldForGone.clear();
      strandWords('remote:x:big1', { text: 'x'.repeat(20 * 1024 * 1024), attachments: [] }, 'One');
      strandWords('remote:x:big2', { text: 'x'.repeat(20 * 1024 * 1024), attachments: [] }, 'Two');
    });
    assert.deepEqual(await laptop.page.evaluate(() => [...mirror.heldForGone.keys()]), ['remote:x:big2'], 'no more than 32 MiB');

    // Nothing of it reaches the disk.
    assert.equal(await laptop.page.evaluate(() => { saveToStorage(); return localStorage.getItem('localai.state.v1').includes('xxxxxxxxxxxxxxxxxxxx'); }), false);
    // And it's out of the page during a lock.
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    assert.equal(await barGone(laptop), true);
    assert.equal(await domHas(laptop, "Your message to"), false);
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    assert.equal((await barSays(laptop)).text, "Your message to Two wasn't sent.", 'after the right PIN it is back');
    await click(laptop, '#remote-stranded-discard');
  });

  await t.test('removing a home PC, from either end, keeps what was being typed', async () => {
    const typist = await launchDevice('typist', { ollamaUrl: laptopOllama.url });
    try {
      assert.deepEqual(await typist.remote('setAddress', relay.address), { ok: true });
      const pairTypist = async () => {
        const { code } = await home.remote('createCode');
        await waitFor('the pairing', async () => {
          const answer = await typist.remote('pair', code, 'Typist', PIN);
          if (!answer.ok && !/cancelled/.test(answer.error)) assert.fail(answer.error);
          return answer.ok;
        }, 10000);
        await waitFor('a session', async () => (await status(typist)).devices[0]?.connected, 20000);
        await waitFor('the chat', () => hasChat(typist, rid()), 10000);
      };
      const typeInChat = async (words) => {
        await openChat(typist, rid());
        await typist.page.fill('#composer-input', words);
      };

      // Case: the home PC removes this laptop. The person didn't choose it.
      await pairTypist();
      await typeInChat('Typed as home removed me');
      const typistId = (await status(home)).devices.find((d) => d.name === 'Typist').id;
      await home.remote('removeDevice', typistId);
      await waitFor('it to go', async () => (await status(typist)).devices.length === 0, 10000);
      await waitFor('the bar', async () => (await barSays(typist))?.text === "Your message to Shared plans wasn't sent.", 3000);
      assert.equal(await typist.page.evaluate(() => document.querySelector('#composer-input').value), '');
      await click(typist, '#remote-gone button');
      await click(typist, '#remote-stranded-put');
      assert.equal(await typist.page.evaluate(() => document.querySelector('#composer-input').value), 'Typed as home removed me');
      await typist.page.fill('#composer-input', '');

      // Case: this laptop removes the home PC.
      await pairTypist();
      await typeInChat('Typed as I removed home');
      await typist.remote('removeDevice', homeId);
      await waitFor('the bar', async () => (await barSays(typist))?.text === "Your message to Shared plans wasn't sent.", 3000);
      await click(typist, '#remote-gone button');
      await click(typist, '#remote-stranded-put');
      assert.equal(await typist.page.evaluate(() => document.querySelector('#composer-input').value), 'Typed as I removed home');
      await waitFor('home to drop it', async () => (await status(home)).devices.every((d) => d.name !== 'Typist'), 10000);
    } finally {
      await typist.stop();
    }
  });

  await t.test('a chat asked for opens only if nothing has changed here since the click, and within 30 seconds', async () => {
    await localChat();
    const fresh = async (title) => {
      const id = await home.page.evaluate((name) => {
        const before = state.activeId;
        createChat(state.chats[before].model, 'chat', { title: name, titleManual: true, webEnabled: false });
        const made = state.activeId;
        setActive(before);
        return made;
      }, title);
      return { id, key: `remote:${homeId}:${id}` };
    };
    const arrive = async ({ id, key }) => {
      await shareAt(id, true);
      await waitFor('it to arrive', () => hasChat(laptop, key), 5000);
      await sleep(100);
    };
    const leave = async ({ id, key }) => {
      await localChat();
      await shareAt(id, false);
      await waitFor('it to go', async () => !(await hasChat(laptop, key)), 5000);
      await home.page.evaluate((c) => deleteChat(c), id);
    };
    const active = () => laptop.page.evaluate(() => state.activeId);
    const toastNamed = (title) => waitFor(`a toast naming ${title}`, () => laptop.page.evaluate((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), title), 2000);
    const armed = (key) => laptop.page.evaluate((k) => armAwaitedChat(k, state.activeId, Date.now()), key);
    const here = await active();

    // Nothing changed: it opens.
    const opens = await fresh('Awaited, nothing changed');
    await armed(opens.key);
    await arrive(opens);
    assert.equal(await active(), opens.key);
    assert.equal(await laptop.page.evaluate(() => mirror.awaited), null);
    await leave(opens);
    await laptop.page.evaluate((id) => setActive(id), here);

    // Words in the box stay where they are, on the chat they're on.
    const words = await fresh('Awaited, words typed');
    await armed(words.key);
    await laptop.page.fill('#composer-input', 'My private local words');
    await arrive(words);
    assert.equal(await active(), here);
    assert.equal(await boxOn(), 'My private local words');
    assert.equal(await laptop.page.evaluate(() => mirror.awaited), null, 'disarmed');
    await toastNamed('Awaited, words typed');
    await laptop.page.fill('#composer-input', '');
    await leave(words);
    await laptop.page.evaluate((id) => setActive(id), here);

    // A file attached.
    const file = await fresh('Awaited, file attached');
    await armed(file.key);
    await laptop.page.evaluate(() => {
      state.pendingAttachments.push({ kind: 'text', name: 'mine.txt', text: 'body', ext: 'txt', size: 4 });
      renderAttachments();
    });
    await arrive(file);
    assert.equal(await active(), here);
    assert.deepEqual(await laptop.page.evaluate(() => state.pendingAttachments.map((a) => a.name)), ['mine.txt']);
    await toastNamed('Awaited, file attached');
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
    await leave(file);
    await laptop.page.evaluate((id) => setActive(id), here);

    // Moved to another chat since the click.
    const moved = await fresh('Awaited, moved on');
    await armed(moved.key);
    const elsewhere = await newChat(laptop, { modality: 'chat', title: 'Somewhere else', titleManual: true, webEnabled: false });
    await arrive(moved);
    assert.equal(await active(), elsewhere);
    await toastNamed('Awaited, moved on');
    await leave(moved);
    await laptop.page.evaluate((id) => setActive(id), here);

    // Too late.
    const late = await fresh('Awaited, too late');
    await laptop.page.evaluate((k) => armAwaitedChat(k, state.activeId, Date.now() - 31000), late.key);
    await arrive(late);
    assert.equal(await active(), here);
    assert.equal(await laptop.page.evaluate(() => mirror.awaited), null);
    await toastNamed('Awaited, too late');
    await leave(late);
    await laptop.page.evaluate((id) => setActive(id), here);
  });

  await t.test('a home PC can only send back so many words, and what was already held stays', async () => {
    const MIB = 1024 * 1024;
    const CAP = 32 * MIB;
    let sent = 0;
    // Built at home, and sent as a real frame with an id of its own each time.
    const sendBack = async (chatId, letter, size, extra = {}) => {
      const id = `cap_${sent++}`;
      assert.equal(await home.page.evaluate(([to, frame, ch, n]) => window.api.remote.send(to, { ...frame, text: ch.repeat(n) }), [laptopId, { type: 'queued-returned', id, chatId, ...extra }, letter, size]), true);
      await waitFor(`${id} to land`, () => laptop.page.evaluate((i) => mirror.returnedSeen.has(i), id), 20000);
    };
    await laptop.page.evaluate(() => {
      window.__raised = [];
      window.__realShowToast = window.showToast;
      window.showToast = (text, tone) => { window.__raised.push(text); window.__realShowToast(text, tone); };
    });
    const noRoomToasts = () => laptop.page.evaluate(() => window.__raised.filter((x) => /no room/.test(x)).length);
    const clearToasts = () => laptop.page.evaluate(() => { window.__raised = []; });
    const heldFor = (key) => laptop.page.evaluate((k) => {
      const held = mirror.heldForGone.get(k);
      return held ? { length: held.text.length, first: held.text[0], letters: [...new Set(held.text.replace(/\n/g, ''))].join('') } : null;
    }, key);
    const goneKey = (name) => `remote:${homeId}:${name}`;
    await localChat();
    await clearToasts();

    // A chat that has gone: one key, unique ids, 10 MiB at a time.
    for (const letter of 'abcde') await sendBack('capped-gone', letter, 10 * MIB);
    const one = await heldFor(goneKey('capped-gone'));
    assert.ok(one.length <= CAP, `held ${one.length}`);
    assert.equal(one.letters, 'abc', 'the first ones are kept, and the rest refused');
    assert.equal(one.first, 'a');
    assert.equal(await noRoomToasts(), 1, 'one toast for all of it');
    await click(laptop, '#remote-stranded-discard');
    await clearToasts();

    // That cap is the device's: a second gone chat can't take it past.
    await sendBack('capped-one', 'f', 17 * MIB);
    await sendBack('capped-two', 'g', 17 * MIB);
    assert.equal(await heldFor(goneKey('capped-two')), null);
    assert.equal((await heldFor(goneKey('capped-one'))).length, 17 * MIB);
    await click(laptop, '#remote-stranded-discard');
    await clearToasts();

    // A shared chat that's there, not open. Nothing bigger goes on when it leaves.
    const made = await newChat(home, { modality: 'chat', title: 'Capped but here', titleManual: true, webEnabled: false, remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await openChat(home, sharedId);
    const key = goneKey(made);
    await waitFor('it to arrive', () => hasChat(laptop, key), 5000);
    for (const letter of 'hij') await sendBack(made, letter, 15 * MIB);
    const waiting = await laptop.page.evaluate((k) => {
      const held = state.chats[k]._returned;
      return { length: held.text.length, letters: [...new Set(held.text.replace(/\n/g, ''))].join('') };
    }, key);
    assert.ok(waiting.length <= CAP, `held ${waiting.length}`);
    assert.equal(waiting.letters, 'hi');
    assert.equal(await noRoomToasts(), 1);
    await shareAt(made, false);
    await waitFor('it to leave', async () => !(await hasChat(laptop, key)), 5000);
    const left = await heldFor(key);
    assert.ok(left.length <= CAP, `held ${left.length}`);
    assert.equal(left.letters, 'hi');
    await click(laptop, '#remote-stranded-discard');
    await clearToasts();

    // Into the box of the chat that's open.
    await openChat(laptop, rid());
    await sendBack(sharedId, 'k', 17 * MIB);
    await sendBack(sharedId, 'm', 17 * MIB);
    assert.equal(await boxOn().then((v) => v.length), 17 * MIB);
    assert.equal(await noRoomToasts(), 1);
    await laptop.page.fill('#composer-input', '');
    await localChat();
    await clearToasts();

    // During an idle lock, with the toast waiting, once, for after the PIN.
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    for (const letter of 'npq') await sendBack('capped-locked', letter, 15 * MIB);
    const locked = await heldFor(goneKey('capped-locked'));
    assert.ok(locked.length <= CAP, `held ${locked.length}`);
    assert.equal(locked.letters, 'np');
    assert.equal(await laptop.page.evaluate(() => mirror.toastsForUnlock.filter((x) => /no room/.test(x)).length), 1);
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await click(laptop, '#remote-stranded-discard');
    await clearToasts();

    // With room again, the next one is taken.
    await sendBack('capped-after', 'r', 1024);
    assert.equal((await heldFor(goneKey('capped-after'))).length, 1024);
    assert.equal(await noRoomToasts(), 0);
    await click(laptop, '#remote-stranded-discard');

    // Files a frame couldn't carry back are mentioned on the bar, and again on Put.
    await sendBack('had-files', 's', 8, { hadAttachments: true });
    const bar = await barSays(laptop);
    assert.equal(bar.text, "Your message to a shared chat wasn't sent. Its files need attaching again.");
    await click(laptop, '#remote-stranded-put');
    assert.equal(await boxOn(), 'ssssssss');
    await waitFor('the toast about files', () => laptop.page.evaluate(() => [...document.querySelectorAll('.toast')].some((x) => /files need attaching again/.test(x.textContent))), 2000);
    await laptop.page.fill('#composer-input', '');
    await laptop.page.evaluate(() => { window.showToast = window.__realShowToast; });
  });

  await t.test('what a home PC says during a lock waits behind it too', async () => {
    await localChat();
    await waitFor('earlier toasts to clear', async () => (await count(laptop, '.toast')) === 0, 6000);
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    assert.equal(await home.remote('send', laptopId, { type: 'queued-returned', id: 'lock_q1', chatId: sharedId, text: 'Handed back during the lock' }), true);
    assert.equal(await home.remote('send', laptopId, { type: 'mirror-too-large' }), true);
    await sleep(500);
    assert.equal(await count(laptop, '.toast'), 0, 'nothing above the PIN screen');
    assert.equal(await domHas(laptop, 'Handed back during the lock'), false);

    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the toasts to show', async () => {
      const words = await laptop.page.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '));
      return /queued message/.test(words) && /too large/.test(words);
    }, 3000);

    // A toast of this machine's own doesn't wait.
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    await laptop.page.evaluate(() => showToast('Something local'));
    assert.match(await laptop.page.evaluate(() => document.querySelector('#toast-host').textContent), /Something local/);
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await openChat(laptop, rid());
    await waitFor('the words in the box', async () => (await boxOn()) === 'Handed back during the lock', 3000);
    await laptop.page.fill('#composer-input', '');
    await localChat();
  });

  await t.test("locking with a home PC's project open, and nothing local in that space, leaves no trace of its models", async () => {
    const project = await newChat(home, { modality: 'agent', title: 'Project at home', titleManual: true, projectFolder: 'C:\\somewhere', remoteControl: true });
    await home.page.evaluate(() => markMirrorDirty());
    await openChat(home, sharedId);
    const key = `remote:${homeId}:${project}`;
    await waitFor('the project', () => hasChat(laptop, key), 5000);
    await openChat(laptop, key);
    assert.equal(await laptop.page.evaluate(() => state.space), 'code');
    assert.equal(await laptop.page.evaluate(() => state.order.map((id) => state.chats[id]).filter((c) => c?.modality === 'agent' && !c.remote).length), 0);
    const model = 'home-only-model:latest';
    await laptop.page.evaluate(([id, name]) => {
      mirror.homes.get(id).info.installedModels.push(name);
      populateModelPicker();
    }, [homeId, model]);
    assert.notEqual(await foundIn(laptop, model), null, 'there to begin with');

    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    assert.equal(await laptop.page.evaluate(() => state.activeId), null);
    assert.equal(await foundIn(laptop, model), null);
    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await laptop.page.evaluate(() => switchSpace('home'));
    await localChat();
    await shareAt(project, false);
    await waitFor('the project to go', async () => !(await hasChat(laptop, key)), 5000);
  });

  await t.test('a laptop whose PIN could not be saved reaches nothing at home, and Remove is a real way out', async () => {
    const owing = await launchDevice('owing', { flags: 'log,no-stun,fail-user-pin', ollamaUrl: laptopOllama.url });
    try {
      assert.deepEqual(await owing.remote('setAddress', relay.address), { ok: true });
      const { code } = await home.remote('createCode');
      let answer;
      await waitFor('the pairing', async () => {
        answer = await owing.remote('pair', code, 'Owing laptop', PIN);
        if (!answer.ok && !/cancelled/.test(answer.error)) assert.fail(answer.error);
        return answer.ok;
      }, 10000);
      assert.equal(answer.pinError, 'Could not save the PIN.');
      const st = await status(owing);
      assert.equal(st.needsPin, true);
      assert.equal(st.locked, false);
      await waitFor('its connection', async () => (await status(owing)).devices[0]?.connected, 20000);
      await appeared(owing, '#remote-pin-overlay');
      assert.equal(await textOf(owing, '#remote-pin-title'), 'Set a PIN for this device');
      await waitFor('the chats to arrive out of sight', () => owing.page.evaluate(() => Object.values(state.chats).some((c) => c.remote)), 5000);
      assert.equal(await domHas(owing, 'Shared plans'), false);

      const chatsAtHome = await home.page.evaluate(() => Object.keys(state.chats).length);
      allRefused(await sendTricks(owing, homeId));
      assert.equal(await owing.remote('send', homeId, { type: 'mirror-resync-request' }), true);
      const on = await owing.remote('setControlAllowed', true);
      assert.equal(on.ok, false, 'no control switch before a PIN');
      assert.equal((await status(owing)).controlAllowed, false);
      assert.deepEqual(await owing.remote('setControlAllowed', false), { ok: true });
      await sleep(800);
      assert.equal(await home.page.evaluate(() => Object.keys(state.chats).length), chatsAtHome);

      await fill(owing, '#remote-pin-input', PIN);
      await fill(owing, '#remote-pin-input2', PIN);
      await click(owing, '#remote-pin-submit');
      await said(owing, '#remote-pin-error', 'Could not save the PIN.');
      assert.equal(await isVisible(owing, '#remote-pin-overlay'), true);

      // Nothing was ever unlocked here, so nothing held comes out because of this.
      const owingId = (await status(home)).devices.find((d) => d.name === 'Owing laptop').id;
      await home.remote('send', owingId, { type: 'queued-returned', id: 'owing_q1', chatId: 'gone-chat', text: 'HELD-WHILE-OWING' });
      await home.remote('send', owingId, { type: 'mirror-too-large' });
      await waitFor('them to land', () => owing.page.evaluate(() => mirror.heldForGone.size === 1 && mirror.toastsForUnlock.length === 1), 3000);
      assert.equal(await foundIn(owing, 'HELD-WHILE-OWING'), null);

      await click(owing, '#remote-pin-remove');
      await gone(owing, '#remote-pin-overlay');
      assert.deepEqual((await status(owing)).devices, []);
      assert.equal(await foundIn(owing, 'HELD-WHILE-OWING'), null);
      assert.equal(await barGone(owing), true);
      assert.equal(await count(owing, '.toast'), 0);
      assert.deepEqual(await owing.page.evaluate(() => [mirror.heldForGone.size, mirror.toastsForUnlock.length]), [0, 0]);
      assert.equal((await status(owing)).needsPin, false);
      assert.equal(await owing.page.evaluate(() => Object.values(state.chats).some((c) => c.remote)), false);
      await waitFor('home to drop it', async () => (await status(home)).devices.every((d) => d.name !== 'Owing laptop'), 10000);
    } finally {
      await owing.stop();
    }
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
    allRefused(await sendTricks(laptop, homeId));
    assert.equal(await count(laptop, '.remote-home'), 0);
    assert.equal(await domHas(laptop, 'Shared plans'), false);

    await fill(laptop, '#remote-pin-input', PIN);
    await click(laptop, '#remote-pin-submit');
    await gone(laptop, '#remote-pin-overlay', 15000);
    await waitFor('the connection', async () => (await status(home)).devices[0].connected === true, 30000);
    await waitFor('the group', async () => (await count(laptop, '.remote-home .chat-item')) >= 1, 15000);
    await said(laptop, '.remote-indicator', `Connected to ${homeName}`);
  });

  await t.test('ten wrong PINs delete the keys, the screen says so, and nothing held comes out', async () => {
    await openChat(laptop, rid());
    await laptop.page.fill('#composer-input', 'TYPED-BEFORE-THE-LOCK');
    await laptop.remote('lock');
    await appeared(laptop, '#remote-pin-overlay');
    await home.remote('send', laptopId, { type: 'queued-returned', id: 'wipe_q1', chatId: 'gone-chat', text: 'WORDS-HELD-IN-THE-LOCK' });
    await home.remote('send', laptopId, { type: 'mirror-too-large' });
    await home.remote('send', laptopId, { type: 'ask', id: 'wipe_ask', kind: 'approval', chatId: sharedId, tool: 'run_command', args: { command: 'ASK-HELD-IN-THE-LOCK', cwd: '' }, device: 'Somewhere' });
    await waitFor('them to land', () => laptop.page.evaluate(() => mirror.heldForGone.size === 1 && mirror.toastsForUnlock.length === 1 && remoteAsks.held.size === 1), 3000);
    assert.equal(await foundIn(laptop, 'ASK-HELD-IN-THE-LOCK'), null, 'held, not shown');
    for (let attempt = 1; attempt <= 10; attempt++) {
      await waitFor(`try ${attempt} to be allowed`, () => laptop.page.evaluate(() => !document.querySelector('#remote-pin-submit').disabled), 90000);
      await fill(laptop, '#remote-pin-input', '000000');
      await click(laptop, '#remote-pin-submit');
      if (attempt < 10) {
        await waitFor(`the answer to try ${attempt}`, async () => /PIN/.test((await textOf(laptop, '#remote-pin-error')) ?? ''), 15000);
      }
    }
    await waitFor('the notice', async () => (await textOf(laptop, '#remote-pin-title')) === 'Remote Control keys deleted', 15000);
    assert.equal(await isVisible(laptop, '#remote-pin-overlay'), true);
    assert.match(await textOf(laptop, '#remote-pin-lead'), /tenth wrong PIN/);
    assert.match(await textOf(laptop, '#remote-pin-lead'), /messages you hadn't sent are gone/);
    assert.equal(await isVisible(laptop, '#remote-pin-form'), false);
    const st = await status(laptop);
    assert.equal(st.hasPin, false);
    assert.deepEqual(st.devices, []);
    assert.equal(await domHas(laptop, 'Shared plans'), false);
    await click(laptop, '#remote-pin-ok');
    await gone(laptop, '#remote-pin-overlay');
    assert.equal(await count(laptop, '.remote-home'), 0);

    // Someone without the PIN carries on from here, and a code is what lifts the lock.
    assert.ok((await laptop.remote('createCode')).code);
    await waitFor('the lock to lift', async () => (await status(laptop)).locked === false, 5000);
    await sleep(300);
    for (const words of ['WORDS-HELD-IN-THE-LOCK', 'TYPED-BEFORE-THE-LOCK', 'ASK-HELD-IN-THE-LOCK']) assert.equal(await foundIn(laptop, words), null);
    assert.equal(await laptop.page.evaluate(() => remoteAsks.held.size), 0);
    assert.equal(await isVisible(laptop, '#approval-overlay'), false);
    assert.equal(await barGone(laptop), true);
    assert.equal(await count(laptop, '.toast'), 0);
    assert.deepEqual(await laptop.page.evaluate(() => [mirror.heldForGone.size, mirror.toastsForUnlock.length]), [0, 0]);
    await laptop.remote('cancelCode');
  });
});
