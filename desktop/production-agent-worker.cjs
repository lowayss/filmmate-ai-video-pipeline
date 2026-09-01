const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const activeWorkers = new Map();
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_CLAIM_HEARTBEAT_MS = 30000;

function resourceFile(name) {
  const local = path.join(__dirname, name);
  if (fs.existsSync(local)) return local;
  const bundled = path.join(process.resourcesPath || '', name);
  if (fs.existsSync(bundled)) return bundled;
  throw new Error(`E_PRODUCTION_AGENT_RESOURCE_MISSING:${name}`);
}

function codexExecutable() {
  const configured = process.env.FILMMATE_CODEX;
  if (configured && fs.existsSync(configured)) return configured;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (fs.existsSync(bundled)) return bundled;
  return 'codex';
}

function emit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try { onEvent(event); } catch { /* UI observers cannot stop the worker. */ }
}

function appendDiagnostic(previous, chunk, limit = 6000) {
  return (String(previous || '') + String(chunk || '')).slice(-limit);
}

function failureMessage(code, stderr, stdout, processError) {
  const diagnostic = String(processError || stderr || stdout || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-6000);
  const exit = code === null || code === undefined ? 'UNKNOWN' : String(code);
  return `E_PRODUCTION_AGENT_CODEX_EXIT_${exit}${diagnostic ? `: ${diagnostic}` : ''}`;
}

function proposalPrompt(workOrder) {
  return [
    'You are the FilmMate Production Agent execution worker.',
    'Your project access is READ-ONLY. Never edit, create, delete, rename, or approve any project file or canonical object yourself.',
    'You only prepare one semantic action proposal. FilmMate validates the claim token, canonical checkpoint, allowlist, dependencies, optimistic revision, and then performs the write.',
    'Automatic approval is forbidden. Do not propose approve_production_object, approve_hap_revision, delegated grants, approval IDs, low-level HAP revision writes, or artifact registration.',
    'Use exactly work_order.suggested_tool. If the task requires an image, video, audio, external generation, missing creative decision, prompt-target selection, or any information not grounded in the canonical context, return decision="needs_user_input", tool=null, args={}, and explain why.',
    'For save_filmmate_document, only propose {"kind":"conti","content":"..."}. Do not rewrite the screenplay. Preserve exact supplied dialogue and canon.',
    'For save_production_object, propose only {object_type,key,stage,payload}. FilmMate will replace identity, expected revision, dependencies, evidence, actor, and idempotency fields with canonical values.',
    'Do not claim an artifact exists unless it is present in the supplied canonical context. Structured metadata is allowed only when it is a legitimate production object by itself.',
    'Return exactly one JSON object matching the provided schema. No Markdown or commentary.',
    'WORK_ORDER_JSON_START',
    JSON.stringify(workOrder, null, 2),
    'WORK_ORDER_JSON_END',
  ].join('\n');
}

function parseProposal(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) throw new Error('E_PRODUCTION_AGENT_CODEX_EMPTY_OUTPUT');
  try { return JSON.parse(raw); }
  catch { throw new Error(`E_PRODUCTION_AGENT_CODEX_JSON_INVALID:${raw.slice(0, 500)}`); }
}

function runCodexProposal({projectDir, workOrder, worker, spawn = childProcess.spawn, onEvent}) {
  return new Promise((resolve, reject) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `FilmMate-agent-${workOrder.task_id}-`));
    const outputFile = path.join(workDir, 'proposal.json');
    const schemaFile = resourceFile('production-agent-action.schema.json');
    const prompt = proposalPrompt(workOrder);
    const args = [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
      '-C', projectDir,
      '--output-schema', schemaFile,
      '--output-last-message', outputFile,
      '-',
    ];
    const child = spawn(codexExecutable(), args, {
      cwd: projectDir,
      env: {...process.env, NO_COLOR: '1'},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    worker.currentChild = child;
    worker.currentWorkDir = workDir;
    let stdout = '';
    let stderr = '';
    let processError = '';
    child.stdout?.on('data', chunk => { stdout = appendDiagnostic(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendDiagnostic(stderr, chunk); });
    child.once('error', error => { processError = String(error?.message || error); });
    child.once('close', code => {
      worker.currentChild = null;
      try {
        if (worker.cancelled) {
          reject(new Error('E_PRODUCTION_AGENT_WORKER_CANCELLED'));
          return;
        }
        if (code !== 0) throw new Error(failureMessage(code, stderr, stdout, processError));
        const proposal = parseProposal(outputFile);
        emit(onEvent, {type: 'proposal_ready', run_id: worker.runId, task_id: workOrder.task_id, decision: proposal?.decision});
        resolve(proposal);
      } catch (error) {
        reject(error);
      } finally {
        try { fs.rmSync(workDir, {recursive: true, force: true}); } catch { /* best effort */ }
      }
    });
    child.stdin?.end(prompt);
  });
}

async function failClaim(bridge, basePayload, claim, error) {
  if (!claim?.task_id || !claim?.claim_token) return;
  try {
    await bridge.runProductionAgentAsync({
      ...basePayload,
      action: 'control_run',
      run_id: claim.run_id,
      control: 'fail_task',
      task_id: claim.task_id,
      claim_token: claim.claim_token,
      actor: 'codex-worker',
      error: String(error?.message || error),
    });
  } catch { /* Preserve the original worker error. */ }
}

async function releaseClaim(bridge, basePayload, claim, reason) {
  if (!claim?.task_id || !claim?.claim_token) return;
  try {
    await bridge.runProductionAgentAsync({
      ...basePayload,
      action: 'control_run',
      run_id: claim.run_id,
      control: 'release_task',
      task_id: claim.task_id,
      claim_token: claim.claim_token,
      actor: 'codex-worker',
      error: reason,
    });
  } catch { /* Best-effort release. */ }
}

function startClaimHeartbeat(worker, claim) {
  worker.heartbeatError = null;
  const tick = async () => {
    if (worker.cancelled || !worker.currentClaim || worker.heartbeatInFlight) return;
    worker.heartbeatInFlight = true;
    try {
      await worker.bridge.runProductionAgentAsync({
        ...worker.basePayload,
        action: 'heartbeat_claim',
        run_id: claim.run_id,
        task_id: claim.task_id,
        claim_token: claim.claim_token,
        actor: 'codex-worker',
      });
      emit(worker.onEvent, {type: 'claim_heartbeat', run_id: claim.run_id, task_id: claim.task_id});
    } catch (error) {
      worker.heartbeatError = error;
      try { worker.currentChild?.kill('SIGTERM'); } catch { /* child already exited */ }
      emit(worker.onEvent, {type: 'claim_heartbeat_failed', run_id: claim.run_id, task_id: claim.task_id, error: String(error?.message || error)});
    } finally {
      worker.heartbeatInFlight = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, worker.heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function workerLoop(worker) {
  const {bridge, basePayload, projectDir, onEvent, spawn} = worker;
  try {
    for (let step = 0; step < worker.maxSteps && !worker.cancelled; step += 1) {
      const claimed = await bridge.runProductionAgentAsync({
        ...basePayload,
        action: 'claim_work_order',
        run_id: worker.runId,
        actor: 'codex-worker',
      });
      if (!claimed?.claimed) {
        emit(onEvent, {
          type: 'stopped',
          run_id: worker.runId,
          reason: claimed?.work_order?.manual_reason || claimed?.run?.state || 'no_automatic_work',
          run: claimed?.run || null,
          work_order: claimed?.work_order || null,
        });
        return;
      }
      const workOrder = claimed.work_order;
      worker.currentClaim = {
        run_id: worker.runId,
        task_id: workOrder.task_id,
        claim_token: workOrder.claim_token,
      };
      emit(onEvent, {type: 'claimed', run_id: worker.runId, task_id: workOrder.task_id, stage: workOrder.stage, tool: workOrder.suggested_tool});
      const stopHeartbeat = startClaimHeartbeat(worker, worker.currentClaim);
      let proposal;
      try {
        proposal = await runCodexProposal({projectDir, workOrder, worker, spawn, onEvent});
        if (worker.heartbeatError) throw worker.heartbeatError;
      } catch (error) {
        if (worker.cancelled) {
          await releaseClaim(bridge, basePayload, worker.currentClaim, 'worker_cancelled');
          return;
        }
        if (worker.heartbeatError) {
          await releaseClaim(bridge, basePayload, worker.currentClaim, 'claim_heartbeat_failed');
          worker.currentClaim = null;
          emit(onEvent, {type: 'stopped', run_id: worker.runId, reason: 'claim_heartbeat_failed', error: String(worker.heartbeatError?.message || worker.heartbeatError)});
          return;
        }
        await failClaim(bridge, basePayload, worker.currentClaim, error);
        emit(onEvent, {type: 'failed', run_id: worker.runId, task_id: workOrder.task_id, error: String(error?.message || error)});
        return;
      } finally {
        stopHeartbeat();
      }
      if (worker.cancelled) {
        await releaseClaim(bridge, basePayload, worker.currentClaim, 'worker_cancelled');
        return;
      }
      try {
        const applied = await bridge.runProductionAgentAsync({
          ...basePayload,
          action: 'apply_worker_proposal',
          run_id: worker.runId,
          task_id: workOrder.task_id,
          claim_token: workOrder.claim_token,
          proposal,
          actor: 'codex-worker',
        });
        worker.currentClaim = null;
        emit(onEvent, {type: 'applied', run_id: worker.runId, task_id: workOrder.task_id, applied});
        if (applied?.stop_reason === 'needs_user_input') {
          emit(onEvent, {type: 'stopped', run_id: worker.runId, reason: 'needs_user_input', run: applied.run || null});
          return;
        }
        const state = applied?.run?.state;
        if (state === 'COMPLETE') {
          emit(onEvent, {type: 'completed', run_id: worker.runId, run: applied.run});
          return;
        }
        if (state !== 'READY') {
          emit(onEvent, {type: 'stopped', run_id: worker.runId, reason: state || applied?.stop_reason || 'waiting', run: applied?.run || null});
          return;
        }
        if (!applied?.progress_made && !applied?.resolved) {
          emit(onEvent, {type: 'stopped', run_id: worker.runId, reason: applied?.stop_reason || 'canonical_state_unchanged', run: applied?.run || null});
          return;
        }
      } catch (error) {
        await failClaim(bridge, basePayload, worker.currentClaim, error);
        worker.currentClaim = null;
        emit(onEvent, {type: 'failed', run_id: worker.runId, task_id: workOrder.task_id, error: String(error?.message || error)});
        return;
      }
    }
    if (!worker.cancelled) emit(onEvent, {type: 'stopped', run_id: worker.runId, reason: 'max_steps_reached'});
  } finally {
    activeWorkers.delete(worker.runId);
  }
}

function startProductionAgentWorker({projectDir, bridge, basePayload, runId, onEvent, maxSteps = DEFAULT_MAX_STEPS, heartbeatMs = DEFAULT_CLAIM_HEARTBEAT_MS, spawn = childProcess.spawn}) {
  const id = String(runId || '');
  if (!id) throw new Error('E_PRODUCTION_AGENT_RUN_ID_REQUIRED');
  if (!bridge || typeof bridge.runProductionAgentAsync !== 'function') throw new Error('E_PRODUCTION_AGENT_BRIDGE_REQUIRED');
  if (activeWorkers.has(id)) return {started: true, already_running: true, run_id: id};
  const worker = {
    runId: id,
    projectDir: path.resolve(projectDir),
    bridge,
    basePayload: {...basePayload},
    onEvent,
    maxSteps: Math.max(1, Math.min(50, Number(maxSteps) || DEFAULT_MAX_STEPS)),
    heartbeatMs: Math.max(1000, Number(heartbeatMs) || DEFAULT_CLAIM_HEARTBEAT_MS),
    spawn,
    cancelled: false,
    currentChild: null,
    currentClaim: null,
    heartbeatError: null,
    heartbeatInFlight: false,
  };
  activeWorkers.set(id, worker);
  emit(onEvent, {type: 'started', run_id: id});
  Promise.resolve().then(() => workerLoop(worker)).catch(error => {
    activeWorkers.delete(id);
    emit(onEvent, {type: 'failed', run_id: id, error: String(error?.message || error)});
  });
  return {started: true, already_running: false, run_id: id};
}

async function cancelProductionAgentWorker(runId) {
  const id = String(runId || '');
  const worker = activeWorkers.get(id);
  if (!worker) return {cancelled: false, run_id: id, active: false};
  worker.cancelled = true;
  try { worker.currentChild?.kill('SIGTERM'); } catch { /* already exited */ }
  await releaseClaim(worker.bridge, worker.basePayload, worker.currentClaim, 'worker_cancelled');
  worker.currentClaim = null;
  activeWorkers.delete(id);
  emit(worker.onEvent, {type: 'cancelled', run_id: id});
  return {cancelled: true, run_id: id, active: false};
}

function activeProductionAgentWorkers() {
  return [...activeWorkers.keys()];
}

module.exports = {
  DEFAULT_MAX_STEPS,
  DEFAULT_CLAIM_HEARTBEAT_MS,
  startProductionAgentWorker,
  cancelProductionAgentWorker,
  activeProductionAgentWorkers,
  proposalPrompt,
  failureMessage,
};
