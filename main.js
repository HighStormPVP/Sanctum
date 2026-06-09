const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { exec, spawn } = require('child_process');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Register custom protocol for cached media (must run before app ready)
protocol.registerSchemesAsPrivileged([
  { scheme: 'aio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

let mainWindow;
let CACHE_DIR;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Sanctum',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm'
  })[ext] || 'application/octet-stream';
}

app.whenReady().then(() => {
  CACHE_DIR = path.join(app.getPath('userData'), 'media-cache');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  protocol.handle('aio-media', async (request) => {
    try {
      const url = new URL(request.url);
      const fname = path.basename(decodeURIComponent(url.pathname || url.hostname));
      const filePath = path.join(CACHE_DIR, fname);
      if (!fs.existsSync(filePath)) return new Response(null, { status: 404 });
      const buf = fs.readFileSync(filePath);
      return new Response(buf, { headers: { 'Content-Type': mimeFor(filePath) } });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });

  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('config:get', () => ({ ollamaUrl: OLLAMA_URL }));

ipcMain.handle('models:catalog', () => {
  const catalogPath = path.join(__dirname, 'models.json');
  return JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
});

// Candidate locations where the official Windows installer drops ollama.exe.
function ollamaInstallCandidates() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama app.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe'
  ];
}

function findOllamaExe() {
  for (const p of ollamaInstallCandidates()) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function pingOllama(timeoutMs = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

ipcMain.handle('ollama:detect', async () => {
  const exe = findOllamaExe();
  const running = await pingOllama();
  return { installed: !!exe, path: exe, running };
});

ipcMain.handle('ollama:start', async () => {
  // Prefer the tray app launcher if present — it ensures the server starts the
  // way the Ollama installer intended (auto-starts on subsequent logins, etc.).
  const tray = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama app.exe');
  const cli  = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe');
  let toLaunch = null;
  let args = [];
  if (fs.existsSync(tray)) { toLaunch = tray; }
  else if (fs.existsSync(cli)) { toLaunch = cli; args = ['serve']; }
  else { return { error: 'ollama not found in default install locations' }; }
  try {
    const child = spawn(toLaunch, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    // Wait briefly for the server to come up
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await pingOllama()) return { ok: true, started: toLaunch };
    }
    return { error: 'started process but Ollama did not respond within 30s' };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('ollama:install', async (evt) => {
  const channelId = `ollama:install:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const send = (msg) => { try { evt.sender.send(channelId, msg); } catch {} };

  (async () => {
    try {
      // 1) Download OllamaSetup.exe from the official URL.
      send({ phase: 'downloading', message: 'Downloading installer from ollama.com…' });
      const tmpFile = path.join(os.tmpdir(), `OllamaSetup-${Date.now()}.exe`);

      const res = await fetch('https://ollama.com/download/OllamaSetup.exe', { redirect: 'follow' });
      if (!res.ok) {
        send({ error: `Download failed: HTTP ${res.status}`, done: true });
        return;
      }
      const total = Number(res.headers.get('content-length') || 0);
      const fileStream = fs.createWriteStream(tmpFile);
      let received = 0;
      let lastReport = 0;

      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        received += value.length;
        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          send({ phase: 'downloading', received, total });
        }
      }
      await new Promise((r) => fileStream.end(r));
      send({ phase: 'downloading', received, total });

      // 2) Launch the installer. Use /SILENT so it runs in the background with
      //    only the UAC elevation prompt visible to the user.
      send({ phase: 'launching', message: 'Launching installer · please approve the UAC prompt' });
      try {
        const child = spawn(tmpFile, ['/SILENT', '/CLOSEAPPLICATIONS', '/NORESTART'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        child.unref();
      } catch (e) {
        send({ error: `Failed to launch installer: ${e.message}`, done: true });
        return;
      }

      // 3) Poll for Ollama to come up.
      send({ phase: 'waiting', message: 'Installing Ollama · waiting for it to come online…' });
      const deadline = Date.now() + 5 * 60_000; // 5 minutes
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2500));
        if (await pingOllama(2000)) {
          send({ phase: 'done', message: 'Ollama is up and running.', done: true });
          // Clean up the installer file
          try { fs.unlinkSync(tmpFile); } catch {}
          return;
        }
      }
      send({ error: 'Timed out waiting for Ollama. If you cancelled the UAC prompt or the installer, try again.', done: true });
    } catch (e) {
      send({ error: e.message, done: true });
    }
  })();

  return { channelId };
});

ipcMain.handle('ollama:list', async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    return await res.json();
  } catch (e) {
    return { error: e.message, models: [] };
  }
});

// Track active pulls so we can abort them. Map: channelId → { controller, tag }.
const activePulls = new Map();

ipcMain.handle('ollama:pull', async (evt, tag) => {
  const channelId = `ollama:pull:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  activePulls.set(channelId, { controller, tag });

  const debugLog = path.join(app.getPath('userData'), 'pull-debug.log');
  const dlog = (msg) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

  (async () => {
    dlog(`=== pull start · tag=${tag} ===`);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: tag, name: tag, stream: true }),
        signal: controller.signal
      });
      dlog(`http status=${res.status}`);
      if (!res.ok || !res.body) {
        const errBody = res.body ? await res.text() : '';
        dlog(`bad response: status=${res.status} body=${errBody.slice(0, 500)}`);
        evt.sender.send(channelId, { error: `Ollama pull ${res.status}: ${errBody.slice(0, 200)}`, done: true });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let chunkCount = 0;
      let lastStatus = '';
      let lastCompleted = 0;
      while (true) {
        let value, done;
        try { ({ value, done } = await reader.read()); }
        catch (e) {
          // Aborted reads land here when controller.abort() is called.
          if (controller.signal.aborted) { dlog('stream aborted by user'); evt.sender.send(channelId, { aborted: true, done: true }); return; }
          throw e;
        }
        if (done) { dlog(`stream done · chunks=${chunkCount} lastStatus="${lastStatus}" lastCompleted=${lastCompleted}`); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            chunkCount++;
            if (obj.status && obj.status !== lastStatus) {
              dlog(`#${chunkCount} status="${obj.status}"${obj.total ? ` total=${obj.total}` : ''}${obj.error ? ` ERROR=${obj.error}` : ''}`);
              lastStatus = obj.status;
            }
            if (obj.completed != null) lastCompleted = obj.completed;
            if (obj.error) dlog(`#${chunkCount} ERROR FIELD: ${obj.error}`);
            evt.sender.send(channelId, obj);
          } catch (e) {
            dlog(`parse failed: ${line.slice(0, 200)}`);
          }
        }
      }
      evt.sender.send(channelId, { done: true });
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') {
        dlog('exception due to abort');
        evt.sender.send(channelId, { aborted: true, done: true });
      } else {
        dlog(`exception: ${e.message}`);
        evt.sender.send(channelId, { error: e.message, done: true });
      }
    } finally {
      activePulls.delete(channelId);
    }
  })();
  return { channelId };
});

// Abort a pull. removeFiles=true also calls DELETE /api/delete to wipe the
// model entry (best effort — partial blobs may remain until `ollama prune`).
ipcMain.handle('ollama:pull-abort', async (_e, { channelId, removeFiles }) => {
  const entry = activePulls.get(channelId);
  if (entry) {
    try { entry.controller.abort(); } catch {}
    if (removeFiles && entry.tag) {
      try {
        await fetch(`${OLLAMA_URL}/api/delete`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: entry.tag, name: entry.tag })
        });
      } catch {}
    }
  } else if (removeFiles) {
    // No active fetch but caller wants to clean up — best-effort delete.
    return { ok: true, note: 'no active fetch; nothing to abort' };
  }
  return { ok: true };
});

// Track in-flight chat streams so the renderer can abort them (Stop button).
const activeChatStreams = new Map();

ipcMain.handle('ollama:chat', async (evt, { model, messages, images, tools, options }) => {
  const channelId = `ollama:chat:stream:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  activeChatStreams.set(channelId, controller);

  const debugLog = path.join(app.getPath('userData'), 'chat-debug.log');
  const dlog = (msg) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

  const body = { model, messages, stream: true };
  if (tools) body.tools = tools;
  if (options && typeof options === 'object') body.options = options;

  if (images && images.length && messages.length) {
    messages[messages.length - 1].images = images;
  }

  (async () => {
    dlog(`=== chat start · model=${model} msgs=${messages?.length} tools=${tools ? tools.length : 0} images=${images?.length || 0} ctx=${options?.num_ctx || '(default)'} ===`);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      dlog(`http status=${res.status}`);
      if (!res.ok || !res.body) {
        const errText = res.body ? await res.text() : '(no body)';
        dlog(`bad response: ${errText.slice(0, 500)}`);
        evt.sender.send(channelId, { error: `Ollama returned ${res.status}: ${errText.slice(0, 300)}`, done: true });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let chunkCount = 0;
      let totalContent = '';
      let toolCallCount = 0;
      while (true) {
        let value, done;
        try { ({ value, done } = await reader.read()); }
        catch (e) {
          if (controller.signal.aborted) { dlog('stream aborted by user'); evt.sender.send(channelId, { aborted: true, done: true }); return; }
          throw e;
        }
        if (done) { dlog(`stream done · chunks=${chunkCount} contentLen=${totalContent.length} toolCalls=${toolCallCount} preview=${JSON.stringify(totalContent.slice(0,80))}`); break; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            chunkCount++;
            if (obj.message?.content) totalContent += obj.message.content;
            if (obj.message?.tool_calls) toolCallCount += obj.message.tool_calls.length;
            if (chunkCount <= 2 || obj.done || obj.error) {
              dlog(`#${chunkCount} ${JSON.stringify(obj).slice(0, 300)}`);
            }
            evt.sender.send(channelId, obj);
          } catch (e) {
            dlog(`parse fail: ${line.slice(0, 200)}`);
          }
        }
      }
      evt.sender.send(channelId, { done: true });
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') {
        dlog('exception due to abort');
        evt.sender.send(channelId, { aborted: true, done: true });
      } else {
        dlog(`exception: ${e.message}`);
        evt.sender.send(channelId, { error: e.message, done: true });
      }
    } finally {
      activeChatStreams.delete(channelId);
    }
  })();

  return { channelId };
});

ipcMain.handle('ollama:chat-abort', (_e, channelId) => {
  const ctrl = activeChatStreams.get(channelId);
  if (!ctrl) return { ok: false, note: 'no active stream' };
  try { ctrl.abort(); } catch {}
  return { ok: true };
});

// =============== UNIVERSAL FILE PICKER ===============
// One picker that accepts any file. Routes by extension to:
//   - kind: 'image' — png/jpg/webp/etc., returned as base64 for vision models
//   - kind: 'pdf'   — pdf-parse extracts text + page count
//   - kind: 'text'  — any plain-text file (code, markdown, csv, json…) returned as UTF-8 text
//   - kind: 'unsupported' — binary files we can't read (.docx, .zip, .exe, …)
const IMAGE_EXTS = new Set(['png','jpg','jpeg','webp','gif','bmp','tif','tiff']);
const TEXT_EXTS = new Set([
  'txt','md','markdown','rst','log','csv','tsv',
  'json','jsonl','yaml','yml','toml','xml','ini','conf','cfg','env',
  'html','htm','css','scss','sass','less',
  'js','mjs','cjs','jsx','ts','tsx','vue','svelte',
  'py','rb','go','rs','c','cc','cpp','cxx','h','hpp','hxx',
  'java','kt','kts','scala','swift','m','mm','php','pl','lua',
  'sh','bash','zsh','fish','ps1','psm1','bat','cmd',
  'sql','graphql','gql','proto','dockerfile','makefile',
  'gitignore','editorconfig','prettierrc','eslintrc','npmrc','nvmrc',
  'lock','sum','mod','gradle','pom','cabal','cargo'
]);

function looksBinary(buf, sampleBytes = 4096) {
  const n = Math.min(buf.length, sampleBytes);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

ipcMain.handle('file:pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0] };
});

const VIDEO_EXTS = new Set(['mp4','mov','mkv','webm','avi','m4v','wmv','flv']);

// Inspect a file by path and pick the right attachment shape: image (base64),
// PDF (parsed text + pages), video (path only — ffmpeg streams), plain text
// (UTF-8 body), or — for anything else — a generic 'file' reference so the
// model still gets the metadata even if we can't read the bytes ourselves.
async function classifyFile(filePath) {
  if (!filePath) return { error: 'no file path' };
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase().replace(/^\./, '');
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch {}

  if (VIDEO_EXTS.has(ext)) {
    return { kind: 'video', name, path: filePath, ext, size };
  }
  if (IMAGE_EXTS.has(ext)) {
    try {
      const buf = fs.readFileSync(filePath);
      return { kind: 'image', name, path: filePath, base64: buf.toString('base64'), size };
    } catch (e) { return { error: e.message, kind: 'image', name }; }
  }
  if (ext === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return { kind: 'pdf', name, path: filePath, pages: data.numpages, text: data.text, size };
    } catch (e) { return { error: e.message, kind: 'pdf', name }; }
  }
  // Try plain text if it looks textual and isn't huge.
  if ((TEXT_EXTS.has(ext) || ext === '') && size <= 2 * 1024 * 1024) {
    try {
      const buf = fs.readFileSync(filePath);
      if (!looksBinary(buf)) {
        return { kind: 'text', name, path: filePath, text: buf.toString('utf-8'), size, ext };
      }
    } catch {/* fall through to generic */}
  }
  // Generic — anything else (zip, exe, .docx, .xlsx, arbitrary binary). Hand
  // back metadata so the model at least knows what was attached, even if we
  // can't unwrap it. Agents can read it directly via fs tools.
  return { kind: 'file', name, path: filePath, ext, size };
}

ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'All files', extensions: ['*'] }]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return classifyFile(r.filePaths[0]);
});

// Classify a file by its already-known path. Used by drag-and-drop in the
// renderer, which extracts the path via webUtils.getPathForFile and hands it
// to us via this IPC.
ipcMain.handle('file:from_path', async (_e, { path: filePath }) => {
  return classifyFile(filePath);
});

// =================== BACKGROUND TASKS ===================
// Lets the agent kick off long-running shell commands and continue working.
const backgroundTasks = new Map();
let nextTaskId = 1;

ipcMain.handle('shell:run_async', async (_e, { command, cwd, allowlist }) => {
  try {
    const wd = cwd ? resolveSafe(cwd) : os.homedir();
    if (allowlist?.length && !withinAllowlist(wd, allowlist)) {
      return { error: `cwd "${cwd}" outside allowed roots` };
    }
    const taskId = 'task_' + (nextTaskId++);
    const isWin = process.platform === 'win32';
    const proc = spawn(command, [], {
      cwd: wd,
      shell: isWin ? 'cmd.exe' : '/bin/sh',
      windowsHide: true
    });
    const task = {
      id: taskId, command, cwd: wd,
      proc, stdout: '', stderr: '',
      status: 'running', exitCode: null,
      startedAt: Date.now(), finishedAt: null
    };
    const cap = (s) => s.length > 200_000 ? s.slice(-200_000) : s;
    proc.stdout.on('data', d => { task.stdout = cap(task.stdout + d.toString()); });
    proc.stderr.on('data', d => { task.stderr = cap(task.stderr + d.toString()); });
    proc.on('exit', (code) => {
      task.status = (task.status === 'killed') ? 'killed' : 'done';
      task.exitCode = code;
      task.finishedAt = Date.now();
      task.proc = null;
    });
    proc.on('error', (err) => {
      task.status = 'error';
      task.stderr += '\n' + err.message;
      task.finishedAt = Date.now();
      task.proc = null;
    });
    backgroundTasks.set(taskId, task);
    return { taskId, command, cwd: wd };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('shell:task_status', async (_e, taskId) => {
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: 'task not found: ' + taskId };
  const elapsed = Math.round(((task.finishedAt || Date.now()) - task.startedAt) / 1000);
  return {
    id: task.id, command: task.command, cwd: task.cwd,
    status: task.status, exitCode: task.exitCode,
    stdout: task.stdout.slice(-10_000),
    stderr: task.stderr.slice(-10_000),
    runtime_seconds: elapsed
  };
});

ipcMain.handle('shell:task_list', async () => {
  const out = [];
  for (const t of backgroundTasks.values()) {
    out.push({
      id: t.id, command: t.command, status: t.status, exitCode: t.exitCode,
      runtime_seconds: Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000)
    });
  }
  return { tasks: out };
});

ipcMain.handle('shell:task_kill', async (_e, taskId) => {
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: 'task not found' };
  if (task.status !== 'running') return { error: `task already ${task.status}` };
  try { task.status = 'killed'; task.proc?.kill(); } catch {}
  return { ok: true };
});

// =================== CODE-BLOCK "OUTPUT" RUNNER ===================
// Writes the code snippet to a tempfile, spawns the right interpreter, and
// streams stdout/stderr line-by-line back to the renderer on a per-call
// channelId. Used by the ▷ Run button in code blocks.
//
// Supported langs:
//   python, py         → python (uses `py` on Win if available, else python)
//   javascript, js, mjs → node
//   typescript, ts     → npx ts-node (best-effort)
//   powershell, ps1    → powershell.exe (Windows) / pwsh
//   shell, bash, sh    → bash (Git-bash on Windows if installed)
//   batch, bat, cmd    → cmd /c
const LANG_RUNNERS = {
  py:   { ext: 'py',  cmd: process.platform === 'win32' ? 'python' : 'python3' },
  python: { ext: 'py', cmd: process.platform === 'win32' ? 'python' : 'python3' },
  js:   { ext: 'js',  cmd: 'node' },
  mjs:  { ext: 'mjs', cmd: 'node' },
  javascript: { ext: 'js', cmd: 'node' },
  ts:   { ext: 'ts',  cmd: 'npx', args: ['-y', 'ts-node'] },
  typescript: { ext: 'ts', cmd: 'npx', args: ['-y', 'ts-node'] },
  ps1:  { ext: 'ps1', cmd: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File'] },
  powershell: { ext: 'ps1', cmd: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File'] },
  sh:   { ext: 'sh',  cmd: 'bash' },
  bash: { ext: 'sh',  cmd: 'bash' },
  bat:  { ext: 'bat', cmd: 'cmd', args: ['/c'] },
  cmd:  { ext: 'bat', cmd: 'cmd', args: ['/c'] }
};

ipcMain.handle('shell:run_code_stream', async (e, { lang, code }) => {
  const channelId = `runcode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sender = e.sender;
  const safeSend = (payload) => { try { if (!sender.isDestroyed()) sender.send(channelId, payload); } catch {} };

  const runner = LANG_RUNNERS[(lang || '').toLowerCase()];
  if (!runner) {
    setImmediate(() => safeSend({ kind: 'error', text: `No runner registered for language: ${lang || '(none)'}`, done: true }));
    return { channelId };
  }

  // Write the snippet to a tempfile we can hand to the interpreter.
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tmpFile = path.join(os.tmpdir(), `aio-run-${stamp}.${runner.ext}`);
  try { fs.writeFileSync(tmpFile, code, 'utf8'); }
  catch (err) {
    setImmediate(() => safeSend({ kind: 'error', text: `Failed to write temp file: ${err.message}`, done: true }));
    return { channelId };
  }

  const taskId = 'task_' + (nextTaskId++);
  const spawnArgs = (runner.args || []).concat([tmpFile]);

  let proc;
  try {
    proc = spawn(runner.cmd, spawnArgs, {
      cwd: os.tmpdir(),
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    });
  } catch (err) {
    safeSend({ kind: 'error', text: `Couldn't start ${runner.cmd}: ${err.message}\n\nIs it installed and on PATH?`, done: true });
    try { fs.unlinkSync(tmpFile); } catch {}
    return { channelId };
  }

  const task = {
    id: taskId, command: `${runner.cmd} ${spawnArgs.join(' ')}`, cwd: os.tmpdir(),
    proc, stdout: '', stderr: '',
    status: 'running', exitCode: null,
    startedAt: Date.now(), finishedAt: null,
    tmpFile, channelId
  };
  backgroundTasks.set(taskId, task);
  safeSend({ kind: 'start', taskId, command: task.command });

  proc.stdout.on('data', (d) => {
    const text = d.toString();
    task.stdout += text;
    safeSend({ kind: 'stdout', text });
  });
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    task.stderr += text;
    safeSend({ kind: 'stderr', text });
  });
  proc.on('error', (err) => {
    task.status = 'error';
    task.finishedAt = Date.now();
    task.proc = null;
    safeSend({ kind: 'error', text: err.message, done: true, exitCode: -1, runtimeMs: task.finishedAt - task.startedAt });
    try { fs.unlinkSync(tmpFile); } catch {}
  });
  proc.on('exit', (code) => {
    if (task.status !== 'killed') task.status = code === 0 ? 'done' : 'error';
    task.exitCode = code;
    task.finishedAt = Date.now();
    task.proc = null;
    safeSend({
      kind: 'exit',
      exitCode: code,
      status: task.status,
      done: true,
      runtimeMs: task.finishedAt - task.startedAt
    });
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  return { channelId, taskId };
});

ipcMain.handle('shell:run_code_kill', async (_e, taskId) => {
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: 'task not found' };
  if (task.status !== 'running') return { error: `task already ${task.status}` };
  try { task.status = 'killed'; task.proc?.kill(); } catch (e) { return { error: e.message }; }
  return { ok: true };
});

// =================== VIDEO ANALYSIS PIPELINE ===================
// Architecture:
//   1. video:detect_deps    — check ffmpeg + python+whisper on PATH
//   2. video:install_dep    — winget ffmpeg / pip install openai-whisper (streamed)
//   3. video:extract        — ffmpeg → frames every 0.5s + 16kHz mono WAV (streamed)
//   4. video:transcribe     — whisper CLI on the WAV → JSON with segments
//   5. video:read_frame     — read a frame back as base64 for the vision model
//   6. video:cleanup_chat   — nuke a chat's video cache dir
//
// All long-running ops use the same channelId/safeSend pattern as ollama:chat.

const VIDEO_CACHE_ROOT = () => path.join(app.getPath('userData'), 'video-cache');

function execAsync(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const isWin = process.platform === 'win32';
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '', stderr: '' });
      return;
    }
    proc.stdout?.on('data', (d) => stdout += d.toString());
    proc.stderr?.on('data', (d) => stderr += d.toString());
    proc.on('error', (e) => resolve({ ok: false, error: e.message, stdout, stderr }));
    proc.on('exit', (code) => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
  });
}

ipcMain.handle('video:detect_deps', async () => {
  const ffmpeg = await execAsync('ffmpeg', ['-version']);
  const whisper = await execAsync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', 'import whisper; print(whisper.__version__)']);
  return {
    ffmpeg: {
      found: ffmpeg.ok,
      version: ffmpeg.ok ? (ffmpeg.stdout.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown' : null,
      error: ffmpeg.ok ? null : (ffmpeg.error || 'ffmpeg not on PATH')
    },
    whisper: {
      found: whisper.ok,
      version: whisper.ok ? whisper.stdout.trim() : null,
      error: whisper.ok ? null : 'openai-whisper Python package not installed'
    }
  };
});

ipcMain.handle('video:install_dep', async (e, { dep }) => {
  const channelId = `vidinstall_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sender = e.sender;
  const safeSend = (p) => { try { if (!sender.isDestroyed()) sender.send(channelId, p); } catch {} };

  // Pick the right installer per platform. ffmpeg uses winget on Windows,
  // Homebrew on macOS, the distro package manager hint on Linux. Whisper goes
  // through pip on every platform (just python vs python3).
  let cmd, args;
  if (dep === 'ffmpeg') {
    if (process.platform === 'win32') {
      cmd = 'winget';
      args = ['install', '-e', '--id', 'Gyan.FFmpeg', '--accept-source-agreements', '--accept-package-agreements', '--silent'];
    } else if (process.platform === 'darwin') {
      cmd = 'brew';
      args = ['install', 'ffmpeg'];
    } else {
      setImmediate(() => safeSend({ kind: 'error', text: 'Auto-install not supported on this platform. Install ffmpeg via your package manager (e.g. `sudo apt install ffmpeg`).', done: true }));
      return { channelId };
    }
  } else if (dep === 'whisper') {
    cmd = process.platform === 'win32' ? 'python' : 'python3';
    args = ['-m', 'pip', 'install', '--upgrade', 'openai-whisper'];
  } else {
    setImmediate(() => safeSend({ kind: 'error', text: `Unknown dependency: ${dep}`, done: true }));
    return { channelId };
  }

  safeSend({ kind: 'start', command: `${cmd} ${args.join(' ')}` });
  let proc;
  try {
    proc = spawn(cmd, args, { windowsHide: true, shell: false });
  } catch (err) {
    safeSend({ kind: 'error', text: `Couldn't run installer: ${err.message}`, done: true });
    return { channelId };
  }
  proc.stdout.on('data', (d) => safeSend({ kind: 'stdout', text: d.toString() }));
  proc.stderr.on('data', (d) => safeSend({ kind: 'stderr', text: d.toString() }));
  proc.on('error', (err) => safeSend({ kind: 'error', text: err.message, done: true }));
  proc.on('exit', (code) => safeSend({ kind: 'exit', exitCode: code, done: true, ok: code === 0 }));
  return { channelId };
});

// Probe video metadata via ffprobe (bundled with ffmpeg).
ipcMain.handle('video:probe', async (_e, { videoPath }) => {
  if (!videoPath || !fs.existsSync(videoPath)) return { error: 'video file not found' };
  const r = await execAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration,size:stream=width,height,r_frame_rate,codec_name',
    '-of', 'json', videoPath
  ]);
  if (!r.ok) return { error: r.stderr || r.error || 'ffprobe failed' };
  try {
    const j = JSON.parse(r.stdout);
    const s = (j.streams || [])[0] || {};
    return {
      duration_sec: parseFloat(j.format?.duration || '0'),
      size_bytes: parseInt(j.format?.size || '0', 10),
      width: s.width || 0, height: s.height || 0,
      codec: s.codec_name || '',
      fps: s.r_frame_rate || ''
    };
  } catch (e) { return { error: 'ffprobe parse failed: ' + e.message }; }
});

// Tracks active video subprocesses by channelId so the renderer can abort
// mid-pipeline (kills ffmpeg / whisper subprocess, then short-circuits).
const videoProcesses = new Map(); // channelId → { kind, proc, aborted }

// Extract frames + audio. Streams { kind: 'progress', stage, percent, framesDone, ... }.
// IMPORTANT: returns { channelId } IMMEDIATELY (defers work via setImmediate)
// so the renderer can register its IPC listener before any chunks are emitted.
// Awaiting the whole pipeline before returning loses every chunk.
ipcMain.handle('video:extract', async (e, { videoPath, chatId, fps = 2 }) => {
  const channelId = `vidextract_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sender = e.sender;
  const safeSend = (p) => { try { if (!sender.isDestroyed()) sender.send(channelId, p); } catch {} };
  const procEntry = { kind: 'extract', proc: null, aborted: false };
  videoProcesses.set(channelId, procEntry);

  setImmediate(() => {
    doVideoExtract({ videoPath, chatId, fps, safeSend, procEntry })
      .catch(err => safeSend({ kind: 'error', text: err.message || String(err), done: true }))
      .finally(() => videoProcesses.delete(channelId));
  });

  return { channelId };
});

async function doVideoExtract({ videoPath, chatId, fps, safeSend, procEntry }) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    safeSend({ kind: 'error', text: 'Video file not found', done: true });
    return;
  }

  const safeChatId = String(chatId || 'misc').replace(/[^a-zA-Z0-9_\-]/g, '_');
  const videoHash = crypto.createHash('sha1').update(videoPath + ':' + fs.statSync(videoPath).mtimeMs).digest('hex').slice(0, 12);
  const workDir = path.join(VIDEO_CACHE_ROOT(), safeChatId, videoHash);
  const framesDir = path.join(workDir, 'frames');
  const audioPath = path.join(workDir, 'audio.wav');
  try { fs.mkdirSync(framesDir, { recursive: true }); } catch (err) {
    safeSend({ kind: 'error', text: 'mkdir failed: ' + err.message, done: true });
    return;
  }
  safeSend({ kind: 'start', workDir, framesDir, audioPath });

  // 1) Probe duration so progress has a denominator. Failure is tolerable —
  // we just won't show a percentage.
  const probe = await execAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', videoPath]);
  let durationSec = 0;
  try { durationSec = parseFloat(JSON.parse(probe.stdout).format?.duration || '0'); } catch {}
  const expectedFrames = Math.max(1, Math.ceil(durationSec * fps));
  safeSend({ kind: 'meta', durationSec, expectedFrames });
  if (procEntry.aborted) { safeSend({ kind: 'aborted', done: true }); return; }

  // 2) Extract frames at the requested fps. (Dropped the conditional scale
  // filter — its single-quoted "min(960,iw)" syntax fails depending on how
  // the shell quotes it. JPEG -q:v 6 keeps file size reasonable at native res.)
  const framePattern = path.join(framesDir, 'f_%06d.jpg');
  const frameArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-vf', `fps=${fps}`,
    '-q:v', '6',
    framePattern
  ];
  await new Promise((resolve) => {
    let proc;
    try { proc = spawn('ffmpeg', frameArgs, { windowsHide: true }); }
    catch (err) { safeSend({ kind: 'error', text: 'ffmpeg spawn failed: ' + err.message, done: true }); resolve(); return; }
    procEntry.proc = proc;
    const pollT = setInterval(() => {
      try {
        const list = fs.readdirSync(framesDir).filter(f => f.startsWith('f_') && f.endsWith('.jpg'));
        safeSend({ kind: 'progress', stage: 'frames', framesDone: list.length, expectedFrames });
      } catch {}
    }, 300);
    let stderrBuf = '';
    proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    proc.on('error', (err) => { clearInterval(pollT); safeSend({ kind: 'error', text: 'ffmpeg frames: ' + err.message, done: true }); resolve(); });
    proc.on('exit', (code) => {
      clearInterval(pollT);
      if (code !== 0 && !procEntry.aborted) {
        safeSend({ kind: 'stderr', text: stderrBuf.slice(-2000) });
      }
      resolve();
    });
  });
  procEntry.proc = null;
  if (procEntry.aborted) { safeSend({ kind: 'aborted', done: true }); return; }

  // 3) Extract audio as 16 kHz mono WAV (whisper wants this).
  safeSend({ kind: 'progress', stage: 'audio', percent: 0 });
  const audioArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-vn', '-ar', '16000', '-ac', '1',
    audioPath
  ];
  const audioResult = await execAsync('ffmpeg', audioArgs);
  const audioOk = audioResult.ok && fs.existsSync(audioPath);
  if (procEntry.aborted) { safeSend({ kind: 'aborted', done: true }); return; }

  // 4) List final frames + timestamps.
  const frameList = [];
  try {
    const files = fs.readdirSync(framesDir).filter(f => f.startsWith('f_') && f.endsWith('.jpg')).sort();
    files.forEach((f, i) => {
      frameList.push({
        path: path.join(framesDir, f),
        index: i,
        timestamp_sec: i / fps
      });
    });
  } catch {}

  safeSend({
    kind: 'done',
    done: true,
    workDir, framesDir, audioPath: audioOk ? audioPath : null,
    durationSec,
    frames: frameList,
    audioOk,
    audioError: audioOk ? null : (audioResult.stderr || audioResult.error || 'audio extraction failed')
  });
}

// Abort the active extraction / transcription on this channel — kills the
// underlying subprocess and short-circuits the pipeline.
ipcMain.handle('video:abort', async (_e, { channelId }) => {
  const entry = videoProcesses.get(channelId);
  if (!entry) return { error: 'channel not found' };
  entry.aborted = true;
  try { entry.proc?.kill('SIGKILL'); } catch {}
  return { ok: true };
});

// Run whisper on the extracted audio. Streams progress (whisper prints per-segment).
// Same deferred-work pattern as video:extract so the renderer can register
// its listener before any chunks are emitted.
ipcMain.handle('video:transcribe', async (e, { audioPath, model = 'tiny' }) => {
  const channelId = `vidwhisper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const sender = e.sender;
  const safeSend = (p) => { try { if (!sender.isDestroyed()) sender.send(channelId, p); } catch {} };
  const procEntry = { kind: 'transcribe', proc: null, aborted: false };
  videoProcesses.set(channelId, procEntry);

  setImmediate(() => {
    if (!audioPath || !fs.existsSync(audioPath)) {
      safeSend({ kind: 'error', text: 'Audio file missing', done: true });
      videoProcesses.delete(channelId);
      return;
    }
    const py = process.platform === 'win32' ? 'python' : 'python3';
    safeSend({ kind: 'start', command: `whisper ${path.basename(audioPath)} --model ${model}` });

    const pyScript = `
import sys, json, whisper
model = whisper.load_model(${JSON.stringify(model)})
result = model.transcribe(${JSON.stringify(audioPath)}, verbose=False, fp16=False)
out = {
  "language": result.get("language"),
  "text": result.get("text", "").strip(),
  "segments": [
    {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": s.get("text", "").strip()}
    for s in result.get("segments", [])
  ],
}
print("___WHISPER_JSON_START___")
print(json.dumps(out))
print("___WHISPER_JSON_END___")
`.trim();

    let proc;
    try {
      proc = spawn(py, ['-u', '-c', pyScript], {
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
      });
    } catch (err) {
      safeSend({ kind: 'error', text: 'whisper spawn failed: ' + err.message, done: true });
      videoProcesses.delete(channelId);
      return;
    }
    procEntry.proc = proc;

    let buf = '';
    let collecting = false;
    let payload = '';
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line === '___WHISPER_JSON_START___') { collecting = true; continue; }
        if (line === '___WHISPER_JSON_END___')  {
          try { safeSend({ kind: 'transcript', data: JSON.parse(payload) }); }
          catch (err) { safeSend({ kind: 'error', text: 'transcript JSON parse failed: ' + err.message }); }
          collecting = false; payload = '';
          continue;
        }
        if (collecting) payload += line + '\n';
        else safeSend({ kind: 'log', text: line });
      }
    });
    proc.stderr.on('data', (d) => safeSend({ kind: 'log', text: d.toString() }));
    proc.on('error', (err) => {
      safeSend({ kind: 'error', text: err.message, done: true });
      videoProcesses.delete(channelId);
    });
    proc.on('exit', (code) => {
      videoProcesses.delete(channelId);
      if (procEntry.aborted) safeSend({ kind: 'aborted', done: true });
      else safeSend({ kind: 'exit', exitCode: code, done: true, ok: code === 0 });
    });
  });

  return { channelId };
});

// Read a single extracted frame back as base64 (for sending to the vision model).
ipcMain.handle('video:read_frame', async (_e, { framePath }) => {
  try {
    if (!framePath || !fs.existsSync(framePath)) return { error: 'frame not found' };
    const buf = fs.readFileSync(framePath);
    return { base64: buf.toString('base64'), size: buf.length };
  } catch (e) { return { error: e.message }; }
});

// Cleanup: delete a chat's whole video cache dir.
ipcMain.handle('video:cleanup_chat', async (_e, { chatId }) => {
  try {
    const safeChatId = String(chatId || 'misc').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const dir = path.join(VIDEO_CACHE_ROOT(), safeChatId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

// =============== WEB TOOLS ===============
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function stripTags(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

ipcMain.handle('web:search', async (_evt, query) => {
  try {
    if (!query || typeof query !== 'string') return { error: 'query required' };
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://html.duckduckgo.com/'
      },
      body: `q=${encodeURIComponent(query)}&b=&kl=us-en`
    });
    if (!res.ok) return { error: `DDG ${res.status}` };
    const html = await res.text();

    const results = [];
    const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = blockRe.exec(html)) && results.length < 8) {
      let link = m[1].replace(/&amp;/g, '&');
      // Skip ad results — these route through duckduckgo.com/y.js?ad_domain=...
      if (/^(\/\/|https?:\/\/)duckduckgo\.com\/y\.js/.test(link)) continue;
      const udd = link.match(/uddg=([^&]+)/);
      if (udd) link = decodeURIComponent(udd[1]);
      if (link.startsWith('//')) link = 'https:' + link;
      const title = stripTags(m[2]);
      const snippet = stripTags(m[3]);
      if (title && link.startsWith('http')) results.push({ url: link, title, snippet });
    }
    return { results };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('web:fetch', async (_evt, url) => {
  try {
    if (!url || !/^https?:\/\//.test(url)) return { error: 'http(s) url required' };
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, redirect: 'follow' });
    if (!res.ok) return { error: `fetch ${res.status}` };
    const ctype = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ctype.includes('json')) return { url, content: text.slice(0, 20000), kind: 'json' };
    return { url, content: stripTags(text).slice(0, 20000), kind: 'html' };
  } catch (e) {
    return { error: e.message };
  }
});

// =============== FILE SYSTEM TOOLS ===============
function resolveSafe(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let resolved = p.trim();
  // Expand a leading ~ to the user's home dir
  if (resolved === '~') resolved = os.homedir();
  else if (resolved.startsWith('~' + path.sep) || resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  }
  return path.isAbsolute(resolved) ? resolved : path.resolve(os.homedir(), resolved);
}

function withinAllowlist(filePath, allowlist) {
  if (!allowlist || !allowlist.length) return true;
  for (const a of allowlist) {
    const root = resolveSafe(a);
    if (!root) continue;
    if (filePath === root) return true;
    if (filePath.startsWith(root + path.sep)) return true;
  }
  return false;
}

ipcMain.handle('fs:read_file', async (_e, requestedPath, allowlist) => {
  try {
    const fp = resolveSafe(requestedPath);
    if (!fp) return { error: 'path required' };
    if (!withinAllowlist(fp, allowlist)) return { error: `path "${requestedPath}" is outside the allowed roots: ${(allowlist || []).join(', ')}` };
    if (!fs.existsSync(fp)) return { error: 'file not found' };
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return { error: 'path is a directory — use list_dir instead' };
    if (stat.size > 200_000) return { error: `file too large (${(stat.size/1024).toFixed(1)} KB, max 200 KB)` };
    const content = fs.readFileSync(fp, 'utf-8');
    return { path: fp, content, size: stat.size };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:list_dir', async (_e, requestedPath, allowlist) => {
  try {
    const fp = resolveSafe(requestedPath);
    if (!fp) return { error: 'path required' };
    if (!withinAllowlist(fp, allowlist)) return { error: `path "${requestedPath}" is outside the allowed roots: ${(allowlist || []).join(', ')}` };
    if (!fs.existsSync(fp)) return { error: 'directory not found' };
    const stat = fs.statSync(fp);
    if (!stat.isDirectory()) return { error: 'not a directory' };
    const dirents = fs.readdirSync(fp, { withFileTypes: true }).slice(0, 200);
    const entries = dirents.map(d => {
      const full = path.join(fp, d.name);
      let size = null;
      try { if (d.isFile()) size = fs.statSync(full).size; } catch {}
      return { name: d.name, kind: d.isDirectory() ? 'dir' : (d.isSymbolicLink() ? 'link' : 'file'), size };
    });
    return { path: fp, entries };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:write_file', async (_e, { path: p, content, allowlist }) => {
  try {
    const fp = resolveSafe(p);
    if (!fp) return { error: 'path required' };
    if (!withinAllowlist(fp, allowlist)) return { error: `path "${p}" is outside the allowed roots: ${(allowlist || []).join(', ')}` };
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content ?? '', 'utf-8');
    return { path: fp, bytes: Buffer.byteLength(content ?? '', 'utf-8') };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:apply_patch', async (_e, { path: p, find, replace, allowlist }) => {
  try {
    const fp = resolveSafe(p);
    if (!fp) return { error: 'path required' };
    if (!withinAllowlist(fp, allowlist)) return { error: `path "${p}" is outside the allowed roots: ${(allowlist || []).join(', ')}` };
    if (typeof find !== 'string' || !find.length) return { error: 'find string required' };
    if (!fs.existsSync(fp)) return { error: 'file not found' };
    const orig = fs.readFileSync(fp, 'utf-8');
    const matches = orig.split(find).length - 1;
    if (matches === 0) return { error: 'find string not found in file' };
    if (matches > 1) return { error: `find string matches ${matches} times — make it more specific` };
    const next = orig.replace(find, replace ?? '');
    fs.writeFileSync(fp, next, 'utf-8');
    return { path: fp, before_lines: orig.split('\n').length, after_lines: next.split('\n').length };
  } catch (e) { return { error: e.message }; }
});

// =============== AUDIT LOG ===============
function auditLogPath() {
  return path.join(app.getPath('userData'), 'agent-audit.log');
}

ipcMain.handle('audit:log', (_e, entry) => {
  try {
    fs.appendFileSync(auditLogPath(), JSON.stringify(entry) + '\n');
    return { ok: true };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('audit:path', () => auditLogPath());

ipcMain.handle('audit:open', async () => {
  const { shell } = require('electron');
  const p = auditLogPath();
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  await shell.openPath(p);
  return { ok: true };
});

// =================== GLOB / GREP ===================
// Custom glob → regex (no external deps). `**` matches any chars including /,
// `*` matches anything except /, `?` matches one char.
function globToRegex(pattern) {
  let p = pattern.replace(/\\/g, '/');
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

function walkFiles(root, opts = {}) {
  const { maxFiles = 10000, allowlist = null } = opts;
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
      if (allowlist && !withinAllowlist(full, allowlist)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

ipcMain.handle('fs:glob', async (_e, { pattern, root, allowlist }) => {
  try {
    const r = resolveSafe(root || os.homedir());
    if (!r) return { error: 'root required' };
    if (!withinAllowlist(r, allowlist)) return { error: 'root outside allowed roots' };
    if (!pattern || typeof pattern !== 'string') return { error: 'pattern required' };
    const re = globToRegex(pattern);
    const all = walkFiles(r, { allowlist });
    const matches = [];
    for (const f of all) {
      const rel = path.relative(r, f).replace(/\\/g, '/');
      if (re.test(rel)) { matches.push(rel); if (matches.length >= 500) break; }
    }
    return { root: r, matches };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:grep', async (_e, { pattern, root, glob: globFilter, caseInsensitive, allowlist }) => {
  try {
    const r = resolveSafe(root || os.homedir());
    if (!r) return { error: 'root required' };
    if (!withinAllowlist(r, allowlist)) return { error: 'root outside allowed roots' };
    if (!pattern || typeof pattern !== 'string') return { error: 'pattern required' };
    let re;
    try { re = new RegExp(pattern, caseInsensitive ? 'i' : ''); }
    catch (e) { return { error: 'invalid regex: ' + e.message }; }
    const fileRe = globFilter ? globToRegex(globFilter) : null;
    const files = walkFiles(r, { allowlist });
    const matches = [];
    const MAX_MATCHES = 100;
    const MAX_FILE_SIZE = 1024 * 1024;
    outer:
    for (const file of files) {
      const rel = path.relative(r, file).replace(/\\/g, '/');
      if (fileRe && !fileRe.test(rel)) continue;
      let content;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_SIZE) continue;
        content = fs.readFileSync(file, 'utf-8');
      } catch { continue; }
      if (content.indexOf('\0') !== -1) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
          if (matches.length >= MAX_MATCHES) break outer;
        }
      }
    }
    return { root: r, matches, count: matches.length };
  } catch (e) { return { error: e.message }; }
});

// =============== SHELL ===============
ipcMain.handle('shell:run', async (_e, { command, cwd }) => {
  return new Promise((resolve) => {
    const wd = cwd ? resolveSafe(cwd) : os.homedir();
    const isWin = process.platform === 'win32';
    exec(command, {
      cwd: wd,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      shell: isWin ? 'cmd.exe' : '/bin/sh',
      windowsHide: true
    }, (err, stdout, stderr) => {
      resolve({
        command,
        cwd: wd,
        exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: (stdout || '').slice(0, 20_000),
        stderr: (stderr || '').slice(0, 20_000),
        timedOut: !!err?.killed
      });
    });
  });
});

// Download a ComfyUI-generated media file into the local cache and return an aio-media:// URL.
ipcMain.handle('media:cache', async (_evt, sourceUrl) => {
  try {
    if (!CACHE_DIR) return { error: 'cache not ready' };
    const res = await fetch(sourceUrl);
    if (!res.ok) return { error: `fetch ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);

    // Derive extension from the source URL's filename query param.
    let ext = '.png';
    try {
      const u = new URL(sourceUrl);
      const fname = u.searchParams.get('filename') || '';
      const m = fname.match(/\.(png|jpg|jpeg|webp|gif|mp4|webm)$/i);
      if (m) ext = '.' + m[1].toLowerCase();
    } catch {}

    const fname = `${hash}${ext}`;
    const fp = path.join(CACHE_DIR, fname);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
    return { url: `aio-media://local/${fname}`, kind: /\.(mp4|webm)$/i.test(ext) ? 'video' : 'image' };
  } catch (e) {
    return { error: e.message };
  }
});
