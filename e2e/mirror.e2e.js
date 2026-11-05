// The mirror for real: two Electron instances, a fake Ollama that only says what a test tells
// it to, the real chat loop at home, and the real relay Worker in Miniflare. The laptop's own
// fake Ollama has no models at all, so nothing on that side can be working from its own copy.
//
//   node e2e/mirror.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  startPair, startFakeOllama, startScriptedOllama, launchDevice, waitFor, sleep, PIN, MODEL, TITLE,
  normalize, threadOf, threadsMatch, stopShowing, stopButtonsAre, secondsOn, timersAgree, newChat, openChat, submit, clickStop, remoteId, hasChat, watch, chatDataMatches, offlineMark, snapshotsSeen
} = require('./harness.js');
const { FIELDS } = require('../lib/chat-mirror.js');

const MARKER = 'MIRROR-MARKER-e4b1c7';
const PRIVATE = 'PRIVATE-CHAT-NEVER-SHARED-9a7d';
const KEY = 'sk-ant-KEY-CANARY-77aa';
const INSTRUCTIONS = 'GLOBAL-INSTRUCTIONS-CANARY-3fd1';

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
      remoteUi.lastInputAt = Date.now(); // a clock that is out is not someone being idle
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
    // Every control now asks the home PC. With nothing getting there, nothing may change here.
    await laptop.page.evaluate(() => {
      window.__realActionToHome = window.actionToHome;
      window.actionToHome = async () => ({ ok: true });
    });
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
    await laptop.page.evaluate(() => {
      window.actionToHome = window.__realActionToHome;
    });
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

  await t.test('markup in a frame stays text, and the window stays on the app', async () => {
    const evil = path.join(folder, 'evil.html');
    fs.writeFileSync(evil, '<!doctype html><title>EVIL</title><script>document.title = "EVIL RAN"</script>');
    const evilUrl = pathToFileURL(evil).href;
    const appUrl = laptop.page.url();
    assert.match(appUrl, /index\.html$/);
    const stillTheApp = async () => {
      assert.equal(laptop.page.url(), appUrl);
      assert.ok(!(await laptop.page.title()).includes('EVIL'));
    };

    const hostile = async (modality, chat) => {
      assert.equal(await home.remote('send', pair.laptopId, {
        type: 'mirror-snapshot', seq: 1000000, now: Date.now(), home: {}, chats: [{ id: chat, title: 'Sent over the wire', modality, updatedAt: Date.now(), messages: [] }]
      }), true);
      await waitFor('the frame to arrive', () => hasChat(laptop, remoteId(pair, chat)), 5000);
    };
    await hostile('<img id="fuzz-x" src="x" onerror="window.__fuzz=1"><style id="fuzz-x">*{display:none}</style><div id="fuzz-x" style="position:fixed;inset:0">FAKE</div>', 'markup');
    assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('[id="fuzz-x"]').length), 0);
    assert.equal(await laptop.page.evaluate(() => window.__fuzz), undefined);
    await hostile(`<meta http-equiv="refresh" content="0;url=${evilUrl}">`, 'refresh');
    await sleep(1500);
    await stillTheApp();
    assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('meta[http-equiv="refresh"]').length), 0);

    // Even if markup did get in some other way, the window can't go anywhere else.
    await laptop.page.evaluate((url) => {
      const meta = document.createElement('meta');
      meta.httpEquiv = 'refresh';
      meta.content = `0;url=${url}`;
      document.head.appendChild(meta);
    }, evilUrl);
    await sleep(1500);
    await stillTheApp();
    await laptop.page.evaluate((url) => {
      location.href = url;
    }, evilUrl);
    await sleep(800);
    await stillTheApp();
    // An iframe can't get there either.
    await laptop.page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.id = 'nav-test';
      frame.src = url;
      document.body.appendChild(frame);
    }, evilUrl);
    await sleep(800);
    assert.deepEqual(laptop.page.frames().map((f) => f.url()).filter((url) => url.includes('evil.html')), [], 'no frame shows it');
    await laptop.page.evaluate(() => document.getElementById('nav-test').remove());

    // A preview still works, on its own scheme.
    await laptop.page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.id = 'preview-test';
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
      document.body.appendChild(frame);
      await showPreview(frame, '<!doctype html><h1 id="ok">preview works</h1>');
    });
    const preview = await waitFor('the preview to load', () => laptop.page.frames().find((f) => f.url().startsWith('aio-preview:')), 5000);
    await waitFor('the preview to draw', () => preview.evaluate(() => document.querySelector('#ok')?.textContent === 'preview works'), 5000);
    await laptop.page.evaluate(() => document.getElementById('preview-test').remove());

    // A reload still works, and the real stream repairs everything the frames above did.
    await laptop.page.reload();
    await laptop.page.waitForLoadState('domcontentloaded');
    assert.equal(laptop.page.url(), appUrl);
    await started(laptop);
    await laptop.record();
    await waitFor('the real chat to come back', () => hasChat(laptop, remoteId(pair, chatId)), 5000);
    await openChat(laptop, remoteId(pair, chatId));
    await threadsMatch(pair, 'after the hostile frames', MARKER);
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

  await t.test('going offline stops the clocks and the dots, and leaves the content as it was', async () => {
    const dropThenCheck = async (selector) => {
      const running = await waitFor(`${selector} to be counting`, async () => {
        const text = await secondsOn(laptop, selector);
        return text ? text : false;
      }, 15000);
      assert.match(running, /^\d+s$/);
      assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
      await waitFor('the laptop to show offline', async () => (await offlineMark(laptop)) === '1', 10000);

      const frozen = await secondsOn(laptop, selector);
      const before = await threadOf(laptop);
      await sleep(2600);
      assert.equal(await secondsOn(laptop, selector), frozen, 'the timer has stopped');
      assert.equal(await threadOf(laptop), before, 'the content is exactly as it was');
      assert.deepEqual(
        await laptop.page.evaluate(() => [...document.querySelectorAll('#thread .msg-thinking-dots span, #thread .think-dots span')].map((e) => getComputedStyle(e).animationName).filter((n) => n !== 'none')),
        [],
        'no dots are moving'
      );

      // Drawing the message again, say by coming back to the chat, doesn't start it again.
      await laptop.page.evaluate(() => renderActiveChat());
      assert.equal(await secondsOn(laptop, selector), frozen, 'still stopped after a redraw');

      assert.deepEqual(await laptop.remote('setAddress', pair.relay.address), { ok: true });
      await waitFor('the laptop to reconnect', async () => (await offlineMark(laptop)) === null && (await laptop.entry()).connected === true, 30000);
      await waitFor('the timer to go again', async () => {
        const text = await secondsOn(laptop, selector);
        return text && text !== frozen;
      }, 8000);
      assert.notEqual(
        await laptop.page.evaluate(() => getComputedStyle(document.querySelector('#thread .msg-thinking-dots span')).animationName),
        'none',
        'and the dots'
      );
    };

    await submit(home, 'Counting while the laptop goes away');
    const reply = await ollama.next();
    await dropThenCheck('.msg-status-time');

    // The screen and a redraw have to agree on when the clock stopped, wherever in its second
    // the connection happens to go. The steps move the drop across a whole second.
    const trials = [];
    for (let i = 0; i < 10; i++) {
      await sleep(137 * i);
      assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
      await waitFor('the laptop to show offline', async () => (await offlineMark(laptop)) === '1', 10000);
      const [shown, redrawn] = await laptop.page.evaluate(() => {
        const read = () => document.querySelector('#thread .msg-status-time').textContent;
        const before = read();
        renderActiveChat();
        return [before, read()];
      });
      trials.push({ shown, redrawn });
      assert.deepEqual(await laptop.remote('setAddress', pair.relay.address), { ok: true });
      await waitFor('the laptop to reconnect', async () => (await offlineMark(laptop)) === null && (await laptop.entry()).connected === true, 30000);
    }
    t.diagnostic(`redraw while offline: ${trials.filter((x) => x.shown === x.redrawn).length} of ${trials.length} kept the same time`);
    assert.deepEqual(trials.filter((x) => x.shown !== x.redrawn), [], 'a redraw moved the timer');
    await threadsMatch(pair, 'back after the trials', 'msg-status-text');
    await threadsMatch(pair, 'back after the startup row', 'msg-status-text');
    reply.think('Thinking, and then saying nothing for a long time. ');
    await waitFor('the silence notice', () => home.page.evaluate(() => Boolean(document.querySelector('#thread .msg-silent'))), 12000);
    await threadsMatch(pair, 'the silence notice again', 'msg-silent');
    await dropThenCheck('.msg-silent-time');
    await threadsMatch(pair, 'back after the silence', 'msg-silent');
    reply.say('Done now.');
    reply.finish();
    await stopButtonsAre(pair, false, 'after the frozen reply');
    await threadsMatch(pair, 'the end of the frozen reply', 'Done now.');
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

// ---- A paired home can send anything ----

const PAYLOADS = (evilUrl) => [
  '<img id="fuzz-x" src="x" onerror="window.__fuzz=1">',
  '<style id="fuzz-x">*{display:none}</style>',
  '<div id="fuzz-x" class="modal-overlay" style="position:fixed;inset:0">FAKE PIN SCREEN</div>',
  `<meta id="fuzz-x" http-equiv="refresh" content="0;url=${evilUrl}">`,
  '<base id="fuzz-x" href="https://evil.example/">',
  '<form id="fuzz-x" action="https://evil.example/"><input name="pin"></form>',
  '<iframe id="fuzz-x" srcdoc="&lt;script&gt;parent.__fuzz=1&lt;/script&gt;"></iframe>',
  '"><svg id="fuzz-x" onload="window.__fuzz=1">',
  "' onmouseover='window.__fuzz=1' x='",
  'modal-overlay',
  'msg-body x" style="position:fixed',
  '__proto__',
  'constructor',
  'javascript:window.__fuzz=1',
  '[x](javascript:window.__fuzz=1) [y](https://a.example/"onclick="window.__fuzz=1) ![z](x)',
  '```<img id="fuzz-x">\n<img id="fuzz-x" src=x onerror="window.__fuzz=1">\n```',
  '`<img id="fuzz-x">` \\(<img id="fuzz-x">\\) $$<img id="fuzz-x">$$ \\[<b id="fuzz-x">\\]',
  '\u0000CB0\u0000 \u0000IC0\u0000',
  '1. <img id="fuzz-x">\n- <img id="fuzz-x">\n# <img id="fuzz-x">\n> <img id="fuzz-x">\n| <a id="fuzz-x"> | b |',
  '<think>x</think><img id="fuzz-x"><think>',
  // A lone surrogate crosses a frame intact, and encodeURIComponent throws on it.
  '```python\n\ud800\n``` \udfff `\ud800`'
];

const MARKDOWN = '# Head\n\n## Two\n\n**b** *i* `c` [l](https://a.example/x)\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n\n\\(x^2\\) $$y_1$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\n# file.py\nprint(1)\n```\n\n```html\n<b>x</b>\n```';

// Something of everything the thread can draw, so that each string field reaches its real
// sink. Which renderer a tool event gets depends on its name, and which card a video gets
// depends on its stage, hence the many of each.
function richChat() {
  const event = (name, status, extra = {}) => ({ name, status, argSummary: 'args', resultSummary: 'summary', input: 'in', output: 'out', exitCode: 1, ...extra });
  const video = (stage, extra = {}) => ({
    role: 'assistant', content: '', modality: 'chat',
    videoState: {
      stage, filename: 'v.mp4', dep: 'ffmpeg', log: 'log text', ok: true, durationSec: 4.5, framesDone: 1, expectedFrames: 9,
      hashDone: 1, totalFrames: 9, uniqueFrames: 9, captionDone: 1,
      deps: { ffmpeg: { found: true, version: '6.1' }, whisper: { found: false, version: '1.0' } },
      ...extra
    }
  });
  return {
    id: 'rich', title: 'Rich', model: 'some:model', modality: 'code', createdAt: 5, updatedAt: Date.now(),
    webEnabled: true, thinkingEnabled: true, planMode: true, approvalMode: false, noApproval: false, readOnly: false, noFetch: false,
    projectFolder: 'C:\\work\\folder', folderElsewhere: '/Users/someone/folder',
    messages: [
      { role: 'user', content: 'plain', modality: 'chat', attachments: [{ kind: 'image', name: 'a.png', pages: 2, ext: 'png' }, { kind: 'video', name: 'v.mp4', ext: 'mp4' }, { kind: 'pdf', name: 'a.pdf', pages: 3 }] },
      { role: 'user', content: 'waiting', queued: true, attachments: [] },
      { role: 'system', content: 'a system line' },
      { role: 'assistant', content: MARKDOWN, modality: 'chat', routedTo: 'other:model', tokenStats: { prompt: 1, completion: 2, _exactCompletion: 2, live: true } },
      { role: 'assistant', content: '', thinking: true, thinkingMode: true },
      { role: 'assistant', content: '', thinking: true, startup: { text: 'Loading', startedAt: 1000 } },
      { role: 'assistant', content: '', thinking: true },
      { role: 'assistant', content: 'quiet', silentSince: 1000 },
      {
        role: 'assistant', content: 'after the tools', toolEvents: [
          { name: '__think', status: 'running', startedAt: 1000, chars: 40, tokens: 10 },
          { name: '__think', status: 'done', startedAt: 1000, ms: 2000, chars: 40, tokens: 10 },
          event('web_search', 'running'), event('web_search', 'done'), event('web_search', 'error'),
          event('run_command', 'running'), event('run_command', 'done'), event('run_command', 'error'),
          event('run_command_async', 'done'), event('calc', 'running'), event('calc', 'done'), event('calc', 'error'),
          event('some_mcp_tool', 'done'),
          { ...event('read_file', 'done'), device: 'MacBook' },
          { ...event('run_command', 'done'), device: 'MacBook', shell: 'Bash' }
        ]
      },
      ...['starting', 'checking-deps', 'deps-missing', 'installing', 'install-done', 'probing', 'extracting', 'extracting-audio', 'dedup',
        'identifying', 'captioning', 'transcribing', 'synthesizing', 'aborted', 'done'].map((stage) => video(stage))
    ]
  };
}

const emptyAgentChat = () => ({ id: 'agent', title: 'Agent', model: 'some:model', modality: 'agent', updatedAt: Date.now(), projectFolder: 'C:\\work\\folder', messages: [] });

const homeDetails = () => ({
  name: 'Home', os: 'win32', shell: { name: 'Bash' }, installedModels: ['some:model'], cloudReady: { anthropic: true },
  hardware: { cpuModel: 'cpu', gpuName: 'gpu', vramGB: 1, totalRamGB: 2, fastBudgetGB: 1, maxBudgetGB: 2, budgetSource: 'vram' }
});

// Every path in a value, as [path, leaf].
function leaves(value, at = []) {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...at, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, [...at, k]));
  return [[at, value]];
}

function nodes(value, at = []) {
  const here = at.length ? [at] : [];
  if (Array.isArray(value)) return [...here, ...value.flatMap((v, i) => nodes(v, [...at, i]))];
  if (value && typeof value === 'object') return [...here, ...Object.entries(value).flatMap(([k, v]) => nodes(v, [...at, k]))];
  return here;
}

function withValue(root, at, value) {
  const copy = JSON.parse(JSON.stringify(root));
  let target = copy;
  for (const key of at.slice(0, -1)) target = target[key];
  target[at[at.length - 1]] = value;
  return copy;
}

test('a paired home can send anything: only the expected rendering comes of it', async (t) => {
  const ollama = await startFakeOllama();
  const device = await launchDevice('fuzz', { ollamaUrl: ollama.url });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-fuzz-'));
  t.after(async () => {
    await device.stop();
    await ollama.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  const { page } = device;
  await waitFor('boot', () => page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));
  const evil = path.join(folder, 'evil.html');
  fs.writeFileSync(evil, '<!doctype html><title>EVIL</title>');
  const appUrl = page.url();
  const payloads = PAYLOADS(pathToFileURL(evil).href);

  // A field added to the mirror has to be added here too, or this test stops covering it.
  const rich = richChat();
  const seen = (name, list) => new Set(list.flatMap((o) => Object.keys(o ?? {})));
  const check = (name, have) => {
    for (const key of Object.keys(FIELDS[name])) assert.ok(have.has(key), `the fuzz has no ${name}.${key}`);
  };
  check('chat', new Set(Object.keys(rich)));
  check('message', seen('', rich.messages));
  check('startup', seen('', rich.messages.map((m) => m.startup)));
  check('tokenStats', seen('', rich.messages.map((m) => m.tokenStats)));
  check('attachment', seen('', rich.messages.flatMap((m) => m.attachments ?? [])));
  check('toolEvent', seen('', rich.messages.flatMap((m) => m.toolEvents ?? [])));
  check('videoState', seen('', rich.messages.map((m) => m.videoState)));
  check('videoDep', seen('', rich.messages.flatMap((m) => Object.values(m.videoState?.deps ?? {}))));
  assert.deepEqual(new Set(FIELDS.message.role), new Set(rich.messages.map((m) => m.role)));

  // Sets up a home in the renderer and collects what benign chats draw, which is the
  // definition of expected: nothing else may ever appear.
  const baseline = await page.evaluate(([chats, details]) => {
    const HOME = 'fuzz-home';
    window.__fuzzWarnings = [];
    const warn = console.warn;
    console.warn = (...args) => { window.__fuzzWarnings.push(args.map(String).join(' ')); warn(...args); };
    window.addEventListener('error', (e) => window.__fuzzWarnings.push(String(e.message)));
    window.__fuzz = undefined;
    window.__seq = 0;
    window.__mirrorStatus = { devices: [{ id: HOME, role: 'home', connected: true }], enabled: true, locked: false, idleLocked: false };
    mirrorOnStatus(window.__mirrorStatus);
    window.__sendSnapshot = (list, home) => mirrorOnFrame(HOME, { type: 'mirror-snapshot', seq: ++window.__seq, now: Date.now(), home, chats: list });
    window.__sendOps = (chatId, ops) => mirrorOnFrame(HOME, { type: 'mirror-ops', seq: ++window.__seq, chatId, ops });
    window.__areas = () => ['#thread', '#chat-list'].flatMap((sel) => [...document.querySelector(sel).querySelectorAll('*')]);

    const tags = new Set();
    const classes = new Set();
    const attrs = new Set();
    const ids = new Set();
    const collect = () => {
      for (const el of window.__areas()) {
        tags.add(el.tagName);
        for (const token of el.classList) classes.add(token);
        for (const attr of el.attributes) attrs.add(attr.name);
        if (el.id) ids.add(el.id);
      }
    };
    const key = (id) => remoteChatKey(HOME, id);
    // Dropping a hostile value can leave any of these: every empty state the app has.
    const empties = [
      { id: 'empty-home', modality: 'chat', messages: [] },
      { id: 'empty-agent', modality: 'agent', messages: [] },
      { id: 'empty-no-modality', messages: [] }
    ];
    window.__sendSnapshot([...chats, ...empties], details);
    const view = (id, space) => {
      state.space = space;
      setActive(key(id));
      collect();
    };
    for (const c of chats) view(c.id, chatSpace(state.chats[key(c.id)]));
    view('empty-home', 'home');
    view('empty-home', 'code');
    view('empty-agent', 'code');
    view('empty-no-modality', 'home');
    window.__sendSnapshot(chats, details);
    setActive(key(chats[0].id));
    state.space = chatSpace(state.chats[key(chats[0].id)]);
    renderChatList();
    const headCount = document.head.childElementCount;
    const bodyCount = document.body.childElementCount;
    window.__violations = [];
    window.__check = (where) => {
      const bad = [];
      if (document.querySelector('[id="fuzz-x"]')) bad.push('an element with the payload id');
      for (const el of window.__areas()) if (el.id && !ids.has(el.id)) bad.push(`id ${el.id}`);
      if (window.__fuzz !== undefined) bad.push('script ran');
      if (document.head.childElementCount !== headCount) bad.push('head changed');
      if (document.body.childElementCount !== bodyCount) bad.push('body changed');
      for (const el of window.__areas()) {
        if (!tags.has(el.tagName)) bad.push(`tag ${el.tagName}`);
        for (const token of el.classList) if (!classes.has(token)) bad.push(`class ${token}`);
        for (const attr of el.attributes) {
          if (!attrs.has(attr.name) || attr.name.startsWith('on')) bad.push(`attribute ${attr.name}`);
          if (attr.name === 'style' && !/^width:\s*\d{1,3}%;?$/.test(attr.value)) bad.push(`style ${attr.value}`);
          if (attr.name === 'href' && !/^https?:\/\//.test(attr.value)) bad.push(`href ${attr.value}`);
        }
        if (getComputedStyle(el).position === 'fixed') bad.push(`fixed ${el.tagName}.${el.className}`);
      }
      if (window.__fuzzWarnings.length) bad.push(...window.__fuzzWarnings.splice(0));
      if (bad.length && window.__violations.length < 30) window.__violations.push({ where, bad: [...new Set(bad)].slice(0, 5) });
    };
    window.__check('the benign chats');
    return { tags: tags.size, classes: classes.size, violations: window.__violations };
  }, [[rich, emptyAgentChat()], homeDetails()]);
  assert.deepEqual(baseline.violations, []);
  assert.ok(baseline.tags > 12 && baseline.classes > 40, `the baseline drew ${baseline.tags} tags and ${baseline.classes} classes`);

  // One field at a time keeps the rest of the message as it is, so the field reaches its sink.
  const stringPaths = (root) => leaves(root).filter(([, v]) => typeof v === 'string').map(([at]) => at);
  const homeBase = homeDetails();
  const cases = [];
  for (const payload of payloads) {
    for (const at of stringPaths(rich)) cases.push({ chats: [withValue(rich, at, payload), emptyAgentChat()], home: homeBase, open: at[0] === 'id' ? null : 'rich', where: `rich.${at.join('.')}`, payload });
    const agent = emptyAgentChat();
    for (const at of stringPaths(agent)) cases.push({ chats: [rich, withValue(agent, at, payload)], home: homeBase, open: at[0] === 'id' ? null : 'agent', where: `agent.${at.join('.')}`, payload });
    for (const at of stringPaths(homeBase)) cases.push({ chats: [rich, agent], home: withValue(homeBase, at, payload), open: 'rich', where: `home.${at.join('.')}`, payload });
    // Everything at once, with the names as they'd be sent and every dispatch changed.
    const all = stringPaths(rich).reduce((c, at) => withValue(c, at, payload), rich);
    cases.push({ chats: [all], home: homeBase, open: all.id, where: 'every field at once', payload });
  }
  // Snapshots, each diffed against the last and painted, then redrawn from scratch.
  const run = (batch) => page.evaluate((list) => {
    for (const { chats, home, open, where, payload } of list) {
      const label = `${where} = ${JSON.stringify(payload).slice(0, 60)}`;
      window.__sendSnapshot(chats, home);
      const key = open && remoteChatKey('fuzz-home', open);
      if (key && state.chats[key]) {
        state.space = chatSpace(state.chats[key]);
        if (state.activeId !== key) setActive(key);
      }
      window.__check(`${label}, painted`);
      renderActiveChat();
      renderChatList();
      window.__check(`${label}, redrawn`);
    }
    return window.__violations;
  }, batch);
  let violations = [];
  for (let i = 0; i < cases.length && !violations.length; i += 40) violations = await run(cases.slice(i, i + 40));
  assert.deepEqual(violations, []);
  t.diagnostic(`${cases.length} hostile snapshots, ${payloads.length} payloads`);

  // The same through ops, which is the path a frame takes once a chat is there.
  const opsResult = await page.evaluate(([messages, chat, list]) => {
    window.__sendSnapshot([chat], {});
    const key = remoteChatKey('fuzz-home', chat.id);
    state.space = chatSpace(state.chats[key]);
    setActive(key);
    const count = state.chats[key].messages.length;
    const set = (root, at, value) => {
      const copy = JSON.parse(JSON.stringify(root));
      let target = copy;
      for (const k of at.slice(0, -1)) target = target[k];
      target[at[at.length - 1]] = value;
      return copy;
    };
    const paths = (value, at = []) => (Array.isArray(value) ? value.flatMap((v, i) => paths(v, [...at, i]))
      : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => paths(v, [...at, k]))
        : typeof value === 'string' ? [at] : []);
    let total = 0;
    for (const payload of list) {
      for (const message of messages) {
        for (const at of paths(message)) {
          total += 1;
          const hostile = set(message, at, payload);
          window.__sendOps(chat.id, [{ type: 'msg-add', index: count, message: hostile }]);
          window.__check(`msg-add ${at.join('.')}`);
          window.__sendOps(chat.id, [{ type: 'msg-update', index: count, set: hostile, events: { from: 0, items: hostile.toolEvents ?? [] } }]);
          window.__check(`msg-update ${at.join('.')}`);
          window.__sendOps(chat.id, [{ type: 'msg-remove', index: count }]);
        }
      }
      for (const field of ['title', 'model', 'modality', 'projectFolder', 'folderElsewhere']) {
        window.__sendOps(chat.id, [{ type: 'meta', set: { [field]: payload } }]);
        window.__check(`meta ${field}`);
      }
      window.__sendOps(chat.id, [{ type: 'meta', set: { title: 'Rich', model: 'some:model', modality: 'code', projectFolder: 'x' } }]);
      window.__sendOps(chat.id, [{ type: 'msg-append', index: 0, baseLength: state.chats[key].messages[0].content.length, text: payload }]);
      window.__check('msg-append');
      window.__sendOps(chat.id, [{ type: 'msg-update', index: 0, set: { content: 'plain' } }]);
    }
    return { total, violations: window.__violations };
  }, [rich.messages.filter((m) => !m.videoState || m.videoState.stage === 'deps-missing' || m.videoState.stage === 'installing'), { ...rich, messages: rich.messages.slice(0, 3) }, payloads]);
  assert.deepEqual(opsResult.violations, []);
  t.diagnostic(`${opsResult.total} hostile ops`);

  // Wrong shapes: nothing throws, nothing is drawn wrongly, and the good chat next to the bad
  // one still arrives.
  const junk = [null, 5, -1, 1e308, true, [], {}, [[]], { a: 1 }, '', 'x'.repeat(5000)];
  const shapes = [];
  for (const at of nodes(rich)) for (const value of junk) shapes.push({ at, value });
  const shapeResult = await page.evaluate(async ([chat, list, details]) => {
    const set = (root, at, value) => {
      const copy = JSON.parse(JSON.stringify(root));
      let target = copy;
      for (const k of at.slice(0, -1)) target = target[k];
      target[at[at.length - 1]] = value;
      return copy;
    };
    const good = { id: 'good', title: 'Good', modality: 'chat', updatedAt: 1, messages: [{ role: 'user', content: 'still here' }] };
    let missed = 0;
    let index = 0;
    for (const { at, value } of list) {
      window.__sendSnapshot([set(chat, at, value), good], details);
      const key = remoteChatKey('fuzz-home', chat.id);
      if (state.chats[key] && state.activeId !== key) setActive(key);
      if (!state.chats[remoteChatKey('fuzz-home', 'good')]) missed += 1;
      window.__check(`shape ${at.join('.')} = ${JSON.stringify(value).slice(0, 30)}`);
      index += 1;
      if (index % 200 === 0) await new Promise((r) => setTimeout(r));
    }
    return { missed, violations: window.__violations };
  }, [rich, shapes, homeBase]);
  assert.deepEqual(shapeResult.violations, []);
  assert.equal(shapeResult.missed, 0);
  t.diagnostic(`${shapes.length} malformed snapshots`);

  // The frame itself, and the bad card the review found.
  const frameResult = await page.evaluate(([chat]) => {
    const before = window.__seq;
    const key = remoteChatKey('fuzz-home', chat.id);
    const expected = mirror.homes.get('fuzz-home').expected;
    for (const seq of [undefined, null, 'x', 1.5, -1, 0, NaN, Infinity, {}, [], 1e300]) {
      mirrorOnFrame('fuzz-home', { type: 'mirror-snapshot', seq, now: 0, home: {}, chats: [] });
      mirrorOnFrame('fuzz-home', { type: 'mirror-ops', seq, chatId: chat.id, ops: [] });
    }
    const untouched = mirror.homes.get('fuzz-home').expected === expected && Boolean(state.chats[key]);
    for (const home of [null, 5, 'x', [], { shell: 5 }, { shell: { name: {} } }]) window.__sendSnapshot([chat], home);
    window.__check('frames with a bad home');
    const info = mirror.homes.get('fuzz-home').info;
    window.__sendSnapshot([{ id: 'nodeps', modality: 'chat', messages: [{ role: 'assistant', content: '', videoState: { stage: 'deps-missing' } }] }, chat], {});
    const noDepsThere = Boolean(state.chats[key]) && Boolean(state.chats[remoteChatKey('fuzz-home', 'nodeps')]);
    setActive(remoteChatKey('fuzz-home', 'nodeps'));
    window.__check('deps-missing with no deps');
    return { before, untouched, infoIsClean: typeof info?.shell?.name === 'string', noDepsThere, violations: window.__violations };
  }, [rich]);
  assert.deepEqual(frameResult.violations, []);
  assert.equal(frameResult.untouched, true, 'a frame with a bad seq changes nothing');
  assert.equal(frameResult.infoIsClean, true);
  assert.equal(frameResult.noDepsThere, true);

  await sleep(1500);
  assert.equal(page.url(), appUrl, 'the window never left');
  assert.ok(!(await page.title()).includes('EVIL'));
  assert.equal(await page.evaluate(() => window.__fuzz), undefined);
});
