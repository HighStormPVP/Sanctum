// A laptop acting on a home PC for real: three Electron instances, a fake Ollama that only says
// what a test tells it to, the real chat loop at home, and the real relay Worker in Miniflare.
// The laptops' own fake Ollama has no models at all.
//
//   node e2e/actions.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  startPair, startScriptedOllama, launchDevice, pair, waitFor, sleep, PIN, MODEL, TITLE,
  threadOf, threadsMatch, stopButtonsAre, chatDataMatches, newChat, openChat, submit, clickStop, hasChat, offlineMark
} = require('./harness.js');
const { VIDEO_REFUSED, TOO_LARGE } = require('../lib/remote-rules.js');

const SECOND_MODEL = 'second:latest';
const KEY = 'sk-ant-KEY-CANARY-c0a1';
const MIB = 1024 * 1024;

const box = (device) => device.page.evaluate(() => document.querySelector('#composer-input').value);
const setBox = (device, text) =>
  device.page.evaluate((value) => {
    const input = document.querySelector('#composer-input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }, text);

const toastsOn = (device) => device.page.evaluate(() => [...document.querySelectorAll('#toast-host .toast')].map((el) => el.textContent));
const toastSays = (device, words, ms = 5000) =>
  waitFor(`${device.name} to say ${JSON.stringify(words)}`, async () => (await toastsOn(device)).some((text) => text.includes(words)), ms);

const readChat = (device, id) => device.page.evaluate((chatId) => JSON.stringify(state.chats[chatId] ?? null), id);
const field = (device, id, name) => device.page.evaluate(([chatId, key]) => state.chats[chatId]?.[key], [id, name]);
const fieldIs = (device, id, name, want) => waitFor(`${name} to be ${JSON.stringify(want)} on ${device.name}`, async () => (await field(device, id, name)) === want, 5000);
const lastMessageIs = (device, id, want) =>
  waitFor(`${device.name}'s last message to be ${JSON.stringify(want)}`, () => device.page.evaluate(([chatId, text]) => state.chats[chatId]?.messages.at(-1)?.content === text, [id, want]), 5000);
const isRunning = (device, id) => device.page.evaluate((chatId) => state.runningChats.has(chatId), id);
const pressed = (device, button) => device.page.evaluate((id) => document.getElementById(id).getAttribute('aria-pressed'), button);
const click = (device, selector) => device.page.evaluate((sel) => document.querySelector(sel).click(), selector);

// What the person at the home PC is looking at. All of it has to survive a laptop's activity.
const homeScreen = (device) =>
  device.page.evaluate(() => {
    const thread = document.querySelector('#thread');
    const input = document.querySelector('#composer-input');
    return {
      active: state.activeId,
      space: state.space,
      box: input.value,
      focused: document.activeElement === input,
      pending: state.pendingAttachments.map((a) => a.name),
      chips: document.querySelectorAll('#attachments .attachment').length,
      thread: thread.innerHTML,
      scroll: thread.scrollTop,
      bottom: thread.scrollHeight - thread.clientHeight,
      title: document.querySelector('#chat-title').value,
      lastModel: state.settings.lastModel
    };
  });

// One field at a time, so a failure says what moved.
function sameScreen(now, before, what) {
  for (const key of Object.keys(before)) {
    assert.deepEqual(now[key], before[key], `${what}: ${key} changed on the home PC`);
  }
}

function asker(homeId) {
  let count = 0;
  // Puts a frame straight on the wire, past everything the laptop's own UI would check.
  const raw = async (device, frame) => {
    assert.equal(await device.remote('send', homeId, frame), true, 'the frame went');
    return waitFor(`the answer to ${frame.kind}`, () =>
      device.page.evaluate((id) => window.__frames.find((f) => f.type === 'action-result' && f.id === id) ?? null, frame.id), 15000);
  };
  const ask = (device, kind, chatId, args) => {
    count += 1;
    const frame = { type: 'action', id: `test-${count}`, kind };
    if (chatId !== undefined) frame.chatId = chatId;
    if (args !== undefined) frame.args = args;
    return raw(device, frame);
  };
  return { ask, raw, nextId: () => `test-raw-${++count}` };
}

// Takes whatever chat requests have come in or come in soon, until the chat has stopped.
async function drain(ollama, home, id, say = 'Finished.') {
  await waitFor('the chat to stop', async () => {
    const reply = ollama.poll();
    if (reply && !reply.closed) {
      reply.say(say);
      reply.finish();
    }
    return !(await isRunning(home, id));
  }, 15000);
}

const stopShowingOn = (device) => device.page.evaluate(() => document.querySelector('.composer .send').classList.contains('stopping'));

// Stop only does anything once this device has heard there's a run to stop.
async function clickStopWhenShowing(device) {
  await waitFor('Stop to show', () => stopShowingOn(device), 5000);
  await clickStop(device);
}

const started = (device) =>
  waitFor(`${device.name} to finish starting`, () => device.page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));

test('acting from a laptop', async (t) => {
  const ollama = await startScriptedOllama();
  ollama.models.push(SECOND_MODEL);
  const trio = await startPair({ homeOllama: ollama });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-actions-'));
  const { home, laptop, homeId } = trio;
  const laptop2 = await launchDevice('laptop2', { ollamaUrl: trio.ollama.url });
  t.after(async () => {
    await laptop2.stop();
    await trio.stop();
    await ollama.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  await started(home);
  await started(laptop);
  await started(laptop2);
  await pair(home, laptop2, trio.relay.address);
  await waitFor('the second laptop to connect', async () => (await laptop2.entry())?.connected);
  await waitFor('the models to show as installed', () => home.page.evaluate(([a, b]) => state.installed.has(a) && state.installed.has(b), [MODEL, SECOND_MODEL]));
  await home.page.evaluate((m) => ensureModelInfo(m), MODEL);

  const homeId2 = (await laptop2.entry()).id;
  assert.equal(homeId2, homeId, 'both laptops know the home PC by one id');
  const onLaptop = { home, laptop, homeId };
  const onLaptop2 = { home, laptop: laptop2, homeId };
  const rid = (chatId) => `remote:${homeId}:${chatId}`;
  const { ask, raw, nextId } = asker(homeId);
  const openOn = async (device, chatId) => {
    await waitFor(`${chatId} to reach ${device.name}`, () => hasChat(device, rid(chatId)), 5000);
    await openChat(device, rid(chatId));
  };
  const shared = (fields = {}) => newChat(home, { modality: 'chat', title: '', remoteControl: true, webEnabled: false, ...fields });
  const agent = (fields = {}) =>
    shared({ modality: 'agent', planMode: true, approvalMode: false, noApproval: false, readOnly: false, noFetch: false, projectFolder: folder, pathAllowlist: [folder], maxSteps: 5, ...fields });
  const threeMatch = async (what, ...text) => {
    await threadsMatch(onLaptop, what, ...text);
    await threadsMatch(onLaptop2, what, ...text);
  };

  // What the person at home is doing all along: a long private chat, scrolled up, half-typed.
  const privateId = await newChat(home, { modality: 'chat', title: 'Private', webEnabled: false });
  await home.page.evaluate(([id, key]) => {
    for (let i = 0; i < 80; i++) state.chats[id].messages.push({ role: i % 2 ? 'assistant' : 'user', content: `Private line ${i}`, attachments: [] });
    state.settings.apiKeys = { anthropic: key };
    saveSettings();
    renderActiveChat();
  }, [privateId, KEY]);
  const settleHomeScreen = async () => {
    await openChat(home, privateId);
    await home.page.evaluate(() => {
      const input = document.querySelector('#composer-input');
      input.value = 'half typed on the home PC';
      input.focus();
      state.pendingAttachments = [{ kind: 'text', name: 'home-draft.txt', text: 'draft', ext: 'txt', size: 5 }];
      renderAttachments();
      document.querySelector('#thread').scrollTop = 120;
    });
    // The thread scrolls smoothly, so this takes a moment to get there.
    await waitFor('the thread to settle', async () => {
      const first = await home.page.evaluate(() => document.querySelector('#thread').scrollTop);
      await sleep(150);
      return first === (await home.page.evaluate(() => document.querySelector('#thread').scrollTop));
    }, 5000);
    return homeScreen(home);
  };

  await t.test('a message typed on the laptop reaches the model and streams back, and the home screen is left alone', async () => {
    const id = await shared();
    await openOn(laptop, id);
    const before = await settleHomeScreen();
    assert.ok(before.scroll > 0 && before.scroll < before.bottom, `scrolled part way up: ${before.scroll} of ${before.bottom}`);

    await submit(laptop, 'First from the laptop');
    assert.equal(await box(laptop), '', 'the box empties, as it does for a local send');
    const first = await ollama.next();
    assert.equal(first.body.model, MODEL);
    assert.deepEqual(first.body.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]), [['user', 'First from the laptop']]);
    sameScreen(await homeScreen(home), before, 'starting a run');
    await waitFor('Stop on the laptop', () => stopShowingOn(laptop), 5000);

    first.say('Streaming to ');
    await lastMessageIs(home, id, 'Streaming to ');
    await lastMessageIs(laptop, rid(id), 'Streaming to ');
    first.say('both ends.');
    await lastMessageIs(laptop, rid(id), 'Streaming to both ends.');
    sameScreen(await homeScreen(home), before, 'while streaming');
    first.finish();
    // The title comes after the reply, and has been known to redraw whatever's on screen.
    await fieldIs(home, id, 'title', TITLE);
    await fieldIs(laptop, rid(id), 'title', TITLE);
    await waitFor('the run to end on the laptop', async () => !(await isRunning(laptop, rid(id))), 5000);
    sameScreen(await homeScreen(home), before, 'after the reply and the title');

    // With the chat open at home too, both screens stream, and the next message has the history.
    await home.page.evaluate(() => {
      document.querySelector('#composer-input').value = '';
      state.pendingAttachments = [];
      renderAttachments();
    });
    await openChat(home, id);
    await threadsMatch(onLaptop, 'the finished reply', 'Streaming to both ends.');
    await submit(laptop, 'Second from the laptop');
    const second = await ollama.next();
    assert.deepEqual(second.body.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]), [
      ['user', 'First from the laptop'], ['assistant', 'Streaming to both ends.'], ['user', 'Second from the laptop']
    ]);
    second.say('Visible on both.');
    await threadsMatch(onLaptop, 'mid-stream', 'Visible on both.');
    await stopButtonsAre(onLaptop, true, 'mid-stream');
    second.finish();
    await threadsMatch(onLaptop, 'the second reply');
    await stopButtonsAre(onLaptop, false, 'after the second reply');
    await chatDataMatches(onLaptop, id);
    assert.equal(await home.page.evaluate((c) => state.activeId === c, id), true);
  });

  await t.test('Stop from the laptop aborts the stream, and clears what was queued', async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await submit(laptop, 'Keep talking');
    const reply = await ollama.next();
    reply.say('Partly');
    await threadsMatch(onLaptop, 'before Stop', 'Partly');

    // A message sent during a run queues at home, the same as one typed there.
    await submit(laptop, 'Queued from the laptop');
    await threadsMatch(onLaptop, 'the queued message', 'Queued from the laptop', 'msg user queued');
    assert.equal(await box(laptop), '');
    assert.equal(await stopShowingOn(laptop), true, 'an empty box means Stop');

    await clickStopWhenShowing(laptop);
    await waitFor('the fake stream to be aborted', () => reply.closed, 5000);
    await stopButtonsAre(onLaptop, false, 'after Stop');
    const after = await threadsMatch(onLaptop, 'after Stop', 'Partly');
    assert.ok(!after.includes('Queued from the laptop'), 'Stop clears the queue, as it does at home');
    assert.equal(await box(laptop), '', "this device's own Stop threw its own queue away");
    assert.equal(ollama.poll(), null, 'nothing else ran');
  });

  await t.test("changes from the laptop show on the home PC, through the same paths as local input", async () => {
    const id = await agent();
    const emptyOther = await newChat(home, { modality: 'agent', title: 'Empty other', projectFolder: folder, pathAllowlist: [folder], planMode: true });
    const otherModel = await field(home, emptyOther, 'model');
    await openChat(home, id);
    await openOn(laptop, id);
    const lastModel = await home.page.evaluate(() => state.settings.lastModel);

    // Safety modes, through the laptop's own buttons, and one is always on.
    assert.equal(await pressed(home, 'toggle-plan'), 'true');
    await waitFor('the laptop to show plan', async () => (await pressed(laptop, 'toggle-plan')) === 'true', 3000);
    await click(laptop, '#toggle-noapproval');
    await fieldIs(home, id, 'noApproval', true);
    assert.equal(await field(home, id, 'planMode'), false);
    assert.equal(await field(home, id, 'approvalMode'), false);
    await waitFor('home to show it', async () => (await pressed(home, 'toggle-noapproval')) === 'true' && (await pressed(home, 'toggle-plan')) === 'false', 3000);
    await waitFor('the laptop to show it', async () => (await pressed(laptop, 'toggle-noapproval')) === 'true' && (await pressed(laptop, 'toggle-plan')) === 'false', 3000);
    await click(laptop, '#toggle-approval');
    await fieldIs(home, id, 'approvalMode', true);
    assert.equal(await field(home, id, 'noApproval'), false);
    assert.equal(await field(home, id, 'planMode'), false);
    assert.equal((await ask(laptop, 'set-mode', id, { mode: 'plan' })).ok, true);
    await fieldIs(home, id, 'planMode', true);
    assert.equal(await field(home, id, 'approvalMode'), false);
    assert.equal(await field(home, id, 'noApproval'), false);
    // The active mode clicked again stays on: there's no off.
    await waitFor('the laptop to catch up', async () => (await pressed(laptop, 'toggle-plan')) === 'true', 3000);
    await click(laptop, '#toggle-plan');
    await sleep(300);
    assert.equal(await field(home, id, 'planMode'), true);

    // Toggles.
    await click(laptop, '#toggle-readonly');
    await fieldIs(home, id, 'readOnly', true);
    await waitFor('readOnly on the laptop', async () => (await pressed(laptop, 'toggle-readonly')) === 'true', 3000);
    await click(laptop, '#toggle-nofetch');
    await fieldIs(home, id, 'noFetch', true);
    await click(laptop, '#toggle-web');
    await fieldIs(home, id, 'webEnabled', true);
    await waitFor('home to show web on', async () => (await pressed(home, 'toggle-web')) === 'true', 3000);

    // Thinking, which the home PC knows about and the laptop's catalog might not.
    await click(laptop, '#toggle-think');
    await fieldIs(home, id, 'thinkingEnabled', true);

    // The picker, on the home PC's list.
    await waitFor('the picker to offer the second model', () =>
      laptop.page.evaluate((m) => Boolean(document.querySelector(`#cs-menu .cs-item[data-value="${m}"]`)), SECOND_MODEL), 5000);
    await click(laptop, `#cs-menu .cs-item[data-value="${SECOND_MODEL}"]`);
    await fieldIs(home, id, 'model', SECOND_MODEL);
    await fieldIs(laptop, rid(id), 'model', SECOND_MODEL);
    await waitFor('both pickers to show it', async () =>
      (await home.page.evaluate(() => document.querySelector('#cs-current').textContent)).includes('second')
      && (await laptop.page.evaluate(() => document.querySelector('#cs-current').textContent)).includes('second'), 3000);
    assert.equal(await field(home, id, 'modality'), 'agent', 'a project stays a project');
    assert.equal(await home.page.evaluate(() => state.settings.lastModel), lastModel, "a laptop's pick doesn't change home's settings");
    assert.equal(await field(home, emptyOther, 'model'), otherModel, "and doesn't spread to other chats");

    // Renaming, through the laptop's title box.
    await laptop.page.evaluate(() => {
      document.querySelector('#chat-title-edit').click();
      document.querySelector('#chat-title').value = 'Named on the laptop';
      document.querySelector('#chat-title-edit').click();
    });
    await fieldIs(home, id, 'title', 'Named on the laptop');
    assert.equal(await field(home, id, 'titleManual'), true);
    await waitFor('home to show the name', async () => (await home.page.evaluate(() => document.querySelector('#chat-title').value)) === 'Named on the laptop', 3000);
    await fieldIs(laptop, rid(id), 'title', 'Named on the laptop');

    // Delete, through the laptop's sidebar.
    const doomed = await shared({ title: 'Doomed' });
    await openChat(home, id);
    await openOn(laptop, doomed);
    const homeBefore = await home.page.evaluate(() => state.activeId);
    await laptop.page.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item')].find((el) => el.textContent.includes('Doomed')).querySelector('.chat-del').click());
    await waitFor('it to go from home', async () => !(await hasChat(home, doomed)), 5000);
    await waitFor('and from the laptop', async () => !(await hasChat(laptop, rid(doomed))), 5000);
    assert.equal(await home.page.evaluate(() => state.activeId), homeBefore);
    await home.page.evaluate((c) => deleteChat(c), emptyOther);
  });

  await t.test('a new chat from the laptop appears on both, with Remote Control on, and home stays put', async () => {
    const before = await settleHomeScreen();
    const beforeIds = await home.page.evaluate(() => Object.keys(state.chats));
    await laptop.page.evaluate(() => {
      state.space = 'home';
      applySpaceChrome();
      paintRemoteChatButton();
    });
    await waitFor('the button to show', () => laptop.page.evaluate(() => !document.querySelector('#new-remote-chat').hidden), 3000);
    await click(laptop, '#new-remote-chat');
    const id = await waitFor('the new chat at home', () =>
      home.page.evaluate((ids) => Object.keys(state.chats).find((k) => !ids.includes(k)) ?? null, beforeIds), 5000);
    assert.equal(await field(home, id, 'remoteControl'), true);
    assert.equal(await field(home, id, 'modality'), 'chat');
    await waitFor('the laptop to open it', () => laptop.page.evaluate((key) => state.activeId === key, rid(id)), 5000);
    await waitFor('the other laptop to have it', () => hasChat(laptop2, rid(id)), 5000);
    sameScreen(await homeScreen(home), before, 'making a chat from the laptop');
    assert.ok(await home.page.evaluate((c) => [...document.querySelectorAll('#chat-list .chat-item')].length > 0, id));

    // A project is born in Plan Mode, however it's asked for.
    const made = await ask(laptop, 'new-chat', undefined, { modality: 'agent', model: MODEL });
    assert.equal(made.ok, true);
    assert.equal(typeof made.chatId, 'string');
    const project = await home.page.evaluate((c) => {
      const { planMode, approvalMode, noApproval, remoteControl, model, modality, maxSteps, pathAllowlist } = state.chats[c];
      return { planMode, approvalMode, noApproval, remoteControl, model, modality, maxSteps, pathAllowlist };
    }, made.chatId);
    assert.deepEqual(project, { planMode: true, approvalMode: false, noApproval: false, remoteControl: true, model: MODEL, modality: 'agent', maxSteps: 5, pathAllowlist: [] });
    sameScreen(await homeScreen(home), before, 'making a project from the laptop');

    assert.equal((await ask(laptop, 'new-chat', undefined, { model: 'not-a-model' })).ok, false);
    await home.page.evaluate(() => {
      document.querySelector('#composer-input').value = '';
      state.pendingAttachments = [];
      renderAttachments();
    });
  });

  await t.test("an action on a chat that isn't shared is refused, and the chat doesn't change", async () => {
    const before = await readChat(home, privateId);
    const kinds = [
      ['send', { text: 'Let me in' }], ['stop', undefined], ['set-model', { model: SECOND_MODEL }], ['set-mode', { mode: 'noApproval' }],
      ['set-toggle', { name: 'webEnabled', value: true }], ['rename', { title: 'Taken over' }], ['delete', undefined],
      ['list-dir', { path: folder }], ['set-folder', { path: folder }]
    ];
    for (const [kind, args] of kinds) {
      const answer = await ask(laptop, kind, privateId, args);
      assert.equal(answer.ok, false, kind);
      assert.match(answer.error, /no longer shared/, kind);
      assert.equal(answer.entries, undefined);
    }
    for (const chatId of ['does-not-exist', '__proto__', 'constructor', 'toString', rid(privateId)]) {
      assert.equal((await ask(laptop, 'rename', chatId, { title: 'Taken over' })).ok, false, chatId);
    }
    assert.equal(await readChat(home, privateId), before);
    assert.equal(ollama.poll(), null, 'no run started');
  });

  await t.test('whatever else a frame holds, only what is listed happens', async () => {
    const id = await agent({ title: 'Target' });
    await openOn(laptop, id);
    const secrets = () => home.page.evaluate(() => JSON.stringify([state.settings, Object.keys(state.chats).length]));
    const status = () => home.remote('status').then((s) => JSON.stringify([s.controlAllowed, s.devices.map((d) => d.id)]));
    const before = [await secrets(), await status(), await readChat(home, id)];

    const refused = [
      { kind: 'read-api-keys' }, { kind: 'set-pin', args: { pin: '000000' } }, { kind: 'setControlAllowed', args: { allowed: true } },
      { kind: 'set-control', args: { allowed: true } }, { kind: 'pair', args: { code: 'ABCDEF' } }, { kind: 'removeDevice', args: { id: 'x' } },
      { kind: 'set-toggle', args: { name: 'remoteControl', value: false } }, { kind: 'set-toggle', args: { name: 'noApproval', value: true } },
      { kind: 'set-toggle', args: { name: 'apiKeys', value: true } }, { kind: 'set-mode', args: { mode: 'off' } },
      { kind: 'set-model', args: { model: 'not-a-model' } }, { kind: 'set-model', args: { model: 'constructor' } }, { kind: 'rename', args: { title: '' } },
      { kind: 'send', args: { text: '' } }, { kind: 'send', args: { text: 5 } }, { kind: 'send', args: { text: 'x', model: 'other' } },
      { kind: 'list-dir', args: { path: '\\\\attacker\\share' } }, { kind: 'set-folder', args: { path: '//attacker/share' } }, { kind: 'set-folder', args: { path: 'relative' } },
      { kind: 'set-folder', args: { path: path.join(folder, 'not-there') } }
    ];
    for (const frame of refused) {
      const answer = await raw(laptop, { type: 'action', id: nextId(), chatId: id, ...frame });
      assert.equal(answer.ok, false, JSON.stringify(frame));
      assert.equal(typeof answer.error, 'string');
    }
    assert.equal(await field(home, id, 'projectFolder'), folder);

    // JSON.parse makes these real keys, as it does at the far end of the link. Playwright can't
    // carry one across, so these are parsed where they're handed in, and the answer still goes
    // back over the link.
    const laptopId = (await home.entry()).id;
    const pollute = async (text, frameId) => {
      await home.page.evaluate(([from, json]) => mirrorOnFrame(from, JSON.parse(json)), [laptopId, text]);
      return waitFor('the answer', () => laptop.page.evaluate((f) => window.__frames.find((x) => x.id === f) ?? null, frameId), 5000);
    };
    const pollutedId = nextId();
    assert.equal((await pollute(`{"type":"action","id":"${pollutedId}","chatId":"${id}","kind":"rename","args":{"title":"Polluted","__proto__":{"polluted":true}}}`, pollutedId)).ok, false);
    const topId = nextId();
    assert.equal((await pollute(`{"type":"action","id":"${topId}","chatId":"${id}","kind":"stop","__proto__":{"polluted":true}}`, topId)).ok, false);
    // And the whole way, in case something on the way turns the key into a prototype.
    await laptop.page.evaluate(([to, json]) => window.api.remote.send(to, JSON.parse(json)), [homeId, `{"type":"action","id":"${nextId()}","chatId":"${id}","kind":"stop","__proto__":{"polluted":true}}`]);
    await sleep(200);
    assert.equal(await home.page.evaluate(() => ({}).polluted), undefined);

    // An id that can't be echoed safely doesn't get an answer, or do anything.
    await laptop.remote('send', homeId, { type: 'action', id: { evil: true }, chatId: id, kind: 'rename', args: { title: 'No id' } });
    await sleep(300);
    assert.deepEqual([await secrets(), await status(), await readChat(home, id)], before);

    // Modes are a project's, and thinking is the model's.
    const plain = await shared({ title: 'Plain' });
    assert.equal((await ask(laptop, 'set-mode', plain, { mode: 'noApproval' })).ok, false);
    assert.equal((await ask(laptop, 'set-toggle', plain, { name: 'readOnly', value: true })).ok, false);
    assert.equal((await ask(laptop, 'set-folder', plain, { path: folder })).ok, false);
    assert.equal((await ask(laptop, 'list-dir', plain, { path: folder })).ok, false);
    assert.equal(await field(home, plain, 'noApproval'), undefined);
    await home.page.evaluate((c) => { state.chats[c].model = 'no-thinking:1b'; }, plain);
    assert.equal((await ask(laptop, 'set-toggle', plain, { name: 'thinkingEnabled', value: true })).ok, false);
    assert.equal(await field(home, plain, 'thinkingEnabled'), undefined);

    // An action goes one way. A home PC can't drive its laptop, or answer for another device.
    const local = await laptop.page.evaluate(() => { createChat(); return state.activeId; });
    await home.remote('send', (await home.entry()).id, { type: 'action', id: nextId(), chatId: local, kind: 'rename', args: { title: 'From home' } });
    await sleep(300);
    assert.notEqual(await field(laptop, local, 'title'), 'From home');
    await home.page.evaluate((c) => deleteChat(c), plain);
    await openOn(laptop, id);
  });

  await t.test('the folder actions name directories only, and a chosen folder replaces the old one', async () => {
    fs.mkdirSync(path.join(folder, 'tree', 'sub-one'), { recursive: true });
    fs.mkdirSync(path.join(folder, 'tree', 'sub-two'));
    fs.writeFileSync(path.join(folder, 'tree', 'a-file-secret-name.txt'), 'x');
    const other = path.join(folder, 'tree', 'sub-one');
    const id = await agent({ title: '', projectFolder: undefined, pathAllowlist: ['/kept/by/hand'] });

    const listed = await ask(laptop, 'list-dir', id, { path: path.join(folder, 'tree') });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.entries, ['sub-one', 'sub-two']);
    assert.ok(!JSON.stringify(listed).includes('secret-name'));
    assert.equal((await ask(laptop, 'list-dir', id, { path: path.join(folder, 'tree', 'a-file-secret-name.txt') })).ok, false);
    const start = await ask(laptop, 'list-dir', id, { path: '' });
    assert.equal(start.ok, true);
    assert.equal(start.path.toLowerCase(), os.homedir().toLowerCase());

    assert.equal((await ask(laptop, 'set-folder', id, { path: path.join(folder, 'tree', 'a-file-secret-name.txt') })).ok, false);
    assert.equal((await ask(laptop, 'set-folder', id, { path: other })).ok, true);
    assert.equal(await field(home, id, 'projectFolder'), other);
    assert.deepEqual(await field(home, id, 'pathAllowlist'), ['/kept/by/hand', other]);
    assert.equal(await field(home, id, 'title'), 'sub-one', 'an unnamed chat takes the folder name, as it does locally');
    const moved = path.join(folder, 'tree', 'sub-two');
    assert.equal((await ask(laptop, 'set-folder', id, { path: moved })).ok, true);
    assert.deepEqual(await field(home, id, 'pathAllowlist'), ['/kept/by/hand', moved], 'changing folders ends access to the old one');
    await home.page.evaluate((c) => deleteChat(c), id);
  });

  await t.test("review focus 3: two laptops send at once, one order, three matching threads", async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await openOn(laptop2, id);
    await threeMatch('an empty chat', 'What would you like to do');

    await Promise.all([submit(laptop, 'One from the first laptop'), submit(laptop2, 'Two from the second laptop')]);
    const first = await ollama.next();
    const firstUser = first.body.messages.filter((m) => m.role === 'user').map((m) => m.content);
    assert.equal(firstUser.length, 1, 'the first to arrive runs, and the other waits its turn');
    const other = firstUser[0].startsWith('One') ? 'Two from the second laptop' : 'One from the first laptop';
    await threeMatch('both messages, one queued', 'One from the first laptop', 'Two from the second laptop', 'msg user queued');
    first.say('Answer to the first.');
    await threeMatch('the first answer', 'Answer to the first.');
    first.finish();
    const second = await ollama.next();
    assert.deepEqual(second.body.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]), [
      ['user', firstUser[0]], ['assistant', 'Answer to the first.'], ['user', other]
    ]);
    second.say('Answer to the second.');
    second.finish();
    await threeMatch('both answers', 'Answer to the second.');
    await stopButtonsAre(onLaptop, false, 'after both');
    await stopButtonsAre(onLaptop2, false, 'after both');
    await chatDataMatches(onLaptop, id);
    await chatDataMatches(onLaptop2, id);
  });

  await t.test('review focus 3: Send and Stop arriving together resolve by order of arrival', async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await openOn(laptop2, id);

    // Send lands first, then Stop: that message is what gets stopped.
    await submit(laptop, 'Send then Stop');
    await waitFor('the send to land', () => home.page.evaluate((c) => state.runningChats.has(c), id), 5000);
    await clickStopWhenShowing(laptop2);
    // The app learns which stream to end from its first chunk, here as anywhere.
    const reply = await ollama.next();
    reply.say('');
    await waitFor('its stream to close', () => reply.closed, 5000);
    await waitFor('the run to stop', async () => !(await isRunning(home, id)), 5000);
    await threeMatch('Send then Stop', 'Send then Stop');
    await stopButtonsAre(onLaptop, false, 'Send then Stop');
    await stopButtonsAre(onLaptop2, false, 'Send then Stop');

    // Stop lands first, on an idle chat, so there's nothing for it to do and the send runs.
    assert.equal((await ask(laptop2, 'stop', id)).ok, true);
    await submit(laptop, 'Stop then Send');
    const ran = await ollama.next();
    assert.equal(ran.body.messages.at(-1).content, 'Stop then Send');
    ran.say('It ran.');
    ran.finish();
    await threeMatch('Stop then Send', 'It ran.');

    // During a run, Stop and then a send, from one laptop, so they arrive in that order.
    await submit(laptop, 'Long one');
    const long = await ollama.next();
    long.say('Going on');
    await threeMatch('the long one', 'Going on');
    const racing = 'Sent just after Stop';
    await waitFor('Stop to show', () => stopShowingOn(laptop), 5000);
    await laptop.page.evaluate((text) => {
      document.querySelector('.composer .send').click();
      const input = document.querySelector('#composer-input');
      input.value = text;
      document.querySelector('#composer-form').requestSubmit();
    }, racing);
    await waitFor('the long one to close', () => long.closed, 5000);
    await sleep(300);
    await drain(ollama, home, id);
    // Either it landed before the run had ended and comes back, or after and ran. Never neither.
    await waitFor('the words to be somewhere', async () => (await box(laptop)) === racing || (await threadOf(home)).includes(racing), 5000);
    await setBox(laptop, '');
    await threeMatch('after Stop then Send', 'Going on');

    // Truly at once, in whichever order they reach it. All that's promised is that all three agree.
    await Promise.all([submit(laptop, 'Racing'), clickStop(laptop2), laptop2.remote('send', homeId, { type: 'action', id: nextId(), chatId: id, kind: 'stop' })]);
    await sleep(300);
    await drain(ollama, home, id);
    await threeMatch('the race', 'Racing');
    await stopButtonsAre(onLaptop, false, 'the race');
    await stopButtonsAre(onLaptop2, false, 'the race');
    await chatDataMatches(onLaptop, id);
    await chatDataMatches(onLaptop2, id);
  });

  await t.test("a queued message that can't go comes back to whoever sent it, not to the home PC's box", async () => {
    const id = await shared();
    await openOn(laptop, id);
    await openOn(laptop2, id);
    const before = await settleHomeScreen();
    await submit(laptop, 'Running');
    const reply = await ollama.next();
    reply.say('Hm.');
    await lastMessageIs(laptop, rid(id), 'Hm.');
    await submit(laptop, 'Queued by the first laptop');
    await waitFor('it to queue', () => home.page.evaluate((c) => state.chats[c].messages.some((m) => m.queued), id), 5000);
    // Stop from elsewhere. The first laptop's words go back to it.
    await clickStopWhenShowing(laptop2);
    await waitFor('the words to come back', async () => (await box(laptop)) === 'Queued by the first laptop', 5000);
    await toastSays(laptop, 'back in the message box');
    assert.equal(await box(laptop2), '');
    const { thread, ...rest } = await homeScreen(home);
    const { thread: _, ...restBefore } = before;
    assert.deepEqual(rest, restBefore);
    await setBox(laptop, '');
    await home.page.evaluate(() => {
      document.querySelector('#composer-input').value = '';
      state.pendingAttachments = [];
      renderAttachments();
    });
    await waitFor('the chat to stop', async () => !(await isRunning(home, id)), 5000);
  });

  await t.test('the home PC sending at the same moment as two laptops: one order, three matching threads', async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await openOn(laptop2, id);
    const words = ['Typed at home at once', 'Typed on laptop one at once', 'Typed on laptop two at once'];
    await Promise.all([submit(home, words[0]), submit(laptop, words[1]), submit(laptop2, words[2])]);
    await threeMatch('all three in the thread', ...words);
    const history = [];
    for (let i = 0; i < 3; i++) {
      const reply = await ollama.next();
      const sent = reply.body.messages.filter((m) => m.role !== 'system').map((m) => [m.role, m.content]);
      assert.deepEqual(sent.slice(0, -1), history, 'each turn sees all that came before it');
      assert.equal(sent.at(-1)[0], 'user');
      history.push(sent.at(-1));
      reply.say(`Answer ${i}.`);
      reply.finish();
      history.push(['assistant', `Answer ${i}.`]);
    }
    assert.deepEqual(history.filter(([role]) => role === 'user').map(([, text]) => text).sort(), [...words].sort());
    await threeMatch('all three answered', 'Answer 2.');
    await stopButtonsAre(onLaptop, false, 'all answered');
    await stopButtonsAre(onLaptop2, false, 'all answered');
    await chatDataMatches(onLaptop, id);
    await chatDataMatches(onLaptop2, id);
  });

  await t.test("a laptop's Stop doesn't destroy what the person at home queued", async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await submit(laptop, 'Running');
    const reply = await ollama.next();
    reply.say('Partly');
    await lastMessageIs(laptop, rid(id), 'Partly');
    await submit(home, 'Queued by the person at home');
    await threadsMatch(onLaptop, 'the home queue', 'Queued by the person at home', 'msg user queued');
    assert.equal(await box(home), '');

    await clickStopWhenShowing(laptop);
    await waitFor('the words back in the home box', async () => (await box(home)) === 'Queued by the person at home', 5000);
    await toastSays(home, 'back in the message box');
    await waitFor('the chat to stop', async () => !(await isRunning(home, id)), 5000);
    assert.equal(await box(laptop), '');
    await setBox(home, '');
  });

  await t.test("deleting a chat during a run gives a laptop's queued words back", async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await submit(laptop, 'Running');
    const reply = await ollama.next();
    reply.say('Partly');
    await lastMessageIs(laptop, rid(id), 'Partly');
    await submit(laptop, 'Queued before the delete');
    await waitFor('it to queue', () => home.page.evaluate((c) => state.chats[c].messages.some((m) => m.queued), id), 5000);

    // The chat leaving the laptop usually beats the end of the aborted run. Here it always does.
    await home.page.evaluate(() => {
      window.__realRestore = window.restoreQueuedMessages;
      window.restoreQueuedMessages = (c) => setTimeout(() => window.__realRestore(c), 800);
    });
    await home.page.evaluate((c) => deleteChat(c), id);
    await waitFor('the chat to leave', async () => !(await hasChat(laptop, rid(id))), 3000);
    assert.equal(await box(laptop), '', 'not yet');
    await waitFor('the words to come back', async () => (await box(laptop)) === 'Queued before the delete', 5000);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-gone').hidden), false);
    await home.page.evaluate(() => { window.restoreQueuedMessages = window.__realRestore; });
    await setBox(laptop, '');
    await click(laptop, '#remote-gone button');
  });

  await t.test("a laptop's queued words wait at home while it's offline", async () => {
    const id = await shared();
    await openChat(home, id);
    await openOn(laptop, id);
    await submit(laptop, 'Running');
    const reply = await ollama.next();
    reply.say('Partly');
    await lastMessageIs(laptop, rid(id), 'Partly');
    await submit(laptop, 'Queued before going offline');
    await waitFor('it to queue', () => home.page.evaluate((c) => state.chats[c].messages.some((m) => m.queued), id), 5000);

    const laptopId = (await home.entry()).id;
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('home to see it go', async () => (await home.entry(laptopId)).connected === false, 60000);

    await clickStopWhenShowing(home);
    await waitFor('the chat to stop', async () => !(await isRunning(home, id)), 5000);
    assert.equal(await home.page.evaluate((c) => state.chats[c].messages.some((m) => m.queued), id), false);
    assert.equal(await box(home), '', "the home PC's box isn't where they go");
    assert.equal(await box(laptop), '');

    assert.deepEqual(await laptop.remote('setAddress', trio.relay.address), { ok: true });
    await waitFor('the laptop to be back', async () => (await laptop.entry()).connected === true, 30000);
    await waitFor('the words to come back', async () => (await box(laptop)) === 'Queued before going offline', 10000);
    await toastSays(laptop, 'back in the message box');
    await setBox(laptop, '');
    // Once.
    await sleep(2200);
    assert.equal(await box(laptop), '');
    assert.equal(await home.page.evaluate(() => mirror.undelivered.size), 0);
  });

  await t.test('a send answered after the chat was unshared: refused, and the words come back', async () => {
    const id = await shared({ title: 'Unshared in flight' });
    await openChat(home, id);
    await openOn(laptop, id);
    await home.page.evaluate(() => {
      window.__realHandle = window.handleRemoteAction;
      window.handleRemoteAction = (d, frame) => setTimeout(() => window.__realHandle(d, frame), 500);
    });
    await submit(laptop, 'Already on its way');
    assert.equal(await box(laptop), '');
    await home.page.evaluate((c) => { state.chats[c].remoteControl = false; markMirrorDirty(); }, id);
    await waitFor('the chat to leave', async () => !(await hasChat(laptop, rid(id))), 3000);
    await waitFor('the words to come back', async () => (await box(laptop)) === 'Already on its way', 5000);
    await toastSays(laptop, 'no longer shared');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-gone').hidden), false);
    assert.ok(!(await readChat(home, id)).includes('Already on its way'));
    await home.page.evaluate(() => { window.handleRemoteAction = window.__realHandle; });
    await setBox(laptop, '');
    await click(laptop, '#remote-gone button');
  });

  await t.test('a late answer to a send that timed out says it did go through', async () => {
    const id = await shared({ title: 'Late' });
    await openChat(home, id);
    await openOn(laptop, id);
    const holdFrames = () => home.page.evaluate(() => {
      window.__realHandle = window.handleRemoteAction;
      window.handleRemoteAction = (d, frame) => setTimeout(() => window.__realHandle(d, frame), 16500);
    });
    const release = () => home.page.evaluate(() => { window.handleRemoteAction = window.__realHandle; });

    // Nothing else has been typed, so what came back goes again.
    await holdFrames();
    await submit(laptop, 'Slow but sure');
    await waitFor('the text back in the box', async () => (await box(laptop)) === 'Slow but sure', 16000);
    await toastSays(laptop, 'Your message may still arrive.');
    const first = await ollama.next();
    assert.equal(first.body.messages.at(-1).content, 'Slow but sure');
    await waitFor('the box to empty', async () => (await box(laptop)) === '', 3000);
    await toastSays(laptop, 'Your message did go through');
    first.finish();
    await waitFor('the run to end', async () => !(await isRunning(home, id)), 5000);

    // More typed since: it stays, because what's there isn't just what came back.
    await submit(laptop, 'Slow again');
    await waitFor('the text back in the box', async () => (await box(laptop)) === 'Slow again', 16000);
    await setBox(laptop, 'Slow again, and more I typed');
    const second = await ollama.next();
    assert.equal(second.body.messages.at(-1).content, 'Slow again');
    await toastSays(laptop, 'Your message did go through');
    assert.equal(await box(laptop), 'Slow again, and more I typed');
    second.finish();
    await waitFor('the run to end', async () => !(await isRunning(home, id)), 5000);
    await setBox(laptop, '');

    // A late refusal changes nothing: the words are already back.
    await home.page.evaluate(() => {
      window.handleRemoteAction = (d, frame) => setTimeout(() => window.api.remote.send(d, { type: 'action-result', id: frame.id, ok: false, error: 'Too late anyway' }), 16500);
    });
    await submit(laptop, 'Refused late');
    await waitFor('the text back in the box', async () => (await box(laptop)) === 'Refused late', 16000);
    await sleep(2000);
    assert.equal(await box(laptop), 'Refused late');
    await release();
    await setBox(laptop, '');
    assert.equal(await laptop.page.evaluate(() => mirror.lateActions.size), 0, 'answered ones are not kept');
    // And a late answer from some other device counts for nothing.
    const kept = await laptop.page.evaluate(([from]) => {
      mirror.lateActions.set('kept-id', { deviceId: from, onLateOk: () => { window.__lateRan = true; }, timer: null });
      mirrorOnFrame('someone-else', { type: 'action-result', id: 'kept-id', ok: true });
      const ran = window.__lateRan === true;
      mirror.lateActions.delete('kept-id');
      return ran;
    }, [homeId]);
    assert.equal(kept, false);
  });

  await t.test('the home PC keeps a record of what a laptop did, and never what it said', async () => {
    const auditFile = await home.page.evaluate(() => window.api.audit.path());
    const entries = () => fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const laptopId = (await home.entry()).id;
    const id = await agent({ title: 'Audited' });
    const SECRET_WORDS = 'AUDIT-MUST-NOT-SEE-THESE-WORDS';
    const SECRET_FILE = 'AUDIT-MUST-NOT-SEE-THIS-FILE';
    const SECRET_TITLE = 'AUDIT-MUST-NOT-SEE-THIS-TITLE';
    const before = entries().length;

    assert.equal((await ask(laptop, 'set-mode', id, { mode: 'noApproval' })).ok, true);
    assert.equal((await ask(laptop, 'set-toggle', id, { name: 'readOnly', value: true })).ok, true);
    assert.equal((await ask(laptop, 'set-model', id, { model: SECOND_MODEL })).ok, true);
    assert.equal((await ask(laptop, 'set-folder', id, { path: folder })).ok, true);
    assert.equal((await ask(laptop, 'rename', id, { title: SECRET_TITLE })).ok, true);
    assert.equal((await ask(laptop, 'set-model', id, { model: MODEL })).ok, true);
    assert.equal((await ask(laptop, 'send', id, { text: SECRET_WORDS, attachments: [{ kind: 'text', name: 'a.txt', text: SECRET_FILE, ext: 'txt', size: 28 }] })).ok, true);
    const reply = await ollama.next();
    assert.ok(reply.body.messages.at(-1).content.includes(SECRET_WORDS), 'the words did reach the model');
    reply.finish();
    assert.equal((await ask(laptop, 'set-mode', privateId, { mode: 'noApproval' })).ok, false);
    assert.equal((await ask(laptop, 'read-api-keys', id)).ok, false);
    assert.equal((await ask(laptop, 'delete', id)).ok, true);

    const seen = await waitFor('the record', async () => {
      const found = entries().slice(before);
      return found.length >= 10 ? found : null;
    }, 5000);
    const of = (kind, ok) => seen.find((e) => e.kind === kind && e.ok === ok);
    for (const e of seen) {
      assert.equal(e.device, laptopId);
      assert.equal(e.source, 'remote-action');
      assert.ok(e.ts);
    }
    assert.equal(of('set-mode', true).chat, id);
    assert.deepEqual(of('set-mode', true).args, { mode: 'noApproval' });
    assert.deepEqual(of('set-toggle', true).args, { name: 'readOnly', value: true });
    assert.deepEqual(of('set-model', true).args, { model: SECOND_MODEL });
    assert.deepEqual(of('set-folder', true).args, { path: folder });
    assert.equal(of('delete', true).chat, id);
    assert.equal(of('set-mode', false).chat, privateId);
    assert.equal(of('read-api-keys', false).ok, false);
    assert.deepEqual(of('send', true).args, { attachments: 1 });
    const text = fs.readFileSync(auditFile, 'utf8');
    assert.ok(!text.includes(SECRET_WORDS), 'message text');
    assert.ok(!text.includes(SECRET_FILE), 'attachment contents');
    assert.ok(!text.includes(SECRET_TITLE), 'a chat title');
  });

  await t.test("no agent tool reads Sanctum's own data folder, and a laptop can't choose it", async () => {
    const profile = home.profile;
    const parent = path.dirname(profile);
    fs.writeFileSync(path.join(profile, 'profile-canary.txt'), 'PROFILE-CANARY-WORDS');

    const id = await agent({ title: 'Reaching for the profile', projectFolder: undefined, pathAllowlist: [] });
    for (const kind of ['set-folder', 'list-dir']) {
      for (const target of [profile, path.join(profile, 'Local Storage'), ...(process.platform === 'win32' ? [profile.toUpperCase()] : [])]) {
        const answer = await ask(laptop, kind, id, { path: target });
        assert.equal(answer.ok, false, `${kind} ${target}`);
        assert.match(answer.error, /Sanctum's own data/, `${kind} ${target}`);
      }
    }
    assert.equal(await field(home, id, 'projectFolder'), undefined);

    // A folder above it is allowed, and a project starts in Plan Mode. Reads there go ahead with
    // no pop-up, so it's the tools themselves that have to refuse.
    assert.equal((await ask(laptop, 'set-folder', id, { path: parent })).ok, true);
    assert.equal(await field(home, id, 'planMode'), true);
    assert.equal((await ask(laptop, 'send', id, { text: 'Read the profile' })).ok, true);
    const first = await ollama.next();
    first.call(['read_file', { path: path.join(profile, 'profile-canary.txt') }], ['list_dir', { path: profile }]);
    first.finish();
    const second = await ollama.next();
    const results = second.body.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    assert.equal(results.length, 2);
    for (const result of results) assert.match(result, /Sanctum's own data/);
    assert.ok(!JSON.stringify(second.body).includes('PROFILE-CANARY-WORDS'));
    assert.ok(!JSON.stringify(second.body).includes('Local Storage'), 'not even the names inside');
    assert.equal(await home.page.evaluate(() => document.querySelector('#path-expand-overlay').hidden), true, 'and nobody is asked');
    second.finish();
    await waitFor('the run to end', async () => !(await isRunning(home, id)), 5000);
    await home.page.evaluate((c) => deleteChat(c), id);
  });

  await t.test('a burst of snapshot requests costs about one snapshot a second, and the last still gets answered', async () => {
    const count = () => laptop.page.evaluate(() => window.__mirrorFrames.filter((f) => f.type === 'mirror-snapshot').length);
    await sleep(1200);
    const before = await count();
    await laptop.page.evaluate((to) => {
      for (let i = 0; i < 40; i++) window.api.remote.send(to, { type: 'mirror-resync-request' });
    }, homeId);
    await sleep(600);
    assert.ok((await count()) - before <= 1, `${(await count()) - before} snapshots in 600 ms`);
    await waitFor('the deferred one', async () => (await count()) - before >= 2, 3000);
    await sleep(1500);
    assert.ok((await count()) - before <= 2, `${(await count()) - before} snapshots from 40 requests`);
    assert.equal(await laptop.page.evaluate((h) => mirror.homes.get(h).awaitingSnapshot, homeId), false);
  });

  await t.test('review focus 4: unsharing while the laptop has text in the box', async () => {
    const id = await shared({ title: 'Going away' });
    const stay = await shared({ title: 'Staying' });
    await openChat(home, id);
    await openOn(laptop, id);
    await setBox(laptop, 'Words I have not sent yet');

    const started = Date.now();
    await home.page.evaluate((c) => { state.chats[c].remoteControl = false; markMirrorDirty(); }, id);
    await waitFor('the chat to leave', async () => !(await hasChat(laptop, rid(id))), 3000);
    assert.ok(Date.now() - started < 2000, 'it left at once');
    await waitFor('it to leave the screen', () => laptop.page.evaluate((key) => state.activeId !== key, rid(id)), 2000);
    const sidebar = await laptop.page.evaluate(() => document.querySelector('#chat-list').textContent);
    assert.ok(!sidebar.includes('Going away'));
    assert.equal(await box(laptop), 'Words I have not sent yet', 'the text is still there');
    assert.ok((await laptop.page.evaluate(() => document.querySelector('#remote-gone').textContent)).includes('This chat is no longer shared'));
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-gone').hidden), false);

    const late = await ask(laptop, 'send', id, { text: 'Too late' });
    assert.equal(late.ok, false);
    assert.equal(late.error, 'This chat is no longer shared.');
    assert.ok(!(await home.page.evaluate((c) => JSON.stringify(state.chats[c].messages), id)).includes('Too late'));

    // It goes when it's been read, and it doesn't come back for the next chat.
    await click(laptop, '#remote-gone button');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-gone').hidden), true);
    assert.equal(await box(laptop), 'Words I have not sent yet');
    await setBox(laptop, '');

    // Deleting does the same.
    await openOn(laptop, stay);
    await setBox(laptop, 'More words');
    await home.page.evaluate((c) => deleteChat(c), stay);
    await waitFor('the chat to leave', async () => !(await hasChat(laptop, rid(stay))), 3000);
    assert.equal(await box(laptop), 'More words');
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#remote-gone').hidden), false);
    await setBox(laptop, '');
    await click(laptop, '#remote-gone button');
  });

  await t.test('no way of failing loses what was typed', async () => {
    const id = await shared({ title: 'Failures' });
    await openOn(laptop, id);
    const typed = 'Please keep this text';

    // The home PC can't run it: not installed there.
    const installedModel = await field(home, id, 'model');
    await home.page.evaluate((c) => { state.chats[c].model = 'not-installed:1b'; }, id);
    await submit(laptop, typed);
    await waitFor('the text back in the box', async () => (await box(laptop)) === typed, 5000);
    await toastSays(laptop, "wasn't sent");
    await home.page.evaluate(([c, m]) => { state.chats[c].model = m; }, [id, installedModel]);
    assert.equal(await home.page.evaluate((c) => state.chats[c].messages.length, id), 0);

    // No answer at all, for 15 seconds. The home PC here ignores the frame.
    await home.page.evaluate(() => {
      window.__realHandle = window.handleRemoteAction;
      window.handleRemoteAction = () => {};
    });
    const asked = Date.now();
    await submit(laptop, typed);
    assert.equal(await box(laptop), '');
    await sleep(14000 - (Date.now() - asked));
    assert.equal(await box(laptop), '', 'not before 15 seconds');
    await waitFor('the text back in the box', async () => (await box(laptop)) === typed, 3000);
    await toastSays(laptop, 'yet. Your message may still arrive.');
    assert.ok(!(await toastsOn(laptop)).some((text) => text.includes("wasn't sent")), "it can't say that for sure");
    await home.page.evaluate(() => {
      window.handleRemoteAction = window.__realHandle;
    });
    await setBox(laptop, '');

    // Typed more in the meantime: neither is lost.
    await home.page.evaluate(() => { window.handleRemoteAction = (d, frame) => setTimeout(() => window.api.remote.send(d, { type: 'action-result', id: frame.id, ok: false, error: 'No thanks' }), 400); });
    await submit(laptop, 'first');
    await setBox(laptop, 'second');
    await waitFor('both in the box', async () => {
      const text = await box(laptop);
      return text.includes('first') && text.includes('second');
    }, 5000);
    await setBox(laptop, '');

    // A different chat open when the answer comes: it waits in the chat it belongs to.
    await waitFor('the last toast to go', async () => (await toastsOn(laptop)).length === 0, 6000);
    await submit(laptop, 'for the failures chat');
    await laptop.page.evaluate(() => createChat());
    await toastSays(laptop, "wasn't sent");
    assert.equal(await box(laptop), '');
    await openChat(laptop, rid(id));
    assert.equal(await box(laptop), 'for the failures chat');
    await home.page.evaluate(() => { window.handleRemoteAction = window.__realHandle; });
    await setBox(laptop, '');

    // Refused before it goes: an idle lock.
    await laptop.remote('lock');
    await waitFor('idle lock', async () => (await laptop.remote('status')).idleLocked === true, 3000);
    assert.equal((await laptop.page.evaluate((key) => actionToHome(key, 'c', 'stop'), homeId)).ok, false);
    assert.deepEqual(await laptop.remote('unlock', PIN), { ok: true });
    await waitFor('back', () => laptop.page.evaluate((key) => Boolean(state.chats[key]), rid(id)), 3000);
    await openOn(laptop, id);

    // Offline: nothing goes, the box says why, and the text stays.
    await setBox(laptop, typed);
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('the laptop to show offline', async () => (await offlineMark(laptop)) === '1', 10000);
    const placeholder = await laptop.page.evaluate(() => document.querySelector('#composer-input').placeholder);
    assert.match(placeholder, /offline/i);
    await laptop.page.evaluate(() => document.querySelector('#composer-form').requestSubmit());
    await toastSays(laptop, 'offline');
    assert.equal(await box(laptop), typed);
    await setBox(laptop, '');
    assert.equal((await laptop.page.evaluate((key) => actionToHome(key, 'c', 'stop'), homeId)).ok, false);
    assert.deepEqual(await laptop.remote('setAddress', trio.relay.address), { ok: true });
    await waitFor('the laptop to be back', async () => (await laptop.entry()).connected === true, 20000);
    await waitFor('the mark to go', async () => (await offlineMark(laptop)) === null, 5000);
    assert.doesNotMatch(await laptop.page.evaluate(() => document.querySelector('#composer-input').placeholder), /offline/i);
  });

  await t.test("the laptop's model picker shows the home PC's models, not its own", async () => {
    const id = await shared({ title: 'Picker' });
    const hostile = '<img src=x onerror="window.__picked=1">';
    ollama.models.push(hostile);
    await home.page.evaluate(() => refreshOllama());
    await openOn(laptop, id);
    await laptop.page.evaluate(() => {
      state.installed.add('laptop-only:7b');
      populateModelPicker();
    });
    const menuOn = () => laptop.page.evaluate(() => ({
      values: [...document.querySelectorAll('#cs-menu .cs-item[data-value]')].map((el) => el.dataset.value),
      badges: [...document.querySelectorAll('#cs-menu .cs-item-badge')].map((el) => el.textContent),
      installs: document.querySelectorAll('#cs-menu [data-action]').length,
      images: document.querySelectorAll('#cs-menu img').length,
      text: document.querySelector('#cs-menu').textContent
    }));
    const menu = await waitFor('the hostile model to reach the picker', async () => {
      const seen = await menuOn();
      return seen.values.some((v) => v.startsWith('<img')) ? seen : null;
    }, 6000);
    assert.ok(menu.values.includes(MODEL));
    assert.ok(menu.values.includes(SECOND_MODEL));
    assert.ok(!menu.values.includes('laptop-only:7b'), 'not its own');
    assert.equal(menu.installs, 0, 'nothing here can install or uninstall');
    assert.equal(menu.images, 0, 'a name is only text');
    assert.equal(await laptop.page.evaluate(() => window.__picked), undefined);
    // Only the cloud models the home PC has a key for, and the key stayed there.
    assert.ok(menu.badges.includes('cloud · ready'));
    assert.ok(!menu.badges.includes('cloud · API key needed'));
    const cloud = await laptop.page.evaluate(() => allPicks().filter((p) => pickProvider(p) !== 'ollama').map((p) => [p.provider, p.tag || p.model_id || p.id]));
    for (const [provider, value] of cloud) {
      assert.equal(menu.values.includes(value), provider === 'anthropic', value);
    }
    assert.ok(!JSON.stringify(await laptop.mirrorFrames()).includes(KEY));

    // Its own come back on its own chats.
    await laptop.page.evaluate(() => { createChat(); populateModelPicker(); });
    const local = await menuOn();
    assert.ok(local.values.includes('laptop-only:7b'));
    assert.ok(!local.values.includes(SECOND_MODEL));
    await laptop.page.evaluate(() => { state.installed.delete('laptop-only:7b'); });
    ollama.models.pop();
    await home.page.evaluate(() => refreshOllama());
  });

  await t.test('attachments go in frames, as if attached at home, and only what fits', async () => {
    const id = await shared({ title: 'Attachments' });
    await openChat(home, id);
    await openOn(laptop, id);

    const attach = (file) => laptop.page.evaluate(async (p) => addPendingAttachment(await window.api.files.fromPath(p)), file);
    const pending = () => laptop.page.evaluate(() => state.pendingAttachments.length);

    // A text file arrives as its contents, with no sign of where it came from.
    const secretDir = fs.mkdtempSync(path.join(folder, 'WHERE-IT-LIVES-'));
    const notes = path.join(secretDir, 'notes.txt');
    fs.writeFileSync(notes, 'contents of the notes');
    assert.equal(await attach(notes), true);
    assert.equal(await laptop.page.evaluate(() => document.querySelector('#attach-file').hidden), false);
    await submit(laptop, 'Read this');
    const withFile = await ollama.next();
    const sentText = withFile.body.messages.at(-1).content;
    assert.ok(sentText.includes('contents of the notes'));
    assert.ok(sentText.includes('notes.txt'));
    assert.ok(!JSON.stringify(withFile.body).includes('WHERE-IT-LIVES'));
    assert.equal(await pending(), 0);
    assert.ok(!(await home.page.evaluate(() => JSON.stringify(state.chats))).includes('WHERE-IT-LIVES'));
    await threadsMatch(onLaptop, 'the attachment chip', 'notes.txt');
    withFile.say('Read it.');
    withFile.finish();
    await stopButtonsAre(onLaptop, false, 'after the file');

    // A hostile path is dropped, and what it names is never opened.
    const elsewhere = path.join(folder, 'must-not-be-read.txt');
    fs.writeFileSync(elsewhere, 'MUST-NOT-BE-READ');
    const withPath = await ask(laptop, 'send', id, { text: 'Named a path', attachments: [{ kind: 'file', name: 'x.zip', ext: 'zip', size: 1, path: elsewhere }] });
    assert.equal(withPath.ok, true);
    const pathed = await ollama.next();
    assert.ok(!JSON.stringify(pathed.body).includes('must-not-be-read'));
    assert.ok(!JSON.stringify(pathed.body).includes('MUST-NOT-BE-READ'));
    assert.ok(!pathed.body.messages.at(-1).content.includes('undefined'));
    assert.ok(!(await home.page.evaluate((c) => JSON.stringify(state.chats[c]), id)).includes('must-not-be-read'));
    pathed.finish();
    await stopButtonsAre(onLaptop, false, 'after the path');

    // A video, in the exact words, on both ends.
    const video = path.join(folder, 'clip.mp4');
    fs.writeFileSync(video, 'not really a video');
    await setBox(laptop, 'Look at this');
    assert.equal(await attach(video), false);
    assert.equal(await pending(), 0);
    await toastSays(laptop, VIDEO_REFUSED);
    await laptop.page.evaluate(() => { state.pendingAttachments.push({ kind: 'video', name: 'clip.mp4', path: 'x', size: 1 }); });
    await laptop.page.evaluate(() => document.querySelector('#composer-form').requestSubmit());
    await sleep(300);
    assert.equal(await box(laptop), 'Look at this', 'refused before sending, and the text stays');
    assert.equal(await pending(), 1);
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
    const refusedVideo = await ask(laptop, 'send', id, { text: 'x', attachments: [{ kind: 'video', name: 'clip.mp4', path: video }] });
    assert.equal(refusedVideo.ok, false);
    assert.equal(refusedVideo.error, VIDEO_REFUSED);

    // 30 MiB, from the attach button's path and at send, and at home if it gets that far.
    const big = path.join(folder, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(30 * MIB));
    assert.equal(await attach(big), false);
    assert.equal(await pending(), 0);
    await toastSays(laptop, TOO_LARGE);
    await laptop.page.evaluate((mib) => { state.pendingAttachments.push({ kind: 'image', name: 'big.png', base64: 'A'.repeat(mib * 40), size: mib * 30 }); }, MIB);
    await laptop.page.evaluate(() => document.querySelector('#composer-form').requestSubmit());
    await toastSays(laptop, TOO_LARGE);
    assert.equal(await box(laptop), 'Look at this');
    await laptop.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
    await setBox(laptop, '');
    const refusedBig = await laptop.page.evaluate(async ([home_, chatId, mib, frameId]) => {
      window.api.remote.send(home_, { type: 'action', id: frameId, chatId, kind: 'send', args: { text: 'x', attachments: [{ kind: 'image', name: 'big.png', base64: 'A'.repeat(mib * 40) }] } });
      return frameId;
    }, [homeId, id, MIB, nextId()]);
    const answered = await waitFor('the refusal', () =>
      laptop.page.evaluate((frameId) => window.__frames.find((f) => f.id === frameId) ?? null, refusedBig), 30000);
    assert.equal(answered.ok, false);
    assert.equal(answered.error, TOO_LARGE);

    // Close to the limit goes through, in frames, and reaches the model whole.
    await home.page.evaluate((m) => {
      state.catalog.categories.chat.picks.push({ tag: m, name: 'Fake vision', multimodal: true });
    }, MODEL);
    const nearLimit = 24 * MIB;
    await laptop.page.evaluate((bytes) => {
      state.pendingAttachments.push({ kind: 'image', name: 'near.png', base64: 'A'.repeat(Math.floor(bytes / 3) * 4), size: bytes, path: 'C:\\never' });
    }, nearLimit);
    await submit(laptop, 'A big picture');
    const pictured = await ollama.next();
    assert.equal(pictured.body.messages.at(-1).images[0].length, Math.floor(nearLimit / 3) * 4);
    pictured.finish();
    await stopButtonsAre(onLaptop, false, 'after the picture');
    await threadsMatch(onLaptop, 'the picture chip', 'near.png');
    await home.page.evaluate((m) => {
      const { picks } = state.catalog.categories.chat;
      picks.splice(picks.findIndex((p) => p.tag === m), 1);
    }, MODEL);
  });

  await t.test("shared chats too big for one frame arrive in parts, and one that can't go is said out loud", async () => {
    const quietHome = () => home.page.evaluate(() => { window.saveToStorage = () => {}; });
    await quietHome();
    const framesOf = (device) => device.page.evaluate(() => window.__mirrorFrames.filter((f) => f.type === 'mirror-snapshot').map((f) => ({ part: f.part, of: f.of, chats: f.chats.length })));
    const forget = (device) => device.page.evaluate(() => { window.__mirrorFrames.length = 0; });

    const body = (mark, mib) => mark + 'x'.repeat(mib * MIB);
    const one = await shared({ title: 'Large one' });
    const two = await shared({ title: 'Large two' });
    await forget(laptop);
    await forget(laptop2);
    await home.page.evaluate(([a, b, textA, textB]) => {
      state.chats[a].messages.push({ role: 'user', content: textA, attachments: [] });
      state.chats[b].messages.push({ role: 'user', content: textB, attachments: [] });
      markMirrorDirty();
    }, [one, two, body('AAA', 12), body('BBB', 12)]);
    const has = (device, chatId, mark, mib) => device.page.evaluate(([key, m, want]) => {
      const text = state.chats[key]?.messages.at(-1)?.content;
      return !!text && text.startsWith(m) && text.length === want;
    }, [rid(chatId), mark, mark.length + mib * MIB]);
    await waitFor('the laptop to have both', async () => (await has(laptop, one, 'AAA', 12)) && (await has(laptop, two, 'BBB', 12)), 30000);

    // Now a fresh look: all of it together is more than one frame can hold.
    await home.page.evaluate(([a, b, textA, textB]) => {
      state.chats[a].messages.push({ role: 'user', content: textA, attachments: [] });
      state.chats[b].messages.push({ role: 'user', content: textB, attachments: [] });
      markMirrorDirty();
    }, [one, two, body('CCC', 14), body('DDD', 14)]);
    await waitFor('the laptop to have the rest', async () => (await has(laptop, one, 'CCC', 14)) && (await has(laptop, two, 'DDD', 14)), 30000);
    await forget(laptop);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('a snapshot in parts', async () => {
      const parts = await framesOf(laptop);
      const of = parts.at(-1)?.of;
      return of > 1 && parts.filter((p) => p.part).length >= of;
    }, 30000);
    const parts = (await framesOf(laptop)).filter((p) => p.part);
    assert.deepEqual(parts.map((p) => p.part), parts.map((_, i) => i + 1));
    assert.ok(parts.every((p) => p.of === parts.length && p.chats === 1));
    await sleep(500);
    assert.equal(await has(laptop, one, 'CCC', 14), true, 'nothing went missing between the parts');
    assert.equal(await has(laptop, two, 'DDD', 14), true);
    assert.equal(await hasChat(laptop, rid(one)), true);

    // One chat by itself can't fit in any frame. Everything else is still fine.
    const small = await shared({ title: 'Small and fine' });
    await home.page.evaluate(([a, text]) => {
      state.chats[a].messages.push({ role: 'user', content: text, attachments: [] });
      markMirrorDirty(a);
    }, [one, body('EEE', 49)]);
    await toastSays(laptop, 'too large to show', 40000);
    await waitFor('the too-large chat to leave', async () => !(await hasChat(laptop, rid(one))), 40000);
    assert.equal(await hasChat(laptop, rid(small)), true);
    assert.equal(await hasChat(laptop, rid(two)), true);
    await home.page.evaluate(([a, b]) => {
      deleteChat(a);
      deleteChat(b);
    }, [one, two]);
    await waitFor('the snapshot traffic to settle', async () => hasChat(laptop, rid(small)), 5000);
    await home.page.evaluate((c) => deleteChat(c), small);
    await waitFor('it to go', async () => !(await hasChat(laptop, rid(small))), 5000);
  });

  await t.test('a chat that grows too large is said out loud to every laptop, and comes back to all of them', async () => {
    await home.page.evaluate(() => { window.saveToStorage = () => {}; });
    const laptopIds = await home.remote('status').then((s) => s.devices.map((d) => d.id));
    assert.equal(laptopIds.length, 2);
    const grower = await shared({ title: 'Grower' });
    await openOn(laptop, grower);
    const lengthOn = (device) => device.page.evaluate((key) => state.chats[key]?.messages.length ?? -1, rid(grower));
    // Small enough each time that every step goes through as ordinary ops, to both laptops.
    for (let i = 1; i <= 5; i++) {
      await home.page.evaluate(([c, text]) => {
        state.chats[c].messages.push({ role: 'user', content: text, attachments: [] });
        markMirrorDirty(c);
      }, [grower, 'g'.repeat(10 * MIB)]);
      await waitFor(`step ${i} on both`, async () => (await lengthOn(laptop)) === i && (await lengthOn(laptop2)) === i, 30000);
    }
    await home.page.evaluate((c) => {
      state.runningChats.set(c, { channelId: null, abortRequested: false });
      markMirrorDirty(c);
    }, grower);
    await waitFor('Stop on the first laptop', () => stopShowingOn(laptop), 5000);

    // The other laptop asks for a snapshot, and only that shows the chat has outgrown a frame.
    await laptop.page.evaluate(() => { document.querySelector('#toast-host')?.replaceChildren(); });
    assert.equal(await laptop2.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await toastSays(laptop, 'too large to show', 20000);
    await toastSays(laptop2, 'too large to show', 20000);
    await waitFor('it to leave the first laptop', async () => (await lengthOn(laptop)) === -1, 20000);
    await waitFor('it to leave the second', async () => (await lengthOn(laptop2)) === -1, 20000);
    assert.equal(await stopShowingOn(laptop), false, "a Stop button can't stick on a chat that's gone");

    // It shrinks, the next snapshot sees it, and everyone gets it back with no hole in it.
    await home.page.evaluate((c) => {
      state.runningChats.delete(c);
      state.chats[c].messages.length = 1;
      state.chats[c].messages.push({ role: 'user', content: 'After it shrank', attachments: [] });
      markMirrorDirty(c);
    }, grower);
    await sleep(1200);
    assert.equal(await laptop2.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('it back on the first laptop', async () => (await lengthOn(laptop)) === 2, 30000);
    await waitFor('it back on the second', async () => (await lengthOn(laptop2)) === 2, 30000);
    await home.page.evaluate((c) => {
      state.chats[c].messages.push({ role: 'user', content: 'Ops flow again', attachments: [] });
      markMirrorDirty(c);
    }, grower);
    await lastMessageIs(laptop, rid(grower), 'Ops flow again');
    await lastMessageIs(laptop2, rid(grower), 'Ops flow again');
    await home.page.evaluate((c) => deleteChat(c), grower);
    await waitFor('it to go', async () => (await lengthOn(laptop)) === -1 && (await lengthOn(laptop2)) === -1, 5000);
  });

  await t.test('a snapshot over 64 MiB arrives whole, at the pace of the laptop, with the session up throughout', async () => {
    await home.page.evaluate(() => { window.saveToStorage = () => {}; });
    const forget = (device) => device.page.evaluate(() => { window.__mirrorFrames.length = 0; });
    const chats = [];
    for (let i = 0; i < 3; i++) {
      const id = await shared({ title: `Huge ${i}` });
      chats.push(id);
      await home.page.evaluate(([c, text]) => {
        state.chats[c].messages.push({ role: 'user', content: text, attachments: [] });
        markMirrorDirty(c);
      }, [id, `H${i}` + 'h'.repeat(24 * MIB)]);
      await waitFor(`huge chat ${i}`, async () => laptop.page.evaluate(([key, want]) => state.chats[key]?.messages[0]?.content?.length === want, [rid(id), 2 + 24 * MIB]), 60000);
      await waitFor(`huge chat ${i} on the other`, async () => laptop2.page.evaluate(([key, want]) => state.chats[key]?.messages[0]?.content?.length === want, [rid(id), 2 + 24 * MIB]), 60000);
    }

    const whole = (device) => device.page.evaluate(([ids, want]) => ids.every((key) => state.chats[key]?.messages[0]?.content?.length === want), [chats.map(rid), 2 + 24 * MIB]);
    const partsOf = (device) => device.page.evaluate(() => window.__mirrorFrames.filter((f) => f.type === 'mirror-snapshot' && f.part).map((f) => ({ part: f.part, of: f.of, seq: f.seq })));
    const quietFor = async (device, ms) => {
      await device.page.evaluate(() => { window.__statuses.length = 0; });
      await sleep(ms);
    };

    await forget(laptop);
    await quietFor(laptop, 1200);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    // Something happens to a chat during the transfer. It has to wait, and arrive after.
    await waitFor('the first part', async () => (await partsOf(laptop)).length >= 1, 60000);
    await home.page.evaluate((c) => {
      state.chats[c].messages.push({ role: 'user', content: 'Said during the snapshot', attachments: [] });
      markMirrorDirty(c);
    }, chats[0]);
    await waitFor('every part', async () => {
      const parts = await partsOf(laptop);
      return parts.length >= 3 && parts.length === parts[0].of;
    }, 120000);
    const parts = await partsOf(laptop);
    assert.deepEqual(parts.map((p) => p.part), parts.map((_, i) => i + 1));
    assert.ok(parts.every((p, i) => i === 0 || p.seq === parts[i - 1].seq + 1), 'no gap between the parts');
    await lastMessageIs(laptop, rid(chats[0]), 'Said during the snapshot');
    assert.equal(await whole(laptop), true);
    await home.page.evaluate(([c]) => {
      state.chats[c].messages.length = 1;
      markMirrorDirty(c);
    }, [chats[0]]);
    const gone = await laptop.page.evaluate(() => window.__statuses.filter((s) => s.devices?.some((d) => d.connected === false)).length);
    assert.equal(gone, 0, 'the session stayed up');
    assert.equal(await laptop.page.evaluate((h) => mirror.homes.get(h).awaitingSnapshot, homeId), false);
    const acked = await home.page.evaluate(() => window.__mirrorFrames.filter((f) => f.type === 'mirror-part-ack').length);
    assert.ok(acked >= parts.length, 'the laptop acknowledged each part');
    await waitFor('home to finish', () => home.page.evaluate(() => [...mirror.laptops.values()].every((l) => !l.paced)), 5000);

    // The laptop going away mid-transfer stops it, and coming back gets all of it.
    await forget(laptop);
    await sleep(1200);
    assert.equal(await laptop.remote('send', homeId, { type: 'mirror-resync-request' }), true);
    await waitFor('the first part again', async () => (await partsOf(laptop)).length >= 1, 60000);
    assert.deepEqual(await laptop.remote('setAddress', 'ws://127.0.0.1:9/nowhere-at-all'), { ok: true });
    await waitFor('the laptop to be offline', async () => (await laptop.entry()).connected === false, 15000);
    assert.deepEqual(await laptop.remote('setAddress', trio.relay.address), { ok: true });
    await waitFor('the laptop to be back', async () => (await laptop.entry()).connected === true, 30000);
    await waitFor('whole again', async () => (await whole(laptop)) && !(await laptop.page.evaluate((h) => mirror.homes.get(h).awaitingSnapshot, homeId)), 120000);

    await home.page.evaluate((ids) => { for (const c of ids) deleteChat(c); }, chats);
    await waitFor('them to go', async () => !(await hasChat(laptop, rid(chats[0]))), 15000);
  });
});

test("Sanctum's own data folder is closed to the agent's file tools, wherever they start from", async (t) => {
  const ollama = await startScriptedOllama();
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-tree-'));
  const profile = path.join(tree, 'nested', 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const device = await launchDevice('profile', { ollamaUrl: ollama.url, profile });
  t.after(async () => {
    await device.stop();
    await ollama.stop();
    fs.rmSync(tree, { recursive: true, force: true });
  });
  await started(device);
  const canary = 'TOOLS-CANARY-WORDS';
  fs.writeFileSync(path.join(profile, 'in-the-profile.txt'), canary);
  fs.writeFileSync(path.join(tree, 'nested', 'beside.txt'), canary);
  const inside = path.join(profile, 'in-the-profile.txt');
  const allow = [tree];

  const results = await device.page.evaluate(async ([file, dir, root, allowed]) => ({
    read: await window.api.fs.readFile(file, allowed),
    list: await window.api.fs.listDir(dir, allowed),
    upper: await window.api.fs.readFile(file.toUpperCase(), allowed),
    dots: await window.api.fs.readFile(`${dir}\\..\\profile\\in-the-profile.txt`, allowed),
    glob: await window.api.fs.glob('**/*.txt', root, allowed),
    globInside: await window.api.fs.glob('*', dir, allowed),
    grep: await window.api.fs.grep('TOOLS-CANARY', root, { allowlist: allowed }),
    grepInside: await window.api.fs.grep('TOOLS-CANARY', dir, { allowlist: allowed }),
    patch: await window.api.fs.applyPatch(file, 'TOOLS', 'x', allowed),
    // Outside the allowlist is refused the same way, and doesn't offer a pop-up to widen it.
    unlisted: await window.api.fs.readFile(file, [])
  }), [inside, profile, tree, allow]);

  for (const key of ['read', 'list', 'globInside', 'grepInside', 'patch', 'unlisted']) {
    assert.match(results[key].error ?? '', /Sanctum's own data/, key);
    assert.doesNotMatch(results[key].error, /outside (the )?allowed roots/, key);
  }
  if (process.platform === 'win32') {
    assert.match(results.upper.error ?? '', /Sanctum's own data/);
    assert.match(results.dots.error ?? '', /Sanctum's own data/);
  }
  assert.equal(fs.readFileSync(inside, 'utf8'), canary, 'and nothing changed');
  // From above it, a search finds what's beside it and nothing in it.
  assert.deepEqual(results.glob.matches.sort(), ['nested/beside.txt']);
  assert.deepEqual(results.grep.matches.map((m) => m.file), ['nested/beside.txt']);
  // The list of a parent names the folder, as any listing would, and nothing in it.
  const parent = await device.page.evaluate(async ([dir, allowed]) => window.api.fs.listDir(dir, allowed), [path.join(tree, 'nested'), allow]);
  assert.deepEqual(parent.entries.map((e) => e.name).sort(), ['beside.txt', 'profile']);
});

test('parts of a snapshot from a hostile home change nothing they should not', async (t) => {
  const ollama = await startScriptedOllama();
  const device = await launchDevice('parts', { ollamaUrl: ollama.url });
  t.after(async () => {
    await device.stop();
    await ollama.stop();
  });
  const { page } = device;
  await started(device);
  const result = await page.evaluate(() => {
    const HOME = 'fuzz-home';
    window.__status = { devices: [{ id: HOME, role: 'home', connected: true }], locked: false, idleLocked: false };
    mirrorOnStatus(window.__status);
    const chat = (id) => ({ id, title: id, messages: [] });
    const has = (id) => Boolean(state.chats[`remote:${HOME}:${id}`]);
    const out = {};
    let seq = 0;
    const snap = (extra) => mirrorOnFrame(HOME, { type: 'mirror-snapshot', seq: ++seq, now: Date.now(), home: {}, ...extra });
    snap({ chats: [chat('a'), chat('b')] });
    out.whole = has('a') && has('b');
    // A chat only leaves when the last part has said it isn't coming.
    snap({ part: 1, of: 2, chats: [chat('a')] });
    out.partOneKeepsB = has('a') && has('b');
    snap({ part: 2, of: 2, chats: [chat('c')] });
    out.lastPartDropsB = has('a') && !has('b') && has('c');
    // Out of order, or nonsense: asks again and drops nothing.
    snap({ part: 2, of: 2, chats: [] });
    out.outOfOrder = has('a') && has('c');
    for (const [part, of] of [[0, 2], [3, 2], [1, 0], [-1, 1], [1.5, 2], ['1', '2'], [null, 2], [1, null], [1, 1e9]]) {
      snap({ part, of, chats: [] });
    }
    out.nonsense = has('a') && has('c');
    // A hostile answer to nothing.
    mirrorOnFrame(HOME, { type: 'action-result', id: 'nobody-asked', ok: true });
    mirrorOnFrame(HOME, { type: 'action-result', id: { evil: 1 }, ok: true });
    mirrorOnFrame(HOME, { type: 'queued-returned', id: 'w1', chatId: 'a', text: 7 });
    mirrorOnFrame(HOME, { type: 'queued-returned', id: 'w2', chatId: 7, text: 'no chat id' });
    mirrorOnFrame(HOME, { type: 'queued-returned', chatId: 'a', text: 'no id' });
    mirrorOnFrame(HOME, { type: 'queued-returned', id: { evil: 1 }, chatId: 'a', text: 'bad id' });
    mirrorOnFrame(HOME, { type: 'queued-returned-ack', id: 'w1' });
    mirrorOnFrame(HOME, { type: 'mirror-part-ack', part: 1, transfer: 1 });
    mirrorOnFrame('someone-else', { type: 'queued-returned', id: 'w3', chatId: 'a', text: 'from a stranger' });
    mirrorOnFrame('someone-else', { type: 'mirror-too-large' });
    out.box = document.querySelector('#composer-input').value;
    // An action from a device that isn't a laptop of this one.
    const before = state.chats[`remote:${HOME}:a`].title;
    mirrorOnFrame(HOME, { type: 'action', id: 'x', chatId: `remote:${HOME}:a`, kind: 'rename', args: { title: 'Taken' } });
    mirrorOnFrame('someone-else', { type: 'action', id: 'x', chatId: `remote:${HOME}:a`, kind: 'rename', args: { title: 'Taken' } });
    out.title = state.chats[`remote:${HOME}:a`].title === before;
    // Words for a chat that has gone end up in the box, with the notice. There's nowhere else.
    mirrorOnFrame(HOME, { type: 'queued-returned', id: 'w4', chatId: 'gone-now', text: 'words for a gone chat' });
    out.orphan = document.querySelector('#composer-input').value;
    out.notice = !document.querySelector('#remote-gone').hidden;
    // Sent again until acknowledged, so a second copy changes nothing.
    mirrorOnFrame(HOME, { type: 'queued-returned', id: 'w4', chatId: 'gone-now', text: 'words for a gone chat' });
    out.once = document.querySelector('#composer-input').value;
    return out;
  });
  assert.deepEqual(result, { whole: true, partOneKeepsB: true, lastPartDropsB: true, outOfOrder: true, nonsense: true, box: '', title: true, orphan: 'words for a gone chat', notice: true, once: 'words for a gone chat' });
});
