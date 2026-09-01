const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  proposalPrompt,
  failureMessage,
  DEFAULT_CLAIM_HEARTBEAT_MS,
  DEFAULT_CANONICAL_REPLAN_LIMIT,
  recoverableStopReason,
  shouldRetryCanonicalReplan,
} = require('./production-agent-worker.cjs');

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

test('canonical mutation races are safe worker stops, not failures', () => {
  assert.equal(
    recoverableStopReason(new Error('E_PRODUCTION_DEPENDENCY_CHANGED:asset:hero@1:asset:hero@2')),
    'canonical_state_changed'
  );
  assert.equal(
    recoverableStopReason(new Error('revision_conflict:cut:C01@3:cut:C01@4')),
    'canonical_state_changed'
  );
  assert.equal(
    recoverableStopReason(new Error('E_PRODUCTION_REVISION_SUPERSEDED')),
    'canonical_state_changed'
  );
  assert.equal(recoverableStopReason(new Error('idempotency_conflict')), null);
  assert.equal(recoverableStopReason(new Error('E_PRODUCTION_PAYLOAD_INVALID')), null);
});

test('canonical replanning is bounded to one consecutive retry by default', () => {
  assert.equal(DEFAULT_CANONICAL_REPLAN_LIMIT, 1);
  assert.equal(shouldRetryCanonicalReplan('canonical_state_changed', 0), true);
  assert.equal(shouldRetryCanonicalReplan('canonical_state_changed', 1), false);
  assert.equal(shouldRetryCanonicalReplan('canonical_state_changed', 0, 0), false);
  assert.equal(shouldRetryCanonicalReplan('claim_invalidated', 0, 1), false);
});

test('worker loop releases stale claim before replanning and resets after progress', () => {
  const source = fs.readFileSync(path.join(__dirname, 'production-agent-worker.cjs'), 'utf8');
  const catchStart = source.indexOf('const reason = recoverableStopReason(error);', source.indexOf('action: \'apply_worker_proposal\''));
  const replan = source.indexOf('shouldRetryCanonicalReplan(reason, worker.canonicalReplans, worker.maxCanonicalReplans)', catchStart);
  const release = source.lastIndexOf('await releaseClaim(bridge, basePayload, worker.currentClaim, reason);', replan);
  const increment = source.indexOf('worker.canonicalReplans += 1;', replan);
  const continueIndex = source.indexOf('continue;', increment);
  assert.ok(catchStart >= 0);
  assert.ok(release > catchStart && release < replan);
  assert.ok(increment > replan && continueIndex > increment);
  assert.match(source, /type: 'replanning'/);
  assert.match(source, /worker\.canonicalReplans = 0;/);
});

test('worker failures preserve diagnostics', () => {
  const message = failureMessage(2, 'bad schema', '', '');
  assert.match(message, /E_PRODUCTION_AGENT_CODEX_EXIT_2/);
  assert.match(message, /bad schema/);
});