// The Electron tests in e2e/ find Electron the way the electron package says to, on every platform.
// On a Mac the binary is inside Electron.app, so a path built by hand from dist/ finds nothing there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const E2E = path.join(__dirname, '..', 'e2e');

test("the harness launches the electron package's own binary, and it is there", () => {
  const { ELECTRON } = require('../e2e/harness.js');
  // Under plain Node, require('electron') is the binary's path for this platform.
  assert.equal(ELECTRON, require('electron'));
  assert.ok(fs.existsSync(ELECTRON), ELECTRON);
});

test('no e2e file builds its own path into dist/', () => {
  for (const file of fs.readdirSync(E2E).filter((name) => name.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(E2E, file), 'utf8');
    assert.doesNotMatch(text, /['"]dist['"]/, file);
  }
});
