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
});
