// Path checks and file walking for the agent's file tools. No Electron here, so
// test/main-rules.test.js can run them directly.
const fs = require('fs');
const path = require('path');

// Resolves symlinks in the part of the path that exists. A file about to be
// created has no real path yet, so its nearest existing parent is checked.
function canonicalize(p, pathMod, realpath) {
  let current = pathMod.resolve(p);
  const missing = [];
  while (true) {
    try {
      return pathMod.join(realpath(current), ...missing);
    } catch {
      const parent = pathMod.dirname(current);
      if (parent === current) return pathMod.join(current, ...missing);
      missing.unshift(pathMod.basename(current));
      current = parent;
    }
  }
}

function isInside(target, root, pathMod) {
  const withSep = root.endsWith(pathMod.sep) ? root : root + pathMod.sep;
  return target === root || target.startsWith(withSep);
}

// By the words alone, touching nothing. Canonicalizing a path asks the file system about it, and for
// \\server\share that means Windows goes out to that server and may offer it the user's credentials.
// So nothing gets canonicalized until this says it's inside a folder someone allowed.
function isLexicallyWithin(filePath, roots, opts = {}) {
  if (!Array.isArray(roots) || !roots.length || !filePath) return false;
  const pathMod = opts.pathMod || path;
  const platform = opts.platform || process.platform;
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(pathMod.resolve(filePath));
  return roots.some((r) => typeof r === 'string' && r.trim() && isInside(target, fold(pathMod.resolve(r.trim())), pathMod));
}

function isCanonicallyWithin(filePath, roots, opts = {}) {
  const pathMod = opts.pathMod || path;
  const platform = opts.platform || process.platform;
  const realpath = opts.realpath || ((p) => fs.realpathSync.native(p));
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(canonicalize(filePath, pathMod, realpath));
  return roots.some((r) => typeof r === 'string' && r.trim() && isInside(target, fold(canonicalize(r.trim(), pathMod, realpath)), pathMod));
}

// True only if filePath is one of the roots or inside one, by its words and then by where links
// really lead. No roots means nothing is allowed: a chat with no folder has to ask first. Only a
// root the path is lexically inside gets canonicalized, so a network folder someone has allowed
// costs nothing to anything else.
function isWithinRoots(filePath, roots, opts = {}) {
  if (!Array.isArray(roots) || !roots.length || !filePath) return false;
  const near = roots.filter((r) => isLexicallyWithin(filePath, [r], opts));
  return near.length > 0 && isCanonicallyWithin(filePath, near, opts);
}

// Sanctum's own data folder holds the API keys, every chat, and the Remote Control secrets. No
// agent file tool goes in there, whoever started the run. Uses the same canonicalizing as the
// allowlist, so case on Windows, dots, and links don't get around it. It does touch what it's given,
// so a path from outside gets checkAgentPath first.
function isInProfile(filePath, profile, opts) {
  return !!profile && !!filePath && isCanonicallyWithin(filePath, [profile], opts);
}

// What the agent's file tools ask of a path: null if it may be used, or 'profile' or 'outside'.
// In this order, so a path nobody allowed is refused by its words before anything looks at it, and
// a path in the profile can't be offered the pop-up that widens the allowlist.
function checkAgentPath(filePath, { roots, profile, ...opts }) {
  if (profile && isLexicallyWithin(filePath, [profile], opts)) return 'profile';
  if (!isLexicallyWithin(filePath, roots, opts)) return 'outside';
  if (isInProfile(filePath, profile, opts)) return 'profile';
  return isWithinRoots(filePath, roots, opts) ? null : 'outside';
}

// The replacer function matters: as a plain string, `$&` and `$$` in the new text
// would be treated as patterns and silently change what gets written.
function applyExactPatch(original, find, replace) {
  return original.replace(find, () => replace ?? '');
}

// Custom glob → regex (no external deps). `**` matches any chars including /,
// `*` matches anything except /, `?` matches one char.
function globToRegex(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i += 2; if (p[i] === '/') i++; }
      else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^${}()|[]\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  return new RegExp('^' + re + '$', 'i');
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode']);

// The caller checks that root is allowed. Links are skipped here, so nothing
// under root can lead outside it. skipDir says which folders to go around.
function walkFiles(root, opts = {}) {
  const { maxFiles = 10000, skipDir, deadline } = opts;
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    if (deadline && Date.now() > deadline) {
      out.timedOut = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDir || !skipDir(full)) stack.push(full);
      }
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

// The same functions for a worker to run, as text so it works from inside the packaged archive.
const WALK_WORKER_SOURCE = `
const fs = require('fs');
const path = require('path');
const SKIP_DIRS = new Set(${JSON.stringify([...SKIP_DIRS])});
${canonicalize}
${isInside}
${isCanonicallyWithin}
${isInProfile}
${globToRegex}
${walkFiles}
`;

module.exports = { isWithinRoots, isLexicallyWithin, isInProfile, checkAgentPath, applyExactPatch, globToRegex, walkFiles, WALK_WORKER_SOURCE };
