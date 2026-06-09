// Minimal MCP client over stdio. Speaks newline-delimited JSON-RPC 2.0
// per the Model Context Protocol spec. Just enough for: initialize →
// list tools → call tool. Notifications and resources are out of scope.

const { spawn } = require('child_process');
const EventEmitter = require('events');

const REQUEST_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2024-11-05';

class McpClient extends EventEmitter {
  constructor({ name, command, args = [], env = {} }) {
    super();
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.status = 'stopped';
    this.error = null;
    this.serverInfo = null;
    this._buf = '';
    this._stderrBuf = '';
  }

  async start() {
    if (this.proc) await this.stop();
    this._setStatus('starting');
    this.error = null;
    this._stderrBuf = '';

    // npx/uvx/etc. on Windows resolve to .cmd files which child_process.spawn
    // can't launch without a shell. shell:true is also the path most-of-least
    // resistance for users copy-pasting Claude-Desktop-style configs.
    const useShell = process.platform === 'win32';

    try {
      this.proc = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true
      });
    } catch (err) {
      this._fail(`spawn failed: ${err.message}`);
      throw err;
    }

    this.proc.on('error', (err) => this._fail(`process error: ${err.message}`));
    this.proc.on('exit', (code, signal) => {
      const tail = this._stderrBuf.trim().slice(-300);
      this._fail(`server exited (code=${code} signal=${signal})${tail ? ` — ${tail}` : ''}`);
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => {
      const t = chunk.toString();
      this._stderrBuf += t;
      if (this._stderrBuf.length > 4000) this._stderrBuf = this._stderrBuf.slice(-4000);
      this.emit('stderr', t);
    });

    try {
      const initResult = await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'Sanctum', version: '0.2.0' }
      });
      this.serverInfo = initResult?.serverInfo || null;
      this._notify('notifications/initialized', {});
      const toolsResult = await this._request('tools/list', {});
      this.tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      this._setStatus('ready');
      this.emit('tools', this.tools);
    } catch (err) {
      this._fail(`init failed: ${err.message}`);
      throw err;
    }
  }

  async stop() {
    this._rejectAll(new Error('client stopped'));
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
    this.proc = null;
    this.tools = [];
    this._setStatus('stopped');
  }

  async callTool(name, args) {
    if (this.status !== 'ready') throw new Error(`server ${this.name} not ready (status=${this.status})`);
    return this._request('tools/call', { name, arguments: args || {} });
  }

  _onStdout(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.code ?? '?'}: ${msg.error.message ?? 'unknown error'}`));
      else pending.resolve(msg.result);
    }
  }

  _request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); }
      });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  _notify(method, params) {
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {}
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  _fail(msg) {
    this.error = msg;
    this._setStatus('error');
    this._rejectAll(new Error(msg));
  }

  _rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

module.exports = { McpClient };
