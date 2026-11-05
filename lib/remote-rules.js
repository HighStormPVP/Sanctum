// What a paired laptop may ask a home PC to do, and what a home PC may ask of a laptop. Loaded by
// the renderer through a <script> tag, as RemoteRules, by main.js for the audit log, and by
// test/remote-rules.test.js through require.
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
  function isCleanShape(value, depth, maxDepth = MAX_DEPTH) {
    if (value === null || typeof value !== 'object') return true;
    if (depth > maxDepth) return false;
    if (Array.isArray(value)) return value.every((item) => isCleanShape(item, depth + 1, maxDepth));
    return Object.keys(value).every((key) => !FORBIDDEN_KEYS.has(key) && isCleanShape(value[key], depth + 1, maxDepth));
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
  // past the bytes, and a file too large to send can't come along as just its name. Both fields
  // count whatever the kind, because an empty one mustn't hide the other.
  function bytesIn(attachment) {
    if (!isObject(attachment)) return 0;
    let sent = 0;
    if (typeof attachment.base64 === 'string') sent += Math.floor((attachment.base64.length * 3) / 4);
    if (typeof attachment.text === 'string') sent += attachment.text.length;
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
    // One that doesn't fit is dropped by cleanAttachment. It's no reason to refuse a.c++.
    if ('ext' in a && !isString(a.ext, MAX_NAME)) return false;
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
    if ((a.kind === 'text' || a.kind === 'file') && typeof a.ext === 'string' && EXTENSION.test(a.ext)) out.ext = a.ext;
    if (Number.isFinite(a.size)) out.size = a.size;
    return out;
  }

  // ---- What the interface shows ----

  const IDLE_LOCK_MS = 15 * 60 * 1000;
  const PATH_LABELS = new Map([['direct', 'Direct'], ['relay', 'Through relay']]);
  const WIPED = "That was the tenth wrong PIN, so this device's Remote Control keys were deleted. Any messages you hadn't sent are gone too. Connect it again with a new code. Your chats are safe at home.";

  function hasHomePeer(status) {
    return Array.isArray(status.devices) && status.devices.some((d) => d.role === 'home');
  }

  // 'enter' while a person's PIN stands between here and the keys, 'set' when a laptop that can
  // reach home has none yet, which is the one state where a stolen laptop reaches home. A home PC
  // with only laptops unlocks itself, and is never asked.
  function pinPrompt(status) {
    if (!status || status.enabled !== true) return null;
    if (status.locked === true && status.hasPin === true) return 'enter';
    if (status.needsPin === true && hasHomePeer(status)) return 'set';
    return null;
  }

  function chatsLocked(status) {
    if (!status) return false;
    return status.locked === true || status.idleLocked === true || pinPrompt(status) === 'set';
  }

  function shouldIdleLock(status, idleMs) {
    if (!status || status.enabled !== true || status.hasPin !== true) return false;
    if (status.locked === true || status.idleLocked === true || !hasHomePeer(status)) return false;
    return idleMs >= IDLE_LOCK_MS;
  }

  function pathLabel(path) {
    return PATH_LABELS.get(path) || 'Offline';
  }

  // m:ss, rounding up so it reads 0:01 rather than 0:00 for its last second. Null once it's gone.
  function codeTimeLeft(expiresAt, now) {
    const left = Math.ceil((expiresAt - now) / 1000);
    if (left <= 0) return null;
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function waitWords(ms) {
    if (ms >= 60000) {
      const minutes = Math.ceil(ms / 60000);
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    const seconds = Math.ceil(ms / 1000);
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }

  // A wait is either a wrong PIN that has just added one, or a try that came too soon after one.
  function pinAnswer(result) {
    const waitMs = result.waitMs > 0 ? result.waitMs : 0;
    if (result.ok) return { ok: true, message: '', waitMs: 0, wiped: false };
    if (result.wiped) return { ok: false, message: WIPED, waitMs: 0, wiped: true };
    if (result.error) return { ok: false, message: result.error, waitMs, wiped: false };
    if (waitMs) return { ok: false, message: `Too many wrong PINs. Try again in ${waitWords(waitMs)}.`, waitMs, wiped: false };
    return { ok: false, message: "That PIN isn't right.", waitMs: 0, wiped: false };
  }

  // ---- Tools on a laptop ----
  //
  // The home PC's model can reach a machine it's paired to. At home this decides which machine a
  // call is for, and what to believe of what a laptop says. On the laptop it decides what a frame
  // may ask for: who may ask at all is settled before this, by the manager in the main process.
  //
  // A laptop's name, what it says it's running, and its MCP tools all come from a device that may
  // be hostile, and they end up in a system prompt, tool cards, and the tool list. So they're all
  // cleaned here, and nothing else in the app reads them raw.

  const HOME_DEVICE = 'home';
  // Web tools and the model itself stay at home. These are never routed, whatever they name.
  const LOCAL_ONLY_TOOLS = new Set(['web_search', 'web_fetch', 'calc', 'exit_plan_mode']);
  const MAX_TOOL_FRAME_BYTES = 8 * 1024 * 1024;
  const MAX_DEVICE_NAME = 48;
  const UNNAMED_DEVICE = 'Unnamed device';
  const MAX_COMMAND = 1024 * 1024;
  const MAX_PATTERN = 64 * 1024;
  const MAX_ALLOWLIST = 256;
  const MAX_TOOL_DEPTH = 32;
  const MAX_TOOL_TITLE = 500;
  const MAX_TOOL_SUMMARY = 200;
  const MAX_TOOL_NAME_SHOWN = 64;
  const DEVICE_OSES = new Set(['win32', 'darwin', 'linux']);
  const DEVICE_SHELLS = new Set(['Bash', 'Cmd']);
  const UNKNOWN = 'unknown';
  // What can't be seen, or could move text to another line or another direction: control and
  // format characters, and the line and paragraph separators.
  const UNSEEN = /[\p{C}\u2028\u2029]/gu;

  // Cloud models refuse a longer tool name.
  const MAX_PUBLIC_TOOL_NAME = 64;
  const MAX_MCP_TOOL_NAME = 128;
  const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_]+__[A-Za-z0-9_]+$/;
  const MAX_MCP_TOOLS = 128;
  const MAX_MCP_DESCRIPTION = 1000;
  const MAX_MCP_TOOL_BYTES = 8 * 1024;
  // More than this isn't even looked at.
  const MAX_MCP_LOOKED_AT = 4096;
  const MAX_SCHEMA_DEPTH = 8;
  const MAX_SCHEMA_TEXT = 300;
  const MAX_SCHEMA_ENUM = 64;
  const SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);
  // What a property name has to be: a plain identifier, as cloud models' tool rules also want.
  const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  // Fits in a control-state a locked laptop may send, which is limited to 64 KiB, so what a home
  // PC is offered doesn't depend on whether the screen is locked.
  const MAX_MCP_TOOLS_BYTES = 60 * 1024;

  // A quote in a name could pass for the end of it in a system prompt. Text in an MCP schema goes the
  // same way, and for the same reason.
  const cleanSchemaText = (value, max) => cleanLine(value, max).replace(/["`]/g, "'");
  const cleanDeviceName = (value) => cleanSchemaText(value, MAX_DEVICE_NAME);

  // Two leading slashes of any kind is a network or device path on Windows: \\server\share, \\?\C:\,
  // \\.\C:\. A home PC doesn't get to send this machine out to a server, or reach a device, whatever
  // mode the chat is in, and looking at such a path at all can offer that server this user's credentials.
  const isNetworkPath = (value) => /^\s*[\\/]{2}/.test(value);
  const isPathText = (value) => isString(value, MAX_PATH) && !CONTROL.test(value) && !isNetworkPath(value);
  const isAllowlist = (value) => Array.isArray(value) && value.length <= MAX_ALLOWLIST && value.every(isPathText);
  const isBody = (value) => typeof value === 'string';
  const isCommand = (value) => isSomeText(value, MAX_COMMAND);
  const isPattern = (value) => isSomeText(value, MAX_PATTERN);
  const isFlag = (value) => typeof value === 'boolean';

  // The closed set a laptop runs, and what each may be given. A Map, so "constructor" finds
  // nothing. mcp_add_server and mcp_remove_server aren't here, because a home PC doesn't get to
  // change what's installed on a laptop except by running a command, which the switch covers.
  const TOOL_ARGUMENTS = new Map([
    ['read_file', { needs: { path: isPathText }, may: { allowlist: isAllowlist } }],
    ['list_dir', { needs: { path: isPathText }, may: { allowlist: isAllowlist } }],
    ['write_file', { needs: { path: isPathText, content: isBody }, may: { allowlist: isAllowlist } }],
    ['apply_patch', { needs: { path: isPathText, find: isBody, replace: isBody }, may: { allowlist: isAllowlist } }],
    ['glob', { needs: { pattern: isPattern, root: isPathText }, may: { allowlist: isAllowlist } }],
    ['grep', { needs: { pattern: isPattern, root: isPathText }, may: { glob: isPattern, case_insensitive: isFlag, allowlist: isAllowlist } }],
    ['run_command', { needs: { command: isCommand }, may: { cwd: isPathText } }],
    ['run_command_async', { needs: { command: isCommand }, may: { cwd: isPathText, allowlist: isAllowlist } }],
    ['task_status', { needs: { task_id: isActionId }, may: {} }],
    ['task_list', { needs: {}, may: {} }],
    ['task_kill', { needs: { task_id: isActionId }, may: {} }]
  ]);

  const utf8Length = (text) => new TextEncoder().encode(text).length;

  function cleanLine(value, max) {
    if (typeof value !== 'string') return '';
    return Array.from(value.replace(UNSEEN, '').trim()).slice(0, max).join('').trim();
  }

  function routesToDevice(name) {
    return TOOL_ARGUMENTS.has(name);
  }

  // Every laptop paired to this home PC, named. A name is settled across all of them rather than
  // the ones available right now. Otherwise one going offline hands its name to another, and a
  // model that remembers the name runs its command on the wrong machine. Where two would look the
  // same, they each get part of their id. The home PC's own name is left alone.
  function namedDevices({ homeName, homeOs, homeShell, peers }) {
    const known = (set, value) => (set.has(value) ? value : UNKNOWN);
    const home = {
      id: HOME_DEVICE,
      name: cleanDeviceName(homeName) || 'Home PC',
      os: known(DEVICE_OSES, homeOs),
      shell: known(DEVICE_SHELLS, homeShell),
      available: true
    };
    const laptops = (Array.isArray(peers) ? peers : [])
      .filter((peer) => isObject(peer) && peer.role === 'laptop' && typeof peer.id === 'string' && peer.id && peer.id !== HOME_DEVICE)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const base = (peer) => cleanDeviceName(peer.name) || UNNAMED_DEVICE;
    const counts = new Map([[home.name.toLowerCase(), 1]]);
    for (const peer of laptops) counts.set(base(peer).toLowerCase(), (counts.get(base(peer).toLowerCase()) || 0) + 1);
    const used = new Set([home.name.toLowerCase()]);
    return [home, ...laptops.map((peer) => {
      let name = base(peer);
      if (counts.get(name.toLowerCase()) > 1 || used.has(name.toLowerCase())) {
        let length = 4;
        do {
          name = `${base(peer)} (${peer.id.slice(0, length)})`;
          length += 4;
        } while (used.has(name.toLowerCase()) && length < peer.id.length + 4);
      }
      used.add(name.toLowerCase());
      return {
        id: peer.id,
        name,
        os: known(DEVICE_OSES, peer.os),
        shell: known(DEVICE_SHELLS, peer.shell),
        available: peer.connected === true && peer.allowed === true
      };
    })];
  }

  // This home PC, and each connected laptop that has said its switch is on.
  function availableDevices(options) {
    return namedDevices(options).filter((device) => device.available).map(({ id, name, os, shell }) => ({ id, name, os, shell }));
  }

  // A chat with no folder defaults to the home PC, and so does one with a folder at home, which is
  // the only kind an old chat has. Otherwise it's the first laptop holding a folder.
  function chatFolderDevice(chat) {
    if (!isObject(chat) || chat.projectFolder || !isObject(chat.projectFolders)) return HOME_DEVICE;
    const found = Object.keys(chat.projectFolders).find((id) => typeof chat.projectFolders[id] === 'string' && chat.projectFolders[id]);
    return found ?? HOME_DEVICE;
  }

  // The named device, else the chat's folder device, else the home PC. Nothing here falls back to
  // home once something else has been asked for: that would be a command silently running on the
  // wrong machine. An error with a deviceId is one this can't reach, for the caller to name.
  function resolveDevice(requested, chat, devices) {
    const list = Array.isArray(devices) ? devices : [];
    if (requested !== undefined && requested !== null && requested !== '') {
      const wanted = typeof requested === 'string' ? requested.trim().toLowerCase() : null;
      const match = wanted && list.find((device) => device.name.toLowerCase() === wanted);
      if (match) return { deviceId: match.id };
      const said = typeof requested === 'string' ? cleanLine(requested, MAX_DEVICE_NAME) : '';
      return { error: `There's no device called "${said}". The devices are: ${list.map((device) => `"${device.name}"`).join(', ')}.` };
    }
    const deviceId = chatFolderDevice(chat);
    if (list.some((device) => device.id === deviceId)) return { deviceId };
    return { error: "This chat's folder is on a device that isn't available.", deviceId };
  }

  function addDeviceArgument(toolDef, deviceNames) {
    const name = toolDef?.function?.name;
    if (!routesToDevice(name) || !Array.isArray(deviceNames) || !deviceNames.length) return toolDef;
    const parameters = toolDef.function.parameters || { type: 'object', properties: {} };
    return {
      ...toolDef,
      function: {
        ...toolDef.function,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            device: { type: 'string', enum: deviceNames, description: "Which machine to run this on. Leave it out to use this chat's default." }
          }
        }
      }
    };
  }

  // A small hash, so two long names cut short at the same place stay apart.
  function shortHash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function mcpToolName(deviceSlug, tool) {
    const name = `mcp__${deviceSlug}__${String(tool).replace(/^mcp__/, '')}`;
    if (name.length <= MAX_PUBLIC_TOOL_NAME) return name;
    return `${name.slice(0, MAX_PUBLIC_TOOL_NAME - 9)}_${shortHash(name)}`;
  }

  function slugForDevice(name) {
    const plain = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20).replace(/_+$/, '');
    return `laptop_${plain || 'device'}`;
  }

  // A schema from a laptop goes into every request to the model, so it's rebuilt from what a tool
  // needs to describe its arguments, and nothing else comes along. Returns null if the tool has to go.
  function cleanSchema(schema, depth) {
    if (!isObject(schema) || depth > MAX_SCHEMA_DEPTH) return null;
    const out = {};
    const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type;
    if (SCHEMA_TYPES.has(type)) out.type = type;
    const description = cleanSchemaText(schema.description, MAX_SCHEMA_TEXT);
    if (description) out.description = description;
    if (Array.isArray(schema.enum)) {
      out.enum = schema.enum.slice(0, MAX_SCHEMA_ENUM)
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .map((item) => (typeof item === 'string' ? cleanSchemaText(item, MAX_SCHEMA_TEXT) : item));
    }
    if (schema.items !== undefined) {
      const items = cleanSchema(schema.items, depth + 1);
      if (!items) return null;
      out.items = items;
    }
    if (schema.properties !== undefined) {
      if (!isObject(schema.properties)) return null;
      out.properties = {};
      for (const name of Object.keys(schema.properties)) {
        if (!SCHEMA_NAME.test(name) || FORBIDDEN_KEYS.has(name)) return null;
        const inner = cleanSchema(schema.properties[name], depth + 1);
        if (!inner) return null;
        out.properties[name] = inner;
      }
      if (Array.isArray(schema.required)) {
        const required = schema.required.filter((name) => typeof name === 'string' && Object.hasOwn(out.properties, name));
        if (required.length) out.required = required;
      }
    }
    return out;
  }

  // A tool as a laptop describes it, or null. Only what's named here survives.
  function cleanMcpTool(def) {
    if (!isObject(def) || !isObject(def.function)) return null;
    const { name, description, parameters } = def.function;
    if (typeof name !== 'string' || name.length > MAX_MCP_TOOL_NAME || !MCP_TOOL_NAME.test(name)) return null;
    if (!isObject(parameters) || parameters.type !== 'object' || !isCleanShape(parameters, 0, MAX_TOOL_DEPTH)) return null;
    const schema = cleanSchema(parameters, 0);
    if (!schema) return null;
    const tool = { type: 'function', function: { name, description: cleanSchemaText(description, MAX_MCP_DESCRIPTION), parameters: schema } };
    return utf8Length(JSON.stringify(tool)) > MAX_MCP_TOOL_BYTES ? null : tool;
  }

  // The tools that can go, in an order nothing about the sender decides, up to the total. How many
  // were given and couldn't go is `dropped`, whatever the reason.
  function limitMcpTools(tools) {
    if (!Array.isArray(tools)) return { tools: [], dropped: 0 };
    const looked = tools.slice(0, MAX_MCP_LOOKED_AT);
    const clean = looked.map(cleanMcpTool).filter(Boolean)
      .sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
    const out = [];
    let bytes = 2;
    for (const tool of clean) {
      const size = utf8Length(JSON.stringify(tool)) + 1;
      if (bytes + size > MAX_MCP_TOOLS_BYTES || out.length >= MAX_MCP_TOOLS) break;
      bytes += size;
      out.push(tool);
    }
    return { tools: out, dropped: tools.length - out.length };
  }

  // What a laptop tells a home PC about its own MCP servers.
  function outgoingMcpTools(tools) {
    return limitMcpTools(tools);
  }

  // Off, unless it plainly says otherwise. Off also means no tools. The limit is here as well as at
  // the laptop, because the laptop is the one it would be a limit on.
  function cleanControlState(frame) {
    const allowed = isObject(frame) && frame.allowed === true;
    const { tools, dropped } = allowed ? limitMcpTools(frame.mcpTools) : { tools: [], dropped: 0 };
    return { allowed, os: isObject(frame) ? frame.os : undefined, shell: isObject(frame) ? frame.shell : undefined, mcpTools: tools, dropped };
  }

  // Each available laptop's tools, under names of their own. The home PC's come first: a laptop
  // tool whose name is taken, as a home server could arrange, simply isn't offered. Names are settled
  // across every paired laptop, for the reason device names are: a tool's name can't come to mean
  // another laptop when the first one goes offline.
  function laptopToolDefs({ devices, paired, control, taken }) {
    const everyLaptop = (paired || devices || []).filter((device) => device.id !== HOME_DEVICE);
    const slugs = new Map(everyLaptop.map((device) => [device.id, slugForDevice(device.name)]));
    const shared = (slug) => [...slugs.values()].filter((other) => other === slug).length > 1;
    const seen = new Set(taken || []);
    const entries = [];
    for (const device of (devices || []).filter((item) => item.id !== HOME_DEVICE)) {
      const base = slugs.get(device.id) ?? slugForDevice(device.name);
      const slug = shared(base) ? `${base}_${device.id.slice(0, 4)}` : base;
      for (const tool of control?.get(device.id)?.mcpTools || []) {
        const publicName = mcpToolName(slug, tool.function.name);
        if (seen.has(publicName)) continue;
        seen.add(publicName);
        entries.push({
          publicName,
          deviceId: device.id,
          tool: tool.function.name,
          def: { type: 'function', function: { name: publicName, description: `[On ${device.name}] ${tool.function.description}`, parameters: tool.function.parameters } }
        });
      }
    }
    return entries;
  }

  // What a frame may ask of this laptop: { id, name, args, chatTitle }, or { error }, with the id
  // too if there's one to answer. A handler is only ever found by looking the name up in a closed
  // list, so nothing in a frame gets to name one.
  function checkToolCall(frame, mcpTools) {
    if (!isObject(frame) || frame.type !== 'tool-call' || !isActionId(frame.id)) return { error: 'That request makes no sense.' };
    const { id, name, args } = frame;
    const refuse = (error) => ({ error, id });
    if (!hasOnlyKeys(frame, ['type', 'id', 'name', 'args', 'chatTitle'])) return refuse('That request makes no sense.');
    const shown = typeof name === 'string' ? cleanLine(name, MAX_TOOL_NAME_SHOWN) : '';
    const isMcp = typeof name === 'string' && mcpTools?.has(name) === true;
    const rule = typeof name === 'string' ? TOOL_ARGUMENTS.get(name) : undefined;
    if (!isMcp && !rule) return refuse(`"${shown}" can't be run on this device.`);
    if (!isObject(args) || !isCleanShape(args, 0, MAX_TOOL_DEPTH)) return refuse(`Those aren't arguments ${shown} can take.`);
    if (rule) {
      const fine = Object.keys(args).every((key) => {
        const check = Object.hasOwn(rule.needs, key) ? rule.needs[key] : Object.hasOwn(rule.may, key) ? rule.may[key] : null;
        return check !== null && check(args[key]);
      }) && Object.keys(rule.needs).every((key) => Object.hasOwn(args, key));
      if (!fine) {
        const reachesOut = Object.values(args).flat().some((value) => typeof value === 'string' && isNetworkPath(value));
        return refuse(reachesOut ? "Network and device paths can't be used on this device from another one." : `Those aren't arguments ${shown} can take.`);
      }
    }
    const chatTitle = typeof frame.chatTitle === 'string' ? frame.chatTitle.slice(0, MAX_TOOL_TITLE) : '';
    return { id, name, args, chatTitle };
  }

  function overToolLimit(value) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch {
      return true;
    }
    if (typeof text !== 'string') return false;
    if (text.length > MAX_TOOL_FRAME_BYTES) return true;
    return text.length * 3 > MAX_TOOL_FRAME_BYTES && utf8Length(text) > MAX_TOOL_FRAME_BYTES;
  }

  // What a laptop sent back, as the chat loop can take it. A hostile one gets to say what it
  // likes, but only as a tool's result.
  function cleanToolResult(frame) {
    const usable = isObject(frame) && (isObject(frame.result) || typeof frame.result === 'string');
    if (!usable) return { result: { error: 'The device sent back nothing.' }, summary: 'no result', ok: false };
    if (overToolLimit(frame.result)) return { result: { error: 'What the device sent back is too large to use.' }, summary: 'too large', ok: false };
    return { result: frame.result, summary: cleanLine(frame.summary, MAX_TOOL_SUMMARY), ok: frame.ok === true };
  }

  // ---- The laptop's audit log ----

  const AUDIT_TEXT_FIELDS = ['path', 'cwd', 'root', 'pattern', 'glob', 'command', 'task_id'];
  const AUDIT_SIZE_FIELDS = ['content', 'find', 'replace'];
  const AUDIT_ENTRY_TEXT = ['ts', 'event', 'call', 'device', 'deviceName', 'chatTitle', 'tool', 'summary', 'reason'];
  const MAX_AUDIT_TEXT = 300;
  const MAX_AUDIT_ARG = 1000;
  const MAX_AUDIT_LINE = 8192;

  // What's worth keeping of a call's arguments. A file's body is its size, and an MCP tool's
  // arguments could be anything, so those are just their names.
  function auditArgs(tool, args) {
    if (!isObject(args)) return undefined;
    if (!TOOL_ARGUMENTS.has(tool)) return { fields: Object.keys(args).slice(0, 32).map((key) => key.slice(0, 64)) };
    const out = {};
    for (const key of AUDIT_TEXT_FIELDS) if (typeof args[key] === 'string') out[key] = args[key].slice(0, MAX_AUDIT_ARG);
    for (const key of AUDIT_SIZE_FIELDS) if (typeof args[key] === 'string') out[`${key}Bytes`] = utf8Length(args[key]);
    return out;
  }

  // JSON leaves these two raw, and some readers take them for the end of a line.
  const asOneLine = (value) => JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

  // One line of JSON, so a hostile title can't write a line of its own. The limit is on that line as
  // written, because escaping makes a string up to six times as long as it looks.
  function auditLine(entry) {
    const out = {};
    for (const key of AUDIT_ENTRY_TEXT) if (typeof entry?.[key] === 'string') out[key] = entry[key].slice(0, MAX_AUDIT_TEXT);
    if (typeof entry?.ok === 'boolean') out.ok = entry.ok;
    if (Number.isSafeInteger(entry?.count)) out.count = entry.count;
    if (isObject(entry?.args)) {
      out.args = {};
      for (const key of Object.keys(entry.args).slice(0, 16)) {
        const value = entry.args[key];
        if (typeof value === 'string') out.args[key.slice(0, 64)] = value.slice(0, MAX_AUDIT_ARG);
        else if (typeof value === 'number') out.args[key.slice(0, 64)] = value;
        else if (Array.isArray(value)) out.args[key.slice(0, 64)] = value.filter((item) => typeof item === 'string').slice(0, 32).map((item) => item.slice(0, 64));
      }
    }
    let line = asOneLine(out);
    if (line.length <= MAX_AUDIT_LINE) return line;
    delete out.args;
    line = asOneLine(out);
    for (let keep = MAX_AUDIT_TEXT / 2; line.length > MAX_AUDIT_LINE; keep = Math.floor(keep / 2)) {
      for (const key of AUDIT_ENTRY_TEXT) if (typeof out[key] === 'string') out[key] = out[key].slice(0, keep);
      line = asOneLine(out);
    }
    return line;
  }

  // Refusals have a log of their own, so a device can't push what ran out of the audit log by asking
  // for what it can't have. And they collapse: for each device, at most one line a minute, with how
  // many it stands for and the first tool among them. The first of a quiet spell is written at once.
  function createRefusalLog({ write, clock, windowMs = 60000 }) {
    const open = new Map(); // device -> { waiting: the line for the next minute, or null, timer }
    const put = (entry) => {
      try {
        write(entry);
      } catch { /* a line that can't be written is only that line */ }
    };
    function roll(device) {
      const window = open.get(device);
      if (!window) return;
      if (!window.waiting) {
        open.delete(device);
        return;
      }
      put(window.waiting);
      window.waiting = null;
      window.timer = clock.setTimeout(() => roll(device), windowMs);
    }
    return {
      note(entry) {
        const window = open.get(entry.device);
        if (!window) {
          put({ ...entry, count: 1 });
          open.set(entry.device, { waiting: null, timer: clock.setTimeout(() => roll(entry.device), windowMs) });
        } else if (window.waiting) {
          window.waiting.count += 1;
        } else {
          window.waiting = { ...entry, count: 1 };
        }
      },
      flush() {
        for (const window of open.values()) {
          clock.clearTimeout(window.timer);
          if (window.waiting) put(window.waiting);
        }
        open.clear();
      }
    };
  }

  // ---- What a home PC started, on a laptop ----

  // What has to end, given what's running here and what the connection manager says. A short gap
  // ends nothing by itself. A live command ends with the link, because the model has been told it
  // failed, or after long silence. A background task only ends with the switch or the pairing, since
  // the design has it keep going and report on reconnect.
  function remoteWorkToEnd({ status, runs, tasks }) {
    const off = status?.controlAllowed !== true || status?.needsPin === true;
    const homes = new Map((status?.devices || []).filter((device) => device.role === 'home').map((device) => [device.id, device]));
    const ending = [];
    for (const { key, deviceId } of runs) {
      const home = homes.get(deviceId);
      let reason = null;
      if (off) reason = 'off';
      else if (!home) reason = 'removed';
      else if (!home.connected) reason = 'offline';
      else if (home.longQuiet) reason = 'silence';
      if (reason) ending.push({ kind: 'run', key, reason });
    }
    for (const { id, deviceId } of tasks) {
      if (off) ending.push({ kind: 'task', id, reason: 'off' });
      else if (!homes.has(deviceId)) ending.push({ kind: 'task', id, reason: 'removed' });
    }
    return ending;
  }

  return {
    isAllowedAction, isActionId, attachmentProblem, cleanAttachment, MAX_MESSAGE_BYTES, VIDEO_REFUSED, TOO_LARGE,
    IDLE_LOCK_MS, pinPrompt, chatsLocked, shouldIdleLock, pathLabel, codeTimeLeft, pinAnswer,
    HOME_DEVICE, LOCAL_ONLY_TOOLS, MAX_TOOL_FRAME_BYTES, availableDevices, namedDevices, chatFolderDevice, resolveDevice,
    addDeviceArgument, mcpToolName, routesToDevice, checkToolCall, cleanToolResult, cleanControlState, outgoingMcpTools,
    laptopToolDefs, overToolLimit, auditArgs, auditLine, cleanLine, createRefusalLog, remoteWorkToEnd
  };
});
