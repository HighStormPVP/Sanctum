// The relay connection trusts what the Mac's Keychain trusts, so a school's or company's
// filter that re-signs secure traffic (Zscaler, for one) doesn't stop it, just as it doesn't
// stop Safari. Everything here stays on 127.0.0.1, and nothing reaches a real relay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const tls = require('node:tls');
const { WebSocketServer } = require('ws');
const { systemCertificates, pemBlocks, MAC_KEYCHAINS } = require('../lib/remote/system-ca.js');
const { connectPairing, trusting } = require('../lib/remote/relay-client.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'tls');
// A certificate authority made only for these tests, standing in for Zscaler's. Its key is gone.
const TEST_CA = fs.readFileSync(path.join(FIXTURES, 'ca.pem'), 'utf8').replace(/\r\n/g, '\n');

const clock = {
  setTimeout, clearTimeout, setInterval, clearInterval, now: () => Date.now()
};

test('pemBlocks takes each certificate out of what security prints, and nothing else', () => {
  const text = `junk\n${TEST_CA}\nmore junk\n${TEST_CA.replace(/\n$/, '')}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`;
  const blocks = pemBlocks(text);
  assert.equal(blocks.length, 2);
  for (const block of blocks) {
    assert.match(block, /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/);
    assert.doesNotMatch(block, /PRIVATE KEY/);
  }
});

test('off a Mac, nothing changes: the built-in list is used as it always was', () => {
  let ran = 0;
  assert.equal(systemCertificates({ platform: 'win32', run: () => { ran++; return TEST_CA; } }), null);
  assert.equal(systemCertificates({ platform: 'linux', run: () => { ran++; return TEST_CA; } }), null);
  assert.equal(ran, 0, 'no command runs');
});

test("on a Mac, the Keychain's certificates join the built-in list", () => {
  const asked = [];
  const list = systemCertificates({
    platform: 'darwin',
    home: '/Users/someone',
    run: (file, args) => {
      asked.push([file, ...args]);
      return args.at(-1) === '/Library/Keychains/System.keychain' ? TEST_CA : '';
    }
  });
  assert.ok(list.includes(TEST_CA.trim()), 'the filter\'s authority');
  for (const root of tls.rootCertificates) assert.ok(list.includes(root), 'and every built-in one');
  assert.equal(new Set(list).size, list.length, 'each once');
  assert.deepEqual(asked.map((a) => a[0]), asked.map(() => '/usr/bin/security'));
  assert.deepEqual(asked.map((a) => a.slice(1, 4)), asked.map(() => ['find-certificate', '-a', '-p']));
  assert.deepEqual(asked.map((a) => a.at(-1)), [...MAC_KEYCHAINS, '/Users/someone/Library/Keychains/login.keychain-db']);
});

test('a keychain that cannot be read is skipped, and with nothing found the built-in list stands', () => {
  const some = systemCertificates({
    platform: 'darwin',
    home: '/Users/someone',
    run: (file, args) => {
      if (args.at(-1).includes('login')) throw new Error('security: no such keychain');
      return args.at(-1) === '/Library/Keychains/System.keychain' ? TEST_CA : '';
    }
  });
  assert.ok(some.includes(TEST_CA.trim()));
  assert.equal(systemCertificates({ platform: 'darwin', home: '/Users/someone', run: () => { throw new Error('no security'); } }), null);
  assert.equal(systemCertificates({ platform: 'darwin', home: '/Users/someone', run: () => '' }), null);
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

test('by default a re-signed certificate is refused, as a TLS problem', async (t) => {
  const { address, opened } = await interceptedServer(t);
  const result = await pairOnce(connectPairing, address);
  assert.equal(result.open, false);
  assert.match(result.reason, /^(SELF_SIGNED|UNABLE_TO_|CERT_|DEPTH_ZERO)/);
  assert.equal(opened.length, 0);
});

test('trusting the authority the system trusts, the same certificate is accepted', async (t) => {
  const { address, opened } = await interceptedServer(t);
  const client = trusting(() => [...tls.rootCertificates, TEST_CA]);
  const result = await pairOnce(client.connectPairing, address);
  assert.deepEqual(result, { open: true });
  assert.deepEqual(opened, ['/test-secret/pair/host']);
});

test('trusting nothing extra leaves the built-in list, so the same certificate is still refused', async (t) => {
  const { address } = await interceptedServer(t);
  const client = trusting(() => null);
  const result = await pairOnce(client.connectPairing, address);
  assert.equal(result.open, false);
});

test('the list is asked for when a connection opens, not when Sanctum starts', () => {
  let asked = 0;
  trusting(() => { asked++; return null; });
  assert.equal(asked, 0);
});
