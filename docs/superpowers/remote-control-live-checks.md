# Remote Control live checks

For the owner and Claude to run together after the relay is deployed (Task 15b). Each check says what to do and what a pass looks like. Nothing here can run in the automated tests, because it needs the real Cloudflare edge, real networks, or real machines.

No results yet. Next to each check, write pass, fail, or not run, with the date and anything seen. Never write the address, the secret, or a pairing code here.

Unless a check says otherwise, the home PC and the laptop are both on the deployed relay, paired, and unlocked.

## The live service

These use a throwaway pair of device keys made for the check, not a real device's keys.

- [ ] **A wrong secret is refused.** Open a WebSocket to the Worker with a made-up secret in the path, and to a path with no secret. Pass: both get HTTP 404, and nothing else comes back.
- [ ] **A frame goes through.** Connect both throwaway devices with the real secret, answer each challenge, and send one frame from one to the other. Pass: each gets `ready`, the frame arrives once, unchanged, and a frame to a device that isn't connected gets `offline`.
- [ ] **The edge after a Worker-side close.** Have the Worker close a socket from outside a message handler, for example a second login as the same device, or an unanswered challenge left for 10 seconds. Pass: the client sees the close and the TCP connection ends within a few seconds. Under Miniflare it stayed open, so note how long the real edge takes.
- [ ] **A pairing slot lasts 10 minutes.** Open a host on the pairing slot and leave it alone. Pass: it's still there at 9 minutes and closed by about 10.

## Pairing on real machines

- [ ] **Windows home PC, Mac laptop.** Paste the address on both, choose Add a device at home, and enter the code on the Mac. Pass: both list each other under Settings > Devices with matching fingerprints, and a shared chat appears on the Mac.
- [ ] **Mac home PC, Windows laptop.** The same with the roles swapped. Pass: as above.

## Networks

- [ ] **Phone hotspot.** Put the laptop on a phone's hotspot and the home PC on its usual network. Pass: Settings > Devices shows the home PC connected, and says Direct or Through relay, matching what's really in use. A shared chat works either way.
- [ ] **A network that blocks direct connections.** Use a network that blocks peer-to-peer traffic, such as some office, hotel, or school Wi-Fi. Pass: Settings > Devices says **Through relay**, and chat, streaming, and tools all still work.
- [ ] **Signaling retries where direct is blocked.** On that network, leave both connected and idle for 30 minutes, and count the relay requests in the Cloudflare dashboard. Pass: the count is near the estimate of about 20 messages a minute for the direct attempts, and doesn't grow over time.
- [ ] **Back to direct under load.** Stream a long reply while direct is up, break the direct path (for example, switch the laptop to the blocking network and back), and time how long it takes to show Direct again. Pass: the reply never stops or repeats, the threads match, and it's back on Direct within about a minute of the network allowing it.
- [ ] **A short Wi-Fi gap during a long command.** Run a command on the laptop that takes a minute, and turn the laptop's Wi-Fi off for about 3 seconds partway through. Then do the same with a gap of about 5 seconds. Pass: nothing silently runs twice, and the model is told clearly if the command was ended. Task 12 ruled that a gap over 3.5 seconds ends the command, so note how often a real gap crosses that.

## Staying in step

- [ ] **Laptop lid closed mid-reply.** Start a long reply in a shared chat, close the laptop's lid for a minute, then open it. Pass: after the PIN if asked, the laptop shows the whole reply, the threads on both ends match, and Stop works.
- [ ] **An idle device, then a message.** Leave both connected and idle for an hour, so the relay can sleep, then send a message from the laptop. Pass: it arrives at home straight away and the reply streams back.
- [ ] **The heartbeat's cost.** With both connected through the relay and idle for a day, read the Durable Object requests and duration in the Cloudflare dashboard. Pass: requests are near the estimate in `relay/README.md` (about 23,000 a day for one pair), and note whether the duration shows the relay sleeping between heartbeats or awake all day.
- [ ] **A busy stream through the relay.** Through the relay, stream at more than 60 frames a second for a minute, for example a fast local model with several shared chats. Pass: the laptop keeps up and the threads match. If it falls further behind the longer it runs, that's Task 8's tick-resend backlog.

## Commands on the laptop

- [ ] **The switch on.** Turn on **Let my home PC control this laptop** on the laptop, then have a shared chat run a command there. Pass: it runs on the laptop, the tool card names the laptop, and the laptop's audit log has it.
- [ ] **The switch off.** Turn it off on the laptop and ask again. Pass: the model gets a clear error saying the laptop's switch is off, nothing runs, and the laptop logs the refusal. Turning it off during a long command ends that command.
- [ ] **The process group on a real Mac.** With the Mac as the laptop, start a command that starts children of its own, then Stop it from home. Pass: the command and every child end. This is the POSIX process-group test that only runs on a Mac.

## Removing devices

- [ ] **From the home PC.** Remove the laptop in Settings > Devices at home. Pass: the laptop loses the shared chats at once and can't send or run anything.
- [ ] **From the laptop.** Pair again, then remove the home PC on the laptop. Pass: the same, the other way round.

## macOS

- [ ] **A denied Keychain prompt.** On the Mac, when macOS asks whether Sanctum may use its Keychain item, choose Deny, then start Sanctum again and allow it. Pass: Sanctum says clearly what happened, and the keys aren't treated as damaged and reset. Task 7 couldn't test this.
- [ ] **Case folding of the profile deny.** On the Mac, with the laptop's switch on, ask for a file in Sanctum's own data folder with the path in different case, for example `~/library/application support/sanctum/remote-keys.json`. Pass: it's refused as Sanctum's own data, the same as the exact spelling.

## Windows

- [ ] **Log off and shut down with Sanctum in the tray.** With a chat shared and the window closed to the tray, log off Windows, and on another day shut it down. Pass: Windows doesn't wait on Sanctum, and Sanctum starts normally the next time.

## Optional: Gemini and a laptop's MCP tools

Only with the owner's Gemini key and their go-ahead, since it's a paid call.

- [ ] **A cleaned laptop MCP schema.** Configure an MCP server on the laptop whose tools include an object with empty `properties` and a string parameter with `enum` values, one of them empty. With the switch on, start a shared agent chat at home on a Gemini model. Pass: Gemini accepts the request, the tools are offered, and one call goes through.
