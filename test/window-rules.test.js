const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { devToolsAllowed, applicationMenuTemplate } = require(path.join(__dirname, '..', 'lib', 'window-rules.js'));

const rolesIn = (items) => items.flatMap((item) => [String(item.role || '').toLowerCase(), ...rolesIn(item.submenu || [])]);

test('DevTools can only be opened in an unpackaged run', () => {
  assert.equal(devToolsAllowed(false), true);
  assert.equal(devToolsAllowed(true), false);
});

test('an unpackaged run keeps the default menu, DevTools and all', () => {
  assert.equal(applicationMenuTemplate(false, 'win32'), null);
  assert.equal(applicationMenuTemplate(false, 'darwin'), null);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`a packaged build's menu on ${platform} has no way to DevTools, and keeps everything else people use`, () => {
    const roles = rolesIn(applicationMenuTemplate(true, platform));
    assert.ok(!roles.includes('toggledevtools'));
    // Roles that hold it inside them.
    assert.ok(!roles.includes('viewmenu'));
    assert.ok(!roles.includes('help'));
    for (const role of ['editmenu', 'reload', 'zoomin', 'zoomout', 'resetzoom', 'togglefullscreen']) {
      assert.ok(roles.includes(role), role);
    }
    assert.equal(roles.includes('appmenu'), platform === 'darwin');
  });
}

test('every window main.js makes follows the rule, and the menu is applied', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const windows = main.split('new BrowserWindow(').length - 1;
  assert.ok(windows >= 2);
  assert.equal(main.split('devTools: devToolsAllowed(app.isPackaged)').length - 1, windows);
  assert.ok(main.includes('applicationMenuTemplate(app.isPackaged, process.platform)'));
});
