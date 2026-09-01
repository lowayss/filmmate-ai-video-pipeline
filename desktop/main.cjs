const { app, BrowserWindow, ipcMain, dialog, clipboard, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const {loadSeedanceSkillPolicy, assertSeedanceSkillBinding} = require("./seedance-skill-binding.cjs");
const {sha256:promptSha256,validatePromptTranslation} = require("./prompt-translation.cjs");
const {
  enqueuePromptJob,
  getPromptJob,
  cancelPromptJob,
  approvePromptJob,
  promptHistory,
} = require("./prompt-job-client.cjs");
const {startCodexPromptJob, cancelCodexPromptJob} = require("./codex-worker.cjs");
const {startProductionAgentWorker, cancelProductionAgentWorker, activeProductionAgentWorkers} = require("./production-agent-worker.cjs");
const {createProjectPathResolver} = require("./project-paths.cjs");
const {createPythonBridge} = require("./python-bridge.cjs");
const {buildSceneProductionState} = require("./production-state.cjs");

const DOCUMENT_WORKSPACE = path.join(app.getPath("documents"), "영화작업용", "scene-package-builder");
const ROOT = fs.existsSync(DOCUMENT_WORKSPACE) ? DOCUMENT_WORKSPACE : path.resolve(__dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const projectPaths = createProjectPathResolver(PACKAGES);
const pythonBridge = createPythonBridge({root:ROOT, resourcesPath:process.resourcesPath});
const CODEX_SKILL_ROOT = path.join(os.homedir(), ".codex", "skills");
const CODEX_SOURCES = [
  { key: "sihap", label: "시합 · 시나리오", kind: "skill", required: true },
  { key: "conhap", label: "콘합 · 콘티/스토리보드", kind: "skill", required: true },
  { key: "mihap-conti", label: "미합 · 카메라/연속성", kind: "skill", required: false },
  { key: "mihap-image-prompt", label: "미합 · 이미지 프롬프트", kind: "skill", required: false },
  { key: "seedance-prompt-rules", label: "씨댄스 · 영상 프롬프트", kind: "skill", required: true },
  { key: "hap-core", label: "HAP Core · 정본/승인/QA", kind: "skill", required: true },
];

function analyzeScreenplay(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const re = /^\s*#{0,6}\s*(?:S\s*#?\s*|SCENE\s+|씬\s*)(\d+)\s*[.)]?\s*(.*?)\s*$/gim;
  const matches = [...normalized.matchAll(re)];
  const scenes = matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index || normalized.length) : normalized.length;
    const raw = match[2].trim();
    const parts = raw.split("/").map(v => v.trim());
    const source = normalized.slice(start, end).trim();
    return { scene_id:`S${Number(match[1])}`, order:index+1, title:parts[0] || `씬 ${match[1]}`, location:parts[0] || null, time:parts[1] || null, source_start:start, source_end:end, source_text:source, estimated_duration_sec:Math.max(15, Math.round(source.split(/\s+/).length / 2.5)) };
  });
  if (!scenes.length && normalized.trim()) {
    scenes.push({scene_id:"S1",order:1,title:"분석 필요",location:null,time:null,source_start:0,source_end:normalized.length,source_text:normalized.trim(),estimated_duration_sec:Math.max(15,Math.round(normalized.split(/\s+/).length/2.5))});
  }
  return { scene_count: scenes.length, scenes };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}

function readJsonl(file) {
  return readText(file).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function hapScriptPath() {
  return pythonBridge.hapScriptPath();
}

function runHap(projectDir, args) {
  return pythonBridge.runHap(projectDir, args);
}

function runHapAsync(projectDir, args) {
  return pythonBridge.runHapAsync(projectDir, args);
}

function runDocumentBridge(command, payload) {
  return pythonBridge.runDocumentBridge(command, payload);
}

function runDocumentBridgeAsync(command, payload) {
  return pythonBridge.runDocumentBridgeAsync(command, payload);
}

async function connectCodexSources(projectDir) {
  const connected = [];
  for (const source of CODEX_SOURCES) {
    const sourcePath = path.join(CODEX_SKILL_ROOT, source.key);
    const output = await runHapAsync(projectDir, ["link-source", projectDir, "--path", sourcePath, "--label", source.label, "--kind", source.kind, ...(source.required ? ["--required"] : []), "--source-id", `codex:${source.key}`]);
    connected.push({ key: source.key, path: sourcePath, source_id: output });
  }
  const checked = await runHapAsync(projectDir, ["check-sources", projectDir]);
  return { connected, check: JSON.parse(checked) };
}

function conhapBreakdown(base, shots) {
  if (!shots.length) return base;
  return {
    ...(base || {}),
    shot_count: shots.length,
    shots: shots.map(shot => ({
      shot_id: shot.id,
      duration_sec: "—",
      beat: `${shot.shot_intent} / 새 정보: ${shot.new_information}`,
      camera: `${shot.camera?.shot_size || ""} · ${shot.camera?.view_angle || ""} · ${shot.camera?.movement || ""}`,
      continuity: `${shot.continuity?.state_in || ""} → ${shot.continuity?.state_out || ""}`,
    })),
  };
}

function readProjects() {
  if (!fs.existsSync(PACKAGES)) return [];
  return fs.readdirSync(PACKAGES, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => fs.statSync(path.join(PACKAGES, b.name)).mtimeMs - fs.statSync(path.join(PACKAGES, a.name)).mtimeMs)
    .map(entry => {
      const projectDir = path.join(PACKAGES, entry.name);
      const hapProjection = readJson(path.join(projectDir, ".hap", "projection.json"));
      const rootManifest = readJson(path.join(projectDir, "scene-data", "scene-manifest.json"));
      if (!rootManifest) return null;
      const scenesDir = path.join(projectDir, "scenes");
      const scenes = fs.existsSync(scenesDir)
        ? fs.readdirSync(scenesDir, { withFileTypes: true })
          .filter(scene => scene.isDirectory())
          .map(scene => {
            const sceneDir = path.join(scenesDir, scene.name);
            const manifest = readJson(path.join(sceneDir, "scene-data", "scene-manifest.json"));
            if (!manifest) return null;
            const breakdown = readJson(path.join(sceneDir, "scene-data", "scene-breakdown.json"));
            const artifacts = readJson(path.join(sceneDir, "scene-data", "artifacts.json"));
            const conhapPath = fs.existsSync(path.join(sceneDir, "conhap-v3", "project.json")) ? "conhap-v3" : "conhap";
            const conhapProject = readJson(path.join(sceneDir, conhapPath, "project.json"));
            const conhapShots = readJsonl(path.join(sceneDir, conhapPath, "shots.jsonl"));
            const conhapBlocks = readJsonl(path.join(sceneDir, conhapPath, "blocks.jsonl"));
            const conhapText = readText(path.join(sceneDir, conhapPath, "text-conti.md"));
            const imageCount = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => /\.(png|jpe?g|webp)$/i.test(file)).length : 0;
            const hasImage = dir => imageCount(dir) > 0;
            const hasArtifactRole = role => (artifacts?.artifacts || []).some(a => a.role === role);
            const sceneEntity = hapProjection?.entities?.find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene.name));
            const childEntities = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
            const scenePromptJobs = (hapProjection?.prompt_jobs || []).filter(job => job.scene_key === manifest.scene_id || job.scene_key === scene.name);
            const production = sceneEntity ? buildSceneProductionState({sceneEntity, childEntities, promptJobs:scenePromptJobs}) : null;
            const aggregate = (types, empty = "pending") => {
              const values = childEntities.filter(entity => types.includes(entity.entity_type));
              if (!values.length) return empty;
              const rank = {blocked:0,stale:1,invalid:2,unverified:3,working:4,missing:5,verified:6,accepted:7,ready:7};
              return values.sort((a,b)=>(rank[a.state]??2)-(rank[b.state]??2))[0].state;
            };
            const legacy = value => value ? "legacy_unverified" : "pending";
            const pipeline = sceneEntity ? {
              analysis: sceneEntity.state,
              text_conti: aggregate(["block"]),
              assets: aggregate(["asset"]),
              storyboard: aggregate(["cut","block"]),
              prompts: aggregate(["prompt","package"]),
              qa: aggregate(["cut","block","asset","prompt","package"]),
              package: aggregate(["package"]),
            } : {
              analysis: legacy(manifest.pipeline?.analysis),
              text_conti: legacy(Boolean(conhapText || fs.existsSync(path.join(sceneDir, "text-conti", "scene-breakdown.json")))),
              assets: hasArtifactRole("character_reference") || hasArtifactRole("location_reference") || hasArtifactRole("prop_reference") || hasImage(path.join(sceneDir, conhapPath, "reference-sheets")) ? "legacy_unverified" : (fs.existsSync(path.join(sceneDir, "assets", "asset-plan.json")) ? "planned" : "pending"),
              storyboard: hasImage(path.join(sceneDir, conhapPath, "frames")) ? "legacy_unverified" : "pending",
              prompts: legacy(fs.existsSync(path.join(sceneDir, "prompts", "prompt-manifest.json"))),
              qa: legacy(fs.existsSync(path.join(sceneDir, conhapPath, "qa", "qa.jsonl")) || fs.existsSync(path.join(sceneDir, "qa", "qa-report.json"))),
              package: legacy(fs.existsSync(path.join(sceneDir, "delivery")) && fs.readdirSync(path.join(sceneDir, "delivery")).some(file => file.endsWith(".zip"))),
            };
            const stages = Object.values(pipeline);
            const done = stages.filter(value => ["ready","accepted","verified"].includes(value)).length;
            return {
              ...manifest,
              breakdown: conhapBreakdown(breakdown, conhapShots),
              block_count: conhapBlocks.length || breakdown?.block_count || manifest.block_count || 0,
              shot_count: conhapShots.length || breakdown?.shot_count || manifest.shot_count || 0,
              scene_duration: breakdown?.duration_sec ? `${breakdown.duration_sec}s` : manifest.scene_duration,
              project: entry.name,
              path: sceneDir,
              production,
              progress: production?.progress ?? (stages.length ? Math.round(done / stages.length * 100) : 0),
              state_source: sceneEntity ? "hap-v2" : "legacy-evidence-only",
            };
          }).filter(Boolean)
        : [];
      return { id: entry.name, title: rootManifest.title || entry.name, scenes, source_links: hapProjection?.source_links || [], root: projectDir };
    }).filter(Boolean);
}

ipcMain.handle("projects:list", () => readProjects());

ipcMain.handle("project:connect-codex-sources", async (_event, project) => {
  let projectDir;
  try { projectDir = projectPaths.resolveHapProject(project); }
  catch { throw new Error("hap_project_not_found"); }
  return await connectCodexSources(projectDir);
});

function productionAgentPayload(project, scene, request = {}) {
  const projectDir = projectPaths.resolveHapProject(project);
  const {sceneDir} = projectPaths.resolveScene(project, scene);
  const manifest = readJson(path.join(sceneDir, "scene-data", "scene-manifest.json")) || {};
  return {
    project_root: projectDir,
    scene_aliases: [scene, sceneDir.name, manifest.scene_id].filter(Boolean),
    ...request,
  };
}

ipcMain.handle("production-agent:run", async (_event, project, scene, request = {}) => {
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {
    action:"plan",
    goal:request?.goal,
    target:request?.target,
    previous_checkpoint:request?.previous_checkpoint,
  }));
});
ipcMain.handle("production-agent:start-run", async (_event, project, scene, request = {}) => {
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {...request, action:"start_run", actor:"filmmate-user"}));
});
ipcMain.handle("production-agent:get-run", async (_event, project, scene, runId) => {
  const request = runId ? {action:"get_run", run_id:runId, actor:"filmmate-user"} : {action:"latest_run", actor:"filmmate-user"};
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, request));
});
ipcMain.handle("production-agent:control-run", async (_event, project, scene, request = {}) => {
  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {...request, action:"control_run", actor:"filmmate-user"}));
});
ipcMain.handle("production-agent:start-worker", async (_event, project, scene, runId) => {
  const basePayload = productionAgentPayload(project, scene);
  const sendEvent = event => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("production-agent:worker-event", {project, scene, ...event});
    }
  };
  return startProductionAgentWorker({
    projectDir: basePayload.project_root,
    bridge: pythonBridge,
    basePayload,
    runId,
    onEvent: sendEvent,
  });
});
ipcMain.handle("production-agent:cancel-worker", async (_event, runId) => {
  return await cancelProductionAgentWorker(runId);
});
ipcMain.handle("production-agent:worker-status", (_event, runId) => {
  const active = activeProductionAgentWorkers();
  return {run_id:String(runId || ""), active:active.includes(String(runId || "")), active_run_ids:active};
});

ipcMain.handle("project:delete", async (_event, project) => {
  const projectName = String(project || "");
  const projectDir = projectPaths.resolveProject(projectName);
  const owner = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const answer = await dialog.showMessageBox(owner, {
    type: "warning",
    title: "프로젝트를 휴지통으로 이동",
    message: `${projectName} 프로젝트를 휴지통으로 이동할까요?`,
    detail: "HAP 정본과 씬·에셋·프롬프트 자료 전체가 함께 이동합니다. 휴지통에서 복구할 수 있습니다.",
    buttons: ["휴지통으로 이동", "취소"],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return { deleted: false, project: projectName };
  if (typeof shell.trashItem === "function") {
    await shell.trashItem(projectDir);
  } else {
    const trash = path.join(os.homedir(), ".Trash");
    fs.mkdirSync(trash, {recursive:true});
    let target = path.join(trash, projectName);
    let suffix = 2;
    while (fs.existsSync(target)) target = path.join(trash, `${projectName}_${suffix++}`);
    fs.renameSync(projectDir, target);
  }
  if (fs.existsSync(projectDir)) throw new Error("project_trash_move_failed");
  return { deleted: true, project: projectName };
});

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(file, base);
    const stat = fs.statSync(file);
    return [{ name: entry.name, relativePath: path.relative(base, file), absolutePath: file, url: pathToFileURL(file).href, size: stat.size, type: path.extname(file).slice(1) || "file" }];
  });
}

function findSceneAssetFolder(sceneDir) {
  const candidates = [
    {path:path.join(sceneDir, "conhap-v3", "reference-sheets"), kind:"reference-sheets-v3"},
    {path:path.join(sceneDir, "conhap", "reference-sheets"), kind:"reference-sheets"},
    {path:path.join(sceneDir, "assets"), kind:"scene-assets"},
    {path:path.join(sceneDir, "input"), kind:"scene-input-assets"},
  ];
  return candidates.find(candidate => fs.existsSync(candidate.path) && fs.statSync(candidate.path).isDirectory()) || null;
}

function listSceneAssetLibrary(sceneDir, project, scene) {
  const assetFolder = findSceneAssetFolder(sceneDir);
  if (!assetFolder) return {path:null, kind:null, files:[]};
  const accessPath = prepareUserAssetAccess(assetFolder.path, project, scene);
  const files = listFiles(assetFolder.path)
    .filter(file => /\.(png|jpe?g|webp)$/i.test(file.name))
    .map(file => ({
      ...file,
      role: file.relativePath.split(path.sep)[0] || "reference",
      path: `/${file.relativePath.split(path.sep).join("/")}`,
    }));
  return {path:accessPath, sourcePath:assetFolder.path, kind:assetFolder.kind, files};
}

ipcMain.handle("scene:detail", async (_event, project, scene) => {
  let projectDir, sceneDir;
  try { ({projectDir, sceneDir} = resolveSceneTarget(project, scene)); }
  catch { throw new Error("scene_not_found"); }
  const manifest = readJson(path.join(sceneDir, "scene-data", "scene-manifest.json"));
  const artifacts = readJson(path.join(sceneDir, "scene-data", "artifacts.json"));
  if (!manifest || !fs.existsSync(sceneDir)) throw new Error("scene_not_found");
  const breakdown = readJson(path.join(sceneDir, "scene-data", "scene-breakdown.json"));
  const assetPlan = readJson(path.join(sceneDir, "assets", "asset-plan.json"));
  const promptManifest = readJson(path.join(sceneDir, "prompts", "prompt-manifest.json"));
  const delivery = readJson(path.join(sceneDir, "delivery", "upload-order.json"));
  const sourcePath = path.join(sceneDir, "input-screenplay.txt");
  const legacySourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
  const conhapDir = path.join(sceneDir, "conhap");
  const preferredConhapDir = fs.existsSync(path.join(sceneDir, "conhap-v3", "project.json")) ? path.join(sceneDir, "conhap-v3") : conhapDir;
  const fullDialogueTextContiPath = path.join(preferredConhapDir, "text-conti-v3-full-dialogue.md");
  const detailedTextContiPath = path.join(preferredConhapDir, "text-conti-v2-draft.md");
  const textContiPath = fs.existsSync(fullDialogueTextContiPath)
    ? fullDialogueTextContiPath
    : fs.existsSync(detailedTextContiPath)
      ? detailedTextContiPath
      : path.join(preferredConhapDir, "text-conti.md");
  const conhapProject = readJson(path.join(preferredConhapDir, "project.json"));
  const hapProjection = readJson(path.join(projectDir, ".hap", "projection.json"));
  const canonicalDocuments = fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))
    ? await runDocumentBridgeAsync("read", {project_root:projectDir, scene})
    : null;
  const documents = canonicalDocuments?.documents || {
    screenplay:{kind:"screenplay",content:legacySourceText,revision_id:null,canonical:false,source:"legacy-projection",projection_path:"input-screenplay.txt"},
    conti:{kind:"conti",content:readText(textContiPath),revision_id:null,canonical:false,source:"legacy-projection",projection_path:path.relative(sceneDir,textContiPath)},
  };
  const sourceText = documents.screenplay?.content ?? legacySourceText;
  const sceneEntity = (hapProjection?.entities || []).find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene));
  const sceneChildren = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
  const scenePromptJobs = (hapProjection?.prompt_jobs || []).filter(job => job.scene_key === manifest.scene_id || job.scene_key === scene);
  const production = sceneEntity ? buildSceneProductionState({sceneEntity, childEntities:sceneChildren, promptJobs:scenePromptJobs}) : null;
  const assetLibrary = listSceneAssetLibrary(sceneDir, project, scene);
  const conhap = {
    dir: path.basename(preferredConhapDir),
    project: conhapProject,
    beats: readJsonl(path.join(preferredConhapDir, "beats.jsonl")),
    shots: readJsonl(path.join(preferredConhapDir, "shots.jsonl")),
    blocks: readJsonl(path.join(preferredConhapDir, "blocks.jsonl")),
    textConti: documents.conti?.content ?? readText(textContiPath),
    textContiPath: documents.conti?.projection_path || path.relative(sceneDir, textContiPath),
    textContiVersion: fs.existsSync(fullDialogueTextContiPath)
      ? "conhap-v3-full-dialogue"
      : fs.existsSync(detailedTextContiPath)
        ? "conhap-v2-draft"
        : (conhapProject?.text_conti_version || "conhap-v1"),
    approval: readJson(path.join(preferredConhapDir, "approval", "approval.json")),
  };
  return {
    manifest,
    breakdown: conhapBreakdown(breakdown, conhap.shots),
    assetPlan,
    promptManifest,
    delivery,
    sourceText,
    documents,
    conhap,
    production,
    hap:{
      schema_version:hapProjection?.schema_version || null,
      scene_revision_id:sceneEntity?.current_revision?.revision_id || null,
      conhap_entity_id:documents.conti?.entity_id || null,
      conhap_revision_id:documents.conti?.revision_id || null,
      entities:sceneChildren.map(entity => ({entity_id:entity.entity_id,entity_type:entity.entity_type,logical_key:entity.logical_key,current_revision_id:entity.current_revision?.revision_id || null,state:entity.state,errors:entity.errors || [],dependencies:entity.dependencies || []})),
    },
    assetLibrary,
    artifacts: (artifacts?.artifacts || []).map(artifact => {
      const artifactPath = path.join(sceneDir, artifact.file || "");
      return {...artifact, absolutePath: artifactPath, url: fs.existsSync(artifactPath) ? pathToFileURL(artifactPath).href : null};
    }),
    files: listFiles(sceneDir),
  };
});

ipcMain.handle("scene:save-document", async (_event, project, scene, request) => {
  const {projectDir} = resolveSceneTarget(project, scene);
  if (!fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("hap_project_not_found");
  const kind = String(request?.kind || "");
  if (!["screenplay", "conti"].includes(kind)) throw new Error("invalid_document_kind");
  const content = String(request?.content ?? "");
  const expectedRevisionId = request?.expectedRevisionId ?? null;
  const expectedSceneRevisionId = request?.expectedSceneRevisionId ?? null;
  const requestHash = crypto.createHash("sha256").update(JSON.stringify({project,scene,kind,expectedRevisionId,expectedSceneRevisionId,content})).digest("hex");
  return await runDocumentBridgeAsync("save", {
    project_root:projectDir,
    scene,
    kind,
    content,
    actor:"filmmate-user",
    expected_revision_id:expectedRevisionId,
    expected_scene_revision_id:expectedSceneRevisionId,
    idempotency_key:`filmmate-document:${requestHash}`,
  });
});

ipcMain.handle("prompt:seedance-skill-policy", () => loadSeedanceSkillPolicy());
ipcMain.handle("prompt:sync-handoff", (_event, payload) => {
  const {projectDir} = resolveSceneTarget(payload?.project, payload?.scene);
  const skillPolicy = assertSeedanceSkillBinding(payload?.skillProvenance);
  return enqueuePromptJob(projectDir, payload, skillPolicy);
});
function promptProjectDir(project) {
  try { return projectPaths.resolveHapProject(project); }
  catch { throw new Error("hap_project_not_found"); }
}
ipcMain.handle("prompt:get-job", (_event, project, jobId) => getPromptJob(promptProjectDir(project), String(jobId)));
ipcMain.handle("prompt:start-codex", (_event, project, jobId, skillProvenance) => {
  const projectDir = promptProjectDir(project);
  const skillPolicy = assertSeedanceSkillBinding(skillProvenance);
  const current = getPromptJob(projectDir, String(jobId));
  return startCodexPromptJob({projectDir, job:current.job, request:current.request, skillPolicy});
});
ipcMain.handle("prompt:cancel-job", (_event, project, jobId) => cancelCodexPromptJob(promptProjectDir(project), String(jobId)));
ipcMain.handle("prompt:approve-job", (_event, project, jobId, evidence) => approvePromptJob(promptProjectDir(project), String(jobId), evidence));
ipcMain.handle("prompt:history", (_event, project, scene) => promptHistory(promptProjectDir(project), scene));

function safeSlug(value) {
  return String(value || "item").replace(/[^0-9A-Za-z가-힣._-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function normalizePromptLanguagePayload(config = {}) {
  const requestedLanguage = ["ko", "en", "zh"].includes(config?.promptLanguage) ? config.promptLanguage : "ko";
  const suppliedVariants = config?.promptVariants && typeof config.promptVariants === "object" ? config.promptVariants : {};
  const variants = {
    ko:String(suppliedVariants.ko || (requestedLanguage === "ko" ? config?.prompt : "") || ""),
    en:String(suppliedVariants.en || (requestedLanguage === "en" ? config?.prompt : "") || ""),
    zh:String(suppliedVariants.zh || (requestedLanguage === "zh" ? config?.prompt : "") || ""),
  };
  if (!variants.ko.trim()) throw new Error("E_PROMPT_KOREAN_SOURCE_REQUIRED: 한국어 정본 프롬프트가 필요합니다.");
  const suppliedStatus = config?.promptVariantStatus && typeof config.promptVariantStatus === "object" ? config.promptVariantStatus : {};
  const status = {
    ko:"ready",
    en:suppliedStatus.en === "ready" && variants.en.trim() ? "ready" : (suppliedStatus.en || "missing"),
    zh:suppliedStatus.zh === "ready" && variants.zh.trim() ? "ready" : (suppliedStatus.zh || "missing"),
  };
  const protectedStrings = Array.isArray(config?.promptProtectedStrings) ? config.promptProtectedStrings.map(value => String(value)).slice(0, 500) : [];
  for (const language of ["en", "zh"]) {
    if (status[language] !== "ready") continue;
    const qa = validatePromptTranslation(variants.ko, variants[language], language, protectedStrings);
    if (qa.status !== "PASS") throw new Error(`E_PROMPT_TRANSLATION_QA_FAILED:${language}:${qa.issues.slice(0, 8).join("|")}`);
  }
  const translationMeta = config?.promptTranslationMeta && typeof config.promptTranslationMeta === "object" ? config.promptTranslationMeta : null;
  if (translationMeta?.source_sha256 && translationMeta.source_sha256 !== promptSha256(variants.ko)) {
    throw new Error("E_PROMPT_TRANSLATION_SOURCE_STALE: 번역본이 현재 한국어 원문과 일치하지 않습니다.");
  }
  const selectedLanguage = status[requestedLanguage] === "ready" ? requestedLanguage : "ko";
  return {selectedLanguage,variants,status,translationMeta,protectedStrings,activePrompt:variants[selectedLanguage]};
}

function writePromptLanguageFiles(dir, config, options = {}) {
  const normalized = normalizePromptLanguagePayload(config);
  const activeFilename = safeSlug(options.activeFilename || "prompt.txt");
  const extension = path.extname(activeFilename) || ".txt";
  const base = path.basename(activeFilename, extension);
  const promptFiles = {};
  fs.writeFileSync(path.join(dir, activeFilename), normalized.activePrompt, "utf8");
  for (const language of ["ko", "en", "zh"]) {
    if (normalized.status[language] !== "ready" || !normalized.variants[language].trim()) continue;
    const filename = `${base}.${language}${extension}`;
    fs.writeFileSync(path.join(dir, filename), normalized.variants[language], "utf8");
    promptFiles[language] = filename;
  }
  const manifestFilename = safeSlug(options.manifestFilename || "PROMPT-LANGUAGES.json");
  const manifest = {
    schema_version:1,
    selected_language:normalized.selectedLanguage,
    active_prompt_file:activeFilename,
    prompt_files:promptFiles,
    status:normalized.status,
    source_language:"ko",
    source_sha256:promptSha256(normalized.variants.ko),
    translation_engine:normalized.translationMeta?.engine || null,
    translation_created_at:normalized.translationMeta?.created_at || null,
    translation_cached:normalized.translationMeta?.cached ?? null,
    translation_validation:normalized.translationMeta?.validation || null,
    prompt_sha256:Object.fromEntries(Object.entries(promptFiles).map(([language]) => [language,promptSha256(normalized.variants[language])])),
  };
  fs.writeFileSync(path.join(dir, manifestFilename), JSON.stringify(manifest, null, 2), "utf8");
  return {...normalized,activeFilename,promptFiles,manifestFilename,manifest};
}

function userUploadRoot(project, scene, model) {
  const projectName = String(project || "project").replace(/^PROJECT_/, "");
  const sceneName = String(scene || "scene");
  const modelName = String(model || "Seedance 2.0");
  return path.join(
    app.getPath("documents"),
    "FilmMate_업로드",
    safeSlug(projectName),
    safeSlug(sceneName),
    safeSlug(modelName),
  );
}

function legacyUserUploadRoot(project, scene, model) {
  const projectName = String(project || "project").replace(/^PROJECT_/, "");
  const sceneName = String(scene || "scene");
  const modelName = String(model || "Seedance 2.0");
  return path.join(
    app.getPath("documents"),
    "FilmMake_업로드",
    safeSlug(projectName),
    safeSlug(sceneName),
    safeSlug(modelName),
  );
}

// The canonical scene package can live behind workspace symlinks and several
// production folders. Keep that storage layout intact, but expose a short
// user-facing path for Finder. The category folders below are symlinks back to
// the canonical asset folders, so adding an asset from Finder still updates
// the source used by the prompt builder.
function userAssetAccessRoot(project, scene) {
  const projectName = String(project || "project").replace(/^PROJECT_/, "");
  return path.join(
    app.getPath("documents"),
    "FilmMate_에셋",
    safeSlug(projectName),
    safeSlug(scene || "scene"),
  );
}

function userBlockAssetRoot(project, scene, blockId) {
  return path.join(userAssetAccessRoot(project, scene), "blocks", safeSlug(blockId || "block"));
}

function materializeUserBlockAssets(project, scene, blockId, items) {
  const root = userBlockAssetRoot(project, scene, blockId);
  fs.mkdirSync(root, {recursive:true});
  const manifestPath = path.join(root, ".filmmate-generated.json");
  const previous = readJson(manifestPath);
  for (const filename of Array.isArray(previous?.generated_files) ? previous.generated_files : []) {
    const target = path.join(root, path.basename(String(filename)));
    if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
  }
  const roleNames = {storyboard:"storyboard",character:"character",background:"background",prop:"prop"};
  const roleOrder = {storyboard:0,character:1,background:2,prop:3};
  const ordered = [...(Array.isArray(items) ? items : [])]
    .filter(item => item && item.absolutePath)
    .sort((a,b) => ((roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9)) || ((a.sequence ?? 999) - (b.sequence ?? 999)));
  const generatedFiles = [];
  const mapping = [];
  const seen = new Set();
  ordered.forEach((item, index) => {
    const source = path.resolve(String(item.absolutePath));
    if (seen.has(source)) return;
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`missing_reference:${item.name || index + 1}`);
    seen.add(source);
    const ext = path.extname(source).toLowerCase() || ".png";
    const role = roleNames[item.role] || safeSlug(item.role || "reference");
    const base = safeSlug(path.parse(item.name || path.basename(source)).name) || "reference";
    const filename = `${String(mapping.length + 1).padStart(2, "0")}_${role}_${base}${ext}`;
    const target = path.join(root, filename);
    if (path.resolve(target) !== source) fs.copyFileSync(source, target);
    generatedFiles.push(filename);
    mapping.push({tag:`@Image ${mapping.length + 1}`,filename,role:item.role || "reference",source_name:item.name || path.basename(source)});
  });
  fs.writeFileSync(manifestPath, JSON.stringify({schema_version:1,project,scene,block_id:String(blockId),generated_files:generatedFiles,mapping,updated_at:new Date().toISOString()}, null, 2), "utf8");
  return {path:root,count:mapping.length,mapping};
}

function prepareUserAssetAccess(sourceDir, project, scene) {
  const accessRoot = userAssetAccessRoot(project, scene);
  fs.mkdirSync(accessRoot, {recursive:true});
  const sourceEntries = fs.readdirSync(sourceDir, {withFileTypes:true})
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  for (const entry of sourceEntries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(accessRoot, entry.name);
    try {
      const current = fs.lstatSync(target);
      if (current.isSymbolicLink() && fs.realpathSync(target) === fs.realpathSync(source)) continue;
      // Never replace a user-created item in the public access folder.
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.symlinkSync(source, target, "dir");
  }
  return accessRoot;
}

async function openFolderForUser(folderPath) {
  if (process.platform === "darwin") {
    const escaped = String(folderPath).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = [
      'tell application "Finder"',
      "  activate",
      `  set targetFolder to (POSIX file "${escaped}" as alias)`,
      "  set newWindow to make new Finder window",
      "  set target of newWindow to targetFolder",
      "  set current view of newWindow to icon view",
      "end tell",
    ].join("\n");
    const run = childProcess.spawnSync("/usr/bin/osascript", ["-e", script], {encoding:"utf8"});
    if (run.status === 0) return "";
  }
  return shell.openPath(folderPath);
}

function userUploadBlockRoot(project, scene, model, blockId) {
  return path.join(userUploadRoot(project, scene, model), safeSlug(blockId));
}

function resolveSceneTarget(project, scene) {
  return projectPaths.resolveScene(project, scene);
}

async function composeStoryboardSheet(items, outputPath) {
  if (!items.length) throw new Error("storyboard_images_missing");
  const sources = items.map(item => {
    const source = path.resolve(item.absolutePath || "");
    if (!fs.existsSync(source)) throw new Error(`missing_reference:${item.name}`);
    const mime = /\.jpe?g$/i.test(source) ? "image/jpeg" : /\.webp$/i.test(source) ? "image/webp" : "image/png";
    return `data:${mime};base64,${fs.readFileSync(source).toString("base64")}`;
  });
  const html = `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;background:#0a0a0a;overflow:hidden}.sheet{width:100%;height:100%;display:grid;grid-template-columns:repeat(${sources.length},1fr);gap:6px;padding:6px}.panel{min-width:0;display:flex;align-items:center;justify-content:center;background:#111}.panel img{width:100%;height:100%;object-fit:contain}</style><div class="sheet">${sources.map(src=>`<div class="panel"><img src="${src}"></div>`).join("")}</div>`;
  const win = new BrowserWindow({show:false,width:1920,height:1080,useContentSize:true,webPreferences:{offscreen:true}});
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage({x:0,y:0,width:1920,height:1080});
    fs.mkdirSync(path.dirname(outputPath), {recursive:true});
    fs.writeFileSync(outputPath, image.toPNG());
  } finally { win.destroy(); }
  return outputPath;
}

ipcMain.handle("image:copy-to-clipboard", (_event, source) => {
  const resolved = path.resolve(source || "");
  if (!fs.existsSync(resolved)) throw new Error("image_not_found");
  const image = nativeImage.createFromPath(resolved);
  if (image.isEmpty()) throw new Error("invalid_image");
  clipboard.writeImage(image);
  return {ok:true};
});

ipcMain.handle("scene:open-assets-folder", async (_event, project, scene, blockId, model, items) => {
  const projectName = String(project || "");
  const sceneName = String(scene || "");
  const {sceneDir} = resolveSceneTarget(projectName, sceneName);
  const assetFolder = findSceneAssetFolder(sceneDir);
  if (!assetFolder) throw new Error("asset_library_not_found");
  if (blockId) {
    const block = materializeUserBlockAssets(projectName, sceneName, blockId, items);
    const openError = await openFolderForUser(block.path);
    if (openError) throw new Error(openError);
    return {path:block.path, blockId:String(blockId), model:String(model || "Seedance 2.0"), count:block.count, mapping:block.mapping, kind:"block-assets", access:"user-facing"};
  }
  const assetsDir = assetFolder.path;
  const accessDir = prepareUserAssetAccess(assetsDir, projectName, sceneName);
  const openError = await openFolderForUser(accessDir);
  if (openError) throw new Error(openError);
  return {path: accessDir, sourcePath: assetsDir, kind: assetFolder.kind, access:"user-facing"};
});

ipcMain.handle("storyboard:compose-block", async (_event, project, scene, blockId, items) => {
  const {sceneDir} = resolveSceneTarget(project, scene);
  const out = path.join(sceneDir, "artifacts", "storyboard_block", `${safeSlug(blockId)}_storyboard_combined.png`);
  const sources = (items || []).map(item=>path.resolve(item.absolutePath||"")).filter(source=>fs.existsSync(source));
  if (fs.existsSync(out) && sources.length && sources.every(source=>fs.statSync(out).mtimeMs>=fs.statSync(source).mtimeMs)) return {absolutePath:out,url:pathToFileURL(out).href,name:path.basename(out),cached:true};
  await composeStoryboardSheet(items || [], out);
  return {absolutePath:out,url:pathToFileURL(out).href,name:path.basename(out)};
});

ipcMain.handle("storyboard:save-composite", (_event, project, scene, blockId, dataUrl) => {
  const {sceneDir} = resolveSceneTarget(project, scene);
  const out = path.join(sceneDir, "artifacts", "storyboard_block", `${safeSlug(blockId)}_storyboard_combined.png`);
  const match = String(dataUrl||"").match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error("invalid_composite_data");
  fs.mkdirSync(path.dirname(out), {recursive:true});
  fs.writeFileSync(out, Buffer.from(match[1], "base64"));
  return {absolutePath:out,url:pathToFileURL(out).href,name:path.basename(out)};
});

ipcMain.handle("asset:pick-images", async (_event, project, scene, role) => {
  const {projectDir, sceneDir} = resolveSceneTarget(project, scene);
  if (fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("E_CANONICAL_WRITE_REQUIRED: HAP 프로젝트의 에셋은 정확한 asset revision에 등록해야 합니다.");
  const assetFolder = findSceneAssetFolder(sceneDir);
  const defaultPath = assetFolder ? prepareUserAssetAccess(assetFolder.path, project, scene) : sceneDir;
  const selected = await dialog.showOpenDialog({defaultPath,properties:["openFile","multiSelections"],filters:[{name:"Images",extensions:["png","jpg","jpeg","webp"]}]});
  if (selected.canceled) return [];
  const bucket = path.join(sceneDir, "artifacts", role);
  fs.mkdirSync(bucket, {recursive:true});
  const registryPath = path.join(sceneDir, "scene-data", "artifacts.json");
  const registry = readJson(registryPath) || {schema_version:"1.0",artifacts:[]};
  const added = selected.filePaths.map(source => {
    const bytes = fs.readFileSync(source);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const dest = path.join(bucket, `${digest.slice(0,16)}_${path.basename(source)}`);
    if (!fs.existsSync(dest)) fs.copyFileSync(source, dest);
    const logicalId = `${role}_${path.parse(source).name}`;
    const version = 1 + Math.max(0, ...registry.artifacts.filter(a => a.logical_id === logicalId).map(a => Number(a.version)||0));
    const record = {logical_id:logicalId,version,role,file:path.relative(sceneDir,dest),sha256:digest,source_name:path.basename(source),actor:"filmmate-user"};
    registry.artifacts.push(record);
    return {...record,absolutePath:dest,url:pathToFileURL(dest).href};
  });
  fs.writeFileSync(registryPath, JSON.stringify(registry,null,2), "utf8");
  return added;
});

ipcMain.handle("asset:pick-preview-images", async (_event, project, scene, role) => {
  const {sceneDir} = resolveSceneTarget(project, scene);
  const assetFolder = findSceneAssetFolder(sceneDir);
  const defaultPath = assetFolder ? prepareUserAssetAccess(assetFolder.path, project, scene) : sceneDir;
  const normalizedRole = String(role || "prop").replace(/_reference$/, "") || "prop";
  const mediaFilter = normalizedRole === "motion"
    ? {name:"Previs video",extensions:["mp4","mov","m4v","webm","avi","mkv"]}
    : normalizedRole === "audio"
      ? {name:"Audio",extensions:["wav","mp3","m4a","aac","flac","ogg"]}
      : {name:"Images",extensions:["png","jpg","jpeg","webp"]};
  const selected = await dialog.showOpenDialog({defaultPath,properties:["openFile","multiSelections"],filters:[mediaFilter]});
  if (selected.canceled) return [];
  const bucket = path.join(sceneDir, "artifacts", "prompt_inputs", normalizedRole);
  fs.mkdirSync(bucket, {recursive:true});
  return selected.filePaths.map(source => {
    const bytes = fs.readFileSync(source);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const destination = path.join(bucket, `${digest.slice(0,16)}_${path.basename(source)}`);
    if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
    return {
      role: normalizedRole,
      name: path.basename(source),
      source_name: path.basename(source),
      sourcePath: source,
      absolutePath: destination,
      url: pathToFileURL(destination).href,
      type: path.extname(source).slice(1).toLowerCase() || "image",
      mediaType: normalizedRole === "motion" ? "video" : normalizedRole === "audio" ? "audio" : "image",
      sourceKind: normalizedRole === "motion" ? "previs" : "asset",
      sha256: digest,
      provenance: "FilmMate prompt input copy; original path retained in sourcePath",
    };
  });
});

ipcMain.handle("ai:open-block-library", async (_event, project, scene, blockId, model) => {
  const {sceneDir} = resolveSceneTarget(project, scene);
  const target = String(blockId || "");
  if (!target) throw new Error("target_not_selected");
  const modelName = String(model || "Seedance 2.0");
  const publicBlockRoot = userUploadBlockRoot(project, scene, modelName, target);
  const legacyUploadBlockRoot = path.join(legacyUserUploadRoot(project, scene, modelName), safeSlug(target));
  const legacyBlockRoot = path.join(sceneDir, ".hap", "previews", "block-libraries", safeSlug(target));
  const blockRoot = fs.existsSync(publicBlockRoot)
    ? publicBlockRoot
    : fs.existsSync(legacyUploadBlockRoot)
      ? legacyUploadBlockRoot
      : legacyBlockRoot;
  fs.mkdirSync(blockRoot, {recursive:true});
  const versions = fs.readdirSync(blockRoot, {withFileTypes:true})
    .filter(entry => entry.isDirectory() && /^v\d{3,}$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
  const folder = path.join(blockRoot, versions[0] || "");
  const openError = await openFolderForUser(folder);
  if (openError) throw new Error(openError);
  return {path:folder, blockId:target, model:modelName, version:versions[0] || null, preview:true, storage:blockRoot === publicBlockRoot ? "user" : blockRoot === legacyUploadBlockRoot ? "legacy-user" : "legacy"};
});

ipcMain.handle("ai:open-block-libraries", async (_event, project, scene, model) => {
  resolveSceneTarget(project, scene);
  const root = userUploadRoot(project, scene, model || "Seedance 2.0");
  fs.mkdirSync(root, {recursive:true});
  const openError = await openFolderForUser(root);
  if (openError) throw new Error(openError);
  return {path:root, model:String(model || "Seedance 2.0"), preview:true, storage:"user"};
});

ipcMain.handle("ai:save-upload-pack", async (_event, project, scene, config) => {
  const {sceneDir} = resolveSceneTarget(project, scene);
  const model = String(config?.model || "Seedance 2.5");
  const blocks = Array.isArray(config?.blocks) ? config.blocks : [];
  if (!blocks.length) throw new Error("upload_pack_blocks_missing");
  const invalidQa = blocks.filter(block => !block?.qa || !Array.isArray(block.qa.checks) || block.qa.status === "FAIL");
  if (invalidQa.length) throw new Error(`E_BLOCK_QA_FAILED:${invalidQa.map(block => block?.blockId || block?.block_id || "unknown").join(",")}`);
  const skillPolicy = assertSeedanceSkillBinding(config?.skillProvenance);
  blocks.forEach(block => assertSeedanceSkillBinding(block?.skillProvenance || config?.skillProvenance));
  const root = userUploadRoot(project, scene, model);
  fs.mkdirSync(root, {recursive:true});
  let version = 1;
  while (fs.existsSync(path.join(root, `v${String(version).padStart(3, "0")}`))) version += 1;
  const out = path.join(root, `v${String(version).padStart(3, "0")}`);
  const flatImages = path.join(out, "00_UPLOAD_ALL_IMAGES");
  const prompts = path.join(out, "00_PROMPTS");
  fs.mkdirSync(flatImages, {recursive:true});
  fs.mkdirSync(prompts, {recursive:true});
  const roleNames = {storyboard:"storyboard",character:"character",background:"background",prop:"prop"};
  const roleOrder = {storyboard:0,character:1,background:2,prop:3};
  const allMapping = [];
  const blockManifests = [];

  blocks.forEach((block, blockIndex) => {
    const blockId = String(block?.blockId || block?.block_id || `B${String(blockIndex + 1).padStart(2, "0")}`);
    const blockDir = path.join(out, safeSlug(blockId));
    fs.mkdirSync(blockDir, {recursive:true});
    const seenSources = new Set();
    const mapping = [];
    const items = [...(Array.isArray(block?.items) ? block.items : [])]
      .sort((a,b) => ((roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9)) || ((a.sequence ?? 999) - (b.sequence ?? 999)));
    items.forEach((item, index) => {
      const source = path.resolve(String(item?.absolutePath || ""));
      if (seenSources.has(source)) return;
      if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`missing_reference:${item?.name || index + 1}`);
      seenSources.add(source);
      const ext = path.extname(source).toLowerCase() || ".png";
      const role = roleNames[item?.role] || safeSlug(item?.role || "reference");
      const base = safeSlug(path.parse(item?.name || path.basename(source)).name) || "reference";
      const filename = `${String(mapping.length + 1).padStart(2, "0")}_${role}_${base}${ext}`;
      fs.copyFileSync(source, path.join(blockDir, filename));
      const flatFilename = `${safeSlug(blockId)}_${filename}`;
      fs.copyFileSync(source, path.join(flatImages, flatFilename));
      const bytes = fs.readFileSync(source);
      const record = {
        tag:`@Image ${mapping.length + 1}`,
        filename,
        flat_filename:flatFilename,
        role:item?.role || "reference",
        source_name:item?.name || path.basename(source),
        sha256:crypto.createHash("sha256").update(bytes).digest("hex"),
      };
      mapping.push(record);
      allMapping.push({block_id:blockId, ...record});
    });
    const promptBundle = writePromptLanguageFiles(blockDir, block, {activeFilename:"prompt.txt"});
    fs.copyFileSync(path.join(blockDir, promptBundle.activeFilename), path.join(prompts, `${safeSlug(blockId)}_prompt.txt`));
    const flatPromptFiles = {};
    for (const [language, filename] of Object.entries(promptBundle.promptFiles)) {
      const flatFilename = `${safeSlug(blockId)}_prompt.${language}.txt`;
      fs.copyFileSync(path.join(blockDir, filename), path.join(prompts, flatFilename));
      flatPromptFiles[language] = flatFilename;
    }
    fs.writeFileSync(path.join(blockDir, "BLOCK-QA.json"), JSON.stringify(block.qa, null, 2), "utf8");
    fs.writeFileSync(path.join(blockDir, "SEEDANCE-SKILL.json"), JSON.stringify(skillPolicy, null, 2), "utf8");
    const productionContract = block?.productionContract || {};
    fs.writeFileSync(path.join(blockDir, "PRODUCTION-CONTRACT.md"), String(productionContract.markdown || "# FilmMate production contract\n"), "utf8");
    const manifest = {
      schema_version:1,
      preview:true,
      canonical:false,
      model,
      unit_type:"block",
      block_id:blockId,
      block_duration_sec:Number(block?.durationSec ?? block?.duration_sec ?? 30),
      shot_ids:Array.isArray(block?.shotIds || block?.shot_ids) ? (block.shotIds || block.shot_ids) : [],
      references:mapping,
      prompt_file:promptBundle.activeFilename,
      selected_prompt_language:promptBundle.selectedLanguage,
      prompt_files:promptBundle.promptFiles,
      flat_prompt_files:flatPromptFiles,
      prompt_languages_file:promptBundle.manifestFilename,
      prompt_language_status:promptBundle.status,
      qa_file:"BLOCK-QA.json",
      qa_status:block.qa.status,
      skill_provenance_file:"SEEDANCE-SKILL.json",
      skill_bundle_sha256:skillPolicy.bundle_sha256,
      production_contract_file:"PRODUCTION-CONTRACT.md",
      created_at:new Date().toISOString(),
      note:"Seedance 블록별 업로드를 쉽게 하기 위한 작업용 묶음",
    };
    fs.writeFileSync(path.join(blockDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    const readme = [
      "FilmMate 업로드용 블록 폴더",
      `블록: ${blockId}`,
      `모델: ${model}`,
      `블록 길이: ${manifest.block_duration_sec}초`,
      manifest.shot_ids.length ? `포함 컷: ${manifest.shot_ids.join(" → ")}` : "",
      "",
      ...mapping.map(item => `${item.tag} = ${item.filename} (${item.role})`),
      "",
      "이 폴더의 이미지 순서와 prompt.txt를 함께 업로드하세요.",
      `언어별 원본: ${Object.entries(promptBundle.promptFiles).map(([language,filename])=>`${language}=${filename}`).join(" · ")}`,
    ].filter(Boolean).join("\n");
    fs.writeFileSync(path.join(blockDir, "00_README_블록_첨부순서.txt"), `${readme}\n`, "utf8");
    blockManifests.push({...manifest, folder:safeSlug(blockId)});
  });

  const rootReadme = [
    "FilmMate Seedance 업로드 묶음",
    `모델: ${model}`,
    `블록 수: ${blockManifests.length}`,
    "",
    "권장: 각 블록 폴더(SD25_B01 등)를 열어 그 안의 이미지와 prompt.txt를 함께 업로드하세요.",
    "일괄 선택이 필요하면 00_UPLOAD_ALL_IMAGES 폴더의 이미지를 사용하고, 00_PROMPTS에서 해당 블록의 프롬프트를 선택하세요.",
    "블록 폴더 내부의 @Image 순서와 prompt.txt의 참조 순서를 유지하세요.",
    "",
    ...blockManifests.map(block => `${block.block_id}: ${block.block_duration_sec}초 · ${block.shot_ids.join(" → ")}`),
  ].filter(Boolean).join("\n");
  fs.writeFileSync(path.join(out, "00_README_업로드_순서.txt"), `${rootReadme}\n`, "utf8");
  const packQa = config?.qa || {status:blockManifests.some(block => block.qa_status === "WARN") ? "WARN" : "PASS",blocks:blockManifests.map(block => ({block_id:block.block_id,status:block.qa_status}))};
  fs.writeFileSync(path.join(out, "00_BLOCK-QA.json"), JSON.stringify(packQa, null, 2), "utf8");
  fs.writeFileSync(path.join(out, "00_SEEDANCE-SKILL.json"), JSON.stringify(skillPolicy, null, 2), "utf8");
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({schema_version:1,preview:true,canonical:false,model,unit_type:"block",version,qa_status:packQa.status,qa_file:"00_BLOCK-QA.json",skill_provenance_file:"00_SEEDANCE-SKILL.json",skill_bundle_sha256:skillPolicy.bundle_sha256,blocks:blockManifests,all_images:allMapping,created_at:new Date().toISOString()}, null, 2), "utf8");
  const openError = await openFolderForUser(out);
  if (openError) throw new Error(openError);
  return {path:out,version,model,blockCount:blockManifests.length,imageCount:allMapping.length,preview:true};
});

ipcMain.handle("ai:save-block-library", async (_event, project, scene, config) => {
  const {projectDir, sceneDir} = resolveSceneTarget(project, scene);
  const targetId = String(config?.targetId || "");
  if (!targetId) throw new Error("target_not_selected");
  if (config?.unitType !== "block") throw new Error("E_BLOCK_LIBRARY_REQUIRES_BLOCK");
  if (!config?.qa || !Array.isArray(config.qa.checks)) throw new Error("E_BLOCK_QA_REQUIRED");
  if (config.qa.status === "FAIL") throw new Error("E_BLOCK_QA_FAILED");
  const skillPolicy = assertSeedanceSkillBinding(config?.skillProvenance);
  const model = String(config?.model || "Seedance 2.0");
  const blockRoot = userUploadBlockRoot(project, scene, model, targetId);
  fs.mkdirSync(blockRoot, {recursive:true});
  let version = 1;
  while (fs.existsSync(path.join(blockRoot, `v${String(version).padStart(3, "0")}`))) version += 1;
  const out = path.join(blockRoot, `v${String(version).padStart(3, "0")}`);
  fs.mkdirSync(out, {recursive:true});

  const roleNames = {storyboard:"storyboard",character:"character",background:"background",prop:"prop"};
  const roleOrder = {storyboard:0,character:1,background:2,prop:3};
  const items = [...(config?.items || [])].sort((a,b) => {
    const roleDiff = (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9);
    return roleDiff || ((a.sequence ?? 999) - (b.sequence ?? 999));
  });
  const mapping = [];
  items.forEach((item, index) => {
    const source = path.resolve(String(item.absolutePath || ""));
    if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`missing_reference:${item.name || index + 1}`);
    const ext = path.extname(source).toLowerCase() || ".png";
    const role = roleNames[item.role] || safeSlug(item.role || "reference");
    const base = safeSlug(path.parse(item.name || path.basename(source)).name);
    const filename = `${String(index + 1).padStart(2, "0")}_${role}_${base}${ext}`;
    fs.copyFileSync(source, path.join(out, filename));
    const bytes = fs.readFileSync(source);
    mapping.push({
      tag:`@Image ${index + 1}`,
      filename,
      role:item.role || "reference",
      source_name:item.name || path.basename(source),
      sha256:crypto.createHash("sha256").update(bytes).digest("hex"),
      source_path:source,
    });
  });

  const promptBundle = writePromptLanguageFiles(out, config, {activeFilename:"prompt.txt"});
  const prompt = promptBundle.activePrompt;
  fs.writeFileSync(path.join(out, "BLOCK-QA.json"), JSON.stringify(config.qa, null, 2), "utf8");
  fs.writeFileSync(path.join(out, "SEEDANCE-SKILL.json"), JSON.stringify(skillPolicy, null, 2), "utf8");
  fs.writeFileSync(path.join(out, "PRODUCTION-CONTRACT.md"), String(config?.productionContract?.markdown || "# FilmMate production contract\n"), "utf8");
  const projectionPath = path.join(projectDir, ".hap", "projection.json");
  const projectionBytes = fs.existsSync(projectionPath) ? fs.readFileSync(projectionPath) : null;
  const projection = projectionBytes ? readJson(projectionPath) : null;
  const blockEntity = (projection?.entities || []).find(entity => entity.entity_type === "block");
  const manifest = {
    schema_version:1,
    preview:true,
    canonical:false,
    project:String(project),
    scene:String(scene),
    unit_type:"block",
    block_id:targetId,
    model,
    block_duration_sec:model === "Seedance 2.5" ? 30 : 15,
    shot_ids:Array.isArray(config?.shotIds) ? config.shotIds : [],
    source_evidence:[
      {kind:"hap_projection", path:path.relative(projectDir, projectionPath), sha256:projectionBytes ? crypto.createHash("sha256").update(projectionBytes).digest("hex") : null},
      {kind:"block_entity", entity_id:blockEntity?.entity_id || null, revision_id:blockEntity?.current_revision?.revision_id || null},
      {kind:"conhap_directory", path:path.join(String(config?.conhapDir || "conhap-v3"), "blocks.jsonl")},
    ],
    references:mapping,
    prompt_file:promptBundle.activeFilename,
    selected_prompt_language:promptBundle.selectedLanguage,
    prompt_files:promptBundle.promptFiles,
    prompt_languages_file:promptBundle.manifestFilename,
    prompt_language_status:promptBundle.status,
    qa_file:"BLOCK-QA.json",
    qa_status:config.qa.status,
    skill_provenance_file:"SEEDANCE-SKILL.json",
    skill_bundle_sha256:skillPolicy.bundle_sha256,
    production_contract_file:"PRODUCTION-CONTRACT.md",
    prompt_sha256:crypto.createHash("sha256").update(prompt, "utf8").digest("hex"),
    created_at:new Date().toISOString(),
    note:"HAP 정본을 변경하지 않는 블록별 작업용 프리뷰 라이브러리",
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const readme = [
    "FilmMate 블록 작업 라이브러리 · preview",
    `블록: ${targetId}`,
    `모델: ${manifest.model}`,
    `블록 길이: ${manifest.block_duration_sec}초`,
    config?.shotIds?.length ? `포함 컷: ${config.shotIds.join(" → ")}` : "",
    "",
    ...mapping.map(item => `${item.tag} = ${item.filename} (${item.role})`),
    "",
    "prompt.txt와 이미지 첨부 순서를 함께 보관합니다.",
    `언어별 원본: ${Object.entries(promptBundle.promptFiles).map(([language,filename])=>`${language}=${filename}`).join(" · ")}`,
    "이 폴더는 HAP 정본·QA·승인 상태를 변경하지 않는 작업용 프리뷰입니다.",
  ].filter(Boolean).join("\n");
  fs.writeFileSync(path.join(out, "00_README_블록_첨부순서.txt"), `${readme}\n`, "utf8");
  const openError = await openFolderForUser(out);
  if (openError) throw new Error(openError);
  return {path:out, version, blockId:targetId, mapping, preview:true, canonical:false};
});

ipcMain.handle("ai:export-package", async (_event, project, scene, config) => {
  const {projectDir, sceneDir} = resolveSceneTarget(project, scene);
  if (fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("E_PROMPT_HAP_REQUIRED: HAP 프로젝트는 Prompt IR 검증과 release gate를 통과해야 패키지를 내보낼 수 있습니다.");
  const unitType = config.unitType === "block" ? "block" : "shot";
  const targetId = config.targetId || config.shotId;
  if (!targetId) throw new Error("target_not_selected");
  const skillPolicy = assertSeedanceSkillBinding(config?.skillProvenance);
  const root = path.join(sceneDir, "previews", "legacy-ai-input", safeSlug(config.model), `${unitType}s`, safeSlug(targetId));
  fs.mkdirSync(root, {recursive:true});
  let version = 1;
  while (fs.existsSync(path.join(root, `v${String(version).padStart(3,"0")}`))) version += 1;
  const out = path.join(root, `v${String(version).padStart(3,"0")}`);
  fs.mkdirSync(out, {recursive:true});
  const roleNames = {storyboard:"storyboard",character:"character",background:"location",prop:"props"};
  const mapping = [];
  const roleOrder = {storyboard:0,character:1,background:2,prop:3};
  let packageItems = [...(config.items || [])];
  if (unitType === "block") {
    const storyboards = packageItems.filter(item => item.role === "storyboard").sort((a,b)=>(a.sequence??999)-(b.sequence??999));
    if (storyboards.length) {
      const sourceDir = path.join(out, "source-storyboards");
      fs.mkdirSync(sourceDir, {recursive:true});
      storyboards.forEach((item,index)=>fs.copyFileSync(path.resolve(item.absolutePath),path.join(sourceDir,`${String(index+1).padStart(2,"0")}_${path.basename(item.absolutePath)}`)));
      const combined = path.join(out, "01_storyboard_combined.png");
      await composeStoryboardSheet(storyboards, combined);
      packageItems = [{role:"storyboard",name:`${targetId}_storyboard_combined.png`,absolutePath:combined,sequence:0},...packageItems.filter(item=>item.role!=="storyboard")];
    }
  }
  const orderedItems = packageItems.sort((a,b)=>{
    const roleDiff = (roleOrder[a.role]??9)-(roleOrder[b.role]??9);
    if (roleDiff) return roleDiff;
    return (a.sequence ?? 999) - (b.sequence ?? 999);
  });
  orderedItems.forEach((item,index) => {
    const source = path.resolve(item.absolutePath || "");
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`missing_reference:${item.name}`);
    const ext = path.extname(source).toLowerCase() || ".png";
    const filename = unitType === "block" && item.role === "storyboard" ? "01_storyboard_combined.png" : `${String(index+1).padStart(2,"0")}_${roleNames[item.role]||safeSlug(item.role)}${ext}`;
    if (path.resolve(path.join(out, filename)) !== source) fs.copyFileSync(source, path.join(out, filename));
    mapping.push({tag:`@Image ${index+1}`,filename,role:item.role,source:item.name});
  });
  const unitLabel = unitType === "block" ? "15초 블록" : "컷";
  const readme = [`모델: ${config.model}`,`${unitLabel}: ${targetId}`,config.shotIds?.length ? `포함 컷: ${config.shotIds.join(" → ")}` : "","",...mapping.map(x=>`${x.tag} = ${x.filename} (${x.role})`),"","위 번호 순서대로 이미지를 첨부하세요."].filter(Boolean).join("\n");
  fs.writeFileSync(path.join(out,"00_README_첨부순서.txt"),readme,"utf8");
  const promptBase = `${safeSlug(targetId)}_${safeSlug(config.model)}_prompt`;
  const promptBundle = writePromptLanguageFiles(out, config, {activeFilename:`${promptBase}.txt`});
  fs.writeFileSync(path.join(out,"SEEDANCE-SKILL.json"),JSON.stringify(skillPolicy,null,2),"utf8");
  fs.writeFileSync(path.join(out,"package.json"),JSON.stringify({...config,prompt:promptBundle.activePrompt,version,mapping,prompt_file:promptBundle.activeFilename,selected_prompt_language:promptBundle.selectedLanguage,prompt_files:promptBundle.promptFiles,prompt_languages_file:promptBundle.manifestFilename,prompt_language_status:promptBundle.status,skill_provenance_file:"SEEDANCE-SKILL.json",skill_bundle_sha256:skillPolicy.bundle_sha256,ready_claim:false,legacy_preview:true,created_at:new Date().toISOString()},null,2),"utf8");
  shell.showItemInFolder(out);
  return {path:out,version,mapping};
});

ipcMain.handle("scene:compile-workspace", async (_event, project, scene) => {
  const {projectDir} = resolveSceneTarget(project, scene);
  if (fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("E_CANONICAL_WRITE_REQUIRED: 레거시 workspace compiler는 HAP 프로젝트를 수정할 수 없습니다.");
  const script = path.join(ROOT, "workspace_compiler.py");
  const run = await pythonBridge.runPythonAsync(script, [project, scene]);
  try {
    return JSON.parse(String(run.stdout || "").trim());
  } catch {
    throw new Error(`E_WORKSPACE_COMPILE_RESPONSE_INVALID:${String(run.stdout || "").trim().slice(0, 500)}`);
  }
});

ipcMain.handle("project:create", async (_event, title, screenplay) => {
  const analysis = analyzeScreenplay(screenplay || "");
  if (!analysis.scenes.length) throw new Error("씬 헤딩을 찾지 못했습니다");
  const slug = String(title || "untitled").replace(/[^0-9A-Za-z가-힣._-]+/g, "_").replace(/^_+|_+$/g, "") || "untitled";
  let name = `PROJECT_${slug}`, n = 2;
  while (fs.existsSync(path.join(PACKAGES, name))) name = `PROJECT_${slug}_${n++}`;
  const projectDir = path.join(PACKAGES, name);
  fs.mkdirSync(path.join(projectDir, "input", "screenplay"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "scene-data"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "input", "screenplay", "screenplay-pasted.txt"), screenplay, "utf8");
  const rootManifest = { schema_version:"1.0", package_type:"project", title:title||slug, created_at:new Date().toISOString(), scene_hints:analysis.scenes.map(({source_text,...scene})=>scene), pipeline:{scene_segmentation:"legacy_claim",text_conti:"pending",assets:"pending",storyboard:"pending",prompts:"pending",qa:"pending",package:"pending"}, read_only_projection:true };
  fs.writeFileSync(path.join(projectDir, "scene-data", "scene-manifest.json"), JSON.stringify(rootManifest,null,2), "utf8");
  for (const scene of analysis.scenes) {
    const sceneDir = path.join(projectDir, "scenes", `${scene.scene_id}_${scene.title.replace(/[^0-9A-Za-z가-힣._-]+/g,"_")}`);
    fs.mkdirSync(path.join(sceneDir, "scene-data"), { recursive:true });
    fs.writeFileSync(path.join(sceneDir, "input-screenplay.txt"), scene.source_text, "utf8");
    fs.writeFileSync(path.join(sceneDir, "scene-data", "scene-manifest.json"), JSON.stringify({schema_version:"1.0",package_type:"scene",scene_id:scene.scene_id,title:scene.title,location:scene.location,time:scene.time,scene_duration:`${scene.estimated_duration_sec}s`,block_duration:"15초",source_span:{start:scene.source_start,end:scene.source_end},pipeline:{analysis:"legacy_claim",text_conti:"pending",assets:"pending",storyboard:"pending",prompts:"pending",qa:"pending"},read_only_projection:true},null,2), "utf8");
  }
  try {
    await runHapAsync(projectDir, ["init", projectDir, "--title", title || slug]);
    for (const scene of analysis.scenes) {
      const sceneName = `${scene.scene_id}_${scene.title.replace(/[^0-9A-Za-z가-힣._-]+/g,"_")}`;
      const sceneDir = path.join(projectDir,"scenes",sceneName);
      const entityId = `scene:${scene.scene_id}`;
      await runHapAsync(projectDir, ["add-entity", projectDir, "--type", "scene", "--key", scene.scene_id, "--entity-id", entityId, "--parent", `project:${name}`]);
      const payload = JSON.stringify({scene_id:scene.scene_id,title:scene.title,location:scene.location,time:scene.time,source_span:[scene.source_start,scene.source_end]});
      const evidence = JSON.stringify([{kind:"source_span",artifact:"input/screenplay/screenplay-pasted.txt",start:scene.source_start,end:scene.source_end}]);
      await runHapAsync(projectDir, ["commit", projectDir, "--entity", entityId, "--producer", "filmmate-importer", "--payload", payload, "--evidence", evidence]);
      await runHapAsync(projectDir, ["add-artifact", projectDir, "--revision", `${entityId}@1`, "--kind", "screenplay", "--file", path.join(sceneDir,"input-screenplay.txt")]);
    }
    const codexSources = await connectCodexSources(projectDir);
    return { id:name, title:title||slug, scene_count:analysis.scene_count, codex_sources:codexSources };
  } catch (error) {
    try { fs.rmSync(projectDir, {recursive:true, force:true}); } catch { /* best effort rollback */ }
    throw new Error(`E_PROJECT_CREATE_FAILED:${error?.message || error}`);
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0d0f12",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
