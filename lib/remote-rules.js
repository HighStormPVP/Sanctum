// What a paired laptop may ask a home PC to do. Loaded by the renderer through a <script> tag,
// as RemoteRules, and by test/remote-rules.test.js through require.
//
// A frame can hold anything, so an action is checked as hostile input before anything reads
// it: a closed list of kinds, a closed list of fields for each, every field's type and range.
// An unknown field refuses the frame rather than being ignored, so nothing can come to matter
// by accident later. What a chat ends up holding is decided by the handlers in renderer.js,
// which take named fields out of args and never pass a frame's object along.
//
// Nothing here can name the laptop control switch, API keys, settings, global instructions,
// the service address, the PIN, pairing, or removing a device. They have no kind, and no field
// reaches them.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RemoteRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
  const MAX_ATTACHMENTS = 32;
  const MAX_NAME = 1024;
  const MAX_TITLE = 500;
  const MAX_MODEL = 256;
  const MAX_PATH = 4096;
  const MAX_CHAT_ID = 256;
  const MAX_PAGES = 1000000;
  // As deep as an honest frame goes: frame, args, attachments, attachment.
  const MAX_DEPTH = 4;

  const VIDEO_REFUSED = "Videos can't be sent from this device yet. Attach it on the home PC.";
  const TOO_LARGE = 'That is too much to send from this device. A message can carry up to 25 MB.';

  const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
  const EXTENSION = /^[A-Za-z0-9]{0,32}$/;
  // No folder name needs one, and a NUL could cut a path short.
  const CONTROL = /[\u0000-\u001f\u007f]/;

  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const MODES = new Set(['plan', 'approval', 'noApproval']);
  const TOGGLES = new Set(['webEnabled', 'thinkingEnabled', 'readOnly', 'noFetch']);
  const NEW_CHAT_MODALITIES = new Set(['chat', 'agent']);
  const ATTACHMENT_KINDS = new Set(['image', 'pdf', 'text', 'file']);

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function isString(value, max) {
    return typeof value === 'string' && value.length <= max;
  }

  function isSomeText(value, max) {
    return isString(value, max) && value.trim().length > 0;
  }

  // Without a key that could reach an object's prototype, and no deeper than an action goes.
  // Own keys are the right ones to look at: JSON.parse makes __proto__ an own key.
  function isCleanShape(value, depth) {
    if (value === null || typeof value !== 'object') return true;
    if (depth > MAX_DEPTH) return false;
    if (Array.isArray(value)) return value.every((item) => isCleanShape(item, depth + 1));
    return Object.keys(value).every((key) => !FORBIDDEN_KEYS.has(key) && isCleanShape(value[key], depth + 1));
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
  }

  // A plain absolute path. Not a network or device path, which would make this machine reach
  // out to wherever it names, and no way of walking out of what it appears to name. Which kind
  // of machine this is doesn't matter here: the wrong form is just a folder that isn't there.
  function isLocalAbsolutePath(value) {
    if (!isString(value, MAX_PATH) || !value || CONTROL.test(value)) return false;
    const drive = /^[A-Za-z]:[\\/]/.test(value);
    if (!drive && !/^\/(?![\\/])/.test(value)) return false;
    // A colon past the drive is a stream on NTFS.
    if (drive && value.indexOf(':', 2) !== -1) return false;
    return !value.split(/[\\/]/).includes('..');
  }

  // What's being sent, or the size of the file if that says more: a size can't talk its way
  // past the bytes, and a file too large to send can't come along as just its name.
  function bytesIn(attachment) {
    if (!isObject(attachment)) return 0;
    let sent = 0;
    if (typeof attachment.base64 === 'string') sent = Math.floor((attachment.base64.length * 3) / 4);
    else if (typeof attachment.text === 'string') sent = attachment.text.length;
    const stated = Number.isFinite(attachment.size) && attachment.size > 0 ? attachment.size : 0;
    return Math.max(sent, stated);
  }

  // Why these can't go in one message from a laptop, in words for the person, or null. Runs on
  // the laptop before anything is sent, and at home on whatever arrives.
  function attachmentProblem(attachments, textLength = 0) {
    if (!Array.isArray(attachments)) return null;
    if (attachments.some((a) => isObject(a) && a.kind === 'video')) return VIDEO_REFUSED;
    let total = textLength;
    for (const attachment of attachments) total += bytesIn(attachment);
    return total > MAX_MESSAGE_BYTES ? TOO_LARGE : null;
  }

  function isAllowedAttachment(a) {
    if (!isObject(a) || !ATTACHMENT_KINDS.has(a.kind)) return false;
    // A path is in this list only so it can be dropped. See cleanAttachment.
    if (!hasOnlyKeys(a, ['kind', 'name', 'base64', 'text', 'pages', 'ext', 'size', 'path'])) return false;
    if (!isString(a.name, MAX_NAME) || !a.name) return false;
    if ('size' in a && !(Number.isFinite(a.size) && a.size >= 0)) return false;
    if ('ext' in a && !(typeof a.ext === 'string' && EXTENSION.test(a.ext))) return false;
    if ('pages' in a && !(Number.isSafeInteger(a.pages) && a.pages >= 0 && a.pages <= MAX_PAGES)) return false;
    if ('text' in a && typeof a.text !== 'string') return false;
    if ('base64' in a && !(typeof a.base64 === 'string' && BASE64.test(a.base64))) return false;
    if (a.kind === 'image') return typeof a.base64 === 'string';
    if (a.kind === 'pdf') return typeof a.text === 'string' && 'pages' in a;
    if (a.kind === 'text') return typeof a.text === 'string';
    return true;
  }

  function isAllowedSend(args) {
    if (!isObject(args) || !hasOnlyKeys(args, ['text', 'attachments'])) return false;
    if (typeof args.text !== 'string') return false;
    const { attachments } = args;
    if (attachments !== undefined) {
      if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) return false;
      if (!attachments.every(isAllowedAttachment)) return false;
    }
    if (!args.text.trim() && !attachments?.length) return false;
    return attachmentProblem(attachments || [], args.text.length) === null;
  }

  function isAllowedNewChat(args) {
    if (args === undefined) return true;
    if (!isObject(args) || !hasOnlyKeys(args, ['modality', 'model'])) return false;
    if ('modality' in args && !NEW_CHAT_MODALITIES.has(args.modality)) return false;
    return !('model' in args) || isSomeText(args.model, MAX_MODEL);
  }

  function noArguments(args) {
    return args === undefined || (isObject(args) && Object.keys(args).length === 0);
  }

  // A Map, so a kind like "constructor" finds nothing.
  const ARGUMENT_RULES = new Map([
    ['send', isAllowedSend],
    ['stop', noArguments],
    ['delete', noArguments],
    ['new-chat', isAllowedNewChat],
    ['set-model', (a) => isObject(a) && hasOnlyKeys(a, ['model']) && isSomeText(a.model, MAX_MODEL)],
    ['set-mode', (a) => isObject(a) && hasOnlyKeys(a, ['mode']) && MODES.has(a.mode)],
    ['set-toggle', (a) => isObject(a) && hasOnlyKeys(a, ['name', 'value']) && TOGGLES.has(a.name) && typeof a.value === 'boolean'],
    ['rename', (a) => isObject(a) && hasOnlyKeys(a, ['title']) && isSomeText(a.title, MAX_TITLE)],
    // An empty path means "start somewhere": the home folder.
    ['list-dir', (a) => isObject(a) && hasOnlyKeys(a, ['path']) && (a.path === '' || isLocalAbsolutePath(a.path))],
    ['set-folder', (a) => isObject(a) && hasOnlyKeys(a, ['path']) && isLocalAbsolutePath(a.path)]
  ]);

  function isActionId(id) {
    return typeof id === 'string' && ACTION_ID.test(id);
  }

  function isAllowedAction(frame) {
    if (!isObject(frame) || frame.type !== 'action') return false;
    if (!isCleanShape(frame, 0)) return false;
    if (!hasOnlyKeys(frame, ['type', 'id', 'chatId', 'kind', 'args'])) return false;
    if (!isActionId(frame.id)) return false;
    const rule = ARGUMENT_RULES.get(frame.kind);
    if (!rule) return false;
    // The one kind that isn't about a chat that already exists.
    if (frame.kind === 'new-chat') {
      if ('chatId' in frame) return false;
    } else if (!isString(frame.chatId, MAX_CHAT_ID) || !frame.chatId) {
      return false;
    }
    return rule(frame.args);
  }

  // The attachment as the chat loop wants it. Named fields only, so a path never survives,
  // whichever end this runs on. A name is only ever something to show.
  function cleanAttachment(a) {
    const out = { kind: a.kind, name: a.name };
    if (a.kind === 'image') out.base64 = a.base64;
    if (a.kind === 'text' || a.kind === 'pdf') out.text = a.text;
    if (a.kind === 'pdf' && Number.isSafeInteger(a.pages)) out.pages = a.pages;
    if ((a.kind === 'text' || a.kind === 'file') && typeof a.ext === 'string') out.ext = a.ext;
    if (Number.isFinite(a.size)) out.size = a.size;
    return out;
  }

  return { isAllowedAction, isActionId, attachmentProblem, cleanAttachment, MAX_MESSAGE_BYTES, VIDEO_REFUSED, TOO_LARGE };
});
