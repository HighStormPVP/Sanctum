// Pairing on the same Wi-Fi, on real instances: a laptop with no service address types only the
// code, finds the home PC on the network, and gets the address inside the pairing. Everything a
// person does is a real click or real typing.
//
// Every instance a test starts keeps this to 127.0.0.1, because main.js does that for any run
// with SANCTUM_REMOTE_TEST set, and this checks it does. A socket bound anywhere else would make
// Windows ask whoever is at this machine about its firewall.
//
//   node e2e/nearby.e2e.js
//
// Screenshots of the laptop's new screens, in each theme, go to SANCTUM_E2E_SHOTS if it's set.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startRelay, startFakeOllama, launchDevice, waitFor, sleep, SECRET } = require('./harness.js');

const NEARBY_LINE = 'For this first pairing, both devices need to be on the same Wi-Fi.';
const LOOKING = 'Looking for your home PC on this network…';
const NOT_FOUND = "Couldn't find a home PC showing a code on this network. Check both are on the same Wi-Fi, or close this and paste the service address under Connect to a home PC.";
const FIREWALL = "If Windows asks, allow Sanctum so your laptop can find this PC. If Windows treats this Wi-Fi as a public network, pairing here won't find it.";
const WRONG_CODE = "That code didn't work. Check it and try again.";
const NEEDS_PIN = 'Set a PIN for this device before connecting it to a home PC.';
const foldOpen = (device) => device.page.evaluate(() => document.querySelector('#remote-address-fold').open);
const PIN = '904172358613';
const FLAGS = 'log,no-stun,block-ice,peek';
const THEMES = ['sanctum', 'dark', 'light'];
const SHOTS = process.env.SANCTUM_E2E_SHOTS || null;

const isVisible = (device, selector) =>
  device.page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    // checkVisibility, since what a closed fold holds still has a size.
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden' && el.checkVisibility();
  }, selector);
const textOf = (device, selector) => device.page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? null, selector);
const click = (device, selector) => device.page.click(selector, { timeout: 10000 });
const fill = (device, selector, value) => device.page.fill(selector, value, { timeout: 10000 });
const appeared = (device, selector, ms = 5000) => waitFor(`${device.name} to show ${selector}`, () => isVisible(device, selector), ms);
const nearby = (device, what) => device.app.evaluate((_, name) => {
  const peek = globalThis.__sanctumNearby;
  return name === 'wire' ? peek.wire() : name === 'loopback' ? peek.loopback : peek.listener();
}, what);

async function openDevices(device) {
  await click(device, '#open-settings');
  await click(device, '.set-nav-btn[data-panel="devices"]');
  await appeared(device, '#remote-address-fold');
}

async function shoot(device, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await device.page.evaluate((t) => applyTheme(t), theme);
    await sleep(150);
    await device.page.screenshot({ path: path.join(SHOTS, `nearby-${name}-${theme}.png`) });
  }
  await device.page.evaluate(() => applyTheme(state.settings.theme));
}

// Every way the text could cross readably: as it is, in JSON, base64 from any byte, and hex, and
// in any run of base64 in a line, decoded.
function readableIn(lines, needle) {
  const bytes = Buffer.from(needle);
  const forms = new Set([needle, JSON.stringify(needle).slice(1, -1), bytes.toString('hex')]);
  for (let shift = 0; shift < 3; shift++) {
    const encoded = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const form = encoded.slice(shift ? 4 : 0, Math.floor((shift + bytes.length) / 3) * 4);
    if (form.length >= 8) forms.add(form);
  }
  const views = [];
  for (const line of lines) {
    const text = line.toString('latin1');
    views.push(text);
    for (const m of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) views.push(Buffer.from(m[0], 'base64').toString('latin1'));
  }
  return [...forms].some((form) => views.some((view) => view.includes(form)));
}

test('a laptop with no address pairs with only the code, and then reaches its home PC through the relay', async (t) => {
  const relay = await startRelay();
  const ollama = await startFakeOllama();
  const home = await launchDevice('home', { flags: FLAGS, ollamaUrl: ollama.url });
  const laptop = await launchDevice('laptop', { flags: FLAGS, ollamaUrl: ollama.url });
  t.after(async () => {
    await Promise.all([home.stop(), laptop.stop()]);
    await relay.stop();
    await ollama.stop();
  });
  assert.equal(await nearby(home, 'loopback'), true, 'a run a test started keeps to loopback');
  assert.equal(await nearby(laptop, 'loopback'), true);
  assert.deepEqual(await home.remote('setAddress', relay.address), { ok: true });

  // The laptop sees only Connect to a home PC, with the address folded away below it.
  await openDevices(laptop);
  assert.equal((await laptop.remote('status')).enabled, false);
  assert.equal(await isVisible(laptop, '#remote-connect-home'), true);
  assert.equal(await isVisible(laptop, '#remote-address-summary'), true);
  for (const selector of ['#remote-add-device', '#remote-address', '#remote-device-list', '#remote-control-wrap', '#availability-wrap']) {
    assert.equal(await isVisible(laptop, selector), false, selector);
  }
  await shoot(laptop, 'devices-no-address');

  // Home shows a code, and listens on loopback only while it does.
  await openDevices(home);
  await click(home, '#remote-add-device');
  await appeared(home, '#remote-code-value', 15000);
  const code = await textOf(home, '#remote-code-value');
  assert.match(code, /^[2-9A-Z]{6}$/);
  assert.equal(await isVisible(home, '#remote-code-firewall'), process.platform === 'win32');
  if (process.platform === 'win32') assert.equal(await textOf(home, '#remote-code-firewall'), FIREWALL);
  const listening = await waitFor('home to listen', async () => {
    const now = await nearby(home, 'listener');
    return now?.ports ? now : null;
  });
  assert.deepEqual(listening.bound, ['127.0.0.1', '127.0.0.1']);

  await click(laptop, '#remote-connect-home');
  await appeared(laptop, '#remote-connect-code');
  assert.equal(await textOf(laptop, '#remote-connect-nearby'), NEARBY_LINE);
  assert.equal(await isVisible(laptop, '#remote-connect-nearby'), true);
  // A wrong code is said, and isn't a reason to offer the address field.
  const wrong = code === '222222' ? '333333' : '222222';
  await fill(laptop, '#remote-connect-code', wrong);
  await fill(laptop, '#remote-connect-pin', PIN);
  await fill(laptop, '#remote-connect-pin2', PIN);
  await click(laptop, '#remote-connect-submit');
  await waitFor('the wrong code to be said', async () => (await textOf(laptop, '#remote-connect-error')) === WRONG_CODE, 20000);
  assert.equal(await foldOpen(laptop), false, 'a wrong code leaves the address folded');

  await fill(laptop, '#remote-connect-code', code.toLowerCase());
  await fill(laptop, '#remote-connect-pin', PIN);
  await fill(laptop, '#remote-connect-pin2', PIN);
  await shoot(laptop, 'connect-dialog');
  await click(laptop, '#remote-connect-submit');
  await appeared(laptop, '#remote-connect-looking', 3000);
  assert.equal(await textOf(laptop, '#remote-connect-looking'), LOOKING);
  await shoot(laptop, 'looking');

  // Paired: the dialog closes, and the question about control follows, as for any pairing.
  await waitFor('the dialog to close', async () => !(await isVisible(laptop, '#remote-connect-overlay')), 30000);
  await appeared(laptop, '#remote-control-ask-overlay');
  await click(laptop, '#remote-control-ask-off');
  const status = await laptop.remote('status');
  assert.equal(status.enabled, true, 'the laptop has the address now');
  assert.equal(status.hasPin, true);

  // It reaches home through the relay, and Settings says so.
  await waitFor('both ends to connect', async () => (await home.entry())?.connected && (await laptop.entry())?.connected, 30000);
  assert.equal(await laptop.path(), 'relay');
  await appeared(laptop, '.remote-device-path.up', 10000);
  assert.equal(await textOf(laptop, '.remote-device-path'), 'Through relay');
  assert.equal(await textOf(laptop, '.remote-device-name'), (await home.remote('status')).name);
  assert.equal(await isVisible(laptop, '#remote-add-device'), true, 'the rest comes with the address');
  assert.equal(await isVisible(laptop, '#remote-address-summary'), false);
  await shoot(laptop, 'paired');
  await click(home, '#remote-code-close');

  // The listener went when the code did.
  await waitFor('home to stop listening', async () => (await nearby(home, 'listener')).bound.length === 0, 5000);

  // What crossed the local network: the pairing messages, with nothing in them anyone could read.
  const lines = [...await nearby(home, 'wire'), ...await nearby(laptop, 'wire')].map((entry) => Buffer.from(entry.bytes, 'base64'));
  const types = lines.flatMap((bytes) => bytes.toString('utf8').trim().split('\n')).map((line) => JSON.parse(line).t);
  for (const type of ['pake', 'pake-reply', 'confirm', 'identity']) assert.ok(types.includes(type), `${type} crossed`);
  const secrets = {
    'the address': relay.address,
    'the secret': SECRET,
    'the code': code,
    'the code in lower case': code.toLowerCase(),
    'the PIN': PIN
  };
  const found = Object.entries(secrets).filter(([, value]) => readableIn(lines, value)).map(([name]) => name);
  assert.deepEqual(found, [], 'readable on the local network');
  assert.equal(readableIn([Buffer.from(JSON.stringify({ b: Buffer.from(`--${relay.address}`).toString('base64') }))], relay.address), true, 'the search finds what it looks for');
});

test('with no home PC showing a code, the laptop says it could not find one', async (t) => {
  const ollama = await startFakeOllama();
  const laptop = await launchDevice('laptop', { flags: FLAGS, ollamaUrl: ollama.url });
  t.after(async () => {
    await laptop.stop();
    await ollama.stop();
  });
  await openDevices(laptop);
  assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-address-fold').open), false);
  await click(laptop, '#remote-connect-home');
  // No PIN typed: said, with the address left folded.
  await fill(laptop, '#remote-connect-code', 'K7M2QX');
  await click(laptop, '#remote-connect-submit');
  await waitFor('the PIN to be asked for', async () => (await textOf(laptop, '#remote-connect-error')) === NEEDS_PIN, 10000);
  assert.equal(await foldOpen(laptop), false, 'asking for a PIN leaves the address folded');

  await fill(laptop, '#remote-connect-pin', PIN);
  await fill(laptop, '#remote-connect-pin2', PIN);
  await click(laptop, '#remote-connect-submit');
  await waitFor('the answer', async () => (await textOf(laptop, '#remote-connect-error')) === NOT_FOUND, 20000);
  assert.equal(await isVisible(laptop, '#remote-connect-looking'), false);
  await shoot(laptop, 'not-found');

  // The other way in is open and ready below Connect to a home PC.
  await click(laptop, '#remote-connect-cancel');
  assert.equal(await isVisible(laptop, '#remote-address'), true);
  await shoot(laptop, 'not-found-fold');
  const status = await laptop.remote('status');
  assert.equal(status.enabled, false);
  assert.equal(status.hasPin, false, 'no PIN is kept from a pairing that never happened');
});
