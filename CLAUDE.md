# Sanctum

A private, local-first AI workspace. Electron desktop app. Chat, vision, code, video analysis, and agentic tasks — everything runs on the user's own machine via Ollama, with optional cloud models (Claude, Gemini) when the user supplies an API key.

Current version: **v0.4.6**. Repo: `HighStormPVP/Sanctum`.

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
| `renderer.js` | ~11.2K | All UI, chat loop, tool execution, state, the Remote Control mirror |
| `main.js` | ~3.2K | IPC handlers, Ollama + cloud streaming, fs/shell/web, Remote Control wiring |
| `preload.js` | ~310 | contextBridge — the only renderer↔main surface |

Plus `index.html` (markup), `style.css` (~3.9K lines), `models.json` (catalog), `lib/mcp-*.js` (MCP client/manager), and `remote-transport.html` with its preload: the hidden, sandboxed window that holds Remote Control's WebRTC channels and only ever sees ciphertext.

Rules that decide what's allowed live in `lib/`, free of Electron, so `npm test` can run them without launching the app:

| File | Rules |
|---|---|
| `lib/agent-rules.js` | Safety modes, command pre-approval. Loaded by the renderer through a `<script>` tag, and by tests through `require` |
| `lib/fs-rules.js` | Path allowlist, `apply_patch` replacement, file walking |
| `lib/url-rules.js` | `web_fetch` limits: no private addresses, redirect checks, timeout, size cap |
| `lib/grep-runner.js` | Agent grep in a worker with a time limit |
| `lib/cloud-params.js` | Per-model thinking, effort, fallback, and image rules |
| `lib/text-rules.js` | Repetition guard, output line splitting, Windows argument quoting |
| `lib/kill-tree.js` | Stops a process and everything it started |
| `lib/window-rules.js` | What a window may offer by how the app runs: no DevTools and no debug switches in a packaged build |
| `lib/remote-rules.js` | Remote Control's checks on hostile input: laptop actions, tool calls, devices, folders, PIN prompts, audit lines. Loaded by the renderer as `RemoteRules` |
| `lib/chat-mirror.js` | Snapshots a shared chat and diffs it into ops for the laptop, and applies them there. Loaded by the renderer as `ChatMirror` |

Remote Control's connection lives in `lib/remote/`, also free of Electron:

| File | Job |
|---|---|
| `lib/remote/crypto.js` | Thin wrappers over the noble libraries: Ed25519, X25519, XChaCha20-Poly1305, HKDF, device ids |
| `lib/remote/pake.js` | RFC 9382 SPAKE2 on P-256, the one piece of cryptography written here, checked against the RFC's vectors |
| `lib/remote/pairing.js` | The 6-character code rules, and the exchange that turns a code into each device knowing the other's key |
| `lib/remote/session.js` | Fresh keys per connection from the long-term keys, then encrypts and decrypts every frame |
| `lib/remote/link.js` | Ordered, exactly-once delivery over the relay and the direct path, so a switch loses nothing |
| `lib/remote/relay-client.js` | The WebSocket to the relay Worker, for a device's mailbox or the pairing slot |
| `lib/remote/direct-path.js` | WebRTC data channels per device, run in the hidden window, beside the relay |
| `lib/remote/keystore.js` | This device's identity, paired devices, PIN, and control switch, sealed with `safeStorage` |
| `lib/remote/manager.js` | Ties those together into "these devices can talk", and decides which tool calls get past the main process |

The relay Worker itself is in `relay/`, with its runbook in `relay/README.md`.

### Tests

```bash
npm test                    # lib/ rules and test/*.test.js, plain Node, under a minute
npm run test:relay          # the relay Worker in Miniflare; needs `npm ci --prefix relay` first
node e2e/mirror.e2e.js      # one end-to-end suite
```

`npm test` doesn't run `e2e/`. Each file there is run on its own with `node`: `actions`, `approvals`, `direct`, `folders`, `mirror`, `preload-surface`, `tools`, and `ui`. They start real Electron instances on temp profiles against the relay in Miniflare and a fake Ollama, so they need `npm ci` and `npm ci --prefix relay`, and Node 22 or later. They never load a real model. `e2e/harness.js` has what they share, and `SANCTUM_REMOTE_TEST` holds test-only flags that a packaged build ignores. Never launch Electron on the default profile from a test: the single-instance lock would hand over to a Sanctum that's already running.

The renderer's sandboxed preload can't read the disk, so anything it needs from the system comes through IPC.

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
- Thinking rules differ by model, and a wrong value is a 400. They live in `lib/cloud-params.js`: Opus 5.5 and Fable 5.x can't turn thinking off, so "off" means low effort. Sonnet 5.5 turns it off with `{type: 'between_tools'}`. Haiku 5.5 rejects `budget_tokens`; Haiku 4.x needs it.
- Replay tool turns unchanged. Signed thinking blocks travel on `tool_calls[0]._anthropic_content`.
- A decline is HTTP 200 with `stop_reason: 'refusal'`. Opus, Sonnet 5.5, and Fable send `fallbacks: 'default'`; Haiku 5.5 has no fallback.

**Gemini:**
- Tool schemas reject `$schema` and `additionalProperties` — `toGeminiTools` sanitizes recursively.
- Tool results are user-role messages with `parts: [{functionResponse: {name, response}}]`. `response` must be an object; wrap bare strings as `{result: str}`. The `name` must match the original `functionCall.name` — that's why history entries carry `tool_name` alongside `tool_call_id`.
- Thinking: Gemini 3+ has no off switch. "Off" means the lowest level that model accepts (see `lib/cloud-params.js`).
- Function calls carry a `thoughtSignature`, which has to go back on the same part or the next tool round can be rejected.

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

`executeToolImpl(name, args, c, offeredTools)` is the gate. Order matters:
1. Offered check (a tool this chat wasn't given is refused)
2. Mode refusals in `modeRefusal()`: Plan Mode blocks writes with an error pointing at `exit_plan_mode`, then Read-only, then No-fetch
3. `exit_plan_mode` handler (modal → flip modes on approve)
4. Which machine: the `device` argument, or the chat's folder default
5. Approval modal (unless `skipAllApprovals` or command allowlist pre-approves; the allowlist never pre-approves a call bound for a laptop). Mode refusals run again after the answer, since a mode can change on another device while a pop-up is open
6. Actual dispatch, or `runToolOnDevice()` for a laptop

**Tool execution uses `c`, never `currentChat()`.** `c` is the chat that asked for the tool, which may not be the one on screen: a chat running in the background, or one a laptop is driving. Its modes, folders, allowlists, and devices are the ones that apply. `currentChat()` anywhere in tool execution, or in anything it calls, applies another chat's rules. The same goes for actions a laptop sends home: they work on the chat the frame names.

`alwaysGated` = `write_file`, `apply_patch`, `run_command`, `run_command_async`, `mcp_add_server`, `mcp_remove_server`.

Everything writes to an audit log (`window.api.audit.log`). Each device also keeps `remote-audit.log` of what ran on it through Remote Control, and `remote-refusals.log` of the tool calls it refused.

## Remote Control

A laptop mirrors and drives chats running on a home PC, and the home model can use tools on the laptop. The design is `docs/superpowers/specs/2026-11-04-remote-control-design.md`.

- **Roles.** In each pairing, one device is the home PC and the other the laptop. One install can be home to some devices and a laptop to others. The home PC holds the chats, keys, and models, and runs the chat loop. The laptop keeps no chat data on disk. A chat is shared while its `remoteControl` is on, from the message box menu. On the laptop it's `remote:<homeId>:<chatId>` with a `c.remote`, and every control on it sends an `action` home instead of changing anything locally.
- **Off until set up.** Nothing shows and nothing connects until a service address is pasted in Settings > Devices. It holds the relay's secret, so it's never logged and never in the repo (`test/no-relay-address.test.js`).
- **The switch.** "Let my home PC control this laptop" lives only on the laptop and is off by default. The laptop's main process enforces it (`lib/remote/manager.js`, then `admitToolCall()` in `main.js`) and never trusts home to. Turning it off ends commands in progress. On Windows, a backgrounded child of a laptop command (`x &`) can outlive the switch going off, because the process tree can't always be found.
- **Staying reachable.** While a chat is shared, or Remote Control is on and a laptop is paired with this PC as its home, closing the window hides it to the tray on every platform (`RemoteRules.closeHidesWindow`). With no laptop paired, closing quits as it always has. If an action reaches home with no window to do it, `main.js` refuses it at once rather than leaving the laptop to time out.
- **The PIN.** A laptop sets a PIN of at least 6 digits when it first pairs, and it seals the Remote Control keys. It's asked at start and after 15 minutes idle. Ten wrong in a row delete the keys. A PIN-locked laptop still runs home's commands if its switch is on.
- **Folders per device.** `c.projectFolders` and `c.pathAllowlists` are keyed by device id, beside the home PC's `projectFolder` and `pathAllowlist`. A device's folder is the default only while that device is available for tools. On a laptop, folders guide the model but aren't a security boundary: the switch and the chat's mode are.
- **The device argument.** Tools that touch a machine gain `device`, whose enum always starts with `"home"`, once a laptop is available or the chat has a folder away from home. The system prompt names each device, its OS, and its shell. A laptop's MCP tools are renamed so they can't collide with home's. Web tools and the model stay at home. Tool cards name the device that ran each call.

An installed build can't be debugged: `build/afterPack.js` turns off the RunAsNode, NODE_OPTIONS, and inspect fuses, and `main.js` exits at once if started with a remote-debugging, inspect, or js-flags switch. Debug with `npm start`.

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

- Assistant messages render flat (no bubble); user messages use a solid bubble (`--bubble`).
- Composer caps at 5 lines (~130px), then scrolls internally.
- Markdown renderer handles both asterisk and underscore bold/italic. Underscore patterns use word-boundary lookarounds so `snake_case` survives.
- Debug logs: `%APPDATA%/sanctum/chat-debug.log` (chat streams), `pull-debug.log` (model pulls).
- Aesthetics: contemporary and sleek. No retro/instrument-panel/scan-line treatments.
- Visual identity: a quiet room with one lamp on. Spruce surfaces, warm text, amber for what's live. No gradients, glows, or sparkle icons, except the sidebar logo, which keeps its original violet-to-cyan S at the owner's request. The taskbar and installer use Electron's default icon, also at the owner's request, so don't add an app icon unless asked. One lamp dot marks a working model.
- Fonts ship in `assets/fonts/`. Nothing is loaded from a CDN.
