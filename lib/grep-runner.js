// Runs the agent's grep in a worker thread with a time limit. The pattern comes
// from the model, and a pattern like (a+)+$ can run for hours. On the main
// process that would freeze IPC, the Stop button, and the freeze watchdog.
const path = require('path');
const { Worker } = require('worker_threads');
const { globToRegex, walkFiles } = require('./fs-rules');

// Passed as source text so it also works from inside the packaged app archive.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { pattern, flags, files, relative } = workerData;
const re = new RegExp(pattern, flags);
const matches = [];
outer:
for (let f = 0; f < files.length; f++) {
  let content;
  try {
    if (fs.statSync(files[f]).size > 1024 * 1024) continue;
    content = fs.readFileSync(files[f], 'utf-8');
  } catch { continue; }
  if (content.indexOf('\\0') !== -1) continue;
  const lines = content.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matches.push({ file: relative[f], line: i + 1, text: lines[i].slice(0, 300) });
      if (matches.length >= 100) break outer;
    }
  }
}
parentPort.postMessage(matches);
`;

async function grepInWorker({ pattern, root, globFilter, caseInsensitive, timeoutMs = 20000 }) {
  const flags = caseInsensitive ? 'i' : '';
  try { new RegExp(pattern, flags); }
  catch (e) { return { error: 'invalid regex: ' + e.message }; }

  const fileRe = globFilter ? globToRegex(globFilter) : null;
  const files = [];
  const relative = [];
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (fileRe && !fileRe.test(rel)) continue;
    files.push(file);
    relative.push(rel);
  }

  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, files, relative } });
    const finish = (result) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ error: `That search took too long and was stopped (over ${Math.round(timeoutMs / 1000)}s). Try a simpler pattern.` });
    }, timeoutMs);
    worker.once('message', (matches) => finish({ root, matches, count: matches.length }));
    worker.once('error', (e) => finish({ error: e.message }));
  });
}

module.exports = { grepInWorker };
