// Sanctum Remote Control relay. One owner, so one secret in the URL and nothing
// else to configure. This file only decides who gets in and where they go; the
// Durable Objects do the rest. The relay never looks inside the `data` it passes.
//
//   /<secret>/device/<deviceId>   one Mailbox per device
//   /<secret>/pair/host|guest     the single PairingSlot
import { Mailbox } from './mailbox.js';
import { PairingSlot } from './pairing-slot.js';

export { Mailbox, PairingSlot };

const DEVICE_ID = /^[a-z2-7]{16}$/;
const PAIR_ROLES = new Set(['host', 'guest']);
const SLOT_NAME = 'slot';

const encoder = new TextEncoder();
const status = (code) => new Response(null, { status: code });

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

// Hashing first gives timingSafeEqual two buffers of the same length, whatever was
// guessed. An unset or empty secret matches nothing, so a missing binding serves
// nothing rather than everything.
async function secretMatches(given, expected) {
  if (typeof expected !== 'string' || expected === '') return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    const [, secret, kind, name, ...extra] = new URL(request.url).pathname.split('/');
    if (!(await secretMatches(secret ?? '', env.ACCESS_SECRET))) return status(404);

    let stub;
    if (extra.length === 0 && kind === 'device' && DEVICE_ID.test(name ?? '')) {
      stub = env.MAILBOX.get(env.MAILBOX.idFromName(name));
    } else if (extra.length === 0 && kind === 'pair' && PAIR_ROLES.has(name)) {
      stub = env.PAIRING_SLOT.get(env.PAIRING_SLOT.idFromName(SLOT_NAME));
    } else {
      return status(404);
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return status(426);
    return stub.fetch(request);
  }
};
