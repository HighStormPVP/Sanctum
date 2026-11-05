// Approval, plan, and access pop-ups on every connected device, for real: Electron instances, the
// real chat loop at home, the real relay Worker in Miniflare, and a fake Ollama that says what a
// test tells it to. Commands only ever run in temp folders made here, so what really happened is
// read from those folders rather than from frames.
//
//   node e2e/approvals.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPair, startScriptedOllama, launchDevice, waitFor, sleep, PIN, MODEL, hasChat, newChat, openChat } = require('./harness.js');

const LAPTOP = 'laptop';
const NOWHERE = 'ws://127.0.0.1:9/nowhere-at-all';
const KIB = 1024;
const OVERLAY = { approval: '#approval-overlay', plan: '#plan-approval-overlay', path: '#path-expand-overlay' };
const YES = { approval: '#approval-approve', plan: '#plan-approval-approve', path: '#pe-once' };
const NO = { approval: '#approval-deny', plan: '#plan-approval-deny', path: '#pe-deny' };

const started = (device) =>
  waitFor(`${device.name} to finish starting`, () => device.page.evaluate(() => state.order.length > 0 && Boolean(state.catalog)));
const visible = (device, selector) => device.page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return Boolean(el) && !el.hidden && el.getClientRects().length > 0;
}, selector);
const textOf = (device, selector) => device.page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector);
const click = (device, selector) => device.page.evaluate((sel) => document.querySelector(sel).click(), selector);
const framesOf = async (device, type) => (await device.frames()).filter((f) => f.type === type);
const appears = (device, kind, ms = 8000) => waitFor(`${device.name} to show the ${kind} pop-up`, () => visible(device, OVERLAY[kind]), ms);
const closes = (device, kind, ms = 8000) => waitFor(`${device.name} to close the ${kind} pop-up`, async () => !(await visible(device, OVERLAY[kind])), ms);
const toasts = (device) => device.page.evaluate(() => [...document.querySelectorAll('#toast-host .toast')].map((el) => el.textContent));
const clearToasts = (device) => device.page.evaluate(() => document.querySelectorAll('#toast-host .toast').forEach((el) => el.remove()));
const readLog = (device, file) => {
  try {
    return fs.readFileSync(path.join(device.profile, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};
const heldCount = (device) => device.page.evaluate(() => remoteAsks.held.size);
const openAtHome = (device) => device.page.evaluate(() => [...remoteAsks.open.keys()]);
const lastAskId = async (device) => (await framesOf(device, 'ask')).at(-1).id;
const newestCount = async (device, type) => (await framesOf(device, type)).length;

// What's on the pop-up, as a person would read it.
const approvalText = (device) => device.page.evaluate(() => {
  const codes = [...document.querySelectorAll('#approval-body .approval-code')].map((el) => el.textContent);
  return { machine: document.querySelector('#approval-device')?.textContent ?? null, codes, name: document.querySelector('#approval-name').textContent };
});

// Every time a pop-up goes on screen, whatever it said, so "never appeared" can be checked.
const noteWhatShows = (device) => device.page.evaluate(() => {
  window.__shown = [];
  for (const [selector, body] of [['#approval-overlay', '#approval-body'], ['#plan-approval-overlay', '#plan-approval-body'], ['#path-expand-overlay', '#pe-requested-path']]) {
    const overlay = document.querySelector(selector);
    new MutationObserver(() => {
      if (!overlay.hidden) window.__shown.push(document.querySelector(body).textContent);
    }).observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
  }
});
const shown = (device) => device.page.evaluate(() => window.__shown);

test('pop-ups on every device', async (t) => {
  const ollama = await startScriptedOllama();
  const trio = await startPair({ homeOllama: ollama });
  const { home, homeId, laptopId } = trio;
  const laptop = trio.laptop;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanctum-e2e-asks-'));
  const homeDir = path.join(root, 'home');
  const laptopDir = path.join(root, 'laptop');
  const outsideDir = path.join(root, 'outside');
  for (const dir of [homeDir, laptopDir, outsideDir]) fs.mkdirSync(dir);
  const extras = [];
  t.after(async () => {
    for (const device of extras) await device.stop();
    await trio.stop();
    await ollama.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  await started(home);
  await started(laptop);
  await waitFor('the model to show as installed', () => home.page.evaluate((m) => state.installed.has(m), MODEL));
  await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
  const homeName = (await home.remote('status')).name;
  assert.deepEqual(await laptop.remote('setControlAllowed', true), { ok: true });
  const hearsSwitch = (want) => waitFor(`home to hear the switch is ${want}`, () => home.page.evaluate(([id, value]) => (remoteTools.control.get(id)?.allowed === true) === value, [laptopId, want]), 10000);
  await hearsSwitch(true);
  // A long way past any test, so a test that means to use the time says so.
  await home.page.evaluate(() => { remoteTools.askWaitMs = 600000; });

  const baseChat = {
    modality: 'agent', title: 'A project', titleManual: true, webEnabled: false, remoteControl: true,
    planMode: false, approvalMode: true, noApproval: false, readOnly: false, noFetch: false,
    projectFolder: homeDir, pathAllowlist: [homeDir],
    projectFolders: { [laptopId]: laptopDir }, pathAllowlists: { [laptopId]: [laptopDir] }, maxSteps: 40
  };
  const key = (id) => `remote:${homeId}:${id}`;
  const shared = async (fields = {}, on = [laptop]) => {
    const id = await newChat(home, { ...baseChat, ...fields });
    if (fields.remoteControl !== false) {
      for (const device of on) await waitFor(`the chat to reach ${device.name}`, () => hasChat(device, key(id)), 8000);
    }
    return id;
  };
  const go = (id) => home.page.evaluate((chatId) => {
    submitToChat(state.chats[chatId], 'Go', []).catch((e) => console.error(e));
  }, id);
  const stopped = (id) => waitFor('the chat to stop', () => home.page.evaluate((chatId) => !state.runningChats.has(chatId), id), 15000);

  // The model asks for this once, and the returned function is the rest of its turn.
  async function modelCalls(id, name, args, start = go) {
    await start(id);
    const first = await ollama.next();
    first.call([name, args]);
    first.finish();
    return async () => {
      const second = await ollama.next();
      const [result] = second.body.messages.filter((m) => m.role === 'tool').slice(-1).map((m) => JSON.parse(m.content));
      second.say('Done.');
      second.finish();
      await stopped(id);
      return result;
    };
  }
  const startFromLaptop = (id) => laptop.remote('send', homeId, { type: 'action', id: `say-${Date.now()}`, chatId: id, kind: 'send', args: { text: 'Go' } });
  const lineCount = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
  const answer = (from, to, id, value) => from.remote('send', to, { type: 'answer', id, value });
  const auditOf = (id, tool) => readLog(home, 'agent-audit.log').filter((e) => e.chat === id && e.tool === tool && e.summary !== undefined).at(-1);
  const disconnect = async () => {
    assert.deepEqual(await laptop.remote('setAddress', NOWHERE), { ok: true });
    await waitFor('home to see the laptop go', async () => !(await home.entry(laptopId)).connected, 10000);
  };
  const reconnect = async () => {
    assert.deepEqual(await laptop.remote('setAddress', trio.relay.address), { ok: true });
    await waitFor('the laptop to reconnect', async () => (await laptop.entry(homeId))?.connected && (await home.entry(laptopId))?.connected, 30000);
    await hearsSwitch(true);
  };

  // ---- The brief's list ----

  await t.test('the pop-up appears on both, showing the same command and the target machine', async (s) => {
    await s.test('a command for the laptop', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo there >> same.txt', device: LAPTOP });
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      const atHome = await approvalText(home);
      const there = await approvalText(laptop);
      assert.deepEqual(there, atHome);
      assert.equal(there.machine, LAPTOP);
      assert.deepEqual(there.codes, [LAPTOP, 'echo there >> same.txt', laptopDir], 'the folder it will really run in, not "(home directory)"');
      assert.ok((await textOf(laptop, '#approval-desc')).includes(`on ${LAPTOP}`));
      assert.ok((await textOf(laptop, '#approval-desc')).includes('A project'), 'and which chat is asking');
      const frame = (await framesOf(laptop, 'ask')).at(-1);
      assert.deepEqual(Object.keys(frame).sort(), ['args', 'chatId', 'device', 'id', 'kind', 'tool', 'type']);
      assert.equal(frame.kind, 'approval');
      assert.equal(frame.chatId, id);
      assert.equal(frame.tool, 'run_command');
      assert.equal(frame.device, LAPTOP);
      assert.match(frame.id, /^[0-9a-f-]{36}$/, 'from crypto.randomUUID');
      await click(laptop, NO.approval);
      await closes(home, 'approval');
      assert.match((await finish()).error, /denied/);
    });

    await s.test('a command for the home PC names the home PC, on both, even with the switch off', async () => {
      assert.deepEqual(await laptop.remote('setControlAllowed', false), { ok: true });
      await hearsSwitch(false);
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo here >> same.txt' });
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      assert.equal((await approvalText(home)).machine, homeName);
      assert.deepEqual(await approvalText(laptop), await approvalText(home));
      assert.ok(!(await textOf(laptop, '#approval-desc')).includes('your machine'), 'a laptop has no business saying "your machine" of another');
      await click(home, NO.approval);
      await closes(laptop, 'approval');
      await finish();
      assert.deepEqual(await laptop.remote('setControlAllowed', true), { ok: true });
      await hearsSwitch(true);
    });
  });

  await t.test('answering on the laptop closes it at home, the tool runs once, and the log says who', async () => {
    const id = await shared();
    const file = path.join(laptopDir, 'once-from-laptop.txt');
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> once-from-laptop.txt', device: LAPTOP });
    await appears(home, 'approval');
    await appears(laptop, 'approval');
    const callsBefore = await newestCount(laptop, 'tool-call');
    await click(laptop, YES.approval);
    await closes(laptop, 'approval');
    await closes(home, 'approval');
    assert.ok((await toasts(home)).some((text) => text.includes(LAPTOP)), 'the person at home is told where it went');
    assert.equal((await finish()).exitCode, 0);
    assert.equal(lineCount(file), 1);
    assert.equal(await newestCount(laptop, 'tool-call'), callsBefore + 1);
    const closed = await waitFor('the laptop to hear it closed', async () => (await framesOf(laptop, 'ask-closed')).at(-1), 5000);
    assert.equal(closed.value, true, 'the device that answered is told too');
    assert.deepEqual(await openAtHome(home), []);
    assert.equal(await heldCount(laptop), 0);
    const log = auditOf(id, 'run_command');
    assert.deepEqual(log.answeredBy, [{ kind: 'approval', name: LAPTOP, device: laptopId }]);
  });

  await t.test('answering at home closes it on the laptop, the tool runs once, and the log says who', async () => {
    const id = await shared();
    const file = path.join(homeDir, 'once-from-home.txt');
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> once-from-home.txt' });
    await appears(home, 'approval');
    await appears(laptop, 'approval');
    const closedBefore = await newestCount(laptop, 'ask-closed');
    await clearToasts(laptop);
    await click(home, YES.approval);
    await closes(laptop, 'approval');
    assert.equal((await finish()).exitCode, 0);
    assert.equal(lineCount(file), 1);
    assert.equal((await framesOf(laptop, 'ask-closed')).length, closedBefore + 1);
    assert.ok((await toasts(laptop)).some((text) => /another device/.test(text)), 'a pop-up someone was reading doesn\'t just vanish');
    assert.deepEqual(auditOf(id, 'run_command').answeredBy, [{ kind: 'approval', name: 'home' }]);
  });

  await t.test('two answers racing resolve to whichever reaches home first, and the other is ignored', async (s) => {
    const raceInOneTick = async (fileName, first) => {
      const id = await shared();
      const file = path.join(homeDir, fileName);
      const finish = await modelCalls(id, 'run_command', { command: `echo x >> ${fileName}` });
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      const askId = await lastAskId(laptop);
      await home.page.evaluate(([laptopDevice, ask, order]) => {
        const fromLaptop = (value) => mirrorOnFrame(laptopDevice, { type: 'answer', id: ask, value });
        if (order === 'laptop-yes-first') {
          fromLaptop(true);
          document.querySelector('#approval-deny').click();
        } else {
          document.querySelector('#approval-deny').click();
          fromLaptop(true);
        }
      }, [laptopId, askId, first]);
      const result = await finish();
      await sleep(300);
      return { result, runs: lineCount(file), by: auditOf(id, 'run_command').answeredBy };
    };

    await s.test('the laptop first', async () => {
      const { result, runs, by } = await raceInOneTick('race-a.txt', 'laptop-yes-first');
      assert.equal(result.exitCode, 0);
      assert.equal(runs, 1);
      assert.equal(by[0].name, LAPTOP);
    });

    await s.test('home first', async () => {
      const { result, runs, by } = await raceInOneTick('race-b.txt', 'home-no-first');
      assert.match(result.error, /denied/);
      assert.equal(runs, 0);
      assert.equal(by[0].name, 'home');
    });
  });

  await t.test('a laptop that connects, reconnects, or reloads while a pop-up is open gets it', async (s) => {
    await s.test('reconnecting: it closes while away, comes back, and its answer counts', async () => {
      const id = await shared();
      const file = path.join(laptopDir, 'reconnected.txt');
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> reconnected.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      const askId = await lastAskId(laptop);
      await clearToasts(laptop);
      await disconnect();
      await closes(laptop, 'approval');
      assert.equal(await heldCount(laptop), 0, 'an answer couldn\'t land, so it isn\'t kept');
      assert.ok((await toasts(laptop)).some((text) => /question/.test(text) && text.includes(homeName)), 'and it says why');
      assert.equal(await visible(home, OVERLAY.approval), true, 'home can still answer');
      await reconnect();
      await appears(laptop, 'approval');
      assert.equal(await lastAskId(laptop), askId, 'the same question');
      assert.equal((await approvalText(laptop)).machine, LAPTOP);
      await click(laptop, YES.approval);
      await closes(home, 'approval');
      assert.equal((await finish()).exitCode, 0);
      assert.equal(lineCount(file), 1);
    });

    await s.test('reloading the laptop page', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> reloaded.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      const askId = await lastAskId(laptop);
      await laptop.page.evaluate(() => location.reload());
      await waitFor('the page to come back', () => laptop.page.evaluate(() => typeof remoteAsks === 'object' && Boolean(window.api?.remote)).catch(() => false), 20000);
      await laptop.record();
      await appears(laptop, 'approval', 15000);
      assert.equal(await home.page.evaluate((ask) => remoteAsks.open.has(ask), askId), true);
      assert.equal((await approvalText(laptop)).codes[1], 'echo x >> reloaded.txt');
      await click(laptop, NO.approval);
      await closes(home, 'approval');
      await finish();
      await started(laptop);
    });

    await s.test('a new laptop connecting, and two at once, the first answer closing the other', async () => {
      const id = await shared();
      const file = path.join(homeDir, 'two-laptops.txt');
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> two-laptops.txt' });
      await appears(laptop, 'approval');

      const second = await launchDevice('second', { ollamaUrl: trio.ollama.url });
      extras.push(second);
      await started(second);
      assert.deepEqual(await second.remote('setAddress', trio.relay.address), { ok: true });
      const { code } = await home.remote('createCode');
      await waitFor('the pairing', async () => {
        const res = await second.remote('pair', code, 'second', PIN);
        if (!res.ok && !/cancelled/.test(res.error)) assert.fail(res.error);
        return res.ok;
      }, 15000);
      const secondId = await waitFor('it to connect', async () => (await home.remote('status')).devices.find((d) => d.id !== laptopId && d.connected)?.id, 15000);
      await appears(second, 'approval', 15000);
      assert.deepEqual(await approvalText(second), await approvalText(laptop));

      await click(second, YES.approval);
      await closes(laptop, 'approval');
      await closes(home, 'approval');
      assert.equal((await finish()).exitCode, 0);
      assert.equal(lineCount(file), 1);
      assert.equal(auditOf(id, 'run_command').answeredBy[0].device, secondId);

      // Real answers from two laptops, as close together as they can be sent.
      const raced = await shared({}, [laptop, second]);
      const racedFile = path.join(homeDir, 'two-race.txt');
      const finishRace = await modelCalls(raced, 'run_command', { command: 'echo x >> two-race.txt' });
      await appears(laptop, 'approval');
      await appears(second, 'approval');
      const askId = await lastAskId(laptop);
      await Promise.all([answer(laptop, homeId, askId, true), answer(second, (await second.entry()).id, askId, false)]);
      const result = await finishRace();
      await sleep(300);
      const winner = auditOf(raced, 'run_command').answeredBy;
      assert.equal(winner.length, 1, 'one answer, whichever it was');
      if (winner[0].device === laptopId) {
        assert.equal(result.exitCode, 0);
        assert.equal(lineCount(racedFile), 1);
      } else {
        assert.equal(winner[0].device, secondId);
        assert.match(result.error, /denied/);
        assert.equal(lineCount(racedFile), 0);
      }

      // Removing a device closes its pop-up there.
      const third = await shared({}, [laptop, second]);
      const finishThird = await modelCalls(third, 'run_command', { command: 'echo x >> removed.txt' });
      await appears(second, 'approval');
      await clearToasts(second);
      await home.remote('removeDevice', secondId);
      await closes(second, 'approval');
      assert.equal(await heldCount(second), 0);
      assert.ok((await toasts(second)).some((text) => /no longer paired/.test(text)));
      await click(home, NO.approval);
      await closes(laptop, 'approval');
      await finishThird();
    });
  });

  await t.test('with every laptop offline home can still answer, and with nobody at home a laptop can', async (s) => {
    await s.test('offline', async () => {
      const id = await shared();
      const file = path.join(homeDir, 'laptop-away.txt');
      await disconnect();
      const before = await newestCount(laptop, 'ask');
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> laptop-away.txt' });
      await appears(home, 'approval');
      await click(home, YES.approval);
      assert.equal((await finish()).exitCode, 0);
      assert.equal(lineCount(file), 1);
      await reconnect();
      await sleep(300);
      assert.equal(await newestCount(laptop, 'ask'), before, 'nothing to offer by then');
      assert.equal(await visible(laptop, OVERLAY.approval), false);
    });

    await s.test('nobody at home, and the run started from the laptop, with no timer running out on it', async () => {
      await home.page.evaluate(() => { remoteTools.askWaitMs = 300; });
      const id = await shared();
      const file = path.join(laptopDir, 'nobody-home.txt');
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> nobody-home.txt', device: LAPTOP }, startFromLaptop);
      await appears(laptop, 'approval');
      await sleep(900);
      assert.equal(await visible(laptop, OVERLAY.approval), true, 'the timer doesn\'t run while a laptop can answer');
      await click(laptop, YES.approval);
      assert.equal((await finish()).exitCode, 0);
      assert.equal(lineCount(file), 1);
      await home.page.evaluate(() => { remoteTools.askWaitMs = 600000; });
    });
  });

  await t.test('a chat that isn\'t shared never sends ask, on any path, until it\'s shared', async () => {
    const id = await shared({ remoteControl: false });
    const askBefore = await newestCount(laptop, 'ask');
    const closedBefore = await newestCount(laptop, 'ask-closed');
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> not-shared.txt' });
    await appears(home, 'approval');
    await sleep(500);
    assert.equal(await newestCount(laptop, 'ask'), askBefore);
    assert.equal(await visible(laptop, OVERLAY.approval), false);

    await disconnect();
    await reconnect();
    await sleep(800);
    assert.equal(await newestCount(laptop, 'ask'), askBefore, 'nor when a laptop comes back');

    await home.page.evaluate(() => mirrorOnStatus(state.remoteStatus));
    await sleep(300);
    assert.equal(await newestCount(laptop, 'ask'), askBefore, 'nor when anything else changes');
    // A forged answer can't reach it either, and nothing about it left this machine to forge from.
    const askId = (await openAtHome(home))[0];
    await answer(laptop, homeId, askId, true);
    await sleep(300);
    assert.equal(await visible(home, OVERLAY.approval), true);

    await home.page.evaluate((chatId) => setChatShared(state.chats[chatId], true), id);
    await appears(laptop, 'approval');
    assert.equal(await newestCount(laptop, 'ask'), askBefore + 1, 'shared while open, it goes');
    assert.equal(await lastAskId(laptop), askId);
    await click(laptop, NO.approval);
    await closes(home, 'approval');
    await finish();
    assert.equal(await newestCount(laptop, 'ask-closed'), closedBefore + 1);
  });

  // ---- Who can answer ----

  await t.test('a forged answer can\'t run anything', async (s) => {
    const forgedFile = path.join(laptopDir, 'forged.txt');
    const id = await shared();
    const other = await shared();
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> forged.txt', device: LAPTOP });
    await appears(home, 'approval');
    await appears(laptop, 'approval');
    const askId = await lastAskId(laptop);
    const stillOpen = async (what) => {
      await sleep(250);
      assert.equal(await home.page.evaluate((ask) => remoteAsks.open.has(ask), askId), true, what);
      assert.equal(await visible(home, OVERLAY.approval), true, what);
      assert.equal(lineCount(forgedFile), 0, what);
    };

    await s.test('a value outside the set is dropped, and the pop-up stays open', async () => {
      for (const value of ['yes', 'true', 'once', 'folder', 1, null, {}, [true]]) {
        await answer(laptop, homeId, askId, value);
      }
      await stillOpen('bad values');
    });

    await s.test('extra fields, or none', async () => {
      await laptop.remote('send', homeId, { type: 'answer', id: askId, value: true, chatId: id });
      await laptop.remote('send', homeId, { type: 'answer', id: askId });
      await laptop.remote('send', homeId, { type: 'answer', value: true });
      await stillOpen('bad shapes');
    });

    await s.test('from a device that was never told of it', async () => {
      await home.page.evaluate(([ask, device]) => remoteAsks.open.get(ask).asked.delete(device), [askId, laptopId]);
      await answer(laptop, homeId, askId, true);
      await stillOpen('not asked');
      await home.page.evaluate(([ask, device]) => remoteAsks.open.get(ask).asked.add(device), [askId, laptopId]);
    });

    await s.test('a chat no longer shared', async () => {
      await home.page.evaluate((chatId) => { state.chats[chatId].remoteControl = false; }, id);
      await answer(laptop, homeId, askId, true);
      await stillOpen('not shared');
      await home.page.evaluate((chatId) => { state.chats[chatId].remoteControl = true; }, id);
    });

    await s.test('a locked laptop can\'t send one, and a String object is no way round', async () => {
      await laptop.remote('lock');
      await waitFor('the lock to show', () => visible(laptop, '#remote-pin-overlay'), 5000);
      assert.equal(await answer(laptop, homeId, askId, true), false);
      assert.equal(await laptop.page.evaluate(([to, ask]) => window.api.remote.send(to, { type: new String('answer'), id: ask, value: true }), [homeId, askId]), false);
      await stillOpen('locked');
      assert.deepEqual(await laptop.remote('unlock', PIN), { ok: true });
      await waitFor('the lock to go', async () => !(await visible(laptop, '#remote-pin-overlay')), 5000);
      await appears(laptop, 'approval');
    });

    await s.test('the log holds a flood of them to a line or two, with nothing from the frames', async () => {
      await sleep(100);
      const logged = () => readLog(home, 'remote-refusals.log').filter((e) => e.tool === 'answer');
      assert.ok(logged().length >= 1, 'what was dropped is written down');
      assert.equal(logged()[0].device, laptopId);
      assert.equal(logged()[0].ok, false);
      const before = logged().length;
      await laptop.page.evaluate(async ([to, ask]) => {
        for (let i = 0; i < 400; i += 1) window.api.remote.send(to, { type: 'answer', id: `${ask}-${i}`, value: `FLOOD-${'x'.repeat(2000)}` });
      }, [homeId, askId]);
      await stillOpen('flood');
      assert.ok(logged().length <= before + 1, `${logged().length - before} lines for 400 answers`);
      const raw = fs.readFileSync(path.join(home.profile, 'remote-refusals.log'), 'utf8');
      assert.ok(!raw.includes('FLOOD-'));
      for (const line of raw.split('\n').filter(Boolean)) assert.ok(line.length <= 8192);
    });

    await s.test('a real answer still works after all that, and only once', async () => {
      await answer(laptop, homeId, askId, true);
      await closes(home, 'approval');
      await answer(laptop, homeId, askId, true);
      await answer(laptop, homeId, askId, false);
      assert.equal((await finish()).exitCode, 0);
      await sleep(300);
      assert.equal(lineCount(forgedFile), 1, 'a second answer, and a late one, do nothing');
    });

    await s.test('an answer for what\'s closed, after Stop, or for another chat does nothing', async () => {
      const file = path.join(laptopDir, 'after-stop.txt');
      await go(other);
      const first = await ollama.next();
      first.call(['run_command', { command: 'echo x >> after-stop.txt', device: LAPTOP }]);
      first.finish();
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      const nextId = await lastAskId(laptop);
      // The one that has just closed belonged to another chat.
      await answer(laptop, homeId, askId, true);
      await sleep(250);
      assert.equal(await home.page.evaluate((ask) => remoteAsks.open.has(ask), nextId), true);
      await home.page.evaluate((chatId) => stopChatAndQueue(state.chats[chatId]), other);
      await closes(home, 'approval');
      await answer(laptop, homeId, nextId, true);
      await stopped(other);
      await sleep(300);
      assert.equal(lineCount(file), 0);
      assert.equal(ollama.poll(), null, 'Stop ended it, and nothing asked the model again');
    });

    await s.test('a device paired as this one\'s home can never answer', async () => {
      const local = await laptop.page.evaluate((model) => {
        const c = addChat(model, 'agent', { remoteControl: true });
        window.__localAsk = null;
        requestApproval('run_command', { command: 'echo local', cwd: '' }, c, null).then((value) => { window.__localAsk = { value }; });
        return c.id;
      }, MODEL);
      await appears(laptop, 'approval');
      const ownId = (await openAtHome(laptop))[0];
      assert.ok(ownId, local);
      // Everything else about it is as good as it can be, so only its role can stop this.
      await laptop.page.evaluate(([ask, device]) => remoteAsks.open.get(ask).asked.add(device), [ownId, homeId]);
      assert.equal(await home.remote('send', laptopId, { type: 'answer', id: ownId, value: true }), true, 'it can send it');
      await sleep(400);
      assert.equal(await laptop.page.evaluate(() => window.__localAsk), null, 'and it\'s dropped');
      assert.equal(await visible(laptop, OVERLAY.approval), true);
      assert.ok(readLog(laptop, 'remote-refusals.log').some((e) => e.tool === 'answer' && e.device === homeId), 'and logged');
      await click(laptop, NO.approval);
      await waitFor('it to answer itself', () => laptop.page.evaluate(() => window.__localAsk?.value === false), 5000);
      await laptop.page.evaluate((chatId) => deleteChat(chatId), local);
    });
  });

  // ---- Each kind ----

  await t.test('a plan: same path as at home, whoever answers', async (s) => {
    const plan = '# Steps\n1. Do it.\n<img src=x onerror="window.__planPwned=1">';
    const fieldsOf = (id) => home.page.evaluate((chatId) => {
      const c = state.chats[chatId];
      return { planMode: c.planMode, approvalMode: c.approvalMode, noApproval: c.noApproval, approvedPlan: c.approvedPlan ?? null };
    }, id);

    await s.test('approved on the laptop, the chat flips to Approval Mode', async () => {
      const id = await shared({ planMode: true, approvalMode: false });
      const finish = await modelCalls(id, 'exit_plan_mode', { plan });
      await appears(home, 'plan');
      await appears(laptop, 'plan');
      const frame = (await framesOf(laptop, 'ask')).at(-1);
      assert.equal(frame.kind, 'plan');
      assert.deepEqual(frame.args, { plan });
      assert.equal(frame.device, homeName);
      const onScreen = await textOf(laptop, '#plan-approval-body');
      assert.ok(onScreen.includes(plan), 'every word of it, as text');
      assert.ok(onScreen.includes(homeName), 'and whose it is');
      assert.ok((await textOf(laptop, '#plan-approval-desc')).includes('A project'));
      assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('#plan-approval-body img').length), 0);
      assert.equal(await laptop.page.evaluate(() => window.__planPwned), undefined);
      await click(laptop, YES.plan);
      await closes(home, 'plan');
      assert.equal((await finish()).ok, true);
      assert.deepEqual(await fieldsOf(id), { planMode: false, approvalMode: true, noApproval: false, approvedPlan: plan });
      assert.deepEqual(auditOf(id, 'exit_plan_mode').answeredBy, [{ kind: 'plan', name: LAPTOP, device: laptopId }]);
    });

    await s.test('rejected on the laptop, it stays in Plan Mode, and the laptop goes back to the usual wording', async () => {
      const id = await shared({ planMode: true, approvalMode: false });
      const finish = await modelCalls(id, 'exit_plan_mode', { plan: 'Another.' });
      await appears(laptop, 'plan');
      await click(laptop, NO.plan);
      await closes(home, 'plan');
      assert.match((await finish()).error, /rejected/);
      assert.deepEqual(await fieldsOf(id), { planMode: true, approvalMode: false, noApproval: false, approvedPlan: null });
    });

    await s.test('answered at home, it closes on the laptop', async () => {
      const id = await shared({ planMode: true, approvalMode: false });
      const finish = await modelCalls(id, 'exit_plan_mode', { plan: 'Home decides.' });
      await appears(laptop, 'plan');
      await appears(home, 'plan');
      assert.ok(!(await textOf(home, '#plan-approval-desc')).includes('From the chat'), 'home\'s own wording is as it was');
      await click(home, YES.plan);
      await closes(laptop, 'plan');
      assert.equal((await finish()).ok, true);
      assert.deepEqual(auditOf(id, 'exit_plan_mode').answeredBy, [{ kind: 'plan', name: 'home' }]);
    });
  });

  await t.test('access: a grant changes only the list for the machine the path is on', async (s) => {
    const lists = (id) => home.page.evaluate((chatId) => {
      const c = state.chats[chatId];
      return { home: c.pathAllowlist, laptops: c.pathAllowlists };
    }, id);
    const wide = (id, name) => path.join(outsideDir, `${name}-${id.slice(-4)}.txt`);

    await s.test('a laptop path, "Allow this folder" from the laptop', async () => {
      const id = await shared({ approvalMode: false, noApproval: true });
      const file = wide(id, 'laptop-path');
      fs.writeFileSync(file, 'FOUND-IT');
      const finish = await modelCalls(id, 'read_file', { path: file, device: LAPTOP });
      await appears(home, 'path');
      await appears(laptop, 'path');
      for (const device of [home, laptop]) {
        assert.equal(await textOf(device, '#pe-device'), LAPTOP);
        assert.equal(await textOf(device, '#pe-tool-name'), 'read_file');
        assert.equal(await textOf(device, '#pe-requested-path'), file);
        assert.equal(await textOf(device, '#pe-current-folder'), laptopDir);
      }
      const frame = (await framesOf(laptop, 'ask')).at(-1);
      assert.equal(frame.kind, 'path');
      assert.deepEqual(frame.args, { path: file, folder: laptopDir });
      await click(laptop, '#pe-folder');
      await closes(home, 'path');
      const result = await finish();
      assert.equal(result.content, 'FOUND-IT');
      assert.deepEqual(await lists(id), { home: [homeDir], laptops: { [laptopId]: [laptopDir, outsideDir] } }, 'the home list gains nothing');
      assert.deepEqual(auditOf(id, 'read_file').answeredBy, [{ kind: 'path', name: LAPTOP, device: laptopId }]);
    });

    await s.test('a home path, "Allow this folder" from the laptop', async () => {
      const id = await shared({ approvalMode: false, noApproval: true });
      const file = wide(id, 'home-path');
      fs.writeFileSync(file, 'FOUND-AT-HOME');
      const finish = await modelCalls(id, 'read_file', { path: file });
      await appears(laptop, 'path');
      assert.equal(await textOf(laptop, '#pe-device'), homeName);
      assert.equal(await textOf(home, '#pe-device'), homeName);
      assert.equal(await textOf(laptop, '#pe-current-folder'), homeDir);
      await click(laptop, '#pe-folder');
      await closes(home, 'path');
      assert.equal((await finish()).content, 'FOUND-AT-HOME');
      assert.deepEqual(await lists(id), { home: [homeDir, outsideDir], laptops: { [laptopId]: [laptopDir] } }, 'no laptop list gains it');
    });

    await s.test('"Just this once" keeps nothing, and "Deny" refuses, from each end', async () => {
      const id = await shared({ approvalMode: false, noApproval: true });
      const file = wide(id, 'once');
      fs.writeFileSync(file, 'ONE-LOOK');
      let finish = await modelCalls(id, 'read_file', { path: file, device: LAPTOP });
      await appears(laptop, 'path');
      await click(laptop, '#pe-once');
      await closes(home, 'path');
      assert.equal((await finish()).content, 'ONE-LOOK');
      assert.deepEqual(await lists(id), { home: [homeDir], laptops: { [laptopId]: [laptopDir] } });

      finish = await modelCalls(id, 'read_file', { path: file, device: LAPTOP });
      await appears(laptop, 'path');
      await click(laptop, '#pe-deny');
      await closes(home, 'path');
      assert.match((await finish()).error, /outside/);

      finish = await modelCalls(id, 'read_file', { path: file, device: LAPTOP });
      await appears(laptop, 'path');
      await appears(home, 'path');
      await click(home, '#pe-deny');
      await closes(laptop, 'path');
      assert.match((await finish()).error, /outside/);
      assert.deepEqual(await lists(id), { home: [homeDir], laptops: { [laptopId]: [laptopDir] } });
    });
  });

  await t.test('Stop, on each kind, from each device, closes it on both as a refusal', async (s) => {
    const kinds = {
      approval: { fields: {}, call: ['run_command', { command: 'echo x >> stop.txt', device: LAPTOP }] },
      plan: { fields: { planMode: true, approvalMode: false }, call: ['exit_plan_mode', { plan: 'Stop me.' }] },
      path: { fields: { approvalMode: false, noApproval: true }, call: ['read_file', { path: path.join(outsideDir, 'stop.txt'), device: LAPTOP }] }
    };
    const stoppers = {
      home: (id) => home.page.evaluate((chatId) => stopChatAndQueue(state.chats[chatId]), id),
      laptop: (id) => laptop.page.evaluate((chatKey) => stopChat(chatKey), key(id))
    };
    fs.writeFileSync(path.join(outsideDir, 'stop.txt'), 'NOT-TO-BE-READ');
    for (const [kind, { fields, call }] of Object.entries(kinds)) {
      for (const [who, stop] of Object.entries(stoppers)) {
        await s.test(`${kind}, Stop from ${who}`, async () => {
          const id = await shared(fields);
          const callsBefore = await newestCount(laptop, 'tool-call');
          await go(id);
          const first = await ollama.next();
          first.call(call);
          first.finish();
          await appears(home, kind);
          await appears(laptop, kind);
          const askId = await lastAskId(laptop);
          await clearToasts(laptop);
          await stop(id);
          await closes(home, kind);
          await closes(laptop, kind);
          await stopped(id);
          const closed = await waitFor('it to be told', async () => (await framesOf(laptop, 'ask-closed')).find((f) => f.id === askId), 5000);
          assert.equal(closed.value, null, 'nobody answered this');
          assert.ok((await toasts(laptop)).some((text) => text.includes(homeName)), 'the laptop says what became of it');
          await sleep(200);
          assert.equal(lineCount(path.join(laptopDir, 'stop.txt')), 0);
          const calls = (await framesOf(laptop, 'tool-call')).slice(callsBefore);
          assert.ok(calls.length <= (kind === 'path' ? 1 : 0), 'no second try');
          assert.deepEqual(await home.page.evaluate(() => [...remoteAsks.open.keys()]), []);
          assert.equal(await heldCount(laptop), 0);
          if (kind === 'plan') assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].planMode, id), true);
        });
      }
    }
  });

  // ---- What's shown is what runs ----

  await t.test('what\'s shown is what runs, whole, and what can\'t be shown can\'t be approved', async (s) => {
    await s.test('a write of 60 KB shows whole on both, scrolls, and can be approved', async () => {
      const id = await shared();
      const content = `${'line of text\n'.repeat(4600)}THE-END-OF-IT`;
      const file = path.join(laptopDir, 'long.txt');
      const finish = await modelCalls(id, 'write_file', { path: file, content, device: LAPTOP });
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      for (const device of [home, laptop]) {
        const { codes } = await approvalText(device);
        assert.equal(codes.at(-1).replace(/\r\n/g, '\n'), content, `${device.name} shows all of it`);
        assert.equal(await device.page.evaluate(() => { const el = [...document.querySelectorAll('#approval-body .approval-code')].at(-1); return el.scrollHeight > el.clientHeight; }), true, 'it scrolls');
      }
      assert.equal(await visible(laptop, YES.approval), true);
      await click(laptop, YES.approval);
      await closes(home, 'approval');
      assert.equal((await finish()).bytes, Buffer.byteLength(content));
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    });

    await s.test('past 64 KiB the laptop gets only Deny, home shows it whole, and a forged yes is dropped', async () => {
      const id = await shared();
      const content = `${'x'.repeat(70 * KIB)}THE-SECRET-END`;
      const file = path.join(laptopDir, 'too-long.txt');
      const finish = await modelCalls(id, 'write_file', { path: file, content, device: LAPTOP });
      await appears(home, 'approval');
      await appears(laptop, 'approval');
      const frame = (await framesOf(laptop, 'ask')).at(-1);
      assert.equal(frame.tooLarge, true);
      assert.deepEqual(frame.args, {});
      assert.equal(frame.device, LAPTOP);
      assert.ok(!JSON.stringify(frame).includes('THE-SECRET-END'));
      assert.equal(await visible(laptop, YES.approval), false, 'nothing to approve with');
      assert.equal(await visible(laptop, NO.approval), true);
      assert.match(await textOf(laptop, '#approval-body'), /too long to show here/i);
      assert.match(await textOf(laptop, '#approval-body'), /home/i);
      assert.equal((await approvalText(laptop)).machine, LAPTOP);
      assert.ok((await approvalText(home)).codes.at(-1).endsWith('THE-SECRET-END'), 'at home, every word');
      assert.equal(await visible(home, YES.approval), true);

      await answer(laptop, homeId, frame.id, true);
      await sleep(300);
      assert.equal(await visible(home, OVERLAY.approval), true, 'a yes for what could not be read is dropped');
      assert.equal(fs.existsSync(file), false);

      await click(laptop, NO.approval);
      await closes(home, 'approval');
      assert.match((await finish()).error, /denied/);
      assert.equal(fs.existsSync(file), false);

      // And the buttons are back for the next one.
      const next = await shared();
      const finishNext = await modelCalls(next, 'run_command', { command: 'echo x >> after-too-long.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      assert.equal(await visible(laptop, YES.approval), true);
      assert.doesNotMatch(await textOf(laptop, '#approval-body'), /too long/i);
      await click(laptop, NO.approval);
      await closes(home, 'approval');
      await finishNext();
    });

    await s.test('home can approve what was too long for the laptop', async () => {
      const id = await shared();
      const content = `${'y'.repeat(70 * KIB)}END`;
      const file = path.join(homeDir, 'too-long-home.txt');
      const finish = await modelCalls(id, 'write_file', { path: file, content });
      await appears(laptop, 'approval');
      await click(home, YES.approval);
      await closes(laptop, 'approval');
      assert.equal((await finish()).bytes, content.length);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    });

    await s.test('a plan past 64 KiB is the same', async () => {
      const id = await shared({ planMode: true, approvalMode: false });
      const finish = await modelCalls(id, 'exit_plan_mode', { plan: 'z'.repeat(70 * KIB) });
      await appears(laptop, 'plan');
      assert.equal(await visible(laptop, YES.plan), false);
      assert.match(await textOf(laptop, '#plan-approval-body'), /too long to show here/i);
      const { id: askId } = (await framesOf(laptop, 'ask')).at(-1);
      await answer(laptop, homeId, askId, true);
      await sleep(300);
      assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].planMode, id), true);
      await click(laptop, NO.plan);
      await closes(home, 'plan');
      assert.match((await finish()).error, /rejected/);
    });

    await s.test('a folder that moves while the pop-up is open stops it running somewhere else', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> moved.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[2], laptopDir);
      await home.page.evaluate(([chatId, device, folder]) => { state.chats[chatId].projectFolders[device] = folder; }, [id, laptopId, outsideDir]);
      await click(laptop, YES.approval);
      await closes(home, 'approval');
      assert.match((await finish()).error, /changed/);
      assert.equal(fs.existsSync(path.join(outsideDir, 'moved.txt')), false);
      assert.equal(fs.existsSync(path.join(laptopDir, 'moved.txt')), false);
    });

    await s.test('a home command with its own folder, and a non-text command, show what they\'ll do', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> own-folder.txt', cwd: outsideDir });
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[2], outsideDir);
      assert.deepEqual(await approvalText(home), await approvalText(laptop));
      await click(laptop, YES.approval);
      assert.equal((await finish()).exitCode, 0);
      assert.equal(lineCount(path.join(outsideDir, 'own-folder.txt')), 1);
    });
  });

  // ---- Keeping them in step ----

  await t.test('one queued behind another that\'s answered elsewhere leaves the queue without ever showing', async () => {
    await noteWhatShows(home);
    await noteWhatShows(laptop);
    const front = await shared();
    const behind = await shared();
    const behindFile = path.join(laptopDir, 'behind.txt');
    const finishFront = await modelCalls(front, 'run_command', { command: 'echo x >> front.txt', device: LAPTOP });
    await appears(home, 'approval');
    await appears(laptop, 'approval');
    const finishBehind = await modelCalls(behind, 'run_command', { command: 'echo x >> behind.txt', device: LAPTOP });
    const behindId = await waitFor('the second question to reach the laptop', async () => (await framesOf(laptop, 'ask')).find((f) => f.chatId === behind)?.id, 5000);
    assert.equal((await approvalText(home)).codes[1], 'echo x >> front.txt', 'the first stays up');

    await answer(laptop, homeId, behindId, true);
    assert.equal((await finishBehind()).exitCode, 0, 'it doesn\'t wait for the one in front');
    assert.equal(lineCount(behindFile), 1);
    assert.equal((await approvalText(home)).codes[1], 'echo x >> front.txt');
    assert.equal((await approvalText(laptop)).codes[1], 'echo x >> front.txt');

    await click(laptop, NO.approval);
    await closes(home, 'approval');
    await closes(laptop, 'approval');
    await finishFront();
    await sleep(300);
    for (const device of [home, laptop]) {
      const seen = (await shown(device)).filter((text) => text.includes('behind.txt'));
      assert.deepEqual(seen, [], `${device.name} never showed it`);
      assert.equal(await visible(device, OVERLAY.approval), false);
    }
  });

  await t.test('one queued behind another that\'s still open shows when its turn comes, on both', async () => {
    const front = await shared();
    const behind = await shared();
    const finishFront = await modelCalls(front, 'run_command', { command: 'echo x >> front-2.txt' });
    await appears(home, 'approval');
    await appears(laptop, 'approval');
    const finishBehind = await modelCalls(behind, 'run_command', { command: 'echo x >> behind-2.txt' });
    await waitFor('the second question to reach the laptop', async () => (await framesOf(laptop, 'ask')).some((f) => f.chatId === behind), 5000);
    await click(home, NO.approval);
    await finishFront();
    await waitFor('the next to come up on both', async () => (await approvalText(home)).codes[1] === 'echo x >> behind-2.txt' && (await approvalText(laptop)).codes[1] === 'echo x >> behind-2.txt' && (await visible(home, OVERLAY.approval)) && (await visible(laptop, OVERLAY.approval)), 5000);
    await click(laptop, NO.approval);
    await closes(home, 'approval');
    await finishBehind();
  });

  await t.test('unsharing and deleting a chat, and reloading home, close them at the laptop', async (s) => {
    await s.test('unsharing: it closes there, stays open here, and says why', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> unshared.txt' });
      await appears(laptop, 'approval');
      await clearToasts(laptop);
      await home.page.evaluate((chatId) => setChatShared(state.chats[chatId], false), id);
      await closes(laptop, 'approval');
      assert.equal(await heldCount(laptop), 0);
      assert.ok((await toasts(laptop)).some((text) => /no longer shared/.test(text)));
      assert.equal(await visible(home, OVERLAY.approval), true);
      await click(home, NO.approval);
      await finish();
    });

    await s.test('deleting', async () => {
      const id = await shared();
      await go(id);
      const first = await ollama.next();
      first.call(['run_command', { command: 'echo x >> deleted.txt' }]);
      first.finish();
      await appears(laptop, 'approval');
      await clearToasts(laptop);
      await home.page.evaluate((chatId) => deleteChat(chatId), id);
      await closes(home, 'approval');
      await closes(laptop, 'approval');
      await stopped(id);
      assert.equal(await heldCount(laptop), 0);
      assert.ok((await toasts(laptop)).some((text) => text.includes(homeName) && /no longer needs an answer/.test(text)), 'and it says so');
      assert.equal(lineCount(path.join(homeDir, 'deleted.txt')), 0);
    });

    await s.test('reloading home', async () => {
      const id = await shared();
      await go(id);
      const first = await ollama.next();
      first.call(['run_command', { command: 'echo x >> home-reload.txt', device: LAPTOP }]);
      first.finish();
      await appears(laptop, 'approval');
      await clearToasts(laptop);
      await home.page.evaluate(() => {
        window.saveToStorage = () => {};
        location.reload();
      });
      await closes(laptop, 'approval', 20000);
      assert.equal(await heldCount(laptop), 0);
      assert.ok((await toasts(laptop)).some((text) => text.includes(homeName)), 'and it says why');
      await waitFor('the page to come back', () => home.page.evaluate(() => typeof remoteAsks === 'object' && Boolean(window.api?.remote)).catch(() => false), 20000);
      await home.record();
      await started(home);
      await home.page.evaluate((m) => ensureModelInfo(m), MODEL);
      await hearsSwitch(true);
      await home.page.evaluate(() => { remoteTools.askWaitMs = 600000; });
      assert.equal(lineCount(path.join(laptopDir, 'home-reload.txt')), 0);
    });
  });

  await t.test('a chat too large to reach a laptop is a chat nobody there can be asked about', async () => {
    await home.page.evaluate(() => { remoteTools.askWaitMs = 1500; });
    const id = await shared();
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> too-large-chat.txt' }, startFromLaptop);
    await appears(laptop, 'approval');
    const timerOn = () => home.page.evaluate(() => [...remoteAsks.open.values()].some((ask) => ask.timer !== null));
    assert.equal(await timerOn(), false);
    await home.page.evaluate((chatId) => {
      mirror.tooLarge.add(chatId);
      syncOpenAsks();
    }, id);
    await closes(laptop, 'approval');
    assert.equal(await timerOn(), true, 'nobody there can answer, so the time counts');
    assert.equal(await visible(home, OVERLAY.approval), true);
    assert.match((await finish()).error, /Nobody answered/);
    await home.page.evaluate((chatId) => {
      mirror.tooLarge.delete(chatId);
      remoteTools.askWaitMs = 600000;
    }, id);
  });

  await t.test('the toast about tools left out says what\'s true whatever the reason', async () => {
    await clearToasts(laptop);
    await laptop.page.evaluate(() => {
      window.__realTools = state.mcpTools;
      state.mcpTools = [{ type: 'function', function: { name: `mcp__a__${'x'.repeat(300)}`, description: '', parameters: { type: 'object', properties: {} } } }];
      remoteTools.toolsLeftOut = 0;
      outgoingToolsNoting();
      state.mcpTools = window.__realTools;
      remoteTools.toolsLeftOut = 0;
    });
    const said = await toasts(laptop);
    assert.ok(said.includes("1 MCP tool on this device can't be offered to a home PC, so it was left out."), JSON.stringify(said));
    await clearToasts(laptop);
  });

  await t.test('the 2-minute timer counts only while no connected laptop can answer', async (s) => {
    const timerRunning = () => home.page.evaluate(() => [...remoteAsks.open.values()].some((ask) => ask.timer !== null));
    const statusWith = (fields) => home.page.evaluate(async (extra) => {
      const real = await window.api.remote.status();
      mirrorOnStatus({ ...real, devices: real.devices.map((d) => ({ ...d, ...extra })) });
    }, fields);

    await s.test('it stops, starts again when the last one goes, stops when one comes back, and ends with the model told the truth', async () => {
      await home.page.evaluate(() => { remoteTools.askWaitMs = 20000; });
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> timer.txt', device: LAPTOP }, startFromLaptop);
      await appears(laptop, 'approval');
      assert.equal(await timerRunning(), false, 'a laptop can answer');

      await statusWith({ quiet: true });
      assert.equal(await timerRunning(), false, 'quiet still counts as connected');
      await statusWith({ quiet: false });

      await disconnect();
      await waitFor('the timer to start', timerRunning, 5000);
      await reconnect();
      await waitFor('the timer to stop', async () => !(await timerRunning()), 5000);
      await appears(laptop, 'approval');

      await home.page.evaluate(() => { remoteTools.askWaitMs = 500; });
      await sleep(900);
      assert.equal(await visible(home, OVERLAY.approval), true, 'not while it can be answered');

      await disconnect();
      const result = await finish();
      assert.match(result.error, /Nobody answered/);
      assert.match(result.error, /any connected device/, 'it says all it knows');
      assert.equal(await visible(home, OVERLAY.approval), false);
      assert.equal(await home.page.evaluate(() => remoteAsks.open.size), 0, 'through the same cleanup');
      assert.equal(lineCount(path.join(laptopDir, 'timer.txt')), 0);
      assert.equal(auditOf(id, 'run_command').answeredBy, undefined, 'and nobody is named');
      await reconnect();
      assert.equal(await visible(laptop, OVERLAY.approval), false, 'it doesn\'t come back');
    });

    await s.test('unsharing leaves no laptop to answer, so it starts then', async () => {
      await home.page.evaluate(() => { remoteTools.askWaitMs = 500; });
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> timer-unshared.txt', device: LAPTOP }, startFromLaptop);
      await appears(laptop, 'approval');
      await sleep(800);
      assert.equal(await visible(home, OVERLAY.approval), true);
      await home.page.evaluate((chatId) => setChatShared(state.chats[chatId], false), id);
      assert.match((await finish()).error, /Nobody answered/);
    });

    await s.test('a plan and an access pop-up end the same way', async () => {
      await home.page.evaluate(() => { remoteTools.askWaitMs = 500; });
      const planning = await shared({ planMode: true, approvalMode: false });
      const finishPlan = await modelCalls(planning, 'exit_plan_mode', { plan: 'Nobody reads this.' }, startFromLaptop);
      await appears(laptop, 'plan');
      await disconnect();
      assert.match((await finishPlan()).error, /Nobody answered/);
      assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].planMode, planning), true);
      await reconnect();

      fs.writeFileSync(path.join(outsideDir, 'unread.txt'), 'NOT-READ');
      const reading = await shared({ approvalMode: false, noApproval: true });
      const finishPath = await modelCalls(reading, 'read_file', { path: path.join(outsideDir, 'unread.txt') }, startFromLaptop);
      await appears(laptop, 'path');
      await disconnect();
      const result = await finishPath();
      assert.ok(!JSON.stringify(result).includes('NOT-READ'));
      assert.equal(await home.page.evaluate(() => remoteAsks.open.size), 0);
      await reconnect();
      await home.page.evaluate(() => { remoteTools.askWaitMs = 600000; });
    });

    await s.test('started at home, it waits for the person at home, with no timer at all', async () => {
      await home.page.evaluate(() => { remoteTools.askWaitMs = 300; });
      await disconnect();
      const id = await shared({ remoteControl: false });
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> slow.txt' });
      await appears(home, 'approval');
      await sleep(800);
      assert.equal(await visible(home, OVERLAY.approval), true);
      await click(home, NO.approval);
      await finish();
      await reconnect();
      await home.page.evaluate(() => { remoteTools.askWaitMs = 600000; });
    });
  });

  await t.test('a pop-up mustn\'t catch keys meant for something else', async (s) => {
    const guard = (device, ms) => device.page.evaluate((value) => { remoteAsks.keyGuardMs = value; }, ms);
    const focused = (device) => device.page.evaluate(() => document.activeElement?.id ?? null);
    const typeInBox = async (device, words) => {
      await device.page.focus('#composer-input');
      await device.page.keyboard.type(words);
    };

    for (const [name, deviceOf, answersOn] of [['on the laptop', () => laptop, 'laptop'], ['at home', () => home, 'home']]) {
      await s.test(`${name}: Enter and Space while typing don't approve, and what's in the box survives`, async () => {
        const device = deviceOf();
        const file = path.join(homeDir, `keys-${answersOn}.txt`);
        const id = await shared();
        // Somewhere to be typing that isn't the chat asking.
        await openChat(device, await newChat(device, { modality: 'chat', remoteControl: false, title: 'Typing here', titleManual: true }));
        await guard(device, 4000);
        await device.page.evaluate(() => {
          state.pendingAttachments = [{ kind: 'text', name: 'note.txt', text: 'kept', ext: 'txt', size: 4 }];
          renderAttachments();
        });
        await typeInBox(device, 'half a sente');
        const finish = await modelCalls(id, 'run_command', { command: `echo x >> keys-${answersOn}.txt` });
        await appears(device, 'approval');
        assert.equal(await focused(device), 'approval-deny', 'focus starts on the refusing choice');
        await device.page.keyboard.press('Enter');
        await device.page.keyboard.press('Space');
        await device.page.keyboard.press('Tab');
        assert.equal(await focused(device), 'approval-approve');
        await device.page.keyboard.press('Enter');
        await device.page.keyboard.press('Space');
        await sleep(200);
        assert.equal(await visible(device, OVERLAY.approval), true, 'none of that did anything');
        assert.equal(await visible(home, OVERLAY.approval), true);
        assert.equal(lineCount(file), 0);
        assert.equal(await device.page.inputValue('#composer-input'), 'half a sente', 'the words are still there');
        assert.equal(await device.page.evaluate(() => state.pendingAttachments.length), 1, 'and the file');

        // A key held down from before doesn't count, however long it's held.
        await device.page.keyboard.down('Enter');
        await guard(device, 0);
        await device.page.keyboard.down('Enter');
        await device.page.keyboard.up('Enter');
        await sleep(200);
        assert.equal(await visible(device, OVERLAY.approval), true, 'a repeat is not a press');

        // After the delay it's an ordinary button again, so a deliberate press works.
        await device.page.keyboard.press('Enter');
        await closes(device, 'approval');
        assert.equal((await finish()).exitCode, 0);
        assert.equal(lineCount(file), 1);
        assert.equal(await focused(device), 'composer-input', 'and the box has its focus back');
        assert.equal(await device.page.inputValue('#composer-input'), 'half a sente');
        assert.equal(await device.page.evaluate(() => state.pendingAttachments.length), 1);
        await device.page.fill('#composer-input', '');
        await device.page.evaluate(() => { state.pendingAttachments = []; renderAttachments(); });
      });

      await s.test(`${name}: after the delay Enter lands on the refusal, and Escape refuses straight away`, async () => {
        const device = deviceOf();
        const id = await shared();
        await guard(device, 0);
        let finish = await modelCalls(id, 'run_command', { command: 'echo x >> enter-refuses.txt' });
        await appears(device, 'approval');
        await device.page.keyboard.press('Enter');
        await closes(device, 'approval');
        assert.match((await finish()).error, /denied/);

        await guard(device, 4000);
        finish = await modelCalls(id, 'run_command', { command: 'echo x >> enter-refuses.txt' });
        await appears(device, 'approval');
        await device.page.keyboard.press('Escape');
        await closes(device, 'approval');
        assert.match((await finish()).error, /denied/);
        assert.equal(lineCount(path.join(homeDir, 'enter-refuses.txt')), 0);
        await guard(device, 800);
      });
    }

    await s.test('plan and access have the same rule', async () => {
      await guard(laptop, 4000);
      const planning = await shared({ planMode: true, approvalMode: false });
      const finishPlan = await modelCalls(planning, 'exit_plan_mode', { plan: 'Keys.' });
      await appears(laptop, 'plan');
      assert.equal(await focused(laptop), 'plan-approval-deny');
      await laptop.page.keyboard.press('Tab');
      await laptop.page.keyboard.press('Enter');
      await sleep(200);
      assert.equal(await home.page.evaluate((chatId) => state.chats[chatId].planMode, planning), true);
      assert.equal(await visible(laptop, OVERLAY.plan), true);
      await click(laptop, NO.plan);
      await finishPlan();

      fs.writeFileSync(path.join(outsideDir, 'keys.txt'), 'x');
      const reading = await shared({ approvalMode: false, noApproval: true });
      const finishPath = await modelCalls(reading, 'read_file', { path: path.join(outsideDir, 'keys.txt') });
      await appears(laptop, 'path');
      assert.equal(await focused(laptop), 'pe-deny');
      await laptop.page.keyboard.press('Tab');
      await laptop.page.keyboard.press('Enter');
      await laptop.page.keyboard.press('Tab');
      await laptop.page.keyboard.press('Space');
      await sleep(200);
      assert.equal(await visible(laptop, OVERLAY.path), true);
      await click(laptop, NO.path);
      await finishPath();
      await guard(laptop, 800);
    });
  });

  // ---- The laptop's side, against a hostile home ----

  await t.test('locked means hidden', async (s) => {
    const locked = async () => {
      await laptop.remote('lock');
      await waitFor('the lock to show', () => visible(laptop, '#remote-pin-overlay'), 5000);
    };
    const unlocked = async () => {
      assert.deepEqual(await laptop.remote('unlock', PIN), { ok: true });
      await waitFor('the lock to go', async () => !(await visible(laptop, '#remote-pin-overlay')), 5000);
    };
    const nothingOnScreen = async (words) => {
      assert.equal(await visible(laptop, OVERLAY.approval), false);
      assert.equal(await laptop.page.evaluate((text) => document.documentElement.innerHTML.includes(text), words), false, 'no trace in the page');
      assert.deepEqual((await toasts(laptop)).filter((text) => text.includes(words)), []);
    };

    await s.test('an ask during the lock reaches no screen, and shows on unlock', async () => {
      const id = await shared();
      await clearToasts(laptop);
      await locked();
      const before = await newestCount(laptop, 'ask');
      const finish = await modelCalls(id, 'run_command', { command: 'echo LOCKED-WORDS >> locked.txt', device: LAPTOP });
      await waitFor('the frame to land', async () => (await newestCount(laptop, 'ask')) === before + 1, 5000);
      await sleep(200);
      await nothingOnScreen('LOCKED-WORDS');
      assert.deepEqual(await toasts(laptop), [], 'and no toast of any kind');
      await unlocked();
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[1], 'echo LOCKED-WORDS >> locked.txt');
      await click(laptop, NO.approval);
      await closes(home, 'approval');
      await finish();
    });

    await s.test('one that closes during the lock never appears', async () => {
      await noteWhatShows(laptop);
      const id = await shared();
      await clearToasts(laptop);
      await locked();
      const before = await newestCount(laptop, 'ask');
      const finish = await modelCalls(id, 'run_command', { command: 'echo GONE-WORDS >> gone.txt' });
      await waitFor('the frame to land', async () => (await newestCount(laptop, 'ask')) === before + 1, 5000);
      await appears(home, 'approval');
      await click(home, NO.approval);
      await finish();
      await waitFor('it to be let go', async () => (await heldCount(laptop)) === 0, 5000);
      await unlocked();
      await sleep(400);
      assert.equal(await visible(laptop, OVERLAY.approval), false);
      assert.deepEqual((await shown(laptop)).filter((text) => text.includes('GONE-WORDS')), []);
      assert.deepEqual(await toasts(laptop), [], 'nothing to say about it either');
    });

    await s.test('one on screen when the lock comes goes away, and comes back if it\'s still open', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo ON-SCREEN >> on-screen.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      await locked();
      await nothingOnScreen('ON-SCREEN');
      assert.equal(await visible(home, OVERLAY.approval), true);
      await unlocked();
      await appears(laptop, 'approval');
      await click(laptop, NO.approval);
      await closes(home, 'approval');
      await finish();
    });

    await s.test('one waiting behind it doesn\'t take its place when the lock comes', async () => {
      await noteWhatShows(laptop);
      const a = await shared();
      const b = await shared();
      const finishA = await modelCalls(a, 'run_command', { command: 'echo FRONT-WORDS >> front-lock.txt' });
      await appears(laptop, 'approval');
      const finishB = await modelCalls(b, 'run_command', { command: 'echo BEHIND-WORDS >> behind-lock.txt' });
      await waitFor('both to be held', async () => (await heldCount(laptop)) === 2, 5000);
      await locked();
      await sleep(300);
      await nothingOnScreen('FRONT-WORDS');
      await nothingOnScreen('BEHIND-WORDS');
      assert.deepEqual((await shown(laptop)).filter((text) => text.includes('BEHIND-WORDS')), [], 'its turn came, and it stayed away');
      await unlocked();
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[1], 'echo FRONT-WORDS >> front-lock.txt');
      await click(laptop, NO.approval);
      await waitFor('the next', async () => (await visible(laptop, OVERLAY.approval)) && (await approvalText(laptop)).codes[1] === 'echo BEHIND-WORDS >> behind-lock.txt', 5000);
      await click(laptop, NO.approval);
      await finishA();
      await finishB();
    });

    await s.test('two held through a lock come back one at a time, in order', async () => {
      const a = await shared();
      const b = await shared();
      await locked();
      const finishA = await modelCalls(a, 'run_command', { command: 'echo A >> a.txt' });
      const finishB = await modelCalls(b, 'run_command', { command: 'echo B >> b.txt' });
      await waitFor('both to land', async () => (await heldCount(laptop)) === 2, 5000);
      await unlocked();
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[1], 'echo A >> a.txt');
      await click(laptop, NO.approval);
      await waitFor('the next', async () => (await visible(laptop, OVERLAY.approval)) && (await approvalText(laptop)).codes[1] === 'echo B >> b.txt', 5000);
      await click(laptop, NO.approval);
      await finishA();
      await finishB();
      await closes(home, 'approval');
    });
  });

  await t.test('a laptop treats an ask as hostile', async (s) => {
    const other = await launchDevice('other-home', { ollamaUrl: trio.ollama.url });
    extras.push(other);
    await started(other);
    await waitFor('its model', () => other.page.evaluate(() => Boolean(state.catalog)), 5000);
    assert.deepEqual(await other.remote('setAddress', trio.relay.address), { ok: true });
    const { code } = await other.remote('createCode');
    await waitFor('the pairing', async () => {
      const res = await laptop.remote('pair', code, LAPTOP);
      if (!res.ok && !/cancelled/.test(res.error)) assert.fail(res.error);
      return res.ok;
    }, 15000);
    const otherId = await waitFor('it to connect', async () => (await laptop.remote('status')).devices.find((d) => d.id !== homeId && d.connected)?.id, 15000);
    const fromOther = await waitFor('its end', async () => (await other.remote('status')).devices.find((d) => d.connected)?.id, 15000);
    const otherChat = await newChat(other, { ...baseChat, projectFolder: outsideDir, pathAllowlist: [outsideDir], projectFolders: {}, pathAllowlists: {} });
    const otherKey = `remote:${otherId}:${otherChat}`;
    await waitFor('its chat to reach the laptop', () => hasChat(laptop, otherKey), 10000);
    const forge = (fields) => other.remote('send', fromOther, { type: 'ask', id: 'forged-1', kind: 'approval', chatId: otherChat, tool: 'run_command', args: { command: 'echo forged', cwd: '' }, device: 'Somewhere', ...fields });
    const heldFor = (deviceId) => laptop.page.evaluate((id) => [...remoteAsks.held.values()].filter((h) => h.deviceId === id).map((h) => h.id), deviceId);

    await s.test('anything out of shape, or for a chat it can\'t see, is dropped', async () => {
      const before = await heldCount(laptop);
      for (const fields of [{ kind: 'grant' }, { extra: 1 }, { device: 'two\nlines' }, { args: 'text' }, { tool: '' }, { chatId: 'not-a-chat-here' }, { id: 'has:colon' }, { args: { command: 'x'.repeat(70 * KIB), cwd: '' } }]) {
        await forge(fields);
      }
      await sleep(400);
      assert.equal(await heldCount(laptop), before);
      assert.equal(await visible(laptop, OVERLAY.approval), false);
    });

    await s.test('a laptop can\'t put one up at home', async () => {
      await laptop.remote('send', homeId, { type: 'ask', id: 'backwards', kind: 'approval', chatId: 'c', tool: 'run_command', args: { command: 'x', cwd: '' }, device: 'x' });
      await sleep(300);
      assert.equal(await visible(home, OVERLAY.approval), false);
      assert.equal(await heldCount(home), 0);
    });

    await s.test('its text stays text, in every kind', async () => {
      const mark = '<img src=x onerror="window.__askPwned=1"><b>bold</b>';
      await forge({ args: { command: mark, cwd: mark }, device: 'Mac<b>Book</b>' });
      await appears(laptop, 'approval');
      assert.equal((await approvalText(laptop)).codes[1], mark);
      assert.equal((await approvalText(laptop)).machine, 'Mac<b>Book</b>');
      await click(laptop, NO.approval);
      await forge({ id: 'forged-2', kind: 'plan', tool: 'exit_plan_mode', args: { plan: mark } });
      await appears(laptop, 'plan');
      assert.ok((await textOf(laptop, '#plan-approval-body')).includes(mark));
      await click(laptop, NO.plan);
      await forge({ id: 'forged-3', kind: 'path', tool: '<b>read</b>', args: { path: mark, folder: mark }, device: 'a<i>b' });
      await appears(laptop, 'path');
      assert.equal(await textOf(laptop, '#pe-requested-path'), mark);
      assert.equal(await textOf(laptop, '#pe-current-folder'), mark);
      assert.equal(await textOf(laptop, '#pe-tool-name'), '<b>read</b>');
      assert.equal(await textOf(laptop, '#pe-device'), 'a<i>b');
      await click(laptop, NO.path);
      await forge({ id: 'forged-4', tool: 'mcp__a__b', args: { x: mark } });
      await appears(laptop, 'approval');
      assert.ok((await textOf(laptop, '#approval-body')).includes('window.__askPwned'));
      assert.equal(await laptop.page.evaluate(() => document.querySelectorAll('.modal img, .modal b, .modal-overlay i').length), 0);
      assert.equal(await laptop.page.evaluate(() => window.__askPwned), undefined);
      await click(laptop, NO.approval);
      for (const [id, value] of [['forged-1', false], ['forged-2', false], ['forged-3', 'deny'], ['forged-4', false]]) {
        await waitFor(`${id} to be answered`, async () => (await framesOf(other, 'answer')).some((f) => f.id === id && f.value === value), 5000);
        await other.remote('send', fromOther, { type: 'ask-closed', id, value });
      }
    });

    await s.test('too long, from a home that says so, in each kind, offers only the refusal', async () => {
      await forge({ id: 'long-1', kind: 'path', tool: 'read_file', args: {}, tooLarge: true });
      await appears(laptop, 'path');
      assert.equal(await visible(laptop, '#pe-once'), false);
      assert.equal(await visible(laptop, '#pe-folder'), false);
      assert.equal(await visible(laptop, '#pe-deny'), true);
      assert.match(await textOf(laptop, '#pe-too-long'), /too long to show here/i);
      await click(laptop, '#pe-deny');
      await waitFor('its answer', async () => (await framesOf(other, 'answer')).some((f) => f.id === 'long-1' && f.value === 'deny'), 5000);
      await other.remote('send', fromOther, { type: 'ask-closed', id: 'long-1', value: 'deny' });
      assert.equal(await visible(laptop, '#pe-too-long'), false);
    });

    await s.test('two homes with the same id: neither can close, replace, or answer the other\'s', async () => {
      const id = await shared();
      const finish = await modelCalls(id, 'run_command', { command: 'echo x >> same-id.txt', device: LAPTOP });
      await appears(laptop, 'approval');
      const askId = await lastAskId(laptop);

      // Closing it from the other home does nothing.
      await other.remote('send', fromOther, { type: 'ask-closed', id: askId, value: false });
      await sleep(300);
      assert.equal(await visible(laptop, OVERLAY.approval), true, 'not theirs to close');
      assert.equal((await approvalText(laptop)).codes[1], 'echo x >> same-id.txt');

      // Its own, under the same id, is its own. It waits its turn and changes nothing on screen.
      await forge({ id: askId, args: { command: 'echo the-other-home', cwd: '' } });
      await waitFor('both to be held', async () => (await heldFor(otherId)).includes(askId) && (await heldFor(homeId)).includes(askId), 5000);
      assert.equal((await approvalText(laptop)).codes[1], 'echo x >> same-id.txt', 'not theirs to replace');

      // The first home sending it again changes nothing either.
      await home.remote('send', laptopId, { type: 'ask', id: askId, kind: 'approval', chatId: id, tool: 'run_command', args: { command: 'echo swapped', cwd: '' }, device: LAPTOP });
      await sleep(300);
      assert.equal((await approvalText(laptop)).codes[1], 'echo x >> same-id.txt', 'a second ask for the same id isn\'t a new one');

      const otherAnswers = (await framesOf(other, 'answer')).length;
      await click(laptop, YES.approval);
      await closes(home, 'approval');
      assert.equal((await finish()).exitCode, 0);
      assert.equal((await framesOf(other, 'answer')).length, otherAnswers, 'the answer went only to the home that asked');
      assert.equal(lineCount(path.join(laptopDir, 'same-id.txt')), 1);

      // The other home's comes up now, and goes back only to it.
      await waitFor('the other home\'s to come up', async () => (await visible(laptop, OVERLAY.approval)) && (await approvalText(laptop)).codes[1] === 'echo the-other-home', 5000);
      const homeAnswers = (await framesOf(home, 'answer')).length;
      await click(laptop, NO.approval);
      await waitFor('its answer', async () => (await framesOf(other, 'answer')).some((f) => f.id === askId && f.value === false), 5000);
      assert.equal((await framesOf(home, 'answer')).length, homeAnswers);
      await other.remote('send', fromOther, { type: 'ask-closed', id: askId, value: false });
      await waitFor('nothing to be left', async () => (await heldFor(otherId)).length === 0, 5000);
    });

    await s.test('at most 20 held for one home, dropping the newest, with one toast', async () => {
      await clearToasts(laptop);
      for (let i = 0; i < 26; i += 1) await forge({ id: `many-${i}`, args: { command: `echo ${i}`, cwd: '' } });
      await waitFor('them to land', async () => (await heldFor(otherId)).length === 20, 5000);
      await sleep(300);
      const held = await heldFor(otherId);
      assert.deepEqual(held, Array.from({ length: 20 }, (_, i) => `many-${i}`), 'the first 20 stay');
      assert.equal((await toasts(laptop)).filter((text) => /Too many/.test(text)).length, 1);

      for (const askId of held) await other.remote('send', fromOther, { type: 'ask-closed', id: askId, value: null });
      await waitFor('them to go', async () => (await heldFor(otherId)).length === 0, 5000);
      await closes(laptop, 'approval');
    });

    await other.remote('removeDevice', fromOther);
    await waitFor('the other home to go', async () => !(await laptop.remote('status')).devices.some((d) => d.id === otherId), 5000);
    assert.equal(await hasChat(laptop, otherKey), false);
  });

  await t.test('Remove <home> instead discards everything held', async () => {
    const id = await shared();
    const finish = await modelCalls(id, 'run_command', { command: 'echo x >> removed-instead.txt' });
    await appears(laptop, 'approval');
    // The screen that offers this, as it is for a laptop that owes a PIN.
    await laptop.page.evaluate(async () => {
      const real = await window.api.remote.status();
      mirrorOnStatus({ ...real, hasPin: false, needsPin: true });
    });
    await waitFor('the button', () => visible(laptop, '#remote-pin-remove'), 5000);
    assert.equal(await visible(laptop, OVERLAY.approval), false);
    assert.equal(await heldCount(laptop), 1, 'held, while the lock is up');
    await click(laptop, '#remote-pin-remove');
    await waitFor('it to be discarded', async () => (await heldCount(laptop)) === 0, 8000);
    await laptop.page.evaluate(async () => mirrorOnStatus(await window.api.remote.status()));
    await sleep(300);
    assert.equal(await visible(laptop, OVERLAY.approval), false, 'and nothing comes back');
    await waitFor('home to hear it was removed', async () => !(await home.remote('status')).devices.some((d) => d.id === laptopId), 8000);
    await click(home, NO.approval);
    await finish();
  });
});
