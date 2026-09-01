const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function inferMediaType(item, source) {
  const explicit = String(item?.mediaType || item?.media_type || '').toLowerCase();
  if (['image', 'video', 'audio'].includes(explicit)) return explicit;
  const extension = path.extname(source).toLowerCase();
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].includes(extension)) return 'video';
  if (['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) return 'audio';
  return 'image';
}

function mediaTag(mediaType, index, at = true) {
  const label = mediaType === 'video' ? 'Video' : mediaType === 'audio' ? 'Audio' : 'Image';
  return `${at ? '@' : ''}${label} ${index}`;
}

function pythonExecutable() {
  return process.env.FILMMATE_PYTHON || process.env.SCENEFLOW_PYTHON || '/opt/homebrew/bin/python3';
}

function runPromptJobs(projectDir, action, payload) {
  const workspaceScript = path.join(__dirname, '..', 'core', 'prompt_jobs.py');
  const bundledScript = path.join(process.resourcesPath || '', 'core', 'prompt_jobs.py');
  const script = fs.existsSync(workspaceScript) ? workspaceScript : bundledScript;
  if (!fs.existsSync(script)) throw new Error('E_PROMPT_JOB_SCRIPT_MISSING');
  const result = childProcess.spawnSync(
    pythonExecutable(),
    [script, action, projectDir],
    {input:JSON.stringify(payload || {}), encoding:'utf8', maxBuffer:32 * 1024 * 1024}
  );
  const raw = String(result.stdout || '').trim();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (error) { throw new Error(`E_PROMPT_JOB_RESPONSE_INVALID:${raw.slice(0, 500)}`); }
  if (result.status !== 0 || parsed.error) throw new Error(String(parsed.error || result.stderr || 'prompt_job_failed').trim());
  return parsed;
}

function safeRelative(projectDir, source) {
  const root = path.resolve(projectDir);
  const absolute = path.resolve(source);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`E_PROMPT_REFERENCE_OUTSIDE_PROJECT:${source}`);
  return relative.split(path.sep).join('/');
}

function referenceRecords(items, projectDir) {
  const counts = {image:0, video:0, audio:0};
  return (Array.isArray(items) ? items : []).map((item, index) => {
    const source = path.resolve(String(item?.absolutePath || ''));
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`E_PROMPT_REFERENCE_MISSING:${item?.name || index + 1}`);
    const role = String(item?.role || 'reference');
    const mediaType = inferMediaType(item, source);
    counts[mediaType] += 1;
    const tag = String(item?.tag || mediaTag(mediaType, counts[mediaType])).trim();
    return {
      order:index + 1,
      input_order:index + 1,
      tag,
      external_id:String(item?.externalId || item?.external_id || mediaTag(mediaType, counts[mediaType], false)),
      media_type:mediaType,
      role,
      name:String(item?.name || path.basename(source)),
      path:safeRelative(projectDir, source),
      sha256:fileSha256(source),
      source_revision:String(item?.revisionId || item?.sourceRevision || ''),
      source_kind:String(item?.sourceKind || item?.source_kind || (role === 'motion' ? 'previs' : 'asset')),
      use:String(item?.use || (role === 'storyboard' ? 'shot order, composition, and continuity only' : role === 'motion' ? 'motion, blocking, camera, and timing only' : `${role} identity and continuity only`)),
      exclude:String(item?.exclude || (role === 'storyboard' ? 'do not inherit its unrelated character or background details' : role === 'motion' ? 'do not inherit its placeholder identity, wardrobe, background, or visual style' : 'do not inherit unrelated pose, camera, or background details')),
      provenance:String(item?.provenance || 'FilmMate selected asset'),
    };
  });
}

function inputRevisionRecords(payload) {
  return (Array.isArray(payload?.inputRevisions) ? payload.inputRevisions : [])
    .map(item => ({revision_id:String(item?.revision_id || item?.revisionId || ''), role:String(item?.role || 'input')}))
    .filter(item => item.revision_id);
}

function normalizeRequest(payload, skillPolicy, projectDir) {
  const sourcePrompt = String(payload?.sourcePrompt || '');
  if (!sourcePrompt.trim()) throw new Error('E_PROMPT_SOURCE_REQUIRED');
  const references = referenceRecords(payload?.references || payload?.items || [], projectDir);
  const workflowMode = payload?.workflowMode === 'micro_shot' ? 'micro_shot' : 'scene_block';
  const inputMode = String(payload?.inputMode || (references.length ? 'reference_to_video' : 'text_to_video'));
  const unitType = payload?.unitType === 'block' ? 'block' : 'shot';
  const model = String(payload?.model || 'Seedance 2.0');
  const targetId = String(payload?.targetId || '');
  const durationMs = Math.max(1, Math.round(Number(payload?.durationSec || (unitType === 'block' ? (model === 'Seedance 2.5' ? 30 : 15) : 5)) * 1000));
  const cutIds = (Array.isArray(payload?.shotIds) ? payload.shotIds : Array.isArray(payload?.cutIds) ? payload.cutIds : []).map(String);
  const request = {
    schema_version:3,
    project:String(payload?.project || ''),
    scene:String(payload?.scene || ''),
    model,
    workflow_mode:workflowMode,
    unit_type:unitType,
    input_mode:inputMode,
    target_id:targetId,
    duration_ms:durationMs,
    micro_brief:String(payload?.microBrief || payload?.micro_brief || ''),
    reference_order_policy:'global_input_order_with_media_tags',
    cut_ids:cutIds,
    source_prompt:sourcePrompt,
    source_prompt_sha256:sha256(Buffer.from(sourcePrompt,'utf8')),
    protected_strings:Array.isArray(payload?.protectedStrings) ? payload.protectedStrings.map(String).filter(Boolean) : [],
    references,
    required_reference_roles:inputMode === 'reference_to_video' && Array.isArray(payload?.requiredReferenceRoles) ? payload.requiredReferenceRoles.map(String) : [],
    input_revisions:inputRevisionRecords(payload),
    source_evidence:Array.isArray(payload?.sourceEvidence) ? payload.sourceEvidence : [],
    model_profile:{name:model, scope:unitType, duration_ms:durationMs, ui_profile:'FilmMate 0.7.2', verified_max_duration_ms:null},
    skill_provenance:{
      name:'seedance-prompt-rules',
      entrypoint:String(skillPolicy?.path || ''),
      bundle_sha256:String(skillPolicy?.bundle_sha256 || ''),
      status:'PASS',
    },
    delivery_contract:`Codex must submit schema-valid prompt_ir and ko, en, zh together for this exact HAP ${inputMode} request.`,
  };
  if (payload?.expectedRevisionId) request.expected_revision_id=String(payload.expectedRevisionId);
  return request;
}

function enqueuePromptJob(projectDir, payload, skillPolicy) {
  const request = normalizeRequest(payload, skillPolicy, projectDir);
  return runPromptJobs(projectDir, 'enqueue', {request, actor:'filmmate-user'});
}

function latestPromptJob(projectDir, context) { return runPromptJobs(projectDir, 'latest', context); }
function getPromptJob(projectDir, jobId) { return runPromptJobs(projectDir, 'get', {job_id:jobId}); }
function claimPromptJob(projectDir, jobId, actor='codex-worker') { return runPromptJobs(projectDir, 'claim', {job_id:jobId, actor}); }
function heartbeatPromptJob(projectDir, payload) { return runPromptJobs(projectDir, 'heartbeat', payload); }
function submitPromptJob(projectDir, payload) { return runPromptJobs(projectDir, 'submit', payload); }
function failPromptJob(projectDir, jobId, error) { return runPromptJobs(projectDir, 'fail', {job_id:jobId, error, actor:'codex-worker'}); }
function cancelPromptJob(projectDir, jobId) { return runPromptJobs(projectDir, 'cancel', {job_id:jobId, actor:'filmmate-user'}); }
function approvePromptJob(projectDir, jobId, evidence) { return runPromptJobs(projectDir, 'approve', {job_id:jobId, approver:'user', evidence}); }
function promptHistory(projectDir, scene) { return runPromptJobs(projectDir, 'history', {scene, limit:100}); }

module.exports = {
  normalizeRequest,
  runPromptJobs,
  enqueuePromptJob,
  latestPromptJob,
  getPromptJob,
  claimPromptJob,
  heartbeatPromptJob,
  submitPromptJob,
  failPromptJob,
  cancelPromptJob,
  approvePromptJob,
  promptHistory,
};
