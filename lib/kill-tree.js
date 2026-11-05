// Stops a process and everything it started. On Windows, killing a shell-launched
// process only ends the shell, leaving dev servers and MCP servers running. On macOS and
// Linux the same goes for a signal to one pid, so a process that has to be stoppable with
// its children starts in a group of its own, through startInOwnGroup.
const { spawn } = require('child_process');

// Settles when the kill has finished, and never rejects, so anything can wait on it or not.
// On Windows that's when taskkill has exited. It has to be waited for on the way out: an app
// that quits straight after starting it leaves the process running.
function killTree(proc, { platform = process.platform, spawnImpl = spawn, killImpl = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (!proc || !proc.pid) return Promise.resolve();
  if (platform === 'win32') {
    return new Promise((resolve) => {
      const fallback = () => {
        try { proc.kill(); } catch {}
        resolve();
      };
      try {
        const killer = spawnImpl('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', fallback);
        killer.on('exit', () => resolve());
      } catch {
        fallback();
      }
    });
  }
  // A negative pid is the whole group. There's no group unless this process leads one, and then
  // the process itself is all that can be reached.
  try {
    killImpl(-proc.pid, 'SIGKILL');
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
  return Promise.resolve();
}

// A shell command that killTree can end along with what it starts. Windows has no use for a group,
// because taskkill follows the tree, and detached there would open a console of its own.
function startInOwnGroup(command, options, { platform = process.platform, spawnImpl = spawn } = {}) {
  return spawnImpl(command, [], { ...options, ...(platform === 'win32' ? {} : { detached: true }) });
}

const OUTPUT_KEPT = 20_000;

// What child_process.exec did for shell:run, which can't start a process in its own group: it
// doesn't pass `detached` on. So the same results by hand. Up to maxBuffer of each stream, past
// which the process is ended, and the first 20 KB of each come back. A process that couldn't start
// or was ended reads as exit code 1.
function runShellCommand({ command, cwd, shell, timeoutMs, maxBuffer = 4 * 1024 * 1024, env, onStart, spawnOptions = {} }) {
  return new Promise((resolve) => {
    const child = startInOwnGroup(command, { cwd, shell, windowsHide: true, ...(env ? { env } : {}) }, spawnOptions);
    const streams = { stdout: '', stderr: '' };
    let timedOut = false;
    let readsAsFailed = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: !readsAsFailed && typeof code === 'number' ? code : 1,
        stdout: streams.stdout.slice(0, OUTPUT_KEPT),
        stderr: streams.stderr.slice(0, OUTPUT_KEPT),
        timedOut
      });
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (text) => {
        if (streams[name].length >= maxBuffer) return;
        streams[name] += text;
        if (streams[name].length >= maxBuffer) {
          readsAsFailed = true;
          killTree(child);
        }
      });
    }
    child.on('error', () => {
      readsAsFailed = true;
      finish(null);
    });
    child.on('close', finish);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    onStart?.(child);
  });
}

module.exports = { killTree, startInOwnGroup, runShellCommand };
