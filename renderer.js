const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORAGE_KEY = 'localai.state.v1';
const SETTINGS_KEY = 'localai.settings.v1';

const state = {
  catalog: null,
  installed: new Set(),
  chats: {},
  order: [],
  activeId: null,
  pulling: new Set(),
  pullProgress: {},       // tag → { received, total } (aggregated across all layers)
  pullDigests:  {},       // tag → { digestKey → { received, total } } — per-layer raw progress; summed into pullProgress so % doesn't drop when Ollama starts a new layer
  pullChannels: new Map(),// tag → channelId (so we can abort)
  paused: new Set(),      // tags whose pull was paused (partial download exists)
  cancelled: new Set(),   // tags currently being cancelled (transient — for cleanup branch)
  runningChats: new Map(),// chatId → { channelId, abortRequested } — drives the send/stop button
  pendingAttachments: [],
  hardware: null,          // hw:detect result — probed lazily when Download opens
  downloadCatalog: null,   // download-catalog.json — lazy-loaded, ~86 models
  dlFilters: null,   // Set of active download-filter keys; lazily created
  space: 'home',     // 'home' (normal chats) | 'code' (agentic projects)
  pullError: null,   // { tag, msg } of the last failed Downloads pull
  dlQuery: '',
  settings: { instructions: '' },
  ollamaDetected: null,
  ollamaRunning: false,
  ollamaBusy: false,
  recentlyInstalled: new Set(), // tags that just finished — show ✓ briefly
  // Status of Video Analysis prerequisites. Refreshed on init + every time the
  // model picker opens, so the dedicated Video Analysis section can show live
  // ✓/Install state for ffmpeg and Whisper without polling.
  videoDeps: { ffmpeg: null, whisper: null, lastChecked: 0 },
  videoDepInstalling: new Set(), // 'ffmpeg' / 'whisper' currently being installed
  // MCP servers — populated from main process. Each entry is
  // { name, command, args, env, status, error, tools[] }. The Ollama-shaped
  // tool list is cached so buildTools() doesn't need an async hop.
  mcpServers: [],
  mcpTools: []
};

// ============== BOOT ==============
(async function init() {
  state.catalog = await window.api.catalog();
  // Needed at boot, not lazily: the model picker resolves installed models
  // through this catalog, and every capability check (vision, tools,
  // thinking) falls back to it via findPick().
  try { state.downloadCatalog = await window.api.downloadCatalog(); } catch {}
  loadFromStorage();
  loadSettings();
  applyTheme(state.settings.theme || 'sanctum');

  await detectOllama();
  await refreshOllama();
  setInterval(refreshOllama, 8000);

  // MCP — pull initial state, subscribe to updates from main, refresh tools
  // whenever the server set changes so agentic mode sees them immediately.
  try {
    state.mcpServers = await window.api.mcp.list();
    state.mcpTools   = await window.api.mcp.getTools();
  } catch {}
  window.api.mcp.onUpdate(async (servers) => {
    state.mcpServers = servers || [];
    try { state.mcpTools = await window.api.mcp.getTools(); } catch { state.mcpTools = []; }
    if (typeof renderMcpSettings === 'function') renderMcpSettings();
  });

  if (!state.order.length) {
    createChat();
  } else {
    // Open into the workspace the most-recent chat belongs to, so a reload
    // doesn't strand you in Home looking at nothing while your last project
    // sits in Code.
    const first = state.chats[state.order[0]];
    state.space = chatSpace(first);
    setActive(state.order[0]);
  }
  applySpaceChrome();

  wireCodeBlockActions();
  wireVideoBubbleActions();
  wireDragDrop();
  wireSidebar();
  wireFreezeWatchdog();
  wireDebugOverlay();
  wireComposer();
  wireAttachments();
  wireTitleEdit();
  wireModelPicker();
  wireModelsView();
  wireSettings();
  wireMcpEditor();
  wireWebToggle();
  wireThinkToggle();
  wireToolsMenu();
  wireAgentBar();
  wireAgentOpts();
  wireInstallBanner();
  renderChatList();
})();

// Surface any uncaught renderer errors so silent failures stop being silent.
window.addEventListener('error', (e) => {
  console.error('renderer error:', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('renderer unhandled rejection:', e.reason);
});

// ============== STORAGE ==============
function saveToStorage() {
  try {
    const slim = { order: state.order, activeId: state.activeId, chats: {} };
    for (const id of state.order) {
      const c = state.chats[id];
      if (!c) continue;
      slim.chats[id] = {
        ...c,
        messages: c.messages.map(m => ({
          role: m.role,
          content: m.content,
          modality: m.modality,
          toolEvents: m.toolEvents,
          attachments: (m.attachments || []).map(a => ({ kind: a.kind, name: a.name, pages: a.pages, ext: a.ext }))
        }))
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch (e) { console.warn('save failed', e); }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.chats = data.chats || {};
    state.order = data.order || [];
    state.activeId = data.activeId || null;

    // Migration: chats whose model is now a hidden router (vision auto-router)
    // OR an old image/video-gen modality (since removed) → reset to a
    // user-pickable default chat model.
    //
    // CRITICAL: the lookup MUST match cloud picks too. v0.3.0–v0.3.4 used
    // `p.tag === c.model` here, but cloud picks have no `tag` (they use
    // `model_id` / `id`). That meant every cloud-picked chat looked like an
    // unknown model on boot and got silently reset to Qwen3 30B — which
    // wasn't installed either, so Send appeared to do nothing. The catalog
    // helper findPick checks all the alternate fields.
    if (state.catalog) {
      const fallback = state.catalog.categories.chat.picks.find(p => !p.multimodal)?.tag;
      for (const id of state.order) {
        const c = state.chats[id];
        if (!c) continue;
        const pick = allPicks().find(p =>
          (p.tag || p.model_id || p.id || p.file) === c.model || p.id === c.model
        );
        const removedModality = c.modality === 'image' || c.modality === 'video';
        if ((!pick || pick.multimodal || removedModality) && fallback) {
          c.model = fallback;
          c.modality = 'chat';
        }
      }
    }
  } catch (e) { console.warn('load failed', e); }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) state.settings = { ...state.settings, ...JSON.parse(raw) };
  } catch {}
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {}
}

// ============== CHATS ==============
function createChat(modelOverride, modalityOverride, extraFields) {
  const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // Default-model priority: explicit override → currently-active chat's model
  // → the last model the user picked anywhere → first-installed fallback.
  // So new chats inherit your most recent selection instead of snapping back
  // to the catalog's #1.
  const defaultModel =
    modelOverride
    || currentChat()?.model
    || state.settings.lastModel
    || firstAvailableModel();
  // Default modality is 'chat' for the New Chat button. The previous behavior
  // inherited the modality from whichever model was carried over — which made
  // New Chat *sticky*: once you opened an agentic chat, every subsequent New
  // Chat became agentic too (because qwen3:8b lives in the `agent` catalog
  // category, so modalityForModel returns 'agent' even though the user just
  // wanted a plain chat). Explicit modality (createAgenticChat, etc.) still
  // wins via modalityOverride.
  const modality = modalityOverride || 'chat';
  state.chats[id] = {
    id, title: '', model: defaultModel, modality,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: [],
    // Default web search ON; updateUIForChat() flips it off if the chosen
    // model isn't tools-capable. extraFields can still override.
    webEnabled: true,
    ...(extraFields || {})
  };
  state.order.unshift(id);
  // A normal chat belongs to Home; a project (modalityOverride 'agent') to
  // Code. Align the workspace so the new chat is actually visible in the list.
  state.space = modality === 'agent' ? 'code' : 'home';
  applySpaceChrome();
  setActive(id);
  saveToStorage();
  renderChatList();
  // Starting a new chat from the Downloads (or any) view should drop you into
  // that chat, not leave you staring at the model list.
  switchView('chat');
}

// Spin up an Agent-modality chat with Plan + Approval modes enabled by default.
function createAgenticChat() {
  if (!state.catalog) return;
  // 1) Keep whatever model the user has selected, as long as it's tools-capable
  //    AND usable right now (installed for Ollama / API key set for cloud).
  //    Picking "New Agentic Chat" while on Claude Opus shouldn't silently
  //    swap to Qwen3 — the user already chose a capable model.
  // 2) Fall back to the agent catalog: prefer an installed Ollama pick over
  //    the first listed.
  // Keep whatever model is currently selected. Never silently swap in a
  // heavier one — the old fallback loaded qwen3:30b-a3b (a 30B model) whenever
  // the current model wasn't flagged tools-capable, which pinned 19GB+ on an
  // 8GB Mac and froze it. A project can run any model the user picked; if it's
  // not great at tools that's the user's call, not a reason to auto-load a
  // giant. Only fall back when there's genuinely no current model, and then to
  // the SMALLEST installed model, not the catalog's flagship.
  let model = currentChat()?.model || state.settings.lastModel || null;
  if (!model || !(findPick(model))) {
    const installed = [...state.installed];
    // Smallest installed model by catalog size, so the fallback is never heavy.
    const bySize = installed
      .map(tag => ({ tag, gb: (state.downloadCatalog?.models || []).find(m => m.tag === tag)?.sizeGB || 999 }))
      .sort((a, b) => a.gb - b.gb);
    model = bySize[0]?.tag || installed[0] || firstAvailableModel();
  }
  if (!model) return;
  createChat(model, 'agent', {
    planMode: true,             // safer default — plan first, no execution
    approvalMode: false,        // mutex with planMode + noApproval
    noApproval: false,          // YOLO — explicit opt-in, never default
    webEnabled: true,
    thinkingEnabled: false,
    readOnly: false,
    noFetch: false,
    pathAllowlist: [],
    commandAllowlist: [],
    maxSteps: 5,
    contextWindow: 8192         // 8K — safe for 32 GB systems running Qwen3 30B
  });
}

function setActive(id) {
  state.activeId = id;
  state.pendingAttachments = [];
  renderAttachments();
  renderActiveChat();
  renderChatList();
  saveToStorage();
}

function deleteChat(id) {
  delete state.chats[id];
  state.order = state.order.filter(x => x !== id);
  if (state.activeId === id) {
    // Activate the next chat in this workspace. If that was the LAST one,
    // don't leave an empty view — refresh with a fresh chat of the same kind
    // (a normal chat in Home, a project in Code).
    const next = chatsInCurrentSpace()[0];
    if (next) setActive(next.id);
    else if (state.space === 'code') createAgenticChat();
    else createChat();
  }
  saveToStorage();
  renderChatList();
}

function currentChat() { return state.chats[state.activeId]; }

function touchChat(id) {
  const c = state.chats[id];
  if (!c) return;
  c.updatedAt = Date.now();
  state.order = [id, ...state.order.filter(x => x !== id)];
}

function autoTitle(chat, firstUserText) {
  if (chat.title) return;
  const t = firstUserText.replace(/\s+/g, ' ').trim().slice(0, 48);
  chat.title = t || 'New chat';
}

// Fire-and-forget background call that asks a small/fast installed model to
// generate a clean 3-6 word title for the chat. Runs after the first user
// message and overwrites the truncated autoTitle. Skips when:
//   - the user has manually renamed (titleManual flag set by the pen editor)
//   - no Ollama model is installed
//   - the call errors (silent failure — autoTitle stays)
async function generateChatTitle(c, userMessage) {
  if (c.titleManual) return;
  // Prefer the smallest tool-capable models for snappy title gen, regardless
  // of which model is handling the actual conversation.
  const candidates = ['llama3.2:3b', 'qwen2.5:7b', 'hermes3:8b', c.model];
  let titleModel = null;
  for (const m of candidates) {
    if (m && state.installed.has(m)) { titleModel = m; break; }
  }
  if (!titleModel) return;

  const prompt = `Generate a very short chat title (3 to 6 words max) summarising this user message. Plain words only — NO quotes, NO period, NO markdown, NO emoji, NO prefix like "Title:". Just the title.

User message:
${userMessage.slice(0, 600)}

Title:`;

  try {
    let title = '';
    await window.api.ollama.chat({
      model: titleModel,
      messages: [{ role: 'user', content: prompt }],
      options: { num_ctx: 2048, temperature: 0.3 }
    }, (chunk) => {
      if (chunk.message?.content) title += chunk.message.content;
    });
    // Strip prefix, quotes, trailing punctuation, take first line, hard cap.
    title = title.trim()
      .replace(/^title\s*[:\-]\s*/i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?;:,]+$/, '')
      .split(/[\r\n]/)[0]
      .trim()
      .slice(0, 60);
    if (c.titleManual) return; // user renamed in the meantime
    if (title && title.length > 1) {
      c.title = title;
      saveToStorage();
      renderActiveChat();
      renderChatList();
    }
  } catch { /* silent — autoTitle stays */ }
}

// ============== MODELS ==============
// ============== DEBUG OVERLAY ==============
// Live hardware counters. Polls main once a second, but only while visible —
// each poll spawns nvidia-smi, so an always-on timer would be wasteful.
let dbgTimer = null;

function dbgBar(label, used, total, unit, pct) {
  const p = pct != null ? pct : (total ? Math.min(100, (used / total) * 100) : 0);
  const tone = p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok';
  const readout = total != null
    ? `${used} / ${total} ${unit}`
    : `${Math.round(p)}%`;
  return `
    <div class="dbg-row">
      <div class="dbg-label"><span>${escapeHtml(label)}</span><span class="dbg-val">${escapeHtml(readout)}</span></div>
      <div class="dbg-track"><div class="dbg-fill ${tone}" style="width:${p.toFixed(1)}%"></div></div>
    </div>`;
}

async function dbgTick() {
  const body = $('#dbg-body');
  if (!body) return;
  let s;
  try { s = await window.api.hardwareLive(); }
  catch { body.innerHTML = `<div class="dbg-empty">Couldn't read hardware stats.</div>`; return; }

  let html = '';
  if (s.gpu) {
    if (s.gpu.utilPct != null) html += dbgBar('GPU', null, null, '', s.gpu.utilPct);
    html += dbgBar('VRAM', s.gpu.vramUsedGB, s.gpu.vramTotalGB, 'GB');
  }
  html += dbgBar('RAM', s.ramUsedGB, s.ramTotalGB, 'GB');
  if (s.cpuPct != null) html += dbgBar('CPU', null, null, '', s.cpuPct);
  if (!s.gpu) html += `<div class="dbg-note">No NVIDIA GPU detected — GPU and VRAM unavailable.</div>`;
  body.innerHTML = html;
}

function setDebugOverlay(on) {
  const el = $('#dbg-overlay');
  if (!el) return;
  el.hidden = !on;
  clearInterval(dbgTimer);
  dbgTimer = null;
  if (on) { dbgTick(); dbgTimer = setInterval(dbgTick, 1000); }
}

function wireDebugOverlay() {
  const close = $('#dbg-close');
  if (close && !close.dataset.wired) {
    close.dataset.wired = '1';
    close.addEventListener('click', () => {
      state.settings.debugOverlay = false;
      saveSettings();
      setDebugOverlay(false);
      const cb = $('#setting-dbg-enabled');
      if (cb) cb.checked = false;
    });
  }
  setDebugOverlay(state.settings.debugOverlay === true);
}

// Main aborted a run because the machine locked up. Explain it in the chat —
// a run that just stops with no reason reads like a bug.
function wireFreezeWatchdog() {
  if (!window.api.watchdog?.onFreezeAbort) return;

  // Push the user's preference down to main on boot.
  const wd = state.settings.watchdog || {};
  window.api.watchdog.config({
    enabled: wd.enabled !== false,
    tripMs: wd.tripMs || 15000
  }).catch(() => {});

  window.api.watchdog.onFreezeAbort(({ stalledMs, freeGB, models, unloaded }) => {
    const secs = Math.round(stalledMs / 1000);
    const model = models?.[0];

    // Mark every running chat as stopped — the streams are already dead.
    for (const [chatId] of state.runningChats) {
      const c = state.chats[chatId];
      const last = c?.messages?.[c.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.thinking = false;
        // Explain the mismatch with real numbers where we can.
        const meta = (state.downloadCatalog?.models || []).find(m => m.tag === model);
        let why = '';
        if (meta && state.hardware) {
          const need = modelFootprintGB(meta, 4096);
          why = `\n\n**${escapeHtml(meta.name)}** needs about **${need.toFixed(1)} GB**, but your machine has roughly **${state.hardware.maxBudgetGB} GB** usable. It was being swapped to disk, which is what locked everything up.`;
        }
        const freed = unloaded?.length
          ? `\n\nThe model has been unloaded, so your memory is back.`
          : `\n\nI couldn't confirm the model unloaded — if things are still slow, run \`ollama stop ${model || '<model>'}\` in a terminal.`;
        last.content = (last.content || '') +
          `\n\n---\n\n**Stopped automatically.** Your system stopped responding for about ${secs} seconds${freeGB != null ? ` (free memory was down to ${freeGB} GB)` : ''}, so Sanctum ended the run rather than leave you unable to click Stop.${why}${freed}\n\n_Try a smaller model — **Downloads** shows what fits this machine. You can turn this off in Settings → General._`;
        try { patchLastMessageContent(last); } catch {}
      }
      state.runningChats.delete(chatId);
    }
    try { updateSendButton(); saveToStorage(); renderActiveChat(); } catch {}
  });
}

// ============== HARDWARE FIT ENGINE ==============
// Turns "20GB model, 12GB card, 64GB RAM" into an honest verdict. Ollama does
// partial offload, so a model larger than VRAM still runs — CPU-bound. The
// three verdicts map to that reality:
//   good        — fits in GPU/unified memory, runs at full speed
//   tight       — spills to system RAM, works but noticeably slow
//   unrunnable  — exceeds system RAM, won't load at all
//
// RUNTIME_OVERHEAD_GB covers the llama.cpp context, compute buffers, and
// allocator slack that sit alongside the weights.
const RUNTIME_OVERHEAD_GB = 0.6;
const WEIGHT_SLACK = 1.08; // quantised weights land slightly above download size
const CTX_TIERS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

function modelFootprintGB(model, ctxTokens = 0) {
  const weights = model.sizeGB * WEIGHT_SLACK;
  const kv = ctxTokens ? (model.kvKbPerTok * ctxTokens) / (1024 * 1024) : 0;
  return weights + kv + RUNTIME_OVERHEAD_GB;
}

// Verdict at a small baseline context (4K) — the question is "can I run this
// at all", not "can I run it at 128K".
function fitFor(model, hw) {
  // Some flagships ship on Ollama with no local weights at all — they're
  // proxied to Ollama's servers via a `:cloud` tag. Hardware is irrelevant
  // for those, so they get their own verdict rather than being mislabelled
  // "too large" (which would imply a bigger GPU could fix it).
  if (model.cloudOnly) {
    return {
      verdict: 'cloud',
      label: 'Cloud only',
      detail: 'No local weights — Ollama runs this on its own servers and needs an ollama.com account.'
    };
  }
  if (!hw) return { verdict: 'unknown', label: 'Checking…', detail: '' };
  const need = modelFootprintGB(model, 4096);
  if (need <= hw.fastBudgetGB) {
    return {
      verdict: 'good',
      label: 'Runs well',
      detail: hw.budgetSource === 'vram'
        ? `Fits in ${hw.vramGB}GB of VRAM — full GPU speed.`
        : `Fits in memory — full speed.`
    };
  }
  if (need <= hw.maxBudgetGB) {
    return {
      verdict: 'tight',
      label: 'Tight',
      detail: hw.budgetSource === 'vram'
        ? `Too big for ${hw.vramGB}GB of VRAM — spills to system RAM and runs slowly.`
        : `Close to your memory limit — expect slow generation.`
    };
  }
  return {
    verdict: 'unrunnable',
    label: 'Too large',
    detail: `Needs about ${need.toFixed(1)}GB; you have ~${hw.maxBudgetGB}GB usable.`
  };
}

// Largest context tier that still leaves headroom on this machine. Uses the
// fast budget when the model fits on the GPU, otherwise the system budget.
function recommendedCtx(model, hw) {
  if (!hw || model.cloudOnly) return null;
  const base = modelFootprintGB(model, 0);
  const budget = base <= hw.fastBudgetGB ? hw.fastBudgetGB : hw.maxBudgetGB;
  const headroom = budget - base;
  if (headroom <= 0) return null;
  let best = null;
  for (const t of CTX_TIERS) {
    if (t > (model.ctxMax || 0)) break;
    const kvGB = (model.kvKbPerTok * t) / (1024 * 1024);
    if (kvGB <= headroom * 0.7) best = t;   // keep 30% back for compute buffers
  }
  return best;
}

function fmtCtx(n) {
  if (!n) return '—';
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

function fmtGB(n) {
  if (n == null) return '—';
  return n < 1 ? `${Math.round(n * 1024)} MB` : `${n} GB`;
}

function fmtBytes(b) {
  if (!b) return '0 MB';
  const gb = b / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
}

// Patch the Downloads card's progress in place. Ollama streams progress many
// times a second, so re-rendering the whole 226-model list per chunk would
// thrash the DOM and fight the user's scroll position.
function patchDlProgress(tag) {
  const wrap = $('#dl-list');
  if (!wrap || $('#dl-wrap')?.hidden) return;
  let el;
  try { el = wrap.querySelector(`.dl-prog[data-prog-tag="${CSS.escape(tag)}"]`); } catch { el = null; }
  if (!el) return;
  const prog = state.pullProgress[tag];
  if (!prog) return;
  const paused = state.paused.has(tag);
  const pct = Math.round(prog.pct ?? (prog.total ? (prog.received / prog.total) * 100 : 0));
  const pctEl = el.querySelector('.dl-prog-pct');
  const byteEl = el.querySelector('.dl-prog-bytes');
  const fill = el.querySelector('.dl-prog-fill');
  if (pctEl) pctEl.textContent = paused ? `Paused · ${pct}%` : `${pct}%`;
  if (byteEl) byteEl.textContent = `${fmtBytes(prog.received)} / ${fmtBytes(prog.total)}`;
  if (fill) { fill.style.width = `${pct}%`; fill.classList.toggle('paused', paused); }
}

function allPicks() {
  const out = [];
  if (!state.catalog) return out;
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
    for (const p of cat.picks) out.push({ ...p, category: key, categoryLabel: cat.label, backend: cat.backend });
  }
  return out;
}

function modalityForModel(modelId) {
  if (!state.catalog || !modelId) return 'chat';
  // Must check tag / model_id / id / file — cloud picks have NO `tag` (they
  // use `model_id` and `id`). Missing this was the v0.3.x send-broken bug:
  // modalityForModel('claude-opus-4-8') returned the 'chat' default, then
  // backendForModel returned 'ollama', then dispatchSend hit the install-
  // check gate and silently bailed. Send animated but nothing happened.
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
    if (cat.picks.some(p => (p.tag || p.model_id || p.id || p.file) === modelId || p.id === modelId)) {
      return key;
    }
  }
  return 'chat';
}

// "Can this model natively read images?" — used to decide whether the vision
// bridge (caption-with-a-local-VL-model-first) is needed at all.
//
// Two sources, because the catalogs disagree in vocabulary: models.json marks
// its vision routers with `multimodal: true`, while download-catalog marks
// natively-multimodal models with a `vision` tag. A downloaded Gemma 3 or
// Qwen3-VL can see images directly, so captioning it first would be pure loss.
function isMultimodal(modelId) {
  const pick = findPick(modelId);
  if (!pick) return false;
  return !!pick.multimodal || (pick.tags || []).includes('vision');
}

// Whether a model's quality-of-tool-calling is good enough to expose web tools
// in the UI. Small models (Llama 3.2 3B) and vision-only models tend to emit
// malformed tool calls. Picks default to capable; set tools_capable=false in
// models.json to opt out.
function modelSupportsTools(modelId) {
  const pick = findPick(modelId);
  if (!pick) return false;
  return pick.tools_capable !== false;
}

// Whether the model has a "thinking" mode — Ollama models with a native
// switches (Ollama) or adaptive thinking (Anthropic / Google). The catalog
// pick opts in via `thinking_capable: true`.
function modelSupportsThinking(modelId) {
  const pick = findPick(modelId);
  return !!pick?.thinking_capable;
}

// Picks a vision router matched to the active text-only chat model:
// smart text models get the bigger vision model so quality is paired,
// the small text model gets the smaller vision model so latency stays low.
const VISION_ROUTING = {
  'qwen3:30b-a3b': ['llama3.2-vision:11b', 'qwen2.5vl:7b'],
  'llama3.3:70b':  ['llama3.2-vision:11b', 'qwen2.5vl:7b'],
  'llama3.2:3b':   ['qwen2.5vl:7b',        'llama3.2-vision:11b']
};

function getVisionRouter(chatModel) {
  const preference = VISION_ROUTING[chatModel] || ['qwen2.5vl:7b', 'llama3.2-vision:11b'];
  for (const tag of preference) {
    if (state.installed.has(tag)) return tag;
  }
  return null;
}

// Friendly display name for a model tag — pulled from the catalog so the
// routing badge can show "Routed to Qwen2.5-VL 7B" not "qwen2.5vl:7b".
function prettyModelName(tag) {
  for (const cat of Object.values(state.catalog?.categories || {})) {
    const pick = (cat.picks || []).find(p => p.tag === tag);
    if (pick) return pick.name;
  }
  return tag;
}

const VISION_ROUTE_PROMPT = 'Describe this image in detail for someone who cannot see it. Include any visible text verbatim (do OCR). Mention spatial layout, colors, notable objects, expressions, and anything else needed to answer detailed questions about it. Be thorough but objective — no speculation.';

async function runVisionCaption(model, base64) {
  let acc = '';
  await window.api.ollama.chat({
    model,
    messages: [{ role: 'user', content: VISION_ROUTE_PROMPT }],
    images: [base64]
  }, (chunk) => {
    if (chunk.message?.content) acc += chunk.message.content;
  });
  return acc.trim();
}

// =========================================================================
// VIDEO ANALYSIS PIPELINE
// =========================================================================
// User attaches a video → we run two parallel chains:
//   A) ffmpeg extract frames @ 2 fps + 16 kHz mono WAV
//   B) Whisper transcribes the WAV with timestamps
// Then we perceptual-hash the frames, collapse near-identical sequences
// down to one representative each, vision-caption those, and finally let a
// text model synthesize a unified description from the captions + transcript.
// Per the user's directive, specifics (gender, music genre, etc.) are NOT
// in the synthesis — they're answered on demand in follow-up Q&A.

const VIDEO_FRAME_CAPTION_PROMPT =
  `Describe what is visible in this video frame in 1-2 short sentences. Be concrete and specific:

- **If it looks like a video game, app, website, or software UI — NAME IT by name** if you can (e.g. "Geometry Dash gameplay", "Minecraft survival mode", "VS Code editor", "Photoshop", "YouTube homepage"). Look for characteristic art style, fonts, UI chrome, HUD elements, icons.
- Mention the action, on-screen text (verbatim), HUD numbers (score, time, health), camera angle, and what is happening.
- Note if it's a screen recording vs real-world footage.

No preamble. No "I see" / "this image shows". Just the description.`;

// One-shot "what is this?" prompt run against a single representative frame
// so the synthesis has a hard identification anchor, instead of trying to
// pattern-match across many generic per-frame captions.
const VIDEO_IDENTIFY_PROMPT =
  `What is this an image of? Be SPECIFIC and DIRECT — if it's a video game, name the game. If it's an app or website, name it. If it's a screen recording of software, name the software. If it's real-world footage, describe the setting. One sentence only. No "this image shows", no hedging.

Examples of good answers:
- "Geometry Dash — bright neon level with a square cube character mid-jump near spike obstacles."
- "Minecraft survival mode — first-person view inside a wooden house at night."
- "VS Code editor with a TypeScript file open."
- "Real-world handheld footage of a city street at dusk."`;

const VIDEO_SYNTHESIS_PROMPT_TEMPLATE = (meta) => `You are summarising a video the user shared. You have ONLY:

- An identification line from a vision model (one frame)
- A timeline of per-frame captions
- An audio transcript

# ABSOLUTE RULES — NO HALLUCINATION

You must ONLY describe things that are LITERALLY mentioned in the identification, the frame captions, or the transcript below. If something isn't in there, **you do not know it and must not mention it.**

Specifically you must NOT invent:
- HUD elements, health bars, score counters, timers, shields, lives, currency
- Game features, mechanics, level names, character names, items
- Scene events ("the player dodges X", "an asteroid grazes the shield") unless a caption literally says so
- Speech content / topics if the transcript is empty
- Camera angles, zoom changes, music, sound effects, atmosphere

If the captions are vague or repetitive, your description must ALSO be vague and short. **A 1-sentence description is fine.** Padding to 2-4 paragraphs by inventing details is forbidden.

If the captions disagree with the identification, trust the captions.

# OUTPUT FORMAT

Write a grounded description of the video — only as long as the captions support. 1-3 short paragraphs max. No "based on the timeline" / "the frames indicate" phrasing — just describe the video as you understand it.

Then on its own line, output exactly:

---

**Transcript**

Then paste the audio transcript verbatim below (every word that was spoken, in order). If there's no transcript / no speech, write **(no speech detected)** instead. Do not paraphrase the transcript or invent words.

# DATA

IDENTIFICATION (one frame, may be wrong — corroborate with the captions below)
${meta.identity || '(no identification available)'}

VIDEO METADATA
- File: ${meta.filename}
- Duration: ${meta.durationSec.toFixed(1)} seconds
- ${meta.frames.length} representative frames after dedup (from ${meta.totalFrames} extracted)
- Transcript language: ${meta.language || 'n/a'}
- Has audible speech: ${meta.hasSpeech ? 'yes' : 'no'}

VISUAL TIMELINE (every line is a per-frame caption — this is your ground truth)
${meta.frames.map(f => `- ${formatTs(f.timestamp_sec)} — ${f.caption}`).join('\n')}

AUDIO TRANSCRIPT (paste verbatim under the "**Transcript**" heading)
${meta.transcriptText || '(no speech detected)'}
`;

function formatTs(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// Average-hash: scale frame to 16×16 grayscale, threshold against mean → 256-bit hash.
// Cheap, deterministic, and Hamming distance gives a stable "are these the same shot?"
// score. dist <= 12 (out of 256) is effectively identical.
async function perceptualHashFrame(framePath) {
  const r = await window.api.video.readFrame(framePath);
  if (r.error) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      cvs.width = 16; cvs.height = 16;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0, 16, 16);
      const data = ctx.getImageData(0, 0, 16, 16).data;
      const lum = new Array(256);
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += lum[i];
      }
      const mean = sum / 256;
      const bits = new Uint8Array(32);
      for (let i = 0; i < 256; i++) {
        if (lum[i] > mean) bits[i >> 3] |= (1 << (i & 7));
      }
      resolve({ bits, dataUrl: cvs.toDataURL('image/png') });
    };
    img.onerror = () => resolve(null);
    img.src = 'data:image/jpeg;base64,' + r.base64;
  });
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

// Dedup an ordered sequence of frames. Returns a subset where consecutive
// near-identical frames are collapsed to the earliest representative.
async function deduplicateFrames(frames, onProgress) {
  const kept = [];
  let lastHashBits = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const h = await perceptualHashFrame(f.path);
    if (!h) continue;
    onProgress?.({ stage: 'hash', done: i + 1, total: frames.length });
    if (lastHashBits && hammingDistance(lastHashBits, h.bits) <= 12) {
      continue; // collapse: visually similar to the previous kept frame
    }
    lastHashBits = h.bits;
    kept.push({ ...f, hashBits: h.bits, thumbDataUrl: h.dataUrl });
  }
  return kept;
}

// Ask the vision model what the video is, sending two representative frames
// (first + middle) in a single multi-image call. Forces the model to identify
// a subject consistent with BOTH frames — one weird transitional shot can't
// mislead the identification. Returns a short single-sentence identification.
async function identifyVideoContent(frames, visionModel) {
  if (!frames?.length) return '';
  // Two frames: one from the early third (skip title cards / fade-ins) and
  // one from the middle. If only one frame exists, fall back to it alone.
  const firstIdx = Math.min(frames.length - 1, Math.floor(frames.length * 0.2));
  const midIdx   = Math.floor(frames.length / 2);
  const picks = firstIdx === midIdx ? [frames[firstIdx]] : [frames[firstIdx], frames[midIdx]];
  try {
    const images = [];
    for (const f of picks) {
      const r = await window.api.video.readFrame(f.path);
      if (!r.error && r.base64) images.push(r.base64);
    }
    if (!images.length) return '';
    const multiHint = images.length > 1
      ? '\n\nYou are seeing TWO frames from the same video. Your identification must be consistent with both — pick a subject that explains both frames. If they disagree (e.g. one is a title card, one is gameplay), prioritise the more content-rich frame.'
      : '';
    let acc = '';
    await window.api.ollama.chat({
      model: visionModel,
      messages: [{ role: 'user', content: VIDEO_IDENTIFY_PROMPT + multiHint }],
      images
    }, (chunk) => { if (chunk.message?.content) acc += chunk.message.content; });
    return acc.trim().split('\n')[0].slice(0, 240);
  } catch { return ''; }
}

// Caption each unique frame via the installed vision model.
async function captionFrames(frames, visionModel, onProgress) {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    onProgress?.({ stage: 'caption', done: i, total: frames.length });
    try {
      const r = await window.api.video.readFrame(f.path);
      if (r.error) { f.caption = '(frame unreadable)'; continue; }
      let acc = '';
      await window.api.ollama.chat({
        model: visionModel,
        messages: [{ role: 'user', content: VIDEO_FRAME_CAPTION_PROMPT }],
        images: [r.base64]
      }, (chunk) => { if (chunk.message?.content) acc += chunk.message.content; });
      f.caption = acc.trim() || '(no caption)';
    } catch (err) {
      f.caption = '(caption failed: ' + err.message + ')';
    }
  }
  onProgress?.({ stage: 'caption', done: frames.length, total: frames.length });
  return frames;
}

// Find an installed vision-capable model — used to caption frames. Mirrors
// getVisionRouter but doesn't care about routing preferences.
function pickInstalledVisionModel() {
  const visionTags = ['qwen2.5vl:7b', 'llama3.2-vision:11b'];
  return visionTags.find(t => state.installed.has(t)) || null;
}

// Render the "deps missing" UI inside the assistant placeholder bubble.
// Returns true if deps are good to go.
async function ensureVideoDeps(assistantMsg) {
  const deps = await window.api.video.detectDeps();
  if (deps.ffmpeg.found && deps.whisper.found) return { ok: true, deps };
  assistantMsg.videoState = {
    stage: 'deps-missing',
    deps
  };
  saveToStorage();
  renderActiveChat();
  return { ok: false, deps };
}

// Run a dep installer with live progress streaming into the message bubble.
async function installVideoDep(chatId, msgIdx, dep) {
  const c = state.chats[chatId];
  if (!c) return;
  const msg = c.messages[msgIdx];
  if (!msg) return;
  msg.videoState = { stage: 'installing', dep, log: '' };
  renderActiveChat();
  await window.api.video.installDep({ dep }, (chunk) => {
    if (chunk.kind === 'stdout' || chunk.kind === 'stderr' || chunk.kind === 'log') {
      msg.videoState.log = (msg.videoState.log + chunk.text).slice(-4000);
      renderActiveChat();
    }
    if (chunk.done) {
      msg.videoState = { stage: 'install-done', dep, ok: chunk.ok };
      saveToStorage();
      renderActiveChat();
    }
  });
}

// Main orchestrator. Called when the user attaches a video in a
// video-analysis chat. assistantMsg is the placeholder we'll progressively
// update as each pipeline stage runs.
async function runVideoAnalysis(c, videoAtt, assistantMsg) {
  const visionModel = pickInstalledVisionModel();
  if (!visionModel) {
    assistantMsg.content = `I need a vision model installed to read the video frames. Open the model picker (top-right) and install **Qwen2.5-VL 7B** or **Llama 3.2 Vision 11B** — they're at the bottom of the chat picks. Then re-attach the video.`;
    assistantMsg.thinking = false;
    saveToStorage();
    renderActiveChat();
    return;
  }

  // 1) Dep gate
  assistantMsg.videoState = { stage: 'checking-deps' };
  renderActiveChat();
  const depCheck = await ensureVideoDeps(assistantMsg);
  if (!depCheck.ok) {
    assistantMsg.thinking = false;
    return; // UI in the bubble will let user click install
  }

  // 2) Probe
  assistantMsg.videoState = { stage: 'probing', filename: videoAtt.name };
  renderActiveChat();
  const probe = await window.api.video.probe(videoAtt.path);
  if (probe.error) {
    assistantMsg.content = `Couldn't read the video: ${probe.error}`;
    assistantMsg.thinking = false;
    saveToStorage();
    renderActiveChat();
    return;
  }

  // 3) Extract frames + audio
  assistantMsg.videoState = {
    stage: 'extracting', filename: videoAtt.name,
    durationSec: probe.duration_sec || 0,
    framesDone: 0, expectedFrames: 0
  };
  renderActiveChat();
  const extracted = await window.api.video.extract(
    { videoPath: videoAtt.path, chatId: c.id, fps: 2 },
    (chunk) => {
      // Capture the channelId on the first chunk so Stop can abort the
      // ffmpeg subprocess mid-extraction.
      const run = state.runningChats.get(c.id);
      if (run && chunk._channelId) run.videoChannelId = chunk._channelId;
      if (chunk.kind === 'meta') {
        assistantMsg.videoState.expectedFrames = chunk.expectedFrames;
        assistantMsg.videoState.durationSec = chunk.durationSec;
        renderActiveChat();
      } else if (chunk.kind === 'progress' && chunk.stage === 'frames') {
        assistantMsg.videoState.framesDone = chunk.framesDone;
        renderActiveChat();
      } else if (chunk.kind === 'progress' && chunk.stage === 'audio') {
        assistantMsg.videoState.stage = 'extracting-audio';
        renderActiveChat();
      } else if (chunk.kind === 'aborted') {
        assistantMsg.videoState = { stage: 'aborted' };
        assistantMsg.content = '_Stopped._';
        assistantMsg.thinking = false;
        renderActiveChat();
      }
    }
  );
  // Clear video channelId so subsequent stages can register their own.
  const _run = state.runningChats.get(c.id);
  if (_run) _run.videoChannelId = null;
  if (extracted.kind === 'aborted') return;
  if (!extracted.frames?.length) {
    assistantMsg.content = `No frames were extracted from the video. It may be corrupted or use a codec ffmpeg can't read.`;
    assistantMsg.thinking = false;
    saveToStorage();
    renderActiveChat();
    return;
  }

  // 4) Perceptual-hash dedupe
  assistantMsg.videoState = {
    stage: 'dedup',
    filename: videoAtt.name,
    durationSec: extracted.durationSec,
    totalFrames: extracted.frames.length,
    hashDone: 0
  };
  renderActiveChat();
  const uniqueFrames = await deduplicateFrames(extracted.frames, (p) => {
    if (p.stage === 'hash') {
      assistantMsg.videoState.hashDone = p.done;
      renderActiveChat();
    }
  });

  // 5a) Hard-identification pass — one explicit "what is this?" call against
  // a single representative frame. The synthesis later uses this as truth so
  // it doesn't have to pattern-match across vague per-frame captions.
  assistantMsg.videoState.stage = 'identifying';
  renderActiveChat();
  const videoIdentity = await identifyVideoContent(uniqueFrames, visionModel);

  // 5b) Caption each unique frame (parallel with transcription would be nice
  // but local Ollama is single-threaded enough that the gain is marginal —
  // keep this sequential so progress is legible).
  assistantMsg.videoState.stage = 'captioning';
  assistantMsg.videoState.uniqueFrames = uniqueFrames.length;
  assistantMsg.videoState.captionDone = 0;
  renderActiveChat();
  await captionFrames(uniqueFrames, visionModel, (p) => {
    if (p.stage === 'caption') {
      assistantMsg.videoState.captionDone = p.done;
      renderActiveChat();
    }
  });

  // 6) Transcribe audio (if extracted)
  let transcript = null;
  if (extracted.audioPath) {
    assistantMsg.videoState.stage = 'transcribing';
    renderActiveChat();
    const tr = await window.api.video.transcribe(
      { audioPath: extracted.audioPath, model: 'tiny' },
      (chunk) => {
        const run = state.runningChats.get(c.id);
        if (run && chunk._channelId) run.videoChannelId = chunk._channelId;
        if (chunk.kind === 'log') {
          assistantMsg.videoState.transcribeLog = (assistantMsg.videoState.transcribeLog || '') + chunk.text;
          renderActiveChat();
        } else if (chunk.kind === 'aborted') {
          assistantMsg.videoState = { stage: 'aborted' };
          assistantMsg.content = '_Stopped._';
          assistantMsg.thinking = false;
          renderActiveChat();
        }
      }
    );
    const _run2 = state.runningChats.get(c.id);
    if (_run2) _run2.videoChannelId = null;
    if (tr.kind === 'aborted') return;
    transcript = tr.transcript;
  }

  // 7) Synthesize the high-level summary via the chat model
  assistantMsg.videoState.stage = 'synthesizing';
  renderActiveChat();
  const hasSpeech = !!(transcript?.text && transcript.text.trim().length > 4);
  const synthMeta = {
    filename: videoAtt.name,
    durationSec: extracted.durationSec,
    totalFrames: extracted.frames.length,
    frames: uniqueFrames.map(f => ({ timestamp_sec: f.timestamp_sec, caption: f.caption })),
    language: transcript?.language || null,
    hasSpeech,
    transcriptText: hasSpeech ? transcript.text : '',
    identity: videoIdentity
  };
  const synthSystem = VIDEO_SYNTHESIS_PROMPT_TEMPLATE(synthMeta);
  let summary = '';
  await window.api.ollama.chat({
    model: c.model,
    messages: [
      { role: 'system', content: synthSystem },
      { role: 'user',   content: 'Please produce the summary now.' }
    ],
    options: { num_ctx: 8192 }
  }, (chunk) => { if (chunk.message?.content) summary += chunk.message.content; });

  // 8) Persist everything on the chat so follow-up Q&A can use it.
  c.videoAnalysis = {
    videoPath: videoAtt.path,
    filename: videoAtt.name,
    durationSec: extracted.durationSec,
    visionModel,
    transcript: transcript || null,
    frames: uniqueFrames.map(f => ({
      timestamp_sec: f.timestamp_sec,
      path: f.path,
      thumbDataUrl: f.thumbDataUrl,
      caption: f.caption
    })),
    totalFrames: extracted.frames.length,
    hasSpeech,
    language: transcript?.language || null,
    identity: videoIdentity
  };
  assistantMsg.content = summary.trim() || '_(no summary returned by model)_';
  assistantMsg.thinking = false;
  assistantMsg.videoState = { stage: 'done' };
  saveToStorage();
  renderActiveChat();
  renderChatList();
}

// Render the in-bubble progress / dep-install / state UI for a video
// analysis message. Re-rendered on every saveToStorage during the pipeline.
function renderVideoStateCard(m) {
  const v = m.videoState || {};
  const wrap = document.createElement('div');
  wrap.className = 'video-state video-state-' + v.stage;

  if (v.stage === 'checking-deps') {
    wrap.innerHTML = `<div class="video-state-row"><span class="video-spinner"></span> Checking ffmpeg + whisper…</div>`;
    return wrap;
  }
  if (v.stage === 'deps-missing') {
    const d = v.deps;
    const dep = (name, label, blurb, found) => `
      <div class="video-dep ${found ? 'ok' : 'missing'}">
        <div class="video-dep-head">
          <span class="video-dep-status">${found ? '✓' : '✗'}</span>
          <strong>${label}</strong>
        </div>
        <p>${blurb}</p>
        ${found
          ? `<span class="video-dep-version">${escapeHtml(d[name].version || '')}</span>`
          : `<button type="button" class="video-dep-install" data-vid-action="install-dep" data-dep="${name}">Install</button>`}
      </div>`;
    wrap.innerHTML = `
      <h3 class="video-state-title">Video Analysis needs two tools</h3>
      <p class="video-state-sub">First-time setup. After this is done, you can analyse any video.</p>
      <div class="video-dep-grid">
        ${dep('ffmpeg', 'ffmpeg', 'Used to extract frames and audio from the video. ~50 MB, installed via winget.', d.ffmpeg.found)}
        ${dep('whisper', 'OpenAI Whisper', 'Local speech-to-text. Runs in Python; ~140 MB for the tiny model. Installed via pip.', d.whisper.found)}
      </div>`;
    return wrap;
  }
  if (v.stage === 'installing') {
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> Installing <strong>${escapeHtml(v.dep)}</strong>…</div>
      <pre class="video-install-log">${escapeHtml((v.log || '').slice(-1500))}</pre>`;
    return wrap;
  }
  if (v.stage === 'install-done') {
    wrap.innerHTML = `
      <div class="video-state-row">${v.ok ? '✓' : '✗'} <strong>${escapeHtml(v.dep)}</strong> ${v.ok ? 'installed' : 'install failed'}</div>
      ${v.ok ? `<button type="button" class="video-dep-install" data-vid-action="retry-after-install">Continue analysis</button>` : ''}`;
    return wrap;
  }
  if (v.stage === 'probing') {
    wrap.innerHTML = `<div class="video-state-row"><span class="video-spinner"></span> Reading <strong>${escapeHtml(v.filename || '')}</strong>…</div>`;
    return wrap;
  }
  if (v.stage === 'extracting' || v.stage === 'extracting-audio') {
    const pct = v.expectedFrames ? Math.min(100, Math.round((v.framesDone / v.expectedFrames) * 100)) : 0;
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> ${v.stage === 'extracting-audio' ? 'Extracting audio' : 'Extracting frames'} · <strong>${v.framesDone || 0}</strong> / ${v.expectedFrames || '?'}</div>
      <div class="video-progress"><div class="video-progress-bar" style="width:${pct}%"></div></div>
      <div class="video-state-sub">${v.durationSec ? v.durationSec.toFixed(1) + 's video · sampling at 2 fps' : ''}</div>`;
    return wrap;
  }
  if (v.stage === 'dedup') {
    const pct = v.totalFrames ? Math.round((v.hashDone / v.totalFrames) * 100) : 0;
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> Deduplicating frames · <strong>${v.hashDone}</strong> / ${v.totalFrames}</div>
      <div class="video-progress"><div class="video-progress-bar" style="width:${pct}%"></div></div>`;
    return wrap;
  }
  if (v.stage === 'identifying') {
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> Identifying what's in the video…</div>`;
    return wrap;
  }
  if (v.stage === 'captioning') {
    const pct = v.uniqueFrames ? Math.round((v.captionDone / v.uniqueFrames) * 100) : 0;
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> Describing <strong>${v.uniqueFrames}</strong> unique frames · ${v.captionDone}/${v.uniqueFrames}</div>
      <div class="video-progress"><div class="video-progress-bar" style="width:${pct}%"></div></div>
      <div class="video-state-sub">Each frame goes through the vision model — ~5–15 s per frame on local hardware.</div>`;
    return wrap;
  }
  if (v.stage === 'transcribing') {
    wrap.innerHTML = `
      <div class="video-state-row"><span class="video-spinner"></span> Transcribing audio with Whisper…</div>
      <div class="video-state-sub">First run downloads the ~140 MB tiny model. Later runs are fast.</div>`;
    return wrap;
  }
  if (v.stage === 'synthesizing') {
    wrap.innerHTML = `<div class="video-state-row"><span class="video-spinner"></span> Synthesising the summary…</div>`;
    return wrap;
  }
  return wrap;
}

// Strip of frame thumbnails the user can click to ask about a moment.
function renderVideoTimeline(va) {
  const strip = document.createElement('div');
  strip.className = 'video-timeline';
  const head = document.createElement('div');
  head.className = 'video-timeline-head';
  head.innerHTML = `
    <span><strong>${escapeHtml(va.filename)}</strong> · ${va.durationSec.toFixed(1)}s · ${va.frames.length} keyframes</span>
    <span class="video-timeline-hint">Click a thumbnail to ask about that moment</span>`;
  strip.appendChild(head);
  const row = document.createElement('div');
  row.className = 'video-timeline-row';
  for (const f of va.frames) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'video-timeline-cell';
    cell.dataset.vidAction = 'ask-about-moment';
    cell.dataset.ts = String(f.timestamp_sec);
    cell.title = `${formatTs(f.timestamp_sec)} — ${f.caption}`;
    cell.innerHTML = `
      <img src="${f.thumbDataUrl}" alt="">
      <span class="video-timeline-ts">${formatTs(f.timestamp_sec)}</span>`;
    row.appendChild(cell);
  }
  strip.appendChild(row);
  return strip;
}

// Build the context block injected into history for every Q&A turn after
// analysis. Includes a compact timeline + transcript so the model can answer
// questions about any moment without us re-querying the vision model.
function buildVideoContext(c) {
  const v = c.videoAnalysis;
  if (!v) return null;
  const tx = v.transcript;
  const segs = tx?.segments || [];
  const transcriptBlock = segs.length
    ? segs.map(s => `  [${formatTs(s.start)} → ${formatTs(s.end)}] ${s.text}`).join('\n')
    : '  (no speech detected — audio may be music, silence, or non-speech sound)';
  const framesBlock = v.frames.map(f => `  [${formatTs(f.timestamp_sec)}] ${f.caption}`).join('\n');
  return `You are answering questions about a video the user shared. You have full timeline data below — refer to it directly. If the user asks about a specific moment ("at 0:42", "the second half", etc.) cite the timestamp.

IDENTIFIED SUBJECT (treat as ground truth, came from a vision model looking at a real frame): ${v.identity || '(none)'}

If the user asks "what game/app/site is this", reproduce the identification above directly. Don't say you're unsure unless the identification literally says "unknown".

When the user asks WHAT the video is about, what game/app/site is in it, or similar identification questions: read the frame descriptions and PATTERN-MATCH across them. If many frames describe Geometry Dash, say "Geometry Dash". If many describe Minecraft, say "Minecraft". Trust your reading of the captions even though you can't see the pixels directly — the captioner already named what it saw.

If the user asks about specifics like speaker gender, music vs speech, language — use only what you can infer from the data; say "uncertain" rather than guessing.

Important behavioural rules:
- Do NOT pro-actively mention speaker gender, music genre, or other granular specifics unless the user asks.
- For gender: infer from the transcript's wording / voice cues you can see in captions, OR say "I'd need to inspect the audio more carefully to tell — want me to?"
- For music presence/type: rely on the transcript-empty signal and frame captions. Don't invent a genre.
- Never say "the video shows static frames" or "only timeline data is available" — that's describing the shape of your data, not the video. Talk about what the captions describe.

VIDEO: ${v.filename} (${v.durationSec.toFixed(1)} s, ${v.frames.length} frames after dedup)
${v.language ? `Detected transcript language: ${v.language}` : ''}

VISUAL TIMELINE
${framesBlock}

AUDIO TRANSCRIPT (timestamped)
${transcriptBlock}
`;
}

function backendForModel(modelId) {
  const m = modalityForModel(modelId);
  return state.catalog?.categories[m]?.backend || 'ollama';
}

function firstAvailableModel() {
  for (const p of allPicks()) {
    if (p.multimodal) continue;            // routers, not user-pickable
    if (p.tag && state.installed.has(p.tag)) return p.tag;
  }
  // No installed model — return the first non-multimodal chat pick.
  const fallback = state.catalog?.categories.chat.picks.find(p => !p.multimodal);
  return fallback?.tag || 'qwen3:30b-a3b';
}

// ============== STATUS ==============
async function refreshOllama() {
  const res = await window.api.ollama.list();
  const pill = $('#ollama-pill'), val = $('#ollama-val');
  if (res.error) {
    pill.classList.remove('up'); val.textContent = 'offline';
    state.installed = new Set();
    state.ollamaRunning = false;
    // If we haven't proven Ollama is installed yet, re-probe — picks up an
    // install that happened while Sanctum was already open.
    if (!state.ollamaDetected) {
      try {
        const det = await window.api.ollama.detect();
        state.ollamaDetected = !!det.installed;
      } catch {}
    }
  } else {
    pill.classList.add('up');
    state.installed = new Set((res.models || []).map(m => m.name));
    val.textContent = `${state.installed.size} ready`;
    state.ollamaRunning = true;
    // A live `/api/tags` response means Ollama is installed AND running.
    // This bumps the banner from "Install Ollama" to gone, immediately, if
    // the user installed it from outside the app.
    state.ollamaDetected = true;
  }
  populateModelPicker();
  renderInstallBanner();
}

async function detectOllama() {
  try {
    const res = await window.api.ollama.detect();
    state.ollamaDetected = !!res.installed;
    state.ollamaRunning  = !!res.running;
  } catch {
    state.ollamaDetected = false;
    state.ollamaRunning = false;
  }
  renderInstallBanner();
}

// ============== SIDEBAR ==============
function wireSidebar() {
  $('#new-chat').addEventListener('click', () => createChat());
  $('#new-project')?.addEventListener('click', () => createAgenticChat());
  $('#space-toggle')?.addEventListener('click', () =>
    switchSpace(state.space === 'code' ? 'home' : 'code'));
  $('#open-downloads')?.addEventListener('click', () => openDownloads());
  $('#open-settings').addEventListener('click', () => openSettings());

  // Sidebar collapse — persisted across sessions via state.settings.
  const toggleBtn = $('#sidebar-toggle');
  const app = document.querySelector('.app');
  if (toggleBtn && app) {
    if (state.settings.sidebarCollapsed) {
      app.classList.add('sidebar-collapsed');
      toggleBtn.title = 'Show sidebar';
      toggleBtn.setAttribute('aria-label', 'Show sidebar');
    }
    toggleBtn.addEventListener('click', () => {
      const collapsed = app.classList.toggle('sidebar-collapsed');
      state.settings.sidebarCollapsed = collapsed;
      saveSettings();
      toggleBtn.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
      toggleBtn.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
    });
  }
}

function wireAgentBar() {
  const simpleToggle = (btnId, fieldName) => {
    const btn = $(`#${btnId}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const c = currentChat();
      if (!c || c.modality !== 'agent') return;
      c[fieldName] = !c[fieldName];
      btn.setAttribute('aria-pressed', c[fieldName] ? 'true' : 'false');
      saveToStorage();
    });
  };

  // Plan / Approval / No-Approval are mutually exclusive AND required: exactly
  // ONE is always on. Clicking the active mode is a no-op (no "off" state) —
  // the agent must be in some safety posture. Clicking an inactive mode
  // switches to it and turns the others off. Initial default = Plan.
  const mutexToggle = (btnId, fieldName, opposing) => {
    const btn = $(`#${btnId}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const c = currentChat();
      if (!c || c.modality !== 'agent') return;
      if (c[fieldName]) return; // already on — clicking again would deselect
      c[fieldName] = true;
      btn.setAttribute('aria-pressed', 'true');
      for (const o of opposing) {
        c[o.field] = false;
        const oBtn = $(`#${o.btnId}`);
        if (oBtn) oBtn.setAttribute('aria-pressed', 'false');
      }
      saveToStorage();
    });
  };
  mutexToggle('toggle-plan',        'planMode',     [{field: 'approvalMode', btnId: 'toggle-approval'},   {field: 'noApproval',   btnId: 'toggle-noapproval'}]);
  mutexToggle('toggle-approval',    'approvalMode', [{field: 'planMode',     btnId: 'toggle-plan'},       {field: 'noApproval',   btnId: 'toggle-noapproval'}]);
  mutexToggle('toggle-noapproval',  'noApproval',   [{field: 'planMode',     btnId: 'toggle-plan'},       {field: 'approvalMode', btnId: 'toggle-approval'}]);
  simpleToggle('toggle-readonly', 'readOnly');
  simpleToggle('toggle-nofetch',  'noFetch');

  const more = $('#open-agent-opts');
  if (more) more.addEventListener('click', openAgentOpts);

  // Wire the folder chip in the agent bar and the "Choose folder" buttons.
  const folderChip = $('#agent-folder-chip');
  if (folderChip) folderChip.addEventListener('click', pickProjectFolder);
  const folderNeededBtn = $('#folder-needed-pick');
  if (folderNeededBtn) folderNeededBtn.addEventListener('click', pickProjectFolder);
}

// ============== AGENT OPTIONS MODAL ==============
function wireAgentOpts() {
  const overlay = $('#agent-opts-overlay');
  if (!overlay) return;

  const close = $('#agent-opts-close');
  close.addEventListener('click', closeAgentOpts);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAgentOpts(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeAgentOpts(); });

  let saveTimer;
  const debouncedSave = () => {
    clearTimeout(saveTimer);
    $('#agent-opts-saved').classList.remove('visible');
    saveTimer = setTimeout(() => {
      saveAgentOpts();
      $('#agent-opts-saved').classList.add('visible');
      setTimeout(() => $('#agent-opts-saved').classList.remove('visible'), 1400);
    }, 350);
  };
  $('#agent-opts-paths').addEventListener('input', debouncedSave);
  $('#agent-opts-cmds').addEventListener('input', debouncedSave);
  $('#agent-opts-steps').addEventListener('input', debouncedSave);
  $('#agent-opts-ctx').addEventListener('input', debouncedSave);
  $('#agent-opts-open-log').addEventListener('click', () => window.api.audit.open());
}

async function openAgentOpts() {
  const c = currentChat();
  if (!c || c.modality !== 'agent') return;
  $('#agent-opts-chat-title').textContent = c.title || 'New chat';
  $('#agent-opts-paths').value = (c.pathAllowlist || []).join('\n');
  $('#agent-opts-cmds').value = (c.commandAllowlist || []).join('\n');
  $('#agent-opts-steps').value = c.maxSteps || 5;
  $('#agent-opts-ctx').value = c.contextWindow || 8192;
  try { $('#agent-opts-log-path').textContent = await window.api.audit.path(); }
  catch { $('#agent-opts-log-path').textContent = '(could not resolve path)'; }
  $('#agent-opts-overlay').hidden = false;
}

function closeAgentOpts() {
  saveAgentOpts();
  $('#agent-opts-overlay').hidden = true;
}

function saveAgentOpts() {
  const c = currentChat();
  if (!c) return;
  const splitLines = (s) => s.split('\n').map(l => l.trim()).filter(Boolean);
  c.pathAllowlist    = splitLines($('#agent-opts-paths').value);
  c.commandAllowlist = splitLines($('#agent-opts-cmds').value);
  const steps = parseInt($('#agent-opts-steps').value, 10);
  c.maxSteps = (Number.isFinite(steps) && steps > 0) ? Math.min(steps, 50) : 5;
  const ctx = parseInt($('#agent-opts-ctx').value, 10);
  c.contextWindow = (Number.isFinite(ctx) && ctx >= 2048) ? Math.min(ctx, 131072) : 8192;
  saveToStorage();
}

// A chat belongs to the Code workspace iff it's agentic; everything else is a
// Home chat. This is the single source of truth for the space split.
function chatSpace(c) { return c?.modality === 'agent' ? 'code' : 'home'; }

// Chats in the currently-active workspace, newest-first order preserved.
function chatsInCurrentSpace() {
  return state.order.map(id => state.chats[id]).filter(c => c && chatSpace(c) === state.space);
}

// Switch workspace: update the sidebar chrome, filter the chat list, and move
// the active chat to one that belongs to the new space (or none, which shows
// that space's empty state).
function switchSpace(space) {
  if (space !== 'home' && space !== 'code') return;
  // Remember the model you were just on so the switch doesn't change it.
  const prevModel = currentChat()?.model || state.settings.lastModel;
  state.space = space;
  // If we're parked on a view (Downloads/Settings), come back to the chat view
  // so the workspace switch is actually visible.
  switchView('chat');
  applySpaceChrome();
  const inSpace = chatsInCurrentSpace();
  const active = currentChat();
  if (!active || chatSpace(active) !== space) {
    state.activeId = inSpace[0]?.id || null;
  }
  // Carry your model across the switch. If the now-active chat is a fresh one
  // (no messages yet), adopt the model you were just using — switching
  // workspaces should never silently change your selected model. A chat with
  // real messages keeps its own model; that's a deliberate thread.
  const now = currentChat();
  if (now && prevModel && now.messages.length === 0 && findPick(prevModel)) {
    now.model = prevModel;
  }
  state.pendingAttachments = [];
  renderAttachments();
  saveToStorage();
  renderChatList();
  renderActiveChat();
}

// Reflect the current workspace in the sidebar: the toggle label/title and
// which "new" button is shown.
function applySpaceChrome() {
  const code = state.space === 'code';
  const label = $('#space-toggle-label');
  const btn = $('#space-toggle');
  if (label) label.textContent = code ? 'Home' : 'Code';
  if (btn) {
    btn.title = code ? 'Back to your normal chats' : 'Open the Code workspace';
    btn.classList.toggle('in-code', code);
  }
  const newChat = $('#new-chat');
  const newProject = $('#new-project');
  if (newChat) newChat.hidden = code;
  if (newProject) newProject.hidden = !code;
}

function renderChatList() {
  const list = $('#chat-list');
  if (!list) return;
  list.innerHTML = '';
  const groups = groupChatsByDate(chatsInCurrentSpace());
  for (const [label, chats] of groups) {
    const header = document.createElement('div');
    header.className = 'list-header';
    header.textContent = label;
    list.appendChild(header);
    for (const c of chats) {
      const item = document.createElement('button');
      item.className = 'chat-item' + (c.id === state.activeId ? ' active' : '');
      const modalityBadge = c.modality ? `<span class="chat-modality">${shortModality(c.modality)}</span>` : '';
      item.innerHTML = `
        <span class="chat-title">${escapeHtml(c.title || 'New chat')}</span>
        ${modalityBadge}
        <span class="chat-del" title="Delete">×</span>
      `;
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('chat-del')) {
          e.stopPropagation();
          deleteChat(c.id);
        } else {
          setActive(c.id);
        }
      });
      list.appendChild(item);
    }
  }
}

function groupChatsByDate(chats) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400_000;
  const weekAgo = today - 7 * 86400_000;
  const monthAgo = today - 30 * 86400_000;
  const buckets = { Today: [], Yesterday: [], 'Previous 7 days': [], 'Previous 30 days': [], Older: [] };
  for (const c of chats) {
    const t = c.updatedAt || c.createdAt;
    if (t >= today) buckets.Today.push(c);
    else if (t >= yesterday) buckets.Yesterday.push(c);
    else if (t >= weekAgo) buckets['Previous 7 days'].push(c);
    else if (t >= monthAgo) buckets['Previous 30 days'].push(c);
    else buckets.Older.push(c);
  }
  return Object.entries(buckets).filter(([_, v]) => v.length);
}

function shortModality(m) {
  return ({ chat: 'chat', vision: 'chat', image: 'image', video: 'video', code: 'code', agent: 'agent' })[m] || m;
}

// ============== VIEW SWITCH ==============
function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
}
// ============== DOWNLOAD TAB ==============
// Filters are multi-select and AND together — pick "Thinking" + "Web search"
// to get models that do both. 'all' and 'runnable' are special (see below);
// the rest match a tag on the model. Labels are phrased the way a user thinks
// about the feature: "Thinking" for the reasoning tag, "Web search" for tool
// use (web search is the headline tool).
const DL_FILTERS = [
  { key: 'runnable',    label: 'Runs on this machine' },
  { key: 'text',        label: 'Text' },
  { key: 'code',        label: 'Code' },
  { key: 'vision',      label: 'Vision' },
  { key: 'reasoning',   label: 'Thinking' },
  { key: 'tools',       label: 'Web search' },
  { key: 'tiny',        label: 'Tiny' },
  { key: 'abliterated', label: 'Abliterated' },
  { key: 'uncensored',  label: 'Uncensored' }
];

function renderHwBar() {
  const el = $('#hw-bar');
  if (!el) return;
  const hw = state.hardware;
  if (!hw) { el.innerHTML = `<div class="hw-probing">Checking your hardware…</div>`; return; }

  // Build the chip list, de-duplicating identical entries. On Apple Silicon
  // the CPU and GPU are the same chip, so os.cpus() and system_profiler both
  // report e.g. "Apple M2" — which showed up as two identical chips. When the
  // GPU name matches (or is contained in) the CPU name, collapse to one.
  const chips = [];
  const cpu = (hw.cpuModel || '').trim();
  const gpuName = (hw.gpuName || '').trim();
  if (cpu) chips.push(cpu);
  if (gpuName) {
    const dupOfCpu = cpu && (gpuName === cpu || cpu.includes(gpuName) || gpuName.includes(cpu));
    if (!dupOfCpu) chips.push(`${gpuName}${hw.vramGB ? ` · ${hw.vramGB} GB VRAM` : ''}`);
    else if (hw.vramGB) chips.push(`${hw.vramGB} GB VRAM`);
  } else if (hw.budgetSource === 'ram') {
    chips.push('No dedicated GPU');
  }
  chips.push(`${hw.totalRamGB} GB RAM`);

  const basis = hw.budgetSource === 'vram'
    ? `Models up to <strong>${hw.fastBudgetGB} GB</strong> run at full speed on the GPU. Larger ones spill into system RAM and slow down; the ceiling is about <strong>${hw.maxBudgetGB} GB</strong>.`
    : hw.budgetSource === 'unified'
      ? `Unified memory — about <strong>${hw.fastBudgetGB} GB</strong> is usable for models.`
      : `No GPU offload, so models run on the CPU. Usable ceiling is about <strong>${hw.maxBudgetGB} GB</strong>.`;

  el.innerHTML = `
    <div class="hw-head">
      ${chips.map(ch => `<span class="hw-chip">${escapeHtml(ch)}</span>`).join('')}
    </div>
    <p class="hw-note">${basis}</p>
  `;
}

// The signature element: a memory bar showing this model's footprint against
// the machine's real budget. Makes "will it fit" a thing you see, not read.
function fitMeter(model, hw) {
  if (!hw || model.cloudOnly) return '';
  const need = modelFootprintGB(model, 4096);
  const scale = Math.max(hw.fastBudgetGB, Math.min(need, hw.maxBudgetGB));
  const pct = Math.min(100, (need / scale) * 100);
  const gpuMark = hw.budgetSource === 'vram' && hw.fastBudgetGB < scale
    ? `<span class="fm-mark" style="left:${(hw.fastBudgetGB / scale) * 100}%" title="${hw.vramGB} GB VRAM"></span>` : '';
  const f = fitFor(model, hw);
  return `
    <div class="fit-meter ${f.verdict}">
      <div class="fm-track">
        <div class="fm-fill" style="width:${pct}%"></div>
        ${gpuMark}
      </div>
      <div class="fm-legend">${need.toFixed(1)} GB needed</div>
    </div>
  `;
}

function renderDownloadTab() {
  const list = $('#dl-list');
  if (!list) return;
  renderHwBar();

  const active = state.dlFilters || (state.dlFilters = new Set());
  const filters = $('#dl-filters');
  if (filters) {
    const chips = DL_FILTERS.map(f =>
      `<button class="dl-chip${active.has(f.key) ? ' active' : ''}" data-filter="${f.key}">${escapeHtml(f.label)}</button>`
    ).join('');
    // An "All" chip clears every filter; it's active only when nothing else is.
    filters.innerHTML = `<button class="dl-chip${active.size === 0 ? ' active' : ''}" data-filter="__all">All</button>` + chips;
    if (!filters.dataset.wired) {
      filters.dataset.wired = '1';
      filters.addEventListener('click', (e) => {
        const btn = e.target.closest('.dl-chip');
        if (!btn) return;
        const key = btn.dataset.filter;
        if (key === '__all') active.clear();
        else if (active.has(key)) active.delete(key);
        else active.add(key);
        renderDownloadTab();
      });
    }
  }
  const search = $('#dl-search');
  if (search && !search.dataset.wired) {
    search.dataset.wired = '1';
    search.addEventListener('input', () => { state.dlQuery = search.value.trim().toLowerCase(); renderDownloadTab(); });
  }

  const hw = state.hardware;
  const q = state.dlQuery || '';
  let models = (state.downloadCatalog?.models || []).filter(m => {
    if (q && !(`${m.name} ${m.tag} ${m.blurb}`.toLowerCase().includes(q))) return false;
    // AND every active filter. 'runnable' is a fit check; the rest are tags.
    for (const f of active) {
      if (f === 'runnable') { if (hw && fitFor(m, hw).verdict === 'unrunnable') return false; }
      else if (!(m.tags || []).includes(f)) return false;
    }
    return true;
  });

  // Runnable first, then biggest-usable first — the models worth their
  // download time float to the top on this specific machine.
  const rank = { good: 0, tight: 1, unknown: 2, unrunnable: 3, cloud: 4 };
  models.sort((a, b) => {
    const d = rank[fitFor(a, hw).verdict] - rank[fitFor(b, hw).verdict];
    return d !== 0 ? d : b.sizeGB - a.sizeGB;
  });

  const countEl = $('#dl-search-count');
  if (countEl) {
    const total = (state.downloadCatalog?.models || []).length;
    countEl.textContent = models.length === total ? `${total}` : `${models.length}/${total}`;
  }

  if (!models.length) {
    list.innerHTML = `<div class="dl-empty">No models match that search.</div>`;
    return;
  }

  list.innerHTML = models.map(m => {
    const f = fitFor(m, hw);
    const ctx = recommendedCtx(m, hw);
    const installed = state.installed.has(m.tag);
    const pulling = state.pulling.has(m.tag);
    const tagChips = (m.tags || []).map(t => `<span class="dl-tag t-${t}">${escapeHtml(t)}</span>`).join('');
    // Cloud-only models have no weights to pull — the Download button would
    // just fail, so offer the pull command for an ollama.com account instead.
    const paused = state.paused.has(m.tag);
    let action;
    if (m.cloudOnly) {
      action = `<span class="dl-cloudnote">Runs on Ollama&nbsp;Cloud</span>`;
    } else if (installed) {
      action = `<div class="dl-have">
           <span class="dl-installed">Installed</span>
           <button class="dl-remove" data-uninstall="${escapeAttr(m.tag)}" title="Uninstall — frees ${fmtGB(m.sizeGB)} of disk">Uninstall</button>
         </div>`;
    } else if (pulling || paused) {
      // Live progress. The bar and label are patched in place by
      // patchDlProgress() rather than re-rendering the whole list on every
      // chunk — Ollama emits progress many times a second.
      const prog = state.pullProgress[m.tag] || { received: 0, total: 0 };
      const pct = Math.round(prog.pct ?? (prog.total ? (prog.received / prog.total) * 100 : 0));
      action = `
        <div class="dl-prog" data-prog-tag="${escapeAttr(m.tag)}">
          <div class="dl-prog-head">
            <span class="dl-prog-pct">${paused ? `Paused · ${pct}%` : `${pct}%`}</span>
            <span class="dl-prog-bytes">${fmtBytes(prog.received)} / ${fmtBytes(prog.total)}</span>
          </div>
          <div class="dl-prog-track"><div class="dl-prog-fill${paused ? ' paused' : ''}" style="width:${pct}%"></div></div>
          <div class="dl-prog-btns">
            <button class="dl-prog-btn" data-pull-toggle="${escapeAttr(m.tag)}" title="${paused ? 'Resume download' : 'Pause download'}">${paused ? 'Resume' : 'Pause'}</button>
            <button class="dl-prog-btn cancel" data-pull-cancel="${escapeAttr(m.tag)}" title="Cancel and delete what's downloaded">Cancel</button>
          </div>
        </div>`;
    } else if (state.pullError && state.pullError.tag === m.tag) {
      // Last pull of this model failed — show why, right on the card.
      action = `
        <div class="dl-failed">
          <span class="dl-failed-msg" title="${escapeAttr(state.pullError.msg)}">${escapeHtml(state.pullError.msg)}</span>
          <button class="dl-get" data-tag="${escapeAttr(m.tag)}">Try again</button>
        </div>`;
    } else {
      action = `<button class="dl-get" data-tag="${escapeAttr(m.tag)}">Download</button>`;
    }
    return `
      <article class="dl-card ${f.verdict}">
        <div class="dl-main">
          <div class="dl-title">
            <h3>${escapeHtml(m.name)}</h3>
            <span class="dl-verdict ${f.verdict}">${escapeHtml(f.label)}</span>
          </div>
          <div class="dl-meta">
            <span class="dl-params">${escapeHtml(m.params)}</span>
            ${m.cloudOnly ? '' : `<span class="dl-size">${fmtGB(m.sizeGB)}</span>`}
            <code class="dl-tagname">${escapeHtml(m.tag)}</code>
          </div>
          <p class="dl-blurb">${escapeHtml(m.blurb)}</p>
        </div>
        <div class="dl-side">
          ${fitMeter(m, hw)}
          <p class="dl-fitnote">${escapeHtml(f.detail)}</p>
          ${ctx ? `<div class="dl-ctx"><span class="dl-ctx-label">Suggested context</span><span class="dl-ctx-val">${fmtCtx(ctx)}</span></div>`
                : `<div class="dl-ctx dim"><span class="dl-ctx-label">Suggested context</span><span class="dl-ctx-val">—</span></div>`}
          ${action}
        </div>
        <div class="dl-tags">${tagChips}</div>
      </article>
    `;
  }).join('');

  if (!list.dataset.wired) {
    list.dataset.wired = '1';
    list.addEventListener('click', async (e) => {
      const get = e.target.closest('.dl-get');
      if (get) {
        // Clear any prior failure for this tag, then kick off the pull and
        // re-render so the card swaps to the progress UI.
        if (state.pullError?.tag === get.dataset.tag) state.pullError = null;
        pullModelInline(get.dataset.tag);
        renderDownloadTab();
        return;
      }
      const toggle = e.target.closest('[data-pull-toggle]');
      if (toggle) {
        const tag = toggle.dataset.pullToggle;
        if (state.paused.has(tag)) pullModelInline(tag);   // resume
        else await pausePull(tag);
        renderDownloadTab();
        return;
      }
      const cancel = e.target.closest('[data-pull-cancel]');
      if (cancel) {
        const tag = cancel.dataset.pullCancel;
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        await cancelPull(tag);
        renderDownloadTab();
        return;
      }
      const rm = e.target.closest('.dl-remove');
      if (rm) {
        const tag = rm.dataset.uninstall;
        if (!confirm(`Uninstall ${tag}?\n\nThis frees the disk space Ollama is using for it. You can download it again any time.`)) return;
        rm.disabled = true;
        rm.textContent = 'Uninstalling…';
        try {
          const res = await window.api.ollama.delete(tag);
          if (res.error) alert(`Uninstall failed: ${res.error}`);
        } catch (err) { alert(`Uninstall failed: ${err.message}`); }
        await refreshOllama();
        renderDownloadTab();
        populateModelPicker();
      }
    });
  }
}

function wireModelsView() {
  // The old Models registry view is gone — Downloads supersedes it (it lists
  // the same models plus 200 more, with hardware fit and uninstall).
  $('#close-downloads')?.addEventListener('click', () => switchView('chat'));
}

// Called when the Downloads view opens. Lazy-loads the big catalog and the
// hardware probe so boot stays fast for people who never open it.
function openDownloads() {
  switchView('downloads');
  if (!state.hardware) {
    window.api.hardware().then(hw => { state.hardware = hw; renderDownloadTab(); });
  }
  renderDownloadTab();
}

// Apply a theme by setting data-theme on <html>. The CSS variable overrides
// inside :root[data-theme="dark"] swap the entire palette. Stored in
// state.settings.theme so it persists across sessions.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme'); // Sanctum is the default :root
}

// ============== SETTINGS ==============
function wireSettings() {
  const overlay = $('#settings-overlay');
  const close = $('#settings-close');
  const textarea = $('#setting-instructions');
  const saved = $('#setting-saved');

  textarea.value = state.settings.instructions || '';

  // API key fields. Stored in localStorage alongside other settings; saved
  // live as the user types (debounced). The picker shows a "needs key"
  // badge when the relevant key is empty, so we refresh it after every save.
  state.settings.apiKeys = state.settings.apiKeys || {};
  const apiSaved = $('#setting-api-saved');
  const wireApiKey = (inputId, revealId, providerKey) => {
    const input = $(`#${inputId}`);
    const reveal = $(`#${revealId}`);
    if (!input) return;
    input.value = state.settings.apiKeys[providerKey] || '';
    let timer;
    input.addEventListener('input', () => {
      state.settings.apiKeys[providerKey] = input.value.trim();
      clearTimeout(timer);
      if (apiSaved) apiSaved.classList.remove('visible');
      timer = setTimeout(() => {
        saveSettings();
        if (apiSaved) {
          apiSaved.classList.add('visible');
          setTimeout(() => apiSaved.classList.remove('visible'), 1500);
        }
        populateModelPicker();
      }, 350);
    });
    if (reveal) {
      reveal.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
      });
    }
  };
  wireApiKey('setting-anthropic-key', 'setting-anthropic-reveal', 'anthropic');
  wireApiKey('setting-google-key',    'setting-google-reveal',    'google');

  // Debug overlay toggle.
  const dbgOn = $('#setting-dbg-enabled');
  if (dbgOn) {
    dbgOn.checked = state.settings.debugOverlay === true;
    dbgOn.addEventListener('change', () => {
      state.settings.debugOverlay = dbgOn.checked;
      saveSettings();
      setDebugOverlay(dbgOn.checked);
    });
  }

  // Freeze protection — pushed to main on every change so the watchdog in the
  // main process reflects the setting immediately.
  state.settings.watchdog = state.settings.watchdog || { enabled: true, tripMs: 15000 };
  const wdOn = $('#setting-wd-enabled');
  const wdSlot = $('#setting-wd-trip-slot');
  const pushWd = () => {
    saveSettings();
    window.api.watchdog?.config({
      enabled: state.settings.watchdog.enabled,
      tripMs: state.settings.watchdog.tripMs
    }).catch(() => {});
  };
  let wdTripSel = null;
  if (wdSlot && !wdSlot.dataset.wired) {
    wdSlot.dataset.wired = '1';
    wdTripSel = buildSelect({
      options: [10000, 15000, 20000, 30000, 45000].map(ms => ({ value: ms, label: `${ms / 1000} seconds` })),
      value: state.settings.watchdog.tripMs || 15000,
      onChange: (v) => { state.settings.watchdog.tripMs = parseInt(v, 10); pushWd(); }
    });
    wdSlot.appendChild(wdTripSel);
    wdTripSel.setDisabled(state.settings.watchdog.enabled === false);
  }
  if (wdOn) {
    wdOn.checked = state.settings.watchdog.enabled !== false;
    wdOn.addEventListener('change', () => {
      state.settings.watchdog.enabled = wdOn.checked;
      wdTripSel?.setDisabled(!wdOn.checked);
      pushWd();
    });
  }

  // Theme picker: reflect current theme + wire clicks
  const themePicker = $('#theme-picker');
  if (themePicker) {
    const validThemes = new Set(['sanctum', 'dark', 'light']);
    const currentTheme = validThemes.has(state.settings.theme) ? state.settings.theme : 'sanctum';
    themePicker.querySelectorAll('.theme-card').forEach(card => {
      card.setAttribute('aria-pressed', card.dataset.theme === currentTheme ? 'true' : 'false');
      card.addEventListener('click', () => {
        const chosen = card.dataset.theme;
        state.settings.theme = chosen;
        applyTheme(chosen);
        themePicker.querySelectorAll('.theme-card').forEach(c =>
          c.setAttribute('aria-pressed', c === card ? 'true' : 'false'));
        saveSettings();
      });
    });
  }

  close.addEventListener('click', () => closeSettings());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeSettings();
  });

  let saveTimer;
  textarea.addEventListener('input', () => {
    state.settings.instructions = textarea.value;
    clearTimeout(saveTimer);
    saved.classList.remove('visible');
    saveTimer = setTimeout(() => {
      saveSettings();
      saved.classList.add('visible');
      setTimeout(() => saved.classList.remove('visible'), 1500);
    }, 350);
  });
}

// ============== CUSTOM SELECT ==============
// Native <select> popups are drawn by the OS — on Windows that means a white
// list no CSS can touch. This renders the menu as real DOM so it inherits
// Sanctum's palette. API mirrors a select: options [{value,label}], a current
// value, and an onChange callback.
function buildSelect({ options, value, onChange, className = '' }) {
  const root = document.createElement('div');
  root.className = `sel ${className}`.trim();
  const current = options.find(o => String(o.value) === String(value)) || options[0];

  root.innerHTML = `
    <button type="button" class="sel-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="sel-val">${escapeHtml(current?.label ?? '')}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="sel-menu" role="listbox" hidden>
      ${options.map(o => `
        <button type="button" class="sel-opt${String(o.value) === String(value) ? ' active' : ''}" role="option"
                data-value="${escapeAttr(String(o.value))}"${o.disabled ? ' disabled' : ''}>
          <span>${escapeHtml(o.label)}</span>
          ${o.note ? `<em class="sel-note">${escapeHtml(o.note)}</em>` : ''}
        </button>`).join('')}
    </div>
  `;

  const btn = root.querySelector('.sel-btn');
  const menu = root.querySelector('.sel-menu');
  const valEl = root.querySelector('.sel-val');

  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey);
  };
  const onDocDown = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  const open = () => {
    if (root.classList.contains('disabled')) return;
    // Flip upward when there isn't room below — long lists near the modal
    // bottom would otherwise render off-screen.
    const spaceBelow = window.innerHeight - btn.getBoundingClientRect().bottom;
    root.classList.toggle('drop-up', spaceBelow < 220);
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    root.classList.add('open');
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
  };

  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.sel-opt');
    if (!opt || opt.disabled) return;
    const v = opt.dataset.value;
    valEl.textContent = options.find(o => String(o.value) === v)?.label ?? '';
    menu.querySelectorAll('.sel-opt').forEach(o => o.classList.toggle('active', o === opt));
    close();
    onChange?.(v);
  });

  root.setDisabled = (d) => {
    root.classList.toggle('disabled', !!d);
    btn.disabled = !!d;
    if (d) close();
  };
  return root;
}

// Per-model context window controls. Lists every INSTALLED Ollama model and
// lets the user pin a context size. Chats read this at send time via
// contextWindowFor(); an unset model falls back to the hardware-aware
// suggestion, then to a safe 8K.
function renderCtxSettings() {
  const list = $('#ctx-list');
  if (!list) return;

  const installed = [...state.installed];
  if (!installed.length) {
    list.innerHTML = `<div class="ctx-empty">No local models installed yet. Pull one from <strong>Models → Download</strong> and it'll show up here.</div>`;
    return;
  }

  const dl = state.downloadCatalog?.models || [];
  const hw = state.hardware;
  state.settings.contextWindows = state.settings.contextWindows || {};

  list.innerHTML = '';
  for (const tag of installed) {
    const meta = dl.find(m => m.tag === tag) || allPicks().find(p => p.tag === tag);
    const name = meta?.name || tag;
    const ctxMax = meta?.ctxMax || meta?.context || 131072;
    const suggested = (meta && meta.kvKbPerTok && hw) ? recommendedCtx(meta, hw) : null;
    const current = state.settings.contextWindows[tag];

    const row = document.createElement('div');
    row.className = 'ctx-row';
    row.innerHTML = `
      <div class="ctx-info">
        <span class="ctx-name">${escapeHtml(name)}</span>
        <code class="ctx-tag">${escapeHtml(tag)}</code>
      </div>
      <div class="ctx-ctl">
        ${suggested ? `<span class="ctx-sug">Suggested: ${fmtCtx(suggested)}</span>` : ''}
      </div>
    `;

    const options = [{ value: '', label: `Auto${suggested ? ` (${fmtCtx(suggested)})` : ''}` }];
    for (const t of CTX_TIERS.filter(t => t <= ctxMax)) {
      options.push({ value: t, label: fmtCtx(t), note: suggested === t ? 'suggested' : '' });
    }
    const sel = buildSelect({
      options,
      value: current ?? '',
      className: 'ctx-select',
      onChange: (v) => {
        if (v) state.settings.contextWindows[tag] = parseInt(v, 10);
        else delete state.settings.contextWindows[tag];
        saveSettings();
      }
    });
    row.querySelector('.ctx-ctl').appendChild(sel);
    list.appendChild(row);
  }
}

// Resolve the context window for a model at send time. Explicit user choice >
// hardware-aware suggestion > conservative 8K default.
function contextWindowFor(tag) {
  const pinned = state.settings.contextWindows?.[tag];
  if (pinned) return pinned;
  const meta = (state.downloadCatalog?.models || []).find(m => m.tag === tag);
  if (meta && state.hardware) {
    const rec = recommendedCtx(meta, state.hardware);
    if (rec) return rec;
  }
  return 8192;
}

function wireSettingsNav() {
  const nav = $('#settings-nav');
  if (!nav || nav.dataset.wired) return;
  nav.dataset.wired = '1';
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.set-nav-btn');
    if (!btn) return;
    const panel = btn.dataset.panel;
    nav.querySelectorAll('.set-nav-btn').forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.set-panel').forEach(p =>
      p.classList.toggle('active', p.dataset.panel === panel));
    if (panel === 'context') {
      // The suggestion column needs hardware + catalog; pull them on demand.
      const done = () => renderCtxSettings();
      if (!state.hardware) window.api.hardware().then(hw => { state.hardware = hw; done(); });
      if (!state.downloadCatalog) window.api.downloadCatalog().then(c => { state.downloadCatalog = c; done(); });
      done();
    }
  });
}

function openSettings() {
  $('#settings-overlay').hidden = false;
  wireSettingsNav();
  $('#setting-instructions').focus();
  renderMcpSettings();
}
function closeSettings() { $('#settings-overlay').hidden = true; }

// ============== MCP SERVER MANAGEMENT ==============
function renderMcpSettings() {
  const list = $('#mcp-list');
  if (!list) return;
  list.innerHTML = '';
  const servers = state.mcpServers || [];
  if (!servers.length) {
    const empty = document.createElement('div');
    empty.className = 'mcp-empty';
    empty.textContent = 'No MCP servers configured. Click "Edit JSON config" to add Blender, Playwright, or any other server.';
    list.appendChild(empty);
    return;
  }
  for (const s of servers) {
    const card = document.createElement('div');
    card.className = `mcp-card mcp-status-${s.status}`;
    const cmdSummary = [s.command, ...(s.args || [])].join(' ');
    const errorBlock = s.error ? `<div class="mcp-error" title="${escapeAttr(s.error)}">${escapeHtml(s.error)}</div>` : '';
    const toolBlock = s.tools && s.tools.length
      ? `<details class="mcp-tools-details"><summary>${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}</summary><ul class="mcp-tools-list">${
          s.tools.map(t => `<li><code>${escapeHtml(t.name)}</code>${t.description ? ` — ${escapeHtml(t.description)}` : ''}</li>`).join('')
        }</ul></details>`
      : '<div class="mcp-tool-count-none">No tools (server not ready)</div>';
    card.innerHTML = `
      <div class="mcp-card-head">
        <div>
          <div class="mcp-name">${escapeHtml(s.name)}</div>
          <div class="mcp-cmd"><code>${escapeHtml(cmdSummary)}</code></div>
        </div>
        <div class="mcp-status-pill">${escapeHtml(s.status)}</div>
      </div>
      ${errorBlock}
      ${toolBlock}
      <div class="mcp-card-actions">
        <button type="button" class="mcp-restart-btn" data-mcp-name="${escapeAttr(s.name)}">Restart</button>
        <button type="button" class="mcp-remove-btn" data-mcp-name="${escapeAttr(s.name)}">Remove</button>
      </div>
    `;
    list.appendChild(card);
  }
  list.querySelectorAll('.mcp-restart-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Restarting…';
      try { state.mcpServers = await window.api.mcp.restart(btn.dataset.mcpName); }
      catch (e) { alert('Restart failed: ' + e.message); }
      state.mcpTools = await window.api.mcp.getTools().catch(() => []);
      renderMcpSettings();
    });
  });
  list.querySelectorAll('.mcp-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove MCP server "${btn.dataset.mcpName}"?`)) return;
      try { state.mcpServers = await window.api.mcp.remove(btn.dataset.mcpName); }
      catch (e) { alert('Remove failed: ' + e.message); }
      state.mcpTools = await window.api.mcp.getTools().catch(() => []);
      renderMcpSettings();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function wireMcpEditor() {
  const editBtn   = $('#mcp-edit-config');
  const overlay   = $('#mcp-editor-overlay');
  const closeBtn  = $('#mcp-editor-close');
  const cancelBtn = $('#mcp-editor-cancel');
  const saveBtn   = $('#mcp-editor-save');
  const textarea  = $('#mcp-editor-text');
  const status    = $('#mcp-editor-status');
  if (!editBtn || !overlay) return;

  const close = () => { overlay.hidden = true; };
  editBtn.addEventListener('click', () => {
    const current = { mcpServers: {} };
    for (const s of (state.mcpServers || [])) {
      current.mcpServers[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
    }
    textarea.value = JSON.stringify(current, null, 2);
    status.textContent = '';
    overlay.hidden = false;
    textarea.focus();
  });
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  saveBtn.addEventListener('click', async () => {
    let parsed;
    try { parsed = JSON.parse(textarea.value); }
    catch (e) { status.textContent = 'Invalid JSON: ' + e.message; status.className = 'mcp-editor-status mcp-status-error'; return; }
    if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object') {
      status.textContent = 'Top-level "mcpServers" object required'; status.className = 'mcp-editor-status mcp-status-error'; return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Applying…';
    status.textContent = '';
    try {
      const existing = new Set((state.mcpServers || []).map(s => s.name));
      const incoming = new Set(Object.keys(parsed.mcpServers));
      // Removals first so a rename frees the old slot before the new add.
      for (const oldName of existing) {
        if (!incoming.has(oldName)) await window.api.mcp.remove(oldName);
      }
      for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
        if (!cfg?.command) { throw new Error(`Server "${name}" needs a "command" string`); }
        await window.api.mcp.add(name, { command: cfg.command, args: cfg.args || [], env: cfg.env || {} });
      }
      state.mcpServers = await window.api.mcp.list();
      state.mcpTools   = await window.api.mcp.getTools();
      status.textContent = 'Saved. Servers starting in the background.';
      status.className = 'mcp-editor-status mcp-status-ok';
      renderMcpSettings();
      setTimeout(close, 800);
    } catch (e) {
      status.textContent = 'Apply failed: ' + e.message;
      status.className = 'mcp-editor-status mcp-status-error';
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save & apply';
    }
  });
}

// ============== MODEL PICKER (custom dropdown) ==============
function wireModelPicker() {
  const trigger = $('#cs-trigger');
  const menu = $('#cs-menu');

  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = menu.hidden;
    setOpen(opening);
    // We deliberately do NOT probe Whisper here — that spawn of python3 fires
    // a "restricted by your administrator" popup on managed Macs every time
    // the picker opens. ensureVideoDeps() still probes when the user actually
    // attaches a video, which is the only point the status matters.
  });

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || trigger.contains(e.target)) return;
    setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false);
  });

  menu.addEventListener('click', (e) => {
    // Download icon click — install without changing selection
    const installBtn = e.target.closest('button[data-action="install-inline"]');
    if (installBtn) {
      e.stopPropagation();
      pullModelInline(installBtn.dataset.tag);
      return;
    }
    const pauseBtn = e.target.closest('button[data-action="pause-inline"]');
    if (pauseBtn) { e.stopPropagation(); pausePull(pauseBtn.dataset.tag); return; }
    const resumeBtn = e.target.closest('button[data-action="resume-inline"]');
    if (resumeBtn) { e.stopPropagation(); resumePull(resumeBtn.dataset.tag); return; }
    const cancelBtn = e.target.closest('button[data-action="cancel-inline"]');
    if (cancelBtn) { e.stopPropagation(); cancelPull(cancelBtn.dataset.tag); return; }
    const uninstallBtn = e.target.closest('button[data-action="uninstall-inline"]');
    if (uninstallBtn) {
      e.stopPropagation();
      const tag = uninstallBtn.dataset.tag;
      if (!confirm(`Uninstall ${tag}?\n\nThis frees the disk blobs Ollama is keeping for this model. You can reinstall it any time from this picker.`)) return;
      (async () => {
        try {
          const res = await window.api.ollama.delete(tag);
          if (res && !res.ok) {
            alert(`Failed to uninstall: ${res.error || 'unknown error'}`);
            return;
          }
          await refreshOllama();
        } catch (err) {
          alert(`Failed to uninstall: ${err.message || err}`);
        }
      })();
      return;
    }

    // Video Analysis section: install ffmpeg / Whisper
    const installVidDep = e.target.closest('button[data-action="install-video-dep"]');
    if (installVidDep) {
      e.stopPropagation();
      installVideoDepFromPicker(installVidDep.dataset.dep);
      return;
    }

    // Item click — select the model
    const item = e.target.closest('.cs-item');
    if (!item) return;
    const value = item.dataset.value;
    if (!value) return;
    const c = currentChat();
    if (!c) return;

    c.model = value;
    // Changing the model must NOT change what kind of chat this is. An agent
    // chat (a Code-workspace project) stays an agent chat no matter which
    // model you pick — otherwise picking a normal model flipped its modality
    // to 'chat', which moved it out of the Code workspace and made it look
    // deleted. Only derive modality for non-agent chats, and never let the
    // 'cloud'/'code' catalog categories (not runtime modes) leak in.
    if (c.modality !== 'agent') {
      const newMod = modalityForModel(value);
      c.modality = (newMod === 'chat' || newMod === 'vision') ? newMod : 'chat';
    }
    // No API key configured? Prompt the user to add one before they try.
    const picked = findPick(value);
    if (picked && pickProvider(picked) !== 'ollama' && !pickReady(picked)) {
      setTimeout(() => openSettings(), 50);
    }

    // Remember this as the last picked model so future new chats default to it.
    state.settings.lastModel = value;
    saveSettings();

    // Silently sync every other EMPTY chat (no messages yet) whose modality
    // matches the new pick. Chats with messages keep their own model — those
    // are explicit threads with the user's intent baked in.
    const newModality = c.modality;
    for (const otherId of state.order) {
      if (otherId === c.id) continue;
      const other = state.chats[otherId];
      if (!other) continue;
      if (other.messages.length > 0) continue; // never overwrite a real thread
      if (other.modality !== newModality) continue;
      other.model = value;
    }

    saveToStorage();
    setOpen(false);
    renderActiveChat();
    renderChatList();
    populateModelPicker();
  });
}

// Only chat & agent are user-selectable as the active model. Vision routers
// and coding-specific picks still appear in the picker so users can install
// them, but clicking the row doesn't change the chat — coding requests
// auto-route to a code model, image attachments auto-route through a vision
// router.
// Categories whose picks the user can select directly. `code` is included:
// coding models used to be reachable only via a silent auto-route, which
// meant you could never deliberately choose one. `vision` stays out because
// its entries are hidden routers for the image bridge, not chat models.
// `installed` holds anything pulled from the Downloads tab.
const SELECTABLE_CATEGORIES = new Set(['chat', 'agent', 'cloud', 'code', 'installed']);

// Returns the provider for a given pick. Default 'ollama' so existing rows
// keep working without a provider field in models.json.
function pickProvider(pick) {
  return pick?.provider || 'ollama';
}

// True when this pick can be used right now (Ollama: model is pulled; cloud:
// API key is set). Drives the "needs install" / "needs API key" badges in
// the picker.
function pickReady(pick) {
  const prov = pickProvider(pick);
  if (prov !== 'ollama') return !!state.settings.apiKeys?.[prov];
  return state.installed.has(pick.tag);
}

// Find the catalog pick for a model id (Ollama tag OR cloud id/model_id).
// Adapt a download-catalog entry into the shape the rest of the app expects
// from a models.json pick. The two catalogs describe capability differently:
// models.json uses explicit booleans, download-catalog uses tags.
//
// NOTE `multimodal` is deliberately NOT set here. In models.json that flag
// means "this is a hidden vision ROUTER, keep it out of the picker" — not
// merely "can see images". Setting it would make every downloaded vision
// model unselectable. Native image support is expressed via the `vision` tag
// and read by isMultimodal().
function downloadPickFor(modelId) {
  const m = (state.downloadCatalog?.models || []).find(x => x.tag === modelId);
  if (!m) return null;
  const tags = m.tags || [];
  return {
    ...m,
    category: 'installed',
    categoryLabel: 'Installed',
    backend: 'ollama',
    context: m.ctxMax,
    tools_capable: tags.includes('tools'),
    thinking_capable: tags.includes('reasoning')
  };
}

// Canonical model lookup. Checks the curated picks (models.json) first, then
// falls back to the full download catalog — otherwise anything pulled from
// the Downloads tab would be invisible to every capability check and to the
// picker itself.
function findPick(modelId) {
  const pick = allPicks().find(p =>
    (p.tag || p.model_id || p.id || p.file) === modelId ||
    p.id === modelId
  );
  return pick || downloadPickFor(modelId);
}

// Refresh the cached install status for the Video Analysis tools. Called from
// init and from the dropdown's open handler so the picker shows current state.
async function refreshVideoDeps() {
  try {
    const r = await window.api.video.detectDeps();
    state.videoDeps.ffmpeg  = !!r.ffmpeg?.found;
    state.videoDeps.whisper = !!r.whisper?.found;
    state.videoDeps.lastChecked = Date.now();
  } catch {
    state.videoDeps.ffmpeg = null;
    state.videoDeps.whisper = null;
  }
  populateModelPicker();
}

async function installVideoDepFromPicker(dep) {
  if (state.videoDepInstalling.has(dep)) return;
  state.videoDepInstalling.add(dep);
  populateModelPicker();
  try {
    await window.api.video.installDep({ dep }, () => { /* progress not shown inline */ });
  } catch {/* swallow — refresh below shows real state */}
  state.videoDepInstalling.delete(dep);
  await refreshVideoDeps();
}

function populateModelPicker() {
  const current = $('#cs-current');
  const menu = $('#cs-menu');
  if (!current || !menu || !state.catalog) return;

  const activeChat = currentChat();
  const activeModel = activeChat?.model;
  // Same canonical lookup as elsewhere so the picker shows the friendly name
  // ("Claude Opus 4.8") for cloud picks instead of the raw model id.
  const activePick = findPick(activeModel);
  current.textContent = activePick?.name || activeModel || 'Select a model';

  // Anything pulled from the Downloads tab lives in download-catalog.json, not
  // models.json, so it would never reach the picker — you could download 200
  // models and select none of them. Surface every installed model that the
  // curated categories don't already cover, under its own "Installed" group.
  const curatedTags = new Set();
  for (const cat of Object.values(state.catalog.categories)) {
    for (const p of cat.picks) if (p.tag) curatedTags.add(p.tag);
  }
  const extraInstalled = [...state.installed]
    .filter(tag => !curatedTags.has(tag))
    .map(tag => downloadPickFor(tag) || { tag, name: tag, tags: [], context: 8192 })
    .sort((a, b) => a.name.localeCompare(b.name));

  const categories = { ...state.catalog.categories };
  if (extraInstalled.length) {
    categories.installed = { label: 'Installed', backend: 'ollama', picks: extraInstalled };
  }

  // Build menu items. Cloud picks sort to the BOTTOM — Sanctum is local-first,
  // so the local models a user already has on disk should be what they see
  // first; cloud is the deliberate opt-in below them.
  menu.innerHTML = '';
  const orderedCategories = Object.entries(categories)
    .sort(([aKey], [bKey]) => (aKey === 'cloud' ? 1 : 0) - (bKey === 'cloud' ? 1 : 0));
  for (const [key, cat] of orderedCategories) {
    const visiblePicks = cat.picks;
    if (!visiblePicks.length) continue;
    const categorySelectable = SELECTABLE_CATEGORIES.has(key);

    const group = document.createElement('div');
    group.className = 'cs-group' + (categorySelectable ? '' : ' non-selectable');
    const label = document.createElement('div');
    label.className = 'cs-group-label';
    label.textContent = cat.label + (categorySelectable ? '' : ' · auto-routed');
    group.appendChild(label);

    for (const p of visiblePicks) {
      const id = p.tag || p.model_id || p.id || p.file;
      const provider = pickProvider(p);
      const isCloud = provider !== 'ollama';
      // Multimodal picks (qwen2.5vl, llama3.2-vision) live in the chat category
      // but are auto-routed for image inputs — not pickable as the primary
      // model. They still appear in the picker so the user can DOWNLOAD them.
      const itemSelectable = categorySelectable && !p.multimodal;
      // Ollama picks: installed registry. Cloud picks: API key presence.
      const installed = isCloud ? pickReady(p) : state.installed.has(p.tag);
      const pulling = !isCloud && state.pulling.has(id);
      const justDone = !isCloud && state.recentlyInstalled.has(id);

      const item = document.createElement(itemSelectable ? 'button' : 'div');
      if (itemSelectable) item.type = 'button';
      item.className = 'cs-item' + (id === activeModel ? ' active' : '') + (itemSelectable ? '' : ' non-selectable');
      if (itemSelectable) item.dataset.value = id;

      const name = document.createElement('span');
      name.className = 'cs-item-name';
      name.textContent = p.name;
      item.appendChild(name);

      // Tag multimodal picks so the user understands they're not pickable —
      // they're used automatically when an image is attached.
      if (p.multimodal) {
        const badge = document.createElement('span');
        badge.className = 'cs-item-badge';
        badge.textContent = 'vision · auto';
        item.appendChild(badge);
      }

      // Cloud picks: show a tiny badge instead of an install/uninstall button.
      // "API Key Needed" if missing, "cloud" once configured.
      if (isCloud) {
        const cloudBadge = document.createElement('span');
        cloudBadge.className = 'cs-item-badge cs-item-cloud-badge' + (installed ? '' : ' needs-key');
        cloudBadge.textContent = installed ? 'cloud · ready' : 'cloud · API key needed';
        item.appendChild(cloudBadge);
      }

      // Uninstall button for installed (non-pulling) models — gives the same
      // disk-freeing action as the Models view, without leaving the composer.
      // Has to be a SEPARATE button next to the row, not inside it, because
      // the row itself is a click target that switches the active model.
      if (!isCloud && installed && !pulling && !state.paused.has(id) && !justDone && p.tag) {
        const un = document.createElement('button');
        un.type = 'button';
        un.className = 'cs-item-action cs-item-uninstall';
        un.dataset.action = 'uninstall-inline';
        un.dataset.tag = p.tag;
        un.title = `Uninstall ${p.name} (frees disk)`;
        un.setAttribute('aria-label', `Uninstall ${p.name}`);
        un.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
        item.appendChild(un);
      }

      if (pulling || state.paused.has(id)) {
        // pullTag keyed by Ollama tag so granular progress updates can find
        // the right row.
        item.dataset.pullTag = id;
        const prog = state.pullProgress[id];
        const pct = Math.round(prog?.pct ?? ((prog && prog.total) ? (prog.received / prog.total) * 100 : 0));
        const progEl = document.createElement('span');
        progEl.className = 'cs-item-progress';
        progEl.textContent = state.paused.has(id) ? `paused · ${pct}%` : `${pct}%`;
        item.appendChild(progEl);

        const actions = document.createElement('span');
        actions.className = 'cs-item-actions';
        const isPaused = state.paused.has(id);
        actions.innerHTML = `
          <button type="button" class="cs-item-action-btn" data-action="${isPaused ? 'resume-inline' : 'pause-inline'}" data-tag="${escapeHtml(id)}" title="${isPaused ? 'Resume download' : 'Pause download'}">
            ${isPaused
              ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>`
              : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="0.5"/><rect x="14" y="4" width="4" height="16" rx="0.5"/></svg>`}
          </button>
          <button type="button" class="cs-item-action-btn cancel" data-action="cancel-inline" data-tag="${escapeHtml(id)}" title="Cancel and delete downloaded files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        `;
        item.appendChild(actions);
      } else if (justDone) {
        const check = document.createElement('span');
        check.className = 'cs-item-check';
        check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        item.appendChild(check);
      } else if (!installed && !isCloud) {
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'cs-item-action';
        dl.dataset.action = 'install-inline';
        dl.dataset.tag = id;
        const sizeHint = p.size_gb ? ` · ~${p.size_gb} GB` : '';
        dl.title = `Download ${p.name}${sizeHint}`;
        dl.setAttribute('aria-label', `Download ${p.name}`);
        dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;
        item.appendChild(dl);
      }

      group.appendChild(item);
    }
    menu.appendChild(group);
  }

  // -------- VIDEO ANALYSIS SECTION --------
  // Hand-built (not catalog-driven) because the entries are external CLI
  // tools, not Ollama models. Shows live install status + an "Install" button
  // wired to video:install_dep, plus a "Start" entry that spins up a new
  // video-analysis chat.
  const vidGroup = document.createElement('div');
  vidGroup.className = 'cs-group non-selectable';
  const vidLabel = document.createElement('div');
  vidLabel.className = 'cs-group-label';
  vidLabel.textContent = 'Video Analysis · setup';
  vidGroup.appendChild(vidLabel);

  const depRows = [
    { key: 'ffmpeg',  name: 'ffmpeg',         hint: 'Extracts frames + audio from videos' },
    { key: 'whisper', name: 'OpenAI Whisper', hint: 'Local speech-to-text transcription' }
  ];
  for (const d of depRows) {
    const item = document.createElement('div');
    item.className = 'cs-item non-selectable';

    const name = document.createElement('span');
    name.className = 'cs-item-name';
    name.textContent = d.name;
    item.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'cs-item-badge';
    badge.textContent = d.hint;
    item.appendChild(badge);

    const installed = state.videoDeps[d.key];
    const installing = state.videoDepInstalling.has(d.key);

    if (installing) {
      const prog = document.createElement('span');
      prog.className = 'cs-item-progress';
      prog.textContent = 'installing…';
      item.appendChild(prog);
    } else if (installed === true) {
      const check = document.createElement('span');
      check.className = 'cs-item-check';
      check.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
      item.appendChild(check);
    } else if (installed === false) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'cs-item-action';
      dl.dataset.action = 'install-video-dep';
      dl.dataset.dep = d.key;
      dl.title = `Install ${d.name}`;
      dl.setAttribute('aria-label', `Install ${d.name}`);
      dl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`;
      item.appendChild(dl);
    } else {
      // unknown / not yet checked
      const dot = document.createElement('span');
      dot.className = 'cs-item-progress';
      dot.textContent = '…';
      item.appendChild(dot);
    }
    vidGroup.appendChild(item);
  }

  menu.appendChild(vidGroup);
}

// Inline pulls from the dropdown share the same pullModel function — that way
// pause/resume/cancel work identically whether you started from the dropdown
// row or the install banner.
async function pullModelInline(tag) {
  pullModel(tag);
}

// Re-render the Downloads list, but only when it's actually on screen —
// pullModel runs regardless of which view the user is looking at.
function refreshDownloadsIfOpen() {
  const wrap = $('#dl-wrap');
  if (wrap && !wrap.hidden && typeof renderDownloadTab === 'function') renderDownloadTab();
}

// ============== ACTIVE CHAT RENDER ==============
function renderActiveChat() {
  const c = currentChat();
  // No active chat (e.g. an empty workspace) — show that space's empty state
  // and hide the chat chrome, rather than leaving stale content on screen.
  if (!c) {
    renderThread();
    $('#agent-bar')?.setAttribute('hidden', '');
    const title = $('#chat-title');
    if (title) { title.value = ''; title.placeholder = 'New chat'; }
    return;
  }

  $('#chat-title').value = c.title || '';
  $('#chat-title').placeholder = c.title || 'New chat';
  $('#chat-modality').textContent = modalityLabel(c.modality);
  // The model picker is now a custom dropdown — its display is synced via
  // populateModelPicker(), called from refreshOllama. Nothing to do here.

  $('#composer-input').placeholder = composerPlaceholder(c.modality);

  const textLike = c.modality === 'chat' || c.modality === 'code' || c.modality === 'agent' || c.modality === 'vision';
  // One generic attach button — handles images, PDFs, and text/code files.
  // The renderer routes by file kind at send time.
  $('#attach-file').hidden = !textLike;

  // Agent safety bar (Plan / Approval toggles) — only relevant in agent chats.
  const agentBar = $('#agent-bar');
  const folderNeeded = $('#folder-needed');
  const folderChip = $('#agent-folder-chip');
  if (agentBar) {
    const isAgent = c.modality === 'agent';
    agentBar.hidden = !isAgent;
    // Project-folder gating: agentic chats are locked until you pick a folder.
    const composerForm = $('#composer-form');
    const composerInput = $('#composer-input');
    if (isAgent && !c.projectFolder) {
      if (folderNeeded) folderNeeded.hidden = false;
      composerForm?.classList.add('disabled');
      if (composerInput) {
        composerInput.disabled = true;
        composerInput.placeholder = 'Select a project folder first…';
      }
      if (folderChip) folderChip.hidden = true;
    } else {
      if (folderNeeded) folderNeeded.hidden = true;
      composerForm?.classList.remove('disabled');
      if (composerInput) {
        composerInput.disabled = false;
        composerInput.placeholder = composerPlaceholder(c.modality);
      }
      if (folderChip) {
        if (isAgent && c.projectFolder) {
          folderChip.hidden = false;
          const name = c.projectFolder.split(/[\\/]/).pop() || c.projectFolder;
          $('#agent-folder-name').textContent = name;
          folderChip.title = `Project folder: ${c.projectFolder}\nClick to change`;
        } else {
          folderChip.hidden = true;
        }
      }
    }
    if (isAgent) {
      // Mutex safety. Exactly ONE of plan / approval / noApproval is always on.
      // If a legacy chat (or a brand-new one) has none of them set, default to
      // Plan — the safest posture. If multiple are on, prefer the safest in
      // the order Plan > Approval > NoApproval and clear the others.
      if (c.planMode) { c.approvalMode = false; c.noApproval = false; }
      else if (c.approvalMode) { c.noApproval = false; }
      else if (!c.noApproval) { c.planMode = true; }
      $('#toggle-plan').setAttribute('aria-pressed', c.planMode ? 'true' : 'false');
      $('#toggle-approval').setAttribute('aria-pressed', c.approvalMode ? 'true' : 'false');
      $('#toggle-noapproval').setAttribute('aria-pressed', c.noApproval ? 'true' : 'false');
      $('#toggle-readonly').setAttribute('aria-pressed', c.readOnly ? 'true' : 'false');
      $('#toggle-nofetch').setAttribute('aria-pressed', c.noFetch ? 'true' : 'false');
    }
  }

  // Both toggles stay VISIBLE for any text-like chat and are greyed out when
  // the model can't do that thing — rather than disappearing. A toggle that
  // vanishes leaves the user guessing whether the feature exists; a greyed
  // one says "this model can't, but the option is real."
  const supportsTools = modelSupportsTools(c.model);
  const supportsThinking = modelSupportsThinking(c.model);

  // Web search works for EVERY text model now: tool-capable models call the
  // web_search tool themselves; the rest get an automatic search-and-inject
  // (Sanctum runs the search and feeds the results in as context). So the web
  // toggle is never disabled — only thinking is gated on real support.
  if (!supportsThinking && c.thinkingEnabled) { c.thinkingEnabled = false; saveToStorage(); }
  // Default web ON for capable models (they only search when they decide to).
  // For weaker models it stays OFF by default — with them, "on" means a search
  // on every message, so opting in should be the user's explicit choice.
  if (c.webEnabled === undefined) { c.webEnabled = supportsTools; saveToStorage(); }

  const setToggle = (id, supported, on) => {
    const btn = $(`#${id}`);
    if (!btn) return;
    btn.hidden = !textLike;                          // only hide for non-text modalities
    btn.classList.toggle('disabled', !supported);    // grey, non-interactive
    btn.setAttribute('aria-disabled', supported ? 'false' : 'true');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = supported ? '' : 'This model doesn’t support this.';
  };
  // Web: always usable on a text chat. Think: only when the model supports it.
  setToggle('toggle-web', true, c.webEnabled === true);
  setToggle('toggle-think', supportsThinking, c.thinkingEnabled === true);

  // The abilities menu stays available for any text chat — both options live
  // inside it, greyed when unsupported.
  const menuBtn = $('#tools-menu-btn');
  if (menuBtn) {
    menuBtn.hidden = !textLike;
    menuBtn.classList.toggle('has-active', !!(c.webEnabled || c.thinkingEnabled));
  }

  renderThread();
  renderInstallBanner();
  updateSendButton();
}

function wireWebToggle() {
  const btn = $('#toggle-web');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const c = currentChat();
    if (!c) return;
    // Web works for every model now (tool-calling or search-and-inject), so
    // it's never disabled — no support gate here.
    c.webEnabled = !c.webEnabled;
    btn.setAttribute('aria-pressed', c.webEnabled ? 'true' : 'false');
    $('#tools-menu-btn')?.classList.toggle('has-active', !!(c.webEnabled || c.thinkingEnabled));
    saveToStorage();
  });
}

function wireThinkToggle() {
  const btn = $('#toggle-think');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const c = currentChat();
    if (!c) return;
    if (btn.classList.contains('disabled') || !modelSupportsThinking(c.model)) return;
    c.thinkingEnabled = !c.thinkingEnabled;
    btn.setAttribute('aria-pressed', c.thinkingEnabled ? 'true' : 'false');
    $('#tools-menu-btn')?.classList.toggle('has-active', !!(c.webEnabled || c.thinkingEnabled));
    saveToStorage();
  });
}

// Open/close the abilities popover, with click-outside + Esc to dismiss.
// The menu stays open while you toggle individual items so the user can flip
// several in a row without re-opening.
function wireToolsMenu() {
  const btn  = $('#tools-menu-btn');
  const menu = $('#tools-menu');
  if (!btn || !menu) return;

  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
    document.addEventListener('keydown', onEsc);
  };
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  };
  const onDocClick = (e) => {
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
}

function modalityLabel(m) {
  return ({
    chat: 'Chat & multimodal',
    vision: 'Chat & multimodal',
    image: 'Image generation',
    video: 'Video generation',
    code: 'Coding',
    agent: 'Agent · tools'
  })[m] || m;
}

function composerPlaceholder(m) {
  return ({
    chat: 'Message your model…',
    vision: 'Message your model…',
    image: 'Describe the image you want…',
    video: 'Describe the video you want…',
    code: 'Paste code or describe a change…',
    agent: 'Goal for the agent…',
    'video-analysis': 'Attach a video (paperclip) to analyse, or ask a follow-up…'
  })[m] || 'Message…';
}

function renderThread() {
  const c = currentChat();
  const list = $('#thread');
  list.innerHTML = '';
  if (!c || !c.messages.length) {
    list.appendChild(renderEmptyState());
    return;
  }
  for (const m of c.messages) list.appendChild(renderMessage(m));
  list.scrollTop = list.scrollHeight;
}

function renderEmptyState() {
  const c = currentChat();
  // Agentic chats get a different empty state — the categorical chips don't
  // make sense (modality is fixed). What it needs first is a project folder,
  // like Claude Code.
  if (c?.modality === 'agent') return renderAgenticEmptyState(c);

  // Code workspace with no project open (or none exist yet) — point the user
  // at New Project rather than the general chat chips.
  if (state.space === 'code') {
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML = `
      <div class="empty-orb"></div>
      <h2>Code workspace</h2>
      <p>Agentic coding projects live here — each one is scoped to a project folder and can read, write, and run commands with your approval. Start one with <strong>New Project</strong>.</p>
      <button type="button" class="empty-folder-btn" id="empty-new-project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        <span>New Project</span>
      </button>
    `;
    setTimeout(() => {
      wrap.querySelector('#empty-new-project')?.addEventListener('click', () => createAgenticChat());
    }, 0);
    return wrap;
  }

  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `
    <div class="empty-orb"></div>
    <h2>What would you like to do?</h2>
    <p>Pick a category below, or change the model from the top right. Everything runs locally.</p>
    <div class="empty-chips"></div>
  `;
  const chipsEl = wrap.querySelector('.empty-chips');
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
    // Vision is auto-routed (a vision router runs when you attach an image);
    // it has no user-facing modality, so don't surface it as a chip.
    if (key === 'vision') continue;
    // Cloud picks aren't a modality — they're cross-cutting models that work
    // in either chat or agent. The empty-state chips are about picking a
    // STARTING modality, so don't show a "Cloud Models" chip here; users
    // switch to Claude via the model picker instead.
    if (key === 'cloud') continue;
    // Agentic chats live in the Code workspace now, reached via New Project —
    // don't offer an "agent" starting chip in the Home empty state.
    if (key === 'agent') continue;
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = cat.label;
    chip.addEventListener('click', () => {
      const firstPick = cat.picks[0];
      const id = firstPick.tag || firstPick.file;
      const ch = currentChat();
      ch.model = id;
      ch.modality = key;
      saveToStorage();
      renderActiveChat();
      $('#composer-input').focus();
    });
    chipsEl.appendChild(chip);
  }
  return wrap;
}

function renderAgenticEmptyState(c) {
  const wrap = document.createElement('div');
  wrap.className = 'empty agentic-empty';
  if (!c.projectFolder) {
    wrap.innerHTML = `
      <div class="empty-orb"></div>
      <h2>Select a project folder</h2>
      <p>The agent needs a working directory. Pick one and it'll be scoped to read and write only inside that folder.</p>
      <button type="button" class="empty-folder-btn" id="empty-pick-folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span>Choose folder</span>
      </button>
    `;
    setTimeout(() => {
      const btn = wrap.querySelector('#empty-pick-folder');
      if (btn) btn.addEventListener('click', pickProjectFolder);
    }, 0);
  } else {
    const folderName = c.projectFolder.split(/[\\/]/).pop() || c.projectFolder;
    wrap.innerHTML = `
      <div class="empty-orb"></div>
      <h2>Ready to work</h2>
      <p>Scoped to <span class="empty-folder-name">${escapeHtml(folderName)}</span>. Tell the agent what to do — investigate the codebase, fix a bug, write tests, anything within this folder.</p>
    `;
  }
  return wrap;
}

async function pickProjectFolder() {
  const r = await window.api.files.pickFolder();
  if (!r) return;
  const c = currentChat();
  if (!c) return;
  c.projectFolder = r.path;
  c.pathAllowlist = c.pathAllowlist || [];
  if (!c.pathAllowlist.includes(r.path)) c.pathAllowlist.push(r.path);
  // Adopt the folder name as the chat title when the user hasn't named the chat yet.
  if (!c.title) {
    const folderName = r.path.split(/[\\/]/).pop();
    if (folderName) c.title = folderName;
  }
  saveToStorage();
  renderActiveChat();
  renderChatList();
}

function renderMessage(m) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}` + (m.queued ? ' queued' : '');

  if (m.queued) {
    const badge = document.createElement('span');
    badge.className = 'msg-queued-badge';
    badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> Queued`;
    el.appendChild(badge);
  }

  // Routing badge: shows up on assistant messages that were silently
  // forwarded to a different model (e.g. chat → coding model on a code req).
  if (m.role === 'assistant' && m.routedTo) {
    const badge = document.createElement('div');
    badge.className = 'msg-routed-badge';
    // Vision is the only remaining auto-route — the code one was removed
    // because being answered by a model you didn't pick is a bad surprise.
    const why = 'vision';
    badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><span>Routed to <strong>${escapeHtml(prettyModelName(m.routedTo))}</strong> · ${why}</span>`;
    el.appendChild(badge);
  }

  if (m.attachments?.length) {
    const att = document.createElement('div');
    att.className = 'msg-attachments';
    for (const a of m.attachments) {
      const tag = document.createElement('span');
      tag.className = 'msg-att';
      const icon = a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎬' : '📄';
      const suffix = a.pages ? ` · ${a.pages}p` : (a.ext ? ` · .${a.ext}` : '');
      tag.textContent = `${icon} ${a.name}${suffix}`;
      att.appendChild(tag);
    }
    el.appendChild(att);
  }

  // Tool events (thinking, reads, searches, shell) render BEFORE the content.
  // All of a turn's tool activity happens before the final answer, so this
  // keeps "Thought for Ns" and "Searched the web" in the place they happened —
  // above the answer — instead of sinking to the bottom of the message.
  if (m.toolEvents?.length) {
    for (const ev of m.toolEvents) el.appendChild(renderToolEvent(ev));
  }

  if (m.content) {
    const body = document.createElement('div');
    body.className = 'msg-body';
    // Assistant content is rendered as markdown so **bold**, lists, code blocks,
    // and links display correctly. User input stays as plain text (the user
    // wrote it; show it verbatim).
    if (m.role === 'assistant') body.innerHTML = renderMarkdown(m.content);
    else body.textContent = m.content;
    el.appendChild(body);
  }

  // (The old "N in · N out" token badge was removed — token counts now live
  // only on the thinking row as "Thought for Ns · N tokens".)

  // Video Analysis status card — appears inside the placeholder assistant
  // bubble while extraction/transcription/captioning runs, plus the deps
  // install UI when ffmpeg or whisper aren't on PATH.
  if (m.videoState) {
    el.appendChild(renderVideoStateCard(m));
  }

  // Timeline strip — once analysis is done, the chat's videoAnalysis frames
  // sit under the very first assistant message so the user can scrub.
  const ch = currentChat();
  if (m.role === 'assistant' && m.videoState?.stage === 'done' && ch?.videoAnalysis) {
    el.appendChild(renderVideoTimeline(ch.videoAnalysis));
  }

  // Loading indicator — shown while the model has produced no content,
  // no tool calls, and no media yet. The "Thinking" label + star are only
  // shown if the chat actually has thinking enabled; otherwise it's just
  // bouncing bubbles so we don't misrepresent what the model is doing.
  if (m.thinking && !m.content && !(m.toolEvents && m.toolEvents.length) && !m.videoState) {
    const t = document.createElement('div');
    t.className = 'msg-thinking' + (m.thinkingMode ? ' with-label' : ' dots-only');
    if (m.thinkingMode) {
      t.innerHTML = `
        <span class="msg-thinking-label">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2 14.39 8.26 21 9.27 16 14.14 17.18 21.02 12 17.77 6.82 21.02 8 14.14 3 9.27 9.61 8.26z"/></svg>
          <span>Thinking</span>
        </span>
        <span class="msg-thinking-dots"><span></span><span></span><span></span></span>
      `;
    } else {
      t.innerHTML = `<span class="msg-thinking-dots"><span></span><span></span><span></span></span>`;
    }
    el.appendChild(t);
  }

  return el;
}

// Friendly display labels for each tool — match the Claude Code aesthetic
// (single capitalized word per tool). Falls back to the raw name for unknown
// tools (e.g. MCP-provided ones get their own name verbatim).
const TOOL_LABELS = {
  read_file: 'Read',
  list_dir: 'List',
  write_file: 'Write',
  apply_patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_search: 'Search',
  web_fetch: 'Fetch',
  calc: 'Calc',
  task_status: 'Task',
  task_list: 'Tasks',
  task_kill: 'Kill',
  mcp_list_servers: 'MCP',
  mcp_add_server: 'MCP add',
  mcp_remove_server: 'MCP remove',
  exit_plan_mode: 'Plan',
  describe_image: 'Vision'
};

function renderToolEvent(ev) {
  // Shell commands get the full Claude-Code-style card with a header row +
  // IN/OUT box. Everything else gets a compact header line that shows the
  // status dot, the tool label, the relevant argument (file path / URL /
  // query), and the status text on the right — same family of designs, no
  // pill chip anywhere.
  if (ev.name === '__think') return renderThinkEvent(ev);
  if (ev.name === 'web_search') return renderSearchEvent(ev);
  if (ev.name === 'run_command' || ev.name === 'run_command_async') {
    return renderShellToolEvent(ev);
  }
  return renderCompactToolEvent(ev);
}

// Web-search row — a permanent past-tense marker in the transcript, styled to
// match the "Thought for Ns" row. "Searched the web" stays put where the
// search happened; it reads as a record of what the model did, not a
// transient status.
function renderSearchEvent(ev) {
  const el = document.createElement('div');
  const running = ev.status === 'running';
  const err = ev.status === 'error';
  el.className = `search-row${running ? ' running' : ''}${err ? ' error' : ''}`;
  const label = running
    ? 'Searching the web'
    : err
      ? (ev.resultSummary ? `Web search — ${ev.resultSummary}` : 'Web search failed')
      : (ev.resultSummary ? `Searched the web · ${ev.resultSummary}` : 'Searched the web');
  el.innerHTML = `
    <svg class="search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <span class="search-label">${escapeHtml(label)}</span>
    ${ev.argSummary ? `<span class="search-q">${escapeHtml(ev.argSummary)}</span>` : ''}
    ${running ? '<span class="think-dots"><span></span><span></span><span></span></span>' : ''}
  `;
  return el;
}

// The reasoning row. Lives in the toolEvents stream so it renders in the
// order it happened and stays there — "Thought for 4s" marks a moment in the
// transcript, so moving it to the end of the message would misreport when the
// model actually thought.
function renderThinkEvent(ev) {
  const el = document.createElement('div');
  const running = ev.status === 'running';
  el.className = `think-row${running ? ' running' : ''}`;
  const secs = ev.ms != null ? Math.max(1, Math.round(ev.ms / 1000)) : null;
  const label = running
    ? 'Thinking'
    : (secs != null ? `Thought for ${secs}s` : 'Thought');
  // Live token count for the thinking phase, approximated from the streamed
  // reasoning text. Only shown when we actually have a count (Anthropic's
  // omitted thinking streams no text, so nothing to show there).
  const tok = ev.tokens ? `<span class="think-tokens">${ev.tokens.toLocaleString()} tokens</span>` : '';
  el.innerHTML = `
    <svg class="think-star" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2 14.39 8.26 21 9.27 16 14.14 17.18 21.02 12 17.77 6.82 21.02 8 14.14 3 9.27 9.61 8.26z"/></svg>
    <span class="think-label">${escapeHtml(label)}</span>
    ${tok ? `<span class="think-sep">·</span>${tok}` : ''}
    ${running ? '<span class="think-dots"><span></span><span></span><span></span></span>' : ''}
  `;
  return el;
}

function renderCompactToolEvent(ev) {
  const el = document.createElement('div');
  el.className = `tool-event te-row ${ev.status || 'done'}`;
  const label = TOOL_LABELS[ev.name] || ev.name;
  const argSummary = ev.argSummary || '';
  let statusText;
  if (ev.status === 'running') statusText = 'running';
  else if (ev.status === 'error') statusText = ev.resultSummary ? `error · ${ev.resultSummary}` : 'error';
  else statusText = ev.resultSummary || 'done';
  el.innerHTML = `
    <span class="te-shell-dot"></span>
    <span class="te-shell-label">${escapeHtml(label)}</span>
    <span class="te-shell-summary">${escapeHtml(argSummary)}</span>
    <span class="te-shell-status">${escapeHtml(statusText)}</span>
  `;
  return el;
}

// Legacy pill renderer — kept for any path I might have missed, but the
// dispatcher above routes through the new compact / shell renderers.

// Claude Code / VS Code style shell-command card. Header row with a status
// dot + tool name + truncated command, then a bordered IN/OUT box that shows
// the full command and the captured stdout/stderr (truncated to 4 KB upstream).
function renderShellToolEvent(ev) {
  const el = document.createElement('div');
  el.className = `tool-event te-shell ${ev.status || 'done'}`;
  const isAsync = ev.name === 'run_command_async';
  // Use the shell the main process actually resolved — Git Bash if available
  // on Windows, else cmd.exe; /bin/sh on macOS/Linux. preload exposes this
  // synchronously so the label is right from the first render.
  const shellName = window.api?.shell?.name || (window.api?.platform === 'win32' ? 'Cmd' : 'Bash');
  const label = isAsync ? `${shellName} · async` : shellName;
  const cmd = ev.input || ev.argSummary || '';
  const truncatedCmd = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd;
  const statusText = ev.status === 'running'
    ? 'running'
    : (ev.status === 'error'
        ? (ev.resultSummary ? `error · ${escapeHtml(ev.resultSummary)}` : 'error')
        : (ev.resultSummary ? escapeHtml(ev.resultSummary) : 'done'));
  const out = ev.output || '';
  const showOut = ev.status !== 'running' && out.length > 0;
  el.innerHTML = `
    <div class="te-shell-head">
      <span class="te-shell-dot"></span>
      <span class="te-shell-label">${escapeHtml(label)}</span>
      <span class="te-shell-summary">${escapeHtml(truncatedCmd)}</span>
      <span class="te-shell-status">${statusText}</span>
    </div>
    <div class="te-shell-io">
      <div class="te-shell-row">
        <span class="te-shell-tag">IN</span>
        <pre class="te-shell-text">${escapeHtml(cmd)}</pre>
      </div>
      ${showOut ? `
      <div class="te-shell-row">
        <span class="te-shell-tag">OUT</span>
        <pre class="te-shell-text">${escapeHtml(out)}</pre>
      </div>` : ''}
    </div>
  `;
  return el;
}

// ============== INSTALL BANNER ==============
// Event delegation: attach once at init, then re-render content freely without
// losing the listener. Without this, mouse-down/mouse-up that straddle a
// re-render tick (refreshOllama every 8s) silently drop the click event because
// the original button has been destroyed by the time mouse-up fires.
function wireInstallBanner() {
  const banner = $('#install-banner');
  if (!banner) return;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'install') {
      const tag = btn.dataset.tag;
      if (!tag || state.pulling.has(tag)) return;
      pullModel(tag);
    } else if (action === 'pause') {
      pausePull(btn.dataset.tag);
    } else if (action === 'resume') {
      resumePull(btn.dataset.tag);
    } else if (action === 'cancel') {
      cancelPull(btn.dataset.tag);
    } else if (action === 'install-ollama') {
      installOllama(banner);
    } else if (action === 'start-ollama') {
      startOllama(banner);
    } else if (action === 'open-settings') {
      openSettings();
    }
  });
}

function renderInstallBanner() {
  const banner = $('#install-banner');
  const c = currentChat();
  if (!banner || !c) return;
  if (state.ollamaBusy) return; // in-flight job owns the banner

  // 1) Ollama itself isn't installed → offer one-click install
  if (state.ollamaDetected === false) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>Ollama isn't installed yet.</strong>
        <span class="sub">Sanctum needs Ollama to run language models. One click downloads and installs it — ~2 GB.</span>
      </div>
      <button type="button" data-action="install-ollama">Install Ollama</button>
    `;
    return;
  }

  // 2) Ollama installed but not running → start it
  if (state.ollamaDetected === true && state.ollamaRunning === false) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>Ollama is installed but not running.</strong>
        <span class="sub">Start it so the app can talk to it.</span>
      </div>
      <button type="button" data-action="start-ollama">Start Ollama</button>
    `;
    return;
  }

  // 3) Per-model install banner
  const tag = c.model;
  // Cloud picks aren't "installed" — they're API-key-gated. Show a focused
  // setup banner if the key is missing, otherwise hide the banner entirely.
  // Without this, switching the chat to claude-opus-4-8 made the banner say
  // "isn't installed — Install model" which both failed (no Ollama tag) and
  // hid the real fix (set the API key in Settings).
  const tagPick = findPick(tag);
  if (tagPick && pickProvider(tagPick) !== 'ollama') {
    if (pickReady(tagPick)) { banner.hidden = true; banner.innerHTML = ''; return; }
    banner.hidden = false;
    const prov = pickProvider(tagPick);
    const provLabel = prov === 'anthropic' ? 'Anthropic' : prov === 'google' ? 'Google' : prov;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>${escapeHtml(tagPick.name)}</strong> needs an API key.
        <span class="sub">Add your ${escapeHtml(provLabel)} key in Settings → API Keys, then send your message.</span>
      </div>
      <button type="button" data-action="open-settings">Open Settings</button>
    `;
    return;
  }
  if (state.installed.has(tag)) { banner.hidden = true; banner.innerHTML = ''; return; }

  // In-flight pull (downloading or paused) — show progress + pause/cancel.
  if (state.pulling.has(tag) || state.paused.has(tag)) {
    const prog = state.pullProgress[tag] || { received: 0, total: 0 };
    const pct = Math.round(prog.pct ?? (prog.total ? (prog.received / prog.total) * 100 : 0));
    const mb = (prog.received / (1024 * 1024)).toFixed(0);
    const totalMb = (prog.total / (1024 * 1024)).toFixed(0);
    const isPaused = state.paused.has(tag);
    const pick = allPicks().find(p => p.tag === tag);
    banner.hidden = false;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>${isPaused ? 'Paused' : 'Installing'} ${escapeHtml(pick?.name || tag)}…</strong>
        <span class="sub ib-progress-sub">${isPaused ? 'Paused' : 'Downloading'} · ${mb} / ${totalMb} MB (${pct}%)</span>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <button type="button" class="ib-action" data-action="${isPaused ? 'resume' : 'pause'}" data-tag="${escapeHtml(tag)}" title="${isPaused ? 'Resume download' : 'Pause download'}">
        ${isPaused
          ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="0.5"/><rect x="14" y="4" width="4" height="16" rx="0.5"/></svg>`}
      </button>
      <button type="button" class="ib-action cancel" data-action="cancel" data-tag="${escapeHtml(tag)}" title="Cancel and delete downloaded files">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    `;
    return;
  }

  const pick = allPicks().find(p => p.tag === tag);
  const sizeHint = pick?.ram_gb ? ` · ~${pick.ram_gb} GB` : '';
  banner.hidden = false;
  banner.innerHTML = `
    <div class="ib-text">
      <strong>${escapeHtml(pick?.name || tag)}</strong> isn't installed yet.
      <span class="sub">Download once and it'll run locally${sizeHint}.</span>
    </div>
    <button type="button" data-action="install" data-tag="${escapeHtml(tag)}">Install model</button>
  `;
}

async function installOllama(banner) {
  if (state.ollamaBusy) return;
  state.ollamaBusy = true;
  banner.hidden = false;
  banner.innerHTML = `
    <div class="ib-text">
      <strong>Installing Ollama…</strong>
      <span class="sub" id="oi-status">Starting download…</span>
    </div>
    <div class="progress"><div class="progress-bar" id="oi-bar"></div></div>
  `;
  const statusEl = banner.querySelector('#oi-status');
  const barEl    = banner.querySelector('#oi-bar');

  try {
    await window.api.ollama.install((chunk) => {
      if (chunk.error) {
        statusEl.textContent = `Error: ${chunk.error}`;
        return;
      }
      if (chunk.phase === 'downloading') {
        if (chunk.total && chunk.received != null) {
          const pct = Math.round((chunk.received / chunk.total) * 100);
          barEl.style.width = pct + '%';
          const mb = (chunk.received / (1024 * 1024)).toFixed(0);
          const totalMb = (chunk.total / (1024 * 1024)).toFixed(0);
          statusEl.textContent = `Downloading · ${mb} / ${totalMb} MB (${pct}%)`;
        } else if (chunk.message) {
          statusEl.textContent = chunk.message;
        }
      } else if (chunk.phase === 'launching') {
        barEl.style.width = '100%';
        statusEl.textContent = chunk.message || 'Launching installer…';
      } else if (chunk.phase === 'waiting') {
        statusEl.textContent = chunk.message || 'Waiting for Ollama to come online…';
      } else if (chunk.phase === 'done') {
        statusEl.textContent = chunk.message || 'Done.';
      }
    });
  } catch (e) {
    statusEl.textContent = `Error: ${e.message || e}`;
  } finally {
    state.ollamaBusy = false;
  }
  await detectOllama();
  await refreshOllama();
}

async function startOllama(banner) {
  if (state.ollamaBusy) return;
  state.ollamaBusy = true;
  banner.hidden = false;
  banner.innerHTML = `
    <div class="ib-text">
      <strong>Starting Ollama…</strong>
      <span class="sub" id="os-status">Launching background process…</span>
    </div>
  `;
  const statusEl = banner.querySelector('#os-status');
  try {
    const res = await window.api.ollama.start();
    if (res.error) {
      statusEl.textContent = `Error: ${res.error}`;
    } else {
      statusEl.textContent = 'Ollama is running.';
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message || e}`;
  } finally {
    state.ollamaBusy = false;
  }
  await detectOllama();
  await refreshOllama();
}

async function pullModel(tag /* banner is read fresh via DOM */) {
  if (state.pulling.has(tag)) return;
  state.pulling.add(tag);
  state.paused.delete(tag);
  state.cancelled.delete(tag);
  if (!state.pullProgress[tag]) state.pullProgress[tag] = { received: 0, total: 0 };
  // Reset the per-digest accumulator on each fresh pull so paused/resumed
  // pulls don't double-count layers that re-stream from byte 0.
  state.pullDigests[tag] = {};
  renderInstallBanner();
  populateModelPicker();

  let sawError = false;
  let lastErrorMessage = '';
  let receivedAnyProgress = false;
  let chunkCount = 0;

  try {
    await window.api.ollama.pull(tag, (chunk) => {
      chunkCount++;
      // Capture channelId from the first chunk so we can abort.
      if (chunk._channelId) state.pullChannels.set(tag, chunk._channelId);

      if (chunk.error) {
        sawError = true;
        lastErrorMessage = chunk.error;
        return;
      }
      if (chunk.aborted) return;
      if (chunk.total && chunk.completed != null) {
        receivedAnyProgress = true;
        // Ollama pulls multiple layers sequentially, each reporting its own
        // total/completed. Naively overwriting state.pullProgress made the
        // percentage drop whenever a new (smaller-but-not-yet-complete) layer
        // started. Track per-digest progress and sum them so % grows monotonic.
        const digestKey = chunk.digest || chunk.status || '_default';
        const per = state.pullDigests[tag] || (state.pullDigests[tag] = {});
        per[digestKey] = { received: chunk.completed || 0, total: chunk.total };
        let received = 0, total = 0;
        for (const d of Object.values(per)) { received += d.received; total += d.total; }

        // Ollama only reveals a layer's size when that layer STARTS, so the
        // denominator grows as the pull proceeds. Summing per-digest fixed the
        // old drop-to-zero, but the percentage still went BACKWARDS whenever a
        // new layer appeared (finish a 4GB layer at 100%, a 1GB layer starts,
        // and 4/4 becomes 4/5 = 80%). Ratchet it instead: never regress, and
        // hold at 99 until the pull actually completes so 100% never lies.
        const rawPct = total ? (received / total) * 100 : 0;
        const prevPct = state.pullProgress[tag]?.pct || 0;
        const pct = Math.min(99, Math.max(prevPct, rawPct));
        state.pullProgress[tag] = { received, total, pct };
        patchPullProgress(tag);
        patchInstallBannerProgress(tag);
        patchDlProgress(tag);
      }
    });
  } catch (e) {
    sawError = true;
    lastErrorMessage = e.message || String(e);
  }

  state.pulling.delete(tag);
  state.pullChannels.delete(tag);

  // PAUSED — keep progress and current UI showing the resume button.
  if (state.paused.has(tag)) {
    renderInstallBanner();
    populateModelPicker();
    refreshDownloadsIfOpen();
    return;
  }
  // CANCELLED — clear progress, refresh installed list (the DELETE may have run),
  // re-render with the install button back.
  if (state.cancelled.has(tag)) {
    state.cancelled.delete(tag);
    delete state.pullProgress[tag];
    delete state.pullDigests[tag];
    await refreshOllama();
    refreshDownloadsIfOpen();
    return;
  }

  // Refresh and check if the pull succeeded.
  const list = await window.api.ollama.list();
  const installedNow = !list.error && (list.models || []).some(m => m.name === tag);
  delete state.pullProgress[tag];

  if (installedNow) {
    state.recentlyInstalled.add(tag);
    await refreshOllama();
    refreshDownloadsIfOpen();   // swap the progress UI for Installed/Uninstall
    setTimeout(() => {
      state.recentlyInstalled.delete(tag);
      populateModelPicker();
    }, 2500);
    return;
  }

  // Surface a friendly error in the install banner.
  let msg;
  if (sawError) msg = `Pull failed: ${lastErrorMessage}`;
  else if (chunkCount === 0) msg = `No data received from Ollama. Try again, or check that Ollama isn't being blocked by antivirus / firewall.`;
  else if (!receivedAnyProgress) msg = `Pull stalled after manifest fetch. Try \`ollama pull ${tag}\` in a terminal to see the underlying error.`;
  else msg = `Stream ended early after ${chunkCount} chunks. Try again.`;
  // Also record it so the Downloads tab (which doesn't show the install
  // banner) can display the failure on the model's card instead of silently
  // snapping back to a Download button.
  state.pullError = { tag, msg };
  const banner = $('#install-banner');
  if (banner) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>${escapeHtml(tag)} didn't finish installing.</strong>
        <span class="sub">${escapeHtml(msg)}</span>
      </div>
      <button type="button" data-action="install" data-tag="${escapeHtml(tag)}">Try again</button>
    `;
  }
  // A failed pull leaves the card stuck on its progress bar otherwise.
  refreshDownloadsIfOpen();
  setTimeout(() => { renderInstallBanner(); }, 8000);
}

// =============== PAUSE / RESUME / CANCEL ===============
async function pausePull(tag) {
  if (!state.pulling.has(tag)) return;
  state.paused.add(tag);
  const channelId = state.pullChannels.get(tag);
  if (channelId) await window.api.ollama.pullAbort(channelId, false);
  // UI updates happen when the stream resolves and the pull function exits.
}

async function resumePull(tag) {
  state.paused.delete(tag);
  // Re-issue the pull — Ollama resumes from existing blobs by sha256.
  if (state.pulling.has(tag)) return; // already restarting elsewhere
  // Both UIs use the same pullModel function now.
  pullModel(tag);
}

async function cancelPull(tag) {
  state.cancelled.add(tag);
  state.paused.delete(tag);
  const channelId = state.pullChannels.get(tag);
  if (channelId) {
    await window.api.ollama.pullAbort(channelId, true);
  } else {
    // No active fetch (was paused). Best-effort delete and clear state.
    try {
      await fetch(`http://localhost:11434/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: tag, name: tag })
      }).catch(() => {});
    } catch {}
    state.cancelled.delete(tag);
    delete state.pullProgress[tag];
    delete state.pullDigests[tag];
    state.pullChannels.delete(tag);
    await refreshOllama();
    populateModelPicker();
    renderInstallBanner();
  }
}

// Granular UI updates so we don't rebuild the whole picker / banner on every
// progress chunk — that was causing the spinner to restart its animation
// hundreds of times per second (the "jitter" the user reported).
function patchPullProgress(tag) {
  const menu = $('#cs-menu');
  if (!menu || menu.hidden) return;
  let item;
  try { item = menu.querySelector(`.cs-item[data-pull-tag="${CSS.escape(tag)}"]`); } catch { item = null; }
  if (!item) return;
  const prog = state.pullProgress[tag];
  if (!prog) return;
  const progEl = item.querySelector('.cs-item-progress');
  if (progEl) {
    const pct = Math.round(prog.pct ?? (prog.total ? (prog.received / prog.total) * 100 : 0));
    progEl.textContent = state.paused.has(tag) ? `paused · ${pct}%` : `${pct}%`;
  }
}

function patchInstallBannerProgress(tag) {
  const c = currentChat();
  if (!c || c.model !== tag) return;
  const banner = $('#install-banner');
  if (!banner || banner.hidden) return;
  const prog = state.pullProgress[tag];
  if (!prog) return;
  const bar = banner.querySelector('.progress-bar');
  const sub = banner.querySelector('.ib-progress-sub');
  if (bar && prog.total) {
    const pct = Math.round(prog.pct ?? ((prog.received / prog.total) * 100));
    bar.style.width = pct + '%';
    if (sub) {
      const mb = (prog.received / (1024 * 1024)).toFixed(0);
      const totalMb = (prog.total / (1024 * 1024)).toFixed(0);
      sub.textContent = state.paused.has(tag)
        ? `Paused · ${mb} / ${totalMb} MB (${pct}%)`
        : `Downloading · ${mb} / ${totalMb} MB (${pct}%)`;
    }
  }
}

// ============== ATTACHMENTS ==============
// Drop a real File-from-DnD into the same attachment pipeline as the picker.
// Uses webUtils.getPathForFile (Electron 32+) since File.prototype.path was
// removed for security.
async function attachDroppedFile(file) {
  const filePath = window.api.files.pathForFile(file);
  if (!filePath) return;
  const att = await window.api.files.fromPath(filePath);
  if (!att || att.error) {
    const c = currentChat();
    if (c) {
      c.messages.push({ role: 'system', content: `Couldn't attach ${file.name}: ${att?.error || 'unknown error'}` });
      renderActiveChat();
    }
    return;
  }
  state.pendingAttachments.push(att);
}

// Wire window-level drag + drop. Any file dragged onto the app, regardless of
// where (chat surface, composer, sidebar), routes through fromPath() and
// becomes a pending attachment ready for the next send.
function wireDragDrop() {
  let dragDepth = 0;
  const overlay = $('#drag-overlay');

  window.addEventListener('dragenter', (e) => {
    // Only react to file drags — ignore text/internal element drags.
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    if (overlay) overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      try { await attachDroppedFile(f); } catch (err) { console.warn('attach failed', err); }
    }
    renderAttachments();
  });
}

function wireAttachments() {
  $('#attach-file').addEventListener('click', async () => {
    // Single picker handles any file type — videos return kind:'video' (run
    // the analysis pipeline), arbitrary files come back as kind:'file' so the
    // model at least gets the metadata. No silent drops.
    const f = await window.api.files.pick();
    if (!f) return;
    if (f.error) {
      // Surface picker errors as a transient system message in the active chat
      const c = currentChat();
      if (c) {
        c.messages.push({ role: 'system', content: `Couldn't attach ${f.name || 'file'}: ${f.error}` });
        renderActiveChat();
      }
      return;
    }
    if (f.kind === 'unsupported') return;
    state.pendingAttachments.push(f);
    renderAttachments();
  });

  // Paste-to-attach: when the user pastes (Ctrl+V) and the clipboard contains
  // an image (PNG screenshot, copied image from a browser, etc.), turn it into
  // a pending attachment instead of inserting raw bytes into the textbox.
  // Plain-text pastes pass through untouched.
  const composerInput = $('#composer-input');
  if (composerInput) {
    composerInput.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items || !items.length) return;
      const imageItems = [];
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) imageItems.push(it);
      }
      if (!imageItems.length) return; // text-only paste — let it through
      e.preventDefault();
      for (const it of imageItems) {
        const blob = it.getAsFile();
        if (!blob) continue;
        try {
          const att = await blobToImageAttachment(blob);
          state.pendingAttachments.push(att);
        } catch {/* skip bad blob */}
      }
      renderAttachments();
    });
  }
}

// Read an image File/Blob and shape it into the same attachment object that
// `file:pick` returns (kind: 'image', name, base64, size). Used by the paste
// handler so the rest of the chat pipeline doesn't need to know the source.
function blobToImageAttachment(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const buf = reader.result;
      const bytes = new Uint8Array(buf);
      // base64 the bytes without choking on large files.
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(bin);
      const subtype = (blob.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `pasted-${stamp}.${subtype}`;
      resolve({ kind: 'image', name, base64, size: blob.size, mime: blob.type });
    };
    reader.readAsArrayBuffer(blob);
  });
}

function humanSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderAttachments() {
  const el = $('#attachments');
  el.innerHTML = '';
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    if (a.kind === 'image') {
      const mime = a.mime || 'image/png';
      chip.innerHTML = `<img src="data:${mime};base64,${a.base64}"><span class="name">${escapeHtml(a.name)}</span><span class="meta">${humanSize(a.size)}</span><span class="x" data-i="${i}">×</span>`;
    } else if (a.kind === 'pdf') {
      chip.innerHTML = `<span class="att-icon">📄</span><span class="name">${escapeHtml(a.name)}</span><span class="meta">${a.pages}p</span><span class="x" data-i="${i}">×</span>`;
    } else if (a.kind === 'video') {
      chip.innerHTML = `<span class="att-icon att-video"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/></svg></span><span class="name">${escapeHtml(a.name)}</span><span class="meta">${humanSize(a.size)}</span><span class="x" data-i="${i}">×</span>`;
    } else if (a.kind === 'file') {
      // Generic file — unknown / binary. Show the extension + size so the
      // user knows what they've attached even though we can't parse it.
      const label = (a.ext || 'file').toUpperCase();
      chip.innerHTML = `<span class="att-icon">📦</span><span class="name">${escapeHtml(a.name)}</span><span class="meta">${label} · ${humanSize(a.size)}</span><span class="x" data-i="${i}">×</span>`;
    } else {
      // text
      const label = (a.ext || 'txt').toUpperCase();
      chip.innerHTML = `<span class="att-icon">📄</span><span class="name">${escapeHtml(a.name)}</span><span class="meta">${label} · ${humanSize(a.size)}</span><span class="x" data-i="${i}">×</span>`;
    }
    chip.querySelector('.x').addEventListener('click', (e) => {
      state.pendingAttachments.splice(Number(e.target.dataset.i), 1);
      renderAttachments();
    });
    el.appendChild(chip);
  });
}

// ============== TITLE EDIT ==============
// The title is locked by default — it behaves like static text. Click the pen
// icon to unlock it, edit, then press Enter or click away to save. Escape
// cancels and restores the original.
function wireTitleEdit() {
  const input = $('#chat-title');
  const btn = $('#chat-title-edit');
  let savedTitle = '';

  const enterEdit = () => {
    if (!input.hasAttribute('readonly')) return;
    savedTitle = input.value;
    input.removeAttribute('readonly');
    btn.classList.add('editing');
    input.focus();
    input.select();
  };

  const exitEdit = (commit) => {
    if (input.hasAttribute('readonly')) return;
    input.setAttribute('readonly', 'true');
    btn.classList.remove('editing');
    const c = currentChat();
    if (!c) return;
    if (commit) {
      const next = input.value.trim();
      if (next) {
        c.title = next;
        // Mark as user-set so the background AI title generator stops
        // overriding it (current run if in flight, future ones too).
        c.titleManual = true;
      } else input.value = c.title || '';
      saveToStorage();
      renderChatList();
    } else {
      input.value = savedTitle;
    }
  };

  btn.addEventListener('click', () => {
    if (input.hasAttribute('readonly')) enterEdit();
    else exitEdit(true);
  });

  input.addEventListener('blur', () => exitEdit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); exitEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); exitEdit(false); }
  });
}

// ============== COMPOSER ==============
function wireComposer() {
  const form = $('#composer-form');
  const input = $('#composer-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    // Grow up to 6 lines (~145px), matching the CSS max-height; past that the
    // textarea scrolls internally instead of pushing the thread off-screen.
    input.style.height = Math.min(input.scrollHeight, 145) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = currentChat();
    if (!c) return;
    if (c.modality === 'agent' && !c.projectFolder) return;

    const input = $('#composer-input');
    const text = input.value.trim();
    const hasInput = text || state.pendingAttachments.length;

    // Submitting (Enter or arrow-button click) while the AI is running:
    //   - if the input has content → queue the new message; the AI will be
    //     handed it as soon as it finishes the current turn.
    //   - if the input is empty → no-op (the dedicated stop button click
    //     handler below handles abort).
    if (state.runningChats.has(c.id)) {
      if (hasInput) queueMessage(c, text);
      return;
    }
    if (!hasInput) return;
    await dispatchSend();
  });

  // Separate button click handler — fires BEFORE form submit. Only stops when
  // the input is empty; otherwise lets the submit handler queue/send.
  const sendBtn = form.querySelector('.send');
  if (sendBtn) {
    sendBtn.addEventListener('click', (e) => {
      const c = currentChat();
      if (!c) return;
      if (!state.runningChats.has(c.id)) return;
      if ($('#composer-input').value.trim().length > 0) return; // let submit queue
      e.preventDefault();
      e.stopPropagation();
      stopChat(c.id);
      // Stop also clears queued messages — if the user stops, they probably
      // mean "stop everything", not "stop just this one and keep going".
      const before = c.messages.length;
      c.messages = c.messages.filter(m => !m.queued);
      if (c.messages.length !== before) {
        saveToStorage();
        renderActiveChat();
        renderChatList();
      }
    });
  }

  // Keep the button icon (send arrow vs stop square) in sync with the input
  // having text — running + empty input = stop, anything else = send/queue.
  input.addEventListener('input', () => { updateSendButton(); });
}

// Add a user message to the chat without running the model yet. Picks up the
// next round when the current run finishes.
function queueMessage(c, text) {
  const attachments = state.pendingAttachments.slice();
  state.pendingAttachments = [];
  renderAttachments();

  const input = $('#composer-input');
  input.value = '';
  input.style.height = 'auto';

  const userMsg = {
    role: 'user',
    content: text,
    modality: c.modality,
    attachments: attachments.map(a => ({ kind: a.kind, name: a.name, pages: a.pages, ext: a.ext })),
    queued: true,
    _attachmentData: attachments
  };
  c.messages.push(userMsg);
  saveToStorage();
  renderActiveChat();
  renderChatList();
  updateSendButton();
}

// When a run finishes, pull the next queued user message (if any) and process
// it. Each call processes one message and recurses naturally via the next
// `runOllamaChat` completing.
async function processNextQueued(c) {
  const idx = c.messages.findIndex(m => m.role === 'user' && m.queued);
  if (idx < 0) return;
  const msg = c.messages[idx];
  msg.queued = false;
  const attachments = msg._attachmentData || [];
  delete msg._attachmentData;
  saveToStorage();
  renderActiveChat();
  renderChatList();

  await runOllamaChat(c, attachments);
}

// Flash the model picker to draw the eye there — used when the user tries to
// send but hasn't got a usable model selected.
function pulseModelPicker() {
  const t = $('#cs-trigger');
  if (!t) return;
  t.classList.remove('pulse-attention');
  // Force reflow so re-adding the class restarts the animation on repeat sends.
  void t.offsetWidth;
  t.classList.add('pulse-attention');
  setTimeout(() => t.classList.remove('pulse-attention'), 1200);
}

async function dispatchSend() {
  const c = currentChat();
  if (!c) return;
  // Agentic chats are locked until a project folder is selected.
  if (c.modality === 'agent' && !c.projectFolder) {
    return;
  }
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text && !state.pendingAttachments.length) return;

  const modality = c.modality;
  const backend = backendForModel(c.model);

  // Model not usable to send with? Pulse the picker to point the user at it.
  // Two cases: an Ollama model that isn't installed, or a cloud model with no
  // API key. Both mean "you haven't got a working model selected."
  const pick = findPick(c.model);
  const cloudNotReady = pick && pickProvider(pick) !== 'ollama' && !pickReady(pick);
  const ollamaNotInstalled = backend === 'ollama' && !state.installed.has(c.model);
  if (ollamaNotInstalled || cloudNotReady) {
    pulseModelPicker();
    if (ollamaNotInstalled) {
      const banner = $('#install-banner');
      if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const attachments = state.pendingAttachments.slice();
  state.pendingAttachments = [];
  renderAttachments();

  input.value = '';
  input.style.height = 'auto';

  const userMsg = {
    role: 'user', content: text, modality,
    attachments: attachments.map(a => ({ kind: a.kind, name: a.name, pages: a.pages, ext: a.ext }))
  };
  // For video-analysis chats: stash the full video attachment (with .path) on
  // the user message so a retry-after-install can resume without re-picking.
  const _videoAtt = attachments.find(a => a.kind === 'video');
  if (_videoAtt) userMsg._videoAtt = _videoAtt;
  c.messages.push(userMsg);
  autoTitle(c, text);
  touchChat(c.id);
  saveToStorage();
  renderActiveChat();
  renderChatList();

  // First user message in this chat? Kick off background AI title generation
  // (no await — runs in parallel with the actual response).
  const userTurns = c.messages.filter(m => m.role === 'user').length;
  if (userTurns === 1 && !c.titleManual) {
    generateChatTitle(c, text);
  }

  // If the user attached a video in ANY chat (general, agentic, etc.) we
  // run the analysis pipeline first, then fall through to a normal Q&A
  // turn the next time they send. The video context stays on c.videoAnalysis.
  {
    const videoAtt = attachments.find(a => a.kind === 'video');
    if (videoAtt) {
      const assistantMsg = {
        role: 'assistant', content: '', modality: c.modality,
        thinking: true, videoState: { stage: 'starting' }
      };
      c.messages.push(assistantMsg);
      state.runningChats.set(c.id, { channelId: null, abortRequested: false });
      updateSendButton();
      renderActiveChat();
      try {
        await runVideoAnalysis(c, videoAtt, assistantMsg);
      } finally {
        state.runningChats.delete(c.id);
        updateSendButton();
      }
    } else {
      await runOllamaChat(c, attachments);
    }
  }
}

// Run a web search for the user's latest message and append the results to
// that message as context. Used for models that can't reliably emit tool
// calls — it gives them the same web-search ability without needing them to
// call anything. Shows a Search tool-event so the user sees it happened.
async function autoWebSearchInject(c, assistantMsg, history) {
  const lastUser = [...c.messages].reverse().find(m => m.role === 'user');
  const query = (lastUser?.content || '').trim().replace(/\s+/g, ' ').slice(0, 400);
  if (!query || !history.length) return;

  const ev = {
    name: 'web_search',
    argSummary: query.length > 64 ? query.slice(0, 64) + '…' : query,
    status: 'running'
  };
  assistantMsg.toolEvents.push(ev);
  patchLastMessage(assistantMsg);

  let res;
  try { res = await window.api.web.search(query); }
  catch (e) { res = { error: e.message }; }

  if (!res || res.error || !res.results?.length) {
    // A failed search shouldn't block the answer — the model just replies from
    // its own knowledge, same as web-off. Mark the event so it's visible.
    ev.status = 'error';
    ev.resultSummary = res?.error ? 'search failed' : 'no results';
    patchLastMessage(assistantMsg);
    return;
  }

  const top = res.results.slice(0, 5);
  ev.status = 'done';
  ev.resultSummary = `${top.length} result${top.length === 1 ? '' : 's'}`;
  patchLastMessage(assistantMsg);

  const block = top.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  // Append to the user's turn (not a separate system message) — small models
  // follow "here's my question + here are the facts" far more reliably than a
  // detached system block.
  const idx = history.length - 1;
  history[idx] = {
    ...history[idx],
    content: `${history[idx].content || ''}\n\n---\nWeb search results (retrieved just now — answer using these and cite the sources; do NOT say you can't access current information):\n\n${block}`
  };
}

// ============== OLLAMA CHAT (with tool loop + vision bridge) ==============
async function runOllamaChat(c, attachments) {
  // Defensive wrapper: any unhandled exception inside the chat loop would
  // otherwise leave runningChats stuck with this chat's id, freezing the
  // Send button in the Stop state and silently swallowing every subsequent
  // submit (the form handler bails when runningChats.has(c.id) is true).
  // The inner _runOllamaChatInner runs the actual work; this outer finally
  // guarantees cleanup.
  try {
    await _runOllamaChatInner(c, attachments);
  } catch (e) {
    console.error('runOllamaChat fatal:', e);
    const lastMsg = c.messages[c.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.thinking = false;
      if (!lastMsg.content) {
        lastMsg.content = `**Chat crashed.** ${e?.message || e}\n\n_If this keeps happening, please file an issue with the chat-debug.log from Sanctum's user-data folder._`;
        try { patchLastMessageContent(lastMsg); } catch {}
      }
    }
  } finally {
    state.runningChats.delete(c.id);
    try { updateSendButton(); } catch {}
  }
}

async function _runOllamaChatInner(c, attachments) {
  // Show loading indicator inside the assistant bubble until first content
  // arrives or a tool fires. `thinkingMode` separately tracks whether Qwen3's
  // /think reasoning is active for this turn — only THEN do we label the
  // indicator "Thinking" with a star. Otherwise it's just bubbles.
  const assistantMsg = {
    role: 'assistant',
    content: '',
    modality: c.modality,
    toolEvents: [],
    thinking: true,
    thinkingMode: !!(c.thinkingEnabled && modelSupportsThinking(c.model)),
    // Initialize the token badge at "~0 tokens" so it's visible from the very
    // first frame, including the silent thinking / tool-call phase where no
    // content streams in. The chunk handler updates it live; `done` snaps it
    // to the exact count from Ollama.
    tokenStats: { prompt: 0, completion: 0, _exactCompletion: 0, live: true }
  };
  c.messages.push(assistantMsg);
  // Mark this chat as running so the send button flips to a stop button.
  state.runningChats.set(c.id, { channelId: null, abortRequested: false });
  updateSendButton();
  renderActiveChat();

  // Build conversation history from prior messages (excluding the placeholder we just pushed)
  const history = c.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content || '' }));

  // System messages, ordered so the final history is:
  //   [global instructions] [project folder context] [mode prompt] [messages…]
  // Unshifts run in reverse order to build that.
  if (c.modality === 'agent' && c.approvalMode) {
    history.unshift({ role: 'system', content: APPROVAL_MODE_PROMPT });
  }
  if (c.modality === 'agent' && c.planMode) {
    history.unshift({ role: 'system', content: PLAN_MODE_PROMPT });
  }
  if (c.modality === 'agent' && c.noApproval) {
    history.unshift({ role: 'system', content: NO_APPROVAL_PROMPT });
  }
  // Web-search nudge — small/medium local models don't reliably call tools on
  // their own unless the system prompt tells them to. Without this, a chat
  // with web_search enabled still gets pure hallucination on questions about
  // current events / today's prices / recent releases, because the model
  // never invokes the tool. Inject this whenever web_search is in the
  // toolset, regardless of modality.
  if (c.webEnabled && modelSupportsTools(c.model)) {
    history.unshift({ role: 'system', content: WEB_SEARCH_PROMPT });
  }
  if (c.projectFolder) {
    const pf = projectFolderPrompt(c);
    if (pf) history.unshift({ role: 'system', content: pf });
  }
  if (state.settings.instructions?.trim()) {
    history.unshift({ role: 'system', content: state.settings.instructions.trim() });
  }
  // Video-analysis chats: inject the full timeline + transcript as the
  // outermost system message so the model can answer "what's at 0:42" /
  // "is the speaker male or female" without us re-running the pipeline.
  // Any chat (general OR agentic) with an analysed video gets the timeline +
  // transcript injected as a system message — so Q&A can reference moments.
  if (c.videoAnalysis) {
    const videoCtx = buildVideoContext(c);
    if (videoCtx) history.unshift({ role: 'system', content: videoCtx });
  }

  // Append PDF text to the latest user message
  const pdfs = (attachments || []).filter(a => a.kind === 'pdf');
  if (pdfs.length) {
    const pdfBlock = pdfs.map(p => `\n\n--- PDF: ${p.name} (${p.pages} pages) ---\n${(p.text || '').slice(0, 30000)}`).join('');
    history[history.length - 1].content = (history[history.length - 1].content || '') + pdfBlock;
  }
  // Append plain-text / code-file content to the latest user message.
  const texts = (attachments || []).filter(a => a.kind === 'text');
  if (texts.length) {
    const textBlock = texts.map(t => `\n\n--- File: ${t.name}${t.ext ? ` (.${t.ext})` : ''} ---\n${(t.text || '').slice(0, 60000)}`).join('');
    history[history.length - 1].content = (history[history.length - 1].content || '') + textBlock;
  }
  // Inject generic-file metadata so the model knows what was attached even
  // though we didn't unwrap the bytes. Agents can then read it via tools.
  const genericFiles = (attachments || []).filter(a => a.kind === 'file');
  if (genericFiles.length) {
    const fileBlock = genericFiles.map(f =>
      `\n\n[Attached file: ${f.name}${f.ext ? ` (.${f.ext})` : ''} · ${humanSize(f.size)} · path: ${f.path}]`
    ).join('');
    history[history.length - 1].content = (history[history.length - 1].content || '') + fileBlock;
  }

  // Ollama thinking is passed as the native `think` parameter (see the
  // payload build below), not by appending /think to the user's message.
  // The old text-directive approach polluted the prompt and left the
  // reasoning inline in the answer as <think> tags; the native switch
  // returns it in a separate field with clean start/stop timing.
  let imageAttachments = (attachments || []).filter(a => a.kind === 'image');
  let imgs = imageAttachments.map(a => a.base64);

  // VISION BRIDGE: if the active model can't natively see images but the user
  // attached some, route each through an installed vision model first and
  // inject the description as text.
  //
  // SKIP this bridge for cloud picks (Claude / Gemini). Those models are
  // multimodal on their own (Claude reads images, Gemini reads images +
  // PDFs natively) — running them through a local Qwen2.5-VL captioning
  // pass first is both wasteful and loses fidelity. v0.3.3 short-circuits
  // here; sending raw image bytes to cloud providers is a TODO for a
  // follow-up release.
  const _activePick = findPick(c.model);
  const _activeIsCloud = pickProvider(_activePick) !== 'ollama';
  if (imageAttachments.length && !isMultimodal(c.model) && !_activeIsCloud) {
    const router = getVisionRouter(c.model);
    if (!router) {
      assistantMsg.content = `I can't read images with this text-only model and no vision model is installed locally.

Install one from your terminal:

\`\`\`bash
ollama pull qwen2.5vl:7b
\`\`\`

…or download **Qwen2.5-VL 7B** / **Llama 3.2 Vision 11B** directly from the model picker (top-right) — they show up under *General Chat & Reasoning* with a download icon. Then re-send your message.`;
      touchChat(c.id);
      saveToStorage();
      renderActiveChat();
      renderChatList();
      return;
    }
    const captions = [];
    for (const img of imageAttachments) {
      const ev = { name: 'describe_image', argSummary: img.name, status: 'running' };
      assistantMsg.toolEvents.push(ev);
      patchLastMessage(assistantMsg);
      try {
        const caption = await runVisionCaption(router, img.base64);
        ev.status = 'done';
        const words = caption.split(/\s+/).filter(Boolean).length;
        ev.resultSummary = `${words} words`;
        captions.push({ name: img.name, caption });
      } catch (e) {
        ev.status = 'error';
        ev.resultSummary = 'failed';
        captions.push({ name: img.name, caption: '(failed to describe image)' });
      }
      patchLastMessage(assistantMsg);
    }
    const visionBlock = captions.map(c => `[Image: ${c.name}]\n${c.caption}`).join('\n\n');
    history[history.length - 1].content = visionBlock + '\n\n' + (history[history.length - 1].content || '');
    imgs = []; // text-only model — don't send raw pixels
  }

  const tools = buildTools(c.modality, c.webEnabled === true, c.model, c);
  const useTools = !!tools;

  // Search-and-inject fallback: models that can't emit tool calls still get
  // web search — Sanctum runs the search itself and appends the results to the
  // user's message as context. This is why web search works on EVERY model,
  // not just the tool-capable ones. Tool-capable models skip this (they call
  // web_search on their own, only when they decide it's needed).
  if (c.webEnabled && !modelSupportsTools(c.model) && c.modality !== 'agent') {
    await autoWebSearchInject(c, assistantMsg, history);
  }

  // The model you picked is the model that answers. There used to be a code
  // auto-route here that silently swapped in a local coding model whenever a
  // message looked code-shaped — it guessed wrong often, and being answered
  // by a model you didn't choose is worse than a slightly weaker answer from
  // the one you did. Coding models are selectable in the picker now, so the
  // choice is yours to make explicitly.
  const effectiveModel = c.model;

  const MAX_ROUNDS = Math.max(1, Math.min(50, c.maxSteps || 5));
  let round = 0;
  let aborted = false;
  let lastContent = '';

  while (round < MAX_ROUNDS && !aborted) {
    round++;
    // Stop button can be clicked between rounds or mid-tool-execution. The
    // chunk handler only sees aborts during a live stream; check the user's
    // explicit abortRequested flag here too so the loop terminates promptly.
    if (state.runningChats.get(c.id)?.abortRequested) { aborted = true; break; }

    // Route to either the local Ollama daemon or a cloud provider depending on
    // the picked model. Both APIs emit the same chunk shape ({message: {content,
    // tool_calls}, done, prompt_eval_count, eval_count}) so the rest of this
    // loop is provider-agnostic.
    const pick = findPick(effectiveModel);
    const provider = pickProvider(pick);
    const isCloud = provider !== 'ollama';

    const payload = isCloud
      ? {
          provider,
          apiKey: state.settings.apiKeys?.[provider] || '',
          model: pick?.model_id || effectiveModel,
          messages: history,
          tools: tools || undefined,
          // Forwarded to streamAnthropic / streamGoogle which translate it to
          // the provider-native thinking parameter. Only meaningful when the
          // pick is thinking_capable; ignored otherwise.
          options: { thinking_enabled: !!c.thinkingEnabled }
        }
      : { model: effectiveModel, messages: history };
    if (!isCloud) {
      // Context window resolution order:
      //   1. this chat's own override (agent opts panel)
      //   2. the per-model pin from Settings -> Context Windows
      //   3. the hardware-aware suggestion for this machine
      //   4. a conservative 8K
      // Oversizing here is what makes big models OOM — the KV cache for 32K on
      // a 30B model is several GB on its own.
      payload.options = { num_ctx: c.contextWindow || contextWindowFor(effectiveModel) };
      // Native Ollama thinking switch — only for models that actually have a
      // thinking mode, or Ollama rejects the request.
      if (modelSupportsThinking(effectiveModel)) {
        payload.options.think = !!c.thinkingEnabled;
      }
      if (tools) payload.tools = tools;
      if (round === 1 && imgs.length) payload.images = imgs;
    }

    let acc = '';
    let collectedToolCalls = [];
    // The in-flight "Thinking…" row, if this round has one. Closed out by
    // endThinking() when reasoning finishes, which stamps the elapsed time so
    // the row becomes a permanent "Thought for Ns".
    let thinkEvent = null;
    const endThinking = () => {
      if (!thinkEvent || thinkEvent.status !== 'running') return;
      thinkEvent.status = 'done';
      thinkEvent.ms = Date.now() - thinkEvent.startedAt;
      patchLastMessage(assistantMsg);
    };
    // Approximate tokens from streamed thinking text (~4 chars/token). Ollama
    // and Gemini stream the reasoning text so we can count it live; Anthropic
    // at display:"omitted" streams empty thinking, so its count stays 0.
    const addThinkingText = (txt) => {
      if (!thinkEvent || !txt) return;
      thinkEvent.chars = (thinkEvent.chars || 0) + txt.length;
      thinkEvent.tokens = Math.max(1, Math.round(thinkEvent.chars / 4));
      // Patch the count in place — Ollama streams reasoning token-by-token, so
      // a full re-render per chunk would flicker. Fall back to a full render
      // only if the running row isn't mounted yet.
      const row = $('#thread')?.querySelector('.think-row.running');
      const span = row?.querySelector('.think-tokens');
      if (span) span.textContent = `${thinkEvent.tokens.toLocaleString()} tokens`;
      else patchLastMessage(assistantMsg);
    };

    const chatFn = isCloud ? window.api.cloud?.chat : window.api.ollama.chat;
    if (typeof chatFn !== 'function') {
      // Belt-and-braces: if the preload bridge somehow didn't expose the cloud
      // surface (older preload bundled with a newer renderer, for example),
      // surface that clearly instead of throwing into the void.
      const provLabel = provider === 'anthropic' ? 'Anthropic' : provider === 'google' ? 'Google' : provider;
      assistantMsg.content = `**Cloud bridge missing.** The preload script for this build doesn't expose the ${provLabel} chat endpoint. Quit and reopen Sanctum; if the problem persists, this is a bug — please file an issue.`;
      assistantMsg.thinking = false;
      aborted = true;
      patchLastMessageContent(assistantMsg);
      break;
    }
    try {
      await chatFn(payload, (chunk) => {
      // First chunk: record the channelId so a click on Stop can abort this
      // stream. If Stop was clicked BEFORE the first chunk arrived (which is
      // common on slow models with long first-token latency), abortRequested
      // is already true but stopChat() couldn't fire chatAbort because the
      // channelId wasn't known yet. Fire it here as soon as we learn it —
      // otherwise the stream finishes naturally and the user thinks Stop is
      // broken.
      if (chunk._channelId) {
        const run = state.runningChats.get(c.id);
        if (run) {
          run.channelId = chunk._channelId;
          if (run.abortRequested && !run._lateAbortSent) {
            run._lateAbortSent = true;
            if (chunk._channelId.startsWith('cloud:')) window.api.cloud.chatAbort(chunk._channelId);
            else window.api.ollama.chatAbort(chunk._channelId);
          }
        }
      }
      if (chunk.aborted) {
        // Clean exit caused by the user pressing Stop. Don't surface an error.
        aborted = true;
        return;
      }
      if (chunk.error) {
        // Surface the actual provider error verbatim so the user can see WHY
        // it failed. Ollama-specific friendlyOllamaError rewrites only apply
        // when the failing call WAS to Ollama — running them on a cloud error
        // produces nonsense like 'Anthropic API error. Couldn't reach
        // Ollama.' when an Anthropic request's `fetch failed` is rewritten by
        // the Ollama-flavoured matcher.
        const cloudPick = findPick(effectiveModel);
        const cloudProv = pickProvider(cloudPick);
        const isCloudErr = cloudProv !== 'ollama';
        const provLabel = cloudProv === 'anthropic' ? 'Anthropic' : cloudProv === 'google' ? 'Google' : cloudProv;
        const rawErr = String(chunk.error || '');
        if (isCloudErr) {
          const hint = /fetch failed|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(rawErr)
            ? `\n\n_Network error — check your internet connection. If your machine is online, ${provLabel}'s API may be having a brief outage; try again in a minute._`
            : `\n\n_Double-check your API key in **Settings → API Keys**, and confirm the model id is current._`;
          acc = `**${provLabel} API error.** ${rawErr}${hint}`;
        } else {
          acc = friendlyOllamaError(chunk.error, c);
        }
        assistantMsg.content = acc;
        assistantMsg.thinking = false;
        aborted = true;
        patchLastMessageContent(assistantMsg);
        return;
      }
      if (chunk.message?.content) {
        if (assistantMsg.thinking) assistantMsg.thinking = false;
        acc += chunk.message.content;
        assistantMsg.content = acc;
        // Live token estimate during streaming. Ollama doesn't expose per-chunk
        // counts so we approximate completion tokens as chars/4 (a common
        // heuristic for English LLM tokenizers). Exact counts overwrite this
        // when the final `done` chunk lands.
        const baseCompletion = (assistantMsg.tokenStats && assistantMsg.tokenStats._exactCompletion) || 0;
        assistantMsg.tokenStats = {
          prompt: assistantMsg.tokenStats?.prompt || 0,
          completion: baseCompletion + Math.ceil(acc.length / 4),
          _exactCompletion: baseCompletion,
          live: true
        };
        patchLastMessageContent(assistantMsg);
      }
      // Thinking timing. Providers signal it differently (Anthropic sends
      // thinking content blocks, Gemini flags thought parts, Ollama returns a
      // separate `thinking` field) — main.js normalises all three into
      // { thinking: { phase } } / { message: { thinking } }.
      //
      // The record is pushed into toolEvents so it renders INLINE, in
      // sequence, and stays where it happened rather than jumping to the end
      // of the message.
      if (chunk.thinking?.phase === 'start' || (chunk.message?.thinking != null && !thinkEvent)) {
        if (!thinkEvent) {
          thinkEvent = { name: '__think', status: 'running', startedAt: Date.now(), chars: 0, tokens: 0 };
          assistantMsg.toolEvents.push(thinkEvent);
          assistantMsg.thinking = false;   // the inline row is the indicator now
          patchLastMessage(assistantMsg);
        }
      }
      // Accumulate streamed reasoning text for the live token count.
      if (typeof chunk.message?.thinking === 'string') addThinkingText(chunk.message.thinking);
      if (typeof chunk.thinking?.text === 'string') addThinkingText(chunk.thinking.text);

      if (chunk.thinking?.phase === 'end') endThinking();
      // Ollama has no explicit end signal — the first real content token after
      // a thinking field means reasoning is done.
      if (chunk.message?.content && thinkEvent?.status === 'running') endThinking();

      if (chunk.message?.tool_calls?.length) {
        if (assistantMsg.thinking) assistantMsg.thinking = false;
        endThinking();
        collectedToolCalls.push(...chunk.message.tool_calls);
      }
      // Final stream chunk carries Ollama's tokenizer counts. In multi-round
      // tool loops we want the SUM across rounds, not just the last round —
      // so accumulate per round here and lock in the exact figure.
      if (chunk.done) {
        const prev = assistantMsg.tokenStats || {};
        const exactCompletion = (prev._exactCompletion || 0) + (chunk.eval_count || 0);
        assistantMsg.tokenStats = {
          prompt: (prev.prompt || 0) + (chunk.prompt_eval_count || 0),
          completion: exactCompletion,
          _exactCompletion: exactCompletion,
          live: false
        };
        // Reset acc for the next tool round (live estimate restarts at 0).
        acc = '';
        patchLastMessage(assistantMsg);
      }
    });
    } catch (e) {
      // The IPC bridge or the underlying fetch can throw before any chunk
      // arrives (transport-level failure: DNS, TLS, malformed payload, etc.).
      // Without this catch the await would propagate up the stack and freeze
      // the chat in a 'thinking forever' state. Surface the error and break.
      const provLabel = provider === 'anthropic' ? 'Anthropic' : provider === 'google' ? 'Google' : provider || 'cloud';
      const detail = (e && e.message) ? e.message : String(e);
      assistantMsg.content = isCloud
        ? `**${provLabel} request failed.** ${detail}\n\n_If this keeps happening, double-check your API key in **Settings → API Keys** and that the model id is current._`
        : `**Chat failed.** ${detail}`;
      assistantMsg.thinking = false;
      aborted = true;
      patchLastMessageContent(assistantMsg);
    }

    // Stream over — if the model was still "thinking" (aborted mid-reason, or
    // a provider that never sent an end signal), close the row out so it can
    // never be left spinning forever.
    endThinking();

    if (aborted) break;
    lastContent = acc;

    if (!collectedToolCalls.length) break;

    // Record assistant turn in history (for tool feedback loop)
    history.push({ role: 'assistant', content: acc, tool_calls: collectedToolCalls });

    // Execute each tool, append results
    for (const call of collectedToolCalls) {
      // Honor a Stop click that happened while the previous tool was running
      // (or between two tools). Without this, a 3-tool batch keeps running
      // every tool before the loop notices the abort.
      if (state.runningChats.get(c.id)?.abortRequested) { aborted = true; break; }

      const name = call.function?.name || call.name;
      let args = call.function?.arguments || call.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }

      const ev = {
        name,
        argSummary: summarizeArgs(name, args),
        status: 'running'
      };
      // Capture the raw command up-front for shell tools so the IN box can
      // show it even before the call completes (running state).
      if (name === 'run_command' || name === 'run_command_async') {
        ev.input = toStringArg(args?.command);
      }
      assistantMsg.toolEvents.push(ev);
      patchLastMessage(assistantMsg);

      const { result, summary, ok } = await executeTool(name, args);
      ev.status = ok ? 'done' : 'error';
      ev.resultSummary = summary;
      // Stash shell output (stdout/stderr) on the event so the OUT box can
      // render it. Truncate to keep the bubble manageable — full content is
      // already in the tool-result message in `history` for the model.
      if (name === 'run_command' || name === 'run_command_async') {
        const stdout = (result && typeof result === 'object' && result.stdout) || '';
        const stderr = (result && typeof result === 'object' && result.stderr) || '';
        const combined = [stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n');
        ev.output = combined.length > 4000 ? combined.slice(0, 4000) + `\n… (${combined.length - 4000} more chars)` : combined;
        if (result && typeof result === 'object' && typeof result.exitCode === 'number') {
          ev.exitCode = result.exitCode;
        }
      }
      patchLastMessage(assistantMsg);

      // Capture the tool_call_id (Anthropic) and tool_name (Gemini) so cloud
      // providers can match the result back to the original tool_use /
      // functionCall. Ollama ignores both fields, so it's safe to always
      // include them.
      history.push({
        role: 'tool',
        tool_call_id: call.id || call.tool_call_id,
        tool_name: name,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }
    if (aborted) break;
    // Clear accumulated content so next round starts with the model's continuation
    assistantMsg.content = '';
    patchLastMessage(assistantMsg);
  }

  // If the loop ended without a content turn after tools, restore the last text we got
  if (!assistantMsg.content && lastContent) assistantMsg.content = lastContent;

  // Stream ended (success / error / user abort) — clear the running flag and
  // flip the send button back to its arrow.
  assistantMsg.thinking = false;
  state.runningChats.delete(c.id);
  updateSendButton();

  touchChat(c.id);
  saveToStorage();
  renderChatList();
  renderActiveChat();

  // If the user queued more messages while this one was generating, pick up
  // the next one automatically.
  if (!aborted) await processNextQueued(c);
}

// Stop the current assistant turn — aborts the Ollama fetch via main process.
function stopChat(chatId) {
  const run = state.runningChats.get(chatId);
  if (!run) return;
  run.abortRequested = true;
  // Reflect the stop in the UI IMMEDIATELY so the user gets instant feedback.
  // The actual abort cycle (fetch interrupt → server-side aborted chunk →
  // promise resolve → break loop) takes several hundred ms; without an
  // immediate visual cue the user thinks the button didn't fire and clicks
  // again. We drop the thinking dots on the in-flight assistant message and
  // mark it as stopped if no content arrived yet.
  const c = state.chats[chatId];
  const lastMsg = c?.messages?.[c.messages.length - 1];
  if (lastMsg && lastMsg.role === 'assistant' && lastMsg.thinking) {
    lastMsg.thinking = false;
    if (!lastMsg.content && !(lastMsg.toolEvents && lastMsg.toolEvents.length)) {
      lastMsg.content = '_Stopped._';
    }
    try { patchLastMessage(lastMsg); } catch {}
  }
  if (run.channelId) {
    // Cloud streams have channelIds that start with "cloud:" — route the
    // abort to the right handler so we don't get an "unknown channel" no-op.
    if (run.channelId.startsWith('cloud:')) window.api.cloud.chatAbort(run.channelId);
    else window.api.ollama.chatAbort(run.channelId);
  }
  if (run.videoChannelId) window.api.video.abort(run.videoChannelId);
}

// Swap the send-button icon between Send (arrow) and Stop (square) based on
// whether the active chat is currently generating.
function updateSendButton() {
  const btn = document.querySelector('.composer .send');
  if (!btn) return;
  const c = currentChat();
  const running = !!(c && state.runningChats && state.runningChats.has(c.id));
  const input = document.querySelector('#composer-input');
  const hasText = !!(input && input.value.trim().length);
  // Running + empty input = STOP (square). Otherwise = SEND/QUEUE (arrow);
  // submitting while running queues the message for after the current turn.
  if (running && !hasText) {
    btn.classList.add('stopping');
    btn.setAttribute('aria-label', 'Stop');
    btn.setAttribute('title', 'Stop the current response');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
  } else {
    btn.classList.remove('stopping');
    btn.setAttribute('aria-label', running ? 'Queue message' : 'Send');
    btn.setAttribute('title', running ? 'Queue this message — will send after the current response finishes' : 'Send');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
  }
}

const TOOL_DEFS = {
  web_search: { type: 'function', function: { name: 'web_search', description: 'Search the public web (DuckDuckGo) for up-to-date information. Returns a list of {url, title, snippet}.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  web_fetch:  { type: 'function', function: { name: 'web_fetch',  description: 'Fetch a URL and return its readable text content (HTML stripped, capped at 20k chars).', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full http(s) URL' } }, required: ['url'] } } },
  calc:       { type: 'function', function: { name: 'calc', description: 'Evaluate a simple numeric expression (digits, + - * / parens only).', parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } } },
  read_file:  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file from the local disk. Relative paths resolve from the user home dir. Max 200 KB.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  list_dir:   { type: 'function', function: { name: 'list_dir',  description: 'List entries of a directory. Returns up to 200 items each with name/kind/size.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  write_file: { type: 'function', function: { name: 'write_file', description: 'Overwrite a file with the given content. Creates parent directories. REQUIRES USER APPROVAL — do not call lightly.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  apply_patch: { type: 'function', function: { name: 'apply_patch', description: 'Apply a single search-and-replace edit to a file. `find` must match exactly and uniquely (include surrounding context to disambiguate). `replace` can be empty to delete the matched chunk. REQUIRES USER APPROVAL.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } } },
  run_command: { type: 'function', function: { name: 'run_command', description: 'Run a shell command. Returns {stdout, stderr, exitCode}. REQUIRES USER APPROVAL on every call.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Working directory (optional, defaults to home).' } }, required: ['command'] } } },
  glob: { type: 'function', function: { name: 'glob', description: 'Find files matching a glob pattern under the project folder. Supports `*` (any chars except /), `**` (any chars including /), `?` (one char). Returns paths relative to the project root. Skips node_modules, .git, dist, build, etc. by default. Capped at 500 matches.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "**/*.test.js"' } }, required: ['pattern'] } } },
  grep: { type: 'function', function: { name: 'grep', description: 'Search file CONTENTS using a regex. Walks the project tree, skips binaries and large files, returns {file, line, text} matches. Capped at 100 matches across at most 10000 files.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regex pattern (no slashes, no flags — pass case_insensitive separately).' }, glob: { type: 'string', description: 'Optional glob to restrict the search (e.g. "**/*.py").' }, case_insensitive: { type: 'boolean', description: 'Match case-insensitively.' } }, required: ['pattern'] } } },
  run_command_async: { type: 'function', function: { name: 'run_command_async', description: 'Start a shell command in the BACKGROUND. Returns a task_id immediately so you can continue working while it runs. Use task_status(task_id) to poll progress and stdout/stderr, task_kill(task_id) to stop it. REQUIRES USER APPROVAL on every call.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Working directory (optional).' } }, required: ['command'] } } },
  task_status: { type: 'function', function: { name: 'task_status', description: 'Check on a background task started with run_command_async. Returns {status, exitCode, stdout, stderr, runtime_seconds}. Status is "running" | "done" | "killed" | "error".', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } } },
  task_list: { type: 'function', function: { name: 'task_list', description: 'List all background tasks in this session with their current status.', parameters: { type: 'object', properties: {} } } },
  task_kill: { type: 'function', function: { name: 'task_kill', description: 'Kill a running background task by id. No-op if already done.', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } } },
  mcp_list_servers: { type: 'function', function: { name: 'mcp_list_servers', description: 'List all configured Model Context Protocol (MCP) servers and their status (ready / starting / error / stopped) along with the tools each exposes. Useful to see what external integrations (Blender, Playwright, etc.) are currently available.', parameters: { type: 'object', properties: {} } } },
  mcp_add_server:   { type: 'function', function: { name: 'mcp_add_server', description: 'Register and start a new MCP server. Pass `name` (your label), `command` (the executable e.g. "npx", "uvx", "python"), optional `args` (array of arguments), and optional `env` (object of env vars). The server spawns immediately and its tools become available to you on the next turn. REQUIRES USER APPROVAL since it executes a local subprocess.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Server name (used for tool prefix mcp__<name>__<tool>).' }, command: { type: 'string', description: 'Executable to run, e.g. "npx" or "uvx".' }, args: { type: 'array', items: { type: 'string' }, description: 'Args array, e.g. ["-y", "@playwright/mcp@latest"].' }, env: { type: 'object', description: 'Extra environment variables {KEY: VALUE}.' } }, required: ['name', 'command'] } } },
  mcp_remove_server: { type: 'function', function: { name: 'mcp_remove_server', description: 'Stop and delete a configured MCP server by name. Frees its config slot; its tools will no longer appear. REQUIRES USER APPROVAL.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  exit_plan_mode: { type: 'function', function: { name: 'exit_plan_mode', description: 'Exit Plan Mode by surfacing your plan to the user for approval. The user sees the plan in a modal with Approve / Reject buttons. On Approve the chat flips to Approval Mode and you can execute (each write tool still pops a per-call approval). On Reject the tool returns "rejected by user" and you stay in Plan Mode — refine the plan and call again when ready. ONLY call this when your plan is complete and ready for the user to review.', parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The full plan, written as numbered steps with the tools you intend to call, files/state that will be touched, and any risks. Markdown is rendered.' } }, required: ['plan'] } } },
};

const WEB_SEARCH_PROMPT = `You have a web_search tool that returns live results from the public web (DuckDuckGo). Use it WITHOUT being asked whenever the user's question depends on information you cannot answer with confidence from your training:
- Anything time-sensitive (today's news / weather / sports scores, current prices, recent releases, "latest" / "newest" anything, dates after your knowledge cutoff).
- Specific facts you would otherwise have to guess at (someone's current job title, a project's exact version number, a company's latest blog post).
- Verifying a claim the user made that you're not 100% sure about.

How to use it:
1. Call \`web_search\` with a tight, focused query (3–8 words, like a search engine query — not a sentence).
2. The tool returns a list of {url, title, snippet}. Pick the best 1–3 results and call \`web_fetch\` on each url to read the full page.
3. Cite the page title and url inline when you use the information. Do not fabricate quotes or page contents you didn't actually fetch.

If you're unsure whether to search: search anyway. A useless search is cheap; a confident-sounding hallucination is not. Do NOT tell the user "I don't have access to current information" — you do, via this tool.`;

const NO_APPROVAL_PROMPT = `NO-APPROVAL MODE IS ACTIVE.

Every tool call you make — including shell commands (run_command, run_command_async), file writes (write_file, apply_patch), and MCP server management (mcp_add_server, mcp_remove_server) — executes IMMEDIATELY with no approval modal. The user opted into this knowing the risks.

Therefore:
- Be decisive. When the user asks for something, do it. Don't preface with "this will execute immediately" or "are you sure?" warnings. They know.
- Sanity-check yourself before destructive commands. There is no second pair of eyes here. Read before you write. Glob before you rm. Confirm the path is correct before you overwrite.
- If you would normally pause to ask "should I proceed?" — don't ask. Either commit and execute, or explicitly note in your reply why you stopped (e.g. "I won't run this because the path falls outside the project folder").
- Stay inside the project folder and any path allowlist unless the user explicitly directs you outside it.`;

const APPROVAL_MODE_PROMPT = `APPROVAL MODE IS ACTIVE.

Every tool call you make automatically triggers an approval modal that shows the user the exact command, path, or arguments — they approve or deny each call as it happens. This is enforced by the app, not by you.

Therefore:
- Do NOT ask the user for verbal confirmation in chat. No "are you sure?", no "please type yes to proceed", no "this action is irreversible — confirm". The modal already handles that.
- Do NOT add safety preambles or warnings before calling tools. Just call the tool. The user sees exactly what you're about to do in the modal.
- Be decisive. When the user asks for something, do it — call the tools needed in order, immediately.
- If the user denies a tool call, the tool returns {error: "denied by user"} — respect that and adapt.

When the user asks you to do something destructive (delete files, etc.), trust that they mean it. Their request IS the approval to attempt. The per-call modal is the final safety check.`;

function projectFolderPrompt(c) {
  if (!c.projectFolder) return null;
  const isWindows = /^[A-Za-z]:[\\/]/.test(c.projectFolder);
  const sep = isWindows ? '\\\\' : '/';
  const platform = isWindows ? 'Windows (cmd.exe)' : 'POSIX (/bin/sh)';
  const shellExamples = isWindows
    ? '`dir`, `del /q /f`, `rmdir /s /q`, `move`, `copy`, `type`. Paths use backslash separators (e.g. `src\\\\index.js`).'
    : '`ls`, `rm -rf`, `mv`, `cp`, `cat`. Paths use forward slashes.';

  return `PROJECT FOLDER: ${c.projectFolder}

This chat is scoped to the folder above by default. All file and shell operations are expected to work inside it.

PATHS:
- For read_file / list_dir / write_file / apply_patch: prefer absolute paths inside the project folder, e.g. \`${c.projectFolder}${sep}filename.ext\`. Relative paths like \`project/\` or \`./\` resolve from the user's home directory (not the project folder).
- IMPORTANT — you CAN try paths outside the project folder. If the user asks you to read or write outside this folder, just call the tool with the absolute path. The app will pop an approval modal showing the requested path and let the user grant access ("Just this once", "Allow this folder", or "Deny"). If they approve, the call succeeds and you can continue. If they deny, you'll receive {error: "...outside the allowed roots..."} — only then should you explain you couldn't access it.
- DO NOT preemptively refuse paths outside the project folder. The user has explicit control via the approval modal — don't take their choice away.

SHELL:
- Platform: ${platform}.
- Use ${shellExamples}
- Always pass \`cwd\` set to "${c.projectFolder}" when calling run_command, unless the user explicitly asks you to run somewhere else.
- Do not mix shells. \`rm\` does not exist on Windows; \`del\` does not exist on POSIX.

When the user says "the project folder" or "this folder", they mean: ${c.projectFolder}`;
}

const PLAN_MODE_PROMPT = `PLAN MODE IS ACTIVE.

You are in Plan Mode. You CANNOT run commands or write files here — those tools are blocked. Your job is to help plan the work, and only once the user has actually asked for a task.

If the user is just greeting you (e.g. "hi", "hey", "hello"), making small talk, or hasn't asked for anything concrete yet: simply greet them back in one short sentence and ask what they'd like to work on. Do NOT investigate, do NOT read files, do NOT draft a plan, do NOT call any tools. There is nothing to plan yet.

Only when the user asks for an actual task (fix a bug, add a feature, change something):
1. Optionally use the read-only tools (read_file, list_dir, glob, grep, web_search, web_fetch) to check the relevant files first — briefly, only what you need.
2. Write a short, concrete plan: the steps you'd take and the files you'd change.
3. Call \`exit_plan_mode\` with that plan. It shows the user an Approve / Reject dialog. On Approve the chat switches to Approval Mode and you can start doing the work (each change still needs approval). On Reject, refine and call it again.

Keep it proportional: a one-line change needs a one-line plan, not a full investigation. Write tools (write_file, apply_patch, run_command, etc.) return an error until the user approves your plan — don't call them yet.`;

// Auto-route: given the user's current chat/agent model, find the tier-matched
// model in another category. So "smartest chat" → "smartest image", etc.

function buildTools(modality, webEnabled, modelId, chat) {
  // Don't send tools to a model that can't reliably emit them.
  if (modelId && !modelSupportsTools(modelId)) return null;
  const readOnly = !!chat?.readOnly;
  const noFetch  = !!chat?.noFetch;
  const tools = [];
  if (webEnabled) {
    tools.push(TOOL_DEFS.web_search);
    if (!noFetch) tools.push(TOOL_DEFS.web_fetch);
  }
  if (modality === 'code') {
    tools.push(TOOL_DEFS.read_file, TOOL_DEFS.list_dir);
    tools.push(TOOL_DEFS.glob, TOOL_DEFS.grep);
    if (!readOnly) tools.push(TOOL_DEFS.apply_patch);
  }
  if (modality === 'agent') {
    tools.push(TOOL_DEFS.calc, TOOL_DEFS.read_file, TOOL_DEFS.list_dir);
    tools.push(TOOL_DEFS.glob, TOOL_DEFS.grep);
    if (!readOnly) {
      tools.push(TOOL_DEFS.write_file, TOOL_DEFS.run_command);
      tools.push(TOOL_DEFS.run_command_async, TOOL_DEFS.task_status, TOOL_DEFS.task_list, TOOL_DEFS.task_kill);
      // MCP server management. mcp_list_servers is always safe; add/remove
      // run a subprocess so they go through the approval modal.
      tools.push(TOOL_DEFS.mcp_list_servers, TOOL_DEFS.mcp_add_server, TOOL_DEFS.mcp_remove_server);
    } else {
      tools.push(TOOL_DEFS.mcp_list_servers);
    }
    // Plan Mode: also expose exit_plan_mode so the agent can formally end
    // the planning phase. Writes still go through the executor-level gate
    // (executeToolImpl returns an error for them while planMode is on).
    if (chat?.planMode) {
      tools.push(TOOL_DEFS.exit_plan_mode);
    }
    // Tools exposed by user-configured MCP servers (Blender, Playwright, etc.)
    // appear here too. The cache is refreshed from main on every status/tools
    // event, so a newly-started server's tools show up on the next turn.
    if (Array.isArray(state.mcpTools) && state.mcpTools.length) {
      tools.push(...state.mcpTools);
    }
  }
  return tools.length ? tools : null;
}

// Safe coercion for tool-call argument extraction. Models sometimes return
// nested objects, numbers, or null where a string is expected — turn that
// into something usable instead of letting "[object Object]" leak into the UI.
function toStringArg(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

function summarizeArgs(name, args) {
  if (!args) return '';
  const pickField = {
    web_search:        'query',
    web_fetch:         'url',
    calc:              'expr',
    read_file:         'path',
    list_dir:          'path',
    write_file:        'path',
    apply_patch:       'path',
    run_command:       'command',
    run_command_async: 'command',
    glob:              'pattern',
    grep:              'pattern',
    task_status:       'task_id',
    task_kill:         'task_id'
  }[name];
  if (pickField) return toStringArg(args[pickField]);
  try { return JSON.stringify(args).slice(0, 80); } catch { return ''; }
}

async function executeTool(name, args) {
  const _impl = executeToolImpl;
  const c = currentChat();
  const startedAt = new Date().toISOString();
  const res = await _impl(name, args);
  try {
    await window.api.audit.log({
      ts: startedAt,
      chat: c?.id,
      model: c?.model,
      tool: name,
      args,
      ok: !!res.ok,
      summary: res.summary,
      status: res.ok ? 'ok' : (res.result?.error || 'failed')
    });
  } catch {}
  return res;
}

async function executeToolImpl(name, args) {
  const c = currentChat();
  const alwaysGated = ['write_file', 'apply_patch', 'run_command', 'run_command_async', 'mcp_add_server', 'mcp_remove_server'].includes(name);
  const forceApproval = c?.approvalMode === true;
  // YOLO mode — skip the approval modal even for destructive tools. The user
  // opted in with the No-Approval toggle; respect it. Read-only enforcement
  // below still wins (No-Approval can't override Read-Only).
  const skipAllApprovals = c?.noApproval === true;
  let approvalDecision = 'none';

  // run_command pre-approval: if the command starts with anything on the
  // pre-approved command allowlist, skip the modal entirely.
  let skipApproval = false;
  if (name === 'run_command' && c?.commandAllowlist?.length) {
    const cmd = toStringArg(args?.command).trim();
    if (c.commandAllowlist.some(a => a && cmd.startsWith(a.trim()))) {
      skipApproval = true;
      approvalDecision = 'pre-approved';
    }
  }

  // Plan Mode: write-class tools are blocked at the executor until the user
  // approves an exit_plan_mode call. Reads/searches/fetches/inspections pass
  // through unchanged so the model can ground its plan in real evidence.
  // exit_plan_mode itself is handled below — it's the formal gate that lets
  // the chat leave Plan Mode.
  if (c?.planMode && name !== 'exit_plan_mode') {
    const planBlocked = ['write_file', 'apply_patch', 'run_command', 'run_command_async', 'task_kill', 'mcp_add_server', 'mcp_remove_server'];
    if (planBlocked.includes(name)) {
      await window.api.audit.log({ ts: new Date().toISOString(), chat: c.id, model: c.model, tool: name, args, status: 'blocked-planmode', ok: false });
      return { result: { error: 'Plan Mode is on — write tools are blocked. Call exit_plan_mode(plan) to surface your plan to the user for approval; on approve the chat flips to Approval Mode and you can execute.' }, summary: 'plan-mode', ok: false };
    }
  }

  // exit_plan_mode: surface the plan to the user; on approve flip the chat
  // from Plan Mode to Approval Mode and return success; on reject return an
  // error so the model can refine and try again.
  if (name === 'exit_plan_mode') {
    if (!c?.planMode) {
      return { result: { error: 'exit_plan_mode called while Plan Mode is off — nothing to exit. Just call the actual tools.' }, summary: 'not-in-plan-mode', ok: false };
    }
    const planText = toStringArg(args?.plan).trim();
    if (!planText) {
      return { result: { error: 'exit_plan_mode needs a non-empty `plan` argument with the plan text to show the user.' }, summary: 'bad args', ok: false };
    }
    const approved = await requestPlanApproval(planText);
    if (!approved) {
      await window.api.audit.log({ ts: new Date().toISOString(), chat: c.id, model: c.model, tool: name, args: { planLen: planText.length }, status: 'plan-rejected', ok: false });
      return { result: { error: 'rejected by user — refine the plan and call exit_plan_mode again when ready.' }, summary: 'rejected', ok: false };
    }
    // Flip the chat into Approval Mode. Plan/Approval/NoApproval are mutex,
    // so set the others off explicitly and re-render the safety bar so the
    // toggles reflect the new state.
    c.planMode = false;
    c.approvalMode = true;
    c.noApproval = false;
    c.approvedPlan = planText;
    saveToStorage();
    try { renderActiveChat(); } catch {}
    await window.api.audit.log({ ts: new Date().toISOString(), chat: c.id, model: c.model, tool: name, args: { planLen: planText.length }, status: 'plan-approved', ok: true });
    return { result: { ok: true, message: 'Plan approved by user. The chat is now in Approval Mode — proceed to execute the plan step by step. Each write tool call will pop a per-call approval modal.' }, summary: 'plan approved', ok: true };
  }

  // Read-only enforcement (defence in depth — buildTools already strips these).
  if (c?.readOnly && (name === 'write_file' || name === 'apply_patch' || name === 'run_command')) {
    await window.api.audit.log({ ts: new Date().toISOString(), chat: c.id, model: c.model, tool: name, args, status: 'blocked-readonly', ok: false });
    return { result: { error: 'this chat is in Read-Only mode — write/patch/shell are disabled' }, summary: 'read-only', ok: false };
  }
  // No-fetch enforcement.
  if (c?.noFetch && name === 'web_fetch') {
    await window.api.audit.log({ ts: new Date().toISOString(), chat: c.id, model: c.model, tool: name, args, status: 'blocked-nofetch', ok: false });
    return { result: { error: 'this chat has No-Fetch mode on — web_fetch is disabled (use web_search results instead)' }, summary: 'no-fetch', ok: false };
  }

  if (skipAllApprovals) {
    approvalDecision = 'no-approval-mode';
  } else if (!skipApproval && (alwaysGated || forceApproval) && name !== 'calc') {
    const ok = await requestApproval(name, args);
    approvalDecision = ok ? 'approved' : 'denied';
    if (!ok) {
      await window.api.audit.log({ ts: new Date().toISOString(), chat: c?.id, model: c?.model, tool: name, args, status: 'denied', ok: false });
      return { result: { error: 'denied by user' }, summary: 'denied', ok: false };
    }
  } else if (!skipApproval) {
    approvalDecision = 'auto-allow';
  }

  try {
    if (name === 'web_search') {
      const q = toStringArg(args?.query);
      if (!q) return { result: { error: 'web_search needs a string `query`' }, summary: 'bad args', ok: false };
      const res = await window.api.web.search(q);
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      const n = (res.results || []).length;
      return { result: { results: res.results }, summary: `${n} result${n === 1 ? '' : 's'}`, ok: true };
    }
    if (name === 'web_fetch') {
      const u = toStringArg(args?.url);
      if (!u) return { result: { error: 'web_fetch needs a string `url`' }, summary: 'bad args', ok: false };
      const res = await window.api.web.fetch(u);
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      const len = (res.content || '').length;
      return { result: { url: res.url, content: res.content }, summary: `${(len / 1024).toFixed(1)} KB`, ok: true };
    }
    if (name === 'calc') {
      try {
        if (!/^[0-9+\-*/().\s]+$/.test(args.expr || '')) throw new Error('invalid expression');
        // eslint-disable-next-line no-new-func
        const v = Function(`"use strict"; return (${args.expr})`)();
        return { result: { value: v }, summary: String(v), ok: true };
      } catch (e) { return { result: { error: e.message }, summary: 'invalid', ok: false }; }
    }
    const allow = c?.pathAllowlist || [];
    if (name === 'read_file') {
      const res = await runWithPathExpansion(name, args, allow, (a) => window.api.fs.readFile(args.path || '', a));
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      return { result: { path: res.path, content: res.content }, summary: `${(res.size / 1024).toFixed(1)} KB`, ok: true };
    }
    if (name === 'list_dir') {
      const res = await runWithPathExpansion(name, args, allow, (a) => window.api.fs.listDir(args.path || '', a));
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      const n = (res.entries || []).length;
      return { result: { path: res.path, entries: res.entries }, summary: `${n} item${n === 1 ? '' : 's'}`, ok: true };
    }
    if (name === 'write_file') {
      const res = await runWithPathExpansion(name, args, allow, (a) => window.api.fs.writeFile(args.path || '', args.content || '', a));
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      return { result: { path: res.path, bytes: res.bytes }, summary: `${res.bytes} B written`, ok: true };
    }
    if (name === 'apply_patch') {
      const res = await runWithPathExpansion(name, args, allow, (a) => window.api.fs.applyPatch(args.path || '', args.find || '', args.replace ?? '', a));
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      return { result: { path: res.path, before_lines: res.before_lines, after_lines: res.after_lines }, summary: 'patched', ok: true };
    }
    if (name === 'run_command') {
      // Default cwd to the project folder when the agent didn't specify one —
      // saves the model from having to remember to set it on every call.
      const effectiveCwd = args.cwd || c?.projectFolder || undefined;
      const res = await window.api.shell.run(args.command || '', effectiveCwd);
      const summary = res.timedOut ? 'timeout' : (res.exitCode === 0 ? `exit 0 · ${res.stdout.length} B` : `exit ${res.exitCode}`);
      return { result: res, summary, ok: res.exitCode === 0 };
    }
    if (name === 'glob') {
      const pattern = toStringArg(args?.pattern);
      if (!pattern) return { result: { error: 'pattern required' }, summary: 'bad args', ok: false };
      const root = c?.projectFolder || allow[0];
      if (!root) return { result: { error: 'no project folder set — glob needs a root' }, summary: 'no root', ok: false };
      const res = await window.api.fs.glob(pattern, root, allow);
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      const n = res.matches.length;
      return { result: { root: res.root, matches: res.matches }, summary: `${n} match${n === 1 ? '' : 'es'}`, ok: true };
    }
    if (name === 'grep') {
      const pattern = toStringArg(args?.pattern);
      if (!pattern) return { result: { error: 'pattern required' }, summary: 'bad args', ok: false };
      const root = c?.projectFolder || allow[0];
      if (!root) return { result: { error: 'no project folder set — grep needs a root' }, summary: 'no root', ok: false };
      const res = await window.api.fs.grep(pattern, root, {
        glob: args?.glob,
        caseInsensitive: !!args?.case_insensitive,
        allowlist: allow
      });
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      const n = res.matches.length;
      return { result: { matches: res.matches }, summary: `${n} match${n === 1 ? '' : 'es'}`, ok: true };
    }
    if (name === 'run_command_async') {
      const effectiveCwd = args.cwd || c?.projectFolder || undefined;
      const res = await window.api.shell.runAsync(args.command || '', effectiveCwd, allow);
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      return { result: { task_id: res.taskId, command: res.command, cwd: res.cwd, message: `Started in background as ${res.taskId}. Use task_status to check on it.` }, summary: `${res.taskId} started`, ok: true };
    }
    if (name === 'task_status') {
      const res = await window.api.shell.taskStatus(toStringArg(args?.task_id));
      if (res.error) return { result: { error: res.error }, summary: 'not found', ok: false };
      return { result: res, summary: `${res.status} · ${res.runtime_seconds}s`, ok: true };
    }
    if (name === 'task_list') {
      const res = await window.api.shell.taskList();
      const n = res.tasks?.length || 0;
      return { result: res, summary: `${n} task${n === 1 ? '' : 's'}`, ok: true };
    }
    if (name === 'task_kill') {
      const res = await window.api.shell.taskKill(toStringArg(args?.task_id));
      if (res.error) return { result: { error: res.error }, summary: 'failed', ok: false };
      return { result: { ok: true }, summary: 'killed', ok: true };
    }
    if (name === 'mcp_list_servers') {
      const servers = await window.api.mcp.list();
      const compact = servers.map(s => ({
        name: s.name,
        command: s.command,
        args: s.args,
        status: s.status,
        error: s.error,
        tools: (s.tools || []).map(t => ({ name: t.name, description: t.description }))
      }));
      return { result: { servers: compact }, summary: `${servers.length} server${servers.length === 1 ? '' : 's'}`, ok: true };
    }
    if (name === 'mcp_add_server') {
      const sname = toStringArg(args?.name);
      const command = toStringArg(args?.command);
      if (!sname || !command) return { result: { error: 'name and command required' }, summary: 'bad args', ok: false };
      const cfg = {
        command,
        args: Array.isArray(args?.args) ? args.args.map(toStringArg) : [],
        env: (args?.env && typeof args.env === 'object') ? args.env : {}
      };
      try {
        const updated = await window.api.mcp.add(sname, cfg);
        state.mcpServers = updated;
        state.mcpTools = await window.api.mcp.getTools();
        const entry = updated.find(s => s.name === sname);
        return { result: { server: entry }, summary: `${sname}: ${entry?.status || 'added'}`, ok: entry?.status !== 'error' };
      } catch (e) { return { result: { error: e.message }, summary: 'failed', ok: false }; }
    }
    if (name === 'mcp_remove_server') {
      const sname = toStringArg(args?.name);
      if (!sname) return { result: { error: 'name required' }, summary: 'bad args', ok: false };
      try {
        const updated = await window.api.mcp.remove(sname);
        state.mcpServers = updated;
        state.mcpTools = await window.api.mcp.getTools();
        return { result: { ok: true, remaining: updated.length }, summary: `removed ${sname}`, ok: true };
      } catch (e) { return { result: { error: e.message }, summary: 'failed', ok: false }; }
    }
    if (name.startsWith('mcp__')) {
      const res = await window.api.mcp.callTool(name, args || {});
      if (!res.ok) return { result: { error: res.error }, summary: 'failed', ok: false };
      const r = res.result || {};
      // MCP tools return { content: [{type:'text', text:...}, ...], isError? }
      const text = Array.isArray(r.content)
        ? r.content.map(c => c?.text ?? (c?.type === 'image' ? '[image returned]' : '')).filter(Boolean).join('\n')
        : '';
      const bytes = text.length;
      return {
        result: r,
        summary: r.isError ? 'tool error' : (bytes ? `${(bytes/1024).toFixed(1)} KB` : 'ok'),
        ok: !r.isError
      };
    }
    return { result: { error: 'unknown tool ' + name }, summary: 'unknown', ok: false };
  } catch (e) {
    return { result: { error: e.message }, summary: 'error', ok: false };
  }
}

// ============== PATH EXPANSION MODAL ==============
// When a file tool tries to access something outside the chat's pathAllowlist,
// instead of dead-ending the agent, ask the user whether to grant access:
// once, for-the-whole-folder, or deny. Returns one of 'once' | 'folder' | 'deny'.
function requestPathExpansion(toolName, requestedPath) {
  return new Promise((resolve) => {
    const overlay = $('#path-expand-overlay');
    if (!overlay) return resolve('deny');
    const c = currentChat();
    $('#pe-tool-name').textContent = toolName;
    $('#pe-requested-path').textContent = requestedPath || '(unknown)';
    $('#pe-current-folder').textContent = c?.projectFolder || '(none — no project folder set)';
    overlay.hidden = false;

    let done = false;
    const cleanup = (decision) => {
      if (done) return;
      done = true;
      overlay.hidden = true;
      $('#pe-deny').removeEventListener('click', onDeny);
      $('#pe-once').removeEventListener('click', onOnce);
      $('#pe-folder').removeEventListener('click', onFolder);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(decision);
    };
    const onDeny     = () => cleanup('deny');
    const onOnce     = () => cleanup('once');
    const onFolder   = () => cleanup('folder');
    const onBackdrop = (e) => { if (e.target === overlay) cleanup('deny'); };
    const onKey      = (e) => { if (e.key === 'Escape') cleanup('deny'); };

    $('#pe-deny').addEventListener('click', onDeny);
    $('#pe-once').addEventListener('click', onOnce);
    $('#pe-folder').addEventListener('click', onFolder);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    $('#pe-deny').focus();
  });
}

// Wraps a file-tool IPC call. If the first try fails because the path is
// outside the allowlist, prompts the user (path-expansion modal). If they
// approve, retries with an expanded allowlist; if they choose "Allow this
// folder", persists the expansion to the chat's pathAllowlist.
async function runWithPathExpansion(toolName, args, allow, runFn) {
  let currentAllow = (allow || []).slice();
  let res = await runFn(currentAllow);
  if (!res || !res.error) return res;
  if (!/outside (?:the )?allowed roots/i.test(res.error)) return res;

  // Extract path from main.js's error message, fall back to args.
  const m = res.error.match(/"([^"]+)"/);
  const requestedPath = (m && m[1]) || toStringArg(args?.path) || toStringArg(args?.cwd) || '';
  if (!requestedPath) return res;

  const decision = await requestPathExpansion(toolName, requestedPath);
  if (decision === 'deny') return res;

  let toAdd;
  if (decision === 'once') {
    toAdd = requestedPath;
  } else {
    // 'folder' — add the containing directory so subsequent accesses in the
    // same folder don't re-prompt.
    const parent = requestedPath.replace(/[\\/][^\\/]+[\\/]?$/, '');
    toAdd = parent || requestedPath;
  }
  currentAllow.push(toAdd);

  if (decision === 'folder') {
    const c = currentChat();
    if (c) {
      c.pathAllowlist = c.pathAllowlist || [];
      if (!c.pathAllowlist.includes(toAdd)) c.pathAllowlist.push(toAdd);
      saveToStorage();
    }
  }
  return await runFn(currentAllow);
}

// ============== PLAN APPROVAL MODAL ==============
// Shown when the agent calls exit_plan_mode(plan). Returns a Promise<boolean>:
// true on Approve, false on Reject / Escape / overlay click. The plan text is
// rendered as markdown so numbered lists and inline code look right.
function requestPlanApproval(planText) {
  return new Promise((resolve) => {
    const overlay  = $('#plan-approval-overlay');
    const bodyEl   = $('#plan-approval-body');
    const approve  = $('#plan-approval-approve');
    const deny     = $('#plan-approval-deny');
    if (!overlay || !bodyEl || !approve || !deny) { resolve(false); return; }

    bodyEl.innerHTML = renderMarkdown(planText);
    overlay.hidden = false;

    let done = false;
    const cleanup = (result) => {
      if (done) return;
      done = true;
      overlay.hidden = true;
      approve.removeEventListener('click', onYes);
      deny.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo  = () => cleanup(false);
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

    approve.addEventListener('click', onYes);
    deny.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
    deny.focus();
  });
}

// ============== APPROVAL MODAL ==============
function requestApproval(toolName, args) {
  return new Promise((resolve) => {
    const overlay  = $('#approval-overlay');
    const nameEl   = $('#approval-name');
    const descEl   = $('#approval-desc');
    const bodyEl   = $('#approval-body');
    const approve  = $('#approval-approve');
    const deny     = $('#approval-deny');

    const presets = {
      write_file:     { label: 'write_file',     desc: 'The model wants to overwrite a file on your disk.' },
      apply_patch:    { label: 'apply_patch',    desc: 'The model wants to edit a file in-place.' },
      run_command:    { label: 'run_command',    desc: 'The model wants to run a shell command on your machine.' },
      web_search:     { label: 'web_search',     desc: 'The model wants to search the public web.' },
      web_fetch:      { label: 'web_fetch',      desc: 'The model wants to fetch a URL.' },
      read_file:      { label: 'read_file',      desc: 'The model wants to read a file from disk.' },
      list_dir:       { label: 'list_dir',       desc: 'The model wants to list a directory.' }
    };
    const preset = presets[toolName] || { label: toolName, desc: 'The model wants to perform an action.' };

    nameEl.textContent = preset.label;
    descEl.textContent = preset.desc;
    bodyEl.innerHTML = renderApprovalBody(toolName, args);
    overlay.hidden = false;

    let done = false;
    const cleanup = (result) => {
      if (done) return;
      done = true;
      overlay.hidden = true;
      approve.removeEventListener('click', onYes);
      deny.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo  = () => cleanup(false);
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };

    approve.addEventListener('click', onYes);
    deny.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
    deny.focus();
  });
}

function renderApprovalBody(toolName, args) {
  if (toolName === 'run_command') {
    return `
      <section class="approval-section">
        <div class="approval-label">Command</div>
        <pre class="approval-code">${escapeHtml(args.command || '')}</pre>
      </section>
      <section class="approval-section">
        <div class="approval-label">Working directory</div>
        <pre class="approval-code dim">${escapeHtml(args.cwd || '(home directory)')}</pre>
      </section>
    `;
  }
  if (toolName === 'write_file') {
    const c = String(args.content ?? '');
    const truncated = c.length > 4000;
    const preview = truncated ? c.slice(0, 4000) : c;
    return `
      <section class="approval-section">
        <div class="approval-label">Path</div>
        <pre class="approval-code">${escapeHtml(args.path || '')}</pre>
      </section>
      <section class="approval-section">
        <div class="approval-label">New content${truncated ? ' (first 4 KB shown)' : ''}</div>
        <pre class="approval-code">${escapeHtml(preview)}</pre>
      </section>
    `;
  }
  if (toolName === 'apply_patch') {
    const findLines = String(args.find ?? '').split('\n').map(l => `<span class="diff-line minus">- ${escapeHtml(l)}</span>`).join('');
    const replaceLines = String(args.replace ?? '').split('\n').map(l => `<span class="diff-line plus">+ ${escapeHtml(l)}</span>`).join('');
    return `
      <section class="approval-section">
        <div class="approval-label">Path</div>
        <pre class="approval-code">${escapeHtml(args.path || '')}</pre>
      </section>
      <section class="approval-section">
        <div class="approval-label">Patch</div>
        <div class="approval-diff">${findLines}${replaceLines}</div>
      </section>
    `;
  }
  if (toolName === 'web_search') {
    return `
      <section class="approval-section">
        <div class="approval-label">Search query</div>
        <pre class="approval-code">${escapeHtml(toStringArg(args?.query))}</pre>
      </section>
    `;
  }
  if (toolName === 'web_fetch') {
    return `
      <section class="approval-section">
        <div class="approval-label">URL to fetch</div>
        <pre class="approval-code">${escapeHtml(toStringArg(args?.url))}</pre>
      </section>
    `;
  }
  if (toolName === 'read_file' || toolName === 'list_dir') {
    return `
      <section class="approval-section">
        <div class="approval-label">Path</div>
        <pre class="approval-code">${escapeHtml(toStringArg(args?.path))}</pre>
      </section>
    `;
  }
  return `<pre class="approval-code">${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
}

function patchLastMessage(msg) {
  // Full re-render — call this when message structure changes (tool events
  // added, media attached, pending state toggled).  For streaming text use
  // patchLastMessageContent instead, which avoids the full DOM swap that
  // makes streamed tokens flicker.
  const list = $('#thread');
  const lastEl = list.lastElementChild;
  if (!lastEl) return;
  const fresh = renderMessage(msg);
  list.replaceChild(fresh, lastEl);
  list.scrollTop = list.scrollHeight;
}

// Lightweight: mutate the existing .msg-body text node in place rather than
// rebuilding the whole bubble for every streamed token.
// Build the small per-message token-count element. Shared by renderMessage and
// patchLastMessageContent so the badge appears (and updates live) without
// rebuilding the whole bubble on every streamed token.

function patchLastMessageContent(msg) {
  const list = $('#thread');
  const lastEl = list.lastElementChild;
  if (!lastEl) return;

  // Verify the existing element is the right message; if not, full render.
  if (!lastEl.classList.contains('msg') || !lastEl.classList.contains(msg.role)) {
    return patchLastMessage(msg);
  }

  let body = lastEl.querySelector(':scope > .msg-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'msg-body';
    // Body goes AFTER the tool events (thinking/search/etc.) and before the
    // token badge / pending indicator, matching renderMessage's order so the
    // answer sits below "Thought for Ns" rather than above it.
    const after = lastEl.querySelector(':scope > .msg-tokens, :scope > .msg-pending');
    if (after) lastEl.insertBefore(body, after);
    else lastEl.appendChild(body);
  }
  // Assistant streams are rendered with markdown so **bold** etc. transitions
  // in as soon as the closing marker arrives.
  if (msg.role === 'assistant') body.innerHTML = renderMarkdown(msg.content || '');
  else body.textContent = msg.content || '';
  // Real content has arrived → kill the "Thinking…" indicator if still mounted.
  if (msg.content) {
    const t = lastEl.querySelector(':scope > .msg-thinking');
    if (t) t.remove();
  }

  // (No more token badge — thinking-phase token counts live on the think row.)

  // Only auto-scroll when the user is already near the bottom so we don't
  // hijack them mid-scroll.
  const nearBottom = (list.scrollHeight - list.clientHeight - list.scrollTop) < 80;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// ============== CATALOG ==============

// Delegated click handler for video-bubble actions: dep installer, retry,
// click-a-thumbnail-to-ask-about-that-moment. One listener on the thread.
function wireVideoBubbleActions() {
  const thread = document.querySelector('#thread');
  if (!thread) return;
  thread.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-vid-action]');
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.vidAction;
    const c = currentChat();
    if (!c) return;

    if (action === 'install-dep') {
      const dep = btn.dataset.dep;
      const msgIdx = c.messages.findIndex(m => m.videoState);
      if (msgIdx < 0) return;
      await installVideoDep(c.id, msgIdx, dep);
    } else if (action === 'retry-after-install') {
      // Re-check deps. If both ok now, restart the pipeline using the most
      // recent user video attachment.
      const deps = await window.api.video.detectDeps();
      if (!deps.ffmpeg.found || !deps.whisper.found) {
        const idx = c.messages.findIndex(m => m.videoState);
        if (idx >= 0) c.messages[idx].videoState = { stage: 'deps-missing', deps };
        renderActiveChat();
        return;
      }
      const userMsg = [...c.messages].reverse().find(m => m.role === 'user' && m.attachments?.some(a => a.kind === 'video'));
      const assistantIdx = c.messages.findIndex(m => m.videoState);
      if (!userMsg || assistantIdx < 0) return;
      // We need the full attachment record (with .path) — pull it from the
      // pending-attachments-at-send-time cache we stuck on the user message.
      const videoAtt = (userMsg._videoAtt || userMsg.attachments.find(a => a.kind === 'video'));
      if (!videoAtt?.path) {
        c.messages[assistantIdx].content = 'I lost the video path on retry — please re-attach the video.';
        c.messages[assistantIdx].videoState = null;
        renderActiveChat();
        return;
      }
      const am = c.messages[assistantIdx];
      am.videoState = { stage: 'starting' };
      am.thinking = true;
      renderActiveChat();
      runVideoAnalysis(c, videoAtt, am);
    } else if (action === 'ask-about-moment') {
      const ts = parseFloat(btn.dataset.ts || '0');
      const input = $('#composer-input');
      if (!input) return;
      input.value = `What's happening at ${formatTs(ts)}?`;
      input.focus();
      input.style.height = 'auto';
      input.style.height = input.scrollHeight + 'px';
    }
  });
}

// Delegated click handler for every code-block Copy / Download button.
// Single listener on the thread survives re-renders during streaming — the
// block elements get rebuilt on every token but this listener does not.
function wireCodeBlockActions() {
  const thread = document.querySelector('#thread');
  if (!thread) return;
  thread.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cb-action]');
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.cbAction;
    const content = decodeURIComponent(btn.dataset.cbContent || '');
    if (action === 'copy') {
      navigator.clipboard.writeText(content).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('done'); }, 1200);
      }).catch(() => { btn.textContent = 'Copy failed'; });
    } else if (action === 'download') {
      const filename = btn.dataset.cbFilename || 'snippet.txt';
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (action === 'edit') {
      openEditModal({
        code: content,
        lang: btn.dataset.cbLang || '',
        filename: btn.dataset.cbFilename || 'snippet.txt',
        originalCode: content,
        sourceButton: btn
      });
    } else if (action === 'output') {
      openOutputModal({
        code: content,
        lang: btn.dataset.cbLang || '',
        filename: btn.dataset.cbFilename || 'snippet.txt'
      });
    }
  });
}

// ============== CODE-BLOCK EDIT MODAL ==============
// In-app editor for snippets. On save, replaces the original code inside the
// chat message's content so future renders + downloads reflect the edit.
// On close with unsaved changes, shows an inline Save / Discard / Cancel
// confirm dialog.
function openEditModal({ code, lang, filename, originalCode }) {
  // Build modal DOM
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay editor-overlay';
  overlay.innerHTML = `
    <div class="modal editor-modal" role="dialog" aria-modal="true" aria-label="Edit ${escapeHtml(filename)}">
      <div class="modal-head editor-head">
        <div class="editor-title-block">
          <span class="editor-filename">${escapeHtml(filename)}</span>
          <span class="editor-lang-tag">${escapeHtml(lang || 'text')}</span>
          <span class="editor-dirty-dot" aria-hidden="true" hidden></span>
        </div>
        <div class="editor-head-actions">
          <button type="button" class="editor-btn editor-btn-ghost" data-edit-action="cancel" title="Close (Esc)">Cancel</button>
          <button type="button" class="editor-btn editor-btn-primary" data-edit-action="save" title="Save (Ctrl+S)">Save</button>
          <button type="button" class="modal-close" data-edit-action="cancel" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="editor-body">
        <div class="editor-gutter" aria-hidden="true"></div>
        <textarea class="editor-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">${escapeHtml(code)}</textarea>
      </div>
      <div class="editor-foot">
        <span class="editor-foot-info" data-foot-info></span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const modal     = overlay.querySelector('.editor-modal');
  const textarea  = overlay.querySelector('.editor-textarea');
  const gutter    = overlay.querySelector('.editor-gutter');
  const dirtyDot  = overlay.querySelector('.editor-dirty-dot');
  const footInfo  = overlay.querySelector('[data-foot-info]');

  let dirty = false;
  let saving = false;

  const updateGutter = () => {
    const n = textarea.value.split('\n').length;
    const lines = [];
    for (let i = 1; i <= n; i++) lines.push(i);
    gutter.textContent = lines.join('\n');
  };
  const updateFootInfo = () => {
    const v = textarea.value;
    const lines = v.split('\n').length;
    const chars = v.length;
    const sel = textarea.selectionEnd - textarea.selectionStart;
    footInfo.textContent = sel > 0
      ? `${lines} lines · ${chars} chars · ${sel} selected`
      : `${lines} lines · ${chars} chars`;
  };
  const setDirty = (v) => {
    if (v === dirty) return;
    dirty = v;
    dirtyDot.hidden = !v;
    modal.classList.toggle('is-dirty', v);
  };

  updateGutter();
  updateFootInfo();

  // Insert literal Tab character on Tab press (don't escape the editor).
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart;
      const eend = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + '  ' + textarea.value.slice(eend);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
      setDirty(true);
      updateGutter();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  });
  textarea.addEventListener('input', () => {
    setDirty(textarea.value !== originalCode);
    updateGutter();
    updateFootInfo();
  });
  textarea.addEventListener('select', updateFootInfo);
  textarea.addEventListener('click', updateFootInfo);
  textarea.addEventListener('keyup', updateFootInfo);

  // Scroll-sync gutter to textarea.
  textarea.addEventListener('scroll', () => {
    gutter.scrollTop = textarea.scrollTop;
  });

  const close = () => {
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onEsc);
  };

  const doSave = () => {
    if (saving) return;
    saving = true;
    const newCode = textarea.value;
    const ok = replaceCodeBlockInChat(originalCode, newCode);
    saving = false;
    if (!ok) {
      footInfo.textContent = 'Save failed — couldn\'t find original block in message';
      footInfo.classList.add('is-error');
      return;
    }
    setDirty(false);
    // Tick the dot green briefly to confirm save.
    modal.classList.add('just-saved');
    footInfo.textContent = 'Saved · ' + new Date().toLocaleTimeString();
    footInfo.classList.remove('is-error');
    setTimeout(() => modal.classList.remove('just-saved'), 900);
  };

  const promptUnsaved = () => new Promise((resolve) => {
    const confirm = document.createElement('div');
    confirm.className = 'editor-confirm';
    confirm.innerHTML = `
      <div class="editor-confirm-card">
        <h3>Unsaved changes</h3>
        <p>You've edited <strong>${escapeHtml(filename)}</strong> but haven't saved. What do you want to do?</p>
        <div class="editor-confirm-actions">
          <button type="button" class="editor-btn editor-btn-ghost" data-c="cancel">Cancel</button>
          <button type="button" class="editor-btn editor-btn-danger" data-c="discard">Discard</button>
          <button type="button" class="editor-btn editor-btn-primary" data-c="save">Save</button>
        </div>
      </div>
    `;
    modal.appendChild(confirm);
    confirm.addEventListener('click', (ev) => {
      const t = ev.target.closest('button[data-c]');
      if (!t) return;
      const choice = t.dataset.c;
      confirm.remove();
      resolve(choice);
    });
  });

  const tryClose = async () => {
    if (!dirty) { close(); return; }
    const choice = await promptUnsaved();
    if (choice === 'cancel') return;
    if (choice === 'save') doSave();
    close();
  };

  overlay.addEventListener('click', (ev) => {
    // Click on overlay backdrop closes (with confirm if dirty).
    if (ev.target === overlay) tryClose();
    const action = ev.target.closest('button[data-edit-action]')?.dataset.editAction;
    if (action === 'save') doSave();
    if (action === 'cancel') tryClose();
  });

  const onEsc = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      tryClose();
    }
  };
  document.addEventListener('keydown', onEsc);

  // Focus + place cursor at end of first line for snappy editing.
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = 0;
}

// Finds the chat-message that contains `originalCode` as a fenced code block
// and rewrites just that block. Returns true on success. Searches every
// message of the current chat so position-independent.
function replaceCodeBlockInChat(originalCode, newCode) {
  const c = currentChat();
  if (!c) return false;
  const orig = originalCode.replace(/\n$/, '');
  const replacement = newCode.replace(/\n$/, '');
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (typeof m.content !== 'string') continue;
    if (!m.content.includes(orig)) continue;
    // Find the fenced block whose body matches orig exactly.
    const re = /```(\w*)\n?([\s\S]*?)```/g;
    let match, found = false;
    let newContent = '';
    let lastEnd = 0;
    while ((match = re.exec(m.content)) !== null) {
      const body = match[2].replace(/\n$/, '');
      newContent += m.content.slice(lastEnd, match.index);
      if (!found && body === orig) {
        newContent += '```' + match[1] + '\n' + replacement + '\n```';
        found = true;
      } else {
        newContent += match[0];
      }
      lastEnd = match.index + match[0].length;
    }
    newContent += m.content.slice(lastEnd);
    if (found) {
      m.content = newContent;
      saveToStorage();
      renderActiveChat();
      return true;
    }
  }
  return false;
}

// ============== CODE-BLOCK OUTPUT MODAL ==============
// HTML → render in a sandboxed iframe.
// Other runnable langs → spawn via shell:run_code and stream stdout/stderr
// into a terminal-style pre with a Stop button.
function openOutputModal({ code, lang, filename }) {
  const langKey = (lang || '').toLowerCase();
  const isHtml = langKey === 'html' || langKey === 'htm';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay output-overlay';

  if (isHtml) {
    overlay.innerHTML = `
      <div class="modal output-modal output-modal-preview" role="dialog" aria-modal="true">
        <div class="modal-head output-head">
          <div class="output-title-block">
            <span class="output-kind-pill output-kind-html">PREVIEW</span>
            <span class="output-filename">${escapeHtml(filename)}</span>
          </div>
          <div class="output-head-actions">
            <button type="button" class="editor-btn editor-btn-ghost" data-out-action="reload" title="Reload">↻ Reload</button>
            <button type="button" class="modal-close" data-out-action="close" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="output-preview-body">
          <iframe class="output-iframe" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin" srcdoc="${escapeHtml(code)}"></iframe>
        </div>
      </div>
    `;
  } else {
    overlay.innerHTML = `
      <div class="modal output-modal output-modal-terminal" role="dialog" aria-modal="true">
        <div class="modal-head output-head">
          <div class="output-title-block">
            <span class="output-kind-pill output-kind-run">${escapeHtml((langKey || 'run').toUpperCase())}</span>
            <span class="output-filename">${escapeHtml(filename)}</span>
            <span class="output-status" data-status>starting…</span>
          </div>
          <div class="output-head-actions">
            <button type="button" class="editor-btn editor-btn-ghost" data-out-action="clear" title="Clear">Clear</button>
            <button type="button" class="editor-btn editor-btn-ghost" data-out-action="rerun" title="Re-run">↻ Re-run</button>
            <button type="button" class="editor-btn editor-btn-danger" data-out-action="stop" title="Stop running process">■ Stop</button>
            <button type="button" class="modal-close" data-out-action="close" aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <pre class="output-terminal" data-terminal></pre>
        <div class="output-foot">
          <span class="output-foot-cmd" data-foot-cmd></span>
          <span class="output-foot-time" data-foot-time></span>
        </div>
      </div>
    `;
  }

  document.body.appendChild(overlay);

  const close = () => {
    overlay.classList.add('is-closing');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onEsc);
    if (activeTaskId) { window.api.shell.runCodeKill(activeTaskId).catch(() => {}); }
  };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc);

  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) { close(); return; }
    const action = ev.target.closest('button[data-out-action]')?.dataset.outAction;
    if (action === 'close') close();
    if (action === 'reload' && isHtml) {
      const iframe = overlay.querySelector('.output-iframe');
      if (iframe) iframe.srcdoc = code;
    }
    if (!isHtml) {
      if (action === 'clear') {
        overlay.querySelector('[data-terminal]').textContent = '';
      }
      if (action === 'stop' && activeTaskId) {
        window.api.shell.runCodeKill(activeTaskId).catch(() => {});
      }
      if (action === 'rerun') {
        overlay.querySelector('[data-terminal]').textContent = '';
        startRun();
      }
    }
  });

  if (isHtml) return; // No process to spawn for HTML preview.

  // Terminal-mode wiring.
  let activeTaskId = null;
  const termEl   = overlay.querySelector('[data-terminal]');
  const statusEl = overlay.querySelector('[data-status]');
  const cmdEl    = overlay.querySelector('[data-foot-cmd]');
  const timeEl   = overlay.querySelector('[data-foot-time]');
  const stopBtn  = overlay.querySelector('[data-out-action="stop"]');
  const rerunBtn = overlay.querySelector('[data-out-action="rerun"]');

  const setStatus = (state, label) => {
    statusEl.textContent = label;
    statusEl.dataset.state = state;
  };

  const append = (text, kind) => {
    if (!text) return;
    const span = document.createElement('span');
    if (kind === 'stderr') span.className = 'term-stderr';
    span.textContent = text;
    termEl.appendChild(span);
    termEl.scrollTop = termEl.scrollHeight;
  };

  const startRun = async () => {
    activeTaskId = null;
    setStatus('running', 'running');
    stopBtn.disabled = false;
    rerunBtn.disabled = true;
    const startedAt = Date.now();
    try {
      await window.api.shell.runCode({ lang: langKey, code }, (chunk) => {
        if (chunk.kind === 'start') {
          activeTaskId = chunk.taskId;
          cmdEl.textContent = chunk.command || '';
        } else if (chunk.kind === 'stdout') {
          append(chunk.text, 'stdout');
        } else if (chunk.kind === 'stderr') {
          append(chunk.text, 'stderr');
        } else if (chunk.kind === 'error') {
          append('\n' + chunk.text + '\n', 'stderr');
        } else if (chunk.kind === 'exit') {
          const sec = ((chunk.runtimeMs || (Date.now() - startedAt)) / 1000).toFixed(2);
          timeEl.textContent = `${sec}s · exit ${chunk.exitCode}`;
          if (chunk.status === 'killed') setStatus('killed', 'stopped');
          else if (chunk.exitCode === 0) setStatus('done', 'finished');
          else setStatus('error', `exited ${chunk.exitCode}`);
        }
      });
    } catch (err) {
      append('\n[run failed] ' + err.message + '\n', 'stderr');
      setStatus('error', 'error');
    } finally {
      stopBtn.disabled = true;
      rerunBtn.disabled = false;
      activeTaskId = null;
    }
  };

  startRun();
}

// ============== UTIL ==============
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// Convert Ollama's terse runtime errors into actionable explanations the user
// can act on. Falls back to the raw message for anything we don't recognise.
function friendlyOllamaError(err, currentChat) {
  if (!err) return '';
  const s = String(err);

  const memMatch = s.match(/requires more system memory \(([\d.]+ GiB)\) than is available \(([\d.]+ GiB)\)/i);
  if (memMatch) {
    const isAgent = currentChat?.modality === 'agent';
    const smaller = isAgent ? 'Hermes 3 8B (~5 GB)' : 'Llama 3.2 3B (~2 GB)';
    return `**Out of memory.** This model needs **${memMatch[1]}** but only **${memMatch[2]}** is available on your machine right now.\n\nTry switching to a smaller model:\n- For ${isAgent ? 'agentic' : 'general'} chats: **${smaller}**\n- Or free up memory by closing other apps / models (Ollama keeps the most recent model loaded — running \`ollama stop <other-model>\` in a terminal can help).\n\nUse the model picker in the top right of this chat.`;
  }

  const noModelMatch = s.match(/model '([^']+)' not found/i);
  if (noModelMatch) {
    return `Model **${noModelMatch[1]}** isn't installed. Click its row in the model picker (top right) and use the download icon to pull it.`;
  }

  if (/connect\s*ECONNREFUSED|fetch failed|ollama returned 5\d\d/i.test(s)) {
    return `Couldn't reach Ollama. Make sure the Ollama tray app is running — the status pill in the sidebar should be green.\n\n_Underlying error: ${s}_`;
  }

  return s;
}

// Minimal markdown → safe HTML for assistant messages.
// Handles: **bold**, *italic*, `inline code`, ```code blocks```, # headings,
// - / * unordered lists, 1. ordered lists, [text](url) links.
// Code is extracted before any other processing so the inside is never touched
// by inline rules. All raw text is HTML-escaped — the only tags emitted are
// the ones this function generates.
// LaTeX → readable HTML. We don't load KaTeX (would need to vendor ~400 KB
// of fonts + CSS); instead we strip the math delimiters and replace common
// macros with Unicode equivalents. Covers what a chat model usually emits:
// fractions, \text{}, \times, \frac, \sqrt, sub/superscripts, Greek letters.
const LATEX_SYMBOLS = {
  'times': '×', 'div': '÷', 'pm': '±', 'mp': '∓', 'cdot': '·',
  'approx': '≈', 'neq': '≠', 'ne': '≠', 'equiv': '≡',
  'leq': '≤', 'geq': '≥', 'le': '≤', 'ge': '≥',
  'll': '≪', 'gg': '≫', 'infty': '∞',
  'sum': 'Σ', 'prod': '∏', 'int': '∫', 'partial': '∂', 'nabla': '∇',
  'to': '→', 'rightarrow': '→', 'leftarrow': '←', 'Rightarrow': '⇒',
  'in': '∈', 'notin': '∉', 'subset': '⊂', 'supset': '⊃',
  'cup': '∪', 'cap': '∩', 'emptyset': '∅', 'forall': '∀', 'exists': '∃',
  'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ',
  'epsilon': 'ε', 'varepsilon': 'ε', 'zeta': 'ζ', 'eta': 'η',
  'theta': 'θ', 'vartheta': 'ϑ', 'iota': 'ι', 'kappa': 'κ', 'lambda': 'λ',
  'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π', 'varpi': 'ϖ',
  'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ',
  'phi': 'φ', 'varphi': 'φ', 'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
  'Alpha': 'Α', 'Beta': 'Β', 'Gamma': 'Γ', 'Delta': 'Δ',
  'Theta': 'Θ', 'Lambda': 'Λ', 'Xi': 'Ξ', 'Pi': 'Π',
  'Sigma': 'Σ', 'Phi': 'Φ', 'Psi': 'Ψ', 'Omega': 'Ω',
  'left': '', 'right': '',
  'quad': '  ', 'qquad': '    '
};

function transformMath(s) {
  s = s.trim();
  // Recursively expand \text{} \mathrm{} \mathbf{} — they may nest.
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\\text\s*\{([^{}]*)\}/g,    '$1');
    s = s.replace(/\\mathrm\s*\{([^{}]*)\}/g,  '$1');
    s = s.replace(/\\mathbf\s*\{([^{}]*)\}/g,  '<strong>$1</strong>');
    s = s.replace(/\\mathit\s*\{([^{}]*)\}/g,  '<em>$1</em>');
  }
  // \frac{a}{b} → <span class="math-frac"><sup>a</sup>⁄<sub>b</sub></span>
  s = s.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g,
    '<span class="math-frac"><span class="math-num">$1</span><span class="math-den">$2</span></span>');
  // \sqrt{x} → √(x)
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, '√($1)');
  // Greek + symbol macros
  s = s.replace(/\\([a-zA-Z]+)/g, (m, name) => {
    if (Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name)) return LATEX_SYMBOLS[name];
    return m;
  });
  // Subscripts and superscripts
  s = s.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
  s = s.replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]+)\}/g,  '<sub>$1</sub>');
  s = s.replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');
  // Drop stray \, \! \; thin-spaces
  s = s.replace(/\\[,;!]/g, ' ');
  return s;
}

function renderMathLite(text) {
  // Display math: \[ ... \]  and  $$ ... $$
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) =>
    `<div class="math-display">${transformMath(inner)}</div>`);
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) =>
    `<div class="math-display">${transformMath(inner)}</div>`);
  // Inline math: \( ... \)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) =>
    `<span class="math-inline">${transformMath(inner)}</span>`);
  return text;
}

function renderMarkdown(text) {
  if (!text) return '';
  let src = String(text);

  // 0. Strip leaked reasoning. Some local models (Qwen3 among them) emit their
  // chain-of-thought inline as <think>…</think> even when thinking is off,
  // instead of via Ollama's separate thinking field. Drop those blocks — and a
  // stray orphan </think> — so the user sees the answer, not the model
  // thinking aloud at them.
  src = src.replace(/<think>[\s\S]*?<\/think>/gi, '');
  src = src.replace(/^[\s\S]*?<\/think>/i, (m) => m.includes('<think>') ? m : '');

  // 1. Pull out fenced code blocks first.
  const codeBlocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Pull out inline code.
  const inlineCode = [];
  src = src.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlineCode.push(code);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // 3. Escape HTML so the model can't inject tags.
  src = escapeHtml(src);

  // 3b. Convert LaTeX math (\[...\], \(...\), $$...$$) to readable HTML with
  // Unicode symbols. Models like to emit LaTeX for unit conversions, fractions,
  // and equations — without this they leak through as raw backslash macros.
  src = renderMathLite(src);

  // 4. Bold + italic + links. CommonMark supports both asterisk AND underscore
  // delimiters: **bold** / __bold__ and *italic* / _italic_. Gemini (and some
  // Anthropic responses) reach for the underscore form — without these rules
  // the user sees raw _underscores_ around text. The underscore patterns use
  // word-boundary lookarounds so we don't mangle identifiers like snake_case.
  src = src.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/(^|[^\w])__([^_\n]+?)__(?=[^\w]|$)/g, '$1<strong>$2</strong>');
  src = src.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  src = src.replace(/(^|[^\w])_([^_\n]+?)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
    if (!/^https?:\/\//.test(url)) return m;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });

  // 5. Block-level: process line by line. Flat lists (no nesting) — keeps the
  // parser simple and works for typical LLM output. Indented sub-bullets are
  // promoted to their own list right after the parent item.
  const lines = src.split('\n');
  const out = [];
  let listType = null;  // 'ul' | 'ol' | null
  // Blank lines INSIDE a list are deferred rather than closing it: many models
  // (especially small ones) write "loose" lists with a blank line between every
  // item. Closing the list on each blank produced a separate <ol> per item,
  // and every fresh <ol> restarts at 1 — which is the "1. 1. 1." bug. We only
  // actually close when a non-list line arrives.
  let pendingBlank = false;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } pendingBlank = false; };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) {
      if (listType) pendingBlank = true;   // maybe a loose list — wait and see
      else closeList();
      continue;
    }

    // Horizontal rule — models use --- (or *** / ___) as a section divider.
    // Render it as an <hr> instead of leaking literal dashes into the text.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); out.push('<hr>'); continue; }

    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${h[2]}</h${lvl}>`); continue; }

    const ul = trimmed.match(/^[*\-]\s+(.+)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      pendingBlank = false;
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    // Capture the actual ordinal so the rendered number matches what the model
    // wrote (value="N"), regardless of how the <ol>s end up grouped. This is a
    // second guard against mis-numbering on top of the loose-list fix.
    const ol = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      pendingBlank = false;
      out.push(`<li value="${ol[1]}">${ol[2]}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${trimmed}</p>`);
  }
  closeList();

  let html = out.join('\n');

  // 6. Restore code (escape inside now to keep tags inert).
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => {
    const { lang, code } = codeBlocks[+i];
    const cleanCode = code.replace(/\n$/, '');
    const ext = LANG_TO_EXT[(lang || '').toLowerCase()] || 'txt';
    // Try to detect "// filename.ext" or "# filename.ext" comment on the first
    // line; otherwise fall back to snippet.<ext>.
    let filename = `snippet.${ext}`;
    const firstLine = cleanCode.split('\n')[0].trim();
    const fileHint = firstLine.match(/^[#/*\-\s]*(?:filename|file|path)?[:\s=]*([\w.\-]+\.\w{1,8})\s*\*?\/?\s*$/i);
    if (fileHint && fileHint[1].length <= 60) filename = fileHint[1];
    const langLabel = lang || 'text';
    // Encode the raw code in a data attribute (URI-encoded) so the click
    // handler can pull it back out without re-parsing the HTML.
    const encoded = encodeURIComponent(cleanCode);
    const langKey = (lang || '').toLowerCase();
    const runnable = RUNNABLE_LANGS.has(langKey);
    const isHtml = langKey === 'html' || langKey === 'htm';
    const outputLabel = isHtml ? '▷ Preview' : '▷ Run';
    const outputTitle = isHtml ? 'Render HTML inside the app' : `Run as ${langLabel}`;
    return `<div class="code-block">
      <div class="code-block-head">
        <span class="code-block-lang">${escapeHtml(langLabel)}</span>
        <span class="code-block-actions">
          <button type="button" class="code-block-action" data-cb-action="edit" data-cb-content="${encoded}" data-cb-lang="${escapeHtml(langKey)}" data-cb-filename="${escapeHtml(filename)}" title="Open in built-in editor">✎ Edit</button>
          ${runnable ? `<button type="button" class="code-block-action code-block-action-run" data-cb-action="output" data-cb-content="${encoded}" data-cb-lang="${escapeHtml(langKey)}" data-cb-filename="${escapeHtml(filename)}" title="${escapeHtml(outputTitle)}">${outputLabel}</button>` : ''}
          <button type="button" class="code-block-action" data-cb-action="copy" data-cb-content="${encoded}" title="Copy to clipboard">Copy</button>
          <button type="button" class="code-block-action" data-cb-action="download" data-cb-content="${encoded}" data-cb-filename="${escapeHtml(filename)}" title="Download ${escapeHtml(filename)}">⤓ ${escapeHtml(filename)}</button>
        </span>
      </div>
      <pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(cleanCode)}</code></pre>
    </div>`;
  });
  html = html.replace(/\x00IC(\d+)\x00/g, (_m, i) => `<code>${escapeHtml(inlineCode[+i])}</code>`);

  return html;
}

// Langs that have a "▷ Run" / "▷ Preview" button — HTML renders inline, the
// rest are spawned via shell:run_code_stream in the main process.
const RUNNABLE_LANGS = new Set([
  'html', 'htm',
  'py', 'python',
  'js', 'javascript', 'mjs',
  'ts', 'typescript',
  'ps1', 'powershell',
  'sh', 'bash',
  'bat', 'cmd'
]);

// Map fenced-code language tags to file extensions for the download button's
// default filename. Lowercase keys.
const LANG_TO_EXT = {
  py: 'py', python: 'py',
  js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs',
  ts: 'ts', typescript: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml',
  xml: 'xml', svg: 'svg',
  md: 'md', markdown: 'md',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  ps1: 'ps1', powershell: 'ps1',
  bat: 'bat', cmd: 'bat',
  c: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
  h: 'h', hpp: 'hpp',
  rs: 'rs', rust: 'rs',
  go: 'go',
  java: 'java',
  kt: 'kt', kotlin: 'kt',
  swift: 'swift',
  rb: 'rb', ruby: 'rb',
  php: 'php',
  sql: 'sql',
  vue: 'vue', svelte: 'svelte',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  scala: 'scala',
  ex: 'ex', elixir: 'ex',
  hs: 'hs', haskell: 'hs',
  pl: 'pl', perl: 'pl',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  csv: 'csv', tsv: 'tsv',
  txt: 'txt', text: 'txt',
  diff: 'diff', patch: 'patch'
};
