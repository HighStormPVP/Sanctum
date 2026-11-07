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
    name: options.name ?? 'Home Desk',
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
  assert.deepEqual(JSON.parse(replyBytes({ port: 50123, name: 'Home Desk' }).toString('utf8')), {
    sanctum: 'pair-here', v: 1, port: 50123, name: 'Home Desk'
  });
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
  const good = { sanctum: 'pair-here', v: 1, port: 50123, name: 'Home Desk' };
  const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  assert.deepEqual(parseReply(bytes(good), '192.168.1.20'), { address: '192.168.1.20', port: 50123, name: 'Home Desk' });
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
    'no port': [{ sanctum: 'pair-here', v: 1, name: 'Home Desk' }],
    'a name that is not text': [{ ...good, name: 7 }],
    'no name': [{ sanctum: 'pair-here', v: 1, port: 50123 }],
    'another version': [{ ...good, v: 2 }],
    'a probe': [{ sanctum: 'pair-probe', v: 1 }],
    'an extra field': [{ ...good, address: '8.8.8.8' }],
    'over 1 KiB': [{ ...good, name: 'x'.repeat(1100) }],
    'not JSON': ['pair-here 50123'],
    'a JSON array': ['[1,2]'],
    'JSON null': ['null'],
    'nothing': ['']
  };
  for (const [what, [value, from = '192.168.1.20']] of Object.entries(refused)) {
    assert.equal(parseReply(bytes(value), from), null, what);
  }
});

test('the list of homes keeps at most four, and one per address', () => {
  const homes = createHomeList();
  homes.add({ address: '192.168.1.2', port: 50000, name: 'A' });
  homes.add({ address: '192.168.1.2', port: 50001, name: 'A again' });
  for (let i = 3; i <= 9; i++) homes.add({ address: `192.168.1.${i}`, port: 50000 + i, name: `H${i}` });
  assert.deepEqual(homes.list().map((h) => h.address), ['192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5']);
  assert.equal(homes.list()[0].port, 50000, 'the first answer from an address stands');
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

test('a loopback listener binds both its sockets to 127.0.0.1 and nothing wider', async (t) => {
  const { listener, ports, discoveryPort } = await startListener(t);
  assert.equal(ports.udpPort, discoveryPort);
  assert.ok(ports.tcpPort >= 1024);
  assert.deepEqual(listener.boundAddresses(), [LOOPBACK, LOOPBACK]);
});

// ---- Finding a home ----

test('a listener answers a probe with its port and name, and discover finds it on loopback', async (t) => {
  const { pairing, ports } = await startListener(t, { name: 'Home Desk' });
  const homes = await pairing.discover().result;
  assert.deepEqual(homes, [{ address: LOOPBACK, port: ports.tcpPort, name: 'Home Desk' }]);
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
  const reply = replyBytes({ port: 40000, name: 'Late' });
  clock.advance(1999);
  fakeHome.send(reply, probes[0].port, LOOPBACK);
  await sleep(100);
  assert.equal(done, null);
  clock.advance(1);
  await waitFor('the result', () => done !== null);
  assert.deepEqual(done, [{ address: LOOPBACK, port: 40000, name: 'Late' }]);
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
    send({ sanctum: 'pair-here', v: 1, port: 80, name: 'Low port' });
    send({ sanctum: 'pair-here', v: 1, port: 41000, name: 'x'.repeat(1100) });
    send({ sanctum: 'pair-here', v: 1, port: 41001, name: 'Extra', extra: true });
    send({ sanctum: 'pair-here', v: 1, port: 41002, name: 'Good' });
    send({ sanctum: 'pair-here', v: 1, port: 41003, name: 'Second from the same address' });
  });
  await new Promise((resolve) => fakeHome.bind({ address: LOOPBACK, port: discoveryPort }, resolve));
  t.after(() => fakeHome.close());

  const clock = fakeClock();
  const search = createLocalPairing({ loopback: true, discoveryPort }).discover({ clock });
  await sleep(300);
  clock.advance(4000);
  assert.deepEqual(await search.result, [{ address: LOOPBACK, port: 41002, name: 'Good' }]);
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
    onOpen: () => client.send({ t: 'pake' }),
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
  const fitting = JSON.stringify({ t: 'pake', pad: 'x'.repeat(64 * 1024 - 40) });
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

test('the ninth line closes the connection, and the eight before it arrive', async (t) => {
  const { ports, seen } = await startListener(t);
  const raw = rawClient(ports.tcpPort);
  await raw.opened;
  for (let i = 0; i < 8; i++) raw.socket.write(`${JSON.stringify({ t: 'pake', i })}\n`);
  await waitFor('eight lines', () => seen.messages.length === 8);
  assert.equal(raw.closed, false);
  raw.socket.write(`${JSON.stringify({ t: 'pake', i: 8 })}\n`);
  await waitFor('the connection to close', () => raw.closed);
  assert.equal(seen.messages.length, 8);
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

test('thirty seconds without a line closes the connection', async (t) => {
  const clock = fakeClock();
  const { ports, seen } = await startListener(t, { clock });
  const raw = rawClient(ports.tcpPort);
  await raw.opened;
  await waitFor('the connection to be seen', () => clock.pending() > 0);
  clock.advance(20000);
  raw.socket.write(`${JSON.stringify({ t: 'pake' })}\n`);
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

test('home holds at most two connections at once', async (t) => {
  const clock = fakeClock();
  const { ports } = await startListener(t, { clock });
  const clients = [];
  for (let i = 0; i < 3; i++) {
    clock.advance(1000);
    const raw = rawClient(ports.tcpPort);
    clients.push(raw);
    await raw.opened;
    await sleep(80);
  }
  await waitFor('the third to be closed', () => clients[2].closed);
  assert.equal(clients[0].closed, false);
  assert.equal(clients[1].closed, false);

  // One going makes room.
  clients[0].socket.destroy();
  await sleep(100);
  clock.advance(1000);
  const next = rawClient(ports.tcpPort);
  await next.opened;
  await sleep(150);
  assert.equal(next.closed, false);
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
  const listener = pairing.listen({ name: 'Home', onMessage() {}, onClose() {} });
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
    onOpen: () => client.send({ t: 'confirm' }),
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
  const listener = pairing.listen({ name: 'Home', onMessage() {}, onClose() {} });
  assert.equal(await listener.ready, null);
  await listener.close();
});

// ---- The Mac's permission ----

test('the Mac build says why Sanctum looks on the local network, in the app\'s own Info.plist', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  // electron-builder 25 copies extendInfo's keys over the app's Info.plist with Object.assign.
  assert.deepEqual(pkg.build.mac.extendInfo, {
    NSLocalNetworkUsageDescription: 'Sanctum looks for your home PC on this network when you pair with a code.'
  });
});
