const { app, BrowserWindow, Menu, Tray, Notification, nativeImage, powerSaveBlocker, ipcMain, dialog, protocol, net, session, shell: electronShell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { exec, spawn } = require('child_process');
const { McpManager } = require('./lib/mcp-manager');
const { isWithinRoots, checkAgentPath, applyExactPatch, folderListing, createRootsProbe } = require('./lib/fs-rules');
const { safeFetchText, isAppPage } = require('./lib/url-rules');
const { grepInWorker, globInWorker } = require('./lib/grep-runner');
const { detectRepetitionLoop, splitOutputLines, quoteWindowsArg, encodePowerShell } = require('./lib/text-rules');
const { killTree, startInOwnGroup, runShellCommand } = require('./lib/kill-tree');
const { devToolsAllowed, applicationMenuTemplate } = require('./lib/window-rules');
const { createKeystore, retryTransient } = require('./lib/remote/keystore');
const { createManager: createRemoteManager } = require('./lib/remote/manager');
const remoteRelayClient = require('./lib/remote/relay-client');
const { createDirectPath } = require('./lib/remote/direct-path');
const RemoteRules = require('./lib/remote-rules');

// Only this app's own page may use anything registered on ipcMain. The hidden transport window
// parses what peers and the network send, so a renderer exploit there must not reach the
// shell, the files, or the keys. Wrapped here, before anything registers, so a new handler
// can't forget. The transport's own channel is on its webContents, not here. A listener added
// this way can't be taken off by reference, and nothing here does that.
for (const method of ['handle', 'handleOnce']) {
  const register = ipcMain[method].bind(ipcMain);
  ipcMain[method] = (channel, handler) => register(channel, (e, ...args) => {
    if (!isLocalUi(e)) throw new Error("This can only be used from this app's own window.");
    return handler(e, ...args);
  });
}
for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
  const register = ipcMain[method].bind(ipcMain);
  ipcMain[method] = (channel, listener) => register(channel, (e, ...args) => {
    if (isLocalUi(e)) listener(e, ...args);
  });
}

// Chunks sent before an invoke returns are lost, because the preload can't listen
// for a channel until it knows the name. This holds them until the reply is out.
function deferredSender(sender, channelId) {
  const send = (p) => { try { if (!sender.isDestroyed()) sender.send(channelId, p); } catch {} };
  let queue = [];
  setImmediate(() => { const held = queue; queue = null; held.forEach(send); });
  return (p) => { if (queue) queue.push(p); else send(p); };
}

// Apps opened from Finder or a desktop launcher get a minimal PATH, which hides
// Homebrew's ffmpeg, npx, and brew. Windows apps get the full PATH already.
function fixPackagedPath() {
  if (!app.isPackaged || process.platform === 'win32') return;
  const loginShell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const child = spawn(loginShell, ['-ilc', 'printf "%s" "$PATH"'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 3000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => clearTimeout(timer));
    child.on('exit', () => {
      clearTimeout(timer);
      if (out.trim()) process.env.PATH = `${out.trim()}:${process.env.PATH || ''}`;
    });
  } catch {}
}
// One Sanctum per profile. Electron keys this on userData, so instances with a --user-data-dir of their
// own run side by side. A second launch, from a shortcut or a login start next to a manual one, hands
// over to the first and goes before it opens a window, the keystore, or any connection.
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.exit(0);
app.on('second-instance', () => { if (app.isReady()) showMainWindow(); });

fixPackagedPath();

let mcpManager = null;
function broadcastMcpUpdate() {
  // Each server's env is in this, and often tokens with it, so it goes to the main window only.
  sendToLocalUi('mcp:updated', mcpManager ? mcpManager.listServers() : []);
}

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Pick the shell that run_command / run_command_async will spawn. On Windows
// we prefer Git Bash if it's installed so the agent can write POSIX-style
// commands (forward slashes, &&, heredocs, $VAR) — same syntax as macOS /
// Linux. Falls back to cmd.exe if Git Bash isn't there. Detected once at
// boot; renderer reads the label via shell:info.
function detectShell() {
  try {
    if (process.platform === 'win32') {
      const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
      ];
      for (const p of candidates) {
        try { if (fs.statSync(p).isFile()) return { name: 'Bash', path: p }; } catch {}
      }
      return { name: 'Cmd', path: 'cmd.exe' };
    }
    return { name: 'Bash', path: '/bin/sh' };
  } catch {
    // Don't crash main process boot over shell detection — fall back to
    // platform defaults.
    return process.platform === 'win32'
      ? { name: 'Cmd', path: 'cmd.exe' }
      : { name: 'Bash', path: '/bin/sh' };
  }
}
const SHELL = detectShell();
ipcMain.handle('shell:info', () => ({ name: SHELL.name, path: SHELL.path }));

// =============== HARDWARE DETECTION ===============
// Probes what the machine can actually run an LLM on. The Download tab uses
// this to tell the user whether a model fits BEFORE they spend 20 minutes
// pulling it. Cached after the first probe — hardware doesn't change mid-run.
//
// The key number is `budgetGB`: memory genuinely available for model weights.
//   - Discrete GPU  -> VRAM (Ollama offloads to GPU; system RAM is a fallback)
//   - Apple Silicon -> unified memory, ~70% is addressable by the GPU
//   - CPU only      -> ~70% of system RAM (OS + apps need the rest)
let HW_CACHE = null;

function execOut(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

// NVIDIA cards report VRAM precisely via nvidia-smi. Most reliable source on
// any platform when it's present.
async function probeNvidia() {
  const out = await execOut('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits');
  const line = out.split('\n').map(s => s.trim()).filter(Boolean)[0];
  if (!line) return null;
  const parts = line.split(',');
  if (parts.length < 2) return null;
  const mib = parseFloat(parts[1]);
  if (!isFinite(mib) || mib <= 0) return null;
  return { name: parts[0].trim(), vramGB: +(mib / 1024).toFixed(1), vendor: 'nvidia' };
}

async function probeWindowsGpu() {
  // Win32_VideoController.AdapterRAM is a uint32 and silently caps at 4 GB, so
  // it's useless for modern cards. The driver registry key holds the real
  // 64-bit size. Fall back to the name alone if the registry read fails.
  const ps = `$ErrorActionPreference='SilentlyContinue';
    $g = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -ne $null } | Select-Object -First 1;
    $base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    $vram=0;
    Get-ChildItem $base 2>$null | ForEach-Object {
      $q = (Get-ItemProperty $_.PSPath -Name 'HardwareInformation.qwMemorySize' -EA SilentlyContinue).'HardwareInformation.qwMemorySize';
      if ($q -and $q -gt $vram) { $vram = $q }
    };
    Write-Output ("{0}|{1}" -f $g.Name, $vram)`;
  const out = await execOut(`powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(ps)}`, 8000);
  const line = out.split('\n').map(s => s.trim()).filter(Boolean).pop();
  if (!line || !line.includes('|')) return null;
  const [name, raw] = line.split('|');
  const bytes = parseFloat(raw);
  if (!name) return null;
  const vramGB = isFinite(bytes) && bytes > 0 ? +(bytes / 1024 ** 3).toFixed(1) : 0;
  return { name: name.trim(), vramGB, vendor: /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : 'other' };
}

async function probeMacGpu() {
  const out = await execOut('system_profiler SPDisplaysDataType -json', 8000);
  try {
    const j = JSON.parse(out);
    const d = j?.SPDisplaysDataType?.[0];
    if (!d) return null;
    return { name: d.sppci_model || 'Apple GPU', vramGB: 0, vendor: 'apple' };
  } catch { return null; }
}

async function detectHardware() {
  if (HW_CACHE) return HW_CACHE;

  const totalRamGB = +(os.totalmem() / 1024 ** 3).toFixed(1);
  const freeRamGB = +(os.freemem() / 1024 ** 3).toFixed(1);
  const cpus = os.cpus() || [];
  const platform = process.platform;
  const arch = process.arch;
  const isAppleSilicon = platform === 'darwin' && arch === 'arm64';

  let gpu = null;
  try {
    gpu = await probeNvidia();
    if (!gpu && platform === 'win32') gpu = await probeWindowsGpu();
    if (!gpu && platform === 'darwin') gpu = await probeMacGpu();
  } catch { /* hardware probing is best-effort — never fatal */ }

  // Two separate budgets, because Ollama does PARTIAL offload: it loads as
  // many layers onto the GPU as fit and runs the remainder on the CPU. So a
  // model bigger than VRAM isn't unrunnable — it's just slow. Collapsing both
  // into one number would label perfectly usable models "unrunnable".
  //
  //   fastBudgetGB — fits entirely in GPU/unified memory: full speed
  //   maxBudgetGB  — fits in system RAM: runs, but CPU-bound and slow
  const sysBudget = +(totalRamGB * 0.7).toFixed(1);
  let fastBudgetGB, budgetSource;
  if (isAppleSilicon) {
    // Unified memory — the GPU addresses system RAM directly, so there's no
    // fast/slow split in the same way. Roughly 70% is usable by Metal.
    fastBudgetGB = sysBudget;
    budgetSource = 'unified';
  } else if (gpu && gpu.vramGB >= 2) {
    fastBudgetGB = gpu.vramGB;
    budgetSource = 'vram';
  } else {
    fastBudgetGB = sysBudget;
    budgetSource = 'ram';
  }

  HW_CACHE = {
    platform, arch, isAppleSilicon,
    totalRamGB, freeRamGB,
    cpuModel: cpus[0]?.model?.trim() || 'Unknown CPU',
    cpuCores: cpus.length,
    gpuName: gpu?.name || null,
    gpuVendor: gpu?.vendor || null,
    vramGB: gpu?.vramGB || 0,
    fastBudgetGB,
    maxBudgetGB: Math.max(fastBudgetGB, sysBudget),
    budgetSource
  };
  return HW_CACHE;
}

ipcMain.handle('hw:detect', () => detectHardware());

// Live counters for the debug overlay. Polled ~1s while the overlay is open
// and never otherwise — spawning nvidia-smi on a timer isn't free.
// Everything is best-effort: a machine with no NVIDIA card still gets RAM
// and CPU, with the GPU fields simply absent.
let lastCpu = null;
function cpuLoadPercent() {
  // os.loadavg() is meaningless on Windows, so derive load from the delta in
  // cumulative CPU times between polls instead.
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!lastCpu) { lastCpu = { idle, total }; return null; }
  const dIdle = idle - lastCpu.idle;
  const dTotal = total - lastCpu.total;
  lastCpu = { idle, total };
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - dIdle / dTotal))));
}

ipcMain.handle('hw:live', async () => {
  const totalRamGB = os.totalmem() / 1024 ** 3;
  const freeRamGB = os.freemem() / 1024 ** 3;
  const out = {
    ramUsedGB: +(totalRamGB - freeRamGB).toFixed(1),
    ramTotalGB: +totalRamGB.toFixed(1),
    cpuPct: cpuLoadPercent(),
    gpu: null
  };
  // utilization.gpu = SM busy %, memory.used/total in MiB.
  const raw = await execOut('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits', 2500);
  const line = raw.split('\n').map(s => s.trim()).filter(Boolean)[0];
  if (line) {
    const p = line.split(',').map(s => s.trim());
    if (p.length >= 4) {
      const used = parseFloat(p[2]), total = parseFloat(p[3]), util = parseFloat(p[1]);
      if (isFinite(used) && isFinite(total)) {
        out.gpu = {
          name: p[0],
          utilPct: isFinite(util) ? util : null,
          vramUsedGB: +(used / 1024).toFixed(1),
          vramTotalGB: +(total / 1024).toFixed(1)
        };
      }
    }
  }
  return out;
});

// =============== FREEZE WATCHDOG ===============
// When a model is too big for the machine, the OS starts swapping and the
// whole desktop stops responding — the cursor barely moves and clicking Stop
// becomes impossible. This watchdog notices that and pulls the plug itself.
//
// How it detects a freeze: a 1s timer that measures its own lateness. If the
// OS is thrashing, every process gets starved of CPU, so our timer fires late.
// A tick that arrives 15s late means the main process was descheduled for 15s
// — that IS the freeze, observed from the inside.
//
// Why the main process and not the renderer: main is far lighter (no
// rendering, no GPU work), so it's the likeliest part of the app to still get
// scheduled under memory pressure. It also owns the abort controllers.
//
// Honest limits: if the machine is so far gone that this process never gets
// scheduled at all, nothing here can run — no in-app watchdog can survive
// that, and the only fix is the OS killing something. This handles the common
// case (badly degraded but still creeping along), not total lockup.
const WD_TICK_MS = 1000;
const WD_STALL_FLOOR_MS = 1500;   // lateness below this is normal jitter, ignore
const WD_DEFAULT_TRIP_MS = 15000; // sustained stall before we intervene

let wdEnabled = true;
let wdTripMs = WD_DEFAULT_TRIP_MS;
let wdStallAccum = 0;
let wdLastTick = Date.now();
let wdTripping = false;

ipcMain.handle('watchdog:config', (_e, { enabled, tripMs } = {}) => {
  if (typeof enabled === 'boolean') wdEnabled = enabled;
  if (Number.isFinite(tripMs) && tripMs >= 5000) wdTripMs = tripMs;
  return { enabled: wdEnabled, tripMs: wdTripMs };
});

// Tell Ollama to drop the model NOW. Aborting the stream stops generation but
// leaves the weights resident for keep_alive (5 min default) — and those
// weights are the memory that froze the machine. keep_alive: 0 evicts them.
async function unloadOllamaModel(model) {
  if (!model) return false;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(5000)
    });
    return res.ok;
  } catch { return false; }
}

async function wdTrip(stalledMs) {
  if (wdTripping) return;
  wdTripping = true;
  const debugLog = path.join(app.getPath('userData'), 'chat-debug.log');
  const dlog = (m) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

  // Only local streams can be the cause — a cloud request uses no local memory.
  const local = [...activeChatStreams.entries()].filter(([, e]) => e.local);
  if (!local.length) { wdTripping = false; wdStallAccum = 0; return; }

  const freeGB = +(os.freemem() / 1024 ** 3).toFixed(1);
  const models = [...new Set(local.map(([, e]) => e.model).filter(Boolean))];
  dlog(`WATCHDOG TRIP · stalled ${Math.round(stalledMs)}ms · freeRAM ${freeGB}GB · aborting ${local.length} stream(s): ${models.join(', ')}`);

  for (const [, e] of local) { try { e.controller.abort(); } catch {} }
  // Then evict the weights — this is what actually gives the machine its
  // memory back and ends the freeze.
  const unloaded = [];
  for (const m of models) if (await unloadOllamaModel(m)) unloaded.push(m);
  dlog(`WATCHDOG · unloaded: ${unloaded.join(', ') || '(none)'}`);

  sendToLocalUi('system:freeze-abort', {
    stalledMs: Math.round(stalledMs), freeGB, models, unloaded
  });
  wdStallAccum = 0;
  setTimeout(() => { wdTripping = false; }, 5000); // debounce re-trips
}

setInterval(() => {
  const now = Date.now();
  const late = now - wdLastTick - WD_TICK_MS; // how far behind schedule we are
  wdLastTick = now;

  // Only armed while a local model is actually generating. Nothing to abort
  // otherwise, and it keeps the watchdog from reacting to unrelated hitches
  // like a big file read or the machine waking from sleep.
  const armed = wdEnabled && [...activeChatStreams.values()].some(e => e.local);
  if (!armed) { wdStallAccum = 0; return; }

  if (late > WD_STALL_FLOOR_MS) {
    wdStallAccum += late;
    if (wdStallAccum >= wdTripMs) wdTrip(wdStallAccum);
  } else {
    // Recovering — bleed the accumulator down rather than resetting, so a
    // stuttering freeze (repeated 3s hitches) still adds up to a trip.
    wdStallAccum = Math.max(0, wdStallAccum - WD_TICK_MS);
  }
}, WD_TICK_MS);

// Register custom protocol for cached media (must run before app ready)
protocol.registerSchemesAsPrivileged([
  { scheme: 'aio-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'aio-preview', privileges: { standard: true, secure: true } },
  { scheme: 'aio-transport', privileges: { standard: true, secure: true } }
]);

let mainWindow;
let CACHE_DIR;

const previewPages = new Map();
ipcMain.handle('preview:create', (_e, html) => {
  const id = crypto.randomBytes(12).toString('hex');
  previewPages.set(id, String(html ?? ''));
  // Only a few previews can be open at once, so old ones can go.
  while (previewPages.size > 20) previewPages.delete(previewPages.keys().next().value);
  return `aio-preview://${id}/`;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131c1b',
    title: 'Sanctum',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Never slowed when hidden or minimized. The chat loop, the mirror and laptop tools all run in
      // this page, and a minimized window that crawled was a slowdown the owner noticed.
      backgroundThrottling: false,
      devTools: devToolsAllowed(app.isPackaged)
    }
  });
  mainWindow.setMenuBarVisibility(false);
  // Otherwise the hidden window would keep the app running with nothing to show for it.
  mainWindow.on('closed', closeRemoteTransport);
  wireHideToTray(mainWindow);

  // Web links open in the user's browser, never in a window of this app. The app
  // itself only ever shows its own page.
  const contents = mainWindow.webContents;
  const openOutside = (url) => {
    if (/^https?:\/\//i.test(url)) electronShell.openExternal(url).catch(() => {});
  };
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  // CSP has no rule against <meta http-equiv="refresh">, so this is what stops one, along with
  // anything else that tries to put another page in a window holding window.api.
  const appPage = path.join(__dirname, 'index.html');
  contents.on('will-navigate', (e, url) => {
    if (isAppPage(url, appPage)) return;
    e.preventDefault();
    openOutside(url);
  });
  // The only frames this page has are previews, on their own scheme.
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (/^aio-preview:/i.test(details.url) || details.url === 'about:blank' || details.url === 'about:srcdoc') return;
    details.preventDefault();
  });

  // A reload or a closed window takes the Stop button with it, so nothing could
  // end a generation that was left running.
  const abortStreams = () => {
    for (const [, entry] of activeChatStreams) { try { entry.controller.abort(); } catch {} }
  };
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      abortStreams();
      endRemoteRunsWithPage();
      pageStoppedSharing();
    }
  });
  contents.once('destroyed', () => {
    abortStreams();
    endRemoteRunsWithPage();
    pageStoppedSharing();
  });

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
  if (!ownsProfile) return;
  const menu = applicationMenuTemplate(app.isPackaged, process.platform);
  if (menu) Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  CACHE_DIR = path.join(app.getPath('userData'), 'media-cache');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // HTML previews of model-written code. Serving them from their own scheme gives
  // them their own script policy, because the app's policy blocks inline scripts.
  // The CSP sandbox gives them an opaque origin, so they can't reach window.api.
  protocol.handle('aio-preview', (request) => {
    const id = new URL(request.url).hostname;
    return new Response(previewPages.get(id) ?? 'Preview expired. Reload it from the chat.', {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups'
      }
    });
  });

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

  // Before the window, so the renderer's first call finds it. A problem here costs
  // Remote Control, not the app.
  try {
    startRemoteControl();
  } catch (e) {
    console.error('[remote] could not start:', e.message);
  }

  loadAvailability();
  createWindow();
  applyAvailability();

  mcpManager = new McpManager({
    configPath: path.join(app.getPath('userData'), 'mcp_config.json'),
    onUpdate: broadcastMcpUpdate
  });
  mcpManager.loadConfig();
  mcpManager.startAll().catch(e => console.error('[mcp] startAll:', e));
});

// Ask Ollama which models are resident, then evict every one of them.
// Ollama holds weights for keep_alive (5 min) after the last request, so
// closing Sanctum would otherwise leave tens of GB pinned in RAM/VRAM long
// after the app is gone. A local-first app shouldn't squat on your memory.
async function unloadAllOllamaModels() {
  let names = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return [];
    const j = await res.json();
    names = (j.models || []).map(m => m.name || m.model).filter(Boolean);
  } catch { return []; }             // Ollama not running — nothing to unload
  const done = [];
  await Promise.all(names.map(async (n) => { if (await unloadOllamaModel(n)) done.push(n); }));
  return done;
}

// Quit cleanup. The previous handler was `async` but never called
// preventDefault(), so Electron tore the process down without waiting for it
// — the await was effectively ignored. This does it properly: block the
// quit, run cleanup, then quit for real. Capped so a hung Ollama or MCP
// server can't strand the app in a permanently-unquittable state.
let quitCleanupRan = false;
let quitCleanupStarted = false;
app.on('before-quit', (e) => {
  // So closing the window can't hide it now, from the tray's Quit or anywhere else.
  appQuitting = true;
  if (quitCleanupRan) return;        // second pass: let the quit through
  e.preventDefault();
  // Quit asked for again, from the tray twice say, while the cleanup is under way. It quits when that's done.
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  applyAvailability();
  const debugLog = path.join(app.getPath('userData'), 'chat-debug.log');
  const dlog = (m) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

  const cleanup = (async () => {
    // Kill in-flight generations first so nothing reloads a model behind us.
    endRemoteRunsWithPage();
    remoteRefusals.flush();
    if (remoteManager) { try { remoteManager.shutdown(); } catch {} }
    for (const [, entry] of activeChatStreams) { try { entry.controller.abort(); } catch {} }
    for (const task of backgroundTasks.values()) { if (task.proc) killing(task.proc); }
    for (const entry of videoProcesses.values()) { entry.aborted = true; if (entry.proc) killing(entry.proc); }
    // A test's way to have a kill that never finishes.
    if (remoteTestFlags.has('hang-kill-at-quit')) killsUnderWay.add(new Promise(() => {}));
    // Side by side, so one that hangs can't cost the others their turn within the limit below.
    // Windows has to finish taskkill while this app is still here. Quit straight after starting it,
    // and the process goes on running.
    await Promise.all([
      Promise.all(killsUnderWay),
      unloadAllOllamaModels().then((unloaded) => {
        if (unloaded.length) dlog(`quit · unloaded ${unloaded.length} model(s): ${unloaded.join(', ')}`);
      }).catch(() => {}),
      mcpManager ? mcpManager.stopAll().catch(() => {}) : null
    ]);
  })();

  const timeout = new Promise(r => setTimeout(r, 6000));
  Promise.race([cleanup, timeout]).catch(() => {}).then(() => {
    quitCleanupRan = true;
    app.quit();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// The Dock icon brings back a window that was hidden to the tray, as well as making one after a close.
app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) showMainWindow(); });

ipcMain.handle('config:get', () => ({ ollamaUrl: OLLAMA_URL }));

// =================== REMOTE CONTROL ===================
// All of the logic is in lib/remote/. This is only the Electron wiring.
let remoteManager = null;
let remoteTransportWindow = null;
const REMOTE_TRANSPORT_PARTITION = 'remote-transport';
const REMOTE_TRANSPORT_URL = 'aio-transport://app/remote-transport.html';

// For the tests in e2e/ only, so never in a packaged app, and nothing a peer says reaches them.
//   log        the hidden window keeps a record of what it was handed
//   no-stun    no STUN server, so a test only touches this machine's own networking
//   block-ice  no candidates cross, so a data channel can never form
//   hang-kill-at-quit  a kill that never settles while quitting
const remoteTestFlags = new Set(app.isPackaged ? [] : String(process.env.SANCTUM_REMOTE_TEST || '').split(','));

// =================== KEEPING THIS PC AVAILABLE ===================
// A laptop can only reach shared chats while Sanctum is running here. So while a chat is shared,
// closing the window hides it to the tray, where it keeps working at full speed (it's never
// throttled, see createWindow), and two settings can keep this PC awake and start Sanctum at
// login. The page says whether a chat is
// shared, since chats live there. Page code could lie about that, and the most a lie does is keep
// a tray icon up or let this PC sleep.
//
// The settings live in a file here rather than in the page, so keep-awake applies from the start.
// Start-at-login is read back from the system each time, because that's what's in effect.
let availability = RemoteRules.cleanAvailability(null);
let availabilitySharing = false;
let appQuitting = false;
let keepAwakeBlocker = null;
let tray = null;
let trayComing = null;
let trayMenu = null;
let trayNoteDue = false;
let trayFailed = false;
const STILL_RUNNING_TITLE = 'Sanctum is still running';
const STILL_RUNNING_TEXT = 'A chat is shared, so Sanctum keeps running in the tray. Quit it from there.';
const START_AT_LOGIN_UNPACKAGED = 'Starting when you log in works in the installed app.';

// For the tests in e2e/ only. `peek` shows them what's going on here, and keeps the note off the
// desktop. `fake-login-item` puts a stand-in where the system's login items would be, because a
// test must never add a real one. A login item for a development run would start Electron as plain
// Node here, since ELECTRON_RUN_AS_NODE is set for the whole machine, so outside a test an
// unpackaged run doesn't offer the setting at all.
const notesShown = [];
const fakeLoginItem = { openAtLogin: false };
const loginItems = remoteTestFlags.has('fake-login-item')
  ? { works: true, read: () => fakeLoginItem.openAtLogin, write: (on) => { fakeLoginItem.openAtLogin = on; } }
  : { works: app.isPackaged, read: () => app.getLoginItemSettings().openAtLogin === true, write: (on) => app.setLoginItemSettings({ openAtLogin: on }) };
if (remoteTestFlags.has('peek')) {
  globalThis.__sanctumAvailability = {
    tray: () => tray !== null,
    keepAwake: () => keepAwakeBlocker,
    sharing: () => availabilitySharing,
    notes: () => notesShown.slice(),
    loginItem: () => fakeLoginItem.openAtLogin,
    // What a person can do with the icon, which a test can't reach on the real taskbar.
    clickTrayIcon: () => tray?.emit('click'),
    clickTrayMenu: (label) => trayMenu?.items.find((item) => item.label === label)?.click()
  };
}

function availabilityFile() {
  return path.join(app.getPath('userData'), 'availability.json');
}

function loadAvailability() {
  try {
    availability = RemoteRules.cleanAvailability(JSON.parse(fs.readFileSync(availabilityFile(), 'utf8')));
  } catch {
    availability = RemoteRules.cleanAvailability(null);
  }
}

function saveAvailability() {
  try {
    fs.writeFileSync(availabilityFile(), JSON.stringify(availability));
  } catch (e) {
    console.error('[availability] could not save:', e.message);
  }
}

function startAtLoginNow() {
  if (!loginItems.works) return false;
  try { return loginItems.read(); } catch { return false; }
}

function availabilitySettings() {
  return {
    keepAwake: availability.keepAwake,
    startAtLogin: startAtLoginNow(),
    startAtLoginWorks: loginItems.works,
    suggestionAnswered: availability.suggestionAnswered
  };
}

function windowHidden() {
  return !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible();
}

// Brings everything here into line with the settings and with whether a chat is shared. Safe to
// call as often as anything changes: it never starts a second blocker or a second icon.
function applyAvailability() {
  const awake = RemoteRules.keepAwakeWanted({ keepAwake: availability.keepAwake, sharing: availabilitySharing, quitting: appQuitting });
  if (awake && keepAwakeBlocker === null) {
    keepAwakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!awake && keepAwakeBlocker !== null) {
    powerSaveBlocker.stop(keepAwakeBlocker);
    keepAwakeBlocker = null;
  }
  if (trayWantedNow()) showTray();
  else dropTray();
}

function trayWantedNow() {
  return RemoteRules.trayWanted({ sharing: availabilitySharing, hidden: windowHidden(), quitting: appQuitting });
}

// Sanctum sets no icon of its own, so the tray shows whatever the system shows for the app.
// If the system won't give it one, there's nothing to bring a hidden window back, so closing quits as it
// would with nothing shared, and a window already hidden comes back.
function showTray() {
  if (tray || trayComing || trayFailed) return;
  trayComing = Promise.resolve()
    .then(() => app.getFileIcon(process.execPath, { size: 'small' }))
    .catch(() => nativeImage.createEmpty())
    .then((icon) => {
      trayComing = null;
      if (tray || !trayWantedNow()) return;
      // A test's way to have the system refuse the icon.
      if (remoteTestFlags.has('tray-fails')) throw new Error('a test asked for no tray icon');
      const made = new Tray(icon);
      made.setToolTip('Sanctum');
      trayMenu = Menu.buildFromTemplate([
        { label: 'Open Sanctum', click: showMainWindow },
        { label: 'Quit', click: () => app.quit() }
      ]);
      made.setContextMenu(trayMenu);
      made.on('click', showMainWindow);
      tray = made;
      if (trayNoteDue) noteStillRunning();
    })
    .catch((e) => {
      trayComing = null;
      trayFailed = true;
      trayMenu = null;
      console.error(`[tray] Couldn't show a tray icon, so closing the window quits Sanctum: ${e?.message || e}`);
      if (windowHidden()) showMainWindow();
    });
}

function dropTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
  trayMenu = null;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  applyAvailability();
}

// Once, the first time the window ever hides, so someone who meant to quit knows where it went.
function noteStillRunning() {
  if (availability.trayNoteShown === true) return;
  if (!tray) {
    trayNoteDue = true;
    return;
  }
  trayNoteDue = false;
  availability.trayNoteShown = true;
  saveAvailability();
  if (remoteTestFlags.has('peek')) {
    notesShown.push(STILL_RUNNING_TEXT);
  } else if (process.platform === 'win32') {
    tray.displayBalloon({ title: STILL_RUNNING_TITLE, content: STILL_RUNNING_TEXT });
  } else if (Notification.isSupported()) {
    new Notification({ title: STILL_RUNNING_TITLE, body: STILL_RUNNING_TEXT }).show();
  }
}

// Closing hides only while a chat is shared, and never while quitting. On a Mac that's the same,
// apart from the Dock: Sanctum stays in it, as Mac apps do, and clicking it brings the window back.
function wireHideToTray(win) {
  win.on('close', (e) => {
    if (trayFailed || !RemoteRules.closeHidesWindow({ sharing: availabilitySharing, quitting: appQuitting })) return;
    e.preventDefault();
    win.hide();
    applyAvailability();
    noteStillRunning();
  });
  win.on('show', applyAvailability);
  win.on('hide', applyAvailability);
  // Shown after hiding, or brought back from minimized. Nothing that went up meanwhile can have been read.
  win.on('show', () => sendToLocalUi('app:shown'));
  win.on('restore', () => sendToLocalUi('app:shown'));
  // Windows is shutting down or logging off, which a hidden window mustn't stand in the way of.
  win.on('session-end', () => { appQuitting = true; });
}

ipcMain.handle('app:setSharing', (_e, sharing) => {
  availabilitySharing = sharing === true;
  applyAvailability();
  return availabilitySharing;
});

// A page that's going can't say a chat is shared any more. The next one says so if it is.
function pageStoppedSharing() {
  if (!availabilitySharing) return;
  availabilitySharing = false;
  applyAvailability();
}

ipcMain.handle('app:setKeepAwake', (_e, on) => {
  availability.keepAwake = on === true;
  saveAvailability();
  applyAvailability();
  return { ok: true, settings: availabilitySettings() };
});

ipcMain.handle('app:setStartAtLogin', (_e, on) => {
  if (!loginItems.works) return { ok: false, error: START_AT_LOGIN_UNPACKAGED, settings: availabilitySettings() };
  try {
    loginItems.write(on === true);
  } catch {
    return { ok: false, error: "Couldn't change that. Try again.", settings: availabilitySettings() };
  }
  return { ok: true, settings: availabilitySettings() };
});

ipcMain.handle('app:getAvailabilitySettings', () => availabilitySettings());

// Answered once, either way, and never asked again.
ipcMain.handle('app:answerSuggestion', () => {
  availability.suggestionAnswered = true;
  saveAvailability();
  return availabilitySettings();
});

// A renderer that has loaded a file: page can read other file: URLs, which an exploit there
// could use on the main window's storage files whatever the CSP says. So this page comes from
// a scheme of its own, on its session alone, and it's the only thing that scheme serves. Going
// through fs is what reads it from the app's archive in a packaged build.
function serveRemoteTransportPage() {
  session.fromPartition(REMOTE_TRANSPORT_PARTITION).protocol.handle('aio-transport', async (request) => {
    const url = new URL(request.url);
    const wanted = new URL(REMOTE_TRANSPORT_URL);
    if (request.method !== 'GET' || url.host !== wanted.host || url.pathname !== wanted.pathname) {
      return new Response(null, { status: 404 });
    }
    const page = await fs.promises.readFile(path.join(__dirname, 'remote-transport.html'));
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
}

// Direct connections need WebRTC, which Electron only has in a renderer, so they live in this
// window. It's hidden and sandboxed, and only ever sees ciphertext. None if the main window is
// gone, as on a Mac after closing it, when the relay does the work until there's one again.
function openRemoteTransport({ onEvent, onGone }) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    title: 'Sanctum transport',
    webPreferences: {
      preload: path.join(__dirname, 'remote-transport-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: devToolsAllowed(app.isPackaged),
      // Its own session, in memory only, away from the main window's storage, which holds the
      // chats and API keys.
      partition: REMOTE_TRANSPORT_PARTITION
    }
  });
  remoteTransportWindow = win;
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.ipc.on('remote-transport:event', (e, event) => {
    if (e.senderFrame === contents.mainFrame) onEvent(event);
  });
  // Either way the window is no use now, and the next attempt opens another.
  contents.on('render-process-gone', () => win.destroy());
  contents.on('did-fail-load', (_e, _code, _text, _url, isMainFrame) => {
    if (isMainFrame) win.destroy();
  });
  win.once('closed', () => {
    if (remoteTransportWindow === win) remoteTransportWindow = null;
    onGone();
  });
  win.loadURL(remoteTestFlags.has('log') ? `${REMOTE_TRANSPORT_URL}?log=1` : REMOTE_TRANSPORT_URL).catch(() => {});
  return {
    send(command) {
      if (!win.isDestroyed()) contents.send('remote-transport:command', command);
    }
  };
}

function closeRemoteTransport() {
  if (remoteTransportWindow && !remoteTransportWindow.isDestroyed()) remoteTransportWindow.close();
}

// The address holds the relay's secret. It's only ever read from here and passed on, and
// never logged.
function remoteAddressStore(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).address ?? null;
      } catch {
        return null;
      }
    },
    save(address) {
      if (address === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, JSON.stringify({ address }), { mode: 0o600 });
    }
  };
}

// Flushed before the keystore comes to depend on it, since the identity can't be opened
// without this file if a home PC loses power right after.
function remoteAutoUnlockFile(file) {
  return {
    read() {
      try {
        return retryTransient(() => fs.readFileSync(file));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    write(bytes) {
      const fd = fs.openSync(file, 'w', 0o600);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    remove() {
      retryTransient(() => fs.rmSync(file, { force: true }));
    }
  };
}

function startRemoteControl() {
  serveRemoteTransportPage();
  const userData = app.getPath('userData');
  // Both callers hand over text as bytes, and safeStorage takes a string.
  const protect = (bytes) => safeStorage.encryptString(Buffer.from(bytes).toString('utf8'));
  const unprotect = (bytes) => Buffer.from(safeStorage.decryptString(Buffer.from(bytes)), 'utf8');
  const keystore = createKeystore({
    file: path.join(userData, 'remote-keys.json'),
    protect,
    unprotect,
    isProtectionAvailable: () => safeStorage.isEncryptionAvailable()
  });
  // So a test can reach a paired laptop owing a PIN, which otherwise takes a failing disk.
  if (remoteTestFlags.has('fail-user-pin')) {
    const setPin = keystore.setPin;
    keystore.setPin = (pin, options) => (options?.kind === 'user' ? Promise.resolve({ ok: false, error: 'Could not save the PIN.' }) : setPin(pin, options));
  }
  remoteManager = createRemoteManager({
    keystore,
    relay: remoteRelayClient,
    addressStore: remoteAddressStore(path.join(userData, 'remote-service.json')),
    autoUnlock: { ...remoteAutoUnlockFile(path.join(userData, 'remote-autounlock.bin')), protect, unprotect },
    deviceName: os.hostname(),
    onToolRefused: noteToolRefused,
    createDirect: (callbacks) => createDirectPath({
      ...callbacks,
      openTransport: openRemoteTransport,
      iceServers: remoteTestFlags.has('no-stun') ? [] : undefined,
      blockCandidates: remoteTestFlags.has('block-ice')
    })
  });
  remoteManager.onFrame((deviceId, frame) => {
    if (frame?.type === 'tool-call' && !admitToolCall(deviceId, frame)) return;
    sendToLocalUi('remote:frame', { deviceId, frame });
  });
  // The work ends first, so a switch turned off has taken effect by the time anything says so.
  remoteManager.onStatus((status) => {
    lastRemoteStatus = status;
    reconcileRemoteWork(status);
    sendToLocalUi('remote:status', withHomeTasks(status));
  });
}

function sendToLocalUi(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

// Only this app's own page in its main window, so never a preview, and never another
// window such as the hidden one that carries direct connections.
function isLocalUi(e) {
  return Boolean(mainWindow) && !mainWindow.isDestroyed()
    && e.sender === mainWindow.webContents
    && e.senderFrame === e.sender.mainFrame
    && e.senderFrame.url.startsWith('file:');
}

function handleRemote(channel, handler) {
  ipcMain.handle(channel, (e, args) => {
    if (!isLocalUi(e)) throw new Error("Remote Control can only be used from this app's own window.");
    if (!remoteManager) throw new Error("Remote Control didn't start.");
    return handler(args ?? {});
  });
}

handleRemote('remote:status', () => withHomeTasks(remoteManager.status()));
handleRemote('remote:setAddress', ({ url }) => remoteManager.setAddress(url));
handleRemote('remote:setPin', ({ pin }) => remoteManager.setPin(pin));
handleRemote('remote:unlock', ({ pin }) => remoteManager.unlock(pin));
handleRemote('remote:lock', () => remoteManager.lock());
handleRemote('remote:createCode', () => remoteManager.createCode());
handleRemote('remote:cancelCode', () => remoteManager.cancelCode());
handleRemote('remote:pair', ({ code, name, pin }) => remoteManager.pair(code, name, pin));
handleRemote('remote:removeDevice', ({ id }) => remoteManager.removeDevice(id));
// handleRemote has checked the sender by now, which is what makes this claim true.
handleRemote('remote:setControlAllowed', ({ allowed }) => remoteManager.setControlAllowed(allowed, { fromLocalUi: true }));
handleRemote('remote:send', ({ deviceId, frame }) => remoteManager.send(deviceId, frame));
handleRemote('remote:audit', (entry) => {
  if (entry?.event === 'refused') remoteRefusals.note(entry);
  else writeLog(REMOTE_AUDIT_FILE, entry);
  return { ok: true };
});
handleRemote('remote:endRun', ({ deviceId, id, reason }) => endRemoteRun(remoteRunKey({ deviceId, id }), reason === 'too long' ? reason : 'stopped'));

// =================== WHAT A HOME PC RUNS HERE ===================
// The switch going off, the link dropping, and Stop all have to reach a process, so what a home PC
// started is kept here, where they are, rather than in a page that may be gone. What ends what is
// decided by RemoteRules.remoteWorkToEnd.
const REMOTE_LOG_MAX_BYTES = 16 * 1024 * 1024;
const REMOTE_AUDIT_FILE = 'remote-audit.log';
const REMOTE_REFUSALS_FILE = 'remote-refusals.log';
const remoteRuns = new Map(); // `${deviceId}:${id}` -> { child, deviceId, id, command, ended }
const killsUnderWay = new Set();
let lastRemoteStatus = null;

// One JSON object per line, in this device's own profile, each log rotating by itself.
//
// remote-audit.log holds only what ran: a `started` line, written here before anything runs, so a
// crash leaves a record of what it interrupted, and an `ended` line. Refusals have their own file,
// so a device with the switch off can't rotate this one away by asking for what it can't have. A
// home with the switch on can still rotate it by running things, and can delete it with a command.
// That's accepted, since a device that can run commands here can already do either.
function writeLog(file, entry) {
  try {
    const full = path.join(app.getPath('userData'), file);
    try {
      if (fs.statSync(full).size > REMOTE_LOG_MAX_BYTES) fs.renameSync(full, `${full}.old`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.appendFileSync(full, RemoteRules.auditLine({ ...entry, ts: new Date().toISOString() }) + '\n');
  } catch { /* what can't be written can't stop what it records */ }
}

const remoteRefusals = RemoteRules.createRefusalLog({
  write: (entry) => writeLog(REMOTE_REFUSALS_FILE, entry),
  clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer) }
});

function noteToolRefused({ deviceId, deviceName, reason, frame }) {
  const tool = typeof frame?.name === 'string' ? frame.name : '';
  remoteRefusals.note({
    event: 'refused', device: deviceId, deviceName, chatTitle: frame?.chatTitle, tool, args: RemoteRules.auditArgs(tool, frame?.args), reason, ok: false
  });
}

function remoteDeviceName(deviceId) {
  return lastRemoteStatus?.devices?.find((d) => d.id === deviceId)?.name;
}

// The manager has settled that this device may ask. This settles what it's asking for, by the rules
// the page also uses, and records it before anything can happen. False if it stops here.
function admitToolCall(deviceId, frame) {
  const mcpNames = new Set(mcpManager ? mcpManager.getOllamaTools().map((tool) => tool.function.name) : []);
  const check = RemoteRules.checkToolCall(frame, mcpNames);
  const noWindow = !mainWindow || mainWindow.isDestroyed();
  const reason = check.error || (noWindow ? "Sanctum's window is closed on this device, so nothing ran." : null);
  if (reason) {
    noteToolRefused({ deviceId, deviceName: remoteDeviceName(deviceId), reason, frame });
    if (check.id) remoteManager.send(deviceId, { type: 'tool-result', id: check.id, result: { error: reason }, summary: 'refused', ok: false });
    return false;
  }
  writeLog(REMOTE_AUDIT_FILE, {
    event: 'started', call: check.id, device: deviceId, deviceName: remoteDeviceName(deviceId), chatTitle: check.chatTitle, tool: check.name, args: RemoteRules.auditArgs(check.name, check.args)
  });
  return true;
}

function remoteRunKey(remoteCall) {
  return `${remoteCall?.deviceId}:${remoteCall?.id}`;
}

// The switch can have gone off between a frame reaching the page and the page getting here.
function remoteCallRefused(remoteCall) {
  if (!remoteCall) return null;
  if (!remoteManager) return "Remote Control didn't start.";
  return remoteManager.toolCallRefusal(remoteCall.deviceId);
}

// A kill that quitting has to wait for.
function killing(proc) {
  const kill = killTree(proc).finally(() => killsUnderWay.delete(kill));
  killsUnderWay.add(kill);
  return kill;
}

function endRemoteRun(key, reason) {
  const run = remoteRuns.get(key);
  if (!run || run.ended) return { ok: true };
  run.ended = true;
  killing(run.child);
  writeLog(REMOTE_AUDIT_FILE, { event: 'ended', call: run.id, device: run.deviceId, tool: 'run_command', args: { command: run.command }, reason, ok: false });
  return { ok: true };
}

function endRemoteTask(task, reason) {
  task.status = 'killed';
  killing(task.proc);
  writeLog(REMOTE_AUDIT_FILE, { event: 'ended', device: task.remoteDevice, tool: 'run_command_async', args: { command: task.command }, reason, ok: false });
}

function reconcileRemoteWork(status) {
  const tasks = [...backgroundTasks.values()].filter((task) => task.remoteDevice && task.status === 'running');
  const ending = RemoteRules.remoteWorkToEnd({
    status,
    runs: [...remoteRuns].filter(([, run]) => !run.ended).map(([key, run]) => ({ key, deviceId: run.deviceId })),
    tasks: tasks.map((task) => ({ id: task.id, deviceId: task.remoteDevice }))
  });
  for (const end of ending) {
    if (end.kind === 'run') endRemoteRun(end.key, end.reason);
    else endRemoteTask(backgroundTasks.get(end.id), end.reason);
  }
}

// Which home PCs have something running here that outlasts its call. The page shows the running
// indicator for these too, because that's the one way to turn them off without the PIN.
function withHomeTasks(status) {
  const running = [...backgroundTasks.values()].filter((task) => task.remoteDevice && task.status === 'running');
  return { ...status, homeTasks: [...new Set(running.map((task) => task.remoteDevice))] };
}

// The page that would have answered is going away, so nothing else will tell the home PC.
function endRemoteRunsWithPage() {
  for (const [key, run] of remoteRuns) {
    if (run.ended) continue;
    endRemoteRun(key, 'page closed');
    remoteManager?.send(run.deviceId, { type: 'tool-result', id: run.id, result: { error: 'Sanctum was reloaded or closed on this device, so that stopped.' }, summary: 'stopped', ok: false });
  }
}

// =================== MCP SERVERS ===================
ipcMain.handle('mcp:list', () => mcpManager ? mcpManager.listServers() : []);
ipcMain.handle('mcp:add', async (_e, { name, config }) => {
  if (!mcpManager) throw new Error('mcp not ready');
  await mcpManager.addServer(name, config);
  return mcpManager.listServers();
});
ipcMain.handle('mcp:remove', async (_e, { name }) => {
  if (!mcpManager) throw new Error('mcp not ready');
  await mcpManager.removeServer(name);
  return mcpManager.listServers();
});
ipcMain.handle('mcp:restart', async (_e, { name }) => {
  if (!mcpManager) throw new Error('mcp not ready');
  await mcpManager.restartServer(name);
  return mcpManager.listServers();
});
ipcMain.handle('mcp:get_tools', () => mcpManager ? mcpManager.getOllamaTools() : []);
ipcMain.handle('mcp:call_tool', async (_e, { name, args }) => {
  if (!mcpManager) throw new Error('mcp not ready');
  try {
    const result = await mcpManager.callTool(name, args);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('models:catalog', () => {
  const catalogPath = path.join(__dirname, 'models.json');
  return JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
});

// The full browsable library for the Download tab. Separate from models.json
// (the curated per-category picks) — this one is everything pullable.
ipcMain.handle('models:download_catalog', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'download-catalog.json'), 'utf-8'));
  } catch (e) {
    return { models: [], error: e.message };
  }
});

// Candidate locations where the official Windows installer drops ollama.exe.
function ollamaInstallCandidates() {
  if (process.platform === 'darwin') {
    return ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama'];
  }
  if (process.platform !== 'win32') {
    return ['/usr/local/bin/ollama', '/usr/bin/ollama', path.join(os.homedir(), '.local', 'bin', 'ollama')];
  }
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
  const isWin = process.platform === 'win32';
  const tray = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama app.exe');
  const macApp = '/Applications/Ollama.app';
  let toLaunch = null;
  let args = [];
  if (isWin && fs.existsSync(tray)) { toLaunch = tray; }
  else if (process.platform === 'darwin' && fs.existsSync(macApp)) { toLaunch = 'open'; args = ['-a', 'Ollama']; }
  else {
    const cli = findOllamaExe();
    if (!cli) return { error: 'ollama not found in default install locations' };
    toLaunch = cli;
    args = ['serve'];
  }
  try {
    // q8_0 KV cache roughly halves context memory, letting big contexts fit —
    // but Ollama silently ignores OLLAMA_KV_CACHE_TYPE unless flash attention is
    // on. This only takes effect when Sanctum is the one starting Ollama; an
    // already-running service keeps its own env, which is why the fit engine
    // keeps 30% headroom rather than trusting the q8 assumption.
    const child = spawn(toLaunch, args, {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0' }
    });
    // Without a listener, a failed launch would be an uncaught exception here.
    child.on('error', () => {});
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
  const send = deferredSender(evt.sender, channelId);

  (async () => {
    try {
      if (process.platform !== 'win32') {
        const where = process.platform === 'darwin' ? 'Download it from ollama.com/download' : 'Install it from ollama.com/download';
        send({ error: `Sanctum can only install Ollama automatically on Windows. ${where}, then reopen Sanctum.`, done: true });
        return;
      }
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
        child.on('error', (e) => send({ error: `Failed to launch installer: ${e.message}`, done: true }));
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

// Force-unload on demand. Reuses the same eviction path the freeze watchdog
// and quit cleanup use: ask Ollama what's resident (/api/ps), then keep_alive:0
// each one so the weights leave memory NOW instead of squatting for the 5-min
// keep_alive window. Wired to the Settings button + rebindable shortcut so the
// user can reclaim VRAM/RAM whenever they want (e.g. before launching a game or
// another GPU job). Returns the models that were resident and their reported
// size, so the renderer can say exactly what it freed.
ipcMain.handle('ollama:unload-all', async () => {
  let resident = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { unloaded: [], freedBytes: 0, error: `Ollama returned ${res.status}` };
    const j = await res.json();
    resident = (j.models || []).map(m => ({
      name: m.name || m.model,
      sizeBytes: m.size_vram || m.size || 0
    })).filter(m => m.name);
  } catch {
    // A busy Ollama can time out here while still holding memory, so this can't
    // be reported as "nothing was loaded".
    return { unloaded: [], freedBytes: 0, error: "Couldn't reach Ollama" };
  }

  const names = resident.map(m => m.name);
  const done = [];
  await Promise.all(names.map(async (n) => { if (await unloadOllamaModel(n)) done.push(n); }));
  const freedBytes = resident
    .filter(m => done.includes(m.name))
    .reduce((sum, m) => sum + (m.sizeBytes || 0), 0);
  const failed = names.filter(n => !done.includes(n));
  return { unloaded: done, failed, freedBytes };
});

// Names of the models fully loaded right now. A model that is still loading
// isn't listed yet, which is how the chat tells "loading" from "reading".
// Returns null when Ollama can't be asked, so callers don't mistake that for
// "nothing is loaded".
ipcMain.handle('ollama:ps', async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.models || []).map(m => m.name || m.model).filter(Boolean);
  } catch { return null; }
});

// Live GGUF metadata for a model (expert counts, KV geometry, context length).
// The fit engine uses this to size MoE models by their ACTIVE params rather than
// total weights, and to compute a real context suggestion instead of guessing.
// Cached per tag — a model's metadata never changes for a given pull; errors are
// not cached so a transient failure can retry.
const modelInfoCache = new Map();
ipcMain.handle('ollama:show', async (_e, tag) => {
  if (!tag) return { error: 'no tag' };
  if (modelInfoCache.has(tag)) return modelInfoCache.get(tag);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag }),
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return { error: `Ollama /api/show ${res.status}` };
    const j = await res.json();
    const out = { model_info: j.model_info || null, details: j.details || null, capabilities: j.capabilities || null };
    modelInfoCache.set(tag, out);
    return out;
  } catch (e) {
    return { error: e.message };
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
// Uninstall a model. Frees its disk blobs via Ollama's /api/delete.
ipcMain.handle('ollama:delete', async (_e, tag) => {
  if (!tag) return { error: 'no tag specified' };
  modelInfoCache.delete(tag);   // metadata cache is stale once the model is gone
  try {
    const res = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag, name: tag })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `Ollama delete ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message || String(e) };
  }
});

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
// channelId -> { controller, model, local }. The model is tracked so the
// freeze watchdog knows which model to unload from Ollama when it trips —
// aborting the HTTP stream alone stops generation but leaves the weights
// resident (Ollama holds them for keep_alive, 5 min by default), which is
// exactly the memory that froze the machine.
const activeChatStreams = new Map();

// Detect a degenerate repetition loop at the tail of the streamed text — the
// model emitting the same short fragment over and over ("AndBoxMeshMaterial"
// ×700), which is how a local model can burn 12K+ tokens and poison a chat.
// Returns the offending unit if the tail ends in a cycle unmistakably long
// enough to be degenerate, else null. Cheap: scans only a bounded tail, and the
// caller only runs it every ~200 chars. Thresholds are deliberately high so
// real content (a repeated code line, a divider) never trips it — 1.2K straight
// chars of one exact repeating unit does not occur in legitimate output.
ipcMain.handle('ollama:chat', async (evt, { model, messages, images, tools, options }) => {
  const channelId = `ollama:chat:stream:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  activeChatStreams.set(channelId, { controller, model, local: true });

  const debugLog = path.join(app.getPath('userData'), 'chat-debug.log');
  const dlog = (msg) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

  const body = { model, messages, stream: true };
  if (tools) body.tools = tools;
  // Ollama's native thinking switch (0.9+). Returns reasoning in a separate
  // `message.thinking` field instead of inline <think> tags, which keeps it
  // out of the visible answer and gives us clean start/stop timing.
  if (options && options.think !== undefined) body.think = !!options.think;
  if (options && typeof options === 'object') {
    const { think, ...rest } = options;   // `think` is top-level, not an option
    if (Object.keys(rest).length) body.options = rest;
  }

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
      let totalThinking = '';
      let lastLoopCheckLen = 0;   // only re-scan for a loop every ~200 new chars
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
            if (typeof obj.message?.thinking === 'string') totalThinking += obj.message.thinking;
            if (obj.message?.tool_calls) toolCallCount += obj.message.tool_calls.length;
            if (chunkCount <= 2 || obj.done || obj.error) {
              dlog(`#${chunkCount} ${JSON.stringify(obj).slice(0, 300)}`);
            }
            evt.sender.send(channelId, obj);

            // Repetition-loop guard. If the model has spiralled into repeating
            // one fragment, stop it now — before it burns the whole budget and
            // poisons the chat history — rather than streaming thousands more
            // copies. We abort Ollama, drop a short visible note through the
            // normal content path (so no renderer change is needed), and end.
            const generatedLen = totalContent.length + totalThinking.length;
            if (generatedLen - lastLoopCheckLen >= 200) {
              lastLoopCheckLen = generatedLen;
              // Reasoning can spiral too, and there it would run to the token cap unseen.
              const unit = detectRepetitionLoop(totalContent) || detectRepetitionLoop(totalThinking);
              if (unit) {
                dlog(`LOOP GUARD · stopped · unit=${JSON.stringify(unit.slice(0, 40))} contentLen=${totalContent.length} eval≈${chunkCount}`);
                try { controller.abort(); } catch {}
                evt.sender.send(channelId, {
                  message: { content: '\n\n_[Stopped automatically — the model started repeating itself. Try again, lower the context, or switch to a stronger model for this edit.]_' }
                });
                evt.sender.send(channelId, { done: true, loopStopped: true, eval_count: chunkCount });
                return;
              }
            }
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
  const entry = activeChatStreams.get(channelId);
  if (!entry) return { ok: false, note: 'no active stream' };
  try { entry.controller.abort(); } catch {}
  return { ok: true };
});

// =============== CLOUD CHAT (Anthropic) ===============
// Routes provider=anthropic picks to the Claude Messages API. Emits the SAME
// chunk shape as ollama:chat so the renderer's existing tool loop, token
// counter, and stop-button wiring all work unchanged:
//   { message: { content?, tool_calls? }, done, prompt_eval_count, eval_count }
//   { error, done }
//   { aborted, done }
const ANTHROPIC_VERSION = '2023-06-01';
const {
  anthropicThinkingParams,
  anthropicUsesFallbacks,
  ANTHROPIC_FALLBACK_BETA,
  geminiThinkingConfig,
  addImagesToAnthropic,
  addImagesToGemini,
  toAnthropicTools,
  toGeminiTools
} = require(path.join(__dirname, 'lib', 'cloud-params.js'));

// Convert Ollama-style messages (system / user / assistant / tool) into the
// Anthropic format: separate `system` string + `messages` array of user/assistant.
// Tool roles become user messages with tool_result content blocks.
function toAnthropicMessages(messages) {
  const sys = [];
  const out = [];
  let pendingToolResults = []; // batch consecutive tool roles into one user msg

  const flushToolResults = () => {
    if (!pendingToolResults.length) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of messages) {
    if (m.role === 'system') {
      sys.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m._anthropicId || `t_${pendingToolResults.length}`,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      });
      continue;
    }
    flushToolResults();
    if (m.role === 'assistant') {
      // A turn from the tool loop carries the exact blocks the API sent,
      // including signed thinking. They have to go back unchanged and in order.
      const original = Array.isArray(m.tool_calls)
        ? m.tool_calls.find(tc => Array.isArray(tc._anthropic_content))?._anthropic_content
        : null;
      if (original?.length) {
        out.push({ role: 'assistant', content: original });
        continue;
      }
      const blocks = [];
      // Anthropic rejects empty text content blocks — only push the text
      // block if it has actual content. Tool calls still get their own
      // tool_use blocks. If both are missing the message is meaningless,
      // skip it entirely rather than send an empty assistant turn (which
      // would also return a 400 from the API).
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name;
          let input = tc.function?.arguments || tc.arguments || {};
          if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
          blocks.push({ type: 'tool_use', id: tc.id || `t_${name}_${blocks.length}`, name, input });
        }
      }
      if (!blocks.length) continue;
      out.push({ role: 'assistant', content: blocks });
    } else {
      // user
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  flushToolResults();
  return { system: sys.join('\n\n').trim() || undefined, messages: out };
}

async function streamAnthropic({ apiKey, model, messages, tools, options, images, controller, evt, channelId, dlog }) {
  const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
  addImagesToAnthropic(anthropicMsgs, images);
  const body = {
    model,
    messages: anthropicMsgs,
    // 64K is the streaming default recommended by the Claude API skill —
    // Opus/Sonnet/Haiku 4.x all support this, and hitting the cap truncates
    // mid-thought which forces an awkward retry. Caller can override.
    max_tokens: options?.max_tokens || 64000,
    stream: true
  };
  if (system) body.system = system;
  const tdef = toAnthropicTools(tools);
  if (tdef) body.tools = tdef;
  Object.assign(body, anthropicThinkingParams(model, !!options?.thinking_enabled));
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION
  };
  // Lets the API retry a safety decline on another model instead of ending the
  // reply. The model that answers can differ from the one that was picked.
  if (anthropicUsesFallbacks(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  });
  if (!res.ok || !res.body) {
    const errText = res.body ? await res.text() : '(no body)';
    dlog(`anthropic bad response ${res.status}: ${errText.slice(0, 500)}`);
    let userMsg = `Anthropic API ${res.status}`;
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) userMsg = j.error.message;
    } catch {}
    evt.sender.send(channelId, { error: userMsg, done: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolUses = new Map(); // index → { id, name, jsonAcc, block }
  const thinkingBlocks = new Set(); // content-block indices that are thinking
  // Every block in the order received, so a tool turn can be replayed unchanged.
  let assembled = [];
  const openBlocks = new Map(); // index → entry in assembled
  let refusal = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let frameCount = 0;
  let firstTextSent = false;

  while (true) {
    let value, done;
    try { ({ value, done } = await reader.read()); }
    catch (e) {
      if (controller.signal.aborted) { evt.sender.send(channelId, { aborted: true, done: true }); return; }
      throw e;
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE allows both LF and CRLF line endings. Normalize so the frame
    // splitter below works regardless of what Anthropic's proxy sends.
    buf = buf.replace(/\r\n/g, '\n');

    // SSE frames are separated by blank lines. Each frame has `event: <name>` and
    // `data: <json>` lines. We only care about the data payload.
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      let obj;
      try { obj = JSON.parse(json); } catch { continue; }
      frameCount++;

      // Overloads and other failures can arrive mid-stream with HTTP 200 already
      // sent. Ignoring them made a failure look like a short, normal reply.
      if (obj.type === 'error') {
        dlog(`anthropic stream error: ${JSON.stringify(obj.error).slice(0, 300)}`);
        evt.sender.send(channelId, { error: obj.error?.message || 'Anthropic reported a streaming error.', done: true });
        return;
      }

      if (obj.type === 'message_start') {
        inputTokens = obj.message?.usage?.input_tokens || 0;
        outputTokens = obj.message?.usage?.output_tokens || 0;
      } else if (obj.type === 'content_block_start') {
        const startType = obj.content_block?.type;
        if (startType === 'fallback') {
          // Another model took over on this same stream. Thinking and tool
          // calls from before this point can't be sent back or acted on; text
          // already shown stays. The marker itself isn't part of the replay.
          dlog(`anthropic fallback ${obj.content_block.from?.model} -> ${obj.content_block.to?.model}`);
          assembled = assembled.filter(b => b.type === 'text');
          openBlocks.clear();
          toolUses.clear();
          if (thinkingBlocks.size) {
            thinkingBlocks.clear();
            evt.sender.send(channelId, { thinking: { phase: 'end' } });
          }
        } else if (startType === 'tool_use') {
          const block = { type: 'tool_use', id: obj.content_block.id, name: obj.content_block.name, input: {} };
          assembled.push(block);
          toolUses.set(obj.index, { id: block.id, name: block.name, jsonAcc: '', block });
        } else if (startType === 'text') {
          const block = { type: 'text', text: obj.content_block.text || '' };
          assembled.push(block);
          openBlocks.set(obj.index, block);
        } else if (startType === 'thinking') {
          const block = { type: 'thinking', thinking: obj.content_block.thinking || '', signature: obj.content_block.signature || '' };
          assembled.push(block);
          openBlocks.set(obj.index, block);
          // Start and stop stay accurate even when the text streams empty.
          thinkingBlocks.add(obj.index);
          evt.sender.send(channelId, { thinking: { phase: 'start' } });
        } else if (startType === 'redacted_thinking') {
          assembled.push({ ...obj.content_block });
        }
      } else if (obj.type === 'content_block_delta') {
        const open = openBlocks.get(obj.index);
        if (open && obj.delta?.type === 'text_delta') open.text += obj.delta.text || '';
        if (open && obj.delta?.type === 'signature_delta') open.signature = obj.delta.signature || '';
        if (open && obj.delta?.type === 'thinking_delta' && obj.delta.thinking) {
          open.thinking += obj.delta.thinking;
          evt.sender.send(channelId, { thinking: { text: obj.delta.thinking } });
        }
        if (obj.delta?.type === 'text_delta' && obj.delta.text) {
          if (!firstTextSent) { firstTextSent = true; dlog(`anthropic first text delta after ${frameCount} frames`); }
          evt.sender.send(channelId, { message: { content: obj.delta.text } });
        } else if (obj.delta?.type === 'input_json_delta') {
          const tu = toolUses.get(obj.index);
          if (tu) tu.jsonAcc += obj.delta.partial_json || '';
        }
      } else if (obj.type === 'content_block_stop') {
        if (thinkingBlocks.has(obj.index)) {
          thinkingBlocks.delete(obj.index);
          evt.sender.send(channelId, { thinking: { phase: 'end' } });
        }
        const tu = toolUses.get(obj.index);
        if (tu) {
          try { tu.block.input = tu.jsonAcc ? JSON.parse(tu.jsonAcc) : {}; } catch { tu.block.input = {}; }
        }
      } else if (obj.type === 'message_delta') {
        if (obj.usage?.output_tokens) outputTokens = obj.usage.output_tokens;
        if (obj.delta?.stop_reason === 'refusal') {
          refusal = obj.delta.stop_details || {};
          dlog(`anthropic refusal category=${refusal.category || 'none'}`);
        }
      } else if (obj.type === 'message_stop') {
        // emitted below via the final done chunk
      }
    }
  }
  if (refusal) {
    // A decline is a successful response with nothing useful in it, so without
    // this the reply would just stop with no explanation.
    const wrote = assembled.some(b => b.type === 'text' && b.text);
    evt.sender.send(channelId, {
      message: {
        content: `${wrote ? '\n\n' : ''}**Claude declined this request.**${wrote ? ' The text above may be incomplete.' : ''} Try rewording it, or switch to another model.`
      }
    });
  } else {
    // Sent together at the end, once every block is complete, so the replay
    // copy on the first call is whole. A tool can't start before this anyway.
    const calls = assembled.filter(b => b.type === 'tool_use').map((b, i) => ({
      id: b.id,
      function: { name: b.name, arguments: b.input },
      ...(i === 0 ? { _anthropic_content: assembled.filter(x => x.type !== 'text' || x.text) } : {})
    }));
    if (calls.length) evt.sender.send(channelId, { message: { tool_calls: calls } });
  }
  evt.sender.send(channelId, {
    done: true,
    prompt_eval_count: inputTokens,
    eval_count: outputTokens
  });
}

// =============== CLOUD CHAT (Google Gemini) ===============
// Uses the Generative Language API (Google AI Studio keys) via
// :streamGenerateContent with alt=sse. Same chunk shape as Anthropic /
// Ollama so the renderer doesn't need to know which provider this is.
function toGeminiContents(messages) {
  const sysParts = [];
  const out = [];
  let pendingFnResults = [];

  const flushFnResults = () => {
    if (!pendingFnResults.length) return;
    out.push({ role: 'user', parts: pendingFnResults });
    pendingFnResults = [];
  };

  for (const m of messages) {
    if (m.role === 'system') {
      sysParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'tool') {
      let payload;
      try { payload = typeof m.content === 'string' ? JSON.parse(m.content) : m.content; }
      catch { payload = { result: m.content }; }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        // already an object — pass through
      } else {
        payload = { result: payload };
      }
      pendingFnResults.push({
        functionResponse: { name: m.tool_name || m._toolName || 'tool', response: payload }
      });
      continue;
    }
    flushFnResults();
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name;
          let args = tc.function?.arguments || tc.arguments || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          // Gemini 3+ signs its function calls. The signature has to come back
          // on the same part or the next tool round can be rejected.
          parts.push({
            functionCall: { name, args },
            ...(tc.thought_signature ? { thoughtSignature: tc.thought_signature } : {})
          });
        }
      }
      if (!parts.length) continue;
      out.push({ role: 'model', parts });
    } else {
      out.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] });
    }
  }
  flushFnResults();
  return { systemInstruction: sysParts.length ? { parts: [{ text: sysParts.join('\n\n') }] } : undefined, contents: out };
}

const GEMINI_EARLY_STOPS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'MAX_TOKENS', 'MISSING_THOUGHT_SIGNATURE', 'OTHER']);

async function streamGoogle({ apiKey, model, messages, tools, options, images, controller, evt, channelId, dlog }) {
  const { systemInstruction, contents } = toGeminiContents(messages);
  addImagesToGemini(contents, images);
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const gtools = toGeminiTools(tools);
  if (gtools) body.tools = gtools;
  const generationConfig = {};
  if (options?.max_tokens) generationConfig.maxOutputTokens = options.max_tokens;
  // Always include the thinking config so the user's toggle reaches the API;
  // 'thinking_enabled' is boolean from the renderer and undefined for callers
  // that don't care. Skip the param when undefined (non-thinking-capable
  // models would 400 on an unknown field on older Flash builds).
  if (options?.thinking_enabled !== undefined) {
    const thinkingConfig = geminiThinkingConfig(model, !!options.thinking_enabled);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  if (!res.ok || !res.body) {
    const errText = res.body ? await res.text() : '(no body)';
    dlog(`google bad response ${res.status}: ${errText.slice(0, 500)}`);
    let userMsg = `Google API ${res.status}`;
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) userMsg = j.error.message;
    } catch {}
    evt.sender.send(channelId, { error: userMsg, done: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let frameCount = 0;
  let inThought = false;
  let earlyStop = null;

  while (true) {
    let value, done;
    try { ({ value, done } = await reader.read()); }
    catch (e) {
      if (controller.signal.aborted) { evt.sender.send(channelId, { aborted: true, done: true }); return; }
      throw e;
    }
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');

    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      let obj;
      try { obj = JSON.parse(json); } catch { continue; }
      frameCount++;

      if (obj.error) {
        dlog(`google stream error: ${JSON.stringify(obj.error).slice(0, 300)}`);
        evt.sender.send(channelId, { error: obj.error.message || 'Google reported a streaming error.', done: true });
        return;
      }
      if (obj.promptFeedback?.blockReason) {
        evt.sender.send(channelId, { error: `Gemini blocked this request (${obj.promptFeedback.blockReason}). Try rewording it, or switch to another model.`, done: true });
        return;
      }
      if (GEMINI_EARLY_STOPS.has(obj.candidates?.[0]?.finishReason)) earlyStop = obj.candidates[0].finishReason;

      if (obj.usageMetadata) {
        if (obj.usageMetadata.promptTokenCount) inputTokens = obj.usageMetadata.promptTokenCount;
        if (obj.usageMetadata.candidatesTokenCount) outputTokens = obj.usageMetadata.candidatesTokenCount;
      }
      const cand = obj.candidates?.[0];
      const parts = cand?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        // Gemini marks reasoning parts with thought:true. Emit start/end as
        // the flag flips so the renderer can time it like any other provider.
        const isThought = part.thought === true;
        if (isThought !== inThought) {
          inThought = isThought;
          evt.sender.send(channelId, { thinking: { phase: isThought ? 'start' : 'end' } });
        }
        if (isThought) {
          // Never shown as part of the answer; only feeds the live token count.
          if (typeof part.text === 'string' && part.text) {
            evt.sender.send(channelId, { thinking: { text: part.text } });
          }
          continue;
        }
        if (typeof part.text === 'string' && part.text.length) {
          evt.sender.send(channelId, { message: { content: part.text } });
        }
        if (part.functionCall) {
          evt.sender.send(channelId, {
            message: {
              tool_calls: [{
                id: `gem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                function: { name: part.functionCall.name, arguments: part.functionCall.args || {} },
                ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {})
              }]
            }
          });
        }
      }
    }
  }
  if (inThought) evt.sender.send(channelId, { thinking: { phase: 'end' } });
  if (earlyStop) {
    evt.sender.send(channelId, { message: { content: `\n\n**Gemini stopped early (${earlyStop}).** This reply may be incomplete.` } });
  }
  dlog(`google stream end · frames=${frameCount} inputTokens=${inputTokens} outputTokens=${outputTokens}`);
  evt.sender.send(channelId, {
    done: true,
    prompt_eval_count: inputTokens,
    eval_count: outputTokens
  });
}

ipcMain.handle('cloud:chat', async (evt, { provider, apiKey, model, messages, tools, options, images }) => {
  const channelId = `cloud:chat:stream:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const controller = new AbortController();
  // local: false — cloud streams consume no local memory, so the freeze
  // watchdog leaves them alone. A frozen machine is never a cloud model's fault.
  activeChatStreams.set(channelId, { controller, model, local: false });

  const debugLog = path.join(app.getPath('userData'), 'chat-debug.log');
  const dlog = (msg) => { try { fs.appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

  (async () => {
    dlog(`=== cloud chat start · provider=${provider} model=${model} msgs=${messages?.length} tools=${tools ? tools.length : 0} ===`);
    try {
      await new Promise(r => setImmediate(r));   // let the channel listener attach first
      if (!apiKey) {
        evt.sender.send(channelId, { error: `No API key set for ${provider}. Open Settings → API Keys to add one.`, done: true });
        return;
      }
      if (provider === 'anthropic') {
        await streamAnthropic({ apiKey, model, messages, tools, options, images, controller, evt, channelId, dlog });
      } else if (provider === 'google') {
        await streamGoogle({ apiKey, model, messages, tools, options, images, controller, evt, channelId, dlog });
      } else {
        evt.sender.send(channelId, { error: `Unknown cloud provider: ${provider}`, done: true });
      }
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') {
        evt.sender.send(channelId, { aborted: true, done: true });
      } else {
        dlog(`cloud exception: ${e.message}`);
        evt.sender.send(channelId, { error: e.message, done: true });
      }
    } finally {
      activeChatStreams.delete(channelId);
    }
  })();

  return { channelId };
});

ipcMain.handle('cloud:chat-abort', (_e, channelId) => {
  const entry = activeChatStreams.get(channelId);
  if (!entry) return { ok: false, note: 'no active stream' };
  try { entry.controller.abort(); } catch {}
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

ipcMain.handle('shell:run_async', async (_e, { command, cwd, allowlist, remoteCall }) => {
  try {
    const refused = remoteCallRefused(remoteCall);
    if (refused) return { error: refused };
    const wd = cwd ? resolveSafe(cwd) : os.homedir();
    if (allowlist?.length && !withinAllowlist(wd, allowlist)) {
      return { error: `cwd "${cwd}" outside allowed roots` };
    }
    // An id of its own, so one a model remembers from here can't find a task on the home PC.
    const taskId = (remoteCall ? 'remote_task_' : 'task_') + (nextTaskId++);
    const proc = startInOwnGroup(command, {
      cwd: wd,
      // Same resolved shell as sync shell:run — Git Bash on Windows if
      // installed, else cmd.exe.
      shell: SHELL.path,
      windowsHide: true
    });
    const task = {
      id: taskId, command, cwd: wd,
      proc, stdout: '', stderr: '',
      status: 'running', exitCode: null,
      startedAt: Date.now(), finishedAt: null,
      remoteDevice: remoteCall?.deviceId ?? null
    };
    const cap = (s) => s.length > 200_000 ? s.slice(-200_000) : s;
    proc.stdout.on('data', d => { task.stdout = cap(task.stdout + d.toString()); });
    proc.stderr.on('data', d => { task.stderr = cap(task.stderr + d.toString()); });
    // The running indicator on a laptop goes by these, so it has to hear when one ends.
    const homeTaskChanged = () => { if (task.remoteDevice) remoteManager?.refreshStatus(); };
    proc.on('exit', (code) => {
      task.status = (task.status === 'killed') ? 'killed' : 'done';
      task.exitCode = code;
      task.finishedAt = Date.now();
      task.proc = null;
      homeTaskChanged();
    });
    proc.on('error', (err) => {
      task.status = 'error';
      task.stderr += '\n' + err.message;
      task.finishedAt = Date.now();
      task.proc = null;
      homeTaskChanged();
    });
    backgroundTasks.set(taskId, task);
    homeTaskChanged();
    return { taskId, command, cwd: wd };
  } catch (e) { return { error: e.message }; }
});

// With a scope, only what that device started exists.
const taskInScope = (task, scope) => task && (!scope || task.remoteDevice === scope) ? task : null;

ipcMain.handle('shell:task_status', async (_e, taskId, scope) => {
  const task = taskInScope(backgroundTasks.get(taskId), scope);
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

ipcMain.handle('shell:task_list', async (_e, scope) => {
  const out = [];
  for (const t of backgroundTasks.values()) {
    if (!taskInScope(t, scope)) continue;
    out.push({
      id: t.id, command: t.command, status: t.status, exitCode: t.exitCode,
      runtime_seconds: Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000)
    });
  }
  return { tasks: out };
});

ipcMain.handle('shell:task_kill', async (_e, taskId, scope) => {
  const task = taskInScope(backgroundTasks.get(taskId), scope);
  if (!task) return { error: 'task not found' };
  if (task.status !== 'running') return { error: `task already ${task.status}` };
  task.status = 'killed';
  killTree(task.proc);
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

// cwd is where it runs, given only by a laptop running code from a shared chat, in that chat's folder
// on the laptop. Without one it runs in the temp folder, as it always has.
ipcMain.handle('shell:run_code_stream', async (e, { lang, code, cwd }) => {
  const channelId = `runcode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const safeSend = deferredSender(e.sender, channelId);
  const runIn = cwd === undefined || cwd === null ? os.tmpdir() : cwd;
  let folderProblem = null;
  try {
    if (typeof runIn !== 'string' || !path.isAbsolute(runIn) || !fs.statSync(runIn).isDirectory()) folderProblem = 'not a folder';
  } catch {
    folderProblem = 'gone';
  }
  if (folderProblem) {
    setImmediate(() => safeSend({ kind: 'error', text: `That folder isn't available here: ${String(runIn)}`, done: true }));
    return { channelId };
  }

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
    // npx is a .cmd file on Windows, which only starts through a shell. "bash"
    // there can be the WSL launcher, so use the Git Bash found at boot.
    const viaShell = process.platform === 'win32' && runner.cmd === 'npx';
    const cmd = runner.cmd === 'bash' && /bash/i.test(SHELL.path || '') ? SHELL.path : runner.cmd;
    proc = spawn(cmd, viaShell ? spawnArgs.map(quoteWindowsArg) : spawnArgs, {
      cwd: runIn,
      windowsHide: true,
      shell: viaShell,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    });
  } catch (err) {
    safeSend({ kind: 'error', text: `Couldn't start ${runner.cmd}: ${err.message}\n\nIs it installed and on PATH?`, done: true });
    try { fs.unlinkSync(tmpFile); } catch {}
    return { channelId };
  }

  const task = {
    id: taskId, command: `${runner.cmd} ${spawnArgs.join(' ')}`, cwd: runIn,
    proc, stdout: '', stderr: '',
    status: 'running', exitCode: null,
    startedAt: Date.now(), finishedAt: null,
    tmpFile, channelId
  };
  backgroundTasks.set(taskId, task);
  safeSend({ kind: 'start', taskId, command: task.command });

  // Only the tail is kept, so a program printing forever can't fill main's memory.
  const keepTail = (s) => (s.length > 200_000 ? s.slice(-200_000) : s);
  proc.stdout.on('data', (d) => {
    const text = d.toString();
    task.stdout = keepTail(task.stdout + text);
    safeSend({ kind: 'stdout', text });
  });
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    task.stderr = keepTail(task.stderr + text);
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
  task.status = 'killed';
  killTree(task.proc);
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
    const { onSpawn, ...spawnOpts } = opts;
    try {
      proc = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    } catch (e) {
      resolve({ ok: false, error: e.message, stdout: '', stderr: '' });
      return;
    }
    if (onSpawn) onSpawn(proc);
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
  const safeSend = deferredSender(e.sender, channelId);

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
  const audioResult = await execAsync('ffmpeg', audioArgs, { onSpawn: (p) => { procEntry.proc = p; } });
  procEntry.proc = null;
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
  killTree(entry.proc);
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
      const split = splitOutputLines(buf);
      buf = split.rest;
      for (const line of split.lines) {
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

// Parse the html.duckduckgo.com results page.
function parseDdgHtml(html) {
  const results = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < 8) {
    let link = m[1].replace(/&amp;/g, '&');
    if (/^(\/\/|https?:\/\/)duckduckgo\.com\/y\.js/.test(link)) continue;   // ads
    const udd = link.match(/uddg=([^&]+)/);
    if (udd) link = decodeURIComponent(udd[1]);
    if (link.startsWith('//')) link = 'https:' + link;
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (title && link.startsWith('http')) results.push({ url: link, title, snippet });
  }
  return results;
}

// Parse the lite.duckduckgo.com fallback page — a much simpler table layout
// that tends to succeed when the html endpoint returns an empty/blocked page.
function parseDdgLite(html) {
  const results = [];
  // lite.duckduckgo.com emits single-quoted class attributes and puts the
  // href before the class, so match on class alone and grab href separately.
  const linkRe = /<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const hrefRe = /href=['"]([^'"]+)['"]/;
  const snipRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const links = []; let m;
  while ((m = linkRe.exec(html)) && links.length < 8) {
    const hrefM = m[0].match(hrefRe);
    if (!hrefM) continue;
    let link = hrefM[1].replace(/&amp;/g, '&');
    const udd = link.match(/uddg=([^&]+)/);
    if (udd) link = decodeURIComponent(udd[1]);
    if (link.startsWith('//')) link = 'https:' + link;
    links.push({ url: link, title: stripTags(m[1]) });
  }
  const snips = []; let s;
  while ((s = snipRe.exec(html))) snips.push(stripTags(s[1]));
  links.forEach((l, i) => {
    if (l.title && l.url.startsWith('http')) results.push({ ...l, snippet: snips[i] || '' });
  });
  return results;
}

ipcMain.handle('web:search', async (_evt, query) => {
  if (!query || typeof query !== 'string') return { error: 'query required' };
  // Two endpoints, tried in order. The html one is richer but intermittently
  // returns an empty page (rate-limiting / anti-scrape); the lite one is
  // plainer but far more reliable, so it's the fallback. A search that just
  // "failed" was usually the html endpoint coming back empty with no retry.
  try {
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://html.duckduckgo.com/'
      },
      body: `q=${encodeURIComponent(query)}&b=&kl=us-en`,
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const results = parseDdgHtml(await res.text());
      if (results.length) return { results };
    }
  } catch { /* fall through to lite */ }

  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://lite.duckduckgo.com/'
      },
      body: `q=${encodeURIComponent(query)}&kl=us-en`,
      signal: AbortSignal.timeout(12000)
    });
    if (res.ok) {
      const results = parseDdgLite(await res.text());
      if (results.length) return { results };
    }
    return { results: [], error: 'no results' };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('web:fetch', async (_evt, url) => {
  try {
    if (!url || !/^https?:\/\//.test(url)) return { error: 'http(s) url required' };
    const res = await safeFetchText(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } });
    if (res.error) return { error: res.error };
    if (res.contentType.includes('json')) return { url: res.url, content: res.text.slice(0, 20000), kind: 'json' };
    return { url: res.url, content: stripTags(res.text).slice(0, 20000), kind: 'html' };
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

// An empty list allows nothing. The renderer answers that error by asking the
// user, so a chat with no project folder still works, one approved path at a time.
function withinAllowlist(filePath, allowlist) {
  return isWithinRoots(filePath, (allowlist || []).map(resolveSafe).filter(Boolean));
}

// The agent's reads stop here, before the allowlist, so being refused can't offer a pop-up to
// widen it. A folder above the profile is fine: a walk goes around it. Sanctum's own code reads
// this folder with fs directly, not through these handlers. run_command isn't limited by this.
const PROFILE_REFUSAL = { error: "That is inside Sanctum's own data folder, which the agent's file tools can't open.", inProfile: true };

// Null if a tool may use this path. A path outside every allowed folder is refused by its words,
// before anything canonicalizes it, so a network path nobody allowed touches nothing.
function checkedPath(fp, allowlist) {
  return checkAgentPath(fp, { roots: (allowlist || []).map(resolveSafe).filter(Boolean), profile: app.getPath('userData') });
}

function pathRefusal(fp, requested, allowlist) {
  const problem = checkedPath(fp, allowlist);
  if (problem === 'profile') return PROFILE_REFUSAL;
  return problem ? { error: `path "${requested}" is outside the allowed roots: ${(allowlist || []).join(', ')}` } : null;
}

function rootRefusal(root, allowlist) {
  const problem = checkedPath(root, allowlist);
  if (problem === 'profile') return PROFILE_REFUSAL;
  return problem ? { error: 'root outside allowed roots' } : null;
}

ipcMain.handle('fs:read_file', async (_e, requestedPath, allowlist) => {
  try {
    const fp = resolveSafe(requestedPath);
    if (!fp) return { error: 'path required' };
    const refused = pathRefusal(fp, requestedPath, allowlist);
    if (refused) return refused;
    if (!fs.existsSync(fp)) return { error: 'file not found' };
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) return { error: 'path is a directory — use list_dir instead' };
    if (stat.size > 200_000) return { error: `file too large (${(stat.size/1024).toFixed(1)} KB, max 200 KB)` };
    const content = fs.readFileSync(fp, 'utf-8');
    return { path: fp, content, size: stat.size };
  } catch (e) { return { error: e.message }; }
});

// The places a folder browser can start from: each drive on Windows, or the root. lib/fs-rules.js says
// how they're found and kept.
const folderRoots = createRootsProbe({ stat: (p) => fs.promises.stat(p), platform: process.platform });

// { foldersOnly } is the folder browser's listing: folders before the cap, and how many more there were.
// { roots } adds where it can start from.
ipcMain.handle('fs:list_dir', async (_e, requestedPath, allowlist, options) => {
  try {
    const fp = resolveSafe(requestedPath);
    if (!fp) return { error: 'path required' };
    const refused = pathRefusal(fp, requestedPath, allowlist);
    if (refused) return refused;
    if (!fs.existsSync(fp)) return { error: 'directory not found' };
    const stat = fs.statSync(fp);
    if (!stat.isDirectory()) return { error: 'not a directory' };
    if (options?.foldersOnly === true) {
      const { names, more } = folderListing(fs.readdirSync(fp, { withFileTypes: true }), 200);
      const listed = { path: fp, entries: names.map(name => ({ name, kind: 'dir' })), more };
      if (options.roots === true) listed.roots = await folderRoots();
      return listed;
    }
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
    const refused = pathRefusal(fp, p, allowlist);
    if (refused) return refused;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content ?? '', 'utf-8');
    return { path: fp, bytes: Buffer.byteLength(content ?? '', 'utf-8') };
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:apply_patch', async (_e, { path: p, find, replace, allowlist }) => {
  try {
    const fp = resolveSafe(p);
    if (!fp) return { error: 'path required' };
    const refused = pathRefusal(fp, p, allowlist);
    if (refused) return refused;
    if (typeof find !== 'string' || !find.length) return { error: 'find string required' };
    if (!fs.existsSync(fp)) return { error: 'file not found' };
    const orig = fs.readFileSync(fp, 'utf-8');
    const matches = orig.split(find).length - 1;
    if (matches === 0) return { error: 'find string not found in file' };
    if (matches > 1) return { error: `find string matches ${matches} times — make it more specific` };
    const next = applyExactPatch(orig, find, replace);
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
    fs.appendFileSync(auditLogPath(), RemoteRules.agentAuditLine(entry) + '\n');
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
ipcMain.handle('fs:glob', async (_e, { pattern, root, allowlist }) => {
  try {
    const r = resolveSafe(root || os.homedir());
    if (!r) return { error: 'root required' };
    const refused = rootRefusal(r, allowlist);
    if (refused) return refused;
    if (!pattern || typeof pattern !== 'string') return { error: 'pattern required' };
    return await globInWorker({ pattern, root: r, profile: app.getPath('userData') });
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('fs:grep', async (_e, { pattern, root, glob: globFilter, caseInsensitive, allowlist }) => {
  try {
    const r = resolveSafe(root || os.homedir());
    if (!r) return { error: 'root required' };
    const refused = rootRefusal(r, allowlist);
    if (refused) return refused;
    if (!pattern || typeof pattern !== 'string') return { error: 'pattern required' };
    return await grepInWorker({ pattern, root: r, globFilter, caseInsensitive, profile: app.getPath('userData') });
  } catch (e) { return { error: e.message }; }
});

// =============== SHELL ===============
ipcMain.handle('shell:run', async (_e, { command, cwd, remoteCall }) => {
  const refused = remoteCallRefused(remoteCall);
  if (refused) return { error: refused };
  const wd = cwd ? resolveSafe(cwd) : os.homedir();
  const result = await runShellCommand({
    command,
    cwd: wd,
    // SHELL is the resolved shell at boot — Git Bash on Windows when it's
    // installed, else cmd.exe; /bin/sh on macOS/Linux.
    shell: SHELL.path,
    timeoutMs: 60_000,
    onStart: (child) => {
      if (remoteCall) remoteRuns.set(remoteRunKey(remoteCall), { child, deviceId: remoteCall.deviceId, id: remoteCall.id, command, ended: false });
    }
  });
  if (remoteCall) remoteRuns.delete(remoteRunKey(remoteCall));
  return { command, cwd: wd, ...result };
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
