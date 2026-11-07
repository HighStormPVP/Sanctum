// What a failed reply says. "Couldn't reach Ollama" only when Ollama really couldn't be reached,
// and never for a cloud model.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ollamaFailureKind, failureLine, chatErrorText } = require(path.join(__dirname, '..', 'lib', 'chat-errors.js'));

const nodeError = (code, message) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
const netError = (name) => new Error(`net::${name}`);
const COULD_NOT_REACH = /Couldn't reach Ollama/;
const PARTWAY = 'Ollama stopped partway through this reply.';

test('refused, or no such host, is Ollama not being there', () => {
  assert.equal(ollamaFailureKind(nodeError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434'), { accepted: false }), 'unreachable');
  assert.equal(ollamaFailureKind(nodeError('ENOTFOUND', 'getaddrinfo ENOTFOUND ollama.lan'), { accepted: false }), 'unreachable');
  assert.equal(ollamaFailureKind(netError('ERR_CONNECTION_REFUSED'), { accepted: false }), 'unreachable', "Electron's net.fetch says it in the message");
  assert.equal(ollamaFailureKind(netError('ERR_NAME_NOT_RESOLVED'), { accepted: false }), 'unreachable');
});

test('a failure after Ollama took the request is a reply cut short, whatever the error says', () => {
  assert.equal(ollamaFailureKind(netError('ERR_INCOMPLETE_CHUNKED_ENCODING'), { accepted: true }), 'partway');
  assert.equal(ollamaFailureKind(nodeError('UND_ERR_BODY_TIMEOUT', 'Body Timeout Error'), { accepted: true }), 'partway');
  assert.equal(ollamaFailureKind(new TypeError('terminated'), { accepted: true }), 'partway');
});

test('anything else before a reply is Ollama hanging up, not Ollama missing', () => {
  assert.equal(ollamaFailureKind(netError('ERR_EMPTY_RESPONSE'), { accepted: false }), 'failed');
  assert.equal(ollamaFailureKind(nodeError('UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'), { accepted: false }), 'failed', 'the old 5-minute cut-off');
  assert.equal(ollamaFailureKind(nodeError('ECONNRESET', 'read ECONNRESET'), { accepted: false }), 'failed');
  assert.equal(ollamaFailureKind(undefined, { accepted: false }), 'failed');
});

test('the line underneath keeps the cause', () => {
  assert.equal(failureLine(nodeError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:11434')), 'fetch failed (connect ECONNREFUSED 127.0.0.1:11434)');
  assert.equal(failureLine(netError('ERR_INCOMPLETE_CHUNKED_ENCODING')), 'net::ERR_INCOMPLETE_CHUNKED_ENCODING');
  assert.equal(failureLine('plain words'), 'plain words');
});

test('each kind of Ollama failure says what happened, with the error underneath', () => {
  const ollama = (error, errorKind) => chatErrorText({ provider: 'ollama', error, errorKind });
  const refused = ollama('fetch failed (connect ECONNREFUSED 127.0.0.1:11434)', 'unreachable');
  assert.match(refused, COULD_NOT_REACH);
  assert.ok(refused.includes('connect ECONNREFUSED 127.0.0.1:11434'));

  const cut = ollama('net::ERR_INCOMPLETE_CHUNKED_ENCODING', 'partway');
  assert.ok(cut.includes(PARTWAY));
  assert.ok(cut.includes('net::ERR_INCOMPLETE_CHUNKED_ENCODING'));
  assert.doesNotMatch(cut, COULD_NOT_REACH);

  const hungUp = ollama('net::ERR_EMPTY_RESPONSE', 'failed');
  assert.match(hungUp, /Ollama closed the connection before replying/);
  assert.doesNotMatch(hungUp, COULD_NOT_REACH);

  for (const answered of [ollama('Ollama returned 500: {"error":"boom"}', 'answered'), ollama('something Ollama said')]) {
    assert.match(answered, /Ollama returned an error/);
    assert.doesNotMatch(answered, COULD_NOT_REACH, 'a 5xx is Ollama answering');
  }
  assert.ok(ollama('Ollama returned 500: {"error":"boom"}', 'answered').includes('{"error":"boom"}'));
});

test("Ollama's own messages keep their own advice", () => {
  assert.match(chatErrorText({ provider: 'ollama', error: "model 'qwen3:8b' not found", errorKind: 'answered' }), /isn't installed/);
  assert.match(chatErrorText({ provider: 'ollama', error: 'model requires more system memory (20.1 GiB) than is available (8.0 GiB)' }), /Out of memory/);
});

test('a cloud error never mentions Ollama', () => {
  const offline = chatErrorText({ provider: 'anthropic', error: 'fetch failed', errorKind: 'unreachable' });
  assert.match(offline, /Anthropic API error/);
  assert.match(offline, /check your internet connection/);
  assert.doesNotMatch(offline, /Ollama/);
  const refused = chatErrorText({ provider: 'google', error: 'API key not valid' });
  assert.match(refused, /Google API error/);
  assert.match(refused, /API key/);
  assert.doesNotMatch(refused, /Ollama/);
});
