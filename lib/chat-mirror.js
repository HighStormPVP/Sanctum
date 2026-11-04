// How a chat at home becomes the same chat on a laptop. Loaded by the renderer through a
// <script> tag, as ChatMirror, and by test/chat-mirror.test.js through require.
//
// The renderer changes chat state in about 70 places, and missing one would make the two
// screens drift. So nothing here hears about changes. The home PC takes a snapshot, compares
// it with the last one it sent, and sends the difference. A change can't be missed, because
// nothing has to report it.
//
// A SNAPSHOT IS AN ALLOWLIST. Each field below is named with the type the screen relies on,
// and everything else stays behind: a field added to a chat later is private until it's added
// here. That is what keeps API keys, attachment bytes and paths at home. The same function
// cleans what arrives on the laptop, where some of these values go into HTML unescaped because
// they're numbers, so a value of the wrong type is dropped at both ends.
//
// Not mirrored: c.videoAnalysis (frames, transcript, paths), so the timeline strip under a
// finished video shows only at home. Also c.pathAllowlist and c.commandAllowlist, which the
// thread doesn't draw.
//
// OPS, in the order they're applied:
//   { type:'meta', set?, unset? }                    chat fields
//   { type:'msg-add', index, message }               goes in before what's at index
//   { type:'msg-append', index, baseLength, text }   streamed text
//   { type:'msg-update', index, set?, unset?, events? }
//   { type:'msg-remove', index }
// `events` is { from, items }: the tool events from that position on are replaced, so a live
// thinking count doesn't resend every finished card before it.
//
// applyOps changes message objects in place. The renderer finds a message's element through
// el.__msg === msg, so an object replaced here would stop updating on screen.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ChatMirror = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TEXT = 'string';
  const NUMBER = 'number';
  const FLAG = 'boolean';

  const CHAT_FIELDS = {
    title: TEXT, model: TEXT, modality: TEXT, createdAt: NUMBER, updatedAt: NUMBER,
    webEnabled: FLAG, thinkingEnabled: FLAG,
    planMode: FLAG, approvalMode: FLAG, noApproval: FLAG, readOnly: FLAG, noFetch: FLAG,
    projectFolder: TEXT
  };
  const MESSAGE_FIELDS = {
    role: TEXT, content: TEXT, modality: TEXT, routedTo: TEXT,
    thinking: FLAG, thinkingMode: FLAG, silentSince: NUMBER, queued: FLAG
  };
  const STARTUP_FIELDS = { text: TEXT, startedAt: NUMBER };
  const TOKEN_STATS_FIELDS = { prompt: NUMBER, completion: NUMBER, _exactCompletion: NUMBER, live: FLAG };
  const ATTACHMENT_FIELDS = { kind: TEXT, name: TEXT, pages: NUMBER, ext: TEXT };
  const TOOL_EVENT_FIELDS = {
    name: TEXT, argSummary: TEXT, status: TEXT, input: TEXT, output: TEXT, resultSummary: TEXT,
    exitCode: NUMBER, startedAt: NUMBER, ms: NUMBER, chars: NUMBER, tokens: NUMBER
  };
  const VIDEO_STATE_FIELDS = {
    stage: TEXT, filename: TEXT, dep: TEXT, log: TEXT, ok: FLAG,
    durationSec: NUMBER, framesDone: NUMBER, expectedFrames: NUMBER, hashDone: NUMBER,
    totalFrames: NUMBER, uniqueFrames: NUMBER, captionDone: NUMBER
  };
  const VIDEO_DEP_FIELDS = { found: FLAG, version: TEXT };

  // What a message holds besides the plain fields, each with how to clean it.
  const MESSAGE_PARTS = {
    startup: (value) => (isObject(value) ? pick(value, STARTUP_FIELDS) : undefined),
    tokenStats: (value) => (isObject(value) ? pick(value, TOKEN_STATS_FIELDS) : undefined),
    attachments: (value) => (Array.isArray(value) ? value.filter(isObject).map((a) => pick(a, ATTACHMENT_FIELDS)) : undefined),
    toolEvents: (value) => (Array.isArray(value) ? value.filter(isObject).map(cleanToolEvent) : undefined),
    videoState: (value) => (isObject(value) ? cleanVideoState(value) : undefined)
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function pick(source, fields) {
    const out = {};
    for (const key in fields) {
      if (!hasOwn(source, key)) continue;
      const value = source[key];
      if (typeof value !== fields[key]) continue;
      if (fields[key] === NUMBER && !Number.isFinite(value)) continue;
      out[key] = value;
    }
    return out;
  }

  function cleanToolEvent(event) {
    return pick(event, TOOL_EVENT_FIELDS);
  }

  function cleanVideoState(state) {
    const out = pick(state, VIDEO_STATE_FIELDS);
    if (isObject(state.deps)) {
      out.deps = {};
      for (const name of ['ffmpeg', 'whisper']) {
        if (isObject(state.deps[name])) out.deps[name] = pick(state.deps[name], VIDEO_DEP_FIELDS);
      }
    }
    return out;
  }

  function snapshotMessage(message) {
    const out = pick(message, MESSAGE_FIELDS);
    for (const key in MESSAGE_PARTS) {
      if (!hasOwn(message, key)) continue;
      const part = MESSAGE_PARTS[key](message[key]);
      if (part !== undefined) out[key] = part;
    }
    return out;
  }

  function snapshotChat(chat) {
    const out = pick(chat, CHAT_FIELDS);
    if (typeof chat.id === TEXT) out.id = chat.id;
    out.messages = Array.isArray(chat.messages) ? chat.messages.filter(isObject).map(snapshotMessage) : [];
    return out;
  }

  // ---- Comparing ----

  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!hasOwn(b, key) || !same(a[key], b[key])) return false;
    }
    return true;
  }

  // Fields that differ between two flat records. Null means none do.
  function fieldChanges(before, after, skip) {
    let set = null;
    let unset = null;
    for (const key of Object.keys(after)) {
      if (key === skip) continue;
      if (!same(before[key], after[key])) (set ??= {})[key] = after[key];
    }
    for (const key of Object.keys(before)) {
      if (key !== skip && !hasOwn(after, key)) (unset ??= []).push(key);
    }
    if (!set && !unset) return null;
    const out = {};
    if (set) out.set = set;
    if (unset) out.unset = unset;
    return out;
  }

  function diffToolEvents(before, after) {
    let from = 0;
    while (from < before.length && from < after.length && same(before[from], after[from])) from++;
    if (from === before.length && from === after.length) return null;
    return { from, items: after.slice(from) };
  }

  function updateOps(index, before, after) {
    const ops = [];
    let afterRest = after;
    if (typeof before.content === TEXT && typeof after.content === TEXT
      && after.content.length > before.content.length && after.content.startsWith(before.content)) {
      ops.push({ type: 'msg-append', index, baseLength: before.content.length, text: after.content.slice(before.content.length) });
      afterRest = { ...after, content: before.content };
    }
    let events = null;
    if (Array.isArray(before.toolEvents) && Array.isArray(after.toolEvents)) {
      events = diffToolEvents(before.toolEvents, after.toolEvents);
      afterRest = { ...afterRest, toolEvents: before.toolEvents };
    }
    const changes = fieldChanges(before, afterRest);
    if (changes || events) {
      const op = { type: 'msg-update', index };
      if (changes) Object.assign(op, changes);
      if (events) op.events = events;
      ops.push(op);
    }
    return ops;
  }

  // How far to look for a message that has moved. Only what lies between the unchanged start
  // and the unchanged end gets this far, and that's rarely more than a message or two, so
  // this only bounds a chat that was replaced wholesale.
  const LOOK_AHEAD = 32;

  function findWithin(list, from, end, wanted) {
    const stop = Math.min(end, from + LOOK_AHEAD);
    for (let i = from; i < stop; i++) {
      if (same(list[i], wanted)) return i;
    }
    return -1;
  }

  // Messages have no ids, so they're lined up by what's in them. The array being built up is
  // final to the left of `to`, which makes `to` the right index for each op.
  function diffMessages(before, after, ops) {
    let start = 0;
    while (start < before.length && start < after.length && same(before[start], after[start])) start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && same(before[endBefore - 1], after[endAfter - 1])) {
      endBefore--;
      endAfter--;
    }

    let from = start;
    let to = start;
    while (from < endBefore || to < endAfter) {
      if (from >= endBefore) {
        ops.push({ type: 'msg-add', index: to, message: after[to] });
        to++;
      } else if (to >= endAfter) {
        ops.push({ type: 'msg-remove', index: to });
        from++;
      } else if (same(before[from], after[to])) {
        from++;
        to++;
      } else if (findWithin(after, to + 1, endAfter, before[from]) >= 0) {
        // This old message is still there further on, so what's here now is new.
        ops.push({ type: 'msg-add', index: to, message: after[to] });
        to++;
      } else if (findWithin(before, from + 1, endBefore, after[to]) >= 0) {
        // This new message was already there further on, so what's here now has gone.
        ops.push({ type: 'msg-remove', index: to });
        from++;
      } else {
        ops.push(...updateOps(to, before[from], after[to]));
        from++;
        to++;
      }
    }
  }

  // With no previous snapshot, the ops build the whole chat. The chat's id is left out, since
  // the two ends file it under different ids and each frame says which chat it's about.
  function diffChat(previous, next) {
    const ops = [];
    const meta = fieldChanges(previous ?? {}, next, 'messages');
    if (meta?.set) delete meta.set.id;
    if (meta?.set && !Object.keys(meta.set).length) delete meta.set;
    if (meta?.unset) meta.unset = meta.unset.filter((key) => key !== 'id');
    if (meta?.unset && !meta.unset.length) delete meta.unset;
    if (meta && (meta.set || meta.unset)) ops.push({ type: 'meta', ...meta });
    diffMessages(previous?.messages ?? [], next.messages, ops);
    return ops;
  }

  // ---- Applying ----

  const validIndex = (index, length) => Number.isInteger(index) && index >= 0 && index < length;

  function removeFields(target, keys, allowed) {
    if (!Array.isArray(keys)) return;
    for (const key of keys) {
      if (typeof key === TEXT && hasOwn(allowed, key)) delete target[key];
    }
  }

  const MESSAGE_KEYS = { ...MESSAGE_FIELDS, ...MESSAGE_PARTS };

  function applyEvents(message, events) {
    const list = message.toolEvents;
    if (!isObject(events) || !Array.isArray(list) || !Array.isArray(events.items)) return false;
    if (!Number.isInteger(events.from) || events.from < 0 || events.from > list.length) return false;
    list.splice(events.from, list.length - events.from, ...events.items.filter(isObject).map(cleanToolEvent));
    return true;
  }

  function applyOp(chat, op) {
    if (!isObject(op)) return false;
    const { messages } = chat;
    switch (op.type) {
      case 'meta':
        if (isObject(op.set)) Object.assign(chat, pick(op.set, CHAT_FIELDS));
        removeFields(chat, op.unset, CHAT_FIELDS);
        return true;
      case 'msg-add':
        if (!Number.isInteger(op.index) || op.index < 0 || op.index > messages.length || !isObject(op.message)) return false;
        messages.splice(op.index, 0, snapshotMessage(op.message));
        return true;
      case 'msg-append': {
        const message = messages[op.index];
        if (!validIndex(op.index, messages.length) || typeof op.text !== TEXT) return false;
        if (typeof message.content !== TEXT || message.content.length !== op.baseLength) return false;
        message.content += op.text;
        return true;
      }
      case 'msg-update': {
        if (!validIndex(op.index, messages.length)) return false;
        const message = messages[op.index];
        if (op.events !== undefined && !applyEvents(message, op.events)) return false;
        if (isObject(op.set)) Object.assign(message, snapshotMessage(op.set));
        removeFields(message, op.unset, MESSAGE_KEYS);
        return true;
      }
      case 'msg-remove':
        if (!validIndex(op.index, messages.length)) return false;
        messages.splice(op.index, 1);
        return true;
      default:
        return false;
    }
  }

  // `resync` means the ops didn't fit this chat, which means the two ends have already parted
  // ways. Only a new snapshot can repair that.
  function applyOps(chat, ops) {
    if (!Array.isArray(ops)) return { resync: true };
    if (!Array.isArray(chat.messages)) chat.messages = [];
    for (const op of ops) {
      if (!applyOp(chat, op)) return { resync: true };
    }
    return { resync: false };
  }

  return { snapshotChat, diffChat, applyOps };
});
