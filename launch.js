// Launcher that clears ELECTRON_RUN_AS_NODE before spawning the Electron app.
// Some systems set this env var globally, which makes Electron run as plain Node
// and breaks `require('electron')` in the main process.
const { spawn } = require('child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: __dirname,
  windowsHide: false
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('Failed to launch Electron:', err);
  process.exit(1);
});
