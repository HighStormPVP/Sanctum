# Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired laptop mirror and drive chats running on a home PC, and let the home model use tools on that laptop.

**Architecture:** Three layers. A Cloudflare Worker handles finding devices and carries relay traffic, but only ever sees ciphertext. A main-process layer (`lib/remote/`) holds keys, runs end-to-end encryption, and moves frames over WebRTC or the relay with no loss during a switch. A renderer layer diffs chat state into mirror frames, applies them on the laptop, routes laptop actions into the home chat loop, and routes tool calls to the named device.

**Tech Stack:** Electron 33 (Node 20, CommonJS), `ws`, `@noble/curves` 1.x, `@noble/ciphers` 1.x, `@noble/hashes` 1.x, Cloudflare Workers with Durable Objects (WebSocket Hibernation API), Miniflare for local tests, `node:test`, `playwright-core` for two-instance tests.

**Spec:** `docs/superpowers/specs/2026-11-04-remote-control-design.md`. Read it first. This plan decides how; the spec decides what.

## Global Constraints

- The relay can never read a chat, code, or command. It never stores or logs message contents.
- Pairing code: 6 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, not case-sensitive, works once, expires after 10 minutes. Five wrong attempts cancel it. Only one code can be pending at a time across the owner's devices, and a new one replaces the old.
- PIN: at least 6 digits. Asked at app start and after 15 minutes idle. Ten wrong in a row delete that device's Remote Control keys.
- Laptop switch: "Let my home PC control this laptop". Off by default. Changeable only on the laptop. Turning it off ends commands in progress.
- Remote Control stays hidden and makes no network connection until the service address is set. The address is never in the repo or a public build.
- Keys and cryptography live in the main process. The chat renderer never holds keys.
- Rules go in `lib/`, free of Electron, with tests. Renderer-loaded rules use the same dual-load pattern as `lib/agent-rules.js`.
- Plain language in the interface: "Remote Control", "Direct", "Through relay". Not "peer", "WebRTC", or "TURN".
- Every dependency used in the main process must load with `require` under Electron 33's Node 20. The noble 2.x packages are ESM-only, so pin the latest 1.x.
- Tests never load a real model and never call a paid API. Fake Ollama and stubbed cloud endpoints only.
- Windows and macOS, in either role.

## Review Focus

1. A laptop sleeps or changes network mid-reply: when it wakes, the chat catches up to match the home PC, with no duplicated or missing text. Pinned in Tasks 4 and 9.
2. Sanctum restarts on the home PC during a reply: the laptop shows the home PC offline, then reconnects and shows the true state, with no Stop button stuck on. Pinned in Task 9.
3. Two devices act at once, such as a send from one laptop and Stop from another: order of arrival at the home PC decides, and all devices end up showing the same thing. Pinned in Task 10.
4. A chat is deleted or unshared while a laptop has it open or is typing in it: it leaves the laptop's view at once, the typed text isn't lost, and a late action gets a clear refusal. Pinned in Task 10.
5. A tool call is in flight when the laptop disconnects or its switch is turned off: the model gets a clear error rather than hanging. Pinned in Task 12.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/remote/crypto.js` | Keys, signatures, AEAD, HKDF wrappers over noble |
| `lib/remote/pake.js` | Pairing key agreement, behind one small interface |
| `lib/remote/pairing.js` | Pairing code rules and the pairing message exchange |
| `lib/remote/session.js` | Authenticated session keys and frame encryption |
| `lib/remote/link.js` | Ordered delivery across two paths, with retransmit |
| `lib/remote/keystore.js` | Identity and peers on disk, PIN rules |
| `lib/remote/manager.js` | Device connections, status, routing, control switch |
| `lib/remote/relay-client.js` | WebSocket to the Worker, with reconnect |
| `lib/remote/direct-path.js` + `remote-transport.html` | Hidden window that runs WebRTC on encrypted bytes |
| `lib/chat-mirror.js` | Pure diff and apply for chat state (dual-load) |
| `lib/remote-rules.js` | Device naming, tool routing, action allowlist (dual-load) |
| `relay/` | Worker source and its tests |
| `e2e/` | Two-instance tests, outside `test/` so `npm test` stays fast |
| `main.js`, `preload.js`, `renderer.js`, `index.html`, `style.css` | Wiring and UI |

---

### Task 0: Baseline

**Files:** none new.

- [ ] **Step 1:** Confirm with the owner that the current uncommitted work (bug fixes, redesign, cloud models) gets committed first. This plan builds on it.
- [ ] **Step 2:** Run `npm test`. Expected: 41 pass, 0 fail.
- [ ] **Step 3:** Commit the baseline, then `git checkout -b remote-control`. All later commits go on this branch.

---

### Task 1: Crypto wrappers and pairing key agreement

**Files:**
- Modify: `package.json` (add, at these exact versions: `@noble/curves` 1.9.7, `@noble/ciphers` 1.3.0, `@noble/hashes` 1.8.0, `ws` 8.22.1)
- Create: `lib/remote/crypto.js`, `lib/remote/pake.js`
- Test: `test/remote-crypto.test.js`

**Interfaces:**
- Produces, from `crypto.js`, all values `Uint8Array`:
  - `newIdentity() -> { publicKey, secretKey }` (Ed25519)
  - `sign(secretKey, msg) -> sig`, `verify(publicKey, msg, sig) -> bool`
  - `newEphemeral() -> { publicKey, secretKey }` (X25519), `sharedSecret(secretKey, peerPublic)`
  - `hkdf(ikm, salt, info, length)`
  - `seal(key, nonce, plaintext, aad)`, `open(key, nonce, ciphertext, aad)` (XChaCha20-Poly1305; `open` throws on tampering)
  - `deviceIdFromPublicKey(publicKey) -> string` (16 lowercase base32 characters of SHA-256)
- Produces, from `pake.js`: `pakeStart(code, role) -> { message, finish(peerMessage) -> { sharedKey, confirmMessage, verifyConfirm(peerConfirm) -> bool } }`, where `role` is `'home'` (SPAKE2's A) or `'laptop'` (SPAKE2's B). `finish` throws on an invalid peer message.
- Also exports `spake2ForTest({ w, x, role, idA, idB, aad })` so tests can inject the values the RFC's vectors fix. It isn't used in production paths.

**Owner decision (4 November 2026):** `pake.js` implements RFC 9382's `SPAKE2-P256-SHA256-HKDF-HMAC` on `@noble/curves` P-256. `cpace-ts` was rejected: it can't load through `require` under Electron 33, and its map-to-curve step is a closed WASM blob. This is the only cryptography we write ourselves, so follow the RFC exactly and invent nothing:

- `M` and `N` are the RFC's P-256 constants, copied exactly.
- `w` comes from `scrypt(code, salt = 'sanctum-pairing-v1', N = 2^15, r = 8, p = 1, 64 bytes)` using Node's `crypto`, then reduced modulo the group order as the RFC says, and must not be 0.
- `x` and `y` are uniform random nonzero scalars from the curve library's random scalar function.
- `idA` is `'sanctum-home'`, `idB` is `'sanctum-laptop'`, and `AAD` is `'sanctum-pairing-v1'`.
- Reject a peer point that doesn't decode to a valid curve point, or that is the identity after the mask is removed. Compare confirmation MACs in constant time.

- [ ] **Step 1: Write failing tests.**
  - `require` loads all three noble packages and `ws` in CJS.
  - Sign and verify round-trips, and a flipped bit fails. `seal`/`open` round-trips, and a flipped bit or wrong AAD throws. `hkdf` matches an RFC 5869 vector.
  - **Every `SPAKE2-P256-SHA256-HKDF-HMAC` test vector in RFC 9382 Appendix B passes** through `spake2ForTest`: `pA`, `pB`, the transcript, the keys, and both confirmation MACs. Fetch the vectors from the RFC and paste them into the test.
  - `M` and `N` in the code equal the RFC's values.
  - The same code on both roles gives an equal `sharedKey`, and each side's `verifyConfirm` accepts the other's `confirmMessage`.
  - Different codes give unequal keys, and `verifyConfirm` returns false on both sides.
  - Tampered messages: the identity point, an off-curve point, and wrong-length bytes all throw from `finish`. A flipped confirmation byte returns false.
  - Neither `message` contains the code or an unsalted hash of it. Two `pakeStart` calls with one code give different messages.
- [ ] **Step 2: Run** `node --test test/remote-crypto.test.js`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run tests.** Expected: PASS. Also run the `require` check under Electron 33's own Node by running its binary directly with `ELECTRON_RUN_AS_NODE=1` set for that one command, on a small script that loads `lib/remote/crypto.js` and `lib/remote/pake.js` and completes one exchange. Expected: prints the matching result with no error.
- [ ] **Step 5: Commit.**

---

### Task 2: Pairing protocol

**Files:**
- Create: `lib/remote/pairing.js`
- Test: `test/remote-pairing.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `CODE_ALPHABET`, `newCode() -> string`, `normalizeCode(input) -> string | null`
  - `createPairingHost({ code, identity, name }) -> { handle(msg) -> { reply?, peer?, failed? }, attemptsLeft }`
  - `createPairingGuest({ code, identity, name }) -> { first, handle(msg) -> { reply?, peer?, failed? } }`
  - `peer` is `{ deviceId, publicKey, name }`

Flow, in order. Messages are JSON-safe objects with base64 fields, opaque to the Worker:

1. The guest sends its `pake` message. The host starts a new `pakeStart` for each attempt, because `finish` is single-use, then replies with its own `pake` message and `confirmMessage`.
2. The guest calls `finish`, checks `verifyConfirm`, then sends its `confirmMessage`. The host checks it. A failed confirmation at this point is a failed attempt. `sharedKey` is not used for anything until `verifyConfirm` returns true.
3. Both derive `sealKey = hkdf(sharedKey, undefined, 'sanctum-pairing-seal-v1', 32)`, since `sharedKey` is 16 bytes and `seal` needs 32.
4. Each side sends `seal(sealKey, randomNonce24, { publicKey, name, signature })`, with the role as AAD. The signature is over `'sanctum-pairing-identity-v1' || role || SHA-256(len(homePake) || homePake || len(laptopPake) || laptopPake)`, using 8-byte little-endian lengths as in RFC 9382. Each side verifies the other's, so a device proves it holds the identity key it claims, for this exchange.

Five failed attempts cancel the code. `pakeStart` blocks for about 90 ms, which is acceptable here because attempts are capped.

- [ ] **Step 1: Write failing tests.**
  - `newCode` is 6 characters, all from `CODE_ALPHABET`. `CODE_ALPHABET` has none of `0 O 1 I L`.
  - `normalizeCode('k7m2qx') === 'K7M2QX'`. It returns null for wrong length or characters outside the alphabet.
  - Run against each other in memory, host and guest each end with the other's `peer`.
  - A wrong code gives `failed` with no `peer`, and `attemptsLeft` drops. After the fifth failure, the correct code also fails.
  - A tampered message gives `failed`.
  - Across a full exchange, no message contains the code, a name, or a key as plaintext (search the bytes).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `lib/remote/pairing.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 3: Cloudflare Worker

**Files:**
- Create: `relay/package.json`, `relay/wrangler.toml`, `relay/src/index.js`, `relay/src/mailbox.js`, `relay/src/pairing-slot.js`, `relay/test/relay.test.js`
- Modify: `package.json` (`"test:relay": "node --test relay/test/"`, and devDependency `miniflare`)

**Interfaces:**
- Produces, over WebSocket, with `<secret>` being the `ACCESS_SECRET` Worker secret:
  - `GET /<secret>/device/<deviceId>`: connects a device. The Worker sends `{ t:'challenge', nonce }`, and the device replies `{ t:'auth', publicKey, sig }`. The device id must equal the id derived from `publicKey`.
  - Then `{ t:'send', to, data }` delivers `{ t:'recv', from, data }` to that device if it's connected. Otherwise the sender gets `{ t:'offline', to }`.
  - `GET /<secret>/pair/host` and `GET /<secret>/pair/guest`: a single pending slot. A new host replaces the old one and closes it. Messages pass through as `{ t:'pair', data }`. The slot expires after 10 minutes.
- Use the Hibernation API (`state.acceptWebSocket`). Use no `setInterval`, since timers prevent hibernation. Use a Durable Object alarm for slot expiry.

- [ ] **Step 1: Write failing tests** against Miniflare:
  - A wrong secret gets 404 and no upgrade.
  - A bad signature, or a device id that doesn't match the key, closes the socket.
  - A message reaches a connected device with the right `from`. A disconnected target gives `offline`, and nothing is held for later.
  - A second connection from the same device replaces the first.
  - A new pairing host closes the old one. A guest connecting to an empty slot gets `{ t:'pair-none' }`. Slot traffic stops after 10 minutes (advance time).
  - More than 120 messages/s from one device gets `{ t:'slow-down' }`, and excess is dropped. A frame over 1 MiB is refused.
  - Durable Object storage holds no `data` values after a run (list keys and values).
- [ ] **Step 2: Run** `npm run test:relay`. Expected: FAIL.
- [ ] **Step 3: Implement.** Verify Ed25519 with WebCrypto in the Worker. Bind one `Mailbox` per device and one `PairingSlot`. No `console.log` of frames.
- [ ] **Step 4: Run.** Expected: PASS. Do not deploy yet. That's Task 15.
- [ ] **Step 5: Commit.**

---

### Task 4: Ordered delivery across two paths

**Files:**
- Create: `lib/remote/link.js`
- Test: `test/remote-link.test.js`

**Interfaces:**
- Produces: `createLink({ sendRelay(bytes), sendDirect(bytes) | null, onFrame(bytes), onPathChange(path) })` returning `{ send(bytes), receiveFromRelay(bytes), receiveFromDirect(bytes), directUp(), directDown(), reset(), path }`.
- `path` is `'direct'`, `'relay'`, or `'offline'`.

Every frame has a sequence number. Unacknowledged frames stay in a buffer capped at 64 MiB, then the link asks for a resync. On any path change, unacknowledged frames are resent on the new path. The receiver drops duplicates and holds out-of-order frames.

- [ ] **Step 1: Write failing tests**, with fake paths:
  - Starts on relay. `directUp()` moves traffic to direct, and `onPathChange('direct')` fires.
  - `directDown()` mid-stream with 1,000 frames in flight delivers all 1,000 exactly once and in order.
  - Delivering every frame twice, or reversed in blocks, still gives each once, in order.
  - Direct and relay both active during a switch gives no duplicates.
  - **Review Focus 1:** both paths down for a while, then relay back: everything unacknowledged arrives once. Exceeding the buffer cap fires `onResyncNeeded` instead of growing.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `lib/remote/link.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 5: Encrypted sessions

**Files:**
- Create: `lib/remote/session.js`
- Test: `test/remote-session.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: `createSession({ identity, peerPublicKey, role })` returning `{ hello, handleHello(msg) -> { reply?, ready }, encrypt(plaintext) -> bytes, decrypt(bytes) -> plaintext }`.

Handshake: X25519 ephemerals, each signed with the long-term key over the whole transcript. Directional keys come from HKDF. Each connection gets fresh keys. Nonce is a per-direction counter. `decrypt` runs above `link.js`, so a resent frame is the same ciphertext and the same counter.

- [ ] **Step 1: Write failing tests.**
  - Handshake completes and frames round-trip in both directions.
  - A different long-term key is refused. A replayed `hello` from an earlier session is refused.
  - A flipped bit in a frame throws. A frame with a repeated counter is refused.
  - Compromising long-term keys after the fact doesn't decrypt recorded frames: re-derive with only the long-term keys and assert failure.
  - Plaintext containing a known string doesn't appear in the ciphertext bytes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `lib/remote/session.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Request an independent security review** of Tasks 1, 2, and 5 before continuing: the transcript binding, nonce handling, and PAKE use. Fix findings.
- [ ] **Step 6: Commit.**

---

### Task 6: Keys on disk and the PIN

**Files:**
- Create: `lib/remote/keystore.js`
- Test: `test/remote-keystore.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: `createKeystore({ file, protect(bytes) -> bytes, unprotect(bytes) -> bytes, now })` returning:
  - `hasPin()`, `setPin(pin) -> { ok, error? }`, `unlock(pin) -> { ok, waitMs?, wiped? }`, `lock()`, `isUnlocked()`
  - `getIdentity()`, `listPeers()`, `addPeer(peer)`, `removePeer(deviceId)`
  - `getControlAllowed()`, `setControlAllowed(bool)`

`protect` and `unprotect` are Electron's `safeStorage` in production, identity functions in tests. The identity and peers are encrypted with a key derived from the PIN by scrypt (Node `crypto`), then the file goes through `protect`.

- [ ] **Step 1: Write failing tests.**
  - `setPin('12345')` is refused. `setPin('123456')` works. Letters are refused.
  - The file contains no identity bytes, and reading it without the PIN yields nothing.
  - A wrong PIN doesn't unlock, and each attempt gets a growing `waitMs`, enforced across a restart (new keystore on the same file).
  - Ten wrong in a row gives `wiped: true`, and `listPeers()` is empty even after the correct PIN.
  - A correct PIN resets the counter.
  - `getControlAllowed()` is `false` on a new install. It's stored outside the PIN-encrypted part, so a PIN-locked laptop can still honour it.
  - A corrupt file gives an unpaired state instead of throwing, and keeps the old file as a copy.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `lib/remote/keystore.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 7: Connection manager and the renderer's API

**Files:**
- Create: `lib/remote/manager.js`, `lib/remote/relay-client.js`
- Modify: `main.js`, `preload.js`
- Test: `test/remote-manager.test.js`

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces `window.api.remote`:
  - `status() -> { enabled, locked, hasPin, controlAllowed, devices: [{ id, name, role, path, connected }] }`
  - `setAddress(url)`, `setPin(pin)`, `unlock(pin)`, `lock()`
  - `createCode() -> { code, expiresAt }`, `cancelCode()`, `pair(code, name) -> { ok, error?, device? }`
  - `removeDevice(id)`, `setControlAllowed(bool)` (refused unless called from this machine's local UI; no frame can reach it)
  - `send(deviceId, frame)`, `onFrame(cb(deviceId, frame))`, `onStatus(cb(status))`
- `role` is `'home'` (they serve chats to me) or `'laptop'` (I serve chats to them). One install can hold both.
- `frame` is any JSON-serializable object. Frames over 256 KiB are split and rejoined inside the manager.

The manager takes its clients by injection, so tests can use fakes. In `main.js` it's created in `whenReady`, using `safeStorage`, with the address saved in `userData`.

- [ ] **Step 1: Write failing tests** with a fake relay client:
  - No address: `status().enabled` is false, and no client is created.
  - While locked (no keys available), no connection starts. `unlock` starts them.
  - A pairing on both ends lists each device with the right `role`.
  - Removing a device closes it, tells the other end, and frames to or from it are dropped. The other end removes it too when told. A removed device can't reconnect (signature check against `listPeers`).
  - A frame from an unknown device is dropped.
  - A 2 MiB frame arrives whole through splitting.
  - Reconnect uses backoff, capped at 30 seconds.
  - Frames from a `laptop`-role device are only ever delivered to the renderer, and `setControlAllowed` has no frame route (assert there's no such handler).
  - Pairing, home side: the manager discards a pending code itself after 10 minutes, even if the relay never says so, because the relay is untrusted. `attemptsLeft === 0` followed by 15 seconds with no completed pairing counts as cancelled, since a guest with a wrong code goes silent and no `failed` arrives. A new `createCode` replaces the old one.
  - Pairing, laptop side: `pair` gives up after 30 seconds with a clear error, since a host failure sends nothing back.
  - Pairing can finish on one side only: if the home side has a verified `peer` but the last message was lost, the laptop reports failure. The home side's new device shows as offline, and removing it or pairing again must work.
  - A peer's `name` is untrusted: empty becomes "Unnamed device", and it's trimmed to 64 characters before it's stored.
  - Pairing, laptop side: a code that has already failed on this device is refused without contacting anyone, with "That code didn't work. Get a new one." This limits guesses by a fake home PC, which the home side's five-attempt limit can't see. Keep the failed codes only in memory, as salted hashes, and clear them after 10 minutes.
  - A home-side pairing entry stays provisional until the first session with that device completes. A provisional entry that never connects is dropped after 10 minutes, and pairing again with the same key doesn't create a duplicate.
  - Heartbeat: an encrypted heartbeat frame every 15 seconds. No frame decrypted for 45 seconds ends the connection and reconnects with a new session. Forged link headers can otherwise stall a connection silently.
  - Any `decrypt` throw ends the connection and reconnects with a new session.
  - A send refused by the link because it's full ends the connection and starts a new session, so the session's counter and the link can't drift apart.
  - A receive-side `onResyncNeeded` is advisory: it never triggers a snapshot, and doesn't reset anything.
  - `handleHello` only ever receives messages whose type is `session-hello` or `session-auth`. A connection whose handshake hasn't finished after 20 seconds starts again with a new session.
  - Each device's `status()` entry includes `fingerprint`: the first 8 characters of its `deviceId`, grouped as `abcd-efgh`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `relay-client.js` uses `ws` and does the challenge from Task 3. Add IPC handlers and preload methods. Keep `preload.js` free of Node requires beyond `electron`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.**

---

### Task 8: Direct connections

**Files:**
- Create: `lib/remote/direct-path.js`, `remote-transport.html`, `remote-transport-preload.js`
- Modify: `lib/remote/manager.js`, `main.js`, `package.json` (add both new files to `build.files`)
- Test: `e2e/direct.e2e.js`

**Decision (the spec leaves this to the builder):** use a hidden `BrowserWindow` for WebRTC instead of a native module, which would add per-platform builds. The window has `contextIsolation` on and `sandbox` on, and it only ever sees ciphertext. STUN server: `stun:stun.cloudflare.com:3478`. No TURN.

**Interfaces:**
- Produces: `createDirectPath({ onSignal(deviceId, data), onOpen(deviceId), onClose(deviceId), onData(deviceId, bytes) })` returning `{ connect(deviceId, initiator), signal(deviceId, data), send(deviceId, bytes), close(deviceId) }`.
- Signaling goes through the encrypted session as frames of type `rtc`, so the relay can't read it either. The home-role side initiates.
- Data channels are ordered and reliable. Messages over 64 KiB are split. Link-level sequencing still applies.

- [ ] **Step 1: Write failing tests** (two Electron instances, local Worker through Miniflare, loopback networking):
  - Paired devices move to `path: 'direct'`, shown by `status()`.
  - Closing the data channel moves to `'relay'`, then back to `'direct'` after retry, which backs off to at most 60 seconds.
  - With the STUN and ICE path blocked (`iceServers: []` with host candidates filtered), `path` stays `'relay'` and frames still flow.
  - Streaming 10,000 frames across a forced switch: every frame arrives once and in order.
  - The hidden window's frame log, inspected in a test build, contains only ciphertext (search for a known plaintext).
- [ ] **Step 2: Run** `node e2e/direct.e2e.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Confirm that closing the main window also closes the hidden one, and that the hidden window doesn't appear in the taskbar.
- [ ] **Step 5: Commit.**

---

### Task 9: Mirroring chats

**Files:**
- Create: `lib/chat-mirror.js`
- Modify: `index.html` (script tag), `renderer.js`
- Test: `test/chat-mirror.test.js`, `e2e/mirror.e2e.js`

**Interfaces:**
- Produces (dual-load, as `ChatMirror` in the renderer):
  - `snapshotChat(chat) -> chatSnapshot`, with `_attachmentData`, `_videoAtt`, and anything path-private removed. Keeps `thinking`, `thinkingMode`, `startup`, `silentSince`, `toolEvents`, `tokenStats`, `videoState`, `queued`.
  - `diffChat(previousSnapshot, chatSnapshot) -> ops[]`
  - `applyOps(chat, ops)`, which mutates existing message objects in place, so `el.__msg` identity holds
- `ops` types: `meta`, `msg-add`, `msg-update`, `msg-append { index, baseLength, text }`, `msg-remove`.
- Frames: `mirror-snapshot { seq, chats, home }`, `mirror-ops { seq, chatId, ops }`, `mirror-remove { seq, chatId }`, `mirror-run { seq, chatId, running }`, `mirror-resync-request`.
- `home` carries `{ name, os, shell, installedModels, cloudReady, hardware }`, so the laptop's model picker reflects the home PC.

**Approach (the spec leaves this to the builder):** diff rather than instrument. The renderer has about 70 places that mutate chat state, and missing one would make the views drift, which is an anti-goal. So: `markMirrorDirty(chatId)` runs from `saveToStorage`, `patchLastMessage`, `patchLastMessageContent`, `renderActiveChat`, and `renderChatList`, plus a 100 ms timer while any shared chat is running. Each tick diffs the shared chats against the last sent snapshot. Streamed text becomes `msg-append`.

On the laptop, remote chats are stored in `state.chats` as `remote:<deviceId>:<chatId>` with `remote: { deviceId, chatId }`, and `saveToStorage` skips them, so nothing reaches disk.

- [ ] **Step 1: Write failing unit tests.**
  - `snapshotChat` drops `_attachmentData` and `_videoAtt`, and contains no API key, even when a chat object carries one.
  - Appending text gives one `msg-append`, not a `msg-update`.
  - For scripted sequences (add, stream, tool event, thinking row, title change, queue, remove), applying the ops to a copy of the start gives a deep-equal result to the end, and object identity of unchanged messages is preserved.
  - A `msg-append` with the wrong `baseLength` returns `{ resync: true }`.
- [ ] **Step 2: Write failing e2e tests** (two instances, fake Ollama, local Worker):
  - **Exact mirror:** a scripted chat with streaming, thinking, tool cards, a queue, and Stop. `#thread` `innerHTML` matches on both ends after normalizing the two machines' local timestamps.
  - A chat without Remote Control on never appears, and no frame contains its title (inspect frames at the session layer).
  - Turning sharing off removes the chat from the laptop within 1 second.
  - **Review Focus 1:** closing the laptop's connection mid-reply and reopening it ends with matching threads.
  - **Review Focus 2:** restarting the home instance mid-reply: the laptop shows offline, the Stop button clears, and after reconnect the thread matches the home PC.
  - Nothing from a remote chat is in the laptop's `localStorage` or `userData` (search for a marker string).
- [ ] **Step 3: Implement** `lib/chat-mirror.js` and the renderer wiring. Add `startedAt` to `msg.startup` so the running timer shows correctly on both ends.
- [ ] **Step 4: Run** `npm test` and `node e2e/mirror.e2e.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 10: Acting from the laptop

**Files:**
- Create: `lib/remote-rules.js`
- Modify: `index.html`, `renderer.js`
- Test: `test/remote-rules.test.js`, `e2e/actions.e2e.js`

**Interfaces:**
- Produces (dual-load, as `RemoteRules`): `isAllowedAction(frame) -> bool`.
- Frames, laptop to home: `action { id, chatId, kind, args }`, where `kind` is one of `send`, `stop`, `set-model`, `set-mode`, `set-toggle`, `rename`, `delete`, `new-chat`, `list-dir`, `set-folder`. Replies: `action-result { id, ok, error? }`.
- `submitToChat(c, text, attachments) -> Promise`: extracted from `dispatchSend`, everything after reading the composer. Local sends and laptop sends both call it.
- Attachment limits: 25 MiB per message, sent in frames. `kind: 'video'` is refused on the laptop with the message "Videos can't be sent from this device yet. Attach it on the home PC."

Home handlers work on the `c` from the frame, never `currentChat()`, and only on chats with `remoteControl: true`, except `new-chat`, which creates one with it on. On the laptop, `dispatchSend`, `stopChat`, the model picker, the mode bar, and toggles check `c.remote` and send an `action` instead. `state.runningChats` on the laptop is driven by `mirror-run`, so Send and Stop look the same.

- [ ] **Step 1: Write failing tests.**
  - Unit: `isAllowedAction` accepts each kind listed and refuses others, such as `read-api-keys`, or any frame with a `__proto__` key.
  - e2e: a message typed on the laptop reaches the fake Ollama with the right history, and streams back to both ends. The home PC's visible chat doesn't change while this happens.
  - e2e: Stop from the laptop aborts the fake stream. Changing the model or mode from the laptop shows on the home PC. A new chat from the laptop appears on both, with Remote Control on.
  - e2e: an action on a chat that isn't shared gets `ok: false`, and the chat doesn't change.
  - e2e **Review Focus 3:** two laptops send at once: both messages land in one order, and all three threads match. Send and Stop arriving together resolve by order of arrival, and all three end up matching.
  - e2e **Review Focus 4:** unsharing while the laptop has text in the box removes the chat from the sidebar, shows "This chat is no longer shared", and leaves the typed text recoverable on the screen. A late `send` gets `ok: false` with a clear message.
  - e2e: the laptop's model picker shows the home PC's models, not its own.
  - e2e: a 30 MiB attachment is refused. A video is refused with the exact message.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `node e2e/actions.e2e.js`, and `node e2e/mirror.e2e.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 11: The interface

**Files:**
- Modify: `index.html`, `renderer.js`, `style.css`
- Test: `e2e/ui.e2e.js`

**Interfaces:**
- Consumes: Tasks 7 and 10.
- Produces: `c.remoteControl` (bool) on home chats, persisted.

Exact UI, from the spec and reviewed mockups:

- **Message box menu:** a **Remote Control** item with a switch, beside Web search and Thinking. Hidden until the address is set and, on a chat with `c.remote`, always hidden.
- **Shared chat marker:** a small marker in the chat header and a dot in the chat list, using `--accent-1`.
- **First share with no paired device:** dialog titled "Connect a device" showing the code large, with "Enter this code on your laptop. It works once and expires in 10 minutes."
- **Settings > Devices:** service address field, paired devices with **Direct**, **Through relay**, or **Offline**, each with its fingerprint and "This device's fingerprint: abcd-efgh" shown for comparison, Remove, **Add a device** (shows a code), **Connect to a home PC** (takes a code), and on any device with a `home` peer, the switch **Let my home PC control this laptop**, off by default.
- **Laptop sidebar:** shared chats grouped under each home PC's name, above local chats.
- **Offline state:** the chat stays visible, with "Home PC is offline. Reconnecting…" and the message box disabled.
- **PIN screen:** set at first pairing, asked at start and after 15 minutes idle. Idle hides remote chats and blocks sending, and leaves the connection up.
- **Laptop indicator:** a persistent "Connected to <home>" in the sidebar. While the model is running something here, a stronger "<home> is running a command on this laptop" with a **Turn off** action, which sets the control switch off.

Use the existing design tokens. No gradients or glows. Follow the frontend-design skill.

- [ ] **Step 1: Write failing tests.**
  - Without an address, no Remote Control UI exists anywhere, and no network connection is attempted (fake server records nothing).
  - The full pairing flow through the UI on two instances, with a lowercase code accepted.
  - A wrong code shows "That code didn't work. Check it and try again." A cancelled code (five wrong) shows "That code was cancelled. Get a new one."
  - Toggling the switch sets the marker and the dot on the home PC.
  - The PIN screen appears at start. With fake time, it appears after 15 minutes idle, and the chat is hidden from the DOM while locked. While idle-locked, the connection stays up.
  - The control switch is off by default, and a frame can't turn it on.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests, and take screenshots** of each screen in all three themes. Review them yourself, and fix anything off.
- [ ] **Step 5: Commit.**

---

### Task 12: Tools on the laptop

**Files:**
- Modify: `lib/remote-rules.js`, `renderer.js`, `lib/remote/manager.js`
- Test: `test/remote-rules.test.js`, `e2e/tools.e2e.js`

**Interfaces:**
- Produces, in `RemoteRules`:
  - `availableDevices({ homeName, peers }) -> [{ id, name, os, shell }]`: this home PC plus each connected `laptop` peer that reports its switch on. Names are made unique here.
  - `resolveDevice(requested, chat, devices) -> { deviceId } | { error }`: the named device, else the chat's folder device, else the home PC. An unknown name is an error, with no fallback to home. This is the "wrong machine" anti-goal.
  - `addDeviceArgument(toolDef, deviceNames) -> toolDef`
  - `mcpToolName(deviceSlug, tool) -> string`: for example `mcp__laptop_macbook__blender__look`.
- `LOCAL_ONLY_TOOLS` (never routed): `web_search`, `web_fetch`, `calc`, `exit_plan_mode`.
- Frames: `tool-call { id, name, args, chatTitle }`, `tool-result { id, result, summary, ok }`, `tool-cancel { id }`, `control-state { allowed, mcpTools, os, shell }`.
- Chat fields: `c.projectFolders` (`{ [deviceId]: path }`), `c.pathAllowlists` (`{ [deviceId]: string[] }`). The existing `projectFolder` and `pathAllowlist` remain for the home PC, so old chats keep working.

Flow: `executeToolImpl` applies all existing gates at home first, then resolves the device. A remote call sends `tool-call` and awaits `tool-result`. On the laptop, the manager in the main process checks `getControlAllowed()` before the renderer sees the frame, and refuses otherwise. The laptop's renderer runs it through existing `window.api.*` calls, and writes to its own audit log (`remote-audit.log`, with chat title, tool, args, result summary). The home system prompt lists each device, its OS, and its shell.

- [ ] **Step 1: Write failing tests.**
  - Unit: `resolveDevice` with a named device, a folder device, and neither. An unknown name errors. A laptop with its switch off isn't in `availableDevices`.
  - Unit: local-only tools get no `device` argument.
  - e2e: `run_command` with `device` set runs on the laptop instance (it writes a file in the laptop's temp folder, and the home temp folder doesn't get it). The tool card names the device.
  - e2e: `read_file`, `write_file`, `apply_patch`, `glob`, `grep`, `run_command_async`, `task_status`, `task_kill`, and a stubbed MCP tool all run on the laptop.
  - e2e: with the switch off, a forged `tool-call` frame is refused in the main process, nothing runs, and the audit log records the refusal.
  - e2e: No-Fetch still blocks `web_fetch`, which stays at home.
  - e2e: Plan Mode and Read-Only block a remote write at home, with no frame sent. No-Approval runs on the laptop with no prompt. Approval Mode prompts (Task 13).
  - e2e: Stop during a remote `run_command` kills the process on the laptop.
  - e2e **Review Focus 5:** disconnecting the laptop mid-call gives the model "<device> is offline" within 5 seconds. Turning the switch off mid-call ends the process and returns a clear error. A background task keeps running through a disconnect, and `task_status` reports it after reconnect.
  - e2e: a chat with its folder on the laptop defaults tools there, and going outside that folder opens the access pop-up, naming the laptop.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` and `node e2e/tools.e2e.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 13: Approvals and pop-ups on every device

**Files:**
- Modify: `renderer.js`
- Test: `e2e/approvals.e2e.js`

**Interfaces:**
- Frames: `ask { id, kind, chatId, tool, args, device }`, `answer { id, value }`, `ask-closed { id, value }`.
- `kind` is `approval`, `plan`, or `path`.

`requestApproval`, `requestPlanApproval`, and `requestPathExpansion` stay as the entry points, on the home PC, for a shared chat. They also send `ask` to connected laptops and resolve on the first answer from anywhere. The laptop shows the same modal through `queueModal`, with the machine named. The other devices close theirs on `ask-closed`.

- [ ] **Step 1: Write failing tests.**
  - The pop-up appears on both, showing the same command and the target machine.
  - Answering on the laptop closes it on the home PC, and vice versa. The tool runs once.
  - Two answers racing resolve to whichever reaches the home PC first, and the other is ignored.
  - A laptop that connects while a pop-up is open gets it as well.
  - With all laptops offline, the home PC can still answer. With the home PC idle and the laptop answering, it works with no one at the home PC.
  - A chat that isn't shared never sends `ask`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node e2e/approvals.e2e.js` and `node e2e/tools.e2e.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 14: Folders and keeping the home PC available

**Files:**
- Modify: `main.js`, `preload.js`, `renderer.js`, `index.html`
- Test: `e2e/folders.e2e.js`, `test/remote-rules.test.js`

**Interfaces:**
- Produces `window.api.app`: `setKeepAwake(bool)`, `setStartAtLogin(bool)`, `getAvailabilitySettings() -> { keepAwake, startAtLogin }`.
- Tray: when any chat is shared, closing the window hides it to the tray instead of quitting. The tray icon comes from `app.getFileIcon(process.execPath)`, since Sanctum sets no custom icon (owner's choice). Tray menu: Open Sanctum, Quit.

Laptop folder picker: the system dialog for laptop folders. A simple browser for home folders, using the `list-dir` action, which lists directories only.

- [ ] **Step 1: Write failing tests.**
  - The window close event hides rather than quits when a chat is shared, and quits normally when none is. Tray Quit always quits and runs the existing cleanup.
  - `keepAwake` starts `powerSaveBlocker` only while on and a chat is shared. It stops when the last chat is unshared.
  - Both settings are off by default. Pairing suggests them once, and "not now" sticks.
  - From the laptop, the home folder browser lists a temp tree, and selecting a folder sets `c.projectFolders[home]`. It returns directories only.
  - The Run button on a code block on the laptop runs on the laptop, and the output panel names the machine.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node e2e/folders.e2e.js`. Expected: PASS.
- [ ] **Step 5: Commit.**

---

### Task 15: Deploy and try it for real

**Files:**
- Modify: `CLAUDE.md`, `.gitignore` (add `relay/.wrangler`, `.dev.vars`)
- Create: `relay/README.md`, `test/no-relay-address.test.js`

- [ ] **Step 1: Write a failing test,** `test/no-relay-address.test.js`: no tracked file, and nothing in `build.files`, contains a `workers.dev` URL or an `ACCESS_SECRET` value. Run it, then fix what it finds.
- [ ] **Step 2: Add a full traffic check** to `e2e/mirror.e2e.js`: record every frame the Worker sees during a scripted chat with a marker string, a tool call, and pairing with a known code. Assert none of those appear in any frame.
- [ ] **Step 3: Update `CLAUDE.md`:** the new `lib/remote/` files, how to run `npm run test:relay` and the e2e tests, and the rule that tool execution uses `c`, never `currentChat()`.
- [ ] **Step 4: Ask the owner to log in and approve the deploy.** This is an outside action on their paid account. Then, in `relay/`: `npx wrangler secret put ACCESS_SECRET` with a freshly generated 32-byte random value, and `npx wrangler deploy`.
- [ ] **Step 5: Check the live service** with a throwaway pair of device keys: a wrong secret gets 404, and a frame goes through.
- [ ] **Step 6: Give the owner the address and this checklist** for real machines. Report each result honestly. Nothing here can be automated:
  - Pair a Windows home PC and a Mac laptop, then the reverse.
  - Use it from a phone hotspot, confirming the Devices screen state.
  - Use it from a network that blocks direct connections, confirming **Through relay**.
  - Close the laptop lid mid-reply, reopen it, and confirm the threads match.
  - Run a command on the laptop from a shared chat, with the switch on and off.
  - Remove a device from each end.
- [ ] **Step 7: Run everything:** `npm test`, `npm run test:relay`, and every file in `e2e/`. Expected: all pass. Then commit.
