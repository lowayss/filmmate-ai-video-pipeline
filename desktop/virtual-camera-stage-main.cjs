const fs = require("node:fs");
const path = require("node:path");
const {app, ipcMain, shell} = require("electron");
const {createProjectPathResolver} = require("./project-paths.cjs");
const stage = require("./virtual-camera-stage-engine.js");

let installed = false;
const MAX_PATH_SAMPLES = 12000;

function workspaceRoot() {
  const documentsWorkspace = path.join(app.getPath("documents"), "영화작업용", "scene-package-builder");
  return fs.existsSync(documentsWorkspace) ? documentsWorkspace : path.resolve(__dirname, "..");
}
function resolveScene(project, scene) { return createProjectPathResolver(path.join(workspaceRoot(), "packages")).resolveScene(project, scene); }
function rootFor(sceneDir) { return path.join(sceneDir, "previews", "virtual-camera-stage"); }
function sceneFile(sceneDir) { return path.join(rootFor(sceneDir), "blockout.json"); }
function safeShot(value) { return String(value || "C01").replace(/[^0-9A-Za-z가-힣._-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,80) || "C01"; }
function writeJsonAtomic(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); const tmp=`${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value,null,2)}\n`, "utf8"); fs.renameSync(tmp,file); }

function loadBlockout(project, scene) {
  const {sceneDir} = resolveScene(project, scene);
  const file = sceneFile(sceneDir);
  try { return stage.normalizeScene(JSON.parse(fs.readFileSync(file,"utf8"))); }
  catch { return stage.defaultScene(); }
}
function saveBlockout(project, scene, input) {
  const {sceneDir} = resolveScene(project, scene);
  const blockout = stage.normalizeScene(input);
  blockout.saved_at = new Date().toISOString();
  writeJsonAtomic(sceneFile(sceneDir), blockout);
  return blockout;
}
function pathDir(sceneDir, shotId) { return path.join(rootFor(sceneDir), "camera-paths", safeShot(shotId)); }
function nextPathNumber(sceneDir, shotId) {
  const dir=pathDir(sceneDir,shotId); if(!fs.existsSync(dir))return 1;
  const nums=fs.readdirSync(dir).map(name=>name.match(/^path_(\d{3})\.json$/)).filter(Boolean).map(m=>Number(m[1]));
  return nums.length ? Math.max(...nums)+1 : 1;
}
function sanitizeSnapshot(input={}) {
  return {
    client_time_ms:stage.finite(input.client_time_ms,Date.now()),
    source:String(input.source||"stage").slice(0,32),
    metric:Boolean(input.metric),
    camera:{
      position:{x:stage.clamp(input.camera?.position?.x,-1000,1000),y:stage.clamp(input.camera?.position?.y,-1000,1000),z:stage.clamp(input.camera?.position?.z,-1000,1000)},
      quaternion:stage.quat(input.camera?.quaternion||{x:0,y:0,z:0,w:1}),
      fov_deg:stage.clamp(input.camera?.fov_deg,15,140)||50,
    },
  };
}
function saveCameraPath(project, scene, request={}) {
  const {sceneDir}=resolveScene(project,scene), shotId=safeShot(request.shot_id), number=nextPathNumber(sceneDir,shotId);
  const samples=Array.isArray(request.samples)?request.samples.slice(0,MAX_PATH_SAMPLES).map(sanitizeSnapshot):[];
  if(samples.length<2)throw new Error("stage_path_requires_two_samples");
  const payload={schema_version:1,preview:true,canonical:false,source:"virtual-camera-stage-v4",shot_id:shotId,path_number:number,coordinate_system:"+X right, +Y up, camera forward -Z",units:samples.every(s=>s.metric)?"meter":"mixed-relative",metric:samples.every(s=>s.metric),started_at:request.started_at||new Date(samples[0].client_time_ms).toISOString(),stopped_at:request.stopped_at||new Date(samples[samples.length-1].client_time_ms).toISOString(),sample_count:samples.length,samples};
  const file=path.join(pathDir(sceneDir,shotId),`path_${String(number).padStart(3,"0")}.json`); writeJsonAtomic(file,payload);
  return {...payload,path:file,samples:undefined};
}
function listCameraPaths(project,scene) {
  const {sceneDir}=resolveScene(project,scene),root=path.join(rootFor(sceneDir),"camera-paths"); if(!fs.existsSync(root))return[]; const rows=[];
  for(const shot of fs.readdirSync(root,{withFileTypes:true})) { if(!shot.isDirectory())continue; const dir=path.join(root,shot.name); for(const name of fs.readdirSync(dir).filter(x=>/^path_\d{3}\.json$/.test(x))) { try { const p=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8")); rows.push({shot_id:p.shot_id,path_number:p.path_number,metric:p.metric,units:p.units,sample_count:p.sample_count,started_at:p.started_at,stopped_at:p.stopped_at,path:path.join(dir,name)}); } catch {} } }
  return rows.sort((a,b)=>String(b.stopped_at||"").localeCompare(String(a.stopped_at||"")));
}
function loadCameraPath(project,scene,shotId,pathNumber) {
  const {sceneDir}=resolveScene(project,scene),number=Math.max(1,Math.trunc(Number(pathNumber)||1)),file=path.join(pathDir(sceneDir,safeShot(shotId)),`path_${String(number).padStart(3,"0")}.json`);
  if(!fs.existsSync(file))throw new Error("stage_path_not_found");
  const stat=fs.statSync(file); if(stat.size>8*1024*1024)throw new Error("stage_path_too_large");
  const payload=JSON.parse(fs.readFileSync(file,"utf8")); payload.samples=Array.isArray(payload.samples)?payload.samples.slice(0,MAX_PATH_SAMPLES).map(sanitizeSnapshot):[]; return payload;
}

function installVirtualCameraStage() {
  if(installed)return; installed=true;
  ipcMain.handle("virtual-camera-stage:load",(_e,project,scene)=>loadBlockout(project,scene));
  ipcMain.handle("virtual-camera-stage:save",(_e,project,scene,input)=>saveBlockout(project,scene,input));
  ipcMain.handle("virtual-camera-stage:save-path",(_e,project,scene,request)=>saveCameraPath(project,scene,request));
  ipcMain.handle("virtual-camera-stage:list-paths",(_e,project,scene)=>listCameraPaths(project,scene));
  ipcMain.handle("virtual-camera-stage:load-path",(_e,project,scene,shotId,pathNumber)=>loadCameraPath(project,scene,shotId,pathNumber));
  ipcMain.handle("virtual-camera-stage:open-folder",async(_e,project,scene)=>{const {sceneDir}=resolveScene(project,scene);const root=rootFor(sceneDir);fs.mkdirSync(root,{recursive:true});const error=await shell.openPath(root);if(error)throw new Error(error);return true;});
}

module.exports={installVirtualCameraStage,loadBlockout,saveBlockout,saveCameraPath,listCameraPaths,loadCameraPath,sanitizeSnapshot};
