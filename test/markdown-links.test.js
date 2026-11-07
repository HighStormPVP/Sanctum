// Links in renderMarkdown, on the real code from renderer.js. A model, or a home PC's mirror, can
// send any text, so a run of brackets has to cost about as much as any other text of its size.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

// From the second escapeHtml, the one in UTIL that the page ends up with, through the end of
// RUNNABLE_LANGS, which is everything renderMarkdown reaches for.
function loadRenderMarkdown() {
  const util = source.indexOf('// ============== UTIL ==============');
  const escapeStart = source.indexOf('function escapeHtml(s)', util);
  const escapeEnd = source.indexOf('\n}\n', escapeStart) + 3;
  const start = source.indexOf('const LATEX_SYMBOLS = {');
  const langs = source.indexOf('const RUNNABLE_LANGS = new Set([');
  const end = source.indexOf(']);', langs) + 3;
  assert.ok(util > 0 && escapeStart > util && start > escapeStart && langs > start && end > langs, 'found the code');
  const body = `${source.slice(escapeStart, escapeEnd)}\n${source.slice(start, end)}\nreturn renderMarkdown;`;
  return new Function(body)();
}

const renderMarkdown = loadRenderMarkdown();
const link = (text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;

test('a link still links, and only to http or https', () => {
  assert.ok(renderMarkdown('see [the docs](https://a.example/x) now').includes(link('the docs', 'https://a.example/x')));
  assert.ok(renderMarkdown('[plain](http://a.example)').includes(link('plain', 'http://a.example')));
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a '));
  assert.ok(!renderMarkdown('[y](https://a.example/"onclick="x)').includes('onclick="x'), 'a quote never leaves the attribute');
  assert.ok(renderMarkdown('[a](https://a.example/1) and [b](https://a.example/2)').includes(`${link('a', 'https://a.example/1')} and ${link('b', 'https://a.example/2')}`));
});

test('a link at each bound still links, and one past it does not', () => {
  const text400 = 't'.repeat(400);
  const url2000 = `https://a.example/${'u'.repeat(2000 - 'https://a.example/'.length)}`;
  assert.equal(url2000.length, 2000);
  assert.ok(renderMarkdown(`[${text400}](https://a.example)`).includes(link(text400, 'https://a.example')), 'text of 400');
  assert.ok(renderMarkdown(`[x](${url2000})`).includes(link('x', url2000)), 'an address of 2000');
  assert.ok(!renderMarkdown(`[${text400}t](https://a.example)`).includes('<a '), 'text of 401');
  assert.ok(!renderMarkdown(`[x](${url2000}u)`).includes('<a '), 'an address of 2001');
});

test('60k of [ renders in under 300 ms', () => {
  for (const text of ['['.repeat(60000), `${'['.repeat(60000)}](`, `[${'x'.repeat(60000)}`, `[a](${'h'.repeat(60000)}`]) {
    const started = process.hrtime.bigint();
    renderMarkdown(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 300, `${ms.toFixed(0)} ms for ${JSON.stringify(text.slice(0, 12))}…`);
  }
});
