const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {proposalPrompt, failureMessage, DEFAULT_CLAIM_HEARTBEAT_MS, recoverableStopReason} = require('./production-agent-worker.cjs');

test('production worker prompt is read-only and approval-free', () => {
  const prompt = proposalPrompt({task_id:'task:1',suggested_tool:'save_production_object',stage:'storyboard'});
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /Automatic approval is forbidden/);
  assert.match(prompt, /needs_user_input/);
  assert.match(prompt, /save_production_object/);
  assert.doesNotMatch(prompt, /workspace-write/);
});

test('worker source invokes Codex in read-only sandbox and renews claims', () => {
  const source = fs.readFileSync(path.join(__dirname, 'production-agent-worker.cjs'), 'utf8');
  assert.match(source, /'--sandbox', 'read-only'/);
  assert.match(source, /apply_worker_proposal/);
  assert.match(source, /claim_work_order/);
  assert.match(source, /heartbeat_claim/);
  assert.match(source, /claim_heartbeat_failed/);
  assert.match(source, /currentChild\?\.kill\('SIGTERM'\)/);
  assert.match(source, /releaseClaim\(bridge, basePayload, worker\.currentClaim, 'claim_heartbeat_failed'\)/);
  assert.equal(DEFAULT_CLAIM_HEARTBEAT_MS, 30000);
  assert.doesNotMatch(source, /'--sandbox', 'workspace-write'/);
});

test('control and stale-claim races are safe worker stops', () => {
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_RUN_NOT_CLAIMABLE:PAUSED')), 'run_not_claimable');
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_RUN_NOT_EXECUTABLE')), 'run_not_executable');
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_TASK_CLAIM_INVALID')), 'claim_invalidated');
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_CLAIM_CHECKPOINT_CHANGED')), 'claim_invalidated');
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_TASK_CLAIM_RACE')), 'claim_invalidated');
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_AGENT_PROPOSAL_INVALID')), null);
});

test('worker failures preserve diagnostics', () => {
  const message = failureMessage(2, 'bad schema', '', '');
  assert.match(message, /E_PRODUCTION_AGENT_CODEX_EXIT_2/);
  assert.match(message, /bad schema/);
});
