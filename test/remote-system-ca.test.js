// The relay connection also trusts the roots in a Mac's system keychain, so a school's or
// company's filter that re-signs secure traffic (Zscaler, for one) doesn't stop it, just as it
// doesn't stop Safari. Everything here stays on 127.0.0.1, and nothing reaches a real relay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');
const { WebSocketServer } = require('ws');
const { systemCertificates, pemBlocks, trustAnchors, MAC_SYSTEM_KEYCHAIN } = require('../lib/remote/system-ca.js');
const { connectPairing, trusting } = require('../lib/remote/relay-client.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n').trim();
// A certificate authority made only for these tests, standing in for Zscaler's. Its key is gone.
const TEST_CA = read('ca.pem');
// A server certificate it signed: a leaf, which can never stand as a root.
const LEAF = read('server.pem');
const INSECURE = /^(SELF_SIGNED|UNABLE_TO_|CERT_|DEPTH_ZERO)/;

const clock = {
  setTimeout, clearTimeout, setInterval, clearInterval, now: () => Date.now()
};

test('pemBlocks takes each certificate out of what security prints, and nothing else', () => {
  const text = `junk\n${TEST_CA}\nmore junk\r\n${TEST_CA.replace(/\n/g, '\r\n')}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`;
  const blocks = pemBlocks(text);
  assert.deepEqual(blocks, [TEST_CA, TEST_CA]);
});

test('only a self-signed CA certificate that has not expired can stand as a root', () => {
  assert.deepEqual(trustAnchors([TEST_CA, LEAF, 'not a certificate']), [TEST_CA]);
  // The test authority runs out in 2046.
  assert.deepEqual(trustAnchors([TEST_CA], Date.parse('2050-01-01')), []);
});

test('off a Mac, nothing changes: the built-in list is used as it always was', async () => {
  let ran = 0;
  for (const platform of ['win32', 'linux']) {
    assert.deepEqual(await systemCertificates({ platform, run: async () => { ran++; return TEST_CA; } }), { list: null, complete: true });
  }
  assert.equal(ran, 0, 'no command runs');
});

test("on a Mac, the system keychain's own roots join the built-in list, and only those", async () => {
  const asked = [];
  const { list, complete } = await systemCertificates({
    platform: 'darwin',
    run: async (file, args) => {
      asked.push([file, ...args]);
      return `${TEST_CA}\n${LEAF}\n${tls.rootCertificates[0]}\n`;
    }
  });
  assert.equal(complete, true);
  assert.deepEqual(asked, [['/usr/bin/security', 'find-certificate', '-a', '-p', MAC_SYSTEM_KEYCHAIN]], 'the system keychain alone, never the login keychain');
  assert.deepEqual(list.slice(0, tls.rootCertificates.length), tls.rootCertificates, 'the built-in list first');
  assert.deepEqual(list.slice(tls.rootCertificates.length), [TEST_CA], "the filter's root, and not the leaf");
});

test('a keychain with no roots of its own leaves the built-in list alone', async () => {
  assert.deepEqual(await systemCertificates({ platform: 'darwin', run: async () => `${LEAF}\n${tls.rootCertificates[3]}` }), { list: null, complete: true });
  assert.deepEqual(await systemCertificates({ platform: 'darwin', run: async () => '' }), { list: null, complete: true });
});

test("a keychain that can't be read says so, so the answer isn't kept", async () => {
  assert.deepEqual(await systemCertificates({ platform: 'darwin', run: async () => { throw new Error('timed out'); } }), { list: null, complete: false });
});

// A secure WebSocket server on 127.0.0.1 whose certificate is signed by the test authority,
// the way a filter's is. It accepts the pairing channel and says nothing.
async function interceptedServer(t) {
  const server = https.createServer({
    key: fs.readFileSync(path.join(FIXTURES, 'server-key.pem')),
    cert: fs.readFileSync(path.join(FIXTURES, 'server.pem'))
  });
  const wss = new WebSocketServer({ server });
  const opened = [];
  wss.on('connection', (socket, req) => opened.push(req.url));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close(resolve);
  }));
  return { address: `wss://localhost:${server.address().port}/test-secret`, opened };
}

function pairOnce(connect, address) {
  return new Promise((resolve) => {
    const channel = connect({
      address,
      role: 'host',
      clock,
      onOpen: () => {
        resolve({ open: true });
        channel.close();
      },
      onMessage() {},
      onNone() {},
      onClose: (reason) => resolve({ open: false, reason })
    });
  });
}

test('by default a re-signed certificate is refused, as a certificate problem', async (t) => {
  const { address, opened } = await interceptedServer(t);
  const result = await pairOnce(connectPairing, address);
  assert.equal(result.open, false);
  assert.match(result.reason, INSECURE);
  assert.equal(opened.length, 0);
});

test('trusting the root the system keychain holds, the same certificate is accepted', async (t) => {
  const { address, opened } = await interceptedServer(t);
  const client = trusting(() => [...tls.rootCertificates, TEST_CA]);
  const result = await pairOnce(client.connectPairing, address);
  assert.deepEqual(result, { open: true });
  assert.deepEqual(opened, ['/test-secret/pair/host']);
});

test('an unreadable certificate in the list drops only itself', async (t) => {
  const { address } = await interceptedServer(t);
  const garbage = '-----BEGIN CERTIFICATE-----\nAAAAnotacertificateAAAA\n-----END CERTIFICATE-----';
  const client = trusting(() => [...tls.rootCertificates, garbage, TEST_CA]);
  assert.deepEqual(await pairOnce(client.connectPairing, address), { open: true });
});

test('trusting nothing extra leaves the built-in list, so the same certificate is still refused', async (t) => {
  const { address } = await interceptedServer(t);
  const client = trusting(() => null);
  const result = await pairOnce(client.connectPairing, address);
  assert.equal(result.open, false);
  assert.match(result.reason, INSECURE);
});

test('a refusal over the certificate is reported, so the keychain can be read again', async (t) => {
  const { address } = await interceptedServer(t);
  const heard = [];
  const client = trusting(() => null, { onInsecure: (reason) => heard.push(reason) });
  const result = await pairOnce(client.connectPairing, address);
  assert.deepEqual(heard, [result.reason], 'once, with the same reason the owner gets');
});

test('the list is asked for as each connection opens, and made into a TLS context only when it changes', async (t) => {
  const { address } = await interceptedServer(t);
  let asked = 0;
  let list = [...tls.rootCertificates, TEST_CA];
  const made = [];
  const real = tls.createSecureContext;
  tls.createSecureContext = (options) => {
    made.push(options);
    return real(options);
  };
  t.after(() => { tls.createSecureContext = real; });
  const client = trusting(() => { asked++; return list; });
  assert.equal(asked, 0, 'not when made');
  await pairOnce(client.connectPairing, address);
  await pairOnce(client.connectPairing, address);
  assert.equal(asked, 2);
  assert.equal(made.filter((o) => o?.ca).length, 1, 'one context for the same list');
  list = [...list];
  await pairOnce(client.connectPairing, address);
  assert.equal(made.filter((o) => o?.ca).length, 2, 'a new one for a new list');
});
