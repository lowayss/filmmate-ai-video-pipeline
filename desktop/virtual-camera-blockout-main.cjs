const fs = require("node:fs");
const path = require("node:path");
const {app, ipcMain, BrowserWindow, shell} = require("electron");
const {createProjectPathResolver} = require("./project-paths.cjs");
const math = require("./virtual-camera-blockout-math.js");

let installed = false;
let activeRecording = null;
const MAX_FRAMES = 18000;
const MIN_FRAME_INTERVAL_MS = 24;

function workspaceRoot() {
  const documentsWorkspace = path.join(app.getPath("documents"), "영화작업용", "scene-package-builder");
  return fs.existsSync(documentsWorkspace) ? documentsWorkspace : path.resolve(__dirname, "..");
}

function resolveScene(project, scene) {
  return createProjectPathResolver(path.join(workspaceRoot(), "packages")).resolveScene(project, scene);
}

function safeShot(value) {
  return String(value || "C01").replace(/[^0-9A-Za-z가-힣._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "C01";
}

function rootDir(sceneDir) {
  return path.join(sceneDir, "previews", "virtual-camera-blockout");
}

function layoutFile(sceneDir) {
  return path.join(rootDir(sceneDir), "blockout.json");
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function notify(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function loadBlockout(project, scene) {
  const {sceneDir} = resolveScene(project, scene);
  try {
    const parsed = JSON.parse(fs.readFileSync(layoutFile(sceneDir), "utf8"));
    return math.sanitizeBlockoutState(parsed);
  } catch {
    return math.defaultBlockout();
  }
}

function saveBlockout(project, scene, input) {
  const {sceneDir} = resolveScene(project, scene);
  const state = math.sanitizeBlockoutState(input);
  const payload = {...state, updated_at:new Date().toISOString()};
  atomicJson(layoutFile(sceneDir), payload);
  notify("virtual-camera-blockout:layout", payload);
  return payload;
}

function nextTakeNumber(sceneDir, shotId) {
  const dir = path.join(rootDir(sceneDir), safeShot(shotId));
  if (!fs.existsSync(dir)) return 1;
  const numbers = fs.readdirSync(dir)
    .map(name => name.match(/^camera_take_(\d{3})\.json$/))
    .filter(Boolean)
    .map(match => Number(match[1]));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

function publicStatus() {
  if (!activeRecording) return {recording:false};
  return {
    recording:true,
    project:activeRecording.project,
    scene:activeRecording.scene,
    shot_id:activeRecording.shotId,
    frame_count:activeRecording.frames.length,
    started_at:activeRecording.startedAt,
  };
}

function startTake(project, scene, request = {}) {
  if (activeRecording) throw new Error("blockout_camera_already_recording");
  resolveScene(project, scene);
  activeRecording = {
    project,
    scene,
    shotId:safeShot(request.shotId),
    startedAt:new Date().toISOString(),
    frames:[],
    lastClientTime:-Infinity,
  };
  const status = publicStatus();
  notify("virtual-camera-blockout:status", status);
  return status;
}

function appendFrame(input) {
  if (!activeRecording) return {accepted:false, reason:"not_recording"};
  if (activeRecording.frames.length >= MAX_FRAMES) return {accepted:false, reason:"frame_limit"};
  const frame = math.sanitizeCameraFrame(input || {});
  const clientTime = Number(frame.client_time_ms || 0);
  if (clientTime && clientTime - activeRecording.lastClientTime < MIN_FRAME_INTERVAL_MS) {
    return {accepted:false, reason:"throttled"};
  }
  if (clientTime) activeRecording.lastClientTime = clientTime;
  activeRecording.frames.push(frame);
  if (activeRecording.frames.length % 12 === 0) notify("virtual-camera-blockout:status", publicStatus());
  return {accepted:true, frame_count:activeRecording.frames.length};
}

function stopTake() {
  if (!activeRecording) throw new Error("blockout_camera_not_recording");
  const recording = activeRecording;
  activeRecording = null;
  const {sceneDir} = resolveScene(recording.project, recording.scene);
  const takeNumber = nextTakeNumber(sceneDir, recording.shotId);
  const analysis = math.summarizeCameraPath(recording.frames);
  const take = {
    schema_version:1,
    preview:true,
    canonical:false,
    source:"virtual-camera-blockout-v4",
    shot_id:recording.shotId,
    take_number:takeNumber,
    started_at:recording.startedAt,
    stopped_at:new Date().toISOString(),
    frame_count:recording.frames.length,
    metric:analysis.metric === true,
    analysis,
    blockout_snapshot:loadBlockout(recording.project, recording.scene),
    camera_frames:recording.frames,
  };
  const output = path.join(rootDir(sceneDir), recording.shotId, `camera_take_${String(takeNumber).padStart(3, "0")}.json`);
  atomicJson(output, take);
  const compact = {...take, path:output, camera_frames:undefined, blockout_snapshot:undefined};
  notify("virtual-camera-blockout:take", compact);
  notify("virtual-camera-blockout:status", publicStatus());
  return compact;
}

function listTakes(project, scene) {
  const {sceneDir} = resolveScene(project, scene);
  const root = rootDir(sceneDir);
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const shot of fs.readdirSync(root, {withFileTypes:true})) {
    if (!shot.isDirectory()) continue;
    const dir = path.join(root, shot.name);
    for (const name of fs.readdirSync(dir).filter(file => /^camera_take_\d{3}\.json$/.test(file))) {
      try {
        const take = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        rows.push({
          shot_id:take.shot_id,
          take_number:take.take_number,
          frame_count:take.frame_count,
          metric:take.metric,
          analysis:take.analysis,
          stopped_at:take.stopped_at,
          path:path.join(dir, name),
        });
      } catch {}
    }
  }
  return rows.sort((a,b) => String(b.stopped_at || "").localeCompare(String(a.stopped_at || "")));
}

async function openFolder(project, scene) {
  const {sceneDir} = resolveScene(project, scene);
  const dir = rootDir(sceneDir);
  fs.mkdirSync(dir, {recursive:true});
  const error = await shell.openPath(dir);
  if (error) throw new Error(error);
  return true;
}

function installVirtualCameraBlockout() {
  if (installed) return;
  installed = true;
  ipcMain.handle("virtual-camera-blockout:load", (_event, project, scene) => loadBlockout(project, scene));
  ipcMain.handle("virtual-camera-blockout:save", (_event, project, scene, state) => saveBlockout(project, scene, state));
  ipcMain.handle("virtual-camera-blockout:status", () => publicStatus());
  ipcMain.handle("virtual-camera-blockout:start-take", (_event, project, scene, request) => startTake(project, scene, request));
  ipcMain.handle("virtual-camera-blockout:append-frame", (_event, frame) => appendFrame(frame));
  ipcMain.handle("virtual-camera-blockout:stop-take", () => stopTake());
  ipcMain.handle("virtual-camera-blockout:list-takes", (_event, project, scene) => listTakes(project, scene));
  ipcMain.handle("virtual-camera-blockout:open-folder", (_event, project, scene) => openFolder(project, scene));
  app.once("before-quit", () => { activeRecording = null; });
}

module.exports = {installVirtualCameraBlockout};
