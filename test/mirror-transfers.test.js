// Snapshot transfers and returned words, on the real code from renderer.js in virtual time. See
// e2e/mirror-sim.js. Sizes are the smallest that show each thing: a chat over 8 MiB has a part
// to itself, and two parts of 9 MiB are a whole window at 18 MiB.
const test = require('node:test');
const assert = require('node:assert');
const { startSim, MIB } = require('../e2e/mirror-sim.js');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function unshare(sim, id) {
  sim.home.state.chats[id].remoteControl = false;
  sim.home.markMirrorDirty();
}

function reshare(sim, id) {
  sim.home.state.chats[id].remoteControl = true;
  sim.home.markMirrorDirty();
}

function say(sim, id, content) {
  sim.home.state.chats[id].messages.push({ role: 'user', content, attachments: [] });
  sim.home.markMirrorDirty(id);
}

// Six chats on their way, with the first part landed and the last chat's part not yet sent.
async function underWay(mbit = 20) {
  const sim = startSim({ mbit });
  const ids = sim.addChats(6, 9);
  sim.connect();
  await sim.world.run(sim.after(MINUTE), sim.firstPartLanded);
  assert.ok(sim.paced(), 'still sending');
  assert.ok(!sim.snapshots().some((f) => f.chats.includes(ids[5])));
  return { sim, ids };
}

// Runs for a moment, so that a tick can see what was just done.
const tick = (sim) => sim.world.run(sim.after(150));

test('words written during a transfer, then an unshare: they never reach the laptop', async () => {
  const { sim, ids } = await underWay();
  const x = ids[5];
  sim.words = ['WORDS-WRITTEN-DURING-THE-TRANSFER'];
  say(sim, x, sim.words[0]);
  await tick(sim);
  unshare(sim, x);
  const others = ids.slice(0, 5);
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(others)), 'the rest arrive');
  await sim.world.run(sim.after(30 * SECOND));
  assert.deepEqual(sim.frames.filter((f) => f.text.length).map((f) => f.type), []);
  assert.equal(sim.chatOnLaptop(x), undefined);
  assert.ok(others.every(sim.sameThread));
});

test('a rename then an unshare during a transfer leaves no chat on the laptop', async () => {
  const { sim, ids } = await underWay();
  const x = ids[5];
  sim.words = ['TITLE-CHANGED-DURING-THE-TRANSFER'];
  sim.home.state.chats[x].title = sim.words[0];
  sim.home.markMirrorDirty(x);
  await tick(sim);
  unshare(sim, x);
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(ids.slice(0, 5))));
  await sim.world.run(sim.after(30 * SECOND));
  assert.equal(sim.chatOnLaptop(x), undefined, 'it did not come back');
  assert.deepEqual(sim.frames.filter((f) => f.text.length).map((f) => f.type), []);
});

test('unshare then reshare during a transfer leaves the thread equal to the one at home', async () => {
  const { sim, ids } = await underWay();
  const x = ids[5];
  unshare(sim, x);
  await sim.world.run(sim.after(2 * SECOND));
  reshare(sim, x);
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(ids)));
  await sim.world.run(sim.after(MINUTE));
  assert.equal(sim.home.state.chats[x].messages.length, 1);
  assert.equal(sim.chatOnLaptop(x).messages.length, 1);
  assert.ok(ids.every(sim.sameThread));
});

test('a change to what is shared restarts the transfer: no more parts, and what was held goes at once', async () => {
  const { sim, ids } = await underWay();
  say(sim, ids[1], 'held for the end of the transfer');
  await tick(sim);
  assert.equal(sim.paced().held.length, 1);
  const sentBefore = sim.paced().next;
  const transfer = sim.paced().transfer;
  unshare(sim, ids[5]);
  await tick(sim);
  assert.equal(sim.paced().transfer, transfer);
  assert.equal(sim.paced().restart, true);
  assert.equal(sim.paced().held.length, 0, 'discarded immediately');

  // Until what's out there is acked, nothing else goes, and then a new transfer begins.
  while (sim.paced()?.transfer === transfer) {
    assert.equal(sim.paced().next, sentBefore);
    await sim.world.run(sim.after(100));
  }
  assert.equal(sim.paced().acked <= sim.paced().next, true);
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(ids.slice(0, 5))));
  assert.equal(sim.link.overflows, 0);
  assert.ok(ids.slice(0, 5).every(sim.sameThread), 'including what was said, from the new snapshot');
});

test('a removal goes ahead of the transfer, and parts already in the link do not bring the chat back', async () => {
  const { sim, ids } = await underWay();
  // The part in flight when this happens holds this chat, and lands first.
  const inLink = sim.paced().parts[sim.paced().acked + (sim.paced().next > sim.paced().acked + 1 ? 1 : 0)].entries[0].id;
  unshare(sim, inLink);
  const removed = await sim.world.run(sim.after(MINUTE), () => sim.frames.some((f) => f.type === 'mirror-remove'));
  assert.ok(removed);
  assert.equal(sim.chatOnLaptop(inLink), undefined);
  assert.ok(sim.paced(), 'and it did not wait for the transfer');
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(ids.filter((c) => c !== inLink))));
  await sim.world.run(sim.after(30 * SECOND));
  assert.equal(sim.chatOnLaptop(inLink), undefined);
});

test('on the laptop, nothing from a chat removed during a transfer gets in, until a new transfer says so', async () => {
  const sim = startSim({ mbit: 1000 });
  sim.connect();
  const { laptop } = sim;
  const frame = (fields) => laptop.mirrorOnFrame('H', { type: 'mirror-snapshot', now: 0, home: {}, ...fields });
  const chat = (id) => ({ id, title: id, messages: [{ role: 'user', content: `words of ${id}` }] });
  frame({ seq: 10, transfer: 7, part: 1, of: 3, chats: [chat('a'), chat('x')] });
  assert.ok(sim.chatOnLaptop('x'));
  laptop.mirrorOnFrame('H', { type: 'mirror-remove', seq: 11, chatId: 'x' });
  assert.equal(sim.chatOnLaptop('x'), undefined, 'it goes at once');

  // A part from that transfer, landing after the removal.
  frame({ seq: 12, transfer: 7, part: 2, of: 3, chats: [chat('x'), chat('b')] });
  assert.equal(sim.chatOnLaptop('x'), undefined, 'a part does not bring it back');
  assert.ok(sim.chatOnLaptop('b'));
  frame({ seq: 13, transfer: 7, part: 3, of: 3, chats: [] });
  assert.equal(sim.chatOnLaptop('x'), undefined);
  assert.equal(laptop.mirror.homes.get('H').awaitingSnapshot, false);

  // Ops, before a new transfer has started.
  laptop.mirrorOnFrame('H', { type: 'mirror-ops', seq: 14, chatId: 'x', ops: [{ type: 'meta', set: { title: 'Back from the dead' } }] });
  assert.equal(sim.chatOnLaptop('x'), undefined, 'nor do ops');

  // A new transfer comes from after the removal, so what's in it is shared now.
  frame({ seq: 15, transfer: 8, part: 1, of: 1, chats: [chat('a'), chat('b'), chat('x')] });
  assert.ok(sim.chatOnLaptop('x'), 'shared again');
  assert.equal(sim.chatOnLaptop('x').messages.length, 1);
});

test('a chat shared during a transfer arrives complete and in order', async () => {
  const { sim, ids } = await underWay();
  const added = sim.addChat('new', 1).id;
  sim.home.markMirrorDirty(added);
  await sim.world.run(sim.after(3 * SECOND));
  say(sim, added, 'second');
  await sim.world.run(sim.after(3 * SECOND));
  sim.home.state.chats[added].messages[1].content += ' and more';
  sim.home.markMirrorDirty(added);
  const all = [...ids, added];
  assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(all)));
  await sim.world.run(sim.after(5 * SECOND));
  assert.ok(all.every(sim.sameThread));
  assert.deepEqual(sim.chatOnLaptop(added).messages.map((m) => m.content.slice(0, 16)), [sim.home.state.chats[added].messages[0].content.slice(0, 16), 'second and more']);
  assert.equal(sim.link.overflows, 0);
});

test('a page reload that loses a part recovers in moments, whichever part it was', async () => {
  for (const at of [500, 2000, 4000, 6000]) {
    const sim = startSim({ mbit: 50 });
    const ids = sim.addChats(6, 13);
    sim.connect();
    await sim.world.run(sim.after(at));
    sim.reload();
    const lostFrom = sim.world.now;
    const done = await sim.world.run(sim.after(MINUTE), sim.whole(ids));
    const lost = sim.snapshots().filter((f) => f.t >= lostFrom && f.t < lostFrom + 800).length;
    assert.ok(done, `a reload at ${at} ms, which lost ${lost} parts, was not whole within a minute`);
    assert.deepEqual(sim.laptop.toasts, [], 'and it never had to say anything');
    assert.ok(ids.every(sim.sameThread));
    assert.equal(sim.link.overflows, 0);
  }
});

test('a reload says so only once, and other re-asks during a transfer stay ignored', async () => {
  const { sim } = await underWay(5);
  const asks = [];
  sim.dropLaptopSend = (frame) => {
    if (frame.type === 'mirror-resync-request') asks.push(frame.reload === true);
    return false;
  };
  const before = sim.paced().transfer;
  sim.home.mirrorOnFrame('L', { type: 'mirror-resync-request' });
  await tick(sim);
  assert.equal(sim.paced().restart, false, 'a plain request means nothing during a transfer');
  assert.equal(sim.paced().transfer, before);
  sim.reload(100);
  await sim.world.run(sim.after(2 * SECOND));
  assert.deepEqual(asks, [true], 'a page that has just loaded says so, once');
  assert.equal(sim.paced().transfer === before ? sim.paced().restart : true, true, 'and that one counts');
});

test('a 20 MiB word beside a 46 MiB part waits its turn, and the session stays up', async () => {
  const sim = startSim({ mbit: 20 });
  const [chat] = sim.addChats(1, 46);
  sim.connect();
  await sim.world.run(sim.after(2 * SECOND));
  assert.ok(sim.paced());
  sim.home.deliverReturnedWords('L', { type: 'queued-returned', chatId: chat, text: 'w'.repeat(20 * MIB), hadAttachments: false });
  await sim.world.run(sim.after(5 * MINUTE), () => sim.home.mirror.undelivered.size === 0 && !sim.paced());
  assert.equal(sim.link.overflows, 0);
  assert.equal(sim.home.mirror.undelivered.size, 0);
  assert.equal(sim.chatOnLaptop(chat)._returned.text.length, 20 * MIB, 'and the word got there');
});

test('a part waits for a word that is still in flight, and the word counts until it is acknowledged', async () => {
  const sim = startSim({ mbit: 20 });
  const [chat] = sim.addChats(1, 46);
  sim.connect();
  assert.ok(await sim.world.run(sim.after(5 * MINUTE), sim.whole([chat])));
  sim.frames.length = 0;
  sim.home.deliverReturnedWords('L', { type: 'queued-returned', chatId: chat, text: 'w'.repeat(20 * MIB), hadAttachments: false });
  await sim.world.run(sim.after(2 * SECOND));
  // A snapshot asked for, with the word still crossing the link.
  sim.home.mirrorOnFrame('L', { type: 'mirror-resync-request' });
  await sim.world.run(sim.after(SECOND));
  assert.ok(sim.paced(), 'the transfer has begun');
  assert.equal(sim.paced().next, 0, 'and its part is waiting for the word');
  assert.ok(await sim.world.run(sim.after(5 * MINUTE), sim.whole([chat])));
  assert.equal(sim.link.overflows, 0);
  assert.equal(sim.home.mirror.undelivered.size, 0);
  assert.deepEqual(sim.frames.map((f) => f.type).filter((type) => type !== 'mirror-run'), ['queued-returned', 'mirror-snapshot']);
});

test('held words: never the newest, up to 32 MiB per device, oldest first, with a line in the audit log', async () => {
  const sim = startSim({ mbit: 1000 });
  const deliver = (i, mib) => sim.home.deliverReturnedWords('nobody', { type: 'queued-returned', chatId: 'c', text: `${i}:${'x'.repeat(mib * MIB)}`, hadAttachments: false });
  const held = () => [...sim.home.mirror.undelivered.get('nobody').values()].map((f) => f.text[0]);
  deliver(1, 13);
  deliver(2, 13);
  assert.deepEqual(held(), ['1', '2']);
  assert.equal(sim.home.audit.length, 0);
  deliver(3, 13);
  assert.deepEqual(held(), ['2', '3'], 'the oldest went');
  assert.deepEqual(sim.home.audit.map((e) => e.kind), ['queued-words-dropped']);
  assert.ok(!JSON.stringify(sim.home.audit).includes('xxx'));
  // A word over the cap by itself isn't evicted. It's the newest.
  deliver(4, 33);
  assert.deepEqual(held(), ['4']);
  assert.equal(sim.home.audit.length, 3);
});

test('a second send failure while a retry is waiting leaves no transfer to wait out', async () => {
  const sim = startSim({ mbit: 50 });
  const ids = sim.addChats(2, 1);
  const send = sim.home.link;
  let failing = false;
  sim.home.link = (frame) => (failing ? false : send(frame));
  sim.connect();
  assert.ok(await sim.world.run(sim.after(MINUTE), sim.whole(ids)));
  await sim.world.run(sim.after(2 * SECOND));

  // One failure, which sets a retry going.
  failing = true;
  say(sim, ids[0], 'cannot go');
  await sim.world.run(sim.after(200));
  // A transfer starts before that retry fires, and its first part fails too.
  sim.home.mirrorOnFrame('L', { type: 'mirror-resync-request' });
  await sim.world.run(sim.after(200));
  assert.equal(sim.paced(), null, 'no ack is coming for what was never sent');
  failing = false;

  const caughtUp = await sim.world.run(sim.after(MINUTE), () => !sim.paced() && ids.every(sim.sameThread));
  assert.ok(caughtUp, 'caught up, long before the ten-minute limit');
});

test('every size arrives whole with no overflow, at slow speeds', async () => {
  for (const mbit of [20, 50]) {
    for (const [count, mib] of [[6, 13], [2, 35], [1, 40], [3, 24]]) {
      const sim = startSim({ mbit });
      const ids = sim.addChats(count, mib);
      sim.connect();
      assert.ok(await sim.world.run(sim.after(10 * MINUTE), sim.whole(ids)), `${count} x ${mib} MiB at ${mbit} Mbit/s`);
      assert.equal(sim.link.overflows, 0);
      assert.equal(sim.snapshots().filter((f) => f.part === 1).length, 1);
    }
  }
});
