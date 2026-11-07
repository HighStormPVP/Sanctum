// What a window may offer, by how the app is running. Loaded by main.js, and by
// test/window-rules.test.js, which can't run a packaged build but can hold this to its word.
//
// DevTools in a running window reaches window.api and everything the page holds, so at a locked
// laptop it would get around the lock. A packaged build has no way to open them. npm start still
// does, for debugging.
function devToolsAllowed(isPackaged) {
  return isPackaged !== true;
}

// Null means leave Electron's default menu alone. The default's View menu has the DevTools entry
// and its shortcut, and the viewMenu role brings them along, so a packaged build spells out what
// it keeps. The edit roles are what make copy and paste work on a Mac.
function applicationMenuTemplate(isPackaged, platform) {
  if (devToolsAllowed(isPackaged)) return null;
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
}

// Switches that hand a debugger the running app, and with it everything DevTools would reach. The
// fuses set in build/afterPack.js already stop Node's inspect switches and run-as-node in a packaged
// build. Chromium's remote debugging has no fuse, so an installed Sanctum started with any of these
// doesn't start at all. An unpackaged run keeps them, for debugging.
const DEBUG_SWITCHES = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags']);

// Chromium reads "--name", "-name", and on Windows "/name", with any "=value" after, and on Windows
// in any case. Every case is refused everywhere, since refusing a few spellings Chromium would ignore
// costs nothing. A slash is only a switch on Windows: on a Mac it starts a path. hasSwitch is
// app.commandLine.hasSwitch, for whatever Chromium itself took as a switch.
function switchName(arg, platform) {
  if (typeof arg !== 'string') return null;
  const prefix = ['--', '-', ...(platform === 'win32' ? ['/'] : [])].find((p) => arg.startsWith(p));
  if (!prefix) return null;
  return arg.slice(prefix.length).split('=')[0].toLowerCase();
}

// The switch that stops this start, or null to go ahead.
function refusedDebugSwitch({ isPackaged, argv, platform, hasSwitch = () => false }) {
  if (isPackaged !== true || !Array.isArray(argv)) return null;
  const given = new Set(argv.slice(1).map((arg) => switchName(arg, platform)));
  return DEBUG_SWITCHES.find((name) => given.has(name) || hasSwitch(name) === true) ?? null;
}

// Web permissions, which Electron grants to every page unless told otherwise. Sanctum's own page uses
// one: writing to the clipboard, for Copy on a code block. Pasting reads the paste event, which asks for
// nothing. There's no microphone: voice input isn't recorded in the page, and Whisper only transcribes a
// video's audio, in the main process. So nothing else is granted, and nothing at all to a preview or to
// any other page. The hidden transport window's session refuses everything without asking this.
const APP_PAGE_PERMISSIONS = Object.freeze(['clipboard-sanitized-write']);

function permissionAllowed(permission, fromAppPage) {
  return fromAppPage === true && APP_PAGE_PERMISSIONS.includes(permission);
}

module.exports = { devToolsAllowed, applicationMenuTemplate, DEBUG_SWITCHES, refusedDebugSwitch, APP_PAGE_PERMISSIONS, permissionAllowed };
