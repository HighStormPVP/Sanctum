// Pairing on the same network, for a laptop that has the code and nothing else. No
// Electron here, so test/remote-local-pairing.test.js can run it under plain Node.
//
// While a code is showing, home listens with two sockets:
//
//   UDP on DISCOVERY_PORT   answers {"sanctum":"pair-probe","v":1} with
//                           {"sanctum":"pair-here","v":1,"port":<tcp port>,"name":<name>}
//   TCP on a port the OS picks, carrying the same pairing messages as the relay's pairing
//                           slot, one JSON object per line
//
// The laptop broadcasts the probe, collects replies for a few seconds, and tries each home
// it found in turn, over connectLocalPairing, which has the relay client's connectPairing
// interface so the manager runs one pairing exchange for both. The manager decides what's
// sent: the code is never in any of it, and the service address only ever crosses inside
// the sealed identity, once both ends have proved the code.
//
// Everything that arrives here is hostile. Only private, link-local and loopback IPv4
// addresses get an answer or a connection, every datagram and line has to be exactly its
// shape and under its size, and home takes few connections, slowly, for a short time.
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
const NAME_MAX = 64;

const PROBES = 3;
const PROBE_GAP_MS = 1000;
const DISCOVERY_MS = 4000;
const MAX_HOMES = 4;
// A probe costs home one small reply. This keeps a flood of them from making it a reflector.
const MAX_REPLIES_PER_SECOND = 10;

const MAX_LINE_BYTES = 64 * 1024;
const MAX_LINES = 8;
const IDLE_MS = 30000;
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

// Where a probe goes: everywhere on the local network, and the directed broadcast of each
// private interface, which reaches networks where the limited one doesn't leave the machine.
function broadcastAddresses(interfaces) {
  const targets = [LIMITED_BROADCAST];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!(entry?.family === 'IPv4' || entry?.family === 4) || entry.internal) continue;
      const address = ipv4Octets(entry.address);
      const mask = ipv4Octets(entry.netmask);
      if (!address || !mask || !inPrivateRange(address)) continue;
      const hostBits = ~toInt(mask) >>> 0;
      // A /32 or /31 has no broadcast address.
      if (hostBits <= 1) continue;
      const broadcast = fromInt((toInt(address) | hostBits) >>> 0);
      if (!targets.includes(broadcast)) targets.push(broadcast);
    }
  }
  return targets;
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

function cleanReplyName(name) {
  const text = typeof name === 'string' ? Array.from(name).slice(0, NAME_MAX).join('') : '';
  return text;
}

function replyBytes({ port, name }) {
  return Buffer.from(JSON.stringify({ sanctum: 'pair-here', v: 1, port, name: cleanReplyName(name) }), 'utf8');
}

// A home that answered, as { address, port, name }, or null. The address is where the reply
// came from, never anything it says about itself.
function parseReply(bytes, from) {
  const address = privateIpv4(from);
  if (!address) return null;
  const value = exactObject(bytes, ['name', 'port', 'sanctum', 'v']);
  if (!value || value.sanctum !== 'pair-here' || value.v !== 1) return null;
  if (!validPort(value.port) || typeof value.name !== 'string') return null;
  return { address, port: value.port, name: value.name };
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
function createLineChannel(socket, { clock, side, onMessage, onClose, onGone = () => {}, onWire = null }) {
  const other = side === 'home' ? 'laptop' : 'home';
  let finished = false;
  let pending = Buffer.alloc(0);
  let lines = 0;
  let idleTimer = null;

  function armIdle() {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      end();
    }, IDLE_MS);
  }

  function stopTimer() {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = null;
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

  return {
    get finished() {
      return finished;
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

// `loopback` has to be said either way. True keeps every socket on 127.0.0.1, for tests and
// for an unpackaged run that a test started. Under the test runner false is refused.
function createLocalPairing({ loopback, discoveryPort = DISCOVERY_PORT, networkInterfaces = os.networkInterfaces, onWire = null } = {}) {
  if (loopback !== true && loopback !== false) throw new Error('Say whether to keep to loopback.');
  if (loopback === false && process.env.NODE_TEST_CONTEXT) throw new Error('A test may only use loopback.');

  function bindHostFor(requested) {
    if (!loopback) return ALL_INTERFACES;
    const host = requested ?? LOOPBACK;
    if (!LOOPBACK_HOSTS.has(host)) throw new Error('Only loopback here.');
    return host;
  }

  // Home's two sockets, while a code is showing. `ready` is the ports once both are bound,
  // or null if they couldn't be, and then pairing goes by the relay alone.
  function listen({ name, clock = systemClock, host, onMessage, onClose }) {
    const bindHost = bindHostFor(host);
    const udp = dgram.createSocket({ type: bindHost.includes(':') ? 'udp6' : 'udp4' });
    const server = net.createServer();
    const channels = new Set();
    let closed = false;
    let closing = null;
    let tcpPort = null;
    let lastAcceptAt = -Infinity;
    let replyWindowStart = -Infinity;
    let repliesInWindow = 0;

    udp.on('error', () => listener.close());
    server.on('error', () => listener.close());

    udp.on('message', (msg, rinfo) => {
      if (closed || tcpPort === null) return;
      if (!isPrivateAddress(rinfo.address) || !isProbe(msg)) return;
      const now = clock.now();
      if (now - replyWindowStart >= 1000) {
        replyWindowStart = now;
        repliesInWindow = 0;
      }
      if (repliesInWindow >= MAX_REPLIES_PER_SECOND) return;
      repliesInWindow += 1;
      try {
        udp.send(replyBytes({ port: tcpPort, name }), rinfo.port, rinfo.address, () => {});
      } catch { /* closing */ }
    });

    server.on('connection', (socket) => {
      socket.on('error', () => {});
      const now = clock.now();
      if (closed || !isPrivateAddress(socket.remoteAddress) || channels.size >= MAX_CONNECTIONS || now - lastAcceptAt < NEW_CONNECTION_GAP_MS) {
        socket.destroy();
        return;
      }
      lastAcceptAt = now;
      socket.setNoDelay(true);
      const channel = createLineChannel(socket, {
        clock,
        side: 'home',
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
        udp.bind({ address: bindHost, port: discoveryPort, exclusive: true }, () => {
          udp.off('error', reject);
          resolve();
        });
      });
    }

    function listenTcp() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: bindHost, port: 0, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    }

    const ready = (async () => {
      try {
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
        }
        return closing;
      }
    };
    return listener;
  }

  // The laptop's search: probes PROBES times, PROBE_GAP_MS apart, and gathers replies for
  // DISCOVERY_MS. `result` is the homes found, at most MAX_HOMES and one per address.
  function discover({ clock = systemClock } = {}) {
    const socket = dgram.createSocket({ type: 'udp4' });
    const homes = createHomeList();
    const targets = loopback ? [LOOPBACK] : broadcastAddresses(safeInterfaces());
    const timers = [];
    let bound = false;
    let finished = false;
    let settleResult;
    const result = new Promise((resolve) => {
      settleResult = resolve;
    });

    function finish() {
      if (finished) return;
      finished = true;
      for (const timer of timers) clock.clearTimeout(timer);
      try {
        socket.close();
      } catch { /* never bound */ }
      settleResult(homes.list());
    }

    function probe() {
      if (finished || !bound) return;
      for (const target of targets) {
        try {
          socket.send(probeBytes(), discoveryPort, target, () => {});
        } catch { /* one unreachable network doesn't end the search */ }
      }
    }

    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      if (finished) return;
      const home = parseReply(msg, rinfo.address);
      if (home) homes.add(home);
    });
    // Bound before anything is sent, since sending first would bind it to every interface.
    socket.bind({ address: loopback ? LOOPBACK : ALL_INTERFACES, port: 0 }, () => {
      if (finished) return;
      bound = true;
      if (!loopback) {
        try {
          socket.setBroadcast(true);
        } catch {
          return finish();
        }
      }
      probe();
    });
    for (let i = 1; i < PROBES; i++) timers.push(clock.setTimeout(probe, i * PROBE_GAP_MS));
    timers.push(clock.setTimeout(finish, DISCOVERY_MS));

    return { result, cancel: finish };
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

module.exports = {
  DISCOVERY_PORT,
  MAX_LINE_BYTES,
  MAX_LINES,
  IDLE_MS,
  isPrivateAddress,
  broadcastAddresses,
  probeBytes,
  isProbe,
  replyBytes,
  parseReply,
  createHomeList,
  createLocalPairing,
  connectLocalPairing
};
