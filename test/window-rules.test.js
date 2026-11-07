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

// ---- Debug switches in an installed app ----

const { DEBUG_SWITCHES, refusedDebugSwitch } = require(path.join(__dirname, '..', 'lib', 'window-rules.js'));
const EXE = 'C:\\Program Files\\Sanctum\\Sanctum.exe';
const packaged = (argv, platform = 'win32', hasSwitch) => refusedDebugSwitch({ isPackaged: true, argv: [EXE, ...argv], platform, hasSwitch });

test('the switches an installed app refuses are the ones that open it to a debugger', () => {
  assert.deepEqual([...DEBUG_SWITCHES].sort(), ['inspect', 'inspect-brk', 'inspect-port', 'js-flags', 'remote-debugging-pipe', 'remote-debugging-port']);
});

test('an installed app started normally, or with a file or a profile, goes ahead', () => {
  assert.equal(packaged([]), null);
  assert.equal(packaged(['--user-data-dir=C:\\temp\\x', 'C:\\notes\\inspect.txt']), null);
  assert.equal(packaged(['--enable-logging', '--lang=en-US']), null);
  // Near misses are other switches.
  assert.equal(packaged(['--inspector', '--inspect-publish-uid=http', '--remote-debugging-address=127.0.0.1', '--js-flagsx']), null);
  // A path that starts with a slash is a path on a Mac.
  assert.equal(packaged(['/inspect'], 'darwin'), null);
});

for (const name of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags']) {
  test(`an installed app refuses --${name}, however it's spelled`, () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.equal(packaged([`--${name}`], platform), name, `bare, on ${platform}`);
      assert.equal(packaged([`--${name}=0`], platform), name, `with a value, on ${platform}`);
      assert.equal(packaged([`-${name}=1`], platform), name, `one dash, on ${platform}`);
      assert.equal(packaged(['--user-data-dir=C:\\x', `--${name.toUpperCase()}=0`], platform), name, `in capitals, after another, on ${platform}`);
    }
    // Windows also takes a slash.
    assert.equal(packaged([`/${name}=0`], 'win32'), name);
  });
}

test('a switch the command line has, however it got there, is refused', () => {
  const seen = [];
  const hasSwitch = (name) => {
    seen.push(name);
    return name === 'remote-debugging-pipe';
  };
  assert.equal(packaged([], 'win32', hasSwitch), 'remote-debugging-pipe');
  assert.ok(seen.includes('remote-debugging-pipe'));
});

test('an unpackaged run keeps every debug switch, for development', () => {
  const argv = [EXE, '--remote-debugging-port=0', '--inspect', '--js-flags=--expose-gc'];
  assert.equal(refusedDebugSwitch({ isPackaged: false, argv, platform: 'win32', hasSwitch: () => true }), null);
  // Anything but a plain true is not packaged, as with devToolsAllowed.
  assert.equal(refusedDebugSwitch({ isPackaged: 'yes', argv, platform: 'win32' }), null);
  assert.equal(refusedDebugSwitch({ isPackaged: true, argv: 'nonsense', platform: 'win32' }), null);
});

test('main.js checks for them first, before the single-instance lock, any window, or the keystore', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const check = main.indexOf('refusedDebugSwitch({ isPackaged: app.isPackaged, argv: process.argv, platform: process.platform, hasSwitch: (name) => app.commandLine.hasSwitch(name) })');
  assert.ok(check > 0, 'the check is there, with the real command line');
  for (const later of ['requestSingleInstanceLock', 'new BrowserWindow(', 'createKeystore(', 'app.whenReady(', 'fixPackagedPath();']) {
    assert.ok(main.indexOf(later) > check, `${later} comes after it`);
  }
  const after = main.slice(check, check + 600);
  assert.match(after, /console\.error\(/, 'one line in the main log');
  assert.match(after, /app\.exit\(1\);\s*return;/, 'and it exits at once, running nothing more of main.js');
});

test('every packaged build switches off run-as-node, NODE_OPTIONS and inspect, before a Mac build is signed', () => {
  const { FuseVersion, FuseV1Options } = require('@electron/fuses');
  const afterPack = require(path.join(__dirname, '..', 'build', 'afterPack.js'));
  assert.deepEqual(afterPack.FUSES, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'afterPack.js'), 'utf8');
  const flip = source.indexOf('await flipFuses(');
  assert.ok(flip > 0 && flip < source.indexOf("!== 'darwin') return"), 'flipped on every platform, then only a Mac goes on');
  assert.ok(flip < source.indexOf('codesign --force'), 'and flipped before signing');
});

test('after flipping, afterPack reads the fuses back and stops the build if any of the three is still on', async () => {
  const { FuseV1Options } = require('@electron/fuses');
  const { FuseState } = require('@electron/fuses/dist/constants');
  const { fusesLeftOn } = require(path.join(__dirname, '..', 'build', 'afterPack.js'));
  const off = { version: '1', [FuseV1Options.RunAsNode]: FuseState.DISABLE, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE, [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE, [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.ENABLE };
  assert.deepEqual(fusesLeftOn(off), []);
  assert.deepEqual(fusesLeftOn({ ...off, [FuseV1Options.RunAsNode]: FuseState.ENABLE }), ['RunAsNode']);
  // Anything but off is on: a fuse the binary doesn't have, or one left to Electron's default.
  assert.deepEqual(fusesLeftOn({ ...off, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.INHERIT }), ['EnableNodeOptionsEnvironmentVariable']);
  assert.deepEqual(fusesLeftOn({ ...off, [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.REMOVED }), ['EnableNodeCliInspectArguments']);
  const { [FuseV1Options.RunAsNode]: _gone, ...missing } = off;
  assert.deepEqual(fusesLeftOn(missing), ['RunAsNode']);
  assert.deepEqual(fusesLeftOn(null), ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']);

  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'afterPack.js'), 'utf8');
  const flip = source.indexOf('await flipFuses(');
  const read = source.indexOf('await getCurrentFuseWire(');
  assert.ok(read > flip && flip > 0, 'read back after flipping');
  assert.ok(read < source.indexOf('codesign --force'), 'and before signing');
  const lineStart = source.lastIndexOf('\n', read);
  assert.match(source.slice(lineStart, read + 300), /fusesLeftOn\(await getCurrentFuseWire\(binary\)\);\s*if \(stillOn\.length\) throw new Error/, 'a fuse left on stops the build');
});

test("Sanctum's own page is granted writing to the clipboard, and nothing else is granted to anything", () => {
  const { permissionAllowed, APP_PAGE_PERMISSIONS } = require(path.join(__dirname, '..', 'lib', 'window-rules.js'));
  assert.deepEqual([...APP_PAGE_PERMISSIONS], ['clipboard-sanitized-write'], 'Copy on a code block, and that is all');
  assert.equal(permissionAllowed('clipboard-sanitized-write', true), true);
  // Not to a preview, or to any page but the app's own.
  assert.equal(permissionAllowed('clipboard-sanitized-write', false), false);
  for (const permission of ['media', 'clipboard-read', 'notifications', 'geolocation', 'fullscreen', 'openExternal', 'pointerLock', 'keyboardLock',
    'midi', 'midiSysex', 'display-capture', 'mediaKeySystem', 'idle-detection', 'window-management', 'fileSystem', 'hid', 'serial', 'usb', 'unknown', '', undefined, null, {}]) {
    assert.equal(permissionAllowed(permission, true), false, String(permission));
    assert.equal(permissionAllowed(permission, false), false, String(permission));
  }
  assert.equal(permissionAllowed('clipboard-sanitized-write', 'yes'), false, 'only a real true counts');
});

test('main.js puts a refusing handler on the hidden window\'s session, and the rule on the main one, before any window', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const guard = source.indexOf('function guardPermissions()');
  assert.ok(guard > 0);
  const body = source.slice(guard, source.indexOf('\n}\n', guard));
  assert.match(body, /fromPartition\(REMOTE_TRANSPORT_PARTITION\)/);
  assert.match(body, /setPermissionRequestHandler\(\(_w, _p, cb\) => cb\(false\)\)/);
  assert.match(body, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(body, /session\.defaultSession\.setPermissionRequestHandler\(/);
  assert.match(body, /session\.defaultSession\.setPermissionCheckHandler\(/);
  const ready = source.indexOf('app.whenReady().then(');
  const called = source.indexOf('guardPermissions();', ready);
  assert.ok(called > ready && called < source.indexOf('createWindow();', ready), 'called once ready, before the window');
});
