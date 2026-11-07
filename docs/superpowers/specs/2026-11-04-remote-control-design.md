# Remote Control design

Date: 4 November 2026. Status: approved by the owner on 4 November 2026.

Labels used below:

- **Owner:** decided by the owner.
- **Call:** decided by the author. The owner can overrule it, and these are listed again at the end.
- **Builder:** left to whoever builds this.

## Why this exists

The owner runs Sanctum and its models on a powerful PC at home, and wants to use it from a laptop while out. The laptop should feel like sitting at the home PC, and the home model should be able to work on the laptop as well.

Success looks like this: from a café, the owner opens Sanctum on the laptop and sees a shared chat exactly as it looks at home. They send a message, and the home model answers live. It can run a command on the laptop or edit a file there, and the owner watches it happen. They never type a code again after the first pairing.

## Goals

1. **Per-chat sharing (Owner).** Pick a chat and turn on Remote Control. The switch lives in the message box menu, next to Web search and Thinking.
2. **One-time pairing (Owner).** Connect with a 6-character code of letters and numbers. It stays connected from then on.
3. **Exact mirror (Owner).** Everything visible in the chat on the home PC appears the same way on the laptop, live. That includes streaming text, thinking rows, tool cards, and token counts.
4. **Two-way use (Owner).** Messages typed on the laptop go to the home PC, and the home model answers them.
5. **Full reach (Owner).** The home model can do on the laptop whatever it can do on the home PC.
6. **Nothing to set up on the network (Owner).** No router changes and no Tailscale. Devices connect directly whenever the network allows, with an encrypted relay as the backup. Cloudflare provides the setup and the relay, on the owner's paid account.
7. **For the owner only (Owner).** Public installs of Sanctum don't use the owner's Cloudflare account.
8. **Several devices (Owner).** Several home PCs and several laptops can all be paired. A laptop can connect to more than one home PC, and a home PC can have more than one laptop.
9. **A PIN on the laptop (Owner).** Sanctum asks for a PIN before Remote Control opens on a laptop.

## Non-goals

- Running a model on the laptop for these chats. The model always runs at home.
- Phone or browser clients. Both ends are the Sanctum desktop app.
- Sharing with other people. A pairing connects one person's own devices.
- Accounts, sign-up, or multi-user support on the relay. It serves one owner.
- Per-device sharing. A shared chat is visible to every laptop paired with that home PC.
- Syncing chats that don't have Remote Control on.

## Anti-goals

These would make it a failure even if it technically worked:

- Cloudflare, or anyone running the relay, can read a chat or run a command.
- A laptop sees a chat that doesn't have Remote Control on.
- A stolen or guessed pairing code gives lasting access.
- Someone using a stolen laptop reaches the home PC without knowing the PIN.
- A public install can use the owner's Cloudflare account, or the repo reveals its address.
- The laptop can be controlled without its owner having turned that on, on the laptop itself.
- The laptop view drifts from the home view, so what's on screen isn't what the model is doing.
- A command silently runs on the wrong machine.

## What it looks like

Mockups were reviewed with the owner.

**Home PC**

- The message box menu gets a **Remote Control** switch for the open chat.
- A shared chat shows a small marker in its header and a dot in the chat list (Call).
- The first time it's turned on, with no device paired, a dialog shows the code, for example `K7M2QX`. **Add a device** in Settings shows a new code at any time.
- Settings gets a **Devices** section: paired devices, their connection state, Remove, and Add a device.

**Laptop**

- A **Connect to a home PC** screen takes the code.
- Shared chats appear in the sidebar, grouped under each home PC's name, above any local chats (Call).
- A PIN screen appears before those chats open (see PIN).
- They use the same message rendering as local chats.
- A persistent indicator shows when the home PC is connected, and a stronger one while the model is running something on this laptop (Call).
- If the home PC is unreachable, the chat stays visible with a clear offline state and the message box is disabled (Call).

## Connection

**Direct first, with a relay as backup (Owner).** Devices connect peer-to-peer over WebRTC whenever the network allows. Some networks block that, so traffic falls back to an encrypted relay rather than failing.

How it works:

- Both apps keep an outbound WebSocket to a Cloudflare Worker. It's used to find each other, to exchange what WebRTC needs to set up a connection, and as the backup path.
- As soon as a device connects, it can work over that WebSocket, and it tries for a WebRTC data channel in the background. If that succeeds, traffic moves to it and the WebSocket goes back to being idle. If the direct path drops, traffic moves back to the relay and the direct attempt starts again (Call).
- The chat must not notice a switch. Messages carry sequence numbers across both paths, so nothing is lost or repeated when traffic moves mid-stream.
- The same end-to-end encryption runs above both paths, so the rest of the app doesn't know or care which is in use, and the relay can't read anything either way.
- The backup is the Worker itself rather than a separate TURN service, which keeps it to one thing to run and pay for (Call).
- Devices learn their public address from a STUN server. This shows the server, and the two devices, each other's IP address. Which STUN server to use is Builder.
- Settings > Devices shows whether each connection is **Direct** or **Through relay** (Call).

**The Cloudflare service**

- A Cloudflare Worker with one Durable Object per device acting as its mailbox, using the WebSocket Hibernation API so idle connections cost almost nothing. Each message is addressed to a paired device, so several home PCs and laptops work from the start (Call). The exact layout is Builder, as long as it doesn't assume one-to-one. Source lives in `relay/` in this repo.
- It stores only what routing needs: device public keys, and pending pairing records until they expire. It never stores or logs message contents.
- Deploying needs the owner's Cloudflare login, and the owner approves the deploy.

**Keeping it to the owner (Call)**

- The service address contains a long random secret. It's never in the repo or a public build.
- Remote Control stays hidden and does nothing until that address is set. On each device, it's pasted once into Settings, or it can be supplied at build time for the owner's own builds.
- This does add one paste per device on top of the code, because public installers can't carry the address and a 6-character code is too short to carry it.
- The relay refuses anything without the secret, and applies simple rate limits.
- Cost, from Cloudflare's published pricing: the paid plan includes 1 million Durable Object requests a month, and incoming WebSocket messages count at 20:1. Billable duration doesn't accrue during hibernation. At 25 tokens/s, an hour of streaming is 90,000 messages unbatched, or 4,500 billable requests. Batching chunks keeps this far lower, so normal use should stay inside the included amount, and direct connections use it far less.

**Pairing**

- The code is 6 characters from an unambiguous alphabet (no `0/O`, `1/I/L`), not case-sensitive, works once, and expires after 10 minutes (Call).
- Five wrong attempts cancel the code (Call).
- Only one code can be pending at a time across the owner's devices, and a new one replaces the old. With one owner, this is how the laptop finds the right home PC using only the code, without the relay learning it (Call).
- Pairing uses a password-authenticated key exchange (PAKE). The relay can pass the messages but can't learn the code or impersonate either device, and can't test guesses offline. This is why a short code is safe. Without PAKE, the code would be too short.
- After pairing, each device holds its own long-term keys, kept with Electron's `safeStorage`. No code is needed again.

**Encryption**

- End-to-end between the two devices, with fresh session keys on each connection, so a key stolen later can't decrypt recorded traffic.
- Use vetted libraries for all cryptographic primitives, and invent no cryptography. The one piece written here is the pairing exchange: the owner chose RFC 9382 SPAKE2 on `@noble/curves` P-256, checked against the RFC's test vectors and by independent review, after the available library proved unsuitable.

**PIN (Owner, details are Call)**

- A device sets a PIN of at least 6 digits the first time it pairs with a home PC.
- The PIN protects the device's Remote Control keys, so the connection can't start after a restart until it's entered, and the keys can't be taken from a copy of the disk without it.
- Sanctum asks for it when the app starts, and after 15 minutes idle on Remote Control chats. While idle-locked, chats are hidden and nothing can be sent, but the connection stays up.
- Repeated wrong PINs add growing delays. Ten in a row delete this device's Remote Control keys, which then needs a new pairing from a code.
- A forgotten PIN also means pairing again. No chat data is lost, because chats live at home.
- The PIN only guards using Remote Control from that device. While the screen is PIN-locked, the home model can still run commands on this laptop if its control switch is on, since that isn't someone at the laptop asking.

**Staying connected**

- Both apps reconnect on their own with backoff whenever they're running and online. A laptop needs its PIN once after each restart before it can reconnect.
- A device stays paired until it's removed from either end. Removal takes effect immediately.

**Keeping the home PC available (Call)**

- Sanctum has to be running at home. While a chat is shared, or Remote Control is on and a laptop is paired with this PC as its home, closing the window keeps Sanctum running in the system tray instead of quitting.
- Settings offers "Start Sanctum when I log in" and "Keep this PC awake while a chat is shared". Both are off until chosen, and pairing suggests them.

## How the mirror works

**The home PC is the single source of truth.** It holds the chats, API keys, and models, and runs the chat loop. The laptop holds no chat data on disk (Call), only what's on screen and in memory.

**Home to laptop**

- A full snapshot of the shared chats on connect or reconnect.
- After that, ordered events for every change the UI renders: messages added or edited, streamed text, thinking rows, tool events, titles, model and mode changes, running state, and the queue.
- Stream chunks are batched at roughly 50–100 ms (Builder).
- If the laptop misses a sequence number, it asks for a new snapshot.

Each home PC sends its own stream to each connected device. If two laptops are connected at once, both see the same thing live, and any of them can act.

**Laptop to home**

- Actions the home UI could also perform on that chat, conflicts resolved by order of arrival at the home PC: send a message with attachments, Stop, queue, change model, change safety mode, change toggles, answer approvals, rename, and pick a project folder.
- These enter the same code paths as local input, so behaviour can't differ.

**Creating and deleting from the laptop (Call).** The laptop can start a new chat at home, which has Remote Control on from the start, so the owner isn't stuck if nothing is shared. Deleting works too. Local chats on the laptop stay separate and private.

**Attachments** sent from the laptop travel encrypted to the home PC, in chunks. Very large files, such as videos, are refused with a clear message in the first version (Call). The limit is Builder.

**Implementation note.** The renderer mutates chat state directly and patches the DOM in many places. Those mutations need a single event stream so the laptop can't miss one. This is likely the largest single change. `renderMessage` should render remote and local chats alike.

## Commands on the laptop

**Reach (Owner).** Every tool that touches a machine works on the laptop: `read_file`, `list_dir`, `write_file`, `apply_patch`, `glob`, `grep`, `run_command`, `run_command_async`, the `task_*` tools, and MCP tools configured on the laptop.

**Choosing the machine (Call)**

- These tools gain a `device` argument. The system prompt names each device the model can use, its operating system, and its shell, since they can differ.
- The devices a model can use are its own home PC and every laptop paired with it that has its control switch on. Two names can't be the same, because the home PC keeps them unique.
- One Sanctum install can be both: a home PC to some devices and a laptop to others. A home PC never gets control of the device it's paired to in reverse without its own pairing (Call).
- A chat's project folder records which device it's on, and that device is the default. A chat with no folder defaults to the home PC.
- Tool cards show which device ran each call, so it's never ambiguous.
- MCP tools from the laptop are named so they can't collide with the home PC's.
- Web tools and the model itself stay at home.

**Folders (Call)**

- A chat can have one project folder per device. Each device's folder sets the default working directory for tools running there.
- Going outside a device's folder opens the existing access pop-up, on every connected device like an approval, naming the machine. The first answer wins.
- `run_command` stays unrestricted by folder on both machines, as it is at home today. So folders guide the model and catch mistakes, but they aren't a security boundary on the laptop. The laptop's switch and the chat's mode are.
- From the laptop, choosing a laptop folder uses the normal system dialog. Choosing a home folder uses a simple folder browser served by the home PC, because a system dialog would open on the empty desk at home.

**Run button on code blocks (Call).** Run acts on the machine you clicked it on. On the laptop it runs on the laptop and doesn't need the home-control switch, since the person at the laptop is the one asking. The output panel names the machine.

**Execution**

- The home PC sends an encrypted tool request. The laptop runs it through the same main-process handlers and `lib/` rules used locally, and returns the result.
- Stop reaches the laptop and ends what's running there.
- If the laptop is offline, the tool returns a clear error to the model at once rather than hanging. A running background task keeps going on the laptop and reports when it reconnects (Call).

**Safety (Call).** This is the most important call in the document.

- The laptop has its own switch: **Let my home PC control this laptop**. It's asked about at pairing and is off by default. It can only be changed on the laptop, and turning it off takes effect immediately, including ending commands in progress.
- When it's on, the chat's existing mode applies to both machines the same way. Plan, Approval, No-Approval, Read-Only, and No-Fetch behave as they do at home. That matches the owner's "do whatever it can, like the home PC". A No-Approval chat runs commands on the laptop without asking.
- Approval pop-ups appear on every connected device, showing the machine the command will run on. The first answer wins, and the pop-up closes on the other device.
- The laptop keeps its own audit log of everything run on it through Remote Control.
- The laptop checks that each request comes from its paired home PC and enforces its own switch. It doesn't trust the home PC to enforce that switch.

**Risks the owner accepts with this design**

- Anyone who gets into the home PC, or a malicious page that steers the model in a No-Approval chat, can act on the laptop too, as long as the laptop's switch is on. This is the cost of full reach. Approval Mode and the laptop switch are the protections.
- The laptop's Remote Control is only as trustworthy as the home PC.
- Anyone who has a laptop and its PIN has full control of its home PCs, including No-Approval, the API keys, and shared chats. A short PIN is the protection against casual theft, not a determined attacker with unlimited time. If a laptop is lost, remove it from the home PC.

## Constraints

- Electron app with `contextIsolation` on. The renderer reaches the OS only through `window.api`.
- All cryptography and the Cloudflare connection live in the main process. The chat renderer never holds keys. Electron only offers WebRTC in renderer processes, so the data channel needs either a hidden window that only ever sees encrypted bytes, or a native module. That choice is Builder, but note a native module adds per-platform builds.
- Rules that decide what's allowed go in `lib/`, free of Electron, with tests, following the existing pattern.
- Must work across Windows and macOS, in either role, including a Windows home PC with a Mac laptop and the reverse.
- The owner's PC has had one unexplained blue screen, and heavy models can slow it down, so tests shouldn't load real models.
- Plain language in the interface: "Remote Control", not "relay" or "peer".

## Left to the builder

- Crypto and WebSocket library choices, apart from the pairing exchange above.
- Message format, sequence numbering, chunk sizes, and batching.
- Reconnect timing and exact limits.
- How the event stream is introduced into `renderer.js`.
- Tray behaviour details per platform.

## How we'll know it works

Automated, against a local copy of the relay:

- Pairing succeeds with the right code. It fails with a wrong, used, or expired code, and five wrong attempts cancel it.
- A recording of relay traffic and of direct traffic contains no readable chat text, code, or command.
- With direct connections blocked, everything works through the relay.
- With both paths available, traffic moves to direct, and the Devices screen says so.
- Breaking the direct path mid-stream moves traffic to the relay, and restoring it moves traffic back. Nothing is lost, repeated, or out of order, and the threads on both ends still match.
- A chat without Remote Control on never reaches the laptop, and turning it off removes it immediately.
- The rendered thread on both ends matches for a scripted chat with streaming, thinking, tool cards, a queue, and Stop.
- Dropping the connection mid-stream and reconnecting ends with both sides matching.
- Tools run on the chosen device, the laptop's switch blocks them when off, and an offline laptop gives a clear error.
- Each safety mode behaves the same on both machines. Approvals resolve once across devices.
- Removing a device from either end ends access at once.
- With two home PCs and two laptops, each laptop sees the right chats under the right home PC, and a tool call reaches only the device it names.
- Without the service address, Remote Control is hidden and no network connection is attempted. A wrong secret is refused.
- The repo and a public build contain no service address (checked by a test).
- The PIN is required at start and after idle. Wrong attempts delay, then delete the keys. After a restart, no connection starts until the PIN is entered.

By hand, before release: two real machines on different networks, including one on a phone hotspot and one on a network that blocks direct connections, with a real Windows and Mac pairing.

## Calls for the owner to check

1. The backup is the Cloudflare Worker itself, not a separate TURN service, and traffic moves between direct and relay automatically.
2. The laptop's "Let my home PC control this laptop" switch is off by default and lives only on the laptop. Once it's on, the chat's own mode applies, including No-Approval.
3. Approvals appear on every connected device, and the first answer wins.
4. The laptop stores no chat data on disk.
5. The laptop can create and delete shared chats at home.
6. Commands choose a machine with a `device` argument, defaulting to wherever the chat's folder is.
7. While a chat is shared, or Remote Control is on and a laptop is paired with it as its home, closing the window at home keeps Sanctum running in the tray.
8. Very large attachments, such as videos, are refused from the laptop in the first version.
9. Each chat can have one folder per device, and folders aren't a security boundary on the laptop.
10. The Run button on a code block acts on the machine where you click it.
11. The service address is pasted once on each device (or built into your own builds), since public installers can't contain it.
12. PIN rules: at least 6 digits, asked at start and after 15 minutes idle, and ten wrong attempts delete that device's keys.
13. A PIN-locked laptop can still receive commands from home if its control switch is on.
14. Every laptop paired with a home PC sees all of that home PC's shared chats.
