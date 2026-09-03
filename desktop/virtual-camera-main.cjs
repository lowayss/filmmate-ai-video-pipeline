const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {app, ipcMain, BrowserWindow, clipboard, shell} = require("electron");
const {createProjectPathResolver} = require("./project-paths.cjs");
const {PRESETS, safeId, sanitizeSample, makeTake} = require("./virtual-camera-core.cjs");

const MAX_BODY_BYTES = 64 * 1024;
const MIN_SAMPLE_INTERVAL_MS = 25;
let installed = false;
let activeSession = null;

function workspaceRoot() {
  const documentsWorkspace = path.join(app.getPath("documents"), "영화작업용", "scene-package-builder");
  return fs.existsSync(documentsWorkspace) ? documentsWorkspace : path.resolve(__dirname, "..");
}

function resolveScene(project, scene) {
  const resolver = createProjectPathResolver(path.join(workspaceRoot(), "packages"));
  return resolver.resolveScene(project, scene);
}

function privateIpv4Addresses() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      result.push({name, address:entry.address});
    }
  }
  result.sort((a, b) => {
    const aPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) ? 0 : 1;
    const bPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b.address) ? 0 : 1;
    return aPrivate - bPrivate || a.name.localeCompare(b.name);
  });
  return result;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store","x-content-type-options":"nosniff"});
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type":"text/html; charset=utf-8",
    "content-length":Buffer.byteLength(body),
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
    "content-security-policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function notify(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function takeRoot(sceneDir) { return path.join(sceneDir, "previews", "virtual-camera"); }

function nextTakeNumber(sceneDir, shotId) {
  const dir = path.join(takeRoot(sceneDir), safeId(shotId, "SHOT"));
  if (!fs.existsSync(dir)) return 1;
  const numbers = fs.readdirSync(dir).map(name => name.match(/^take_(\d{3})\.json$/)).filter(Boolean).map(match => Number(match[1]));
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

function writeTake(project, scene, recording) {
  const {sceneDir} = resolveScene(project, scene);
  const takeNumber = nextTakeNumber(sceneDir, recording.shotId);
  const take = makeTake({shotId:recording.shotId,preset:recording.preset,samples:recording.samples,startedAt:recording.startedAt,stoppedAt:new Date().toISOString(),takeNumber});
  const shotDir = path.join(takeRoot(sceneDir), take.shot_id);
  fs.mkdirSync(shotDir, {recursive:true});
  const output = path.join(shotDir, `take_${String(takeNumber).padStart(3, "0")}.json`);
  const tmp = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(take, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, output);
  return {shot_id:take.shot_id,take_number:take.take_number,preset:take.preset,started_at:take.started_at,stopped_at:take.stopped_at,sample_count:take.sample_count,analysis:take.analysis,path:output,preview:true,canonical:false};
}

function readTakeSummaries(project, scene) {
  const {sceneDir} = resolveScene(project, scene);
  const root = takeRoot(sceneDir);
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const shot of fs.readdirSync(root, {withFileTypes:true})) {
    if (!shot.isDirectory()) continue;
    const shotDir = path.join(root, shot.name);
    for (const name of fs.readdirSync(shotDir).filter(file => /^take_\d{3}\.json$/.test(file))) {
      try {
        const take = JSON.parse(fs.readFileSync(path.join(shotDir, name), "utf8"));
        rows.push({shot_id:take.shot_id,take_number:take.take_number,preset:take.preset,started_at:take.started_at,stopped_at:take.stopped_at,sample_count:take.sample_count,analysis:take.analysis,path:path.join(shotDir, name),selected:false,preview:true,canonical:false});
      } catch { /* ignore corrupt preview files */ }
    }
    const selectedFile = path.join(shotDir, "selected.json");
    if (fs.existsSync(selectedFile)) {
      try {
        const selected = JSON.parse(fs.readFileSync(selectedFile, "utf8"));
        for (const row of rows) if (row.shot_id === shot.name && row.take_number === selected.take_number) row.selected = true;
      } catch { /* ignore invalid marker */ }
    }
  }
  return rows.sort((a,b) => String(b.stopped_at || "").localeCompare(String(a.stopped_at || "")));
}

function selectTake(project, scene, shotId, takeNumber) {
  const {sceneDir} = resolveScene(project, scene);
  const shot = safeId(shotId, "SHOT");
  const number = Math.max(1, Math.trunc(Number(takeNumber) || 1));
  const shotDir = path.join(takeRoot(sceneDir), shot);
  const takeFile = path.join(shotDir, `take_${String(number).padStart(3, "0")}.json`);
  if (!fs.existsSync(takeFile)) throw new Error("virtual_camera_take_not_found");
  const marker = {schema_version:1,preview:true,canonical:false,shot_id:shot,take_number:number,take_file:path.basename(takeFile),selected_at:new Date().toISOString()};
  fs.writeFileSync(path.join(shotDir, "selected.json"), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

function publicStatus(session) {
  if (!session) return {active:false,recording:false};
  const urls = privateIpv4Addresses().map(item => `http://${item.address}:${session.port}/?token=${encodeURIComponent(session.token)}`);
  urls.push(`http://127.0.0.1:${session.port}/?token=${encodeURIComponent(session.token)}`);
  return {
    active:true,session_id:session.id,project:session.project,scene:session.scene,port:session.port,urls,primary_url:urls[0],
    recording:Boolean(session.recording),shot_id:session.recording?.shotId || null,preset:session.recording?.preset || null,sample_count:session.recording?.samples?.length || 0,
    sensor_transport:"http-lan",sensor_secure_context_required:true,
    note:"Mobile browser motion sensors may require HTTPS. Manual pan/tilt/roll controls remain available over LAN HTTP.",
  };
}

function startRecording(session, request = {}) {
  if (!session) throw new Error("virtual_camera_session_not_active");
  if (session.recording) throw new Error("virtual_camera_already_recording");
  const requestedPreset = String(request.preset || "CINEMA").toUpperCase();
  session.recording = {shotId:safeId(request.shotId || "C01", "C01"),preset:PRESETS[requestedPreset] ? requestedPreset : "CINEMA",startedAt:new Date().toISOString(),samples:[],lastSampleAt:0};
  notify("virtual-camera:status", publicStatus(session));
  return publicStatus(session);
}

function stopRecording(session) {
  if (!session?.recording) throw new Error("virtual_camera_not_recording");
  const recording = session.recording;
  session.recording = null;
  const take = writeTake(session.project, session.scene, recording);
  notify("virtual-camera:take", take);
  notify("virtual-camera:status", publicStatus(session));
  return take;
}

function recordSample(session, input) {
  const now = Date.now();
  const sample = sanitizeSample(input, now);
  session.latestSample = sample;
  if (session.recording && now - session.recording.lastSampleAt >= MIN_SAMPLE_INTERVAL_MS) {
    session.recording.samples.push(sample);
    session.recording.lastSampleAt = now;
  }
  notify("virtual-camera:sample", sample);
  return sample;
}

function tokenFrom(req, url) { return req.headers["x-vcam-token"] || url.searchParams.get("token") || ""; }
function authorized(session, req, url) {
  const supplied = String(tokenFrom(req, url));
  const expected = String(session.token);
  if (supplied.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); }
  catch { return false; }
}

function mobilePage(session) {
  const token = JSON.stringify(session.token);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="#0b0d10"><title>FilmMate Virtual Camera</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0b0d10;color:#f5f6f7;font:15px system-ui,sans-serif;padding:20px}.top{display:flex;justify-content:space-between;align-items:center}.brand{font-weight:900;font-size:21px}.brand b{color:#b9ff55}.pill{border:1px solid #2a3038;border-radius:999px;padding:6px 9px;color:#9aa3ad;font-size:12px}.monitor{margin:18px 0;border:1px solid #2a3038;border-radius:16px;background:#12161b;aspect-ratio:16/9;display:grid;place-items:center;overflow:hidden}.reticle{width:68%;height:68%;border:1px solid #b9ff5577;position:relative}.reticle:before,.reticle:after{content:"";position:absolute;background:#b9ff5577}.reticle:before{width:1px;height:100%;left:50%}.reticle:after{height:1px;width:100%;top:50%}.readout{position:absolute;bottom:7px;left:8px;font:11px ui-monospace,monospace;color:#b9ff55}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.card{border:1px solid #2a3038;background:#171b20;border-radius:11px;padding:10px;text-align:center}.card small{color:#8c96a3;display:block}.card b{font:18px ui-monospace,monospace}.controls{display:grid;gap:10px;margin-top:16px}button,select,input{font:inherit}.btn{border:1px solid #333b45;background:#171b20;color:#fff;border-radius:11px;padding:13px;font-weight:800}.btn.primary{background:#b9ff55;color:#10120d;border-color:#b9ff55}.btn.rec{background:#ff5757;border-color:#ff5757}.btn:disabled{opacity:.4}.row{display:flex;gap:8px}.row>*{flex:1}.field{border:1px solid #2a3038;background:#12161b;border-radius:12px;padding:11px}.field label{display:flex;justify-content:space-between;color:#9aa3ad;font-size:12px}.field input{width:100%}.notice{margin-top:12px;border:1px solid #6e552c;background:#211b12;color:#ffd58a;border-radius:11px;padding:11px;line-height:1.45;font-size:12px}.ok{border-color:#496628;background:#14200f;color:#cfff8f}</style></head>
<body><div class="top"><div class="brand">FilmMate <b>VCAM</b></div><span class="pill" id="connection">CONNECTED</span></div><div class="monitor"><div class="reticle"><div class="readout" id="readout">READY</div></div></div><div class="grid"><div class="card"><small>PAN</small><b id="pan">0.0°</b></div><div class="card"><small>TILT</small><b id="tilt">0.0°</b></div><div class="card"><small>ROLL</small><b id="roll">0.0°</b></div></div><div class="controls"><div class="row"><button class="btn primary" id="sensor">센서 시작</button><select class="btn" id="preset"><option>CINEMA</option><option>HANDHELD</option><option>SMOOTH</option><option>GIMBAL</option><option>RAW</option></select></div><div class="row"><button class="btn rec" id="rec">● REC</button><button class="btn" id="stop" disabled>STOP</button></div><div class="field"><label>PAN 수동 <span id="panValue">0°</span></label><input id="panSlider" type="range" min="-180" max="180" value="0"></div><div class="field"><label>TILT 수동 <span id="tiltValue">0°</span></label><input id="tiltSlider" type="range" min="-90" max="90" value="0"></div><div class="field"><label>ROLL 수동 <span id="rollValue">0°</span></label><input id="rollSlider" type="range" min="-90" max="90" value="0"></div></div><div class="notice" id="notice"></div>
<script>const TOKEN=${token};const state={orientation:{alpha:0,beta:0,gamma:0,absolute:false},motion:{acceleration:{x:0,y:0,z:0},rotationRate:{alpha:0,beta:0,gamma:0},interval:0},source:'manual'};let dirty=true;const $=id=>document.getElementById(id);async function api(p,o={}){const r=await fetch(p,{...o,headers:{'content-type':'application/json','x-vcam-token':TOKEN,...(o.headers||{})}}),d=await r.json();if(!r.ok)throw new Error(d.error||'request_failed');return d}function draw(){const o=state.orientation;$('pan').textContent=(o.alpha||0).toFixed(1)+'°';$('tilt').textContent=(o.beta||0).toFixed(1)+'°';$('roll').textContent=(o.gamma||0).toFixed(1)+'°'}function onOrientation(e){state.orientation={alpha:Number(e.alpha)||0,beta:Number(e.beta)||0,gamma:Number(e.gamma)||0,absolute:Boolean(e.absolute)};state.source='sensor';dirty=true;draw()}function onMotion(e){const a=e.acceleration||{},r=e.rotationRate||{};state.motion={acceleration:{x:Number(a.x)||0,y:Number(a.y)||0,z:Number(a.z)||0},rotationRate:{alpha:Number(r.alpha)||0,beta:Number(r.beta)||0,gamma:Number(r.gamma)||0},interval:Number(e.interval)||0};dirty=true}async function enableSensors(){try{if(!window.isSecureContext)throw new Error('이 브라우저는 센서 사용에 HTTPS 보안 연결이 필요합니다. 현재는 아래 수동 PAN/TILT/ROLL 컨트롤을 사용할 수 있습니다.');if(typeof DeviceOrientationEvent==='undefined')throw new Error('이 기기에서 방향 센서를 사용할 수 없습니다.');if(typeof DeviceOrientationEvent.requestPermission==='function'){const results=await Promise.all([DeviceOrientationEvent.requestPermission(),typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'?DeviceMotionEvent.requestPermission():Promise.resolve('granted')]);if(results.some(v=>v!=='granted'))throw new Error('센서 권한이 허용되지 않았습니다.')}window.addEventListener('deviceorientation',onOrientation);window.addEventListener('devicemotion',onMotion);state.source='sensor';$('notice').className='notice ok';$('notice').textContent='센서 연결됨 · 휴대폰 움직임을 전송합니다.';$('sensor').disabled=true}catch(error){$('notice').className='notice';$('notice').textContent=error.message}}$('sensor').onclick=enableSensors;$('rec').onclick=async()=>{try{await api('/api/record/start',{method:'POST',body:JSON.stringify({shotId:'C01',preset:$('preset').value})});$('rec').disabled=true;$('stop').disabled=false;$('readout').textContent='● REC'}catch(e){$('notice').textContent=e.message}};$('stop').onclick=async()=>{try{const take=await api('/api/record/stop',{method:'POST',body:'{}'});$('rec').disabled=false;$('stop').disabled=true;$('readout').textContent='TAKE '+String(take.take_number).padStart(2,'0')+' SAVED';$('notice').className='notice ok';$('notice').textContent=take.analysis?.prompt||'Take saved.'}catch(e){$('notice').textContent=e.message}};for(const axis of [['panSlider','panValue','alpha'],['tiltSlider','tiltValue','beta'],['rollSlider','rollValue','gamma']]){$(axis[0]).oninput=e=>{state.orientation[axis[2]]=Number(e.target.value);state.source='manual';$(axis[1]).textContent=e.target.value+'°';dirty=true;draw()}}setInterval(()=>{if(!dirty)return;dirty=false;api('/api/sample',{method:'POST',body:JSON.stringify({...state,client_time_ms:Date.now()})}).catch(()=>{$('connection').textContent='OFFLINE'})},33);$('notice').textContent=window.isSecureContext?'센서 시작을 눌러 권한을 허용하세요.':'LAN HTTP 연결입니다. 최신 모바일 브라우저는 동작 센서에 HTTPS를 요구할 수 있어 수동 컨트롤을 함께 제공합니다.';draw();</script></body></html>`;
}

async function startSession(project, scene) {
  if (activeSession && activeSession.project === project && activeSession.scene === scene) return publicStatus(activeSession);
  if (activeSession) await stopSession();
  resolveScene(project, scene);
  const session = {id:crypto.randomUUID(),token:crypto.randomBytes(18).toString("base64url"),project:String(project),scene:String(scene),port:null,server:null,recording:null,latestSample:null};
  session.server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        if (!authorized(session, req, url)) return html(res, 403, "<h1>Invalid FilmMate VCAM session.</h1>");
        return html(res, 200, mobilePage(session));
      }
      if (!authorized(session, req, url)) return json(res, 403, {error:"unauthorized"});
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, publicStatus(session));
      if (req.method === "POST" && url.pathname === "/api/sample") {
        const sample = recordSample(session, await parseJsonBody(req));
        return json(res, 200, {ok:true,recording:Boolean(session.recording),sample_count:session.recording?.samples?.length||0,received_at:sample.received_at});
      }
      if (req.method === "POST" && url.pathname === "/api/record/start") return json(res, 200, startRecording(session, await parseJsonBody(req)));
      if (req.method === "POST" && url.pathname === "/api/record/stop") return json(res, 200, stopRecording(session));
      return json(res, 404, {error:"not_found"});
    } catch (error) { return json(res, 400, {error:error?.message || String(error)}); }
  });
  await new Promise((resolve, reject) => { session.server.once("error", reject); session.server.listen(0, "0.0.0.0", resolve); });
  session.port = session.server.address().port;
  activeSession = session;
  notify("virtual-camera:status", publicStatus(session));
  return publicStatus(session);
}

async function stopSession() {
  const session = activeSession;
  activeSession = null;
  if (!session) return {active:false};
  if (session.recording) { try { stopRecording(session); } catch { /* best effort */ } }
  await new Promise(resolve => session.server.close(resolve));
  notify("virtual-camera:status", {active:false,recording:false});
  return {active:false};
}

function installVirtualCamera() {
  if (installed) return;
  installed = true;
  ipcMain.handle("virtual-camera:start-session", (_event, project, scene) => startSession(project, scene));
  ipcMain.handle("virtual-camera:stop-session", () => stopSession());
  ipcMain.handle("virtual-camera:status", () => publicStatus(activeSession));
  ipcMain.handle("virtual-camera:start-recording", (_event, request) => startRecording(activeSession, request || {}));
  ipcMain.handle("virtual-camera:stop-recording", () => stopRecording(activeSession));
  ipcMain.handle("virtual-camera:list-takes", (_event, project, scene) => readTakeSummaries(project, scene));
  ipcMain.handle("virtual-camera:select-take", (_event, project, scene, shotId, takeNumber) => selectTake(project, scene, shotId, takeNumber));
  ipcMain.handle("virtual-camera:open-folder", async (_event, project, scene) => { const {sceneDir} = resolveScene(project, scene); const root = takeRoot(sceneDir); fs.mkdirSync(root, {recursive:true}); const error = await shell.openPath(root); if (error) throw new Error(error); return {path:root}; });
  ipcMain.handle("virtual-camera:copy-text", (_event, text) => { clipboard.writeText(String(text || "")); return true; });
  app.on("before-quit", () => { if (activeSession?.server) activeSession.server.close(); activeSession = null; });
}

module.exports = {installVirtualCamera};
