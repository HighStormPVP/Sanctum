// Direct connections for real: two Electron instances, real WebRTC in the sandboxed hidden
// window over this machine's own networking, and the real relay Worker in Miniflare.
//
//   node e2e/direct.e2e.js
const test = require('node:test');
const assert = require('node:assert');
const { startPair, waitFor, sleep, SECRET } = require('./harness.js');

const CANARY = 'CANARY-chat-text-that-must-only-cross-sealed';

// Closes this device's data channel from inside its hidden window, the way a dropped
// connection would, and leaves the page's own code to notice.
async function closeChannel(device) {
  const transport = await device.transport();
  const closed = await transport.evaluate(() => {
    let count = 0;
    for (const peer of peers.values()) {
      if (peer.channel && peer.channel.readyState === 'open') {
        peer.channel.close();
        count += 1;
      }
    }
    return count;
  });
  assert.equal(closed, 1, 'there was one open channel to close');
}

async function direct(pair) {
  await Promise.all([pair.home.waitForPath('direct'), pair.laptop.waitForPath('direct')]);
}

const sendNumbers = (device, id, from, to) =>
  device.page.evaluate(
    async ([deviceId, first, last]) => {
      const sends = [];
      for (let n = first; n < last; n++) sends.push(window.api.remote.send(deviceId, { n }));
      return (await Promise.all(sends)).every(Boolean);
    },
    [id, from, to]
  );

test('direct connections', async (t) => {
  const pair = await startPair();
  t.after(() => pair.stop());
  const { home, laptop, homeId, laptopId } = pair;

  await t.test('paired devices move to direct, and status says so', async () => {
    await direct(pair);
    const seen = await home.entry();
    assert.equal(seen.connected, true);
    assert.equal(seen.path, 'direct');
    // What set it up crossed as frames, and none of it reached the renderer.
    assert.deepEqual(await home.frames(), []);
    assert.deepEqual(await laptop.frames(), []);
  });

  await t.test('frames cross, and acknowledgements come back, without using the relay for data', async () => {
    const before = await laptop.frameCount();
    assert.equal(await sendNumbers(home, laptopId, 0, 50), true);
    await waitFor('50 frames', async () => (await laptop.frameCount()) === before + 50);
    const sent = await (await home.transport()).evaluate(() => frameLog.filter((e) => e.dir === 'out').length);
    assert.ok(sent >= 50, `the hidden window sent ${sent} messages`);
    const peers = await (await laptop.transport()).evaluate(() => frameLog.filter((e) => e.dir === 'in').length);
    assert.ok(peers >= 50, `the other hidden window received ${peers} messages`);
  });

  await t.test('the hidden window is locked down and stays hidden', async () => {
    for (const device of [home, laptop]) {
      assert.deepEqual(await device.hiddenWindowFacts(), {
        visible: false, contextIsolation: true, sandbox: true, nodeIntegration: false, ownSession: true, sessionPersists: false
      });
      const page = await device.transport();
      assert.deepEqual(
        await page.evaluate(() => [typeof require, typeof process, typeof window.api, Object.keys(window.sanctumTransport).sort()]),
        ['undefined', 'undefined', 'undefined', ['emit', 'onCommand']]
      );

      // Direct is up at this point, so WebRTC works from this page and origin.
      assert.equal(await page.evaluate(() => location.protocol), 'aio-transport:');
      assert.equal(await device.path(), 'direct');

      // It can't open anything, go anywhere, or reach anything: the same denial as the main
      // window, and a CSP that stops what the page itself tries.
      const url = page.url();
      const windowsBefore = await device.windowCount();
      await page.evaluate(() => {
        window.open('https://example.com/');
      });
      await page.evaluate(() => {
        location.href = 'https://example.com/';
      });
      await sleep(300);
      assert.equal(await device.windowCount(), windowsBefore);
      assert.equal(page.url(), url);
      const blocked = await page.evaluate(
        () =>
          new Promise((resolve) => {
            document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true });
            fetch('https://example.com/').catch(() => {});
          })
      );
      assert.equal(blocked, 'connect-src');
      assert.equal(await device.path(), 'direct');
    }
  });

  await t.test('a frame over the 64 KiB limit crosses in pieces, with no message over it', async () => {
    const before = await laptop.frameCount();
    const text = 'y'.repeat(700 * 1024);
    assert.equal(await home.remote('send', laptopId, { text }), true);
    await waitFor('the large frame', async () => (await laptop.frameCount()) === before + 1);
    const got = await laptop.page.evaluate(() => window.__frames.at(-1).text);
    assert.equal(got, text);
    const largest = await (await home.transport()).evaluate(() => Math.max(...frameLog.filter((e) => e.bytes).map((e) => e.bytes.length)));
    assert.ok(largest > 60 * 1024 && largest <= 64 * 1024, `largest message was ${largest}`);
  });

  await t.test('the frame log holds only ciphertext', async () => {
    for (const [from, id, to] of [[home, laptopId, laptop], [laptop, homeId, home]]) {
      const start = await to.frameCount();
      assert.equal(await from.remote('send', id, { text: CANARY, pad: 'p'.repeat(300 * 1024) }), true);
      await waitFor('the canary', async () => (await to.frameCount()) === start + 1);
    }

    for (const device of [home, laptop]) {
      const page = await device.transport();
      const stats = await page.evaluate(
        ([canary, secret, ids, pin]) => {
          const text = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
          const needles = [canary, btoa(canary), secret, ...ids, pin];
          const hit = new Set();
          let frames = 0;
          let bytes = 0;
          for (const entry of frameLog) {
            const seen = entry.bytes ? text(entry.bytes) : JSON.stringify(entry);
            if (entry.bytes) {
              frames += 1;
              bytes += entry.bytes.length;
            }
            for (const needle of needles) if (seen.includes(needle)) hit.add(needle);
          }
          // The search has to be able to find one, or finding none means nothing.
          const control = text(new TextEncoder().encode(`xx${canary}xx`)).includes(canary);
          return { frames, bytes, hits: [...hit], control };
        },
        [CANARY, SECRET, [homeId, laptopId], '123456']
      );
      assert.equal(stats.control, true);
      assert.ok(stats.frames > 0 && stats.bytes > 300 * 1024, `the log saw ${stats.frames} frames, ${stats.bytes} bytes`);
      assert.deepEqual(stats.hits, [], `${device.name}'s hidden window saw plaintext or identifiers`);
    }
    // And it was really carrying that frame: the receiver has the text.
    assert.equal((await laptop.frames()).filter((f) => f.text === CANARY).length, 1);
    assert.equal((await home.frames()).filter((f) => f.text === CANARY).length, 1);
  });

  await t.test('closing the data channel moves to relay, frames keep flowing, and retry returns to direct', async () => {
    await direct(pair);
    await closeChannel(laptop);
    await Promise.all([home.waitForPath('relay', 5000), laptop.waitForPath('relay', 5000)]);
    assert.equal((await home.entry()).connected, true);

    const before = await laptop.frameCount();
    assert.equal(await sendNumbers(home, laptopId, 0, 10), true);
    await waitFor('frames over the relay', async () => (await laptop.frameCount()) === before + 10);

    await direct(pair);
    const after = await laptop.frameCount();
    assert.equal(await sendNumbers(home, laptopId, 10, 20), true);
    await waitFor('frames back on direct', async () => (await laptop.frameCount()) === after + 10);
  });

  await t.test('streaming 10,000 frames across forced switches: each arrives once and in order', async () => {
    await direct(pair);
    await laptop.page.evaluate(() => {
      window.__frames = [];
    });
    await home.page.evaluate(() => {
      window.__statuses = [];
    });
    const stream = (from, to) => sendNumbers(home, laptopId, from, to);

    // Frames still in flight when the channel goes. The home side closes it this time.
    const first = stream(0, 3000);
    await closeChannel(home);
    assert.equal(await first, true);
    await home.waitForPath('relay', 5000);

    // On the relay, and on its way back: frames keep going until the switch has happened.
    // Signaling is in line behind whatever the link resent, and the relay takes 100 messages a
    // second, so getting back takes as long as that backlog does. This pace leaves it room
    // to drain, as a real stream would. The mirror batches, and comes nowhere near the limit.
    const relayedFrom = Date.now();
    let next = 3000;
    while (!((await home.path()) === 'direct' && (await laptop.path()) === 'direct')) {
      assert.ok(Date.now() - relayedFrom < 180000, `never got back to direct; ${await laptop.frameCount()} of ${next} frames in`);
      assert.equal(await stream(next, next + 5), true);
      next += 5;
      await sleep(250);
    }
    t.diagnostic(`back on direct after ${Date.now() - relayedFrom} ms, ${await laptop.frameCount()} of ${next} frames in`);
    assert.ok(next < 8000, 'the second drop needs frames left to send');

    // The rest on direct, with another drop in the middle of them, this time from the far
    // end while frames are on the way.
    const rest = stream(next, 8000);
    await closeChannel(laptop);
    assert.equal(await rest, true);
    await home.waitForPath('relay', 5000);
    await waitFor('the second return to direct', async () => (await home.path()) === 'direct' && (await laptop.path()) === 'direct', 180000);
    assert.equal(await stream(8000, 10000), true);

    await waitFor('all 10,000 frames', async () => (await laptop.frameCount()) >= 10000, 240000);
    await sleep(1000); // anything repeated would have turned up by now
    const numbers = await laptop.page.evaluate(() => window.__frames.map((f) => f.n));
    assert.equal(numbers.length, 10000);
    const wrong = numbers.findIndex((n, i) => n !== i);
    assert.equal(wrong, -1, `frame ${wrong} was ${numbers[wrong]}`);

    // The switches really happened, and the chat never saw the connection drop.
    const statuses = await home.page.evaluate(() => window.__statuses.map((s) => s.devices[0]));
    const paths = statuses.map((d) => d.path).filter((p, i, all) => p !== all[i - 1]);
    assert.ok(paths.filter((p) => p === 'relay').length >= 2, `paths seen: ${paths}`);
    assert.ok(statuses.every((d) => d.connected), 'connected stayed true');
    assert.equal((await home.entry()).path, 'direct');
  });

  await t.test('closing the main window closes the hidden one, and the app with it', async () => {
    assert.ok(await laptop.hiddenWindowFacts());
    await laptop.app.evaluate(({ BrowserWindow }, page) => {
      BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes(page)).close();
    }, 'remote-transport.html');
    await waitFor('the app to exit once its main window closed', () => laptop.exited, 20000);
    // The other end notices, and is left on whatever remains.
    await waitFor('the home side to leave direct', async () => (await home.path()) !== 'direct', 60000);
  });
});

test('with the settings the app ships with, the peer connection is given the real STUN server', async (t) => {
  // No no-stun. The channel forms over host candidates here whether or not that server
  // answers, so this passes offline, and it proves WebRTC accepts the setting as written.
  const pair = await startPair({ flags: 'log' });
  t.after(() => pair.stop());
  await direct(pair);
  for (const device of [pair.home, pair.laptop]) {
    const page = await device.transport();
    const servers = await page.evaluate(() => [...peers.values()].map((peer) => peer.pc.getConfiguration().iceServers));
    assert.deepEqual(servers.map((list) => list.map((server) => server.urls)), [[['stun:stun.cloudflare.com:3478']]]);
  }
});

test('with direct blocked, the relay carries everything', async (t) => {
  // No STUN server and no host candidates: the channel can never form.
  const pair = await startPair({ flags: 'log,no-stun,block-ice' });
  t.after(() => pair.stop());
  const { home, laptop, laptopId, homeId } = pair;

  // An attempt really is under way, or staying on the relay proves nothing.
  const page = await home.transport();
  await waitFor('an attempt', () => page.evaluate(() => peers.size > 0));
  const answering = await laptop.transport();
  await waitFor('the other end to answer', () => answering.evaluate(() => peers.size > 0));

  const until = Date.now() + 8000;
  let n = 0;
  while (Date.now() < until) {
    assert.equal(await home.path(), 'relay');
    assert.equal(await laptop.path(), 'relay');
    assert.equal(await home.remote('send', laptopId, { n }), true);
    assert.equal(await laptop.remote('send', homeId, { n }), true);
    n += 1;
    await sleep(100);
  }
  await waitFor('frames both ways', async () => (await laptop.frameCount()) === n && (await home.frameCount()) === n);
  assert.deepEqual((await laptop.frames()).map((f) => f.n), Array.from({ length: n }, (_, i) => i));
  assert.deepEqual((await home.frames()).map((f) => f.n), Array.from({ length: n }, (_, i) => i));

  // Nothing of it went through the hidden window.
  const carried = await page.evaluate(() => frameLog.filter((e) => e.bytes).length);
  assert.equal(carried, 0);
  const state = await page.evaluate(() => [...peers.values()].map((p) => p.channel?.readyState));
  assert.ok(!state.includes('open'), `channel states: ${state}`);
});
