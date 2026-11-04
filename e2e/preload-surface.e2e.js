// What the renderer gets from Remote Control, checked in the real app, and that nothing else
// can use it: the methods on window.api.remote, what status() gives away, that a peer's
// frame can't reach the control switch, and that isLocalUi turns away the hidden window.
//
//   node e2e/preload-surface.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPair, waitFor, sleep, SECRET, PIN, TRANSPORT_PAGE } = require('./harness.js');

const REMOTE_METHODS = [
  'cancelCode', 'createCode', 'lock', 'onFrame', 'onStatus', 'pair', 'removeDevice',
  'send', 'setAddress', 'setControlAllowed', 'setPin', 'status', 'unlock'
];

test('the preload surface', async (t) => {
  const pair = await startPair();
  t.after(() => pair.stop());
  const { home, laptop, homeId, laptopId } = pair;

  await t.test('window.api.remote exposes the listed methods and nothing else', async () => {
    assert.deepEqual(await home.page.evaluate(() => Object.keys(window.api.remote).sort()), REMOTE_METHODS);
    assert.ok(await home.page.evaluate(() => Object.values(window.api.remote).every((v) => typeof v === 'function')));
  });

  await t.test('nothing in status() holds a key, the address, or the secret', async () => {
    const seen = JSON.stringify([await home.remote('status'), await laptop.remote('status')]);
    assert.ok(!seen.includes(SECRET));
    assert.ok(!seen.includes(pair.relay.address));
    assert.ok(!seen.includes('ws://'));
    assert.ok(!seen.includes(PIN));
    assert.ok(!/publicKey|secretKey|privateKey|signing|"key"/i.test(seen), seen);

    // A device id is the hash of a public key, so status may show that, but these fields
    // are all a device gets, so none of them can be a key under another name.
    const entry = await home.entry();
    assert.deepEqual(Object.keys(entry).sort(), ['connected', 'fingerprint', 'id', 'name', 'path', 'role']);
  });

  await t.test("a peer's frame can't reach the control switch, and only ever reaches the renderer", async () => {
    await home.page.evaluate(() => {
      window.__frames = [];
    });
    const attempts = [
      { type: 'setControlAllowed', allowed: true },
      { t: 'setControlAllowed', allowed: true },
      { setControlAllowed: true },
      { method: 'setControlAllowed', args: [true] },
      { channel: 'remote:setControlAllowed', allowed: true }
    ];
    for (const frame of attempts) assert.equal(await laptop.remote('send', homeId, frame), true);
    await waitFor('the frames', async () => (await home.frameCount()) === attempts.length);
    assert.deepEqual(await home.frames(), attempts);
    assert.equal((await home.remote('status')).controlAllowed, false);

    // The switch does work from this device's own window.
    assert.deepEqual(await home.remote('setControlAllowed', true), { ok: true });
    assert.equal((await home.remote('status')).controlAllowed, true);
    assert.deepEqual(await home.remote('setControlAllowed', false), { ok: true });
  });

  await t.test('a frame of the signaling type never reaches the renderer, from this end or the other', async () => {
    await home.page.evaluate(() => {
      window.__frames = [];
    });
    assert.equal(await laptop.remote('send', homeId, { type: 'rtc', data: { attempt: 1, kind: 'offer', sdp: 'x' } }), false);
    assert.equal(await laptop.remote('send', homeId, { type: 'after' }), true);
    await waitFor('the frame after', async () => (await home.frameCount()) === 1);
    assert.deepEqual(await home.frames(), [{ type: 'after' }]);
  });

  await t.test("isLocalUi refuses IPC from the hidden window, and every remote: channel goes through it", async () => {
    await home.transport();
    // A real ipcRenderer in the real hidden window, which its page can't otherwise get to,
    // through a preload only this test adds. It goes in before the page reloads.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-preload-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe, `
      const { contextBridge, ipcRenderer } = require('electron');
      if (location.href.includes(${JSON.stringify(TRANSPORT_PAGE)})) {
        contextBridge.exposeInMainWorld('__probe', {
          invoke: (channel, args) => ipcRenderer.invoke(channel, args).then(
            (value) => ({ ok: true, value }),
            (err) => ({ ok: false, message: String(err && err.message) })
          )
        });
      }
    `);
    await home.app.evaluate(({ BrowserWindow, session }, [file, page]) => {
      session.defaultSession.setPreloads([file]);
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(page)).webContents.reload();
    }, [probe, TRANSPORT_PAGE]);
    const hidden = await waitFor('the probe', async () => {
      const page = home.app.windows().find((w) => w.url().includes(TRANSPORT_PAGE));
      try {
        return page && (await page.evaluate(() => Boolean(window.__probe))) ? page : null;
      } catch {
        return null; // mid-reload
      }
    });

    const calls = [
      ['remote:status', {}],
      ['remote:setAddress', { url: '' }],
      ['remote:setPin', { pin: '654321' }],
      ['remote:unlock', { pin: PIN }],
      ['remote:lock', {}],
      ['remote:createCode', {}],
      ['remote:cancelCode', {}],
      ['remote:pair', { code: 'ABC', name: 'x', pin: PIN }],
      ['remote:removeDevice', { id: laptopId }],
      ['remote:setControlAllowed', { allowed: true }],
      ['remote:send', { deviceId: laptopId, frame: { type: 'from-hidden' } }]
    ];
    for (const [channel, args] of calls) {
      const answer = await hidden.evaluate(([c, a]) => window.__probe.invoke(c, a), [channel, args]);
      assert.equal(answer.ok, false, `${channel} answered the hidden window`);
      assert.match(answer.message, /can only be used from this app's own window/, channel);
    }

    // None of that did anything, and the same call from the real window is fine.
    const status = await home.remote('status');
    assert.equal(status.controlAllowed, false);
    assert.equal(status.devices.length, 1);
    await sleep(500);
    assert.ok(!(await laptop.frames()).some((f) => f.type === 'from-hidden'));
    await home.app.evaluate(({ session }) => session.defaultSession.setPreloads([]));
  });
});
