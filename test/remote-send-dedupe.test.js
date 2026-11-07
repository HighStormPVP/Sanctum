// A laptop's send carries a client id, kept when the same words go again after a timeout, and the home
// PC runs each id once per chat. On the real code from renderer.js (see e2e/mirror-sim.js), with the
// frames going over the stand-in link, so they arrive the way a laptop's would.
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
const { startSim } = require('../e2e/mirror-sim.js');

let actions = 0;
function sendFrom(sim, args, chatId = 'c1') {
  actions += 1;
  const id = `a_send${actions}`;
  sim.laptop.link({ type: 'action', id, chatId, kind: 'send', args });
  return id;
}

async function connected() {
  const sim = startSim({ mbit: 20 });
  sim.addChat('c1', 0);
  sim.addChat('c2', 0);
  sim.connect();
  await sim.world.run(sim.after(2000));
  return sim;
}

const settle = (sim) => sim.world.run(sim.after(1000));
const answerTo = (sim, id) => sim.frames.find((f) => f.type === 'action-result' && f.id === id);
const runs = (sim) => sim.home.runs.map((r) => `${r.chatId}:${r.text}`);

test('the same send twice: one run, and the repeat gets the first one\'s answer', async () => {
  const sim = await connected();
  const clientId = nodeCrypto.randomUUID();
  const first = sendFrom(sim, { text: 'Hello', clientId });
  await settle(sim);
  const again = sendFrom(sim, { text: 'Hello', clientId });
  await settle(sim);
  assert.deepEqual(runs(sim), ['c1:Hello']);
  assert.equal(answerTo(sim, first).ok, true);
  assert.equal(answerTo(sim, again).ok, true, 'answered as the first was, so the laptop takes it as gone through');
});

test('an edited resend has a new id, so two runs', async () => {
  const sim = await connected();
  sendFrom(sim, { text: 'Hello', clientId: nodeCrypto.randomUUID() });
  await settle(sim);
  sendFrom(sim, { text: 'Hello, edited', clientId: nodeCrypto.randomUUID() });
  await settle(sim);
  assert.deepEqual(runs(sim), ['c1:Hello', 'c1:Hello, edited']);
});

test('ids are per chat, and a send with no id is never taken for a repeat', async () => {
  const sim = await connected();
  const clientId = nodeCrypto.randomUUID();
  sendFrom(sim, { text: 'Hello', clientId });
  sendFrom(sim, { text: 'Hello', clientId }, 'c2');
  sendFrom(sim, { text: 'Plain' });
  sendFrom(sim, { text: 'Plain' });
  await settle(sim);
  assert.deepEqual(runs(sim), ['c1:Hello', 'c2:Hello', 'c1:Plain', 'c1:Plain']);
});

test('a forged id that is not a UUID is refused by the action shape rule, and nothing runs', async () => {
  const sim = await connected();
  const id = sendFrom(sim, { text: 'Hello', clientId: 'not-a-uuid' });
  await settle(sim);
  assert.deepEqual(runs(sim), []);
  assert.equal(answerTo(sim, id).ok, false);
});

test('a send that was refused is not remembered, so the same words go once the problem is fixed', async () => {
  const sim = await connected();
  const clientId = nodeCrypto.randomUUID();
  sim.home.overrides.chatModelProblem = () => 'install';
  const refused = sendFrom(sim, { text: 'Hello', clientId });
  await settle(sim);
  assert.equal(answerTo(sim, refused).ok, false);
  sim.home.overrides.chatModelProblem = () => null;
  const again = sendFrom(sim, { text: 'Hello', clientId });
  await settle(sim);
  assert.equal(answerTo(sim, again).ok, true);
  assert.deepEqual(runs(sim), ['c1:Hello']);
});

test('home remembers the last 200 ids per chat', async () => {
  const sim = await connected();
  const ids = Array.from({ length: 201 }, () => nodeCrypto.randomUUID());
  ids.forEach((clientId, i) => sendFrom(sim, { text: `m${i}`, clientId }));
  await settle(sim);
  assert.equal(sim.home.runs.length, 201);
  sendFrom(sim, { text: 'm200', clientId: ids[200] });
  sendFrom(sim, { text: 'm1', clientId: ids[1] });
  await settle(sim);
  assert.equal(sim.home.runs.length, 201, 'the last 200 are still known');
  sendFrom(sim, { text: 'm0', clientId: ids[0] });
  await settle(sim);
  assert.deepEqual(runs(sim).slice(201), ['c1:m0'], 'the oldest has been forgotten');
});
