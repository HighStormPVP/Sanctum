// The real mirror section of renderer.js, twice, a home PC and a laptop, joined by a stand-in link
// with the real 64 MiB buffer and 48 MiB frame limits, in virtual time. So a slow transfer, or ten
// minutes of waiting, takes moments, and what happens in between can be looked at. It's for the
// timing of snapshots and returned words. Anything about the screen, or the real link and relay,
// is for e2e/actions.e2e.js.
//
// The section's code runs unchanged. Everything it reaches for outside itself is either named in
// `overrides` below, or is a stub that takes any call and does nothing. MIRROR_SIM_ROOT runs it
// against another copy of the code, for checking that a test fails on an older one.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.MIRROR_SIM_ROOT || path.join(__dirname, '..');
const MIB = 1024 * 1024;
const LINK_BUFFER_BYTES = 64 * MIB;
const MAX_FRAME_BYTES = 48 * MIB;
const ACK_DELAY_MS = 30;

const source = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const SECTION = source.slice(source.indexOf('// ============== ACTING FROM A LAPTOP =============='), source.indexOf('// ============== CATALOG =============='));
const ChatMirror = require(path.join(ROOT, 'lib', 'chat-mirror.js'));
const RemoteRules = require(path.join(ROOT, 'lib', 'remote-rules.js'));
const SECTION_EXPORTS = ['mirror', 'mirrorOnFrame', 'mirrorOnStatus', 'markMirrorDirty', 'wireChatMirror', 'deliverReturnedWords', 'requestMirrorSnapshot', 'mirrorHome'];

function createWorld() {
  const world = { now: 1000000, queue: [], count: 0 };
  world.at = (t, fn) => {
    // Whole milliseconds, as Date.now gives. Ids are built from it.
    const event = { t: Math.max(Math.ceil(t), world.now), n: world.count++, fn, dead: false };
    world.queue.push(event);
    return event;
  };
  // Runs events in time order until the time given, or until stopWhen says so.
  world.run = async (until, stopWhen) => {
    for (;;) {
      if (stopWhen?.()) return true;
      let next = null;
      for (const event of world.queue) {
        if (!event.dead && (!next || event.t < next.t || (event.t === next.t && event.n < next.n))) next = event;
      }
      if (!next || next.t > until) {
        world.now = until;
        return false;
      }
      world.queue.splice(world.queue.indexOf(next), 1);
      world.now = next.t;
      next.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return world;
}

function createInstance(world) {
  const stub = new Proxy(function stub() {}, {
    get(_target, key) {
      if (key === 'value') return '';
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      return stub;
    },
    apply: () => stub,
    set: () => true,
    has: () => true
  });
  const instance = { toasts: [], audit: [], dead: false, link: null };
  const timers = new Map();
  let timerId = 1;
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(world.now);
    }

    static now() {
      return world.now;
    }
  }
  const cancel = (id) => {
    const event = timers.get(id);
    if (event) {
      event.dead = true;
      timers.delete(id);
    }
  };
  instance.state = {
    chats: {}, order: [], runningChats: new Map(), settings: { apiKeys: {} }, installed: new Set(['m']),
    hardware: { cpuModel: 'x', gpuName: 'y', vramGB: 1, totalRamGB: 1, fastBudgetGB: 1, maxBudgetGB: 1, budgetSource: 'ram' },
    activeId: null, pendingAttachments: [], remoteStatus: null, space: 'home'
  };
  const overrides = {
    state: instance.state,
    window: {
      api: {
        remote: {
          send: async (to, frame) => (instance.link ? instance.link(frame) : false),
          onStatus() {},
          onFrame() {},
          status: async () => null
        },
        audit: { log: async (entry) => { instance.audit.push(entry); } },
        platform: 'win32',
        shellInfo: { name: 'bash' }
      }
    },
    Date: VirtualDate,
    ChatMirror,
    RemoteRules,
    setTimeout(fn, ms) {
      const id = timerId++;
      timers.set(id, world.at(world.now + (ms || 0), () => {
        timers.delete(id);
        if (!instance.dead) fn();
      }));
      return id;
    },
    clearTimeout: cancel,
    setInterval(fn, ms) {
      const id = timerId++;
      const again = () => {
        if (instance.dead) return;
        fn();
        timers.set(id, world.at(world.now + ms, again));
      };
      timers.set(id, world.at(world.now + ms, again));
      return id;
    },
    clearInterval: cancel,
    showToast: (text) => instance.toasts.push({ t: world.now, text }),
    currentChat: () => null,
    chatsInCurrentSpace: () => [],
    console: { warn() {}, log() {}, error() {} }
  };
  // Names the section declares are its own. Any other it asks for comes from here.
  const scope = new Proxy({}, {
    has: (_target, key) => typeof key === 'string' && (key in overrides || !(key in globalThis)),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : (key in overrides ? overrides[key] : stub)),
    set(_target, key, value) {
      overrides[key] = value;
      return true;
    }
  });
  const body = `with (scope) { return (function () {\n${SECTION}\n; return { ${SECTION_EXPORTS.join(', ')} }; })(); }`;
  Object.assign(instance, new Function('scope', body)(scope));
  instance.wireChatMirror();
  return instance;
}

// Home to laptop is limited by a speed and the link's buffer. A refusal ends the session, as it
// does in the manager, and a new one follows. Laptop to home is quick and unlimited.
function createLink(world, bytesPerSecond) {
  const link = { generation: 0, buffered: 0, lastEnd: 0, overflows: 0, down: false };
  link.fromHome = (frame) => {
    if (link.down) return false;
    const text = JSON.stringify(frame);
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_FRAME_BYTES) return false;
    if (link.buffered + bytes > LINK_BUFFER_BYTES) {
      link.overflows += 1;
      link.onOverflow();
      return false;
    }
    link.buffered += bytes;
    const { generation } = link;
    const landsAt = Math.max(link.lastEnd, world.now) + (bytes / bytesPerSecond) * 1000;
    link.lastEnd = landsAt;
    world.at(landsAt, () => { if (generation === link.generation) link.toLaptop(text, frame); });
    world.at(landsAt + 5, () => { if (generation === link.generation) link.buffered -= bytes; });
    return true;
  };
  link.fromLaptop = (frame) => {
    if (link.down) return false;
    const text = JSON.stringify(frame);
    const { generation } = link;
    world.at(world.now + ACK_DELAY_MS, () => { if (generation === link.generation) link.toHome(text); });
    return true;
  };
  return link;
}

function startSim({ mbit }) {
  const world = createWorld();
  const home = createInstance(world);
  let laptop = createInstance(world);
  let laptopAway = false;
  const link = createLink(world, (mbit * 1000 * 1000) / 8);
  const sim = {
    world, home, link, frames: [], words: [], dropLaptopFrame: null, dropLaptopSend: null,
    get laptop() { return laptop; }
  };
  link.toLaptop = (text, frame) => {
    sim.frames.push({ t: world.now, ...frame, chats: frame.chats?.map((c) => c.id), text: sim.words.filter((w) => text.includes(w)) });
    if (laptopAway || sim.dropLaptopFrame?.(frame)) return;
    laptop.mirrorOnFrame('H', JSON.parse(text));
  };
  link.toHome = (text) => home.mirrorOnFrame('L', JSON.parse(text));
  home.link = (frame) => link.fromHome(frame);
  const connectLaptopEnd = (instance) => {
    instance.link = (frame) => (sim.dropLaptopSend?.(frame) ? true : link.fromLaptop(frame));
  };
  connectLaptopEnd(laptop);
  // This page has been up a while by the time anything connects.
  laptop.mirrorOnStatus({ devices: [] });
  sim.connect = () => {
    home.mirrorOnStatus({ name: 'Home', devices: [{ id: 'L', role: 'laptop', connected: true }] });
    laptop.mirrorOnStatus({ devices: [{ id: 'H', role: 'home', connected: true }] });
  };
  link.onOverflow = () => {
    link.generation += 1;
    link.buffered = 0;
    link.lastEnd = 0;
    link.down = true;
    home.mirrorOnStatus({ name: 'Home', devices: [{ id: 'L', role: 'laptop', connected: false }] });
    laptop.mirrorOnStatus({ devices: [{ id: 'H', role: 'home', connected: false }] });
    world.at(world.now + 500, () => {
      link.down = false;
      sim.connect();
    });
  };
  // A window reload: the session stays up, and whatever lands in the gap is lost.
  sim.reload = (gapMs = 800) => {
    laptop.dead = true;
    laptopAway = true;
    world.at(world.now + gapMs, () => {
      laptop = createInstance(world);
      connectLaptopEnd(laptop);
      laptopAway = false;
      laptop.mirrorOnStatus({ devices: [{ id: 'H', role: 'home', connected: true }] });
    });
  };
  sim.addChat = (id, mib, fields = {}) => {
    home.state.chats[id] = {
      id, title: `T-${id}`, model: 'm', modality: 'chat', createdAt: 1, updatedAt: 1, remoteControl: true,
      messages: [{ role: 'user', content: `${id}:${'z'.repeat(Math.floor(mib * MIB))}`, attachments: [] }],
      ...fields
    };
    home.state.order.push(id);
    return home.state.chats[id];
  };
  sim.addChats = (count, mib) => Array.from({ length: count }, (_, i) => sim.addChat(`c${i}`, mib).id);
  sim.chatOnLaptop = (id) => laptop.state.chats[`remote:H:${id}`];
  sim.paced = () => home.mirror.laptops.get('L')?.paced ?? null;
  sim.waiting = () => laptop.mirror.homes.get('H')?.awaitingSnapshot !== false;
  sim.whole = (ids) => () => ids.every((id) => sim.chatOnLaptop(id)) && !sim.paced() && !sim.waiting();
  sim.sameThread = (id) => {
    const c = sim.chatOnLaptop(id);
    return !!c && JSON.stringify(ChatMirror.snapshotChat(home.state.chats[id]).messages) === JSON.stringify(ChatMirror.snapshotChat(c).messages);
  };
  sim.snapshots = () => sim.frames.filter((f) => f.type === 'mirror-snapshot');
  sim.after = (ms) => world.now + ms;
  // Set off when the first part has landed, which is when a transfer is well under way.
  sim.firstPartLanded = () => sim.snapshots().length >= 1;
  return sim;
}

module.exports = { startSim, MIB };
