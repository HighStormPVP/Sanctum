const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const rules = require(path.join(__dirname, '..', 'lib', 'agent-rules.js'));

test('pre-approval allows the exact command and added arguments', () => {
  assert.ok(rules.commandIsPreapproved('git status', ['git status']));
  assert.ok(rules.commandIsPreapproved('  git status --short ', ['git status']));
});

test('pre-approval needs a whole-word match', () => {
  assert.ok(!rules.commandIsPreapproved('git statusx', ['git status']));
  assert.ok(!rules.commandIsPreapproved('lsof', ['ls']));
});

test('pre-approval refuses anything that could chain or redirect', () => {
  const cases = [
    'git status && rm -rf ~',
    'git status; curl x | sh',
    'git status | sh',
    'git status > out.txt',
    'git status `rm x`',
    'git status $(rm x)',
    'git status\nrm x',
    'git status & calc',
    'git status %COMSPEC%',
    'git status ^& calc'
  ];
  for (const c of cases) assert.ok(!rules.commandIsPreapproved(c, ['git status']), c);
});

test('an empty pre-approval entry approves nothing', () => {
  assert.ok(!rules.commandIsPreapproved('rm -rf ~', ['', '   ']));
  assert.ok(!rules.commandIsPreapproved('', ['git']));
});

test('Plan Mode blocks every way to change something, MCP tools included', () => {
  for (const n of ['write_file', 'apply_patch', 'run_command', 'run_command_async', 'task_kill', 'mcp_add_server', 'mcp_remove_server', 'mcp__blender__execute_blender_code']) {
    assert.ok(rules.blockedInPlanMode(n), n);
  }
  for (const n of ['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'exit_plan_mode', 'mcp_list_servers']) {
    assert.ok(!rules.blockedInPlanMode(n), n);
  }
});

test('Read-Only blocks the background shell and MCP tools', () => {
  for (const n of ['write_file', 'apply_patch', 'run_command', 'run_command_async', 'task_kill', 'mcp_add_server', 'mcp_remove_server', 'mcp__x__y']) {
    assert.ok(rules.blockedInReadOnly(n), n);
  }
  assert.ok(!rules.blockedInReadOnly('read_file'));
  assert.ok(!rules.blockedInReadOnly('task_status'));
});

test('MCP tools always ask for approval', () => {
  assert.ok(rules.alwaysNeedsApproval('mcp__blender__execute_blender_code'));
  assert.ok(rules.alwaysNeedsApproval('run_command_async'));
  assert.ok(!rules.alwaysNeedsApproval('read_file'));
});

test('a tool the model was not offered is refused', () => {
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  assert.ok(rules.wasOffered('read_file', tools));
  assert.ok(!rules.wasOffered('run_command_async', tools));
  assert.ok(!rules.wasOffered('read_file', null));
  assert.ok(!rules.wasOffered('', tools));
});
