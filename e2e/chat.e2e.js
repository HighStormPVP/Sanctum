// One home PC with no laptop, against a fake Ollama this file scripts: how long Sanctum waits for
// a local model, what it says when Ollama fails, which context window a chat asks for, the plan
// card, and the floating menus. Nothing here reaches a real model or a paid API.
//
//   node e2e/chat.e2e.js
//   SANCTUM_SLOW_TESTS=1 node e2e/chat.e2e.js     also waits out the old 5-minute limit for real
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launchDevice, waitFor, sleep, MODEL } = require('./harness.js');

const SHOTS = process.env.SANCTUM_SHOTS || null;
const SLOW = process.env.SANCTUM_SLOW_TESTS === '1';

// A fake Ollama with one model. Each chat request waits for the test to say what to do with it,
// except a title request, which is answered at once.
async function startOllama() {
  const pending = [];
  const waiters = [];
  const fake = { loaded: true, contextLength: 32768 };
  const json = (res, value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, size: 1000000000 }] });
      if (req.url === '/api/ps') return json(res, { models: fake.loaded ? [{ name: MODEL, model: MODEL }] : [] });
      if (req.url === '/api/show') {
        return json(res, { model_info: { 'fake.context_length': fake.contextLength }, details: {}, capabilities: ['completion', 'tools'] });
      }
      if (req.url !== '/api/chat') return json(res, {});
      const body = JSON.parse(raw);
      if (body.options?.num_predict === 32) {
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'A title' } })}\n${JSON.stringify({ done: true })}\n`);
        return undefined;
      }
      const reply = {
        body,
        closed: false,
        headers: () => {
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.flushHeaders();
        },
        line: (value) => {
          reply.headers();
          res.write(`${JSON.stringify(value)}\n`);
        },
        say: (content) => reply.line({ message: { role: 'assistant', content } }),
        call: (...calls) => reply.line({ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })) } }),
        finish: () => {
          reply.headers();
          res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 7, eval_count: 9 })}\n`);
        },
        fail: (status, text) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: text }));
        },
        cut: () => res.socket.destroy()
      };
      res.on('close', () => { reply.closed = true; });
      if (waiters.length) waiters.shift()(reply);
      else pending.push(reply);
      return undefined;
    });
  });
  let port = 0;
  const listen = () => new Promise((resolve) => server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  await listen();
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    next: (ms = 20000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no chat request reached the fake Ollama')), ms);
      const got = (reply) => { clearTimeout(timer); resolve(reply); };
      if (pending.length) got(pending.shift());
      else waiters.push(got);
    }),
    // Nothing listening on the port, so a connection is refused, as with Ollama not running.
    goAway: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
    comeBack: listen,
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  });
}

const textOf = (device, selector) => device.page.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector);

// The background colour's alpha, from the computed style.
const alphaOf = (device, selector) => device.page.evaluate((s) => {
  const color = getComputedStyle(document.querySelector(s)).backgroundColor;
  const parts = color.match(/[\d.]+/g).map(Number);
  return parts.length === 4 ? parts[3] : 1;
}, selector);

const THEMES = ['sanctum', 'dark', 'light'];
const setTheme = (device, theme) => device.page.evaluate((t) => applyTheme(t), theme);

async function shot(device, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await device.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('one home PC and a fake Ollama', async (t) => {
  const ollama = await startOllama();
  const home = await launchDevice('home', { ollamaUrl: ollama.url });
  t.after(async () => {
    await home.stop();
    await ollama.stop();
  });
  await waitFor('the app to start', () => home.page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));
  await waitFor('the model to show as installed', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
  await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-chat-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));

  // A new project chat, the way the app makes one, with a folder so it can send.
  const newProject = (extra = {}) => home.page.evaluate(([m, dir, more]) => {
    createChat(m, 'agent', { ...agenticChatFields(), projectFolder: dir, pathAllowlist: [dir], webEnabled: false, titleManual: true, ...more });
    return state.activeId;
  }, [MODEL, folder, extra]);
  const send = (id, text) => home.page.evaluate(([chatId, words]) => {
    submitToChat(state.chats[chatId], words, []).catch((e) => console.error(e));
  }, [id, text]);
  const running = (id) => home.page.evaluate((chatId) => state.runningChats.has(chatId), id);
  const stopped = (id, ms = 15000) => waitFor('the chat to stop', async () => !(await running(id)), ms);
  const chatField = (id, field) => home.page.evaluate(([chatId, f]) => state.chats[chatId][f], [id, field]);
  const hasOwnField = (id, field) => home.page.evaluate(([chatId, f]) => Object.prototype.hasOwnProperty.call(state.chats[chatId], f), [id, field]);
  // What a send in this chat asks Ollama for.
  async function numCtxOf(id) {
    await send(id, 'Hello');
    const reply = await ollama.next();
    reply.say('Hi.');
    reply.finish();
    await stopped(id);
    return reply.body.options.num_ctx;
  }
  const pinContext = (value) => home.page.evaluate(([m, v]) => {
    if (v) state.settings.contextWindows = { ...state.settings.contextWindows, [m]: v };
    else delete state.settings.contextWindows?.[m];
    saveSettings();
  }, [MODEL, value]);
  const reload = async () => {
    await home.page.reload();
    await waitFor('the app to start again', () => home.page.evaluate(() => typeof state !== 'undefined' && state.order.length > 0 && Boolean(state.catalog)), 30000);
    await waitFor('the model to show as installed again', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
    await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
  };

  await t.test('floating menus are opaque in every theme', async () => {
    await home.page.click('#open-settings');
    await home.page.click('.set-nav-btn[data-panel="context"]');
    await waitFor('a context window row', () => home.page.evaluate(() => Boolean(document.querySelector('#ctx-list .sel-btn'))));
    // The list is drawn again when the model's details arrive, which closes an open menu.
    await sleep(500);
    const openMenu = async () => {
      if (await home.page.evaluate(() => !document.querySelector('#ctx-list .sel-menu').hidden)) return;
      await home.page.click('#ctx-list .sel-btn');
      await waitFor('the menu to open', () => home.page.evaluate(() => !document.querySelector('#ctx-list .sel-menu').hidden));
    };
    for (const theme of THEMES) {
      await setTheme(home, theme);
      await openMenu();
      assert.equal(await alphaOf(home, '#ctx-list .sel-menu'), 1, `the menu in ${theme}`);
      await sleep(250);
      await openMenu();
      await shot(home, `context-menu-${theme}`);
    }
    await home.page.keyboard.press('Escape');
    if (await home.page.evaluate(() => !document.querySelector('#settings-overlay').hidden)) await home.page.click('#settings-close');
    await home.page.evaluate(() => showToast('A toast over the thread'));
    for (const theme of THEMES) {
      await setTheme(home, theme);
      assert.equal(await alphaOf(home, '#toast-host .toast'), 1, `a toast in ${theme}`);
    }
    await setTheme(home, 'sanctum');
    await home.page.evaluate(() => document.querySelectorAll('#toast-host .toast').forEach((el) => el.remove()));
  });

  await t.test('the context window comes from Settings unless the chat has its own', async (s) => {
    await s.test('a new project chat sends what Settings gives its model', async () => {
      await pinContext(16384);
      const id = await newProject();
      assert.equal(await hasOwnField(id, 'contextWindow'), false, 'a new chat has no size of its own');
      assert.equal(await numCtxOf(id), 16384, 'the size pinned in Settings');
      await pinContext(null);
      const auto = await home.page.evaluate((m) => contextWindowFor(m), MODEL);
      assert.equal(await numCtxOf(id), auto, "Auto's suggestion");
    });

    await s.test('a chat with its own size sends that', async () => {
      await pinContext(16384);
      const id = await newProject({ contextWindow: 4096 });
      assert.equal(await numCtxOf(id), 4096);
      await pinContext(null);
    });

    await s.test("the chat options field: empty means Settings, a number is the chat's own", async () => {
      await pinContext(16384);
      const id = await newProject();
      await home.page.evaluate(() => openAgentOpts());
      await waitFor('the options to open', () => home.page.evaluate(() => !document.querySelector('#agent-opts-overlay').hidden));
      assert.equal(await home.page.inputValue('#agent-opts-ctx'), '');
      assert.equal(await home.page.getAttribute('#agent-opts-ctx', 'placeholder'), 'Settings: 16K');
      assert.match(await textOf(home, '#agent-opts-ctx-help'), /Leave empty to use Settings > Context Windows\./);
      await home.page.locator('#agent-opts-ctx-help').scrollIntoViewIfNeeded();
      await sleep(400);
      await shot(home, 'chat-options-context');

      await home.page.fill('#agent-opts-ctx', '4096');
      await home.page.evaluate(() => closeAgentOpts());
      assert.equal(await chatField(id, 'contextWindow'), 4096);
      await home.page.evaluate(() => openAgentOpts());
      assert.equal(await home.page.inputValue('#agent-opts-ctx'), '4096');
      await home.page.fill('#agent-opts-ctx', '999999');
      await home.page.evaluate(() => closeAgentOpts());
      assert.equal(await chatField(id, 'contextWindow'), 131072, 'still clamped');

      await home.page.evaluate(() => openAgentOpts());
      await home.page.fill('#agent-opts-ctx', '');
      await home.page.evaluate(() => closeAgentOpts());
      assert.equal(await hasOwnField(id, 'contextWindow'), false, "empty takes the chat's own size away");
      assert.equal(await numCtxOf(id), 16384);
      await pinContext(null);
    });

    await s.test('chats left on the old automatic 8K lose it once, and nothing else changes', async () => {
      const ids = await home.page.evaluate(() => {
        const make = (fields) => addChat(state.settings.lastModel || 'x', 'agent', { ...agenticChatFields(), ...fields }).id;
        const ids = { old: make({ contextWindow: 8192 }), small: make({ contextWindow: 4096 }), big: make({ contextWindow: 32768 }), none: make({}) };
        delete state.chats[ids.none].contextWindow;
        delete state.settings.migrations;
        saveSettings();
        saveToStorage();
        return ids;
      });
      await reload();
      assert.equal(await hasOwnField(ids.old, 'contextWindow'), false, '8192 was the default nobody chose');
      assert.equal(await chatField(ids.small, 'contextWindow'), 4096);
      assert.equal(await chatField(ids.big, 'contextWindow'), 32768);
      assert.equal(await hasOwnField(ids.none, 'contextWindow'), false);
      assert.equal(await home.page.evaluate(() => state.settings.migrations?.ctxDefault8k), true);

      // Chosen after the move, 8K stays.
      await home.page.evaluate((id) => { state.chats[id].contextWindow = 8192; saveToStorage(); }, ids.old);
      await reload();
      assert.equal(await chatField(ids.old, 'contextWindow'), 8192, 'it ran once');
      await home.page.evaluate((list) => { for (const id of list) deleteChat(id); }, Object.values(ids));
    });
  });

  // ---- Waiting on a local model ----

  const plainChat = (model = MODEL) => home.page.evaluate((m) => {
    createChat(m, 'chat', { webEnabled: false, titleManual: true });
    return state.activeId;
  }, model);
  const lastReply = (id) => home.page.evaluate((chatId) => latestAssistant(state.chats[chatId])?.content ?? null, id);

  await t.test('Sanctum waits for a local model however long it takes to start', async (s) => {
    await s.test('a reply that starts after the global fetch limit, and pauses past it, still arrives', async () => {
      // Electron's global fetch gives up after 300 s with nothing back. That's too long to wait
      // here, so it's lowered to 1 s in this app's main process, and the fake waits 3 s.
      const limit = await home.app.evaluate(async (_electron, url) => {
        const key = Symbol.for('undici.globalDispatcher.1');
        if (!globalThis[key]) await fetch(`${url}/api/tags`).then((r) => r.text());
        const Agent = globalThis[key].constructor;
        globalThis[key] = new Agent({ headersTimeout: 1000, bodyTimeout: 1000 });
        // The lowered limit bites: the same kind of silent request, through the global fetch.
        try {
          await fetch(`${url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'probe', messages: [] }) });
          return 'no limit';
        } catch (e) {
          return e.cause?.code || e.message;
        }
      }, ollama.url);
      const probe = await ollama.next();
      assert.equal(limit, 'UND_ERR_HEADERS_TIMEOUT', 'the global fetch now gives up after 1 s');
      probe.cut();

      const id = await plainChat();
      await send(id, 'Take your time');
      const reply = await ollama.next();
      await sleep(3000);
      reply.say('Slow ');
      await sleep(3000);
      reply.say('but here.');
      reply.finish();
      await stopped(id);
      assert.equal(await lastReply(id), 'Slow but here.');
    });

    await s.test('Stop during the silent wait ends it at once, and Ollama sees the request go', async () => {
      const id = await plainChat();
      await send(id, 'Never mind');
      const reply = await ollama.next();
      await sleep(500);
      const pressed = Date.now();
      await home.page.evaluate((chatId) => stopChat(chatId), id);
      await waitFor('the fake Ollama to see the connection close', () => reply.closed, 2000);
      await stopped(id, 2000);
      assert.ok(Date.now() - pressed < 2000);
      assert.equal(await lastReply(id), '_Stopped._');
    });

    await s.test('past 2 minutes the waiting line says the model is slow to start, with the seconds still counting', async () => {
      const id = await plainChat();
      await send(id, 'Hello?');
      const reply = await ollama.next();
      const status = () => textOf(home, '#thread .msg-thinking .msg-status-text');
      await waitFor('Reading your message', async () => (await status()) === 'Reading your message', 5000);
      await home.page.evaluate((chatId) => { latestAssistant(state.chats[chatId]).startup.startedAt -= 121000; }, id);
      await waitFor('the slow-start words', async () => (await status()) === 'Reading your message — this model is slow to start right now', 5000);
      assert.match(await textOf(home, '#thread .msg-thinking .msg-status-time'), /^12\ds$/);
      reply.say('Here.');
      reply.finish();
      await stopped(id);
    });

    await s.test('5 and a half minutes of silence, for real', { skip: !SLOW && 'set SANCTUM_SLOW_TESTS=1 to run it' }, async () => {
      // With Electron's own limits as they ship: nothing lowered and nothing raised.
      await home.app.evaluate(async () => {
        const key = Symbol.for('undici.globalDispatcher.1');
        globalThis[key] = new (globalThis[key].constructor)();
      });
      const id = await plainChat();
      const started = Date.now();
      await send(id, 'Take five and a half minutes');
      const reply = await ollama.next();
      await sleep(330000);
      assert.equal(reply.closed, false, 'still waiting');
      reply.say('Worth the wait.');
      reply.finish();
      await stopped(id);
      const waited = Math.round((Date.now() - started) / 1000);
      console.log(`# waited ${waited} s, then the reply was: ${JSON.stringify(await lastReply(id))}`);
      assert.equal(await lastReply(id), 'Worth the wait.');
    });
  });

  await t.test('a failed reply says what really happened', async (s) => {
    await s.test("nothing listening: Couldn't reach Ollama", async () => {
      const id = await plainChat();
      await ollama.goAway();
      try {
        await send(id, 'Anyone there?');
        await stopped(id);
      } finally {
        await ollama.comeBack();
      }
      const text = await lastReply(id);
      assert.match(text, /Couldn't reach Ollama/);
      assert.match(text, /ERR_CONNECTION_REFUSED|ECONNREFUSED/, 'with the error underneath');
    });

    await s.test('cut off partway: says so, and not that Ollama is missing', async () => {
      const id = await plainChat();
      await send(id, 'Tell me a story');
      const reply = await ollama.next();
      reply.say('Once upon');
      await sleep(300);
      reply.cut();
      await stopped(id);
      const text = await lastReply(id);
      assert.ok(text.includes('Ollama stopped partway through this reply.'), text);
      assert.doesNotMatch(text, /Couldn't reach Ollama/);
      assert.match(text, /Underlying error: .+/);
    });

    await s.test('an error status from Ollama: Ollama answered, with an error', async () => {
      const id = await plainChat();
      await send(id, 'Break');
      const reply = await ollama.next();
      reply.fail(500, 'llama runner process has terminated');
      await stopped(id);
      const text = await lastReply(id);
      assert.match(text, /Ollama returned an error/);
      assert.match(text, /llama runner process has terminated/);
      assert.doesNotMatch(text, /Couldn't reach Ollama/);
    });

    await s.test("a cloud model that can't be reached is named, and Ollama isn't", async () => {
      // The main process's fetch to the provider fails as an unplugged cable would, before
      // anything leaves this machine.
      const stubbed = await home.app.evaluate(() => {
        const real = globalThis.fetch;
        globalThis.fetch = (url, options) => {
          if (/^https:\/\/(api\.anthropic\.com|generativelanguage\.googleapis\.com)\//.test(String(url))) {
            globalThis.__cloudCalls = (globalThis.__cloudCalls || 0) + 1;
            const cause = Object.assign(new Error('connect ECONNREFUSED 203.0.113.1:443'), { code: 'ECONNREFUSED' });
            return Promise.reject(new TypeError('fetch failed', { cause }));
          }
          return real(url, options);
        };
        return true;
      });
      assert.equal(stubbed, true);
      await home.page.evaluate(() => { state.settings.apiKeys = { ...state.settings.apiKeys, anthropic: 'not-a-real-key' }; });
      const id = await plainChat('claude-haiku-5-5');
      await send(id, 'Hello');
      await stopped(id);
      assert.equal(await home.app.evaluate(() => globalThis.__cloudCalls), 1, 'the stub took the call');
      const text = await lastReply(id);
      assert.match(text, /Anthropic API error/);
      assert.doesNotMatch(text, /Ollama/);
      await home.page.evaluate(() => { delete state.settings.apiKeys.anthropic; });
    });
  });
});
