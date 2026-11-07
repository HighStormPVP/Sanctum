// What the renderer gets from Remote Control, checked in the real app, and that nothing else
// can use it: the methods on window.api.remote, what status() gives away, that a peer's
// frame can't reach the control switch. And that the hidden window, the one renderer handling
// what peers and the network send, gets nothing: no IPC, no shared storage, no broadcasts.
//
//   node e2e/preload-surface.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startPair, waitFor, sleep, SECRET, PIN, TRANSPORT_PAGE, MODEL } = require('./harness.js');

const PARTITION = 'remote-transport';
const REFUSED = /can only be used from this app's own window/;

const REMOTE_METHODS = [
  'audit', 'cancelCode', 'createCode', 'endRun', 'lock', 'onFrame', 'onStatus', 'pair', 'removeDevice',
  'send', 'setAddress', 'setControlAllowed', 'setPin', 'status', 'unlock'
];

const APP_METHODS = ['answerSuggestion', 'getAvailabilitySettings', 'onShown', 'setKeepAwake', 'setSharing', 'setStartAtLogin'];

test('the preload surface', async (t) => {
  const pair = await startPair();
  t.after(() => pair.stop());
  const { home, laptop, homeId, laptopId } = pair;

  await t.test('window.api.remote exposes the listed methods and nothing else', async () => {
    assert.deepEqual(await home.page.evaluate(() => Object.keys(window.api.remote).sort()), REMOTE_METHODS);
    assert.ok(await home.page.evaluate(() => Object.values(window.api.remote).every((v) => typeof v === 'function')));
  });

  // Added on purpose in Task 14: keeping this PC available while a chat is shared.
  await t.test('window.api.app exposes the listed methods and nothing else', async () => {
    assert.deepEqual(await home.page.evaluate(() => Object.keys(window.api.app).sort()), APP_METHODS);
    assert.ok(await home.page.evaluate(() => Object.values(window.api.app).every((v) => typeof v === 'function')));
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
    assert.deepEqual(Object.keys(entry).sort(), ['connected', 'fingerprint', 'id', 'longQuiet', 'name', 'path', 'quiet', 'role']);
  });

  await t.test("a peer's frame can't reach the control switch, and only ever reaches the renderer", async () => {
    await home.page.evaluate(() => {
      window.__frames = [];
    });
    const attempts = [
      { type: 'setControlAllowed', allowed: true },
      { type: 'probe', t: 'setControlAllowed', allowed: true },
      { type: 'probe', setControlAllowed: true },
      { type: 'probe', method: 'setControlAllowed', args: [true] },
      { type: 'probe', channel: 'remote:setControlAllowed', allowed: true }
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

  // Asking only: nothing here opens a microphone or a camera, even where it would be allowed.
  await t.test('the hidden window is granted no web permission, and the main page only writing to the clipboard', async () => {
    const hidden = await home.transport();
    const ask = (page) => page.evaluate(async () => {
      const query = async (name) => {
        try {
          return (await navigator.permissions.query({ name })).state;
        } catch (e) {
          return `error: ${e.message}`;
        }
      };
      const answers = {};
      for (const name of ['notifications', 'geolocation', 'microphone', 'camera', 'clipboard-read', 'clipboard-write', 'midi']) answers[name] = await query(name);
      answers.requested = await Notification.requestPermission();
      return answers;
    });
    const none = { notifications: 'denied', geolocation: 'denied', microphone: 'denied', camera: 'denied', 'clipboard-read': 'denied', 'clipboard-write': 'denied', midi: 'denied', requested: 'denied' };
    assert.deepEqual(await ask(hidden), none);
    assert.deepEqual(await ask(home.page), { ...none, 'clipboard-write': 'granted' });

    // And Copy on a code block still works. Whatever was on the clipboard goes back afterwards.
    const saved = await home.app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage().toDataURL() }));
    try {
      await home.page.evaluate((model) => {
        createChat(model, 'chat', { title: 'Copy', titleManual: true });
        currentChat().messages.push({ role: 'assistant', content: '```js\nconsole.log("copied by a test")\n```' });
        renderActiveChat();
      }, MODEL);
      await home.page.evaluate(() => document.querySelector('#thread button[data-cb-action="copy"]').click());
      await waitFor('Copy to answer', () => home.page.evaluate(() => /Copied|Copy failed/.test(document.querySelector('#thread button[data-cb-action="copy"]').textContent)), 5000);
      assert.equal(await home.page.evaluate(() => document.querySelector('#thread button[data-cb-action="copy"]').textContent), 'Copied');
      assert.equal(await home.app.evaluate(({ clipboard }) => clipboard.readText()), 'console.log("copied by a test")');
    } finally {
      await home.app.evaluate(({ clipboard, nativeImage }, was) => {
        const restore = {};
        if (was.text) restore.text = was.text;
        if (was.html) restore.html = was.html;
        if (was.rtf) restore.rtf = was.rtf;
        const image = nativeImage.createFromDataURL(was.image);
        if (!image.isEmpty()) restore.image = image;
        clipboard.clear();
        if (Object.keys(restore).length) clipboard.write(restore);
      }, saved);
    }
  });

  await t.test('the hidden window is cut off from everything else', async (s) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-preload-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    await home.transport();

    // A real ipcRenderer in each real window, which their pages can't otherwise get to, through
    // a preload only this test adds. Each window's session gets it, and each page loads again.
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe, `
      const { contextBridge, ipcRenderer } = require('electron');
      const received = [];
      for (const channel of ['mcp:updated', 'system:freeze-abort']) {
        ipcRenderer.on(channel, (_e, payload) => received.push({ channel, payload }));
      }
      contextBridge.exposeInMainWorld('__probe', {
        invoke: (channel, args) => ipcRenderer.invoke(channel, args).then(
          (value) => ({ ok: true, value }),
          (err) => ({ ok: false, message: String(err && err.message) })
        ),
        send: (channel) => ipcRenderer.send(channel),
        received: () => JSON.parse(JSON.stringify(received))
      });
    `);
    await home.app.evaluate(({ BrowserWindow, session }, [file, partition]) => {
      session.defaultSession.setPreloads([file]);
      session.fromPartition(partition).setPreloads([file]);
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
    }, [probe, PARTITION]);

    const probed = (find) =>
      waitFor('the probe', async () => {
        const page = find();
        try {
          return page && (await page.evaluate(() => Boolean(window.__probe && window.api !== null))) ? page : null;
        } catch {
          return null; // mid-reload
        }
      });
    const hidden = await probed(() => home.app.windows().find((w) => w.url().includes(TRANSPORT_PAGE)));
    await probed(() => home.page);
    await waitFor('window.api after the reload', () => home.page.evaluate(() => Boolean(window.api?.remote)));
    await home.record();
    const fromHidden = (channel, args) => hidden.evaluate(([c, a]) => window.__probe.invoke(c, a), [channel, args]);
    const fromMain = (channel, args) => home.page.evaluate(([c, a]) => window.__probe.invoke(c, a), [channel, args]);
    const fromHiddenReceived = () => hidden.evaluate(() => window.__probe.received());

    await s.test('isLocalUi refuses it on every remote: channel', async () => {
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
        ['remote:send', { deviceId: laptopId, frame: { type: 'from-hidden' } }],
        ['remote:audit', { event: 'from-hidden' }],
        ['remote:endRun', { deviceId: laptopId, id: 'x' }]
      ];
      for (const [channel, args] of calls) {
        const answer = await fromHidden(channel, args);
        assert.equal(answer.ok, false, `${channel} answered the hidden window`);
        assert.match(answer.message, REFUSED, channel);
      }
      const status = await home.remote('status');
      assert.equal(status.controlAllowed, false);
      assert.equal(status.devices.length, 1);
      await sleep(500);
      assert.ok(!(await laptop.frames()).some((f) => f.type === 'from-hidden'));
    });

    await s.test('a raw shell:run from it is refused and runs nothing, and the main window can still run one', async () => {
      const marker = path.join(dir, 'ran.txt');
      const command = 'echo ran > ran.txt';
      const refused = await fromHidden('shell:run', { command, cwd: dir });
      assert.equal(refused.ok, false, JSON.stringify(refused));
      assert.match(refused.message, REFUSED);
      await sleep(1000);
      assert.equal(fs.existsSync(marker), false, 'the command ran');

      const ran = await home.page.evaluate(([c, d]) => window.api.shell.run(c, d), [command, dir]);
      assert.equal(ran.exitCode, 0, JSON.stringify(ran));
      assert.equal(fs.existsSync(marker), true);
    });

    await s.test('every registered channel refuses it, and nothing registered can be missed', async () => {
      const { handlers, listeners } = await home.app.evaluate(({ ipcMain }) => ({
        handlers: [...ipcMain._invokeHandlers.keys()],
        listeners: ipcMain.eventNames().filter((name) => typeof name === 'string')
      }));
      assert.ok(handlers.length >= 50, `only ${handlers.length} handlers found: did the registry move?`);

      // What the source registers has to be in that registry, so reading it can't miss any.
      const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
      const named = [...source.matchAll(/\b(?:ipcMain\.handle|handleRemote)\(\s*'([^']+)'/g)].map((m) => m[1]);
      assert.ok(named.length >= 50);
      for (const channel of named) assert.ok(handlers.includes(channel), `${channel} isn't registered`);
      const registrations = [...source.matchAll(/\bipcMain\.(handle|handleOnce|on|once|addListener|prependListener|prependOnceListener)\(/g)];
      assert.equal(registrations.length, named.filter((c) => !c.startsWith('remote:')).length + 1, 'a registration this test cannot read the name of');

      for (const channel of handlers) {
        const answer = await fromHidden(channel, undefined);
        assert.equal(answer.ok, false, `${channel} answered the hidden window: ${JSON.stringify(answer)}`);
        assert.match(answer.message, REFUSED, channel);
      }
      // Electron's own no-op on 'error' is always there. Anything else is new, and this test
      // should send it something too. The next test shows every way of adding one is guarded.
      const added = listeners.filter((name) => name !== 'error');
      assert.deepEqual(added, [], `a listener on ipcMain, check this test covers it: ${added}`);
    });

    await s.test('anything registered later is guarded too, however it registers', async () => {
      await home.app.evaluate(({ ipcMain }) => {
        globalThis.__hits = [];
        const hit = (name) => () => {
          globalThis.__hits.push(name);
          return name;
        };
        for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) ipcMain[method](`e2e:${method}`, hit(method));
        for (const method of ['handle', 'handleOnce']) ipcMain[method](`e2e:${method}`, hit(method));
      });
      const hits = () => home.app.evaluate(() => globalThis.__hits);
      const listeners = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'];

      for (const method of listeners) await hidden.evaluate((c) => window.__probe.send(c), `e2e:${method}`);
      for (const method of ['handle', 'handleOnce']) {
        const answer = await fromHidden(`e2e:${method}`);
        assert.equal(answer.ok, false, method);
        assert.match(answer.message, REFUSED);
      }
      await sleep(300);
      assert.deepEqual(await hits(), []);

      // And they do work, so what stopped them above was the sender.
      for (const method of listeners) await home.page.evaluate((c) => window.__probe.send(c), `e2e:${method}`);
      for (const method of ['handle', 'handleOnce']) assert.deepEqual(await fromMain(`e2e:${method}`), { ok: true, value: method });
      await waitFor('the listeners', async () => (await hits()).length === listeners.length + 2);
    });

    await s.test("it can't read the main window's storage, and is in a session of its own", async () => {
      await home.page.evaluate(() => localStorage.setItem('e2e-only-in-main', 'visible'));
      const main = await home.page.evaluate(() => Object.keys(localStorage));
      assert.ok(main.includes('e2e-only-in-main'));
      assert.ok(main.includes('localai.settings.v1') || main.includes('localai.state.v1'), `main window's keys: ${main}`);

      const seen = await hidden.evaluate(() => ({
        keys: Object.keys(localStorage),
        value: localStorage.getItem('e2e-only-in-main'),
        state: localStorage.getItem('localai.state.v1'),
        settings: localStorage.getItem('localai.settings.v1')
      }));
      assert.deepEqual(seen, { keys: [], value: null, state: null, settings: null });

      // Going the other way, too.
      await hidden.evaluate(() => localStorage.setItem('e2e-only-in-hidden', 'visible'));
      assert.equal(await home.page.evaluate(() => localStorage.getItem('e2e-only-in-hidden')), null);
      assert.deepEqual(await home.hiddenWindowFacts(), {
        visible: false, contextIsolation: true, sandbox: true, nodeIntegration: false, ownSession: true, sessionPersists: false
      });
    });

    await s.test('it gets no MCP update, which holds tokens, and the main window does', async () => {
      await home.page.evaluate(() => {
        window.__mcp = [];
        window.api.mcp.onUpdate((servers) => window.__mcp.push(servers));
      });
      const token = 'e2e-mcp-token-that-stays-in-the-main-window';
      // A command that doesn't exist, so nothing runs. It still announces the change.
      await home.page.evaluate(
        ([value]) => window.api.mcp.add('e2e-probe', { command: 'sanctum-e2e-no-such-command', args: [], env: { TOKEN: value } }).catch(() => {}),
        [token]
      );
      await waitFor('the update', () => home.page.evaluate((value) => window.__mcp.some((servers) => JSON.stringify(servers).includes(value)), token));
      await sleep(300);
      assert.deepEqual(await fromHiddenReceived(), []);
      await home.page.evaluate(() => window.api.mcp.remove('e2e-probe').catch(() => {}));
    });

    await s.test('it gets no freeze-abort notice, and the main window does', async () => {
      await home.page.evaluate(async () => {
        window.__freeze = [];
        window.api.watchdog.onFreezeAbort((payload) => window.__freeze.push(payload));
        await window.api.watchdog.config({ enabled: true, tripMs: 5000 });
        // Local as far as the watchdog knows. The fake Ollama never answers it.
        window.api.ollama.chat({ model: 'e2e-fake-model', messages: [] }, () => {}).catch(() => {});
      });
      await waitFor('the chat to be under way', () => pair.ollama.chats() > 0);
      // The freeze itself: this process doing nothing else for longer than the limit.
      await home.app.evaluate(() => {
        const until = Date.now() + 6500;
        while (Date.now() < until);
      });
      await waitFor('the notice', () => home.page.evaluate(() => window.__freeze.length > 0), 20000);
      await sleep(300);
      assert.deepEqual(await fromHiddenReceived(), []);
    });

    await s.test('nothing in main.js broadcasts to every window any more', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
      assert.ok(!source.includes('getAllWindows'));
      assert.ok(!source.includes('getAllWebContents'));
    });

    await s.test('its page comes from a scheme of its own, on its session alone, and only that one page', async () => {
      assert.deepEqual(
        await hidden.evaluate(() => [location.protocol, location.host, location.pathname]),
        ['aio-transport:', 'app', '/remote-transport.html']
      );
      const results = await home.app.evaluate(async ({ session }, partition) => {
        const own = session.fromPartition(partition);
        const status = (url, options) => own.fetch(url, options).then((r) => r.status, () => 'failed');
        const page = await own.fetch('aio-transport://app/remote-transport.html');
        return {
          handledOnOwn: own.protocol.isProtocolHandled('aio-transport'),
          handledOnDefault: session.defaultSession.protocol.isProtocolHandled('aio-transport'),
          fromDefault: await session.defaultSession.fetch('aio-transport://app/remote-transport.html').then((r) => r.status, () => 'failed'),
          good: page.status,
          type: page.headers.get('content-type'),
          hasCsp: (await page.text()).includes('Content-Security-Policy'),
          withLog: await status('aio-transport://app/remote-transport.html?log=1'),
          others: await Promise.all([
            'aio-transport://app/',
            'aio-transport://app/main.js',
            'aio-transport://app/preload.js',
            'aio-transport://app/remote-transport-preload.js',
            'aio-transport://app/package.json',
            'aio-transport://app/../main.js',
            'aio-transport://app/remote-transport.html/../main.js',
            'aio-transport://app/remote-transport.html/..%2fmain.js',
            'aio-transport://app/%2e%2e/main.js',
            'aio-transport://app/REMOTE-TRANSPORT.HTML',
            'aio-transport://app/remote-transport.html/',
            'aio-transport://other/remote-transport.html'
          ].map((url) => status(url))),
          posted: await status('aio-transport://app/remote-transport.html', { method: 'POST' })
        };
      }, PARTITION);
      assert.deepEqual(results, {
        handledOnOwn: true,
        handledOnDefault: false,
        fromDefault: 'failed',
        good: 200,
        type: 'text/html; charset=utf-8',
        hasCsp: true,
        withLog: 200,
        others: Array(12).fill(404),
        posted: 404
      });
    });

    // Run last among these, since it reloads the page without its CSP. Without the CSP is the
    // case that counts: an exploit wouldn't be bound by it, so what's left has to hold alone.
    await s.test("a file: URL doesn't load from it, even with its CSP out of the way", async () => {
      const target = path.join(dir, 'file-target.html');
      fs.writeFileSync(target, '<!DOCTYPE html><title>target</title>');
      const targetUrl = pathToFileURL(target).href;
      // A frame refused a load can still report the URL, on its error page, so what counts is
      // whether the target's own document is in there.
      const framesHoldingTarget = (pageName) =>
        home.app.evaluate(async ({ BrowserWindow }, wanted) => {
          const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(wanted));
          const titles = await Promise.all(win.webContents.mainFrame.frames.map((frame) =>
            Promise.race([
              frame.executeJavaScript('document.title').catch(() => 'unreachable'),
              new Promise((resolve) => setTimeout(() => resolve('no answer'), 1000))
            ])));
          return titles.filter((title) => title === 'target').length;
        }, pageName);
      const attempt = (url) =>
        hidden.evaluate(async (fileUrl) => {
          const fetched = await fetch(fileUrl).then(() => 'loaded', () => 'failed');
          const framed = await new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.onload = () => resolve('load event');
            iframe.onerror = () => resolve('error event');
            iframe.src = fileUrl;
            document.body.append(iframe);
            setTimeout(() => resolve('nothing'), 1500);
          });
          return { fetched, framed };
        }, url);

      // As shipped.
      assert.equal((await attempt(targetUrl)).fetched, 'failed');
      assert.equal(await framesHoldingTarget(TRANSPORT_PAGE), 0);

      const cdp = await hidden.context().newCDPSession(hidden);
      await cdp.send('Page.enable');
      await cdp.send('Page.setBypassCSP', { enabled: true });
      await hidden.reload();
      await waitFor('the probe after the reload', () => hidden.evaluate(() => Boolean(window.__probe)));
      const without = await attempt(targetUrl);
      assert.equal(without.fetched, 'failed');
      assert.equal(await framesHoldingTarget(TRANSPORT_PAGE), 0, 'the file: URL loaded in a frame');

      // The same attempt from a page that does have a file: origin, in the same session: the
      // frame loads, so not seeing one above means something.
      const control = path.join(dir, 'control.html');
      fs.writeFileSync(control, `<!DOCTYPE html><iframe src="${targetUrl}"></iframe>`);
      const controlTitles = await home.app.evaluate(async ({ BrowserWindow }, [file, partition]) => {
        const win = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } });
        await win.loadFile(file);
        const titles = await Promise.all(win.webContents.mainFrame.frames.map((frame) => frame.executeJavaScript('document.title')));
        win.destroy();
        return titles;
      }, [control, PARTITION]);
      assert.deepEqual(controlTitles, ['target']);

      await cdp.send('Page.setBypassCSP', { enabled: false });
      await hidden.reload();
      await cdp.detach();
      await home.waitForPath('direct', 90000);
    });

    await home.app.evaluate(({ session }, partition) => {
      session.defaultSession.setPreloads([]);
      session.fromPartition(partition).setPreloads([]);
    }, PARTITION);
  });
});
