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
  pullProgress: {},       // tag → { received, total }
  pullChannels: new Map(),// tag → channelId (so we can abort)
  paused: new Set(),      // tags whose pull was paused (partial download exists)
  cancelled: new Set(),   // tags currently being cancelled (transient — for cleanup branch)
  runningChats: new Map(),// chatId → { channelId, abortRequested } — drives the send/stop button
  pendingAttachments: [],
  settings: { instructions: '' },
  ollamaDetected: null,
  ollamaRunning: false,
  ollamaBusy: false,
  recentlyInstalled: new Set(), // tags that just finished — show ✓ briefly
  // Status of Video Analysis prerequisites. Refreshed on init + every time the
  // model picker opens, so the dedicated Video Analysis section can show live
  // ✓/Install state for ffmpeg and Whisper without polling.
  videoDeps: { ffmpeg: null, whisper: null, lastChecked: 0 },
  videoDepInstalling: new Set() // 'ffmpeg' / 'whisper' currently being installed
};

// ============== BOOT ==============
(async function init() {
  state.catalog = await window.api.catalog();
  loadFromStorage();
  loadSettings();
  applyTheme(state.settings.theme || 'sanctum');

  await detectOllama();
  await refreshOllama();
  setInterval(refreshOllama, 8000);

  if (!state.order.length) {
    createChat();
  } else {
    setActive(state.order[0]);
  }

  wireCodeBlockActions();
  wireVideoBubbleActions();
  wireDragDrop();
  wireSidebar();
  wireComposer();
  wireAttachments();
  wireTitleEdit();
  wireModelPicker();
  wireModelsView();
  wireSettings();
  wireWebToggle();
  wireThinkToggle();
  wireToolsMenu();
  wireAgentBar();
  wireAgentOpts();
  wireInstallBanner();
  renderChatList();
  renderCatalog();
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
    if (state.catalog) {
      const fallback = state.catalog.categories.chat.picks.find(p => !p.multimodal)?.tag;
      for (const id of state.order) {
        const c = state.chats[id];
        if (!c) continue;
        const pick = allPicks().find(p => p.tag === c.model);
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
  const modality = modalityOverride || modalityForModel(defaultModel);
  state.chats[id] = {
    id, title: '', model: defaultModel, modality,
    createdAt: Date.now(), updatedAt: Date.now(),
    messages: [],
    ...(extraFields || {})
  };
  state.order.unshift(id);
  setActive(id);
  saveToStorage();
  renderChatList();
}

// Spin up an Agent-modality chat with Plan + Approval modes enabled by default.
function createAgenticChat() {
  if (!state.catalog) return;
  const picks = state.catalog.categories.agent?.picks || [];
  // Prefer an already-installed agent model; fall back to the first listed.
  const installedPick = picks.find(p => p.tag && state.installed.has(p.tag));
  const fallback = picks[0];
  const model = (installedPick || fallback)?.tag;
  if (!model) return;
  createChat(model, 'agent', {
    planMode: true,             // safer default — plan first, no execution
    approvalMode: false,        // mutually exclusive with planMode
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
    if (state.order.length) setActive(state.order[0]);
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
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
    if (cat.picks.some(p => (p.tag || p.file) === modelId)) return key;
  }
  return 'chat';
}

function isMultimodal(modelId) {
  const pick = allPicks().find(p => (p.tag || p.file) === modelId);
  return !!pick?.multimodal;
}

// Whether a model's quality-of-tool-calling is good enough to expose web tools
// in the UI. Small models (Llama 3.2 3B) and vision-only models tend to emit
// malformed tool calls. Picks default to capable; set tools_capable=false in
// models.json to opt out.
function modelSupportsTools(modelId) {
  const pick = allPicks().find(p => (p.tag || p.file) === modelId);
  if (!pick) return false;
  return pick.tools_capable !== false;
}

// Whether the model has a native "thinking" mode controllable via /think and
// /no_think soft switches (Qwen3 family).
function modelSupportsThinking(modelId) {
  const pick = allPicks().find(p => (p.tag || p.file) === modelId);
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

// ============== CODE AUTO-ROUTING ==============
// Heuristic detector for "the user is asking for code" — used in general chat
// mode to transparently forward the turn to an installed coding model.
// Strong signals: code fences in the user's message, "write a function",
// language names paired with action verbs, "fix this code", etc.
function isLikelyCodeRequest(text) {
  if (!text) return false;
  // Fenced code block in the prompt — almost always means "look at this code"
  if (/```[\s\S]*?```/.test(text)) return true;
  const patterns = [
    /\b(write|build|create|implement|generate|make|give\s+me|show\s+me|code)\s+(?:me\s+)?(?:a|an|the|some)?\s*(function|class|method|module|script|program|component|widget|app|api|endpoint|loop|algorithm|regex|query|snippet)\b/i,
    /\b(fix|debug|refactor|rewrite|optimize|improve|explain|review)\s+(?:this|my|the|some)?\s*(code|function|bug|script|method|class|file)\b/i,
    /\b(in|using|with)\s+(python|javascript|typescript|java|c\+\+|rust|go(?:lang)?|ruby|php|swift|kotlin|sql|html|css|bash|powershell|node(?:\.?js)?|react|vue|svelte|dart|scala|elixir|haskell)\b/i,
    /\b(python|javascript|typescript|rust|go|ruby|java|c\+\+|sql|html|css|bash|powershell|react|vue|svelte)\s+(code|script|function|method|program|file|module|snippet)\b/i,
    /\bcode\s+(it|this|that|me|in)\b/i,
    /\bhow\s+(do|can|to)\s+i\s+(code|write|implement|build|make)\b/i
  ];
  return patterns.some(p => p.test(text));
}

// Find the first installed coding model from the catalog's `code` category.
function pickInstalledCodeModel() {
  const picks = state.catalog?.categories.code?.picks || [];
  for (const p of picks) {
    if (p.tag && state.installed.has(p.tag)) return p.tag;
  }
  return null;
}

// Friendly display name for a model tag — pulled from the catalog so the
// routing badge can show "Routed to Qwen2.5-Coder 32B" not "qwen2.5-coder:32b".
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
  } else {
    pill.classList.add('up');
    state.installed = new Set((res.models || []).map(m => m.name));
    val.textContent = `${state.installed.size} ready`;
    state.ollamaRunning = true;
  }
  populateModelPicker();
  renderInstallBanner();
  renderCatalog();
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
  $('#new-agentic-chat').addEventListener('click', () => createAgenticChat());
  $('#open-models').addEventListener('click', () => switchView('models'));
  $('#open-settings').addEventListener('click', () => openSettings());
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

  // Plan and Approval are mutually exclusive: turning one on turns the other
  // off. Plan Mode = the agent only plans, never acts. Approval Mode = the
  // agent acts but every tool call needs explicit user approval.
  const mutexToggle = (btnId, fieldName, opposingField, opposingBtnId) => {
    const btn = $(`#${btnId}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const c = currentChat();
      if (!c || c.modality !== 'agent') return;
      c[fieldName] = !c[fieldName];
      btn.setAttribute('aria-pressed', c[fieldName] ? 'true' : 'false');
      if (c[fieldName]) {
        c[opposingField] = false;
        const opposing = $(`#${opposingBtnId}`);
        if (opposing) opposing.setAttribute('aria-pressed', 'false');
      }
      saveToStorage();
    });
  };
  mutexToggle('toggle-plan',     'planMode',     'approvalMode', 'toggle-approval');
  mutexToggle('toggle-approval', 'approvalMode', 'planMode',     'toggle-plan');
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

function renderChatList() {
  const list = $('#chat-list');
  if (!list) return;
  list.innerHTML = '';
  const groups = groupChatsByDate(state.order.map(id => state.chats[id]).filter(Boolean));
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
function wireModelsView() { $('#close-models').addEventListener('click', () => switchView('chat')); }

// Apply a theme by setting data-theme on <html>. The CSS variable overrides
// inside :root[data-theme="dark"] swap the entire palette. Stored in
// state.settings.theme so it persists across sessions.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme'); // Sanctum is the default :root
}

// ============== SETTINGS ==============
function wireSettings() {
  const overlay = $('#settings-overlay');
  const close = $('#settings-close');
  const textarea = $('#setting-instructions');
  const saved = $('#setting-saved');

  textarea.value = state.settings.instructions || '';

  // Theme picker: reflect current theme + wire clicks
  const themePicker = $('#theme-picker');
  if (themePicker) {
    const currentTheme = state.settings.theme === 'dark' ? 'dark' : 'sanctum';
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

function openSettings() {
  $('#settings-overlay').hidden = false;
  $('#setting-instructions').focus();
}
function closeSettings() { $('#settings-overlay').hidden = true; }

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
    // Refresh the Video Analysis install status whenever the picker opens —
    // ffmpeg/whisper can be installed/uninstalled outside the app.
    if (opening) refreshVideoDeps();
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
    c.modality = modalityForModel(value);

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
const SELECTABLE_CATEGORIES = new Set(['chat', 'agent']);

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
  const activePick = allPicks().find(p => (p.tag || p.file) === activeModel);
  current.textContent = activePick?.name || activeModel || 'Select a model';

  // Build menu items
  menu.innerHTML = '';
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
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
      const id = p.tag || p.file;
      const isOllama = !!p.tag;
      // Multimodal picks (qwen2.5vl, llama3.2-vision) live in the chat category
      // but are auto-routed for image inputs — not pickable as the primary
      // model. They still appear in the picker so the user can DOWNLOAD them.
      const itemSelectable = categorySelectable && !p.multimodal;
      // Every model in the catalog is now an Ollama tag; check the installed
      // registry.
      const installed = state.installed.has(p.tag);
      const pulling = state.pulling.has(id);
      const justDone = state.recentlyInstalled.has(id);

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

      if (pulling || state.paused.has(id)) {
        // pullTag keyed by Ollama tag so granular progress updates can find
        // the right row.
        item.dataset.pullTag = id;
        const prog = state.pullProgress[id];
        const pct = (prog && prog.total) ? Math.round((prog.received / prog.total) * 100) : 0;
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
      } else if (!installed) {
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

// ============== ACTIVE CHAT RENDER ==============
function renderActiveChat() {
  const c = currentChat();
  if (!c) return;

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
      // Mutex safety: if a legacy chat had both planMode and approvalMode true,
      // prefer planMode (safer) and turn approval off.
      if (c.planMode && c.approvalMode) {
        c.approvalMode = false;
        saveToStorage();
      }
      $('#toggle-plan').setAttribute('aria-pressed', c.planMode ? 'true' : 'false');
      $('#toggle-approval').setAttribute('aria-pressed', c.approvalMode ? 'true' : 'false');
      $('#toggle-readonly').setAttribute('aria-pressed', c.readOnly ? 'true' : 'false');
      $('#toggle-nofetch').setAttribute('aria-pressed', c.noFetch ? 'true' : 'false');
    }
  }

  // Web toggle only makes sense when the model actually supports tool calls.
  const supportsTools = modelSupportsTools(c.model);
  $('#toggle-web').hidden = !textLike || !supportsTools;

  // If user had Web on for a previous tool-capable model and switched to one
  // that isn't, silently turn it off so we don't send tools the model will
  // mishandle.
  if (!supportsTools && c.webEnabled) {
    c.webEnabled = false;
    saveToStorage();
  }

  const wb = $('#toggle-web');
  if (wb) wb.setAttribute('aria-pressed', c.webEnabled === true ? 'true' : 'false');

  // Think toggle — only visible when the model has Qwen3-style /think soft
  // switches (currently just qwen3:30b-a3b).
  const supportsThinking = modelSupportsThinking(c.model);
  $('#toggle-think').hidden = !textLike || !supportsThinking;
  if (!supportsThinking && c.thinkingEnabled) {
    c.thinkingEnabled = false;
    saveToStorage();
  }
  const tb = $('#toggle-think');
  if (tb) tb.setAttribute('aria-pressed', c.thinkingEnabled ? 'true' : 'false');

  // Hide the abilities-menu button entirely if neither toggle is available
  // for this model+modality. If one is visible, keep the dropdown so the user
  // sees the remaining option in there.
  const menuBtn = $('#tools-menu-btn');
  if (menuBtn) {
    const webShown = !($('#toggle-web')?.hidden);
    const thinkShown = !($('#toggle-think')?.hidden);
    menuBtn.hidden = !webShown && !thinkShown;
    // Reflect "any ability on" with a subtle highlight on the menu button.
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
    if (!modelSupportsThinking(c.model)) return;
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
    const why = m.routedReason === 'code' ? 'coding intent' : 'vision' ;
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

  if (m.toolEvents?.length) {
    for (const ev of m.toolEvents) el.appendChild(renderToolEvent(ev));
  }

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
  // shown if the chat is actually in Qwen3 /think mode; otherwise it's just
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

function renderToolEvent(ev) {
  const el = document.createElement('div');
  el.className = `tool-event ${ev.status || 'done'}`;
  const argSummary = ev.argSummary || '';
  const icons = {
    web_search:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    web_fetch:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>`,
    describe_image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    calc:           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h4M8 15h2M12 15h4M8 19h2M12 19h4"/></svg>`,
    read_file:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>`,
    list_dir:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    write_file:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>`,
    apply_patch:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>`,
    run_command:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>`,
    run_command_async: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polygon points="10 8 16 12 10 16" fill="currentColor" stroke="none"/></svg>`,
    glob:           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="13" cy="14" r="3"/><path d="m17 18-1.5-1.5"/></svg>`,
    grep:           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6M11 8v6"/></svg>`,
    task_status:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    task_list:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
    task_kill:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>`
  };
  const icon = icons[ev.name] || icons.web_fetch;
  const prettyName = ({
    web_search: 'web_search',
    web_fetch: 'web_fetch',
    describe_image: 'reading image',
    calc: 'calc',
    read_file: 'read_file',
    list_dir: 'list_dir',
    write_file: 'write_file',
    apply_patch: 'apply_patch',
    run_command: 'run_command',
    run_command_async: 'run_command · async',
    glob: 'glob',
    grep: 'grep',
    task_status: 'task_status',
    task_list: 'task_list',
    task_kill: 'task_kill'
  })[ev.name] || ev.name;
  // Show the result summary even on error so the user can see WHY it failed
  // (e.g. "timeout", "denied by user") instead of an
  // opaque "error".
  let statusText;
  if (ev.status === 'running') statusText = 'running';
  else if (ev.status === 'error') statusText = ev.resultSummary ? `error · ${ev.resultSummary}` : 'error';
  else statusText = ev.resultSummary || 'done';
  el.innerHTML = `
    ${icon}
    <span class="te-name">${escapeHtml(prettyName)}</span>
    <span class="te-arg">${escapeHtml(argSummary)}</span>
    <span class="te-status">${escapeHtml(statusText)}</span>
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
  if (state.installed.has(tag)) { banner.hidden = true; banner.innerHTML = ''; return; }

  // In-flight pull (downloading or paused) — show progress + pause/cancel.
  if (state.pulling.has(tag) || state.paused.has(tag)) {
    const prog = state.pullProgress[tag] || { received: 0, total: 0 };
    const pct = prog.total ? Math.round((prog.received / prog.total) * 100) : 0;
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
        state.pullProgress[tag] = { received: chunk.completed, total: chunk.total };
        patchPullProgress(tag);
        patchInstallBannerProgress(tag);
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
    return;
  }
  // CANCELLED — clear progress, refresh installed list (the DELETE may have run),
  // re-render with the install button back.
  if (state.cancelled.has(tag)) {
    state.cancelled.delete(tag);
    delete state.pullProgress[tag];
    await refreshOllama();
    return;
  }

  // Refresh and check if the pull succeeded.
  const list = await window.api.ollama.list();
  const installedNow = !list.error && (list.models || []).some(m => m.name === tag);
  delete state.pullProgress[tag];

  if (installedNow) {
    state.recentlyInstalled.add(tag);
    await refreshOllama();
    setTimeout(() => {
      state.recentlyInstalled.delete(tag);
      populateModelPicker();
    }, 2500);
    return;
  }

  // Surface a friendly error in the install banner.
  const banner = $('#install-banner');
  if (banner) {
    banner.hidden = false;
    let msg;
    if (sawError) msg = `Pull failed: ${lastErrorMessage}`;
    else if (chunkCount === 0) msg = `No data received from Ollama. Try again, or check that Ollama isn't being blocked by antivirus / firewall.`;
    else if (!receivedAnyProgress) msg = `Pull stalled after manifest fetch. Try \`ollama pull ${tag}\` in a terminal to see the underlying error.`;
    else msg = `Stream ended early after ${chunkCount} chunks. Try again.`;
    banner.innerHTML = `
      <div class="ib-text">
        <strong>${escapeHtml(tag)} didn't finish installing.</strong>
        <span class="sub">${escapeHtml(msg)}</span>
      </div>
      <button type="button" data-action="install" data-tag="${escapeHtml(tag)}">Try again</button>
    `;
  }
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
    const pct = prog.total ? Math.round((prog.received / prog.total) * 100) : 0;
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
    const pct = Math.round((prog.received / prog.total) * 100);
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
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
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

  if (backend === 'ollama' && !state.installed.has(c.model)) {
    const banner = $('#install-banner');
    if (banner) banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// ============== OLLAMA CHAT (with tool loop + vision bridge) ==============
async function runOllamaChat(c, attachments) {
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
    thinkingMode: !!(c.thinkingEnabled && modelSupportsThinking(c.model))
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

  // Qwen3 thinking-mode soft switch — append /think or /no_think to the
  // latest user turn. The model honours the most recent directive in history.
  if (modelSupportsThinking(c.model) && history.length) {
    const directive = c.thinkingEnabled ? ' /think' : ' /no_think';
    history[history.length - 1].content = (history[history.length - 1].content || '') + directive;
  }
  let imageAttachments = (attachments || []).filter(a => a.kind === 'image');
  let imgs = imageAttachments.map(a => a.base64);

  // VISION BRIDGE: if the active model can't natively see images but the user attached some,
  // route each through an installed vision model first and inject the description as text.
  if (imageAttachments.length && !isMultimodal(c.model)) {
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

  // Code auto-route: if the user is in plain chat and asks a code question,
  // silently swap to an installed coding model for this turn. Surfaced via
  // the routedTo badge on the assistant message.
  let effectiveModel = c.model;
  if (c.modality === 'chat') {
    const lastUser = [...c.messages].reverse().find(m => m.role === 'user');
    if (lastUser && isLikelyCodeRequest(lastUser.content)) {
      const codeModel = pickInstalledCodeModel();
      if (codeModel && codeModel !== c.model) {
        effectiveModel = codeModel;
        assistantMsg.routedTo = codeModel;
        assistantMsg.routedReason = 'code';
        renderActiveChat();
      }
    }
  }

  const MAX_ROUNDS = Math.max(1, Math.min(50, c.maxSteps || 5));
  let round = 0;
  let aborted = false;
  let lastContent = '';

  while (round < MAX_ROUNDS && !aborted) {
    round++;

    const payload = { model: effectiveModel, messages: history };
    // Cap the context window so big models like Qwen3 30B-A3B don't OOM. The
    // KV cache for the default 32K context is ~13 GB on its own; 8K is the
    // safe default that fits comfortably in 32 GB systems.
    payload.options = { num_ctx: c.contextWindow || 8192 };
    if (tools) payload.tools = tools;
    if (round === 1 && imgs.length) payload.images = imgs;

    let acc = '';
    let collectedToolCalls = [];

    await window.api.ollama.chat(payload, (chunk) => {
      // First chunk: record the channelId so a click on Stop can abort this stream.
      if (chunk._channelId) {
        const run = state.runningChats.get(c.id);
        if (run) run.channelId = chunk._channelId;
      }
      if (chunk.aborted) {
        // Clean exit caused by the user pressing Stop. Don't surface an error.
        aborted = true;
        return;
      }
      if (chunk.error) {
        acc = friendlyOllamaError(chunk.error, c);
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
        patchLastMessageContent(assistantMsg);
      }
      if (chunk.message?.tool_calls?.length) {
        if (assistantMsg.thinking) assistantMsg.thinking = false;
        collectedToolCalls.push(...chunk.message.tool_calls);
      }
    });

    if (aborted) break;
    lastContent = acc;

    if (!collectedToolCalls.length) break;

    // Record assistant turn in history (for tool feedback loop)
    history.push({ role: 'assistant', content: acc, tool_calls: collectedToolCalls });

    // Execute each tool, append results
    for (const call of collectedToolCalls) {
      const name = call.function?.name || call.name;
      let args = call.function?.arguments || call.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }

      const ev = {
        name,
        argSummary: summarizeArgs(name, args),
        status: 'running'
      };
      assistantMsg.toolEvents.push(ev);
      patchLastMessage(assistantMsg);

      const { result, summary, ok } = await executeTool(name, args);
      ev.status = ok ? 'done' : 'error';
      ev.resultSummary = summary;
      patchLastMessage(assistantMsg);

      history.push({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result) });
    }
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
  if (run.channelId) window.api.ollama.chatAbort(run.channelId);
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
};

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

You are in Plan Mode. Your job is to PLAN, not execute. You MUST NOT call any tools while Plan Mode is on — not now, not after the user asks again, not even if they insist, complain, or get frustrated. Plan Mode and Approval Mode are mutually exclusive: Plan Mode is for designing the plan; Approval Mode is what the user must switch to in order to actually execute it (with per-call approval).

For every user request, respond with:
1. A numbered list of each step you would take.
2. For each step, name the specific tool you would call and the key arguments.
3. Potential risks, side effects, and files/state that would be touched.
4. End with this exact line: "Plan Mode is on — I won't execute any of this. To run this plan, toggle off Plan Mode and toggle on Approval Mode in the safety bar; I'll then execute it step by step, asking you to approve each tool call."

If the user pushes you to "just do it" / "go ahead" / "stop planning" / "run it anyway" / anything similar, DO NOT call tools. Calmly explain that Plan Mode is read-only by design and they must switch to Approval Mode to execute. Then offer to refine the plan instead.

You may revise the plan when asked. You may answer questions about the plan. You may NOT take action while Plan Mode is on.`;

// Auto-route: given the user's current chat/agent model, find the tier-matched
// model in another category. So "smartest chat" → "smartest image", etc.
function tierMatchedModel(currentModelId, targetCategory) {
  if (!state.catalog) return null;
  const target = state.catalog.categories[targetCategory];
  if (!target?.picks?.length) return null;

  let sourceTier = 0;
  for (const sourceKey of ['chat', 'agent']) {
    const picks = (state.catalog.categories[sourceKey]?.picks || []).filter(p => !p.multimodal);
    const idx = picks.findIndex(p => (p.tag || p.file) === currentModelId);
    if (idx >= 0) { sourceTier = idx; break; }
  }
  const clamped = Math.min(sourceTier, target.picks.length - 1);
  const matched = target.picks[clamped];
  return matched?.tag || matched?.file || null;
}

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
  const alwaysGated = ['write_file', 'apply_patch', 'run_command', 'run_command_async'].includes(name);
  const forceApproval = c?.approvalMode === true;
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

  if (!skipApproval && (alwaysGated || forceApproval) && name !== 'calc') {
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
    // Place body after any existing attachments/tool-events so order matches
    // the full renderer's output.
    const pending = lastEl.querySelector(':scope > .msg-pending');
    if (pending) lastEl.insertBefore(body, pending);
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

  // Only auto-scroll when the user is already near the bottom so we don't
  // hijack them mid-scroll.
  const nearBottom = (list.scrollHeight - list.clientHeight - list.scrollTop) < 80;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// ============== CATALOG ==============
function renderCatalog() {
  const c = $('#catalog');
  if (!c || !state.catalog) return;
  c.innerHTML = '';
  for (const [key, cat] of Object.entries(state.catalog.categories)) {
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <div class="cat-label">${escapeHtml(key)}</div>
      <h2>${escapeHtml(cat.label)}</h2>
      ${cat.picks.map((p, i) => {
        const installed = state.installed.has(p.tag);
        const tagText = p.tag;
        const tagClass = installed ? 'cat-tag installed' : 'cat-tag';
        const ranks = ['i.', 'ii.', 'iii.', 'iv.', 'v.'];
        const rank = ranks[i] || `${i + 1}.`;
        const mmBadge = p.multimodal ? `<span class="cat-badge router">vision · auto</span>` : '';
        return `
          <div class="cat-pick">
            <div class="cat-pick-head">
              <span class="cat-rank">${rank}</span>
              <span class="cat-name">${escapeHtml(p.name)}</span>
              ${mmBadge}
            </div>
            <span class="${tagClass}">${escapeHtml(tagText)}</span>
            <p class="cat-why">${escapeHtml(p.why)}</p>
            <div class="cat-meta">
              ${p.ram_gb ? `<span>RAM <strong>${p.ram_gb} GB</strong></span>` : ''}
              ${p.vram_gb ? `<span>VRAM <strong>${p.vram_gb} GB</strong></span>` : ''}
              ${p.context ? `<span>Context <strong>${(p.context / 1024).toFixed(0)}K</strong></span>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    `;
    c.appendChild(card);
  }
}

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

  // 4. Bold + italic + links.
  src = src.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
    if (!/^https?:\/\//.test(url)) return m;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });

  // 5. Block-level: process line by line. Flat lists (no nesting) — keeps the
  // parser simple and works for typical LLM output. Indented sub-bullets are
  // promoted to their own list right after the parent item.
  const lines = src.split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (!trimmed) { closeList(); continue; }

    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${h[2]}</h${lvl}>`); continue; }

    const ul = trimmed.match(/^[*\-]\s+(.+)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    const ol = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
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
