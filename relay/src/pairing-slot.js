// The one pending pairing. At most one host and one guest, joined by the relay and
// nothing else: the PAKE messages in `data` mean nothing here, and nothing is
// stored. A new host replaces everything in the slot, and the slot (host, guest,
// and all) expires PAIR_TTL_MS after its host connected, using a Durable Object
// alarm so the object can still hibernate.
import { DurableObject } from 'cloudflare:workers';
import { acknowledgeClose, closeQuietly, createRateLimiter, isOversize, millisecondsFrom } from './mailbox.js';

const DEFAULT_PAIR_TTL_MS = 10 * 60 * 1000;

const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

const OTHER_SIDE = { host: 'guest', guest: 'host' };

export class PairingSlot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = { host: createRateLimiter(), guest: createRateLimiter() };
  }

  // Sockets that are closed from our side stay listed until the close finishes, so
  // they're marked first and skipped here.
  #live(role) {
    return this.ctx.getWebSockets(role).filter((ws) => !ws.deserializeAttachment()?.closed);
  }

  #retire(ws, code, reason) {
    ws.serializeAttachment({ role: ws.deserializeAttachment()?.role, closed: true });
    closeQuietly(ws, code, reason);
  }

  async fetch(request) {
    const role = new URL(request.url).pathname.split('/').pop();
    const [client, server] = Object.values(new WebSocketPair());
    server.serializeAttachment({ role, closed: false });
    const hostPresent = this.#live('host').length > 0;

    if (role === 'host') {
      for (const ws of [...this.#live('host'), ...this.#live('guest')]) this.#retire(ws, 1000, 'replaced');
      this.ctx.acceptWebSocket(server, ['host']);
      await this.ctx.storage.setAlarm(Date.now() + millisecondsFrom(this.env.PAIR_TTL_MS, DEFAULT_PAIR_TTL_MS));
    } else if (!hostPresent) {
      this.ctx.acceptWebSocket(server, ['guest']);
      server.send(JSON.stringify({ t: 'pair-none' }));
      this.#retire(server, 1000, 'no pairing in progress');
    } else {
      for (const ws of this.#live('guest')) this.#retire(ws, 1000, 'replaced');
      this.ctx.acceptWebSocket(server, ['guest']);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    for (const ws of [...this.#live('host'), ...this.#live('guest')]) this.#retire(ws, 1000, 'expired');
  }

  async webSocketMessage(ws, message) {
    if (isOversize(message)) return this.#retire(ws, CLOSE_TOO_BIG, 'frame too large');
    const att = ws.deserializeAttachment();
    if (!att || att.closed) return;
    const verdict = this.rate[att.role]();
    if (verdict === 'warn') ws.send(JSON.stringify({ t: 'slow-down' }));
    if (verdict !== 'ok') return;
    if (typeof message !== 'string') return this.#retire(ws, CLOSE_UNSUPPORTED, 'text only');

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.#retire(ws, CLOSE_POLICY, 'bad frame');
    }
    if (msg === null || typeof msg !== 'object') return this.#retire(ws, CLOSE_POLICY, 'bad frame');
    if (msg.t !== 'pair' || !('data' in msg)) return;

    const out = JSON.stringify({ t: 'pair', data: msg.data });
    for (const peer of this.#live(OTHER_SIDE[att.role])) {
      try {
        peer.send(out);
      } catch {
        // The peer is on its way out.
      }
    }
  }

  // A host that leaves takes the slot with it. A host that was replaced or expired
  // is already marked, so its late close event can't touch the new slot.
  async webSocketClose(ws, code, reason) {
    acknowledgeClose(ws, code, reason);
    const att = ws.deserializeAttachment();
    if (att?.role === 'host' && !att.closed) {
      for (const guest of this.#live('guest')) this.#retire(guest, 1000, 'host left');
    }
  }
}
