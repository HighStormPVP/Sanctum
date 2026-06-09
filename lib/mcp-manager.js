// Owns the set of MCP servers configured in this Sanctum install. Loads/
// saves a Claude-Desktop-compatible mcp_config.json under userData, spawns
// each server's stdio process via McpClient, and surfaces an aggregated
// tool list that the agentic chat path can expose to Ollama.

const fs = require('fs');
const path = require('path');
const { McpClient } = require('./mcp-client');

const TOOL_PREFIX = 'mcp__';

function safeName(s) {
  // Ollama tool names are alphanumeric + underscore. Strip the rest so
  // server / tool names with hyphens or @scopes still produce valid IDs.
  return String(s).replace(/[^a-zA-Z0-9_]/g, '_');
}

class McpManager {
  constructor({ configPath, onUpdate }) {
    this.configPath = configPath;
    this.onUpdate = onUpdate || (() => {});
    this.clients = new Map();
    this.config = { mcpServers: {} };
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        this.config = parsed && typeof parsed === 'object' ? parsed : { mcpServers: {} };
      }
    } catch (e) {
      console.error('[mcp] config load failed:', e.message);
      this.config = { mcpServers: {} };
    }
    if (!this.config.mcpServers || typeof this.config.mcpServers !== 'object') {
      this.config.mcpServers = {};
    }
  }

  saveConfig() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error('[mcp] config save failed:', e.message);
    }
  }

  async startAll() {
    const entries = Object.entries(this.config.mcpServers || {});
    await Promise.all(entries.map(([name, cfg]) =>
      this._spawn(name, cfg).catch(e => console.error(`[mcp] start ${name}:`, e.message))
    ));
  }

  async stopAll() {
    await Promise.all([...this.clients.values()].map(c => c.stop().catch(() => {})));
    this.clients.clear();
    this.onUpdate();
  }

  async _spawn(name, cfg) {
    if (this.clients.has(name)) {
      try { await this.clients.get(name).stop(); } catch {}
      this.clients.delete(name);
    }
    if (cfg.disabled) { this.onUpdate(); return; }
    const client = new McpClient({
      name,
      command: cfg.command,
      args: cfg.args || [],
      env: cfg.env || {}
    });
    client.on('status', () => this.onUpdate());
    client.on('tools', () => this.onUpdate());
    this.clients.set(name, client);
    try { await client.start(); }
    catch { /* error already recorded on the client */ }
    this.onUpdate();
  }

  async addServer(name, cfg) {
    if (!name || !cfg?.command) throw new Error('name and command required');
    this.config.mcpServers[name] = {
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
      disabled: !!cfg.disabled
    };
    this.saveConfig();
    await this._spawn(name, this.config.mcpServers[name]);
  }

  async removeServer(name) {
    const c = this.clients.get(name);
    if (c) { try { await c.stop(); } catch {} this.clients.delete(name); }
    delete this.config.mcpServers[name];
    this.saveConfig();
    this.onUpdate();
  }

  async restartServer(name) {
    const cfg = this.config.mcpServers[name];
    if (!cfg) throw new Error(`no such server: ${name}`);
    await this._spawn(name, cfg);
  }

  listServers() {
    return Object.entries(this.config.mcpServers).map(([name, cfg]) => {
      const c = this.clients.get(name);
      return {
        name,
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
        disabled: !!cfg.disabled,
        status: c ? c.status : 'stopped',
        error: c ? c.error : null,
        tools: c?.tools?.map(t => ({ name: t.name, description: t.description })) || []
      };
    });
  }

  // Aggregated tool list shaped for Ollama's tool-calling API. Names are
  // prefixed with mcp__<server>__ so the renderer can route tool_calls back
  // to the right MCP client without ambiguity.
  getOllamaTools() {
    const out = [];
    for (const [name, client] of this.clients) {
      if (client.status !== 'ready') continue;
      const safeServer = safeName(name);
      for (const t of client.tools) {
        const safeTool = safeName(t.name);
        out.push({
          type: 'function',
          function: {
            name: `${TOOL_PREFIX}${safeServer}__${safeTool}`,
            description: `[${name}] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: 'object', properties: {} }
          }
        });
      }
    }
    return out;
  }

  // Resolve a tool name like 'mcp__blender__execute_blender_code' back to
  // (server, originalToolName) and call it. Since we sanitize names with
  // safeName(), match by safeName equivalence rather than literal string.
  async callTool(prefixedName, args) {
    if (!prefixedName?.startsWith(TOOL_PREFIX)) throw new Error('not an MCP tool');
    const rest = prefixedName.slice(TOOL_PREFIX.length);
    const sepIdx = rest.indexOf('__');
    if (sepIdx < 0) throw new Error('malformed MCP tool name');
    const safeServer = rest.slice(0, sepIdx);
    const safeTool = rest.slice(sepIdx + 2);

    let client = null;
    for (const [name, c] of this.clients) {
      if (safeName(name) === safeServer) { client = c; break; }
    }
    if (!client) throw new Error(`MCP server not found for tool ${prefixedName}`);
    const realTool = (client.tools.find(t => safeName(t.name) === safeTool) || {}).name;
    if (!realTool) throw new Error(`tool not found on server: ${prefixedName}`);
    return client.callTool(realTool, args || {});
  }
}

module.exports = { McpManager, TOOL_PREFIX };
