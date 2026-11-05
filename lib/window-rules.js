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

module.exports = { devToolsAllowed, applicationMenuTemplate };
