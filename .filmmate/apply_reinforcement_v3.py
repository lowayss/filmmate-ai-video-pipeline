from pathlib import Path

path = Path("desktop/main.cjs")
text = path.read_text(encoding="utf-8")

replacements = [
    (
'''function runHap(projectDir, args) {
  return pythonBridge.runHap(projectDir, args);
}

function runDocumentBridge(command, payload) {
  return pythonBridge.runDocumentBridge(command, payload);
}

function connectCodexSources(projectDir) {
  const connected = [];
  for (const source of CODEX_SOURCES) {
    const sourcePath = path.join(CODEX_SKILL_ROOT, source.key);
    const output = runHap(projectDir, ["link-source", projectDir, "--path", sourcePath, "--label", source.label, "--kind", source.kind, ...(source.required ? ["--required"] : []), "--source-id", `codex:${source.key}`]);
    connected.push({ key: source.key, path: sourcePath, source_id: output });
  }
  const checked = runHap(projectDir, ["check-sources", projectDir]);
  return { connected, check: JSON.parse(checked) };
}
''',
'''function runHap(projectDir, args) {
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
'''),
    (
'''ipcMain.handle("project:connect-codex-sources", (_event, project) => {
  let projectDir;
  try { projectDir = projectPaths.resolveHapProject(project); }
  catch { throw new Error("hap_project_not_found"); }
  return connectCodexSources(projectDir);
});''',
'''ipcMain.handle("project:connect-codex-sources", async (_event, project) => {
  let projectDir;
  try { projectDir = projectPaths.resolveHapProject(project); }
  catch { throw new Error("hap_project_not_found"); }
  return await connectCodexSources(projectDir);
});'''),
    (
'''ipcMain.handle("scene:detail", (_event, project, scene) => {''',
'''ipcMain.handle("scene:detail", async (_event, project, scene) => {'''),
    (
'''    ? runDocumentBridge("read", {project_root:projectDir, scene})''',
'''    ? await runDocumentBridgeAsync("read", {project_root:projectDir, scene})'''),
    (
'''ipcMain.handle("scene:save-document", (_event, project, scene, request) => {''',
'''ipcMain.handle("scene:save-document", async (_event, project, scene, request) => {'''),
    (
'''  return runDocumentBridge("save", {''',
'''  return await runDocumentBridgeAsync("save", {'''),
    (
'''ipcMain.handle("scene:compile-workspace", (_event, project, scene) => {
  const {projectDir} = resolveSceneTarget(project, scene);
  if (fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("E_CANONICAL_WRITE_REQUIRED: 레거시 workspace compiler는 HAP 프로젝트를 수정할 수 없습니다.");
  const script = path.join(ROOT, "workspace_compiler.py");
  const python = process.env.FILMMATE_PYTHON || process.env.SCENEFLOW_PYTHON || "/opt/homebrew/bin/python3";
  const run = childProcess.spawnSync(python, [script, project, scene], { encoding: "utf8" });
  if (run.status !== 0) throw new Error((run.stderr || "workspace_compile_failed").trim());
  return JSON.parse(run.stdout);
});''',
'''ipcMain.handle("scene:compile-workspace", async (_event, project, scene) => {
  const {projectDir} = resolveSceneTarget(project, scene);
  if (fs.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) throw new Error("E_CANONICAL_WRITE_REQUIRED: 레거시 workspace compiler는 HAP 프로젝트를 수정할 수 없습니다.");
  const script = path.join(ROOT, "workspace_compiler.py");
  const run = await pythonBridge.runPythonAsync(script, [project, scene]);
  try {
    return JSON.parse(String(run.stdout || "").trim());
  } catch {
    throw new Error(`E_WORKSPACE_COMPILE_RESPONSE_INVALID:${String(run.stdout || "").trim().slice(0, 500)}`);
  }
});'''),
    (
'''ipcMain.handle("project:create", (_event, title, screenplay) => {''',
'''ipcMain.handle("project:create", async (_event, title, screenplay) => {'''),
    (
'''  const hapScript = hapScriptPath();
  const python = process.env.FILMMATE_PYTHON || process.env.SCENEFLOW_PYTHON || "/usr/bin/python3";
  const init = childProcess.spawnSync(python, [hapScript,"init",projectDir,"--title",title||slug], {encoding:"utf8"});
  if (init.status !== 0) throw new Error(`HAP 초기화 실패: ${(init.stderr||init.stdout||"").trim()}`);
  for (const scene of analysis.scenes) {
    const sceneName = `${scene.scene_id}_${scene.title.replace(/[^0-9A-Za-z가-힣._-]+/g,"_")}`;
    const sceneDir = path.join(projectDir,"scenes",sceneName);
    const entityId = `scene:${scene.scene_id}`;
    const add = childProcess.spawnSync(python,[hapScript,"add-entity",projectDir,"--type","scene","--key",scene.scene_id,"--entity-id",entityId,"--parent",`project:${name}`],{encoding:"utf8"});
    if (add.status !== 0) throw new Error(`HAP 씬 등록 실패: ${(add.stderr||add.stdout||"").trim()}`);
    const payload = JSON.stringify({scene_id:scene.scene_id,title:scene.title,location:scene.location,time:scene.time,source_span:[scene.source_start,scene.source_end]});
    const evidence = JSON.stringify([{kind:"source_span",artifact:"input/screenplay/screenplay-pasted.txt",start:scene.source_start,end:scene.source_end}]);
    const commit = childProcess.spawnSync(python,[hapScript,"commit",projectDir,"--entity",entityId,"--producer","filmmate-importer","--payload",payload,"--evidence",evidence],{encoding:"utf8"});
    if (commit.status !== 0) throw new Error(`HAP 씬 리비전 실패: ${(commit.stderr||commit.stdout||"").trim()}`);
    const artifact = childProcess.spawnSync(python,[hapScript,"add-artifact",projectDir,"--revision",`${entityId}@1`,"--kind","screenplay","--file",path.join(sceneDir,"input-screenplay.txt")],{encoding:"utf8"});
    if (artifact.status !== 0) throw new Error(`HAP 원문 등록 실패: ${(artifact.stderr||artifact.stdout||"").trim()}`);
  }
  const codexSources = connectCodexSources(projectDir);
  return { id:name, title:title||slug, scene_count:analysis.scene_count, codex_sources:codexSources };''',
'''  try {
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
  }'''),
]

for index, (old, new) in enumerate(replacements, 1):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"replacement {index} expected exactly once, found {count}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
print(f"applied {len(replacements)} verified replacements")
