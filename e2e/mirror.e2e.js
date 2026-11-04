// The mirror for real: two Electron instances, a fake Ollama that only says what a test tells
// it to, the real chat loop at home, and the real relay Worker in Miniflare. The laptop's own
// fake Ollama has no models at all, so nothing on that side can be working from its own copy.
//
//   node e2e/mirror.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startPair, launchDevice, waitFor, sleep, PIN } = require('./harness.js');

const MODEL = 'fake:latest';
const TITLE = 'Mirrored Title Here';
const MARKER = 'MIRROR-MARKER-e4b1c7';
const PRIVATE = 'PRIVATE-CHAT-NEVER-SHARED-9a7d';
const KEY = 'sk-ant-KEY-CANARY-77aa';
const INSTRUCTIONS = 'GLOBAL-INSTRUCTIONS-CANARY-3fd1';

// A chat request stays open until the test finishes it, so what's on screen can be looked at
// between any two chunks. A title request is answered at once, because nothing waits on it.
async function startScriptedOllama() {
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
      if (req.url === '/api/tags') return json(res, { models: [{ name: MODEL, model: MODEL, size: 1000000000 }] });
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

function everyFileUnder(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(full);
    }
  };
  walk(dir);
  return found;
}

// Chromium keeps localStorage strings as either of these.
function filesContaining(files, text) {
  const forms = [Buffer.from(text, 'utf8'), Buffer.from(text, 'utf16le')];
  return files.filter((file) => {
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return false;
    }
    return forms.some((form) => bytes.includes(form));
  });
}

test('mirroring chats', async (t) => {
  const ollama = await startScriptedOllama();
  const pair = await startPair({ homeOllama: ollama });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-folder-'));
  t.after(async () => {
    await pair.stop();
    await ollama.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const { laptop, homeId } = pair;
  let { home } = pair;

  // Boot isn't finished until the first chat exists, which happens just before the wiring.
  const started = (device) =>
    waitFor(`${device.name} to finish starting`, () => device.page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));
  await started(home);
  await started(laptop);
  await waitFor('the model to show as installed', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
  await home.page.evaluate((m) => ensureModelInfo(m), MODEL);

  // A chat nobody shares, and secrets, all there from the start of everything that follows.
  await home.page.evaluate(([key, instructions]) => {
    state.settings.apiKeys = { anthropic: key };
    state.settings.instructions = instructions;
    saveSettings();
  }, [KEY, INSTRUCTIONS]);
  const privateId = await newChat(home, { modality: 'chat', title: PRIVATE, webEnabled: false });
  await home.page.evaluate(([id, text]) => {
    state.chats[id].messages.push({ role: 'user', content: text, attachments: [] });
    saveToStorage();
  }, [privateId, PRIVATE]);

  await t.test('the laptop learns about its home PC, and nothing secret comes with it', async () => {
    const seen = await waitFor('a snapshot that knows the key is set', async () =>
      (await laptop.mirrorFrames()).filter((f) => f.type === 'mirror-snapshot' && f.home.cloudReady?.anthropic).at(-1), 5000);
    assert.deepEqual(Object.keys(seen.home).sort(), ['cloudReady', 'hardware', 'installedModels', 'name', 'os', 'shell']);
    assert.ok(seen.home.name.length > 0);
    assert.equal(seen.home.os, process.platform);
    assert.ok(seen.home.shell.name);
    assert.equal(seen.home.shell.path, undefined, 'where the shell lives is not the name of the shell');
    assert.ok(seen.home.installedModels.includes(MODEL));
    assert.equal(seen.home.cloudReady.anthropic, true);
    assert.ok(!JSON.stringify(seen).includes(KEY));
    // The laptop's own idea of what's installed is untouched.
    assert.equal(await laptop.page.evaluate((m) => state.installed.has(m), MODEL), false);
  });

  let chatId;
  await t.test('exact mirror: streaming, thinking, tool cards, a queue, and Stop', async () => {
    chatId = await newChat(home, {
      modality: 'agent', title: '', remoteControl: true, noApproval: true, planMode: false, approvalMode: false,
      thinkingEnabled: true, webEnabled: false, projectFolder: folder, pathAllowlist: [folder], maxSteps: 5
    });
    const rid = await watch(pair, chatId);
    await threadsMatch(pair, 'an empty chat', 'Ready to work');

    // This laptop's clock is an hour out and its shell is something else. Neither may show.
    await laptop.page.evaluate(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + 3600000;
      state.shellInfo = { name: 'LaptopShell' };
    });
    const before = await snapshotsSeen(laptop);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('a fresh snapshot', async () => (await snapshotsSeen(laptop)) > before, 5000);

    await submit(home, `Say something ${MARKER}`);
    await threadsMatch(pair, 'the user message and the startup row', MARKER, 'msg-status-text');
    await stopButtonsAre(pair, true, 'running');
    assert.equal(await home.page.evaluate((id) => Number.isFinite(state.chats[id].messages.at(-1).startup?.startedAt), chatId), true);
    await sleep(3500);
    await timersAgree(pair, '.msg-status-time');

    // The first chunk ends the startup row even with nothing in it, on both screens.
    const first = await ollama.next();
    first.say('');
    await waitFor('the chunk to arrive', () => home.page.evaluate((id) => !state.chats[id].messages.at(-1).startup, chatId), 5000);
    const afterStartup = await threadsMatch(pair, 'an empty first chunk', 'msg-thinking');
    assert.ok(!afterStartup.includes('msg-status-text'), 'the startup row has gone');

    first.think('Let me think about this for a while. ');
    await threadsMatch(pair, 'the thinking row', 'think-row running', 'think-tokens');

    // More reasoning updates the count where it is, or the dots would never get to animate.
    await laptop.page.evaluate(() => {
      document.querySelector('#thread .think-row.running').__sameRow = true;
    });
    first.think('And then a little while longer than that, thinking it through carefully. ');
    await threadsMatch(pair, 'the thinking count', '28 tokens');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#thread .think-row.running').__sameRow), true);

    // Nothing arrives for long enough that the app says so.
    await waitFor('the silence notice at home', () => home.page.evaluate(() => Boolean(document.querySelector('#thread .msg-silent'))), 12000);
    await threadsMatch(pair, 'the silence notice', 'msg-silent', 'Thought for');
    await sleep(1200);
    await timersAgree(pair, '.msg-silent-time');

    first.call(['run_command', { command: 'echo mirror-tool-output' }], ['calc', { expr: '2+2' }]);
    first.finish();
    await threadsMatch(pair, 'the tool cards', 'te-shell', 'mirror-tool-output', 'te-row');

    const second = await ollama.next();
    second.say('## Part one\n\nSome **bold** words, then a block:\n\n```python\nprint("hi")\n```\n\nAnd');
    await threadsMatch(pair, 'streaming markdown', 'Part one', 'code-block');
    second.say(' more text after it.');
    await threadsMatch(pair, 'more streaming', 'more text after it');
    await laptop.page.evaluate(() => {
      window.__mirrorFramesAtQueue = window.__mirrorFrames.length;
    });
    second.say(` Then ${'a long run of words '.repeat(20)}.`);
    await threadsMatch(pair, 'a long run', 'a long run of words');
    const streamed = await laptop.page.evaluate(() =>
      window.__mirrorFrames.slice(window.__mirrorFramesAtQueue).flatMap((f) => (f.type === 'mirror-ops' ? f.ops : [])));
    assert.ok(streamed.some((op) => op.type === 'msg-append'), 'text arrives as appends');
    assert.ok(!streamed.some((op) => op.type === 'msg-update' && op.set && 'content' in op.set), 'and never as rewrites');

    await submit(home, 'A queued follow-up');
    await threadsMatch(pair, 'the queued message', 'msg-queued-badge', 'A queued follow-up');
    second.say(' And text keeps coming with a queue behind it.');
    await threadsMatch(pair, 'streaming ahead of the queue', 'queue behind it', 'msg-queued-badge');

    second.finish();
    const third = await ollama.next();
    await threadsMatch(pair, 'the queue moving up', 'A queued follow-up');
    assert.ok(!normalize(await threadOf(home)).includes('msg-queued-badge'));
    third.say('Answering the follow-up, and');
    await threadsMatch(pair, 'the next turn', 'Answering the follow-up');

    // The title the model wrote, on the header and in the list.
    await waitFor('the written title', async () => {
      const title = (device) => device.page.evaluate(() => document.querySelector('#chat-title').value);
      return (await title(home)) === TITLE && (await title(laptop)) === TITLE;
    }, 5000);
    assert.ok((await laptop.page.evaluate(() => [...document.querySelectorAll('#chat-list .chat-title')].map((e) => e.textContent))).includes(TITLE));

    await stopButtonsAre(pair, true, 'the next turn');
    await clickStop(home);
    await waitFor('the stream to be aborted', () => third.closed, 5000);
    await stopButtonsAre(pair, false, 'after Stop');
    await threadsMatch(pair, 'stopped partway', 'Answering the follow-up');

    // Stop before anything has arrived, with one queued behind it.
    await submit(home, 'Another turn');
    await threadsMatch(pair, 'another turn', 'Another turn');
    const fourth = await ollama.next();
    await submit(home, 'Queued, and then stopped');
    await threadsMatch(pair, 'queued again', 'Queued, and then stopped');
    await clickStop(home);
    const stopped = await threadsMatch(pair, 'stopped with nothing said', 'Stopped.');
    assert.ok(!stopped.includes('msg-queued-badge'));
    // The app can't abort a stream until its first chunk says which one it is.
    fourth.finish();
    await stopButtonsAre(pair, false, 'after the second Stop');
    await threadsMatch(pair, 'stopped and settled', 'Stopped.');

    // A tool call with no thinking before it ends the dots as soon as it arrives.
    await submit(home, 'A tool straight away');
    await threadsMatch(pair, 'waiting on a tool call', 'A tool straight away', 'msg-thinking');
    const fifth = await ollama.next();
    fifth.call(['calc', { expr: '3+3' }]);
    await waitFor('the dots to go at home', () => home.page.evaluate(() => !document.querySelector('#thread .msg-thinking')), 5000);
    await threadsMatch(pair, 'a tool call on its way', 'A tool straight away');
    fifth.finish();
    await threadsMatch(pair, 'the tool that came straight away', 'te-row');
    const sixth = await ollama.next();
    sixth.say('Six.');
    sixth.finish();
    await stopButtonsAre(pair, false, 'after the tool turn');
    await threadsMatch(pair, 'the end of the tool turn', 'Six.');

    await chatDataMatches(pair, chatId);
    assert.deepEqual(await laptop.page.evaluate((id) => state.chats[id].remote, rid), { deviceId: homeId, chatId });
  });

  await t.test('a remote chat is only ever changed by its home PC', async () => {
    const rid = remoteId(pair, chatId);
    const read = () => laptop.page.evaluate((id) => JSON.stringify(ChatMirror.snapshotChat(state.chats[id])), rid);
    const before = await read();
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').disabled), true, 'the message box waits for Task 10');
    // Everything on screen that would change a local chat, and the repairs a render makes.
    await laptop.page.evaluate(() => {
      for (const id of ['toggle-web', 'toggle-think', 'toggle-plan', 'toggle-approval', 'toggle-noapproval', 'toggle-readonly', 'toggle-nofetch']) {
        document.getElementById(id)?.click();
      }
      const input = document.querySelector('#composer-input');
      input.value = 'typed on the laptop';
      document.querySelector('#composer-form').requestSubmit();
      input.value = '';
      renderActiveChat();
      switchSpace(state.space);
    });
    await laptop.page.evaluate((id) => deleteChat(id), rid);
    assert.equal(await read(), before);
    assert.equal(await laptop.page.evaluate((id) => state.activeId === id && !state.runningChats.has(id), rid), true);

    // A model picked for a local chat doesn't spread to an empty remote one, and new local
    // chats don't start on the home PC's model.
    const empty = await newChat(home, { modality: 'chat', title: 'Nothing yet', remoteControl: true, webEnabled: false });
    const emptyRid = await watch(pair, empty);
    await threadsMatch(pair, 'an empty home chat', 'What would you like to do');
    await laptop.page.evaluate(() => createChat());
    assert.notEqual(await laptop.page.evaluate(() => currentChat().model), MODEL);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#composer-input').disabled), false, 'a local chat can still be typed in');
    await laptop.page.evaluate(() => {
      const menu = document.querySelector('#cs-menu');
      const item = document.createElement('div');
      item.className = 'cs-item';
      item.dataset.value = 'other:2b';
      menu.appendChild(item);
      item.click();
      item.remove();
    });
    assert.equal(await laptop.page.evaluate(() => currentChat().model), 'other:2b', 'the pick did reach the local chat');
    assert.equal(await laptop.page.evaluate((id) => state.chats[id].model, emptyRid), MODEL);
    await home.page.evaluate((id) => deleteChat(id), empty);
    await waitFor('the deleted chat to go', async () => !(await hasChat(laptop, emptyRid)), 3000);
    await openChat(laptop, rid);
    await openChat(home, chatId);
  });

  await t.test('a chat without Remote Control never appears, and no frame has its title', async () => {
    assert.equal(await hasChat(laptop, remoteId(pair, privateId)), false);
    const frames = JSON.stringify([...(await laptop.mirrorFrames()), ...(await laptop.frames())]);
    assert.ok(frames.includes(MARKER), 'the search can find what was shared');
    assert.ok(!frames.includes(PRIVATE));
    assert.ok(!frames.includes(privateId));
    assert.ok(!frames.includes(KEY));
    assert.ok(!frames.includes(INSTRUCTIONS));
    const seen = await laptop.page.evaluate(() => JSON.stringify(state.chats) + document.body.innerHTML);
    assert.ok(!seen.includes(PRIVATE));
  });

  await t.test('a laptop cannot put a chat on its home PC', async () => {
    assert.equal(await laptop.remote('send', homeId, {
      type: 'mirror-snapshot', seq: 1, now: 0, home: {}, chats: [{ id: 'injected', title: 'Injected', messages: [] }]
    }), true);
    await sleep(300);
    assert.deepEqual(await home.page.evaluate(() => Object.keys(state.chats).filter((id) => id.includes('injected') || id.startsWith('remote:'))), []);
  });

  await t.test('anything out of step is repaired by a new snapshot', async () => {
    const rid = remoteId(pair, chatId);
    const snapshots = () => snapshotsSeen(laptop);
    const inject = (frame) => laptop.page.evaluate(([id, f]) => {
      const home = mirror.homes.get(id);
      mirrorOnFrame(id, { ...f, seq: f.seq ?? home.expected });
    }, [homeId, frame]);

    // A number missing from the sequence.
    let before = await snapshots();
    await inject({ type: 'mirror-run', chatId, running: true, seq: 999999 });
    await waitFor('a snapshot after a gap', async () => (await snapshots()) > before, 3000);
    await threadsMatch(pair, 'after a gap', MARKER);

    // Text that doesn't line up with what's here. The local copy has been changed first, and
    // only the snapshot can put that right.
    await laptop.page.evaluate((id) => {
      state.chats[id].messages[0].content = 'changed only here';
      renderActiveChat();
    }, rid);
    before = await snapshots();
    await inject({ type: 'mirror-ops', chatId, ops: [{ type: 'msg-append', index: 0, baseLength: 5, text: 'x' }] });
    await waitFor('a snapshot after ops that do not fit', async () => (await snapshots()) > before, 3000);
    await threadsMatch(pair, 'after ops that do not fit', MARKER);
    await chatDataMatches(pair, chatId);

    // The window reloading loses everything, and the connection doesn't notice, so it has to
    // ask for itself. Cleaning up after this test relies on nothing that reload changes.
    await laptop.page.reload();
    await laptop.page.waitForLoadState('domcontentloaded');
    await started(laptop);
    await laptop.record();
    await waitFor('the chat to come back after a reload', () => hasChat(laptop, rid), 5000);
    await openChat(laptop, rid);
    await threadsMatch(pair, 'after a reload', MARKER);
    await chatDataMatches(pair, chatId);
  });

  await t.test('turning sharing off removes the chat within a second, and on brings it back', async () => {
    const rid = remoteId(pair, chatId);
    const startedAt = Date.now();
    await home.page.evaluate((id) => {
      state.chats[id].remoteControl = false;
      saveToStorage();
    }, chatId);
    await waitFor('the chat to leave the laptop', async () => !(await hasChat(laptop, rid)), 1000);
    t.diagnostic(`gone from the laptop after ${Date.now() - startedAt} ms`);
    const [active, html] = await laptop.page.evaluate(() => [state.activeId, document.querySelector('#thread').innerHTML]);
    assert.notEqual(active, rid);
    assert.ok(!html.includes(MARKER), 'not left on the screen either');

    await home.page.evaluate((id) => {
      state.chats[id].remoteControl = true;
      saveToStorage();
    }, chatId);
    await watch(pair, chatId);
    await threadsMatch(pair, 'shared again', MARKER);
    await chatDataMatches(pair, chatId);
  });

  await t.test('the path changing under a reply loses nothing, and needs no snapshot', async () => {
    await Promise.all([home.waitForPath('direct'), laptop.waitForPath('direct')]);
    await submit(home, 'Moving between paths');
    const reply = await ollama.next();
    reply.say('On direct.');
    await threadsMatch(pair, 'on direct', 'On direct.');
    const before = await snapshotsSeen(laptop);
    await (await laptop.transport()).evaluate(() => {
      for (const peer of peers.values()) if (peer.channel?.readyState === 'open') peer.channel.close();
    });
    reply.say(' Moved along.');
    await Promise.all([home.waitForPath('relay', 5000), laptop.waitForPath('relay', 5000)]);
    reply.say(' On the relay now.');
    await threadsMatch(pair, 'on the relay', 'Moved along. On the relay now.');
    assert.equal(await snapshotsSeen(laptop), before);
    assert.equal((await laptop.entry()).connected, true);
    reply.finish();
    await stopButtonsAre(pair, false, 'after the path change');
    await threadsMatch(pair, 'finished', 'On the relay now.');
  });

  await t.test('review focus 1: the laptop dropping out mid-reply ends with matching threads', async () => {
    await submit(home, 'Keep going while the laptop is away');
    const reply = await ollama.next();
    reply.say('Before the drop.');
    await threadsMatch(pair, 'before the drop', 'Before the drop.');
    await stopButtonsAre(pair, true, 'before the drop');

    // Moving to a relay that isn't there ends every connection this device has.
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('the laptop to go offline', async () => (await laptop.entry()).connected === false, 10000);
    await waitFor('the laptop to show it', async () => (await offlineMark(laptop)) === '1', 2000);
    assert.equal(await stopShowing(laptop), false, 'Stop clears with the connection');
    assert.equal(await laptop.page.evaluate(() => state.runningChats.size), 0);
    assert.ok((await threadOf(laptop)).includes('Before the drop.'), 'the chat stays visible');

    reply.say(' During the drop.');
    await waitFor('home to have it', async () => (await threadOf(home)).includes('During the drop.'), 5000);
    assert.ok(!(await threadOf(laptop)).includes('During the drop.'));

    assert.deepEqual(await laptop.remote('setAddress', pair.relay.address), { ok: true });
    await waitFor('the laptop to reconnect', async () => (await laptop.entry()).connected === true, 30000);
    await threadsMatch(pair, 'after reconnecting', 'During the drop.');
    assert.equal(await offlineMark(laptop), null);
    await stopButtonsAre(pair, true, 'still running after reconnecting');

    reply.say(' After the drop.');
    await threadsMatch(pair, 'streaming on after reconnecting', 'After the drop.');
    reply.finish();
    await stopButtonsAre(pair, false, 'after the reply');
    await threadsMatch(pair, 'the end of the reply', 'After the drop.');
    await chatDataMatches(pair, chatId);
  });

  await t.test('review focus 2: the home PC restarting mid-reply', async () => {
    await submit(home, 'Restart while I am answering');
    const reply = await ollama.next();
    reply.think('Thinking before the restart. ');
    reply.say('Partway through when it went.');
    await threadsMatch(pair, 'before the restart', 'Partway through when it went.');
    await stopButtonsAre(pair, true, 'before the restart');
    const rid = remoteId(pair, chatId);
    await laptop.page.evaluate((id) => {
      window.__lastMessage = state.chats[id].messages.at(-1);
    }, rid);

    await home.quit();
    await waitFor('the laptop to see it offline', async () => (await laptop.entry()).connected === false, 60000);
    await waitFor('the laptop to show it', async () => (await offlineMark(laptop)) === '1', 2000);
    assert.equal(await stopShowing(laptop), false);
    assert.equal(await laptop.page.evaluate(() => state.runningChats.size), 0);
    assert.ok((await threadOf(laptop)).includes('Partway through when it went.'), 'the chat stays visible');

    home = await launchDevice('home', { ollamaUrl: ollama.url, profile: home.profile });
    pair.home = home; // the harness stops whatever is here
    await started(home);
    await openChat(home, chatId);
    await waitFor('the laptop to reconnect', async () => (await laptop.entry()).connected === true, 60000);
    await threadsMatch(pair, 'after the restart', 'Partway through when it went.');
    await stopButtonsAre(pair, false, 'after the restart');
    assert.equal(await offlineMark(laptop), null);
    await chatDataMatches(pair, chatId);
    assert.equal(
      await laptop.page.evaluate((id) => state.chats[id].messages.at(-1) === window.__lastMessage, rid),
      true,
      'the message on screen is the same object, updated in place'
    );

    await waitFor('the model at home', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
    await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
    await submit(home, 'And it all still works');
    const after = await ollama.next();
    after.say('Yes, it still works.');
    await threadsMatch(pair, 'a reply after the restart', 'Yes, it still works.');
    after.finish();
    await stopButtonsAre(pair, false, 'after that reply');
    await threadsMatch(pair, 'finished after the restart', 'Yes, it still works.');
    await chatDataMatches(pair, chatId);
  });

  await t.test('a locked laptop hides remote chats, keeps them current, and shows them again on unlock', async () => {
    const rid = remoteId(pair, chatId);
    await openChat(laptop, rid);
    await laptop.remote('lock');
    await waitFor('idle lock', async () => (await laptop.remote('status')).idleLocked === true, 3000);
    await waitFor('the chat to be off the screen', () => laptop.page.evaluate((marker) => !document.body.innerHTML.includes(marker), MARKER), 3000);
    assert.equal(await laptop.page.evaluate((id) => state.activeId !== id, rid), true);
    assert.equal(await laptop.page.evaluate((id) => chatsInCurrentSpace().some((c) => c.id === id), rid), false);

    // The connection stays up, and frames go on being applied.
    assert.equal((await laptop.entry()).connected, true);
    await submit(home, 'Said while the laptop was locked');
    const reply = await ollama.next();
    reply.say('Answered while locked.');
    await waitFor('the locked laptop to stay current', () =>
      laptop.page.evaluate((id) => state.chats[id].messages.at(-1).content === 'Answered while locked.', rid), 5000);
    assert.equal(await laptop.page.evaluate((text) => document.body.innerHTML.includes(text), 'Answered while locked.'), false);
    reply.finish();

    assert.deepEqual(await laptop.remote('unlock', PIN), { ok: true });
    await waitFor('the chat to be back', () => laptop.page.evaluate((id) => state.activeId === id, rid), 3000);
    await stopButtonsAre(pair, false, 'after the locked reply');
    await threadsMatch(pair, 'after unlocking', 'Answered while locked.');
  });

  await t.test('a long chat mirrors, and streaming into it stays cheap', async () => {
    const longId = await newChat(home, { modality: 'chat', title: 'Long', webEnabled: false });
    await home.page.evaluate((id) => {
      const c = state.chats[id];
      for (let i = 0; i < 1000; i++) {
        c.messages.push({ role: 'user', content: `Question number ${i} about something.`, modality: 'chat', attachments: [] });
        c.messages.push({
          role: 'assistant',
          modality: 'chat',
          content: `Answer number ${i}. ${'Some reasonable length of reply text. '.repeat(20)}`,
          toolEvents: [{ name: '__think', status: 'done', startedAt: 5, ms: 1000, chars: 40, tokens: 10 }],
          tokenStats: { prompt: 10, completion: 20, _exactCompletion: 20, live: false }
        });
      }
      c.remoteControl = true;
      saveToStorage();
      renderActiveChat();
    }, longId);
    await watch(pair, longId);
    await threadsMatch(pair, 'the 2,000 messages', 'Answer number 999');

    const cost = await home.page.evaluate(async (id) => {
      const c = state.chats[id];
      const last = c.messages.at(-1);
      let previous = ChatMirror.snapshotChat(c);
      const times = [];
      for (let i = 0; i < 200; i++) {
        last.content += ' another few tokens';
        const start = performance.now();
        const next = ChatMirror.snapshotChat(c);
        ChatMirror.diffChat(previous, next);
        times.push(performance.now() - start);
        previous = next;
        if (i % 20 === 0) await new Promise((r) => setTimeout(r));
      }
      times.sort((a, b) => a - b);
      return { median: times[100], p95: times[190], max: times[199] };
    }, longId);
    t.diagnostic(`snapshot + diff of 2,000 messages: median ${cost.median.toFixed(2)} ms, p95 ${cost.p95.toFixed(2)} ms, max ${cost.max.toFixed(2)} ms`);
    // A tick comes every 100 ms, so this is a few percent of one thread at the very worst.
    assert.ok(cost.p95 < 5, `p95 ${cost.p95} ms`);

    // And it really does stay matched while something streams into it.
    await submit(home, 'One more');
    const reply = await ollama.next();
    reply.say('Streaming into a long chat.');
    await threadsMatch(pair, 'streaming into the long chat', 'Streaming into a long chat.');
    reply.finish();
    await stopButtonsAre(pair, false, 'the long chat');
    await home.page.evaluate((id) => deleteChat(id), longId);
    await waitFor('the long chat to go', async () => !(await hasChat(laptop, remoteId(pair, longId))), 5000);
  });

  await t.test("nothing from a remote chat reaches the laptop's disk", async () => {
    const rid = remoteId(pair, chatId);
    await openChat(laptop, rid);
    // Something that does belong on this disk, so the search is known to work.
    const control = 'LOCAL-CONTROL-STRING-55c1';
    await laptop.page.evaluate(([id, text]) => {
      createChat('other:1b', 'chat', { title: text });
      setActive(id);
      saveToStorage();
    }, [rid, control]);
    assert.equal(await laptop.page.evaluate(() => state.activeId), rid);

    const storage = await laptop.page.evaluate(() => JSON.stringify({ ...localStorage }));
    assert.ok(storage.includes(control));
    assert.ok(!storage.includes(MARKER));
    assert.ok(!storage.includes('remote:'));
    assert.ok(!storage.includes(chatId));

    await laptop.quit();
    const files = everyFileUnder(laptop.profile);
    assert.notDeepEqual(filesContaining(files, control), [], 'the search finds what is on disk');
    assert.deepEqual(filesContaining(files, MARKER), []);
    assert.deepEqual(filesContaining(files, TITLE), []);
  });
});
