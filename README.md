# Sanctum

A private, fully-local AI workspace for Windows. Sanctum puts the best open-weights models for chat, coding, vision, agentic tool-use, and **video analysis** one click away — all running on your own machine, nothing leaving it.

---

## What's inside

Sanctum is an Electron front-end that talks to a single local backend:

```
┌──────────────────────┐     HTTP     ┌──────────────────┐
│  Sanctum (this app)  │ ───────────► │ Ollama :11434    │  ← all language + vision models
└──────────────────────┘              └──────────────────┘
```

For Video Analysis, Sanctum also drives two CLI tools you install on demand:

- **ffmpeg** — extracts frames + audio from videos
- **OpenAI Whisper** (Python) — local speech-to-text transcription

---

## The model picks

Categories visible in the picker (the model registry shows the same list with rationale):

| Category | Picks (top → bottom) |
|---|---|
| **General Chat & Reasoning** | Qwen3 30B-A3B · Llama 3.3 70B · Qwen2.5 7B · Qwen3.5 9B Abliterated · Dolphin-Mistral 7B · Llama 3.2 3B |
| **Vision** *(auto-routed for image attachments)* | Qwen2.5-VL 7B · Llama 3.2 Vision 11B |
| **Coding** *(auto-routed when chat looks like a code question)* | Qwen2.5-Coder 32B · DeepSeek-Coder-V2 Lite 16B · Qwen2.5-Coder 7B |
| **Agentic / Tool Use** | Qwen3 30B-A3B · Hermes 3 Llama 3.1 8B · Qwen3 8B |

All picks are open-weights and downloaded directly through the app — click the ⤓ icon next to a row in the picker.

**Vision routing.** When you attach an image to any chat, Sanctum captions it through a vision router (Qwen2.5-VL by default, Llama 3.2 Vision on bigger machines) and forwards the description into your selected chat model — so even a text-only model can "see."

**Code routing.** When your message in a general chat reads like a coding request, Sanctum silently routes that turn to an installed coding model. A small **`⚡ Routed to …`** badge on the assistant message tells you when this happened.

---

## Video Analysis

Drag any `.mp4`/`.mov`/`.mkv`/`.webm` into a chat (general or agentic) and Sanctum runs a multi-stage local pipeline:

1. **ffmpeg** extracts frames at 0.5 s and the audio as 16 kHz mono WAV
2. Frames are **perceptual-hash deduped** so static shots don't get re-captioned
3. The vision model runs an **identification pass** on two frames (early + middle) to anchor what the video is
4. Each unique frame is then **described** by the vision model
5. **Whisper** transcribes the audio with timestamps
6. Your chat model **synthesizes** a grounded description and pastes the full audio transcript below

Follow-up questions ("what's at 0:42?", "what's the speaker saying?") get answered against the full stored timeline + transcript — no re-extraction needed.

ffmpeg + Whisper are installable from the **Video Analysis · setup** section inside the model picker (one-click `winget install` / `pip install`).

---

## Setup

### 1. Install Ollama

Download from <https://ollama.com/download>. Runs as a background service on `localhost:11434`. Sanctum will offer a one-click installer if Ollama isn't on PATH when you first launch.

Pull whatever models you want from inside the app (model picker → ⤓ icon), or via CLI:

```powershell
ollama pull qwen3:30b-a3b
ollama pull qwen2.5-coder:32b
ollama pull qwen2.5vl:7b
ollama pull hermes3:8b
ollama pull llama3.2:3b
```

### 2. Install Sanctum

```powershell
npm install
npm start
```

`npm start` routes through `launch.js`, which clears the `ELECTRON_RUN_AS_NODE` environment variable before spawning Electron. If you ever see `Cannot read properties of undefined (reading 'whenReady')`, that env var is the cause — the launcher already handles it.

### 3. (Optional) Set up Video Analysis

Open the model picker, scroll to **Video Analysis · setup**, and click **Install** on the ffmpeg + Whisper rows. The app drives `winget install Gyan.FFmpeg` and `pip install openai-whisper` for you.

### 4. Package a distributable

Sanctum uses [`electron-builder`](https://www.electron.build/) for packaging.

```powershell
# Windows installer (.exe via NSIS)  — outputs to dist/
npm run dist:win

# macOS DMG (universal — Intel + Apple Silicon)  — must be run on a Mac
npm run dist:mac

# Linux AppImage
npm run dist:linux
```

### Tagged release builds (no Mac required)

A GitHub Actions workflow at [.github/workflows/release.yml](.github/workflows/release.yml) builds the **Windows installer + macOS DMG** automatically when you push a version tag. No Mac ownership required — GitHub provides macOS runners.

```bash
git tag v0.1.0
git push origin v0.1.0
```

→ A draft Release appears under your repo's Releases page with `Sanctum-0.1.0.dmg` (universal) and `Sanctum Setup 0.1.0.exe` attached. **The DMG is unsigned** — first-launch users on macOS need to right-click → Open to bypass Gatekeeper. To eliminate the warning, set up Apple Developer ID signing (notes inside the workflow file).

### Icon assets

The packager looks for:
- `assets/icon.icns` (macOS — 1024×1024 minimum)
- `assets/icon.ico` (Windows — multi-resolution)
- `assets/icon.png` (Linux — 512×512+)

If any are missing, electron-builder falls back to the default Electron icon — fine for dev, not great for shipping. The `iconutil` CLI on Mac or online converters can generate `.icns` from a PNG.

---

## Hardware reality check

| Hardware | What runs comfortably |
|---|---|
| **8 GB VRAM / 8 GB Mac unified** | Llama 3.2 3B, Qwen2.5 7B, Hermes 3 8B, Qwen2.5-VL 7B |
| **16 GB VRAM / 16 GB Mac unified** | Qwen3 8B, Qwen3.5 9B Abliterated, DeepSeek-Coder-V2 16B, Llama 3.2 Vision 11B |
| **24 GB VRAM** | Qwen3 30B-A3B (MoE — only ~3B active), Qwen2.5-Coder 32B |
| **48 GB+** | Llama 3.3 70B full quality |

Ollama auto-quantizes to fit available memory.

---

## Theming

Two palettes in **Settings → Theme**:

- **Sanctum** (default) — violet × cyan gradient on dark navy with an aurora background
- **Dark** — strict greyscale with two solid accent colors (violet for primary CTAs, emerald for the Agentic Chat button)

Switching is instant — no restart.

---

## Files

| File | What's in it |
|---|---|
| `main.js` | Electron main process, IPC handlers, Ollama client, ffmpeg + Whisper subprocess orchestration |
| `preload.js` | contextBridge → `window.api` surface for the renderer |
| `renderer.js` | UI logic, chat threads, model picker, video analysis pipeline coordinator |
| `index.html` / `style.css` | UI markup + theming |
| `models.json` | Curated model catalog with rationale, RAM hints, multimodal flags |
| `launch.js` | Cross-env Electron launcher that strips `ELECTRON_RUN_AS_NODE` |

---

## Known limits

- Video Analysis frames are JPEG at native resolution — long clips take minutes per minute of footage because each unique frame goes through the vision model sequentially.
- Whisper's `tiny` model is the default — accurate but biased toward English. Larger model sizes can be configured in the transcription IPC if you want to switch.
- The synthesis prompt is grounded against the captions — vague captions produce vague summaries by design, to avoid hallucination.
