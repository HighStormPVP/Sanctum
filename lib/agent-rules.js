// What an agent may do in each safety mode. Loaded by the renderer through a
// <script> tag and by test/agent-rules.test.js through require, so the rules can
// be tested without launching the app.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.AgentRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CHANGING_TOOLS = new Set([
    'write_file', 'apply_patch', 'run_command', 'run_command_async',
    'mcp_add_server', 'mcp_remove_server'
  ]);

  const isMcpTool = (name) => typeof name === 'string' && name.startsWith('mcp__');

  // An MCP tool can do anything (Blender runs arbitrary Python), and nothing in
  // its name says whether it changes things. So all of them count as changes.
  function alwaysNeedsApproval(name) {
    return CHANGING_TOOLS.has(name) || isMcpTool(name);
  }

  function blockedInPlanMode(name) {
    return alwaysNeedsApproval(name) || name === 'task_kill';
  }

  function blockedInReadOnly(name) {
    return alwaysNeedsApproval(name) || name === 'task_kill';
  }

  // A pre-approved command may only gain plain arguments. Anything a shell would
  // read as a second command, a redirect, or an expansion goes to the approval
  // pop-up, whatever it starts with.
  const SHELL_SYNTAX = /[;&|`$<>()\n\r%^]/;

  function commandIsPreapproved(command, allowlist) {
    const cmd = String(command ?? '').trim();
    if (!cmd || SHELL_SYNTAX.test(cmd) || !Array.isArray(allowlist)) return false;
    return allowlist.some((entry) => {
      const allowed = String(entry ?? '').trim();
      return !!allowed && (cmd === allowed || cmd.startsWith(allowed + ' '));
    });
  }

  // A model can name a tool it was never given. Local models do this often, and
  // the tool list is what Read-Only and plain chats rely on to limit it.
  function wasOffered(name, tools) {
    if (!name || !Array.isArray(tools)) return false;
    return tools.some((t) => (t?.function?.name || t?.name) === name);
  }

  return { alwaysNeedsApproval, blockedInPlanMode, blockedInReadOnly, commandIsPreapproved, wasOffered };
});
