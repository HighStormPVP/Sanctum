// What a local model is asked for when it has tools, and when a round that should have
// called a tool and didn't is worth asking again.
const test = require('node:test');
const assert = require('node:assert');
const { localSampling, missedToolCall, nudgeFor, retryLabel, giveUpNote, MAX_NUDGES } = require('../lib/tool-rounds.js');

test('with tools, a local model gets no repetition penalties, so its tool calls come out whole', () => {
  // Measured on Qwen3.6 35B: with repeat_penalty 1.1 and the model's own presence_penalty 1.5,
  // 0 of 4 long tool calls came through; with both off, 4 of 4.
  assert.deepEqual(localSampling({ toolsOffered: true }), { repeat_penalty: 1, presence_penalty: 0 });
});

test('without tools, a local model keeps the mild repeat penalty against loops, and its own presence penalty', () => {
  assert.deepEqual(localSampling({ toolsOffered: false }), { repeat_penalty: 1.1 });
});

const base = { toolsOffered: true, toolCalls: 0, text: '', thinkingChars: 0, evalCount: 0, doneReason: 'stop', streamError: null };

test('a round that called a tool, or had no tools to call, is never a miss', () => {
  assert.equal(missedToolCall({ ...base, toolCalls: 1, text: 'Let me write it:' }), null);
  assert.equal(missedToolCall({ ...base, toolsOffered: false, text: 'Let me write it:' }), null);
});

test('a reply that announces an action and ends on a colon is a miss', () => {
  assert.equal(missedToolCall({ ...base, text: 'Let me write out the complete basket catching game:', evalCount: 14 }), 'announced');
  assert.equal(missedToolCall({ ...base, text: 'Now I will build it： ', evalCount: 6 }), 'announced');
});

test('an ordinary answer is not a miss', () => {
  assert.equal(missedToolCall({ ...base, text: 'The scene has a cube, a light and a camera.', evalCount: 12 }), null);
  assert.equal(missedToolCall({ ...base, text: 'Here are the steps: first, open Blender. Then add a cube.', evalCount: 15 }), null);
});

test('far more tokens generated than reached the screen means a tool call was lost on the way', () => {
  // 61 seconds and about 2,400 tokens, of which 51 characters arrived.
  assert.equal(missedToolCall({ ...base, text: 'I will write the game now.', evalCount: 2400 }), 'withheld');
  // Long thinking that did arrive is not lost.
  assert.equal(missedToolCall({ ...base, text: 'Done.', thinkingChars: 9000, evalCount: 2300 }), null);
});

test('a reply with nothing in it after tools were offered is a miss', () => {
  assert.equal(missedToolCall({ ...base, text: '   ', thinkingChars: 28000, evalCount: 7800 }), 'empty');
  assert.equal(missedToolCall({ ...base }), 'empty');
});

test('Ollama failing to read the tool call is a miss, and any other error is not', () => {
  assert.equal(missedToolCall({ ...base, streamError: 'XML syntax error on line 3: invalid characters between </parameter and >' }), 'malformed');
  assert.equal(missedToolCall({ ...base, streamError: 'qwen tool call parsing failed' }), 'malformed');
  assert.equal(missedToolCall({ ...base, streamError: 'model requires more system memory (38.0 GiB) than is available' }), null);
});

test('a reply cut off at the token limit is not asked again, since it would be cut off again', () => {
  assert.equal(missedToolCall({ ...base, text: 'Let me write it:', evalCount: 16384, doneReason: 'length' }), null);
});

test('the nudge tells the model what went wrong, and there are at most two a reply', () => {
  assert.equal(MAX_NUDGES, 2);
  assert.match(nudgeFor('malformed'), /couldn't be read/);
  for (const kind of ['announced', 'withheld', 'empty']) assert.match(nudgeFor(kind), /call the tool now/i);
});

test('a long answer in Chinese, Japanese or Korean is not mistaken for a lost call', () => {
  // About one character a token, not four.
  const chinese = '这是一个关于搭建停车场模型的详细说明。'.repeat(105); // about 2,000 characters
  assert.equal(missedToolCall({ ...base, text: chinese, evalCount: 1300 }), null);
  // A short reply with thousands of tokens behind it is still a lost call, in any script.
  assert.equal(missedToolCall({ ...base, text: '我现在写游戏。', evalCount: 2400 }), 'withheld');
});

test('a round with nothing in it, after tools already ran in this reply, is the model finishing', () => {
  assert.equal(missedToolCall({ ...base, text: '', thinkingChars: 400, evalCount: 120, toolsRan: 1 }), null);
  assert.equal(missedToolCall({ ...base, text: '', thinkingChars: 400, evalCount: 120, toolsRan: 0 }), 'empty');
  // A lost call is still a lost call after tools ran.
  assert.equal(missedToolCall({ ...base, text: 'Next the ramps.', evalCount: 2400, toolsRan: 3 }), 'withheld');
});

test('a malformed call beside one that came through: the good one runs, nothing is asked again', () => {
  assert.equal(missedToolCall({ ...base, toolCalls: 1, streamError: 'XML syntax error on line 3' }), null);
});

test('each kind of miss has its own row and its own words when Sanctum gives up', () => {
  const kinds = ['malformed', 'withheld', 'empty', 'announced'];
  const rows = kinds.map(retryLabel);
  assert.equal(new Set(rows).size, 4, 'four different rows');
  assert.match(retryLabel('empty'), /stopped without/);
  assert.equal(new Set(kinds.map((k) => giveUpNote(k, 'XML syntax error'))).size, 4, 'four different notes');
  assert.match(giveUpNote('malformed', 'XML syntax error on line 3'), /XML syntax error on line 3/);
  assert.match(giveUpNote('announced', ''), /continue/);
});
