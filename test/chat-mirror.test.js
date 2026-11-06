const test = require('node:test');
const assert = require('node:assert');
const { snapshotChat, diffChat, applyOps } = require('../lib/chat-mirror.js');

const SECRET = 'sk-ant-canary-0123456789';

function baseChat() {
  return {
    id: 'c_1',
    title: 'Plans',
    model: 'qwen3:8b',
    modality: 'agent',
    createdAt: 1000,
    updatedAt: 2000,
    webEnabled: true,
    thinkingEnabled: true,
    planMode: false,
    approvalMode: false,
    noApproval: true,
    readOnly: false,
    noFetch: false,
    projectFolder: 'C:\\work\\plans',
    messages: [
      { role: 'user', content: 'first', modality: 'agent', attachments: [] },
      {
        role: 'assistant',
        content: 'an answer',
        modality: 'agent',
        toolEvents: [{ name: 'calc', argSummary: '1+1', status: 'done', resultSummary: '2' }],
        tokenStats: { prompt: 4, completion: 2, _exactCompletion: 2, live: false }
      },
      { role: 'user', content: 'second', modality: 'agent', attachments: [] }
    ]
  };
}

// What crossing the wire does to these: anything JSON can't carry goes.
const wire = (value) => JSON.parse(JSON.stringify(value));

// Starts a copy from `start`, and applies each step's diff to it, checking that the copy
// and the real thing agree after every step, as the two screens must.
function runScript(start, steps) {
  const real = start;
  const copy = wire(snapshotChat(real));
  let previous = snapshotChat(real);
  for (const [name, step] of Object.entries(steps)) {
    step(real);
    const next = snapshotChat(real);
    const unchanged = new Map();
    const ops = wire(diffChat(previous, next));
    for (const [i, m] of copy.messages.entries()) {
      const after = next.messages.find((n) => JSON.stringify(n) === JSON.stringify(m));
      if (after) unchanged.set(m, i);
    }
    assert.deepEqual(applyOps(copy, ops), { resync: false }, name);
    assert.deepEqual(wire(snapshotChat(copy)), wire(next), name);
    for (const m of unchanged.keys()) {
      assert.ok(copy.messages.includes(m), `${name}: an unchanged message kept its object`);
    }
    previous = next;
  }
  return copy;
}

// ---- snapshotChat ----

test('snapshotChat drops what only this machine should hold', () => {
  const chat = baseChat();
  chat.messages[0]._attachmentData = [{ kind: 'image', name: 'a.png', base64: 'QUJD-image-bytes', path: 'C:\\secret\\a.png' }];
  chat.messages[0]._videoAtt = { kind: 'video', name: 'v.mp4', path: 'C:\\secret\\v.mp4' };
  chat.messages[0].attachments = [{ kind: 'image', name: 'a.png', pages: 3, ext: 'png', path: 'C:\\secret\\a.png', base64: 'QUJD-image-bytes' }];
  chat.pathAllowlist = ['C:\\secret'];
  chat.commandAllowlist = ['rm -rf'];
  chat.videoAnalysis = { filename: 'v.mp4', frames: [{ thumbDataUrl: 'data:image/png;base64,QUJD-image-bytes' }] };

  const snap = snapshotChat(chat);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('_attachmentData'));
  assert.ok(!text.includes('_videoAtt'));
  assert.ok(!text.includes('QUJD-image-bytes'));
  assert.ok(!text.includes('secret'), text);
  assert.ok(!text.includes('rm -rf'));
  assert.ok(!text.includes('videoAnalysis'));
  // What the name and the size on screen need survives.
  assert.deepEqual(snap.messages[0].attachments, [{ kind: 'image', name: 'a.png', pages: 3, ext: 'png' }]);
});

test('snapshotChat carries no API key, wherever one has ended up', () => {
  const chat = baseChat();
  chat.apiKey = SECRET;
  chat.apiKeys = { anthropic: SECRET };
  chat.settings = { apiKeys: { anthropic: SECRET }, instructions: SECRET };
  chat.instructions = SECRET;
  chat.messages[1].apiKey = SECRET;
  chat.messages[1].payload = { apiKey: SECRET };
  chat.messages[1].toolEvents[0].args = { apiKey: SECRET };
  chat.messages[1].tokenStats.apiKey = SECRET;
  chat.messages[1].startup = { text: 'Waiting', startedAt: 5, apiKey: SECRET };
  chat.messages[1].videoState = { stage: 'probing', filename: 'v.mp4', apiKey: SECRET };
  assert.ok(!JSON.stringify(snapshotChat(chat)).includes(SECRET));
});

test('snapshotChat keeps everything the thread draws', () => {
  const chat = baseChat();
  const running = {
    role: 'assistant',
    content: '',
    modality: 'agent',
    routedTo: 'qwen2.5vl:7b',
    thinking: true,
    thinkingMode: true,
    startup: { text: 'Loading Qwen', startedAt: 1234 },
    silentSince: 5678,
    queued: true,
    tokenStats: { prompt: 1, completion: 2, _exactCompletion: 0, live: true },
    videoState: {
      stage: 'deps-missing',
      filename: 'v.mp4',
      deps: { ffmpeg: { found: true, version: '6.1', path: 'C:\\secret\\ffmpeg.exe' }, whisper: { found: false } }
    },
    toolEvents: [
      { name: '__think', status: 'running', startedAt: 10, ms: 20, chars: 30, tokens: 8 },
      { name: 'run_command', argSummary: 'ls', status: 'error', input: 'ls -la', output: 'no', exitCode: 1, resultSummary: 'failed' }
    ]
  };
  chat.messages.push(running);
  const snap = snapshotChat(chat).messages[3];
  const { videoState, ...rest } = snap;
  const { videoState: _v, ...expected } = running;
  assert.deepEqual(rest, expected);
  assert.deepEqual(videoState, {
    stage: 'deps-missing',
    filename: 'v.mp4',
    deps: { ffmpeg: { found: true, version: '6.1' }, whisper: { found: false } }
  });
});

test('snapshotChat keeps what the chat header draws', () => {
  const chat = baseChat();
  const { messages, ...snap } = snapshotChat(chat);
  const { messages: _m, ...expected } = chat;
  assert.deepEqual(snap, expected);
  assert.equal(messages.length, 3);
});

test('a snapshot does not change when the live chat does', () => {
  const chat = baseChat();
  const snap = snapshotChat(chat);
  chat.messages[1].toolEvents[0].status = 'error';
  chat.messages[1].tokenStats.prompt = 99;
  chat.messages[1].content = 'changed';
  assert.equal(snap.messages[1].toolEvents[0].status, 'done');
  assert.equal(snap.messages[1].tokenStats.prompt, 4);
  assert.equal(snap.messages[1].content, 'an answer');
});

test('a value of the wrong type is dropped, since the screen trusts these types', () => {
  // renderThinkEvent writes tokens.toLocaleString() into HTML unescaped, because it's a number.
  const chat = baseChat();
  chat.title = { evil: true };
  chat.messages[1].silentSince = '<img src=x>';
  chat.messages[1].toolEvents[0].tokens = '<img src=x>';
  chat.messages[1].videoState = { stage: 'extracting', framesDone: '<img src=x>', expectedFrames: Infinity };
  const snap = snapshotChat(chat);
  assert.ok(!('title' in snap));
  assert.ok(!JSON.stringify(snap).includes('<img'));
  assert.deepEqual(snap.messages[1].videoState, { stage: 'extracting' });
});

test('snapshotChat survives a chat with no messages array', () => {
  assert.deepEqual(snapshotChat({ id: 'x' }), { id: 'x', messages: [] });
});

// ---- diffChat ----

test('no change gives no ops', () => {
  assert.deepEqual(diffChat(snapshotChat(baseChat()), snapshotChat(baseChat())), []);
});

test('appended text is one msg-append, not a msg-update', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.messages[1].content += ' that grew';
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'msg-append', index: 1, baseLength: 9, text: ' that grew' }]);
});

test('text arriving on an empty message is a msg-append from zero', () => {
  const chat = baseChat();
  chat.messages[1].content = '';
  const before = snapshotChat(chat);
  chat.messages[1].content = 'h';
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'msg-append', index: 1, baseLength: 0, text: 'h' }]);
});

test('text that was rewritten rather than extended is a msg-update', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.messages[1].content = 'an ans';
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'msg-update', index: 1, set: { content: 'an ans' } }]);
});

test('text and a counter changing together stay separate, so the text can still be patched', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.messages[1].content += '!';
  chat.messages[1].tokenStats = { prompt: 4, completion: 3, _exactCompletion: 2, live: true };
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [
    { type: 'msg-append', index: 1, baseLength: 9, text: '!' },
    { type: 'msg-update', index: 1, set: { tokenStats: { prompt: 4, completion: 3, _exactCompletion: 2, live: true } } }
  ]);
});

test('only the tool events that changed are sent', () => {
  const chat = baseChat();
  const events = chat.messages[1].toolEvents;
  events.push({ name: 'run_command', status: 'done', output: 'x'.repeat(4000) });
  events.push({ name: '__think', status: 'running', startedAt: 10, chars: 4, tokens: 1 });
  const before = snapshotChat(chat);
  events[2].chars = 40;
  events[2].tokens = 10;
  const ops = diffChat(before, snapshotChat(chat));
  assert.deepEqual(ops, [
    { type: 'msg-update', index: 1, events: { from: 2, items: [{ name: '__think', status: 'running', startedAt: 10, chars: 40, tokens: 10 }] } }
  ]);
});

test('a change of title is a meta op carrying only that', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.title = 'Better';
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'meta', set: { title: 'Better' } }]);
});

test('a field that went away is unset', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  delete chat.projectFolder;
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'meta', unset: ['projectFolder'] }]);
});

test('a reply going in ahead of a queued message is one add in the right place', () => {
  const chat = baseChat();
  chat.messages[2].queued = true;
  const before = snapshotChat(chat);
  chat.messages.splice(2, 0, { role: 'assistant', content: '', thinking: true });
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [
    { type: 'msg-add', index: 2, message: { role: 'assistant', content: '', thinking: true } }
  ]);
});

test('removing a message from the middle is one remove', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.messages.splice(1, 1);
  assert.deepEqual(diffChat(before, snapshotChat(chat)), [{ type: 'msg-remove', index: 1 }]);
});

test('with no previous snapshot, the ops build the whole chat, starting with its meta', () => {
  const chat = baseChat();
  const ops = diffChat(null, snapshotChat(chat));
  assert.equal(ops[0].type, 'meta');
  assert.deepEqual(ops.slice(1).map((op) => op.type), ['msg-add', 'msg-add', 'msg-add']);
  const copy = { id: chat.id, messages: [] };
  assert.deepEqual(applyOps(copy, wire(ops)), { resync: false });
  assert.deepEqual(wire(snapshotChat(copy)), wire(snapshotChat(chat)));
});

test('the chat id is never an op, since the two ends file it under different ids', () => {
  const a = snapshotChat(baseChat());
  const b = { ...a, id: 'remote:device:c_1' };
  assert.deepEqual(diffChat(a, b), []);
  assert.ok(!('id' in diffChat(null, a)[0].set));
});

// ---- applying scripted sequences ----

test('a whole turn, step by step, leaves the copy equal to the original', () => {
  const reply = () => ({ role: 'assistant', content: '', modality: 'agent', toolEvents: [], thinking: true, thinkingMode: true });
  const last = (c) => c.messages[c.messages.length - 1];
  runScript(baseChat(), {
    'user message added': (c) => c.messages.push({ role: 'user', content: 'go', modality: 'agent', attachments: [{ kind: 'pdf', name: 'a.pdf', pages: 2 }] }),
    'reply starts': (c) => c.messages.push(reply()),
    'startup row': (c) => { last(c).startup = { text: 'Waiting for Qwen', startedAt: 100 }; },
    'startup text changes': (c) => { last(c).startup.text = 'Loading Qwen'; },
    'startup ends': (c) => { delete last(c).startup; },
    'thinking row': (c) => {
      last(c).thinking = false;
      last(c).toolEvents.push({ name: '__think', status: 'running', startedAt: 100, chars: 0, tokens: 0 });
    },
    'thinking counts': (c) => { last(c).toolEvents[0].chars = 40; last(c).toolEvents[0].tokens = 10; },
    'thinking ends': (c) => { last(c).toolEvents[0].status = 'done'; last(c).toolEvents[0].ms = 2300; },
    'silence notice': (c) => { last(c).silentSince = 500; },
    'silence ends': (c) => { delete last(c).silentSince; },
    'tool starts': (c) => last(c).toolEvents.push({ name: 'run_command', argSummary: 'echo', input: 'echo hi', status: 'running' }),
    'tool ends': (c) => { Object.assign(last(c).toolEvents[1], { status: 'done', resultSummary: 'ok', output: 'hi', exitCode: 0 }); },
    'text streams': (c) => { last(c).content = 'Hel'; },
    'text streams on': (c) => { last(c).content += 'lo **there**'; last(c).tokenStats = { prompt: 0, completion: 3, _exactCompletion: 0, live: true }; },
    'title changes': (c) => { c.title = 'Greeting'; },
    'round resets text': (c) => { last(c).content = ''; },
    'model and mode change': (c) => { c.model = 'other:1b'; c.noApproval = false; c.planMode = true; },
    'queued': (c) => c.messages.push({ role: 'user', content: 'later', modality: 'agent', attachments: [], queued: true }),
    'text streams with a queue behind': (c) => { c.messages[c.messages.length - 2].content = 'Again'; },
    'second queued': (c) => c.messages.push({ role: 'user', content: 'later still', modality: 'agent', attachments: [], queued: true }),
    'queue unblocks': (c) => {
      c.messages[c.messages.length - 2].queued = false;
      c.messages.splice(c.messages.length - 1, 0, reply());
    },
    'stop clears the queue': (c) => { c.messages = c.messages.filter((m) => !m.queued); },
    'video card': (c) => { last(c).videoState = { stage: 'extracting', framesDone: 1, expectedFrames: 9, durationSec: 4.5 }; },
    'video card goes': (c) => { last(c).videoState = null; },
    'remove from the middle': (c) => c.messages.splice(1, 1),
    'two far apart removed': (c) => { c.messages = c.messages.filter((_, i) => i !== 0 && i !== 2); },
    'tool events shrink': (c) => { last(c).toolEvents = []; },
    'everything goes': (c) => { c.messages = []; }
  });
});

test('object identity of a message survives streaming into it', () => {
  const chat = baseChat();
  const copy = wire(snapshotChat(chat));
  const [first, second, third] = copy.messages;
  const before = snapshotChat(chat);
  chat.messages[1].content += ' and more';
  chat.messages[1].toolEvents[0].status = 'error';
  chat.messages[1].thinking = true;
  applyOps(copy, wire(diffChat(before, snapshotChat(chat))));
  assert.equal(copy.messages[0], first);
  assert.equal(copy.messages[1], second, 'the changed message is still the same object, so el.__msg finds it');
  assert.equal(copy.messages[2], third);
  assert.equal(second.content, 'an answer and more');
});

test('a message going in or out leaves the others as the same objects', () => {
  const chat = baseChat();
  const copy = wire(snapshotChat(chat));
  const [first, second, third] = copy.messages;
  let before = snapshotChat(chat);
  chat.messages.splice(1, 0, { role: 'user', content: 'between' });
  applyOps(copy, wire(diffChat(before, snapshotChat(chat))));
  assert.deepEqual([copy.messages[0], copy.messages[2], copy.messages[3]], [first, second, third]);
  assert.equal(copy.messages[2], second);

  before = snapshotChat(chat);
  chat.messages = [chat.messages[1], chat.messages[3]];
  applyOps(copy, wire(diffChat(before, snapshotChat(chat))));
  assert.equal(copy.messages.length, 2);
  assert.equal(copy.messages[1], third);
});

test('applyOps does not hold on to what it was given', () => {
  const chat = baseChat();
  const before = snapshotChat(chat);
  chat.messages[1].toolEvents.push({ name: 'calc', status: 'running' });
  chat.messages[1].tokenStats = { prompt: 1, completion: 1, _exactCompletion: 0, live: true };
  const ops = diffChat(before, snapshotChat(chat));
  const copy = wire(before);
  applyOps(copy, ops);
  ops[0].events.items[0].status = 'changed';
  ops[0].set.tokenStats.prompt = 500;
  assert.equal(copy.messages[1].toolEvents[1].status, 'running');
  assert.equal(copy.messages[1].tokenStats.prompt, 1);
});

// ---- things going wrong ----

test('a msg-append with the wrong baseLength asks for a resync, and leaves the text alone', () => {
  const copy = wire(snapshotChat(baseChat()));
  assert.deepEqual(applyOps(copy, [{ type: 'msg-append', index: 1, baseLength: 3, text: 'x' }]), { resync: true });
  assert.equal(copy.messages[1].content, 'an answer');
});

test('ops that do not fit the chat ask for a resync', () => {
  const bad = [
    { type: 'msg-append', index: 99, baseLength: 0, text: 'x' },
    { type: 'msg-append', index: 1, baseLength: 9, text: 5 },
    { type: 'msg-update', index: 99, set: { content: 'x' } },
    { type: 'msg-update', index: 1, events: { from: 99, items: [] } },
    { type: 'msg-update', index: 1, events: { from: 0, items: 'nope' } },
    { type: 'msg-add', index: 99, message: { role: 'user', content: 'x' } },
    { type: 'msg-add', index: 0 },
    { type: 'msg-remove', index: -1 },
    { type: 'msg-remove', index: 1.5 },
    { type: 'not-a-type' },
    null
  ];
  for (const op of bad) {
    const copy = wire(snapshotChat(baseChat()));
    assert.deepEqual(applyOps(copy, [op]), { resync: true }, JSON.stringify(op));
    assert.deepEqual(copy, wire(snapshotChat(baseChat())), JSON.stringify(op));
  }
  assert.deepEqual(applyOps(wire(snapshotChat(baseChat())), 'nope'), { resync: true });
});

test('applyOps takes only known fields of known types, as the other end could be anything', () => {
  const copy = wire(snapshotChat(baseChat()));
  const ops = JSON.parse(`[
    {"type":"meta","set":{"__proto__":{"polluted":1},"id":"changed","remote":{"deviceId":"x"},"remoteControl":true,"title":"ok","model":5},"unset":["id","remote","messages"]},
    {"type":"msg-update","index":1,"set":{"__proto__":{"polluted":1},"_attachmentData":[1],"content":"new","silentSince":"bad"},"unset":["__proto__","role2"]},
    {"type":"msg-add","index":0,"message":{"__proto__":{"polluted":1},"role":"user","content":"x","apiKey":"y"}}
  ]`);
  const before = { id: copy.id };
  assert.deepEqual(applyOps(copy, ops), { resync: false });
  assert.equal(copy.id, before.id);
  assert.ok(Array.isArray(copy.messages));
  assert.ok(!('remote' in copy));
  assert.ok(!('remoteControl' in copy));
  assert.equal(copy.title, 'ok');
  assert.equal(copy.model, 'qwen3:8b');
  assert.equal({}.polluted, undefined);
  assert.equal(copy.polluted, undefined);
  assert.equal(copy.messages[2].content, 'new');
  assert.ok(!('_attachmentData' in copy.messages[2]));
  assert.ok(!('silentSince' in copy.messages[2]));
  assert.deepEqual(copy.messages[0], { role: 'user', content: 'x' });
});

// ---- Closed sets: these reach class names, and a paired home could send anything ----

const fs = require('node:fs');
const path = require('node:path');
const { cleanHome, FIELDS } = require('../lib/chat-mirror.js');

const HOSTILE = '<img src=x onerror=alert(1)>';

test('fields that reach markup or a class name take only the values the app uses', () => {
  const chat = baseChat();
  chat.modality = HOSTILE;
  Object.assign(chat.messages[1], { role: 'modal-overlay', modality: HOSTILE });
  chat.messages[1].toolEvents[0].status = 'modal-overlay';
  chat.messages[2].videoState = { stage: 'modal-overlay', filename: 'v.mp4' };
  const snap = snapshotChat(chat);
  assert.ok(!('modality' in snap));
  assert.ok(!('role' in snap.messages[1]));
  assert.ok(!('modality' in snap.messages[1]));
  assert.ok(!('status' in snap.messages[1].toolEvents[0]));
  assert.ok(!('videoState' in snap.messages[2]), 'a card with no known stage draws nothing');
});

test('applyOps holds the closed sets too', () => {
  const copy = wire(snapshotChat(baseChat()));
  applyOps(copy, [
    { type: 'meta', set: { modality: HOSTILE } },
    { type: 'msg-update', index: 1, set: { role: 'modal-overlay' }, events: { from: 0, items: [{ name: 'calc', status: HOSTILE }] } },
    { type: 'msg-add', index: 0, message: { role: HOSTILE, content: 'x', videoState: { stage: HOSTILE } } }
  ]);
  assert.equal(copy.modality, 'agent');
  assert.equal(copy.messages[2].role, 'assistant');
  assert.deepEqual(copy.messages[2].toolEvents, [{ name: 'calc' }]);
  assert.deepEqual(copy.messages[0], { content: 'x' });
});

// A value the app starts using and the mirror doesn't know would quietly vanish on a laptop.
test('every status, stage, role and modality the renderer sets is in the closed sets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const found = (pattern) => [...source.matchAll(pattern)].map((m) => m[1]);
  const stages = [
    ...found(/videoState(?:\.stage)? = \{?\s*(?:stage: )?'([a-z-]+)'/g),
    ...found(/videoState\.stage = '([a-z-]+)'/g),
    ...found(/videoState: \{ stage: '([a-z-]+)'/g),
    ...found(/videoState = \{\s*stage: '([a-z-]+)'/g),
    ...found(/v\.stage === '([a-z-]+)'/g)
  ];
  assert.ok(stages.length > 12, `found ${stages.length} stages`);
  for (const stage of stages) assert.ok(FIELDS.videoState.stage.has(stage), `stage ${stage}`);

  const statuses = [...found(/\bstatus: '([a-z-]+)'/g), ...found(/\b(?:ev|thinkEvent)\.status = '([a-z-]+)'/g)];
  const toolStatuses = statuses.filter((s) => !s.startsWith('blocked') && !s.startsWith('plan') && s !== 'denied');
  assert.ok(toolStatuses.length > 4);
  for (const status of toolStatuses) assert.ok(FIELDS.toolEvent.status.has(status), `status ${status}`);

  for (const role of found(/messages\.push\(\{ role: '([a-z]+)'/g)) assert.ok(FIELDS.message.role.has(role), `role ${role}`);
  for (const role of ['user', 'assistant', 'system']) assert.ok(FIELDS.message.role.has(role));

  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models.json'), 'utf8'));
  for (const key of Object.keys(catalog.categories)) assert.ok(FIELDS.chat.modality.has(key), `modality ${key}`);
  for (const key of ['chat', 'vision', 'image', 'video', 'code', 'agent', 'video-analysis']) assert.ok(FIELDS.chat.modality.has(key), `modality ${key}`);
});

// ---- cleanHome ----

test('cleanHome keeps what a real home PC sends', () => {
  const home = {
    name: 'Study PC',
    os: 'win32',
    shell: { name: 'Bash' },
    installedModels: ['qwen3:8b', 'llama3.2:3b'],
    cloudReady: { anthropic: true, google: false },
    hardware: { cpuModel: 'Ryzen', gpuName: 'RTX', vramGB: 12, totalRamGB: 32, fastBudgetGB: 12, maxBudgetGB: 22.4, budgetSource: 'vram' }
  };
  assert.deepEqual(cleanHome(wire(home)), home);
  assert.deepEqual(cleanHome({ ...home, hardware: null }), { ...home, hardware: null });
});

test('cleanHome takes nothing else, in any shape', () => {
  const blank = { name: '', os: null, shell: { name: '' }, installedModels: [], cloudReady: {}, hardware: null };
  for (const junk of [null, undefined, 5, 'x', [], {}]) assert.deepEqual(cleanHome(junk), blank);
  const home = cleanHome(JSON.parse(`{
    "__proto__": { "polluted": 1 },
    "name": 5, "os": "${'evil'}", "shell": { "name": ["x"], "path": "secret-path" }, "extra": "secret",
    "installedModels": ["ok", 5, { "a": 1 }, null],
    "cloudReady": { "anthropic": "sk-secret", "google": true, "__proto__": true },
    "hardware": { "cpuModel": 7, "vramGB": "12", "budgetSource": "<b>", "secret": "x" }
  }`));
  assert.deepEqual(home, {
    name: '', os: null, shell: { name: '' }, installedModels: ['ok'],
    cloudReady: { google: true }, hardware: {}
  });
  assert.equal({}.polluted, undefined);
  assert.ok(!JSON.stringify(home).includes('secret'));
});

// ---- Task 14, part 2: each device's folder, so a laptop can read its own ----

test("each device's folder is mirrored, and a hostile home can't put anything else there", () => {
  const chat = baseChat();
  chat.projectFolders = { abcdefghijklmnop: 'C:\\work\\laptop', qrstuvwxyz234567: '/Users/me/other', bad: '/x', ABCDEFGHIJKLMNOP: '/caps', empty234567abcde: '', tooLongxxxxxxxxxx: '/x' };
  const snap = snapshotChat(chat);
  assert.deepEqual(snap.projectFolders, { abcdefghijklmnop: 'C:\\work\\laptop', qrstuvwxyz234567: '/Users/me/other' }, 'only real device ids, and only text');

  const copy = { messages: [] };
  applyOps(copy, diffChat(null, snap));
  assert.deepEqual(copy.projectFolders, snap.projectFolders);

  // A change goes as a meta op, and a hostile one is cleaned the same way.
  const changed = { ...chat, projectFolders: { abcdefghijklmnop: '/new' } };
  applyOps(copy, diffChat(snap, snapshotChat(changed)));
  assert.deepEqual(copy.projectFolders, { abcdefghijklmnop: '/new' });
  applyOps(copy, [{ type: 'meta', set: { projectFolders: { abcdefghijklmnop: 5, ['__proto__']: '/x', zzzzzzzzzzzzzzzz: '/ok' } } }]);
  assert.deepEqual(copy.projectFolders, { zzzzzzzzzzzzzzzz: '/ok' });
  assert.equal(Object.getPrototypeOf(copy.projectFolders), Object.prototype);
  applyOps(copy, [{ type: 'meta', set: { projectFolders: 'nope' } }]);
  assert.equal(copy.projectFolders, undefined, 'not a map, so no folders');
  applyOps(copy, [{ type: 'meta', set: { projectFolders: { zzzzzzzzzzzzzzzz: '/ok' } } }, { type: 'meta', unset: ['projectFolders'] }]);
  assert.equal(copy.projectFolders, undefined);

  // No folders, no field.
  assert.equal('projectFolders' in snapshotChat({ ...chat, projectFolders: {} }), false);
  const many = {};
  for (let i = 0; i < 100; i++) many[String(i).padStart(16, 'a').replace(/[0189]/g, 'b')] = '/x';
  assert.ok(Object.keys(snapshotChat({ ...chat, projectFolders: many }).projectFolders || {}).length <= 64);
});
