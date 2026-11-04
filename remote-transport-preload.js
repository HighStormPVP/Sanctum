// The hidden transport window's only way out. It passes opaque commands and events, and gives
// the page no ipcRenderer, no channel names, and nothing else. See lib/remote/direct-path.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sanctumTransport', {
  onCommand: (handler) => {
    ipcRenderer.on('remote-transport:command', (_e, command) => handler(command));
  },
  emit: (event) => ipcRenderer.send('remote-transport:event', event)
});
