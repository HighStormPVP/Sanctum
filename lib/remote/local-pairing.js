// Pairing on the same network, for a laptop that has the code and nothing else. No
// Electron here, so test/remote-local-pairing.test.js can run it under plain Node.
//
// While a code is showing, home listens with two sockets:
//
//   UDP on DISCOVERY_PORT   answers {"sanctum":"pair-probe","v":1} with
//                           {"sanctum":"pair-here","v":1,"port":<tcp port>}
//   TCP on a port the OS picks, carrying the same pairing messages as the relay's pairing
//                           slot, one JSON object per line
//
// The laptop broadcasts the probe, and also sends it to each address on a small private
// network directly, since many routers and mesh systems drop broadcasts. It collects replies
// for a few seconds, says what got in the way if nobody answered, and tries each home it
// found in turn, over connectLocalPairing, which has the relay client's connectPairing
// interface so the manager runs one pairing exchange for both. The manager decides what's
// sent: the code is never in any of it, and the service address only ever crosses inside
// the sealed identity, once both ends have proved the code.
//
// Everything that arrives here is hostile. Only private, link-local and loopback IPv4
// addresses get an answer or a connection, every datagram and line has to be exactly its
// shape and under its size, and home takes few connections, slowly, for a short time.
//
// Anyone on the network can connect without the code, so a connection gets one attempt: a
// well-formed pake within PAKE_WITHIN_MS, then a confirm, and nothing more. One that hasn't
// sent its pake yet is the first to go when a new connection needs its place, so connecting
// and saying nothing can't hold home's two places.
//
// A socket bound outside loopback makes Windows ask the person at the machine about its
// firewall, so `loopback: true` keeps every socket here on 127.0.0.1, and under the test
// runner nothing else is allowed at all.
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');

const DISCOVERY_PORT = 47613;
const LOOPBACK = '127.0.0.1';
const LOOPBACK_HOSTS = new Set([LOOPBACK, '::1']);
const ALL_INTERFACES = '0.0.0.0';
const LIMITED_BROADCAST = '255.255.255.255';

const PROBE_TEXT = '{"sanctum":"pair-probe","v":1}';
const MAX_DATAGRAM_BYTES = 1024;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const PROBES = 3;
const PROBE_GAP_MS = 1000;
const DISCOVERY_MS = 4000;
// Asking each host directly: only on networks of /22 or smaller, at most this many in all,
// and this many sends to a turn of the event loop, so a round doesn't flood the kernel.
const MAX_UNICAST_HOST_BITS = 1023;
const MAX_UNICAST_TARGETS = 1024;
const SEND_BATCH = 64;
// Between batches. A /22 round is 16 batches, about 130 ms, well inside the second between rounds.
const SEND_GAP_MS = 8;
// Enough that replies forged by others on the network can't crowd out the real home.
const MAX_HOMES = 16;
// A probe costs home one small reply. These keep a flood of them from making it a reflector,
// and one sender from using up what the real laptop needs.
const MAX_REPLIES_PER_SECOND = 10;
const MAX_REPLIES_PER_SOURCE_PER_SECOND = 2;

const MAX_LINE_BYTES = 64 * 1024;
const MAX_LINES = 8;
const IDLE_MS = 30000;
// Home closes a connection that hasn't sent a well-formed pake in this long.
const PAKE_WITHIN_MS = 5000;
const MAX_CONNECTIONS = 2;
const NEW_CONNECTION_GAP_MS = 1000;
// A closing channel sends what it has, and this is how long the other end gets to take it.
const FLUSH_MS = 5000;

const NEWLINE = 0x0a;

const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

// ---- Addresses ----

// Four decimal octets in their one spelling, or null.
function ipv4Octets(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

// The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d, in any spelling), or null.
function mappedOctets(text) {
  if (typeof text !== 'string' || !net.isIPv6(text)) return null;
  let spelled = text.toLowerCase();
  const lastColon = spelled.lastIndexOf(':');
  const tail = spelled.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = ipv4Octets(tail);
    if (!octets) return null;
    const hex = (a, b) => ((a << 8) | b).toString(16);
    spelled = `${spelled.slice(0, lastColon + 1)}${hex(octets[0], octets[1])}:${hex(octets[2], octets[3])}`;
  }
  let groups;
  if (spelled.includes('::')) {
    const [left, right] = spelled.split('::');
    const head = left ? left.split(':') : [];
    const rest = right ? right.split(':') : [];
    groups = [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest];
  } else {
    groups = spelled.split(':');
  }
  if (groups.length !== 8) return null;
  const values = groups.map((group) => parseInt(group, 16));
  if (values.some((value) => !Number.isInteger(value))) return null;
  if (values.slice(0, 5).some((value) => value !== 0) || values[5] !== 0xffff) return null;
  return [values[6] >> 8, values[6] & 0xff, values[7] >> 8, values[7] & 0xff];
}

function inPrivateRange([a, b]) {
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a === 127;
}

// 10/8, 172.16/12, 192.168/16, 169.254/16 and 127/8, as IPv4 or IPv4-mapped IPv6. Not the
// carriers' shared 100.64/10, which is many networks, and no other IPv6.
function isPrivateAddress(address) {
  const octets = ipv4Octets(address) ?? mappedOctets(address);
  return Boolean(octets) && inPrivateRange(octets);
}

// The address in IPv4 spelling, if it's one this file talks to.
function privateIpv4(address) {
  const octets = ipv4Octets(address) ?? mappedOctets(address);
  return octets && inPrivateRange(octets) ? octets.join('.') : null;
}

const toInt = (octets) => ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
const fromInt = (value) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');

const isIpv4Entry = (entry) => entry?.family === 'IPv4' || entry?.family === 4;

function interfaceEntries(interfaces) {
  const entries = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const entry of Array.isArray(list) ? list : []) if (entry && typeof entry === 'object') entries.push(entry);
  }
  return entries;
}

// The private IPv4 networks this machine is on, as { address, hostBits }, with the address
// as a number. Not loopback's own interface, and not a /32 or /31, which has no broadcast
// address and nobody else on it.
function privateNetworks(interfaces) {
  const networks = [];
  for (const entry of interfaceEntries(interfaces)) {
    if (!isIpv4Entry(entry) || entry.internal) continue;
    const address = ipv4Octets(entry.address);
    const mask = ipv4Octets(entry.netmask);
    if (!address || !mask || !inPrivateRange(address)) continue;
    const hostBits = ~toInt(mask) >>> 0;
    if (hostBits <= 1) continue;
    networks.push({ address: toInt(address), hostBits });
  }
  return networks;
}

// Where a probe goes: everywhere on the local network, and the directed broadcast of each
// private interface, which reaches networks where the limited one doesn't leave the machine.
function broadcastAddresses(interfaces) {
  const targets = [LIMITED_BROADCAST];
  for (const { address, hostBits } of privateNetworks(interfaces)) {
    const broadcast = fromInt((address | hostBits) >>> 0);
    if (!targets.includes(broadcast)) targets.push(broadcast);
  }
  return targets;
}

// Many routers, mesh systems and wired-to-Wi-Fi bridges drop broadcasts, but pass a datagram
// sent to one address. So besides the broadcasts, a search asks each other host on a network
// of /22 or smaller directly: never the network or broadcast address, never this machine, and
// at most MAX_UNICAST_TARGETS in all. `networks` is the first three octets of each network's
// own address, for saying where the search looked.
function probeTargets(interfaces) {
  const networks = privateNetworks(interfaces);
  const own = new Set();
  for (const entry of interfaceEntries(interfaces)) {
    const octets = isIpv4Entry(entry) ? ipv4Octets(entry.address) : null;
    if (octets) own.add(toInt(octets));
  }
  const unicast = [];
  const seen = new Set();
  // Smallest first, so a wide VPN or virtual adapter listed before the Wi-Fi can't use up the cap.
  const bySize = networks.slice().sort((a, b) => a.hostBits - b.hostBits);
  for (const { address, hostBits } of bySize) {
    // A mask with holes in it isn't a network to walk.
    if (hostBits > MAX_UNICAST_HOST_BITS || (hostBits & (hostBits + 1)) !== 0) continue;
    const network = (address & ~hostBits) >>> 0;
    const broadcast = (network | hostBits) >>> 0;
    for (let host = network + 1; host < broadcast && unicast.length < MAX_UNICAST_TARGETS; host++) {
      if (own.has(host) || seen.has(host)) continue;
      seen.add(host);
      unicast.push(fromInt(host));
    }
  }
  const prefixes = [];
  for (const { address } of networks) {
    const prefix = fromInt(address).split('.').slice(0, 3).join('.');
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return { broadcasts: broadcastAddresses(interfaces), unicast, networks: prefixes };
}

// A system error's code, such as EHOSTUNREACH, and never anything else an error carries.
function errorCode(err) {
  const code = err?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'UNKNOWN';
}

// ---- Datagrams ----

const validPort = (port) => Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;

function exactObject(bytes, keys) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DATAGRAM_BYTES) return null;
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]) ? value : null;
}

function probeBytes() {
  return Buffer.from(PROBE_TEXT, 'utf8');
}

function isProbe(bytes) {
  const value = exactObject(bytes, ['sanctum', 'v']);
  return value !== null && value.sanctum === 'pair-probe' && value.v === 1;
}

// No name: nothing needs it, and anyone on the network would see it.
function replyBytes({ port }) {
  return Buffer.from(JSON.stringify({ sanctum: 'pair-here', v: 1, port }), 'utf8');
}

// A home that answered, as { address, port }, or null. The address is where the reply came
// from, never anything it says about itself.
function parseReply(bytes, from) {
  const address = privateIpv4(from);
  if (!address) return null;
  const value = exactObject(bytes, ['port', 'sanctum', 'v']);
  if (!value || value.sanctum !== 'pair-here' || value.v !== 1 || !validPort(value.port)) return null;
  return { address, port: value.port };
}

// What home takes on a connection: a pake of exactly this shape, then a confirm, and no more.
// The pairing checks what's inside them.
function homeTakes(msg, index) {
  if (index === 0) {
    const keys = Object.keys(msg).sort();
    return keys.length === 2 && keys[0] === 'pake' && keys[1] === 't' && msg.t === 'pake' && typeof msg.pake === 'string';
  }
  return index === 1 && msg.t === 'confirm';
}

function createHomeList() {
  const homes = [];
  return {
    add(home) {
      if (homes.length >= MAX_HOMES || homes.some((h) => h.address === home.address)) return;
      homes.push(home);
    },
    list: () => homes.map((home) => ({ ...home }))
  };
}

// ---- The pairing channel: one JSON object per line ----

// `onClose` is for an end the owner didn't ask for, as with the relay client, and `onGone`
// for any end at all. `from` names who sent what onWire is shown, for the traffic tests.
// `takes` decides whether a line may come at that place, and `firstWithinMs` how long the
// first one may take. Breaking either closes the connection.
function createLineChannel(socket, { clock, side, onMessage, onClose, onGone = () => {}, onWire = null, takes = null, firstWithinMs = null }) {
  const other = side === 'home' ? 'laptop' : 'home';
  let finished = false;
  let pending = Buffer.alloc(0);
  let lines = 0;
  let idleTimer = null;
  let firstTimer = null;
  let started = false;

  function armIdle() {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      end();
    }, IDLE_MS);
  }

  function stopTimer() {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    if (firstTimer !== null) clock.clearTimeout(firstTimer);
    idleTimer = null;
    firstTimer = null;
  }

  function settle() {
    finished = true;
    stopTimer();
    pending = Buffer.alloc(0);
    onGone();
  }

  // Not asked for by the owner, so it's reported.
  function end() {
    if (finished) return;
    settle();
    socket.destroy();
    onClose();
  }

  function receive(chunk) {
    if (finished) return;
    onWire?.({ from: other, bytes: Buffer.from(chunk) });
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    for (;;) {
      const index = pending.indexOf(NEWLINE);
      if (index === -1) break;
      const line = pending.subarray(0, index);
      pending = pending.subarray(index + 1);
      if (line.length + 1 > MAX_LINE_BYTES) return end();
      lines += 1;
      if (lines > MAX_LINES) return end();
      let msg;
      try {
        msg = JSON.parse(line.toString('utf8'));
      } catch {
        return end();
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return end();
      if (takes && !takes(msg, lines - 1)) return end();
      if (!started) {
        started = true;
        if (firstTimer !== null) clock.clearTimeout(firstTimer);
        firstTimer = null;
      }
      armIdle();
      onMessage(msg);
      if (finished) return;
    }
    if (pending.length >= MAX_LINE_BYTES) end();
  }

  socket.on('data', receive);
  socket.on('error', end);
  socket.on('close', end);
  armIdle();
  if (firstWithinMs !== null) {
    firstTimer = clock.setTimeout(() => {
      firstTimer = null;
      end();
    }, firstWithinMs);
  }

  return {
    get finished() {
      return finished;
    },
    // Whether a first line has come.
    get started() {
      return started;
    },
    send(value) {
      if (finished) return false;
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      if (bytes.length > MAX_LINE_BYTES) return false;
      onWire?.({ from: side, bytes });
      socket.write(bytes);
      return true;
    },
    // Asked for, so no onClose. With flush, what was sent goes first.
    close({ flush = false } = {}) {
      if (finished) return;
      settle();
      if (!flush) return socket.destroy();
      socket.end();
      const timer = setTimeout(() => socket.destroy(), FLUSH_MS);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
    }
  };
}

function bothTaps(...taps) {
  const present = taps.filter((tap) => typeof tap === 'function');
  if (!present.length) return null;
  return (entry) => {
    for (const tap of present) {
      try {
        tap(entry);
      } catch { /* a tap never changes what's sent */ }
    }
  };
}

// The laptop's end, with the relay client's connectPairing interface. It only connects to
// this network, and a home that never answers is the caller's timer to end.
function connectLocalPairing({ address, port, clock = systemClock, onOpen, onMessage, onClose, onWire = null }) {
  const host = privateIpv4(address);
  if (!host || !validPort(port)) throw new Error('That home PC is not on this network.');
  const socket = net.connect({ host, port });
  socket.setNoDelay(true);
  let opened = false;
  const channel = createLineChannel(socket, {
    clock,
    side: 'laptop',
    onWire,
    onMessage: (msg) => {
      if (opened) onMessage(msg);
    },
    onClose
  });
  socket.once('connect', () => {
    if (channel.finished) return;
    opened = true;
    onOpen();
  });
  return {
    send: (value) => opened && channel.send(value),
    close: (options) => channel.close(options)
  };
}

// ---- Both ends, set up for this run ----

// Run right before every bind. Under the test runner, or with SANCTUM_LOOPBACK_ONLY set as
// e2e/harness.js sets it, only loopback gets through, whatever chose the host, so no test can
// make Windows ask about its firewall. In an installed app the variable can only make it
// refuse, and then pairing goes by the relay alone.
function checkBindHost(host) {
  const loopbackOnly = Boolean(process.env.NODE_TEST_CONTEXT) || Boolean(process.env.SANCTUM_LOOPBACK_ONLY);
  if (loopbackOnly && !LOOPBACK_HOSTS.has(host)) throw new Error('Only loopback may be bound here.');
  return host;
}

// `loopback` has to be said either way. True keeps every socket on 127.0.0.1, for tests and
// for an unpackaged run that a test started. Under the test runner false is refused, unless
// `bindHost` is given, which may only be 127.0.0.1: then everything runs as on a real network,
// interfaces and all, but bound to loopback, and a search sends only to loopback addresses.
// That's how a test reaches the path a real network takes. `createUdpSocket` is for tests too.
function createLocalPairing({ loopback, bindHost = null, discoveryPort = DISCOVERY_PORT, networkInterfaces = os.networkInterfaces, createUdpSocket = (type) => dgram.createSocket({ type }), onWire = null } = {}) {
  if (loopback !== true && loopback !== false) throw new Error('Say whether to keep to loopback.');
  if (bindHost !== null && bindHost !== LOOPBACK) throw new Error('The bind host may only be loopback.');
  if (loopback === false && bindHost === null && process.env.NODE_TEST_CONTEXT) throw new Error('A test may only use loopback.');

  // A new listener binds the same discovery port, so it waits for the last one to be closed.
  let lastClosing = Promise.resolve();

  function bindHostFor(requested) {
    if (!loopback) return bindHost ?? ALL_INTERFACES;
    const host = requested ?? LOOPBACK;
    if (!LOOPBACK_HOSTS.has(host)) throw new Error('Only loopback here.');
    return host;
  }

  // Home's two sockets, while a code is showing. `ready` is the ports once both are bound,
  // or null if they couldn't be, and then pairing goes by the relay alone.
  function listen({ clock = systemClock, host, onMessage, onClose }) {
    const bindHost = bindHostFor(host);
    const before = lastClosing;
    const udp = dgram.createSocket({ type: bindHost.includes(':') ? 'udp6' : 'udp4' });
    const server = net.createServer();
    const channels = new Set();
    let closed = false;
    let closing = null;
    let tcpPort = null;
    let lastAcceptAt = -Infinity;
    const replies = createReplyLimiter();

    udp.on('error', () => listener.close());
    server.on('error', () => listener.close());

    udp.on('message', (msg, rinfo) => {
      if (closed || tcpPort === null) return;
      if (!isPrivateAddress(rinfo.address) || !isProbe(msg)) return;
      if (!replies.mayReply(rinfo.address, clock.now())) return;
      try {
        udp.send(replyBytes({ port: tcpPort }), rinfo.port, rinfo.address, () => {});
      } catch { /* closing */ }
    });

    server.on('connection', (socket) => {
      socket.on('error', () => {});
      const now = clock.now();
      if (closed || !isPrivateAddress(socket.remoteAddress) || now - lastAcceptAt < NEW_CONNECTION_GAP_MS) {
        socket.destroy();
        return;
      }
      if (channels.size >= MAX_CONNECTIONS) {
        // The oldest that hasn't started its attempt makes way. If both have, this one waits.
        const waiting = [...channels].find((channel) => !channel.started);
        if (!waiting) {
          socket.destroy();
          return;
        }
        waiting.close();
      }
      lastAcceptAt = now;
      socket.setNoDelay(true);
      const channel = createLineChannel(socket, {
        clock,
        side: 'home',
        takes: homeTakes,
        firstWithinMs: PAKE_WITHIN_MS,
        onWire,
        onMessage: (msg) => onMessage(channel, msg),
        onClose: () => onClose(channel),
        onGone: () => channels.delete(channel)
      });
      channels.add(channel);
    });

    function bindUdp() {
      return new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind({ address: checkBindHost(bindHost), port: discoveryPort, exclusive: true }, () => {
          udp.off('error', reject);
          resolve();
        });
      });
    }

    function listenTcp() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: checkBindHost(bindHost), port: 0, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    }

    const ready = (async () => {
      try {
        await before;
        if (closed) {
          await Promise.all([closeUdp(), closeServer()]);
          return null;
        }
        await bindUdp();
        if (closed) return null;
        await listenTcp();
        if (closed) return null;
        tcpPort = server.address().port;
        return { udpPort: udp.address().port, tcpPort };
      } catch {
        closed = true;
        await Promise.all([closeUdp(), closeServer()]);
        return null;
      }
    })();

    const closeUdp = () => new Promise((resolve) => {
      try {
        udp.close(() => resolve());
      } catch {
        resolve(); // never bound, or already closed
      }
    });
    const closeServer = () => new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => {});
      // The listening socket is gone at once. Connections still flushing end on their own.
      return resolve();
    });

    const listener = {
      ready,
      boundAddresses() {
        if (tcpPort === null || closed) return [];
        return [udp.address().address, server.address().address];
      },
      // Waits for binding to settle, so nothing is left bound by a close that came early.
      close(options) {
        closed = true;
        for (const channel of [...channels]) channel.close(options);
        if (!closing) {
          closing = ready.then(async () => {
            for (const channel of [...channels]) channel.close(options);
            await Promise.all([closeUdp(), closeServer()]);
          });
          lastClosing = closing;
        }
        return closing;
      }
    };
    return listener;
  }

  // The laptop's search: probes PROBES times, PROBE_GAP_MS apart, and gathers replies for
  // DISCOVERY_MS. `result` is the homes found, at most MAX_HOMES and one per address.
  // `outcome` is { homes, problem, networks }: what went wrong, if anything did, for the
  // manager to explain an empty search, and the networks searched, as their first three
  // octets. A problem is one of
  //   { kind: 'no-network' }               no private network to search
  //   { kind: 'socket', code }             the socket failed, which ends the search
  //   { kind: 'send', code, every }        sends refused, with the first code, and whether
  //                                        not one send got out
  //   { kind: 'broadcast', code }          broadcasts refused, so only direct probes went
  // and is null when every probe went out.
  function discover({ clock = systemClock } = {}) {
    const socket = createUdpSocket('udp4');
    const homes = createHomeList();
    const searchHost = loopback ? LOOPBACK : (bindHost ?? ALL_INTERFACES);
    const plan = loopback ? { broadcasts: [LOOPBACK], unicast: [], networks: [] } : probeTargets(safeInterfaces());
    // Bound to loopback, a search never sends anywhere else.
    const keep = searchHost === LOOPBACK ? (address) => address.startsWith('127.') : () => true;
    let broadcasts = plan.broadcasts.filter(keep);
    const unicast = plan.unicast.filter(keep);
    const timers = [];
    let bound = false;
    let finished = false;
    let socketProblem = null;
    let broadcastProblem = null;
    let firstSendCode = null;
    let sent = 0;
    let refused = 0;
    // The direct probes on their own: macOS may let a broadcast out while it refuses them.
    let unicastSent = 0;
    let unicastRefused = 0;
    let firstUnicastCode = null;
    const pacing = new Set();
    let settleOutcome;
    const outcome = new Promise((resolve) => {
      settleOutcome = resolve;
    });

    function problemNow() {
      if (!loopback && plan.networks.length === 0) return { kind: 'no-network' };
      if (socketProblem) return socketProblem;
      if (refused > 0 && sent === 0) return { kind: 'send', code: firstSendCode, every: true };
      if (unicastRefused > 0 && unicastSent === 0) return { kind: 'send', code: firstUnicastCode, every: true };
      // No broadcasts and no network narrow enough to ask directly: nothing went out at all.
      if (broadcastProblem && unicast.length === 0) return { kind: 'send', code: broadcastProblem.code, every: true };
      if (broadcastProblem) return broadcastProblem;
      if (refused > 0) return { kind: 'send', code: firstSendCode, every: false };
      return null;
    }

    function finish() {
      if (finished) return;
      finished = true;
      for (const timer of timers) clock.clearTimeout(timer);
      for (const timer of pacing) clearTimeout(timer);
      pacing.clear();
      try {
        socket.close();
      } catch { /* never bound */ }
      settleOutcome({ homes: homes.list(), problem: problemNow(), networks: plan.networks.slice() });
    }

    function refusedWith(err, direct) {
      refused += 1;
      if (firstSendCode === null) firstSendCode = errorCode(err);
      if (direct) {
        unicastRefused += 1;
        if (firstUnicastCode === null) firstUnicastCode = errorCode(err);
      }
    }

    function sentOne(direct) {
      sent += 1;
      if (direct) unicastSent += 1;
    }

    // One unreachable address doesn't end the search.
    function sendOne(target, direct) {
      try {
        socket.send(probeBytes(), discoveryPort, target, (err) => {
          if (finished) return;
          if (err) refusedWith(err, direct);
          else sentOne(direct);
        });
      } catch (err) {
        refusedWith(err, direct);
      }
    }

    // A batch, then a short pause, so a /22's sends and their address lookups don't all go
    // out in the same few milliseconds, where a busy Wi-Fi link could drop some unseen. On a
    // real timer: the pause is about the network, not the search's own schedule.
    function sendFrom(targets, start) {
      if (finished) return;
      const end = Math.min(start + SEND_BATCH, targets.length);
      for (let i = start; i < end; i++) sendOne(targets[i].address, targets[i].direct);
      if (end < targets.length) {
        const timer = setTimeout(() => {
          pacing.delete(timer);
          sendFrom(targets, end);
        }, SEND_GAP_MS);
        pacing.add(timer);
      }
    }

    function probe() {
      if (finished || !bound) return;
      sendFrom([
        ...broadcasts.map((address) => ({ address, direct: false })),
        ...unicast.map((address) => ({ address, direct: true }))
      ], 0);
    }

    socket.on('error', (err) => {
      if (!socketProblem) socketProblem = { kind: 'socket', code: errorCode(err) };
      finish();
    });
    socket.on('message', (msg, rinfo) => {
      if (finished) return;
      const home = parseReply(msg, rinfo.address);
      if (home) homes.add(home);
    });
    // Bound before anything is sent, since sending first would bind it to every interface.
    socket.bind({ address: checkBindHost(searchHost), port: 0 }, () => {
      if (finished) return;
      bound = true;
      if (!loopback) {
        try {
          socket.setBroadcast(true);
        } catch (err) {
          // The direct probes don't need it.
          broadcastProblem = { kind: 'broadcast', code: errorCode(err) };
          broadcasts = [];
        }
      }
      probe();
    });
    for (let i = 1; i < PROBES; i++) timers.push(clock.setTimeout(probe, i * PROBE_GAP_MS));
    timers.push(clock.setTimeout(finish, DISCOVERY_MS));

    return { result: outcome.then(({ homes: found }) => found), outcome, cancel: finish };
  }

  function safeInterfaces() {
    try {
      return networkInterfaces();
    } catch {
      return {};
    }
  }

  return {
    loopback,
    listen,
    discover,
    connect: (options) => connectLocalPairing({ ...options, onWire: bothTaps(onWire, options.onWire) })
  };
}

// Each sender gets two answers a second, inside ten a second in all. Senders are counted only
// while the overall allowance has room, and the count starts afresh each second, so a flood of
// forged addresses can't grow what is kept or the time each probe takes.
function createReplyLimiter() {
  let windowStart = -Infinity;
  let inWindow = 0;
  const bySource = new Map(); // address -> answers this second
  return {
    mayReply(address, now) {
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
        bySource.clear();
      }
      if (inWindow >= MAX_REPLIES_PER_SECOND) return false;
      const count = bySource.get(address) || 0;
      if (count >= MAX_REPLIES_PER_SOURCE_PER_SECOND) return false;
      bySource.set(address, count + 1);
      inWindow += 1;
      return true;
    },
    get sourcesKept() {
      return bySource.size;
    }
  };
}

module.exports = {
  createReplyLimiter,
  DISCOVERY_PORT,
  MAX_LINE_BYTES,
  MAX_LINES,
  IDLE_MS,
  PAKE_WITHIN_MS,
  isPrivateAddress,
  checkBindHost,
  broadcastAddresses,
  probeTargets,
  probeBytes,
  isProbe,
  replyBytes,
  parseReply,
  createHomeList,
  createLocalPairing,
  connectLocalPairing
};
