# Sanctum relay

This is the Cloudflare Worker behind Remote Control. It's for the owner's own devices only. Public installs of Sanctum don't know its address and never use it.

## What it does

Each Sanctum keeps one connection open to the relay. Devices use it to find each other, to set up a direct connection, and to carry traffic whenever a direct connection isn't possible. When they do connect directly, the relay goes quiet.

## What it can and can't see

Everything a device sends through the relay is encrypted on that device for the other device, so the relay passes along bytes it can't read.

It can't see:

- chats, messages, replies, or titles
- commands, tool calls, or their results
- files or folder paths
- the pairing code, the PIN, or any API key

Pairing uses a password-authenticated exchange, so the relay can pass the pairing messages but can't learn the code from them, or test guesses at it offline. Like anyone else with the secret, it could try guesses one at a time while a code is waiting, and each wrong one counts towards the limit of five, after which the code is cancelled.

It can see:

- which of your devices are connected, and when
- each device's ID and public key, which is how a device proves who it is
- which device sends to which, how often, and how much
- each device's IP address, as any server would
- the secret, because it's part of the address

It stores nothing about messages. It keeps live connections, and at most one pending pairing, which expires after 10 minutes.

## The address

Sanctum reaches the relay at an address of this form:

```
wss://sanctum-relay.<your-subdomain>.workers.dev/<your-secret>
```

`<your-subdomain>` is your Cloudflare account's workers.dev subdomain, and `<your-secret>` is the value you set as `ACCESS_SECRET` below. The relay refuses anything without the secret.

Never put the real address or secret in this repo, an issue, or a screenshot. `test/no-relay-address.test.js` fails if a tracked file, or anything a build would pack, holds a workers.dev address other than the form above, or anything shaped like a secret.

## Deploying

You need the Cloudflare account on the Workers Paid plan, Node 22 or later, and this repo.

1. Install, from the repo root:

   ```
   npm ci
   npm ci --prefix relay
   cd relay
   ```

2. Sign in to Cloudflare. This opens a browser:

   ```
   npx wrangler login
   ```

   `npx wrangler whoami` shows which account you're signed in to.

3. Make a secret: 32 random bytes, written URL-safe. This prints 43 characters:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   Keep it in your password manager. Don't save it in a file in this folder.

4. Give it to the Worker. Paste the value when asked:

   ```
   npx wrangler secret put ACCESS_SECRET
   ```

   The first time, Wrangler may say there's no Worker called `sanctum-relay` yet and offer to create it. Say yes.

5. Deploy:

   ```
   npm run deploy
   ```

   It ends by printing `https://sanctum-relay.<your-subdomain>.workers.dev`. If the account has no workers.dev subdomain yet, Wrangler asks you to choose one first.

6. Put the address together: `wss://`, the host it printed, `/`, and the secret.

`relay/.wrangler`, `.dev.vars` and `.dev.vars.*`, and `.env` are ignored by git, here and in `relay/`, so local Wrangler files stay out of the repo.

## Giving Sanctum the address

On the home PC, open **Settings > Devices**, open **Service address**, paste the address, and choose **Save**. Sanctum hides it once it's saved. Then choose **Add a device**.

If the laptop is on the same Wi-Fi as the home PC when you pair, that's all: choose **Connect to a home PC** on the laptop and type the code. The laptop finds the home PC on the network, and gets the address inside the encrypted pairing. After that it reaches the home PC from anywhere.

Pairing from another network, the laptop needs the address pasted the same way first. Sanctum has no way to build the address in, so it comes either by pasting or by pairing on the same Wi-Fi.

## Logs: leave them off

**Don't turn on Workers Logs, Logpush, or any other request logging for this Worker.** The secret is in the address path, so a log of requests is a log of the secret. `wrangler tail` shows the same request URLs live, so don't run it either. The relay itself never logs.

Workers Logs are off in the config: `relay/wrangler.toml` has `enabled = false` under `[observability]`, and each deploy sends that setting with the Worker. Turning logging on would mean editing that line, and `test/no-relay-address.test.js` fails if it's changed. Whether a deploy also switches off logs that were turned on in the dashboard is one of the live checks.

If logging is ever turned on by mistake, turn it off and rotate the secret.

## Rotating the secret

Do this if the address may have been seen, or if you'd just like a fresh one.

1. Make a new secret, as in step 3 above.
2. In `relay/`, run `npx wrangler secret put ACCESS_SECRET` and paste it. From then on, the relay only lets in the new secret. A connection that was already open may carry on until it next drops.
3. On every device, paste the new address into **Settings > Devices > Service address**. A device has to be unlocked with its PIN to take a new address.

Pairings don't depend on the secret, so devices stay paired and connect again as soon as they have the new address. Until then, they show each other as offline.

## Removing the Worker

1. In `relay/`, run `npx wrangler delete`, or delete `sanctum-relay` under **Workers & Pages** in the Cloudflare dashboard.
2. On each device, remove your other devices in **Settings > Devices** if you won't be setting up a new relay.

Without the relay, devices can't find each other, so Remote Control shows other devices as offline. Chats stay on the home PC as they are.

## What it costs

This is a rough guide, based on Cloudflare's published Workers Paid pricing at the time of writing. It isn't a promise, so check Cloudflare's pricing page and your usage in the dashboard.

- The plan is 5 US dollars a month. It includes 1 million Durable Object requests a month, and 400,000 GB-seconds of Durable Object time.
- Through the relay, each frame costs about one request: a WebSocket message in counts as one twentieth of a request, and handing it to the other device's mailbox counts as one. Over a direct connection, frames cost nothing.
- Every frame is acknowledged by the other end, which is a frame too.
- Streaming a reply sends about 10 frames a second, so with the acknowledgements, an hour of streaming through the relay is around 70,000 requests.
- Connected devices also send each other a heartbeat every 15 seconds. If that goes through the relay all month, it's roughly 700,000 requests for one home PC and one laptop. It may also keep the relay from sleeping between heartbeats, which uses Durable Object time.
- Beyond what's included, a further million requests is 0.15 US dollars, and a further million GB-seconds is 12.50 US dollars.

So for one person, expect the 5 dollars a month, and on top of that somewhere between nothing and a few dollars. Requests add cents at most. The few dollars would be Durable Object time, if heartbeats keep both devices' mailboxes awake all month. Devices that connect directly use the relay far less. The heartbeat's real cost is one of the checks in `docs/superpowers/remote-control-live-checks.md`.
