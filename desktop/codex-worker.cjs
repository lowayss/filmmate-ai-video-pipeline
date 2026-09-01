const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  claimPromptJob,
  heartbeatPromptJob,
  submitPromptJob,
  failPromptJob,
  cancelPromptJob,
} = require('./prompt-job-client.cjs');

const activeWorkers = new Map();

function resourceFile(name) {
  const local = path.join(__dirname, name);
  if (fs.existsSync(local)) return local;
  return path.join(process.resourcesPath || '', name);
}

function codexExecutable() {
  const configured = process.env.FILMMATE_CODEX;
  if (configured && fs.existsSync(configured)) return configured;
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  if (fs.existsSync(bundled)) return bundled;
  return 'codex';
}

function codexPrompt({request, skillPolicy}) {
  const skillPath = String(skillPolicy?.path || skillPolicy?.entrypoint || process.env.CODEX_SEEDANCE_SKILL_PATH || path.join(os.homedir(), '.codex', 'skills', 'seedance-prompt-rules', 'SKILL.md'));
  return [
    'You are the FilmMate Seedance prompt compiler.',
    'This is a read-only compilation task. Do not edit, create, delete, or rename any project file.',
    `Before writing anything, read the complete skill file at ${skillPath}. Do not rely on a summary.`,
    'Apply that skill as the governing rule set, including the full Seedance 2.0/2.5 structure, reference roles, hard timeline, exact audio/text locks, FACS when applicable, and conditional live-action color rules.',
    'Preserve the supplied screenplay, storyboard, dialogue, protected strings, reference roles, and continuity. Never invent facts or silently rewrite supplied dialogue.',
    'Return exactly one JSON object matching the supplied JSON Schema. Do not wrap it in Markdown and do not add commentary.',
    'The object must contain schema_version=3, engine, prompt_ir, and prompt_variants with all three non-empty keys ko, en, zh.',
    'prompt_ir must be a complete structured representation of the request, including the exact input_mode. It must contain a contiguous hard timeline whose intervals each have exactly one central_action string and exactly one camera string, plus start_state and end_state. In text_to_video mode, references must be an empty array and no @Image, @Video, or @Audio tag may be invented. In reference_to_video mode, copy every required reference field exactly from the request and preserve the exact ordered tags.',
    'For workflow_mode=micro_shot, the request is a 4–15 second single-shot contract. Use the supplied micro_brief as the only story source. Required character and background references control identity and space. If a reference has source_kind=previs and role=motion, use it only for motion, blocking, camera, and timing; never inherit its placeholder person, wardrobe, background, or style. A media-aware tag may be @Video 1, @Image 1, or @Audio 1; copy the exact request tag into prompt_ir and all language variants. Do not add media fields that are not present in the JSON schema.',
    'Follow the output schema literally. Every timeline interval includes audio and performance; use null when either is not applicable. Every global_locks key must be present; use null only when the supplied canon has no applicable lock. model_profile.verified_max_duration_ms must copy the request value or be null.',
    'Include source_map, continuity locks, exact audio/text locks, negative constraints, and FACS only when observable performance direction is justified by the supplied canon.',
    'Each language variant must preserve the same cuts, timing, media-tag order, protected strings, central action, camera action, start/end states, and required Seedance section structure. The Korean variant is the canonical wording; English and Simplified Chinese are faithful production variants, not summaries.',
    'REQUEST_JSON_START',
    JSON.stringify(request, null, 2),
    'REQUEST_JSON_END',
  ].join('\n');
}

function parseOutput(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) throw new Error('E_CODEX_EMPTY_OUTPUT');
  try { return JSON.parse(raw); }
  catch { throw new Error(`E_CODEX_OUTPUT_JSON_INVALID:${raw.slice(0, 500)}`); }
}

function appendDiagnostic(previous, chunk, limit=6000) {
  return (String(previous || '') + String(chunk || '')).slice(-limit);
}

function codexFailureMessage(code, stderr, stdout, processError) {
  const diagnostic = String(processError || stderr || stdout || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-6000);
  const exit = code === null || code === undefined ? 'UNKNOWN' : String(code);
  return `E_CODEX_EXIT_${exit}${diagnostic ? `: ${diagnostic}` : ''}`;
}

function emit(onEvent, event) {
  if (typeof onEvent === 'function') {
    try { onEvent(event); } catch { /* UI callbacks must not stop the worker. */ }
  }
}

function startCodexPromptJob({projectDir, job, request, skillPolicy, onEvent}) {
  const jobId = String(job?.job_id || '');
  if (!jobId) throw new Error('E_PROMPT_JOB_ID_REQUIRED');
  if (activeWorkers.has(jobId)) return {started: true, already_running: true, job_id: jobId};

  let claimed = job;
  if (['QUEUED', 'REJECTED', 'FAILED'].includes(String(job.state))) {
    const result = claimPromptJob(projectDir, jobId, 'codex-worker');
    claimed = result.job || result;
  }
  if (!['CLAIMED', 'WRITING'].includes(String(claimed.state))) {
    throw new Error(`E_PROMPT_JOB_NOT_WRITABLE:${claimed.state}`);
  }
  const claimToken = String(claimed.claim_token || '');
  if (!claimToken) throw new Error('E_PROMPT_JOB_CLAIM_TOKEN_MISSING');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `FilmMate-prompt-${jobId}-`));
  const outputFile = path.join(workDir, 'bundle.json');
  const schemaFile = resourceFile('prompt-bundle.schema.json');
  if (!fs.existsSync(schemaFile)) throw new Error('E_CODEX_OUTPUT_SCHEMA_MISSING');
  const promptFile = path.join(workDir, 'request.txt');
  fs.writeFileSync(promptFile, codexPrompt({request, skillPolicy}), 'utf8');

  const args = [
    'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
    '-C', projectDir,
    '--output-schema', schemaFile,
    '--output-last-message', outputFile,
    '-',
  ];
  const child = childProcess.spawn(codexExecutable(), args, {
    cwd: projectDir,
    env: {...process.env, NO_COLOR: '1'},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const worker = {child, workDir, claimToken, jobId, projectDir, cancelled:false,stdout:'',stderr:'',processError:''};
  activeWorkers.set(jobId, worker);
  emit(onEvent, {type:'started', job_id:jobId});

  try { heartbeatPromptJob(projectDir, {job_id:jobId, claim_token:claimToken, actor:'codex-worker', state:'WRITING', detail:{engine:'Codex CLI'}}); }
  catch (error) { emit(onEvent, {type:'heartbeat_error', job_id:jobId, error:String(error.message || error)}); }
  const heartbeat = setInterval(() => {
    try { heartbeatPromptJob(projectDir, {job_id:jobId, claim_token:claimToken, actor:'codex-worker', state:'WRITING', detail:{heartbeat:true}}); }
    catch (error) { emit(onEvent, {type:'heartbeat_error', job_id:jobId, error:String(error.message || error)}); }
  }, 15000);
  child.stdout.on('data', chunk => {worker.stdout=appendDiagnostic(worker.stdout,chunk);emit(onEvent, {type:'stdout', job_id:jobId, text:String(chunk).slice(-2000)})});
  child.stderr.on('data', chunk => {worker.stderr=appendDiagnostic(worker.stderr,chunk);emit(onEvent, {type:'stderr', job_id:jobId, text:String(chunk).slice(-2000)})});
  child.on('error', error => {worker.processError=String(error.message || error);emit(onEvent, {type:'process_error', job_id:jobId, error:worker.processError})});
  child.on('close', code => {
    clearInterval(heartbeat);
    activeWorkers.delete(jobId);
    if (worker.cancelled) return;
    try {
      if (code !== 0) throw new Error(codexFailureMessage(code, worker.stderr, worker.stdout, worker.processError));
      const bundle = parseOutput(outputFile);
      const result = submitPromptJob(projectDir, {
        job_id:jobId,
        claim_token:claimToken,
        request_sha256:String(claimed.request_sha256 || ''),
        skill_bundle_sha256:String(request?.skill_provenance?.bundle_sha256 || skillPolicy?.bundle_sha256 || ''),
        prompt_ir:bundle.prompt_ir,
        prompt_variants:bundle.prompt_variants,
        engine:String(bundle.engine || 'Codex CLI'),
        actor:'codex-worker',
      });
      emit(onEvent, {type:'submitted', job_id:jobId, result});
    } catch (error) {
      const message = String(error?.message || error);
      try { failPromptJob(projectDir, jobId, message); } catch (failError) { emit(onEvent, {type:'fail_record_error', job_id:jobId, error:String(failError.message || failError)}); }
      emit(onEvent, {type:'failed', job_id:jobId, error:message});
    }
  });
  child.stdin.end(fs.readFileSync(promptFile, 'utf8'));
  return {started:true, job_id:jobId, state:String(claimed.state), claim_token:claimToken};
}

function cancelCodexPromptJob(projectDir, jobId) {
  const worker = activeWorkers.get(String(jobId));
  if (worker) {
    worker.cancelled = true;
    try { worker.child.kill('SIGTERM'); } catch { /* already exited */ }
    activeWorkers.delete(String(jobId));
  }
  return cancelPromptJob(projectDir, String(jobId));
}

function activeCodexPromptJobs() { return [...activeWorkers.keys()]; }

module.exports = {startCodexPromptJob, cancelCodexPromptJob, activeCodexPromptJobs, codexFailureMessage};
