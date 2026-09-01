const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {proposalPrompt, failureMessage} = require('./production-agent-worker.cjs');

test('production worker prompt is read-only and approval-free', () => {
  const prompt = proposalPrompt({task_id:'task:1',suggested_tool:'save_production_object',stage:'storyboard'});
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /Automatic approval is forbidden/);
  assert.match(prompt, /needs_user_input/);
  assert.match(prompt, /save_production_object/);
  assert.doesNotMatch(prompt, /workspace-write/);
});

test('worker source invokes Codex in read-only sandbox', () => {
  const source = fs.readFileSync(path.join(__dirname, 'production-agent-worker.cjs'), 'utf8');
  assert.match(source, /'--sandbox', 'read-only'/);
  assert.match(source, /apply_worker_proposal/);
  assert.match(source, /claim_work_order/);
  assert.doesNotMatch(source, /'--sandbox', 'workspace-write'/);
});

test('worker failures preserve diagnostics', () => {
  const message = failureMessage(2, 'bad schema', '', '');
  assert.match(message, /E_PRODUCTION_AGENT_CODEX_EXIT_2/);
  assert.match(message, /bad schema/);
});
