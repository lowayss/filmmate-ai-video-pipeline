const fs = require("node:fs");
const path = require("node:path");
const {
  sha256,
  countOccurrences,
  collectProtectedStrings,
  validatePromptTranslation,
} = require("./prompt-translation.cjs");

const HANDOFF_SCHEMA_VERSION = 1;

function safeSlug(value) {
  return String(value || "item")
    .replace(/[^0-9A-Za-z가-힣._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function inferMediaType(item) {
  const explicit = String(item?.mediaType || item?.media_type || '').toLowerCase();
  if (['image', 'video', 'audio'].includes(explicit)) return explicit;
  const source = String(item?.path || item?.absolutePath || item?.name || '').toLowerCase();
  if (/\.(mp4|mov|m4v|webm|avi|mkv)$/.test(source)) return 'video';
  if (/\.(wav|mp3|m4a|aac|flac|ogg)$/.test(source)) return 'audio';
  return 'image';
}

function handoffDirectory(sceneDir, context) {
  return path.join(
    sceneDir,
    "previews",
    "filmmate-codex-handoff",
    safeSlug(context.model),
    safeSlug(context.unitType),
    safeSlug(context.targetId),
  );
}

function normalizeRequest(payload, skillPolicy) {
  const sourcePrompt = String(payload?.sourcePrompt || "");
  if (!sourcePrompt.trim()) throw new Error("E_PROMPT_HANDOFF_SOURCE_REQUIRED");
  if (sourcePrompt.length > 200000) throw new Error("E_PROMPT_HANDOFF_SOURCE_TOO_LARGE");
  const context = {
    project:String(payload?.project || ""),
    scene:String(payload?.scene || ""),
    model:String(payload?.model || ""),
    unitType:payload?.unitType === "block" ? "block" : "shot",
    targetId:String(payload?.targetId || ""),
  };
  for (const [key,value] of Object.entries(context)) if (!value) throw new Error(`E_PROMPT_HANDOFF_CONTEXT_REQUIRED:${key}`);
  const suppliedProtected = Array.isArray(payload?.protectedStrings) ? payload.protectedStrings : [];
  const protectedStrings = collectProtectedStrings(sourcePrompt, suppliedProtected)
    .slice(0, 500)
    .map(value => String(value).slice(0, 1000));
  const counts = {image:0, video:0, audio:0};
  const references = (Array.isArray(payload?.references) ? payload.references : []).slice(0, 100).map((item, index) => {
    const mediaType = inferMediaType(item);
    counts[mediaType] += 1;
    const label = mediaType === 'video' ? 'Video' : mediaType === 'audio' ? 'Audio' : 'Image';
    return {
    order:Number(item?.order || item?.inputOrder || index + 1),
    input_order:Number(item?.inputOrder || item?.input_order || item?.order || index + 1),
    tag:String(item?.tag || `@${label} ${counts[mediaType]}`),
    external_id:String(item?.externalId || item?.external_id || `${label} ${counts[mediaType]}`),
    media_type:mediaType,
    source_kind:String(item?.sourceKind || item?.source_kind || (item?.role === 'motion' ? 'previs' : 'asset')),
    role:String(item?.role || ""),
    name:String(item?.name || ""),
    path:String(item?.path || ""),
    use:String(item?.use || ""),
    exclude:String(item?.exclude || ""),
    provenance:String(item?.provenance || ""),
  };
  });
  const core = {
    schema_version:HANDOFF_SCHEMA_VERSION,
    project:context.project,
    scene:context.scene,
    model:context.model,
    unit_type:context.unitType,
    target_id:context.targetId,
    workflow_mode:payload?.workflowMode === 'micro_shot' ? 'micro_shot' : 'scene_block',
    micro_brief:String(payload?.microBrief || payload?.micro_brief || ''),
    reference_order_policy:'global_input_order_with_media_tags',
    source_prompt:sourcePrompt,
    source_prompt_sha256:sha256(sourcePrompt),
    protected_strings:protectedStrings,
    references,
    skill_provenance:{
      name:"seedance-prompt-rules",
      entrypoint:String(skillPolicy.entrypoint || ""),
      bundle_sha256:String(skillPolicy.bundle_sha256 || ""),
      status:"PASS",
    },
    delivery_contract:"Codex must submit ko, en, and zh together for this exact request.",
  };
  return {context, core, requestSha256:sha256(JSON.stringify(core))};
}

function validateProtectedSource(sourcePrompt, koreanPrompt, protectedStrings) {
  const issues = [];
  for (const token of collectProtectedStrings(sourcePrompt, protectedStrings)) {
    const expected = countOccurrences(sourcePrompt, token);
    const actual = countOccurrences(koreanPrompt, token);
    if (expected !== actual) issues.push(`ko_protected_token_mismatch:${token}:${expected}:${actual}`);
  }
  return issues;
}

function readResponse(responseFile, request, skillPolicy) {
  if (!fs.existsSync(responseFile)) return null;
  let response;
  try { response = JSON.parse(fs.readFileSync(responseFile, "utf8")); }
  catch { throw new Error("E_PROMPT_HANDOFF_RESPONSE_JSON_INVALID"); }
  if (response?.schema_version !== HANDOFF_SCHEMA_VERSION) throw new Error("E_PROMPT_HANDOFF_SCHEMA_INVALID");
  if (response?.request_sha256 !== request.requestSha256) throw new Error("E_PROMPT_HANDOFF_STALE_RESPONSE");
  if (response?.skill_bundle_sha256 !== skillPolicy.bundle_sha256) throw new Error("E_PROMPT_HANDOFF_SKILL_STALE");
  const variants = response?.prompt_variants || {};
  for (const language of ["ko", "en", "zh"]) {
    if (typeof variants[language] !== "string" || !variants[language].trim()) throw new Error(`E_PROMPT_HANDOFF_VARIANT_REQUIRED:${language}`);
  }
  const protectedIssues = validateProtectedSource(request.core.source_prompt, variants.ko, request.core.protected_strings);
  const enQa = validatePromptTranslation(variants.ko, variants.en, "en", request.core.protected_strings);
  const zhQa = validatePromptTranslation(variants.ko, variants.zh, "zh", request.core.protected_strings);
  const issues = [...protectedIssues, ...enQa.issues.map(issue => `en:${issue}`), ...zhQa.issues.map(issue => `zh:${issue}`)];
  if (issues.length) throw new Error(`E_PROMPT_HANDOFF_QA_FAILED:${issues.slice(0, 12).join("|")}`);
  return {
    schema_version:HANDOFF_SCHEMA_VERSION,
    status:"ready",
    request_sha256:request.requestSha256,
    source_sha256:sha256(variants.ko),
    skill_bundle_sha256:skillPolicy.bundle_sha256,
    variants:{ko:variants.ko.trim(), en:variants.en.trim(), zh:variants.zh.trim()},
    engine:String(response.engine || "Codex task handoff"),
    created_at:String(response.created_at || ""),
    validation:{en:enQa, zh:zhQa},
  };
}

function syncPromptHandoff(sceneDir, payload, skillPolicy) {
  const request = normalizeRequest(payload, skillPolicy);
  const directory = handoffDirectory(sceneDir, request.context);
  const requestFile = path.join(directory, "request.json");
  const responseFile = path.join(directory, "response.json");
  const existing = fs.existsSync(requestFile) ? (() => { try { return JSON.parse(fs.readFileSync(requestFile, "utf8")); } catch { return null; } })() : null;
  if (existing?.request_sha256 !== request.requestSha256) {
    atomicWriteJson(requestFile, {...request.core, request_sha256:request.requestSha256, updated_at:new Date().toISOString()});
  }
  try {
    const delivered = readResponse(responseFile, request, skillPolicy);
    if (delivered) return {...delivered, request_path:requestFile, response_path:responseFile};
    return {schema_version:HANDOFF_SCHEMA_VERSION,status:"waiting",request_sha256:request.requestSha256,request_path:requestFile};
  } catch (error) {
    return {schema_version:HANDOFF_SCHEMA_VERSION,status:"rejected",request_sha256:request.requestSha256,request_path:requestFile,response_path:responseFile,error:String(error?.message || error)};
  }
}

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  handoffDirectory,
  normalizeRequest,
  syncPromptHandoff,
};
