// Runs the agent's glob and grep in a worker thread with a time limit. A pattern comes from the
// model, and one like (a+)+$ can run for hours. A walk of a large folder takes seconds with nothing
// else able to happen. On the main process, either would freeze IPC, the Stop button, the freeze
// watchdog, and Remote Control's connections.
const { Worker } = require('worker_threads');
const { WALK_WORKER_SOURCE } = require('./fs-rules');

const PARTIAL_NOTE = 'That folder is too large to go through in time, so this is only part of what is there. Try a narrower folder.';
const TIMEOUT_MS = 20000;
// How much of the time limit the walk may have, so a search has some left.
const WALK_SHARE = 0.6;
const MAX_GLOB_MATCHES = 500;

// Passed as source text so it also works from inside the packaged app archive.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
${WALK_WORKER_SOURCE}
const { mode, root, pattern, flags, globFilter, profile, walkMs, maxMatches } = workerData;
const skipDir = profile ? (dir) => isInProfile(dir, profile) : undefined;
const walked = walkFiles(root, { skipDir, deadline: Date.now() + walkMs });
const partial = walked.timedOut === true;
const relative = (file) => path.relative(root, file).replace(/\\\\/g, '/');

if (mode === 'glob') {
  const re = globToRegex(pattern);
  const matches = [];
  for (const file of walked) {
    const rel = relative(file);
    if (re.test(rel)) {
      matches.push(rel);
      if (matches.length >= maxMatches) break;
    }
  }
  parentPort.postMessage({ matches, partial });
} else {
  const re = new RegExp(pattern, flags);
  const fileRe = globFilter ? globToRegex(globFilter) : null;
  const matches = [];
  outer:
  for (const file of walked) {
    const rel = relative(file);
    if (fileRe && !fileRe.test(rel)) continue;
    let content;
    try {
      if (fs.statSync(file).size > 1024 * 1024) continue;
      content = fs.readFileSync(file, 'utf-8');
    } catch { continue; }
    if (content.indexOf('\\0') !== -1) continue;
    const lines = content.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
        if (matches.length >= 100) break outer;
      }
    }
  }
  parentPort.postMessage({ matches, partial });
}
`;

function runInWorker(workerData, timeoutMs, tooLong, shape) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData });
    const finish = (result) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: tooLong }), timeoutMs);
    worker.once('message', ({ matches, partial }) => finish({
      ...shape(matches),
      ...(partial ? { partial: true, note: PARTIAL_NOTE } : {})
    }));
    worker.once('error', (e) => finish({ error: e.message }));
  });
}

// `profile` is a folder the walk goes around. It's a path rather than a function, because a function
// can't cross into a worker. `walkMs` is how long the walk gets before settling for what it has, and
// `timeoutMs` is when the whole thing is given up on.
function grepInWorker({ pattern, root, globFilter, caseInsensitive, profile, timeoutMs = TIMEOUT_MS, walkMs = timeoutMs * WALK_SHARE }) {
  const flags = caseInsensitive ? 'i' : '';
  try { new RegExp(pattern, flags); }
  catch (e) { return Promise.resolve({ error: 'invalid regex: ' + e.message }); }
  return runInWorker(
    { mode: 'grep', root, pattern, flags, globFilter, profile, walkMs },
    timeoutMs,
    `That search took too long and was stopped (over ${Math.round(timeoutMs / 1000)}s). Try a simpler pattern.`,
    (matches) => ({ root, matches, count: matches.length })
  );
}

function globInWorker({ pattern, root, profile, timeoutMs = TIMEOUT_MS, walkMs = timeoutMs * WALK_SHARE }) {
  return runInWorker(
    { mode: 'glob', root, pattern, profile, walkMs, maxMatches: MAX_GLOB_MATCHES },
    timeoutMs,
    `That took too long and was stopped (over ${Math.round(timeoutMs / 1000)}s). Try a narrower folder.`,
    (matches) => ({ root, matches })
  );
}

module.exports = { grepInWorker, globInWorker };
