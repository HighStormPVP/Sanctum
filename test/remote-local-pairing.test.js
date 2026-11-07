// Pairing on the same network: finding a home PC that's showing a code, and the pairing
// messages over a plain TCP connection. Real sockets, but only ever on loopback: a socket
// bound anywhere else makes Windows ask the person at this machine about its firewall.
// The manager's use of this is in test/remote-manager.test.js, and two real managers
// pair this way in relay/test/manager.test.js.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const net = require('node:net');
const path = require('node:path');

const local = require(path.join(__dirname, '..', 'lib', 'remote', 'local-pairing.js'));
const {
  DISCOVERY_PORT, isPrivateAddress, probeBytes, isProbe, replyBytes, parseReply, createHomeList,
  broadcastAddresses, createLocalPairing, connectLocalPairing
} = local;

const LOOPBACK = '127.0.0.1';
const PAKE_LINE = JSON.stringify({ t: 'pake', pake: 'AAAA' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Time moves only when a test says so, while the sockets stay real.
function fakeClock() {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: time + Math.max(0, ms) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      throw new Error('not used here');
    },
    clearInterval() {},
    advance(ms) {
      const end = time + ms;
      for (;;) {
        let next = null;
        for (const entry of timers) if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        time = next[1].due;
        next[1].fn();
      }
      time = end;
    },
    pending: () => timers.size
  };
}

// A port nothing is using right now, on loopback, for a listener's discovery socket. The
// app's fixed port isn't used, so this can run beside anything else on this machine.
async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind({ address: LOOPBACK, port: 0 }, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function udpPortFree(port, address = LOOPBACK) {
  const socket = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ address, port, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      socket.close();
    } catch { /* never bound */ }
  }
}

async function tcpPortFree(port, address = LOOPBACK) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: address, port, exclusive: true }, resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

// A client socket to a listener, that records what it's sent and whether it was closed.
function rawClient(port, host = LOOPBACK) {
  const socket = net.connect({ host, port });
  const raw = { socket, data: '', closed: false };
  socket.on('data', (chunk) => {
    raw.data += chunk.toString('utf8');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    raw.closed = true;
  });
  raw.opened = new Promise((resolve) => socket.once('connect', resolve));
  return raw;
}

async function startListener(t, options = {}) {
  const discoveryPort = options.discoveryPort ?? await freeUdpPort();
  const pairing = createLocalPairing({ loopback: true, discoveryPort, ...options.config });
  const seen = { messages: [], closed: [], channels: new Set() };
  const listener = pairing.listen({
    clock: options.clock,
    host: options.host,
    onMessage(channel, msg) {
      seen.channels.add(channel);
      seen.messages.push(msg);
      options.onMessage?.(channel, msg);
    },
    onClose(channel) {
      seen.closed.push(channel);
    }
  });
  t.after(() => listener.close());
  const ports = await listener.ready;
  assert.ok(ports, 'the listener bound');
  return { pairing, listener, ports, seen, discoveryPort };
}

// ---- Which addresses count as this network ----

test('isPrivateAddress takes the private, link-local and loopback IPv4 ranges', () => {
  for (const address of [
    '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.255',
    '169.254.1.1', '127.0.0.1', '127.255.0.9'
  ]) assert.equal(isPrivateAddress(address), true, address);
});

test('isPrivateAddress takes the IPv4-mapped IPv6 forms of the same ranges', () => {
  for (const address of [
    '::ffff:10.1.2.3', '::FFFF:192.168.1.20', '::ffff:127.0.0.1', '::ffff:172.20.0.5', '::ffff:169.254.9.9',
    '0:0:0:0:0:ffff:192.168.1.1', '::ffff:c0a8:0101', '::ffff:7f00:1'
  ]) assert.equal(isPrivateAddress(address), true, address);
});

test('isPrivateAddress refuses everything else, the near misses most of all', () => {
  for (const address of [
    // Just outside each range.
    '172.32.0.1', '172.15.255.255', '192.169.0.1', '192.167.255.255', '11.0.0.1', '9.255.255.255',
    '169.255.0.1', '169.253.255.255', '128.0.0.1', '126.255.255.255',
    // Shared address space, which carrier networks use and isn't one network.
    '100.64.0.1', '100.127.255.254',
    // Public, and the special ones.
    '8.8.8.8', '1.1.1.1', '0.0.0.0', '255.255.255.255', '224.0.0.1',
    // Mapped forms of public addresses, and IPv6 that isn't mapped.
    '::ffff:8.8.8.8', '::ffff:172.32.0.1', '::ffff:100.64.0.1', '::ffff:0808:0808', '::1', 'fe80::1', 'fd00::1', '::',
    '::ffff:', '64:ff9b::10.0.0.1', '::10.0.0.1',
    // Not addresses.
    '', 'localhost', '10.0.0', '10.0.0.1.5', '10.0.0.256', '10.0.0.-1', ' 10.0.0.1', '10.0.0.1 ', '010.0.0.1',
    '1e1.0.0.1', '0x0a.0.0.1', 'ten.0.0.1'
  ]) assert.equal(isPrivateAddress(address), false, JSON.stringify(address));
  for (const notText of [null, undefined, 10, {}, ['10.0.0.1']]) assert.equal(isPrivateAddress(notText), false);
});

// ---- What crosses in a datagram ----

test('the probe and the reply are exactly the agreed shapes', () => {
  assert.equal(DISCOVERY_PORT, 47613);
  assert.equal(probeBytes().toString('utf8'), '{"sanctum":"pair-probe","v":1}');
  // No name: nothing reads it, and anyone on the network could.
  assert.equal(replyBytes({ port: 50123 }).toString('utf8'), '{"sanctum":"pair-here","v":1,"port":50123}');
  assert.equal(isProbe(probeBytes()), true);
});

test('a probe that is anything but exactly that shape is ignored', () => {
  const bad = [
    '{"sanctum":"pair-probe","v":2}', '{"sanctum":"pair-here","v":1}', '{"sanctum":"pair-probe"}',
    '{"sanctum":"pair-probe","v":1,"x":1}', '{"v":1}', '[]', 'null', '"pair-probe"', 'not json', '',
    `{"sanctum":"pair-probe","v":1,"pad":"${'x'.repeat(1100)}"}`
  ];
  for (const text of bad) assert.equal(isProbe(Buffer.from(text)), false, text.slice(0, 60));
});

test('a reply is taken only in its exact shape, from this network, with a port it could listen on', () => {
  const good = { sanctum: 'pair-here', v: 1, port: 50123 };
  const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  assert.deepEqual(parseReply(bytes(good), '192.168.1.20'), { address: '192.168.1.20', port: 50123 });
  assert.deepEqual(parseReply(bytes({ ...good, port: 1024 }), '10.0.0.2')?.port, 1024);
  assert.deepEqual(parseReply(bytes({ ...good, port: 65535 }), '10.0.0.2')?.port, 65535);
  // The address it came from, not one it claims, and in IPv4 spelling when it came mapped.
  assert.deepEqual(parseReply(bytes(good), '::ffff:192.168.1.20')?.address, '192.168.1.20');

  const refused = {
    'a public sender': [good, '8.8.8.8'],
    'a near-miss sender': [good, '172.32.0.1'],
    'shared address space': [good, '100.64.0.1'],
    'no sender': [good, null],
    'a low port': [{ ...good, port: 1023 }],
    'port zero': [{ ...good, port: 0 }],
    'a port past the range': [{ ...good, port: 65536 }],
    'a fractional port': [{ ...good, port: 50123.5 }],
    'a port as text': [{ ...good, port: '50123' }],
    'a negative port': [{ ...good, port: -50123 }],
    'no port': [{ sanctum: 'pair-here', v: 1 }],
    'a name, which the shape no longer has': [{ ...good, name: 'Home Desk' }],
    'another version': [{ ...good, v: 2 }],
    'a probe': [{ sanctum: 'pair-probe', v: 1 }],
    'an extra field': [{ ...good, address: '8.8.8.8' }],
    'over 1 KiB': [`{"sanctum":"pair-here","v":1,"port":50123${' '.repeat(1100)}}`],
    'not JSON': ['pair-here 50123'],
    'a JSON array': ['[1,2]'],
    'JSON null': ['null'],
    'nothing': ['']
  };
  for (const [what, [value, from = '192.168.1.20']] of Object.entries(refused)) {
    assert.equal(parseReply(bytes(value), from), null, what);
  }
});

test('the list of homes keeps sixteen, one per address, in the order they answered', () => {
  const homes = createHomeList();
  homes.add({ address: '192.168.1.2', port: 50000 });
  homes.add({ address: '192.168.1.2', port: 50001 });
  for (let i = 3; i <= 30; i++) homes.add({ address: `192.168.1.${i}`, port: 50000 + i });
  const list = homes.list();
  assert.equal(list.length, 16);
  assert.deepEqual(list.map((h) => h.address), Array.from({ length: 16 }, (_, i) => `192.168.1.${i + 2}`));
  assert.equal(list[0].port, 50000, 'the first answer from an address stands');
});

test('broadcastAddresses is the limited broadcast and each private interface\'s directed one', () => {
  const interfaces = {
    'Wi-Fi': [
      { address: '192.168.1.37', netmask: '255.255.255.0', family: 'IPv4', internal: false },
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }
    ],
    Ethernet: [{ address: '10.20.30.40', netmask: '255.255.0.0', family: 4, internal: false }],
    'Office VPN': [{ address: '172.20.1.2', netmask: '255.255.255.252', family: 'IPv4', internal: false }],
    Loopback: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    Public: [{ address: '203.0.113.9', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    'Point to point': [{ address: '10.9.9.9', netmask: '255.255.255.255', family: 'IPv4', internal: false }],
    Duplicate: [{ address: '192.168.1.99', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
    Broken: [{ address: '192.168.7.1', netmask: 'nonsense', family: 'IPv4', internal: false }]
  };
  assert.deepEqual(broadcastAddresses(interfaces), ['255.255.255.255', '192.168.1.255', '10.20.255.255', '172.20.1.3']);
  assert.deepEqual(broadcastAddresses({}), ['255.255.255.255']);
  assert.deepEqual(broadcastAddresses(null), ['255.255.255.255']);
});

// ---- Never off this machine in a test ----

test('outside loopback is refused under the test runner, so no test can ask the firewall', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this runs under node --test');
  assert.throws(() => createLocalPairing({ loopback: false }), /loopback/);
  assert.throws(() => createLocalPairing({}), /loopback/);
});

test('right before any socket binds, a non-loopback host is refused under the test runner', () => {
  // Every bind in the module goes through this, so a mistake in choosing the host can't reach
  // the network either.
  for (const host of ['0.0.0.0', '192.168.1.5', '::', '', undefined]) assert.throws(() => local.checkBindHost(host), /loopback/, String(host));
  for (const host of ['127.0.0.1', '::1']) assert.doesNotThrow(() => local.checkBindHost(host));
});

test('a loopback listener binds both its sockets to 127.0.0.1 and nothing wider', async (t) => {
  const { listener, ports, discoveryPort } = await startListener(t);
  assert.equal(ports.udpPort, discoveryPort);
  assert.ok(ports.tcpPort >= 1024);
  assert.deepEqual(listener.boundAddresses(), [LOOPBACK, LOOPBACK]);
});

// ---- Finding a home ----

test('a listener answers a probe with its port, and discover finds it on loopback', async (t) => {
  const { pairing, ports } = await startListener(t);
  const homes = await pairing.discover().result;
  assert.deepEqual(homes, [{ address: LOOPBACK, port: ports.tcpPort }]);
});

// 127.0.0.2 and up are loopback too, so they can stand in for other machines on the network.
test('four forged replies from other addresses don\'t crowd out the real home, which is tried in its turn', async (t) => {
  const discoveryPort = await freeUdpPort();
  const forgers = [];
  for (let i = 2; i <= 5; i++) {
    const forger = dgram.createSocket('udp4');
    await new Promise((resolve) => forger.bind({ address: `127.0.0.${i}`, port: 0 }, resolve));
    forgers.push(forger);
  }
  const home = dgram.createSocket('udp4');
  home.on('message', (msg, rinfo) => {
    // The forgers answer first, then the real home.
    forgers.forEach((forger, i) => forger.send(replyBytes({ port: 41000 + i }), rinfo.port, rinfo.address));
    setTimeout(() => home.send(replyBytes({ port: 42000 }), rinfo.port, rinfo.address), 30);
  });
  await new Promise((resolve) => home.bind({ address: LOOPBACK, port: discoveryPort }, resolve));
  t.after(() => {
    home.close();
    for (const forger of forgers) forger.close();
  });
  const clock = fakeClock();
  const search = createLocalPairing({ loopback: true, discoveryPort }).discover({ clock });
  await sleep(300);
  clock.advance(4000);
  assert.deepEqual(await search.result, [
    { address: '127.0.0.2', port: 41000 }, { address: '127.0.0.3', port: 41001 },
    { address: '127.0.0.4', port: 41002 }, { address: '127.0.0.5', port: 41003 },
    { address: LOOPBACK, port: 42000 }
  ]);
});

test('discover probes three times a second apart and stops listening at four seconds', async (t) => {
  const discoveryPort = await freeUdpPort();
  const fakeHome = dgram.createSocket('udp4');
  const probes = [];
  fakeHome.on('message', (msg, rinfo) => {
    probes.push({ text: msg.toString('utf8'), from: rinfo.address, port: rinfo.port });
  });
  await new Promise((resolve) => fakeHome.bind({ address: LOOPBACK, port: discoveryPort }, resolve));
  t.after(() => fakeHome.close());

  const clock = fakeClock();
  const pairing = createLocalPairing({ loopback: true, discoveryPort });
  let done = null;
  const search = pairing.discover({ clock });
  search.result.then((homes) => {
    done = homes;
  });
  await waitFor('the first probe', () => probes.length === 1);
  clock.advance(999);
  await sleep(100);
  assert.equal(probes.length, 1);
  clock.advance(1);
  await waitFor('the second probe', () => probes.length === 2);
  clock.advance(1000);
  await waitFor('the third probe', () => probes.length === 3);
  assert.ok(probes.every((p) => p.text === '{"sanctum":"pair-probe","v":1}' && p.from === LOOPBACK));

  // A late answer still counts until four seconds are up.
  const reply = replyBytes({ port: 40000 });
  clock.advance(1999);
  fakeHome.send(reply, probes[0].port, LOOPBACK);
  await sleep(100);
  assert.equal(done, null);
  clock.advance(1);
  await waitFor('the result', () => done !== null);
  assert.deepEqual(done, [{ address: LOOPBACK, port: 40000 }]);
  clock.advance(5000);
  await sleep(100);
  assert.equal(probes.length, 3, 'no probe after the end');
  assert.equal(clock.pending(), 0);
});

test('discover keeps only good replies, and one per address', async (t) => {
  const discoveryPort = await freeUdpPort();
  const fakeHome = dgram.createSocket('udp4');
  fakeHome.on('message', (msg, rinfo) => {
    const send = (value) => fakeHome.send(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), rinfo.port, rinfo.address);
    send('not json');
    send({ sanctum: 'pair-here', v: 1, port: 80 });
    send(`{"sanctum":"pair-here","v":1,"port":41000${' '.repeat(1100)}}`);
    send({ sanctum: 'pair-here', v: 1, port: 41001, name: 'A name' });
    send({ sanctum: 'pair-here', v: 1, port: 41002 });
    send({ sanctum: 'pair-here', v: 1, port: 41003 });
  });
  await new Promise((resolve) => fakeHome.bind({ address: LOOPBACK, port: discoveryPort }, resolve));
  t.after(() => fakeHome.close());

  const clock = fakeClock();
  const search = createLocalPairing({ loopback: true, discoveryPort }).discover({ clock });
  await sleep(300);
  clock.advance(4000);
  assert.deepEqual(await search.result, [{ address: LOOPBACK, port: 41002 }]);
});

test('cancelling a search ends it at once with nothing', async () => {
  const discoveryPort = await freeUdpPort();
  const clock = fakeClock();
  const search = createLocalPairing({ loopback: true, discoveryPort }).discover({ clock });
  search.cancel();
  assert.deepEqual(await search.result, []);
  assert.equal(clock.pending(), 0);
});

test('a listener on IPv6 loopback ignores probes from it, since ::1 is not one of the ranges', async (t) => {
  let ipv6 = true;
  try {
    const probe = dgram.createSocket('udp6');
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.bind({ address: '::1', port: 0 }, resolve);
    });
    probe.close();
  } catch {
    ipv6 = false;
  }
  if (!ipv6) return t.skip('no IPv6 loopback here');

  const { ports } = await startListener(t, { host: '::1' });
  const prober = dgram.createSocket('udp6');
  const answers = [];
  prober.on('message', (msg) => answers.push(msg.toString()));
  await new Promise((resolve) => prober.bind({ address: '::1', port: 0 }, resolve));
  t.after(() => prober.close());
  prober.send(probeBytes(), ports.udpPort, '::1');
  await sleep(300);
  assert.deepEqual(answers, []);

  // And its TCP side closes a connection from there before reading a byte.
  const raw = rawClient(ports.tcpPort, '::1');
  await waitFor('the connection to close', () => raw.closed);
});

// ---- The pairing channel ----

test('connectLocalPairing has the relay pairing interface, with newline-delimited JSON both ways', async (t) => {
  const { ports, seen } = await startListener(t, {
    onMessage: (channel, msg) => channel.send({ t: 'pake-reply', echo: msg.t })
  });
  const got = [];
  let opened = false;
  let closed = 0;
  const wire = [];
  const client = connectLocalPairing({
    address: LOOPBACK,
    port: ports.tcpPort,
    onOpen: () => {
      opened = true;
      client.send({ t: 'pake', pake: 'AAAA' });
    },
    onMessage: (msg) => got.push(msg),
    onClose: () => {
      closed += 1;
    },
    onWire: (entry) => wire.push(entry)
  });
  assert.deepEqual(Object.keys(client).sort(), ['close', 'send']);
  await waitFor('the reply', () => got.length === 1);
  assert.equal(opened, true);
  assert.deepEqual(seen.messages, [{ t: 'pake', pake: 'AAAA' }]);
  assert.deepEqual(got, [{ t: 'pake-reply', echo: 'pake' }]);
  assert.deepEqual(wire.map((w) => [w.from, w.bytes.toString()]), [
    ['laptop', '{"t":"pake","pake":"AAAA"}\n'],
    ['home', '{"t":"pake-reply","echo":"pake"}\n']
  ]);

  // Closed by its owner: no onClose, and it sends nothing more.
  client.close();
  assert.equal(client.send({ t: 'confirm' }), false);
  await waitFor('home to see it go', () => seen.closed.length === 1);
  await sleep(50);
  assert.equal(closed, 0);
});

test('a channel the other end closes reports onClose once', async (t) => {
  const { ports } = await startListener(t, { onMessage: (channel) => channel.close() });
  let closed = 0;
  const client = connectLocalPairing({
    address: LOOPBACK,
    port: ports.tcpPort,
    onOpen: () => client.send({ t: 'pake', pake: 'AAAA' }),
    onMessage: () => {},
    onClose: () => {
      closed += 1;
    }
  });
  await waitFor('onClose', () => closed === 1);
  await sleep(50);
  assert.equal(closed, 1);
});

test('nobody listening is an onClose, not a throw', async () => {
  const port = await freeUdpPort(); // a TCP port is almost certainly free there too
  let closed = 0;
  connectLocalPairing({ address: LOOPBACK, port, onOpen: () => assert.fail('opened'), onMessage: () => {}, onClose: () => { closed += 1; } });
  await waitFor('onClose', () => closed === 1);
});

test('connectLocalPairing refuses to connect anywhere outside this network', () => {
  let closed = 0;
  for (const address of ['8.8.8.8', '100.64.0.1', 'example.com']) {
    assert.throws(() => connectLocalPairing({ address, port: 50000, onOpen() {}, onMessage() {}, onClose: () => { closed += 1; } }));
  }
  assert.equal(closed, 0);
});

test('a line over 64 KiB closes the connection', async (t) => {
  const { ports, seen } = await startListener(t);
  const fits = rawClient(ports.tcpPort);
  await fits.opened;
  const fitting = JSON.stringify({ t: 'pake', pake: 'A'.repeat(64 * 1024 - 40) });
  assert.ok(fitting.length + 1 <= 64 * 1024);
  fits.socket.write(`${fitting}\n`);
  await waitFor('the fitting line', () => seen.messages.length === 1);
  assert.equal(fits.closed, false);

  await sleep(1100); // the next connection may come a second later
  const big = rawClient(ports.tcpPort);
  await big.opened;
  big.socket.write('x'.repeat(64 * 1024 + 1));
  await waitFor('the connection to close', () => big.closed);
  assert.equal(seen.messages.length, 1);
});

// One attempt per connection: a pake, then a confirm, and nothing more.
test('home takes a pake first, then a confirm, and closes a connection for anything else', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const cases = {
    'a first line that is not a pake': [JSON.stringify({ t: 'confirm', confirm: 'AAAA' })],
    'a pake with no pake in it': [JSON.stringify({ t: 'pake' })],
    'a pake whose pake is not text': [JSON.stringify({ t: 'pake', pake: 7 })],
    'a pake with more in it': [JSON.stringify({ t: 'pake', pake: 'AAAA', more: 1 })],
    'a second pake': [PAKE_LINE, PAKE_LINE],
    'a line after the confirm': [PAKE_LINE, JSON.stringify({ t: 'confirm', confirm: 'AAAA' }), JSON.stringify({ t: 'confirm', confirm: 'AAAA' })]
  };
  for (const [what, lines] of Object.entries(cases)) {
    clock.advance(1000);
    const before = seen.messages.length;
    const raw = rawClient(ports.tcpPort);
    await raw.opened;
    for (const line of lines) raw.socket.write(`${line}\n`);
    await waitFor(`${what} to close it`, () => raw.closed);
    // Everything up to the line that broke the rule arrives, and nothing after.
    assert.equal(seen.messages.length - before, lines.length - 1, what);
  }
  // The right two lines keep it open.
  clock.advance(1000);
  const good = rawClient(ports.tcpPort);
  await good.opened;
  good.socket.write(`${PAKE_LINE}\n${JSON.stringify({ t: 'confirm', confirm: 'AAAA' })}\n`);
  await sleep(150);
  assert.equal(good.closed, false);
});

test('a connection that sends no pake within five seconds is closed', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const silent = rawClient(ports.tcpPort);
  await silent.opened;
  await waitFor('the connection to be seen', () => clock.pending() > 0);
  clock.advance(4999);
  await sleep(100);
  assert.equal(silent.closed, false);
  clock.advance(1);
  await waitFor('the silent connection to close', () => silent.closed);

  // A pake in time keeps it.
  clock.advance(1000);
  const prompt = rawClient(ports.tcpPort);
  await prompt.opened;
  prompt.socket.write(`${PAKE_LINE}\n`);
  await waitFor('the pake', () => seen.messages.length === 1);
  clock.advance(10000);
  await sleep(100);
  assert.equal(prompt.closed, false);
});

test('a line that is not a JSON object closes the connection', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  for (const line of ['not json', '[1]', 'null', '7']) {
    clock.advance(1000);
    const raw = rawClient(ports.tcpPort);
    await raw.opened;
    raw.socket.write(`${line}\n`);
    await waitFor(`${line} to close it`, () => raw.closed);
  }
  assert.equal(seen.messages.length, 0);
});

test('thirty seconds without a line after the pake closes the connection', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const raw = rawClient(ports.tcpPort);
  await raw.opened;
  await waitFor('the connection to be seen', () => clock.pending() > 0);
  clock.advance(3000);
  raw.socket.write(`${PAKE_LINE}\n`);
  await waitFor('the line', () => seen.messages.length === 1);
  // A line starts the thirty seconds again.
  clock.advance(29999);
  await sleep(100);
  assert.equal(raw.closed, false);
  clock.advance(1);
  await waitFor('the idle connection to close', () => raw.closed);
});

test('the laptop end has the same limits on what home sends it', async (t) => {
  const clock = fakeClock();
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(`${JSON.stringify({ t: 'pake-reply' })}\n`.repeat(9));
  });
  await new Promise((resolve) => server.listen({ host: LOOPBACK, port: 0 }, resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const got = [];
  let closed = 0;
  connectLocalPairing({ address: LOOPBACK, port: server.address().port, clock, onOpen() {}, onMessage: (m) => got.push(m), onClose: () => { closed += 1; } });
  await waitFor('the ninth line to close it', () => closed === 1);
  assert.equal(got.length, 8);

  const quiet = net.createServer((socket) => socket.on('error', () => {}));
  await new Promise((resolve) => quiet.listen({ host: LOOPBACK, port: 0 }, resolve));
  t.after(() => {
    quiet.close();
  });
  let quietClosed = 0;
  let opened = false;
  connectLocalPairing({ address: LOOPBACK, port: quiet.address().port, clock, onOpen: () => { opened = true; }, onMessage() {}, onClose: () => { quietClosed += 1; } });
  await waitFor('it to open', () => opened);
  clock.advance(30000);
  await waitFor('the idle connection to close', () => quietClosed === 1);
  for (const socket of quiet.connections ?? []) socket.destroy();
});

test('home takes one new connection a second', async (t) => {
  const clock = fakeClock();
  const { ports } = await startListener(t, { clock });
  const first = rawClient(ports.tcpPort);
  await first.opened;
  await sleep(50);
  const second = rawClient(ports.tcpPort);
  await waitFor('the second to be closed', () => second.closed);
  clock.advance(999);
  const third = rawClient(ports.tcpPort);
  await waitFor('the third to be closed', () => third.closed);
  clock.advance(1);
  const fourth = rawClient(ports.tcpPort);
  await fourth.opened;
  await sleep(150);
  assert.equal(fourth.closed, false);
  assert.equal(first.closed, false);
});

test('home holds at most two connections that have sent a pake, and turns a third away', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const clients = [];
  for (let i = 0; i < 3; i++) {
    clock.advance(1000);
    const raw = rawClient(ports.tcpPort);
    clients.push(raw);
    await raw.opened;
    if (i < 2) {
      raw.socket.write(`${PAKE_LINE}\n`);
      await waitFor('its pake', () => seen.messages.length === i + 1);
    }
    await sleep(80);
  }
  await waitFor('the third to be closed', () => clients[2].closed);
  assert.equal(clients[0].closed, false);
  assert.equal(clients[1].closed, false);

  // One going makes room.
  clients[0].socket.destroy();
  await waitFor('home to see it go', () => seen.closed.length === 1);
  await sleep(100);
  clock.advance(1000);
  const next = rawClient(ports.tcpPort);
  await next.opened;
  await sleep(150);
  assert.equal(next.closed, false);
});

test('a new connection pushes out the oldest that hasn\'t sent a pake, so silence can\'t hold the slots', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const first = rawClient(ports.tcpPort);
  await first.opened;
  await sleep(80);
  clock.advance(1000);
  const second = rawClient(ports.tcpPort);
  await second.opened;
  await sleep(80);
  second.socket.write(`${PAKE_LINE}\n`);
  await waitFor('the second one\'s pake', () => seen.messages.length === 1);
  clock.advance(1000);
  const third = rawClient(ports.tcpPort);
  await third.opened;
  await waitFor('the silent first to be pushed out', () => first.closed);
  await sleep(100);
  assert.equal(second.closed, false, 'the one with a pake stays');
  assert.equal(third.closed, false);

  // Silent ones push each other out in turn, oldest first.
  clock.advance(1000);
  const fourth = rawClient(ports.tcpPort);
  await fourth.opened;
  await waitFor('the third to be pushed out', () => third.closed);
  await sleep(100);
  assert.equal(second.closed, false);
  assert.equal(fourth.closed, false);
});

test('closing the listener frees both ports, ends its connections, and answers no more probes', async (t) => {
  const { pairing, listener, ports, discoveryPort } = await startListener(t);
  const raw = rawClient(ports.tcpPort);
  await raw.opened;
  await listener.close();
  await waitFor('the connection to end', () => raw.closed);
  assert.equal(await udpPortFree(discoveryPort), true, 'the discovery port is free');
  assert.equal(await tcpPortFree(ports.tcpPort), true, 'the pairing port is free');
  const clock = fakeClock();
  const search = pairing.discover({ clock });
  await sleep(200);
  clock.advance(4000);
  assert.deepEqual(await search.result, []);
});

test('closing before the sockets have bound still frees them', async (t) => {
  const discoveryPort = await freeUdpPort();
  const pairing = createLocalPairing({ loopback: true, discoveryPort });
  const listener = pairing.listen({ onMessage() {}, onClose() {} });
  const closing = listener.close();
  assert.equal(await listener.ready, null);
  await closing;
  assert.equal(await udpPortFree(discoveryPort), true);
});

test('closing with flush lets what was sent arrive first', async (t) => {
  let listener = null;
  const started = await startListener(t, {
    onMessage: (channel) => {
      channel.send({ t: 'identity', last: true });
      listener.close({ flush: true });
    }
  });
  listener = started.listener;
  const got = [];
  const client = connectLocalPairing({
    address: LOOPBACK,
    port: started.ports.tcpPort,
    onOpen: () => client.send({ t: 'pake', pake: 'AAAA' }),
    onMessage: (msg) => got.push(msg),
    onClose() {}
  });
  await waitFor('the last message', () => got.length === 1);
  assert.deepEqual(got, [{ t: 'identity', last: true }]);
});

test('a discovery port already in use leaves the listener unbound, and it says so', async (t) => {
  const discoveryPort = await freeUdpPort();
  const holder = dgram.createSocket('udp4');
  await new Promise((resolve) => holder.bind({ address: LOOPBACK, port: discoveryPort, exclusive: true }, resolve));
  t.after(() => holder.close());
  const pairing = createLocalPairing({ loopback: true, discoveryPort });
  const listener = pairing.listen({ onMessage() {}, onClose() {} });
  assert.equal(await listener.ready, null);
  await listener.close();
});

test('a listener made right after one that is closing waits for it, and still binds', async () => {
  const discoveryPort = await freeUdpPort();
  const pairing = createLocalPairing({ loopback: true, discoveryPort });
  // As when a code replaces one that hadn't finished binding: closed, not waited for.
  const first = pairing.listen({ onMessage() {}, onClose() {} });
  first.close();
  const second = pairing.listen({ onMessage() {}, onClose() {} });
  assert.equal(await first.ready, null);
  const ports = await second.ready;
  assert.ok(ports, 'the new one bound');
  assert.equal(ports.udpPort, discoveryPort);
  await second.close();

  // And after one that had bound.
  const third = pairing.listen({ onMessage() {}, onClose() {} });
  assert.ok(await third.ready);
  third.close();
  const fourth = pairing.listen({ onMessage() {}, onClose() {} });
  assert.ok(await fourth.ready);
  await fourth.close();
});

// Replies a second, from each source and in all.
test('home answers at most two probes a second from one address, and ten in all', async (t) => {
  const clock = fakeClock();
  const { ports } = await startListener(t, { clock });
  const probers = [];
  const answers = new Map();
  for (let i = 1; i <= 7; i++) {
    const prober = dgram.createSocket('udp4');
    const address = `127.0.0.${i}`;
    answers.set(address, 0);
    prober.on('message', () => answers.set(address, answers.get(address) + 1));
    await new Promise((resolve) => prober.bind({ address, port: 0 }, resolve));
    probers.push(prober);
  }
  t.after(() => {
    for (const prober of probers) prober.close();
  });
  const send = (prober) => new Promise((resolve) => prober.send(probeBytes(), ports.udpPort, LOOPBACK, resolve));

  // One address, five probes: two answers.
  for (let i = 0; i < 5; i++) await send(probers[0]);
  await sleep(200);
  assert.equal(answers.get('127.0.0.1'), 2);

  // A second later, each of seven addresses asks twice: ten answers in all.
  clock.advance(1000);
  for (const prober of probers) {
    await send(prober);
    await send(prober);
  }
  await sleep(300);
  const total = [...answers.values()].reduce((a, b) => a + b, 0) - 2;
  assert.equal(total, 10);
  for (const count of answers.values()) assert.ok(count <= 4);

  // And the next second, a fresh allowance.
  const before = answers.get('127.0.0.7');
  clock.advance(1000);
  await send(probers[6]);
  await sleep(150);
  assert.equal(answers.get('127.0.0.7'), before + 1);
});

// ---- A second guard, from the environment ----

// Run in a process of its own without the test runner's variable, so only SANCTUM_LOOPBACK_ONLY
// can be what refuses. It only calls the check, and never binds anything.
test('SANCTUM_LOOPBACK_ONLY refuses any host but loopback, even outside the test runner', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    const { checkBindHost } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'remote', 'local-pairing.js'))});
    const out = {};
    for (const host of ['0.0.0.0', '192.168.1.5', '127.0.0.1', '::1']) {
      try { checkBindHost(host); out[host] = 'allowed'; } catch { out[host] = 'refused'; }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const run = (extra) => {
    const env = { ...process.env, ...extra };
    delete env.NODE_TEST_CONTEXT;
    if (!('SANCTUM_LOOPBACK_ONLY' in extra)) delete env.SANCTUM_LOOPBACK_ONLY;
    return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }));
  };
  assert.deepEqual(run({ SANCTUM_LOOPBACK_ONLY: '1' }), { '0.0.0.0': 'refused', '192.168.1.5': 'refused', '127.0.0.1': 'allowed', '::1': 'allowed' });
  // Without either, the app's own choice stands.
  assert.deepEqual(run({}), { '0.0.0.0': 'allowed', '192.168.1.5': 'allowed', '127.0.0.1': 'allowed', '::1': 'allowed' });
});

// ---- The Mac's permission ----

test('the Mac build says why Sanctum looks on the local network, in the app\'s own Info.plist', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  // electron-builder 25 copies extendInfo's keys over the app's Info.plist with Object.assign.
  assert.deepEqual(pkg.build.mac.extendInfo, {
    NSLocalNetworkUsageDescription: 'Sanctum looks for your home PC on this network when you pair with a code.'
  });
});
