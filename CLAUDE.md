# Sanctum

A private, local-first AI workspace. Electron desktop app. Chat, vision, code, video analysis, and agentic tasks — everything runs on the user's own machine via Ollama, with optional cloud models (Claude, Gemini) when the user supplies an API key.

Current version: **v0.3.9**. Repo: `HighStormPVP/Sanctum`.

## Running it

```bash
npm start          # launches via launch.js
```

**Never call `electron .` directly.** This machine has `ELECTRON_RUN_AS_NODE=1` set globally, which makes Electron run as plain Node — `require('electron')` returns a path string instead of the API object and `app.whenReady()` throws. `launch.js` clones `process.env`, deletes that var, then spawns the electron binary. `npm start` routes through it.

To restart during dev (Git Bash needs escaped flags):
```bash
taskkill //IM electron.exe //F && npm start
```

## Architecture

Three files carry almost everything:

| File | Lines | Role |
|---|---|---|
| `renderer.js` | ~5.3K | All UI, chat loop, tool execution, state |
| `main.js` | ~1.9K | IPC handlers, Ollama + cloud streaming, fs/shell/web |
| `preload.js` | ~230 | contextBridge — the only renderer↔main surface |

Plus `index.html` (markup), `style.css` (~3K lines), `models.json` (catalog), `lib/mcp-*.js` (MCP client/manager).

`contextIsolation: true`, `nodeIntegration: false`. Renderer touches the OS **only** through `window.api`.

### State

Everything lives in one `state` object in `renderer.js`, persisted to localStorage under two keys:
- `localai.state.v1` — chats, order, activeId
- `localai.settings.v1` — theme, instructions, apiKeys, sidebarCollapsed

Each chat carries its own model, modality, and agent flags. There's no server, no DB, no sync.

## Model catalog (`models.json`)

Categories: `cloud`, `chat`, `vision`, `code`, `agent`. Each pick is an object; the fields that matter:

- `tag` — Ollama pull string (local picks only)
- `provider` + `model_id` — cloud picks (`anthropic` / `google`); **no `tag`**
- `tools_capable` — defaults true; set false to hide tool toggles
- `thinking_capable` — surfaces the Thinking toggle
- `multimodal` — vision router, auto-routed, not user-pickable

### The `tag`-only lookup trap

Cloud picks have no `tag`. Any lookup written as `p.tag === modelId` silently misses every cloud model. This caused four separate shipped bugs (v0.3.0–v0.3.6) — boot migration wiping cloud picks, capability toggles vanishing, and the Send button silently no-oping because `modalityForModel` fell through to `'chat'` → `backendForModel` returned `'ollama'` → `dispatchSend` bailed at the install-check gate.

**Always use `findPick(modelId)`.** It checks `tag || model_id || id || file` plus an id-only fallback. Same for `pickProvider()` and `pickReady()`.

## Cloud providers

Adding a provider is bounded work — the renderer doesn't change:

1. Add picks to `models.json` with `provider: 'newname'`, `model_id`, `tools_capable: true`
2. Add a Settings field in `index.html`, wire it in `wireSettings()` → `state.settings.apiKeys.newname`
3. Write `streamNewname({...})` in `main.js` — takes Ollama-shape messages/tools, emits Ollama-shape chunks via `evt.sender.send(channelId, ...)`
4. Branch on `provider` in the `cloud:chat` handler

The contract: every provider emits `{ message: { content?, tool_calls? }, done, prompt_eval_count, eval_count }`. That's why the existing tool loop, token counter, and Stop button work unchanged across Ollama/Anthropic/Gemini.

### Provider gotchas (learned the hard way)

**Anthropic:**
- Never date-suffix model ids. `claude-haiku-4-5-20251001` → 400. It's just `claude-haiku-4-5`.
- Default `max_tokens: 64000` for streaming, not 8192 — hitting the cap truncates mid-thought and reads as "send is broken".
- Empty `{type:'text', text:''}` blocks are rejected. Skip the message entirely if it has no text and no tool_use.
- Thinking: Opus 4.x / Sonnet 4.6 → `{type: 'adaptive'}`. Haiku 4.5 → manual only, `{type: 'enabled', budget_tokens: N}`.

**Gemini:**
- Tool schemas reject `$schema` and `additionalProperties` — `toGeminiTools` sanitizes recursively.
- Tool results are user-role messages with `parts: [{functionResponse: {name, response}}]`. `response` must be an object; wrap bare strings as `{result: str}`. The `name` must match the original `functionCall.name` — that's why history entries carry `tool_name` alongside `tool_call_id`.
- Thinking: Pro is structurally always-on (`thinking_level: LOW` is the floor, no true off). Flash/Flash-Lite accept `thinking_budget: 0` to disable.

**Both:** SSE parsing normalizes `\r\n → \n` before splitting frames on `\n\n`. Cloud errors must NOT go through `friendlyOllamaError` — it rewrites "fetch failed" into "Couldn't reach Ollama", which is nonsense for an Anthropic call.

## Chat loop

`dispatchSend()` → `runOllamaChat()` (wrapper with try/catch/finally) → `_runOllamaChatInner()`.

The wrapper exists because a throw inside the loop used to strand the chat id in `state.runningChats`, which freezes Send as Stop and silently swallows every subsequent submit. The `finally` always deletes the entry.

Inside the loop: build history → inject system prompts → resolve provider via `findPick` → pick `chatFn` (cloud vs ollama) → stream → collect tool calls → execute → repeat up to `maxSteps` rounds.

### Auto-routes (and when to skip them)

Chat modality silently swaps models for code questions (`pickInstalledCodeModel`) and images (vision bridge). **Both skip when the picked model is a cloud pick** — Claude and Gemini handle code and images natively, and swapping a deliberate Opus pick for a local 7B was a surprise, not a feature.

### Qwen3 `/think` gating

The `/think` `/no_think` soft-switch append is Qwen3-specific and gated to `pickProvider(pick) === 'ollama'`. Sending it to Claude gets you a confused response explaining what the tag would mean. Cloud thinking goes through `payload.options.thinking_enabled` → translated per-provider in `main.js`.

## Agent mode

Three mutually exclusive safety modes, **exactly one always on** (defaults to Plan):

| Mode | Behavior |
|---|---|
| **Plan** | Reads allowed, writes blocked at the executor. Agent calls `exit_plan_mode(plan)` → modal with Approve/Reject. Approve flips chat to Approval Mode. |
| **Approval** | Executes, but every write-class tool pops a per-call modal. |
| **No-Approval** | YOLO. No modal, even for `run_command` / `write_file`. Amber-orange styling so it never reads as safe-default. |

Plus independent `readOnly` and `noFetch` toggles.

Clicking the active mode is a no-op — there's no "off" state. `mutexToggle()` in `wireAgentBar()` enforces this; `renderActiveChat()` re-asserts it on every render for legacy chats.

Agentic chats are locked until a project folder is picked. `createAgenticChat()` keeps the current model if it's tools-capable AND ready, otherwise falls back to the agent catalog.

### Tool execution

`executeToolImpl(name, args)` is the gate. Order matters:
1. Plan Mode block (writes → error pointing at `exit_plan_mode`)
2. `exit_plan_mode` handler (modal → flip modes on approve)
3. Read-only enforcement
4. No-fetch enforcement
5. Approval modal (unless `skipAllApprovals` or command allowlist pre-approves)
6. Actual dispatch

`alwaysGated` = `write_file`, `apply_patch`, `run_command`, `run_command_async`, `mcp_add_server`, `mcp_remove_server`.

Everything writes to an audit log (`window.api.audit.log`).

## Shell

`main.js` `detectShell()` runs once at boot. On Windows it probes for Git Bash (`C:\Program Files\Git\bin\bash.exe`) and uses it if present — so the agent can write POSIX syntax cross-platform. Falls back to `cmd.exe`. macOS/Linux get `/bin/sh`.

`preload.js` mirrors the probe synchronously so the renderer has the label from the first frame. **Both are wrapped in try/catch** — a throw in preload means `contextBridge.exposeInMainWorld` never fires, `window.api` is undefined, and the entire UI dies silently (no chats, no Ollama, nothing clickable).

## Tool event rendering

`renderToolEvent(ev)` dispatches:
- `run_command` / `run_command_async` → `renderShellToolEvent()` — full card, status dot + shell label + command preview, then a bordered IN/OUT box. Output capped at 4 KB.
- Everything else → `renderCompactToolEvent()` — status dot + friendly label (`TOOL_LABELS`) + arg + status.

Status dot colors: violet pulsing (running), green (done), red (error).

## Releases

Commit to `main` directly, then tag. CI (`.github/workflows/release.yml`) builds on tag push and publishes three artifacts: `Sanctum-{v}-arm64-mac.zip`, `Sanctum-{v}-mac.zip`, `Sanctum.Setup.{v}.exe`.

```bash
git tag -a v0.4.0 -m "v0.4.0" && git push origin v0.4.0
gh run watch <id> --repo HighStormPVP/Sanctum --exit-status
gh release edit v0.4.0 --repo HighStormPVP/Sanctum --notes "..."
```

Use `Closes #N` in the commit body to auto-close the issue. The release-publish glob must include every artifact extension produced — a missing extension silently ships an incomplete release.

Mac CI ships `.zip`, not `.dmg` (APFS `hdiutil` bug on Apple Silicon runners).

## Conventions

- Assistant messages render flat (no bubble); user messages keep the purple bubble.
- Composer caps at 5 lines (~130px), then scrolls internally.
- Markdown renderer handles both asterisk and underscore bold/italic. Underscore patterns use word-boundary lookarounds so `snake_case` survives.
- Debug logs: `%APPDATA%/sanctum/chat-debug.log` (chat streams), `pull-debug.log` (model pulls).
- Aesthetics: contemporary and sleek. No retro/instrument-panel/scan-line treatments.
