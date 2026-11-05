const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  anthropicThinkingParams: a,
  anthropicUsesFallbacks,
  geminiThinkingConfig: g,
  addImagesToAnthropic,
  addImagesToGemini,
  toAnthropicTools,
  toGeminiTools
} = require(path.join(__dirname, '..', 'lib', 'cloud-params.js'));

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'models.json'), 'utf8'));
const cloudPicks = catalog.categories.cloud.picks;

test('Opus 5.5 and Fable 5.1 never send a thinking off switch', () => {
  for (const m of ['claude-opus-5-5', 'claude-fable-5-1']) {
    assert.deepStrictEqual(a(m, false), { output_config: { effort: 'low' } });
    assert.strictEqual(a(m, true).thinking.type, 'adaptive');
  }
});

test('Sonnet 5.5 turns thinking off with between_tools, with no other field', () => {
  assert.deepStrictEqual(a('claude-sonnet-5-5', false), { thinking: { type: 'between_tools' } });
  assert.strictEqual(a('claude-sonnet-5-5', true).thinking.type, 'adaptive');
});

test('Haiku 5.5 never gets budget_tokens; Haiku 4.5 still needs it', () => {
  assert.deepStrictEqual(a('claude-haiku-5-5', false), { thinking: { type: 'disabled' } });
  assert.strictEqual(a('claude-haiku-5-5', true).thinking.budget_tokens, undefined);
  assert.strictEqual(a('claude-haiku-4-5', true).thinking.budget_tokens, 10000);
  assert.deepStrictEqual(a('claude-haiku-4-5', false), {});
});

test('fallbacks go only to models that have one', () => {
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
    assert.ok(anthropicUsesFallbacks(m), m);
  }
  for (const m of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-opus-4-8']) {
    assert.ok(!anthropicUsesFallbacks(m), m);
  }
});

test('Gemini off uses the lowest level each model accepts', () => {
  assert.deepStrictEqual(g('gemini-4-argon', false), { thinkingLevel: 'LOW' });
  assert.deepStrictEqual(g('gemini-3.8-flash', false), { thinkingLevel: 'LOW' });
  assert.deepStrictEqual(g('gemini-3.5-flash-lite', false), { thinkingLevel: 'MINIMAL' });
  assert.deepStrictEqual(g('gemini-3.6-flash', false), { thinkingLevel: 'MINIMAL' });
  assert.deepStrictEqual(g('gemini-4-argon', true), { thinkingLevel: 'HIGH', includeThoughts: true });
});

test('Gemini 2.x gets no thinking level, which it would reject', () => {
  assert.strictEqual(g('gemini-2.5-flash', true), undefined);
  assert.strictEqual(g('gemini-2.5-pro', false), undefined);
});

test('every cloud pick is complete and has no tag', () => {
  for (const p of cloudPicks) {
    assert.ok(p.id && p.name && p.model_id && p.provider, p.id);
    assert.strictEqual(p.tag, undefined, p.id);
    assert.ok(!/-\d{8}$/.test(p.model_id), `${p.id} must not be date-suffixed`);
  }
});

test('every renamed model lands on a pick that exists', () => {
  const ids = new Set(cloudPicks.flatMap(p => [p.id, p.model_id]));
  const renames = catalog.renamed_models;
  assert.ok(Object.keys(renames).length >= 6);
  for (const [from, to] of Object.entries(renames)) {
    assert.ok(ids.has(to), `${from} -> ${to}`);
    assert.ok(!ids.has(from), `${from} is still a current pick, so it must not be renamed`);
  }
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const JPEG = '/9j/4AAQSkZJRgABAQ';
const WEBP = 'UklGRiQAAABXRUJQ';
const BMP = 'Qk02AAAAAAAAADYAAAA';

test('images go to the last Claude user message, before its text', () => {
  const messages = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: 'what is this?' }
  ];
  addImagesToAnthropic(messages, [PNG, JPEG]);
  assert.strictEqual(messages[0].content, 'earlier');
  assert.deepStrictEqual(messages[2].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
    { type: 'text', text: 'what is this?' }
  ]);
});

test('a Claude image with no text sends no empty text block', () => {
  const messages = [{ role: 'user', content: '' }];
  addImagesToAnthropic(messages, [WEBP]);
  assert.strictEqual(messages[0].content.length, 1);
  assert.strictEqual(messages[0].content[0].type, 'image');
});

test('images go to the last Gemini user turn as inline data', () => {
  const contents = [{ role: 'user', parts: [{ text: 'what is this?' }] }];
  addImagesToGemini(contents, [JPEG]);
  assert.deepStrictEqual(contents[0].parts, [
    { inlineData: { mimeType: 'image/jpeg', data: JPEG } },
    { text: 'what is this?' }
  ]);
});

test('an image format the provider cannot read is an error, not a silent drop', () => {
  assert.throws(() => addImagesToAnthropic([{ role: 'user', content: 'x' }], [BMP]), /PNG, JPEG/);
  assert.throws(() => addImagesToGemini([{ role: 'user', parts: [{ text: 'x' }] }], [BMP]), /PNG, JPEG/);
});

test('no images leaves the request unchanged', () => {
  const messages = [{ role: 'user', content: 'x' }];
  addImagesToAnthropic(messages, undefined);
  assert.strictEqual(messages[0].content, 'x');
});

test('tool lists go to each provider in its own shape', () => {
  const tool = (parameters) => ({ type: 'function', function: { name: 't', description: 'd', parameters } });
  const schema = { type: 'object', $schema: 'x', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'object', additionalProperties: true, $schema: 'y', properties: {} } } } };

  const [{ functionDeclarations: [gemini] }] = toGeminiTools([tool(schema), null, {}]);
  assert.deepEqual(gemini, { name: 't', description: 'd', parameters: { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: {} } } } } }, 'what Gemini rejects is gone, at every depth');
  assert.deepEqual(toGeminiTools([tool(undefined)])[0].functionDeclarations[0].parameters, { type: 'object', properties: {} });
  assert.equal(toGeminiTools([]), undefined);
  assert.equal(toGeminiTools(null), undefined);

  assert.deepEqual(toAnthropicTools([tool(schema), null]), [{ name: 't', description: 'd', input_schema: schema }]);
  assert.deepEqual(toAnthropicTools([tool(undefined)])[0].input_schema, { type: 'object', properties: {} });
  assert.equal(toAnthropicTools([]), undefined);
});
