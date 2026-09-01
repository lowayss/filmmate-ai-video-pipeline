const READY_STATES = new Set(["accepted", "verified", "ready"]);
const ACTIVE_PROMPT_JOB_STATES = new Set(["QUEUED", "CLAIMED", "WRITING", "VALIDATING"]);

const STAGES = [
  { key: "analysis", label: "Scene Analysis", entityTypes: ["scene"], required: true },
  { key: "conti", label: "Written Conti", entityTypes: ["beat", "block"], required: true },
  { key: "assets", label: "References", entityTypes: ["asset"], required: true },
  { key: "storyboard", label: "Storyboard / Shots", entityTypes: ["cut"], required: true },
  { key: "prompts", label: "Video Prompts", entityTypes: ["prompt"], required: true },
  { key: "handoff", label: "Handoff Package", entityTypes: ["package"], required: false },
];

const STAGE_ALIASES = {
  analysis: "analysis",
  scene_analysis: "analysis",
  conti: "conti",
  text_conti: "conti",
  written_conti: "conti",
  assets: "assets",
  asset: "assets",
  references: "assets",
  storyboard: "storyboard",
  shots: "storyboard",
  shot: "storyboard",
  prompts: "prompts",
  prompt: "prompts",
  package: "handoff",
  handoff: "handoff",
  delivery: "handoff",
};

const STATUS_PRIORITY = {
  blocked: 0,
  stale: 1,
  needs_review: 2,
  in_progress: 3,
  missing: 4,
  ready: 5,
};

function currentPayload(entity) {
  const raw = entity?.current_revision?.payload_json;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); }
  catch { return {}; }
}

function explicitStage(entity) {
  const payload = currentPayload(entity);
  const raw = String(payload.production_stage || payload.stage || "").trim().toLowerCase();
  return STAGE_ALIASES[raw] || null;
}

function fallbackStage(entity) {
  const type = String(entity?.entity_type || "");
  return STAGES.find(stage => stage.entityTypes.includes(type))?.key || null;
}

function stageForEntity(entity) {
  return explicitStage(entity) || fallbackStage(entity);
}

function entityStatus(entity) {
  const state = String(entity?.state || "missing").toLowerCase();
  if (READY_STATES.has(state)) return "ready";
  if (state === "blocked" || state === "invalid") return "blocked";
  if (state === "stale") return "stale";
  if (state === "unverified") return "needs_review";
  if (state === "working") return "in_progress";
  if (state === "missing") return "missing";
  return "in_progress";
}

function entityRef(entity) {
  return {
    entity_id: entity?.entity_id || null,
    entity_type: entity?.entity_type || null,
    logical_key: entity?.logical_key || null,
    state: entity?.state || "missing",
    revision_id: entity?.current_revision?.revision_id || null,
  };
}

function staleDependencyMessages(entity) {
  return (Array.isArray(entity?.dependencies) ? entity.dependencies : [])
    .filter(dep => dep?.stale)
    .map(dep => {
      const label = [dep.upstream_entity_type, dep.upstream_logical_key].filter(Boolean).join(" ") || dep.upstream_entity_id || "upstream object";
      const before = dep.used_revision_id || "unknown";
      const after = dep.current_revision_id || "missing";
      const role = dep.role ? `${dep.role}: ` : "";
      return `${role}${label} changed (${before} → ${after})`;
    });
}

function reasonsForEntity(entity) {
  const dependencyReasons = staleDependencyMessages(entity);
  const errors = Array.isArray(entity?.errors) ? entity.errors.map(String) : [];
  return [...new Set([...dependencyReasons, ...errors])];
}

function actionForStatus(status) {
  if (status === "stale") return "regenerate_from_current_inputs";
  if (status === "blocked") return "resolve_blocker";
  if (status === "needs_review") return "run_qa_or_review";
  if (status === "in_progress") return "finish_current_work";
  if (status === "missing") return "create_stage_outputs";
  return null;
}

function latestPromptJob(promptJobs) {
  return [...(Array.isArray(promptJobs) ? promptJobs : [])]
    .sort((a, b) => String(b?.updated_at || "").localeCompare(String(a?.updated_at || "")))[0] || null;
}

function promptJobFallback(promptJobs) {
  const job = latestPromptJob(promptJobs);
  if (!job) return null;
  const state = String(job.state || "").toUpperCase();
  if (ACTIVE_PROMPT_JOB_STATES.has(state)) {
    return { status: "in_progress", reason: `prompt job ${state.toLowerCase()}`, job_id: job.job_id || null };
  }
  if (state === "STALE") return { status: "stale", reason: "latest prompt job is stale", job_id: job.job_id || null };
  if (["FAILED", "REJECTED"].includes(state)) {
    return { status: "blocked", reason: job.last_error || `prompt job ${state.toLowerCase()}`, job_id: job.job_id || null };
  }
  if (["READY", "USER_APPROVED", "UPLOAD_READY"].includes(state)) {
    return { status: "needs_review", reason: "prompt job output is not yet represented by a ready canonical prompt object", job_id: job.job_id || null };
  }
  return null;
}

function summarizeStage(definition, entities, promptJobs) {
  const refs = entities.map(entityRef);
  const reasons = [...new Set(entities.flatMap(reasonsForEntity))];
  let status = "missing";

  if (entities.length) {
    status = entities
      .map(entityStatus)
      .sort((a, b) => (STATUS_PRIORITY[a] ?? 99) - (STATUS_PRIORITY[b] ?? 99))[0];
  } else if (definition.key === "prompts") {
    const fallback = promptJobFallback(promptJobs);
    if (fallback) {
      status = fallback.status;
      reasons.push(fallback.reason);
    }
  }

  if (!entities.length && !reasons.length) reasons.push("no production objects for this stage");
  const readyCount = entities.filter(entity => entityStatus(entity) === "ready").length;
  const staleCount = entities.filter(entity => entityStatus(entity) === "stale").length;

  return {
    key: definition.key,
    label: definition.label,
    required: definition.required,
    status,
    object_count: entities.length,
    ready_count: readyCount,
    stale_count: staleCount,
    reasons,
    entities: refs,
    action: actionForStatus(status),
  };
}

function buildSceneProductionState({ sceneEntity, childEntities = [], promptJobs = [] } = {}) {
  const all = [sceneEntity, ...(Array.isArray(childEntities) ? childEntities : [])].filter(Boolean);
  const stageObjects = Object.fromEntries(STAGES.map(stage => [stage.key, []]));
  for (const entity of all) {
    const stage = stageForEntity(entity);
    if (stage && stageObjects[stage]) stageObjects[stage].push(entity);
  }

  const stages = STAGES.map(definition => summarizeStage(definition, stageObjects[definition.key], promptJobs));
  const required = stages.filter(stage => stage.required);
  const readyRequired = required.filter(stage => stage.status === "ready");
  const blockers = required
    .filter(stage => stage.status !== "ready")
    .map(stage => ({
      stage: stage.key,
      label: stage.label,
      status: stage.status,
      action: stage.action,
      reasons: stage.reasons,
      entity_ids: stage.entities.map(entity => entity.entity_id).filter(Boolean),
    }));
  const staleObjects = all
    .filter(entity => entityStatus(entity) === "stale")
    .map(entity => ({ ...entityRef(entity), reasons: reasonsForEntity(entity), dependencies: entity.dependencies || [] }));
  const generateReady = required.length > 0 && blockers.length === 0;
  const status = generateReady
    ? "ready"
    : blockers.map(blocker => blocker.status).sort((a, b) => (STATUS_PRIORITY[a] ?? 99) - (STATUS_PRIORITY[b] ?? 99))[0] || "missing";

  return {
    schema_version: 1,
    generate_ready: generateReady,
    status,
    progress: required.length ? Math.round((readyRequired.length / required.length) * 100) : 0,
    ready_stages: readyRequired.length,
    required_stages: required.length,
    stages: Object.fromEntries(stages.map(stage => [stage.key, stage])),
    blockers,
    stale_objects: staleObjects,
    next_action: blockers[0] || null,
  };
}

module.exports = {
  READY_STATES,
  STAGES,
  buildSceneProductionState,
  entityStatus,
  stageForEntity,
};
