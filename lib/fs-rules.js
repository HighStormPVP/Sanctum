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

// True only if filePath is one of the roots or inside one. No roots means
// nothing is allowed: a chat with no folder has to ask first.
function isWithinRoots(filePath, roots, opts = {}) {
  if (!Array.isArray(roots) || !roots.length || !filePath) return false;
  const pathMod = opts.pathMod || path;
  const platform = opts.platform || process.platform;
  const realpath = opts.realpath || ((p) => fs.realpathSync.native(p));
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const target = fold(canonicalize(filePath, pathMod, realpath));
  return roots.some((r) => {
    if (typeof r !== 'string' || !r.trim()) return false;
    const root = fold(canonicalize(r.trim(), pathMod, realpath));
    const withSep = root.endsWith(pathMod.sep) ? root : root + pathMod.sep;
    return target === root || target.startsWith(withSep);
  });
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
// under root can lead outside it.
function walkFiles(root, opts = {}) {
  const { maxFiles = 10000 } = opts;
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

module.exports = { isWithinRoots, applyExactPatch, globToRegex, walkFiles };
