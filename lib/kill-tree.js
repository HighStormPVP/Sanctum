// Stops a process and everything it started. On Windows, killing a shell-launched
// process only ends the shell, leaving dev servers and MCP servers running.
const { spawn } = require('child_process');

function killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { proc.kill(); } catch {} });
    } catch { try { proc.kill(); } catch {} }
    return;
  }
  try { proc.kill('SIGKILL'); } catch {}
}

module.exports = { killTree };
