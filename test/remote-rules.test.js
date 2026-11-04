const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const RemoteRules = require(path.join(__dirname, '..', 'lib', 'remote-rules.js'));
const { isAllowedAction, attachmentProblem, cleanAttachment, MAX_MESSAGE_BYTES, VIDEO_REFUSED, TOO_LARGE } = RemoteRules;

const MIB = 1024 * 1024;
const action = (kind, args, extra = {}) => ({ type: 'action', id: 'a1', chatId: 'c_1', kind, ...(args === undefined ? {} : { args }), ...extra });
const newChat = (args) => {
  const frame = { type: 'action', id: 'a1', kind: 'new-chat' };
  if (args !== undefined) frame.args = args;
  return frame;
};

const GOOD = [
  action('send', { text: 'hello' }),
  action('send', { text: '', attachments: [{ kind: 'text', name: 'a.txt', text: 'body', ext: 'txt', size: 4 }] }),
  action('send', { text: 'x', attachments: [{ kind: 'image', name: 'a.png', base64: 'AAAA', size: 3 }] }),
  action('send', { text: 'x', attachments: [{ kind: 'pdf', name: 'a.pdf', text: 'body', pages: 2, size: 9 }] }),
  action('send', { text: 'x', attachments: [{ kind: 'file', name: 'a.zip', ext: 'zip', size: 9 }] }),
  action('stop'),
  action('stop', {}),
  action('set-model', { model: 'fake:latest' }),
  action('set-mode', { mode: 'plan' }),
  action('set-mode', { mode: 'approval' }),
  action('set-mode', { mode: 'noApproval' }),
  action('set-toggle', { name: 'webEnabled', value: true }),
  action('set-toggle', { name: 'thinkingEnabled', value: false }),
  action('set-toggle', { name: 'readOnly', value: true }),
  action('set-toggle', { name: 'noFetch', value: false }),
  action('rename', { title: 'A better title' }),
  action('delete'),
  newChat(),
  newChat({}),
  newChat({ modality: 'chat' }),
  newChat({ modality: 'agent', model: 'fake:latest' }),
  action('list-dir', { path: '' }),
  action('list-dir', { path: 'C:\\Users\\Someone' }),
  action('list-dir', { path: '/home/someone' }),
  action('set-folder', { path: 'D:/work/project' }),
  action('set-folder', { path: '/Users/someone/project' })
];

test('every listed kind, with the right arguments, is allowed', () => {
  for (const frame of GOOD) assert.equal(isAllowedAction(frame), true, JSON.stringify(frame));
  const kinds = new Set(GOOD.map((frame) => frame.kind));
  assert.deepEqual([...kinds].sort(), ['delete', 'list-dir', 'new-chat', 'rename', 'send', 'set-folder', 'set-mode', 'set-model', 'set-toggle', 'stop']);
});

test('kinds that are not listed are refused', () => {
  for (const kind of ['read-api-keys', 'set-pin', 'pair', 'removeDevice', 'set-control', 'setControlAllowed', 'settings', 'read-file', 'run', 'constructor', '__proto__', 'toString', 'SEND', '', 7, null, undefined, {}, ['send']]) {
    assert.equal(isAllowedAction({ type: 'action', id: 'a1', chatId: 'c_1', kind }), false, String(kind));
  }
});

test('anything that is not an action frame is refused', () => {
  for (const frame of [null, undefined, 1, 'action', [], {}, { kind: 'stop', id: 'a1', chatId: 'c' }, { type: 'mirror-ops', id: 'a1', chatId: 'c', kind: 'stop' }]) {
    assert.equal(isAllowedAction(frame), false, JSON.stringify(frame));
  }
});

test('a __proto__, constructor or prototype key anywhere refuses the frame', () => {
  const texts = [
    '{"type":"action","id":"a1","chatId":"c","kind":"stop","__proto__":{"polluted":true}}',
    '{"type":"action","id":"a1","chatId":"c","kind":"stop","constructor":{"prototype":{}}}',
    '{"type":"action","id":"a1","chatId":"c","kind":"stop","args":{"__proto__":{"polluted":true}}}',
    '{"type":"action","id":"a1","chatId":"c","kind":"rename","args":{"title":"t","prototype":{}}}',
    '{"type":"action","id":"a1","chatId":"c","kind":"send","args":{"text":"t","attachments":[{"kind":"text","name":"a","text":"b","__proto__":{"x":1}}]}}',
    '{"type":"action","id":"a1","chatId":"c","kind":"send","args":{"text":"t","attachments":[{"kind":"text","name":"a","text":"b","path":{"__proto__":{"x":1}}}]}}'
  ];
  for (const text of texts) assert.equal(isAllowedAction(JSON.parse(text)), false, text);
  assert.equal({}.polluted, undefined);
});

test('a frame nested deeper than any action needs does not run the check out of stack', () => {
  let deep = {};
  for (let i = 0; i < 200000; i++) deep = { a: deep };
  assert.equal(isAllowedAction(action('stop', { deep })), false);
  assert.equal(isAllowedAction(action('send', { text: 't', attachments: [{ kind: 'text', name: 'a', text: 'b', path: deep }] })), false);
});

test('an unknown field at any level refuses the frame', () => {
  const cases = [
    { ...action('stop'), extra: 1 },
    action('stop', { everything: true }),
    action('delete', { also: 'other-chat' }),
    action('send', { text: 'x', model: 'other' }),
    action('send', { text: 'x', attachments: [{ kind: 'text', name: 'a', text: 'b', spare: 1 }] }),
    action('set-model', { model: 'x', global: true }),
    action('set-mode', { mode: 'plan', planMode: false }),
    action('set-toggle', { name: 'readOnly', value: true, also: 'noFetch' }),
    action('rename', { title: 't', titleManual: false }),
    newChat({ modality: 'chat', remoteControl: false }),
    newChat({ modality: 'agent', noApproval: true }),
    newChat({ modality: 'agent', projectFolder: 'C:\\' }),
    action('list-dir', { path: '/', files: true }),
    action('set-folder', { path: '/', pathAllowlist: ['/'] })
  ];
  for (const frame of cases) assert.equal(isAllowedAction(frame), false, JSON.stringify(frame));
});

test('the id and the chat id have to be short strings', () => {
  for (const id of [undefined, null, 1, '', 'a'.repeat(65), 'has space', 'a/b', {}, []]) {
    assert.equal(isAllowedAction({ ...action('stop'), id }), false, String(id));
  }
  for (const chatId of [undefined, null, 1, '', 'c'.repeat(257), {}, []]) {
    assert.equal(isAllowedAction({ ...action('stop'), chatId }), false, String(chatId));
  }
});

test('new-chat has no chat, and everything else needs one', () => {
  assert.equal(isAllowedAction({ ...newChat(), chatId: 'c_1' }), false);
  const { chatId, ...noChat } = action('set-mode', { mode: 'plan' });
  assert.equal(isAllowedAction(noChat), false);
});

test('arguments of the wrong type or out of range are refused', () => {
  const cases = [
    action('stop', []),
    action('stop', 'now'),
    action('send'),
    action('send', {}),
    action('send', { text: 5 }),
    action('send', { text: '   ' }),
    action('send', { text: '', attachments: [] }),
    action('send', { text: 'x', attachments: {} }),
    action('send', { text: 'x', attachments: 'a' }),
    action('send', { text: 'x', attachments: [null] }),
    action('send', { text: 'x', attachments: [[]] }),
    action('send', { text: 'x', attachments: Array.from({ length: 33 }, () => ({ kind: 'file', name: 'a' })) }),
    action('set-model'),
    action('set-model', { model: '' }),
    action('set-model', { model: 3 }),
    action('set-model', { model: 'm'.repeat(300) }),
    action('set-mode', { mode: 'off' }),
    action('set-mode', { mode: 'yolo' }),
    action('set-mode', { mode: 'constructor' }),
    action('set-mode', { mode: true }),
    action('set-mode', {}),
    action('set-toggle', { name: 'remoteControl', value: false }),
    action('set-toggle', { name: 'planMode', value: true }),
    action('set-toggle', { name: 'noApproval', value: true }),
    action('set-toggle', { name: 'apiKeys', value: true }),
    action('set-toggle', { name: 'projectFolder', value: true }),
    action('set-toggle', { name: 'constructor', value: true }),
    action('set-toggle', { name: 'webEnabled', value: 'yes' }),
    action('set-toggle', { name: 'webEnabled', value: 1 }),
    action('set-toggle', { name: 'webEnabled' }),
    action('rename', {}),
    action('rename', { title: '' }),
    action('rename', { title: '   ' }),
    action('rename', { title: 7 }),
    action('rename', { title: 't'.repeat(501) }),
    newChat({ modality: 'video' }),
    newChat({ modality: 'cloud' }),
    newChat({ modality: 7 }),
    newChat({ model: '' }),
    newChat({ model: 7 }),
    newChat([]),
    action('list-dir'),
    action('list-dir', {}),
    action('list-dir', { path: 7 }),
    action('set-folder'),
    action('set-folder', { path: '' })
  ];
  for (const frame of cases) assert.equal(isAllowedAction(frame), false, JSON.stringify(frame).slice(0, 120));
});

test('a folder has to be a plain absolute path on this machine', () => {
  const bad = [
    'relative/path', '.', '..', '~', '~/secrets', 'C:', 'C:relative', 'C:\\a\\..\\b', '/a/../b', '/..', 'C:/..',
    '\\\\attacker\\share', '//attacker/share', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0', '/\\attacker\\share', '\\/attacker/share', '\\rooted',
    'C:\\file.txt:stream', 'C:\\with\u0000nul', '/with\nnewline', 'x'.repeat(5000)
  ];
  for (const p of bad) {
    assert.equal(isAllowedAction(action('set-folder', { path: p })), false, `set-folder ${p}`);
    assert.equal(isAllowedAction(action('list-dir', { path: p })), false, `list-dir ${p}`);
  }
  assert.equal(isAllowedAction(action('set-folder', { path: '/a..b/c.d' })), true);
});

test('an attachment has a closed set of kinds', () => {
  for (const kind of ['video', 'exe', 'path', 'unsupported', 'constructor', '', 7, null, undefined]) {
    assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [{ kind, name: 'a' }] })), false, String(kind));
  }
});

test('an attachment field of the wrong type refuses the frame', () => {
  const cases = [
    { kind: 'text' },
    { kind: 'text', name: 7, text: 'x' },
    { kind: 'text', name: '', text: 'x' },
    { kind: 'text', name: 'n'.repeat(1025), text: 'x' },
    { kind: 'text', name: 'a', text: 7 },
    { kind: 'text', name: 'a' },
    { kind: 'pdf', name: 'a', pages: 2 },
    { kind: 'pdf', name: 'a', text: 'x' },
    { kind: 'pdf', name: 'a', text: 'x', pages: '2' },
    { kind: 'pdf', name: 'a', text: 'x', pages: -1 },
    { kind: 'pdf', name: 'a', text: 'x', pages: 1.5 },
    { kind: 'image', name: 'a' },
    { kind: 'image', name: 'a', base64: 7 },
    { kind: 'image', name: 'a', base64: 'not base64!' },
    { kind: 'image', name: 'a', base64: 'AAAA', size: -1 },
    { kind: 'image', name: 'a', base64: 'AAAA', size: 'big' },
    { kind: 'image', name: 'a', base64: 'AAAA', size: Infinity },
    { kind: 'file', name: 'a', ext: '<b>' },
    { kind: 'file', name: 'a', ext: 7 },
    { kind: 'file', name: 'a', ext: 'e'.repeat(33) }
  ];
  for (const attachment of cases) {
    assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [attachment] })), false, JSON.stringify(attachment));
  }
});

test('a path on an attachment is not a reason to refuse it, and never survives cleaning', () => {
  const att = { kind: 'file', name: 'a.zip', ext: 'zip', size: 9, path: 'C:\\Windows\\System32\\config\\SAM' };
  assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [att] })), true);
  assert.deepEqual(cleanAttachment(att), { kind: 'file', name: 'a.zip', ext: 'zip', size: 9 });
  assert.deepEqual(
    cleanAttachment({ kind: 'text', name: 'a.txt', text: 'body', ext: 'txt', size: 4, path: '/etc/passwd' }),
    { kind: 'text', name: 'a.txt', text: 'body', ext: 'txt', size: 4 }
  );
  assert.deepEqual(
    cleanAttachment({ kind: 'image', name: 'a.png', base64: 'AAAA', size: 3, mime: 'image/png', path: '/x.png' }),
    { kind: 'image', name: 'a.png', base64: 'AAAA', size: 3 }
  );
  assert.deepEqual(
    cleanAttachment({ kind: 'pdf', name: 'a.pdf', text: 'b', pages: 2, size: 9, path: '/x.pdf' }),
    { kind: 'pdf', name: 'a.pdf', text: 'b', pages: 2, size: 9 }
  );
});

test('what cleaning leaves of a local attachment is an allowed attachment', () => {
  for (const local of [
    { kind: 'image', name: 'pasted.png', base64: 'AAAA', size: 3, mime: 'image/png' },
    { kind: 'pdf', name: 'a.pdf', path: '/a.pdf', pages: 2, text: 'b', size: 9 },
    { kind: 'text', name: 'a', path: '/a', text: 'b', size: 1, ext: '' },
    { kind: 'file', name: 'a.tar.gz', path: '/a.tar.gz', ext: 'gz', size: 9 },
    { kind: 'file', name: 'a', path: '/a', ext: '', size: 0 }
  ]) {
    assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [cleanAttachment(local)] })), true, local.name);
  }
});

test('a message is limited to 25 MiB, counting every attachment and the text', () => {
  assert.equal(MAX_MESSAGE_BYTES, 25 * MIB);
  const base64For = (bytes) => 'A'.repeat(Math.ceil(bytes / 3) * 4);
  const image = (bytes) => ({ kind: 'image', name: 'a.png', base64: base64For(bytes), size: bytes });

  assert.equal(attachmentProblem([image(24 * MIB)]), null);
  assert.equal(attachmentProblem([image(30 * MIB)]), TOO_LARGE);
  assert.equal(attachmentProblem([image(13 * MIB), image(13 * MIB)]), TOO_LARGE);
  assert.equal(attachmentProblem([{ kind: 'text', name: 'a', text: 'x'.repeat(26 * MIB) }]), TOO_LARGE);
  assert.equal(attachmentProblem([image(24 * MIB)], 2 * MIB), TOO_LARGE);
  // A size can't talk its way past the bytes, and bytes not sent still count as the file's size.
  assert.equal(attachmentProblem([{ kind: 'image', name: 'a.png', base64: base64For(30 * MIB), size: 1 }]), TOO_LARGE);
  assert.equal(attachmentProblem([{ kind: 'file', name: 'a.zip', size: 30 * MIB }]), TOO_LARGE);

  assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [image(24 * MIB)] })), true);
  assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [image(30 * MIB)] })), false);
  assert.equal(isAllowedAction(action('send', { text: 'x'.repeat(26 * MIB) })), false);
});

test('a video is refused, in the exact words', () => {
  assert.equal(VIDEO_REFUSED, "Videos can't be sent from this device yet. Attach it on the home PC.");
  assert.equal(attachmentProblem([{ kind: 'image', name: 'a', base64: 'AAAA' }, { kind: 'video', name: 'a.mp4', path: '/a.mp4', size: 1 }]), VIDEO_REFUSED);
  assert.equal(isAllowedAction(action('send', { text: 'x', attachments: [{ kind: 'video', name: 'a.mp4' }] })), false);
});

test('attachmentProblem copes with whatever a frame holds', () => {
  for (const junk of [undefined, null, 'x', 7, {}, [null], [7], ['x'], [[]], [{ kind: 'text' }], [{ base64: 7 }], [{ text: {} }]]) {
    assert.equal(attachmentProblem(junk), null, JSON.stringify(junk));
  }
});

test('the rules load from a script tag as well', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-rules.js'), 'utf8');
  const self = {};
  // eslint-disable-next-line no-new-func
  new Function('self', 'module', source)(self, undefined);
  assert.equal(typeof self.RemoteRules.isAllowedAction, 'function');
  assert.equal(self.RemoteRules.isAllowedAction(action('stop')), true);
});

test('the page loads the rules before the renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const rules = html.indexOf('lib/remote-rules.js');
  assert.ok(rules > 0);
  assert.ok(rules < html.indexOf('src="renderer.js"'));
});
