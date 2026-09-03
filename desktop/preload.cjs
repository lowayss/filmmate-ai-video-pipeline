const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("sceneFlow", {
  projects: () => ipcRenderer.invoke("projects:list"),
  sceneDetail: (project, scene) => ipcRenderer.invoke("scene:detail", project, scene),
  saveSceneDocument: (project, scene, request) => ipcRenderer.invoke("scene:save-document", project, scene, request),
  seedanceSkillPolicy: () => ipcRenderer.invoke("prompt:seedance-skill-policy"),
  syncPromptHandoff: payload => ipcRenderer.invoke("prompt:sync-handoff", payload),
  startCodexPrompt: (project, jobId, skillProvenance) => ipcRenderer.invoke("prompt:start-codex", project, jobId, skillProvenance),
  getPromptJob: (project, jobId) => ipcRenderer.invoke("prompt:get-job", project, jobId),
  cancelPromptJob: (project, jobId) => ipcRenderer.invoke("prompt:cancel-job", project, jobId),
  approvePromptJob: (project, jobId, evidence) => ipcRenderer.invoke("prompt:approve-job", project, jobId, evidence),
  promptHistory: (project, scene) => ipcRenderer.invoke("prompt:history", project, scene),
  createProject: (title, screenplay) => ipcRenderer.invoke("project:create", title, screenplay),
  connectCodexSources: project => ipcRenderer.invoke("project:connect-codex-sources", project),
  deleteProject: project => ipcRenderer.invoke("project:delete", project),
  compileWorkspace: (project, scene) => ipcRenderer.invoke("scene:compile-workspace", project, scene),
  pickImages: (project, scene, role) => ipcRenderer.invoke("asset:pick-images", project, scene, role),
  pickPreviewImages: (project, scene, role) => ipcRenderer.invoke("asset:pick-preview-images", project, scene, role),
  openAssetsFolder: (project, scene, blockId, model, items) => ipcRenderer.invoke("scene:open-assets-folder", project, scene, blockId, model, items),
  openBlockLibrary: (project, scene, block, model) => ipcRenderer.invoke("ai:open-block-library", project, scene, block, model),
  openBlockLibraries: (project, scene, model) => ipcRenderer.invoke("ai:open-block-libraries", project, scene, model),
  saveBlockLibrary: (project, scene, config) => ipcRenderer.invoke("ai:save-block-library", project, scene, config),
  saveUploadPack: (project, scene, config) => ipcRenderer.invoke("ai:save-upload-pack", project, scene, config),
  copyImage: source => ipcRenderer.invoke("image:copy-to-clipboard", source),
  composeBlockStoryboard: (project, scene, block, items) => ipcRenderer.invoke("storyboard:compose-block", project, scene, block, items),
  saveBlockStoryboard: (project, scene, block, dataUrl) => ipcRenderer.invoke("storyboard:save-composite", project, scene, block, dataUrl),
  exportAiPackage: (project, scene, config) => ipcRenderer.invoke("ai:export-package", project, scene, config),
  runProductionAgent: (project, scene, request) => ipcRenderer.invoke("production-agent:run", project, scene, request),
  startProductionRun: (project, scene, request) => ipcRenderer.invoke("production-agent:start-run", project, scene, request),
  getProductionRun: (project, scene, runId) => ipcRenderer.invoke("production-agent:get-run", project, scene, runId),
  controlProductionRun: (project, scene, request) => ipcRenderer.invoke("production-agent:control-run", project, scene, request),
  startProductionWorker: (project, scene, runId) => ipcRenderer.invoke("production-agent:start-worker", project, scene, runId),
  cancelProductionWorker: runId => ipcRenderer.invoke("production-agent:cancel-worker", runId),
  productionWorkerStatus: runId => ipcRenderer.invoke("production-agent:worker-status", runId),
  onProductionAgentWorkerEvent: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("production-agent:worker-event", handler);
    return () => ipcRenderer.removeListener("production-agent:worker-event", handler);
  },
});

contextBridge.exposeInMainWorld("virtualCamera", {
  startSession: (project, scene) => ipcRenderer.invoke("virtual-camera:start-session", project, scene),
  stopSession: () => ipcRenderer.invoke("virtual-camera:stop-session"),
  status: () => ipcRenderer.invoke("virtual-camera:status"),
  startRecording: request => ipcRenderer.invoke("virtual-camera:start-recording", request),
  stopRecording: () => ipcRenderer.invoke("virtual-camera:stop-recording"),
  listTakes: (project, scene) => ipcRenderer.invoke("virtual-camera:list-takes", project, scene),
  selectTake: (project, scene, shotId, takeNumber) => ipcRenderer.invoke("virtual-camera:select-take", project, scene, shotId, takeNumber),
  openFolder: (project, scene) => ipcRenderer.invoke("virtual-camera:open-folder", project, scene),
  copyText: text => ipcRenderer.invoke("virtual-camera:copy-text", text),
  onSample: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("virtual-camera:sample", handler);
    return () => ipcRenderer.removeListener("virtual-camera:sample", handler);
  },
  onStatus: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("virtual-camera:status", handler);
    return () => ipcRenderer.removeListener("virtual-camera:status", handler);
  },
  onTake: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("virtual-camera:take", handler);
    return () => ipcRenderer.removeListener("virtual-camera:take", handler);
  },
});

window.addEventListener("DOMContentLoaded", () => {
  const styles = [
    ["./virtual-camera-ui.css", "base"],
    ["./virtual-camera-pose.css", "pose"],
  ];
  for (const [href, key] of styles) {
    if (document.querySelector(`link[data-filmmate-vcam-style="${key}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.filmmateVcamStyle = key;
    document.head.appendChild(link);
  }
  const scripts = [
    ["./virtual-camera-ui.js", "base"],
    ["./virtual-camera-pose-ui.js", "pose"],
  ];
  for (const [src, key] of scripts) {
    if (document.querySelector(`script[data-filmmate-vcam-script="${key}"]`)) continue;
    const script = document.createElement("script");
    script.src = src;
    script.dataset.filmmateVcamScript = key;
    document.body.appendChild(script);
  }
});
