const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {app, ipcMain, BrowserWindow, clipboard, shell} = require("electron");
const {createProjectPathResolver} = require("./project-paths.cjs");
const {PRESETS, safeId, sanitizeSample, makeTake, estimateTranslation} = require("./virtual-camera-core.cjs");
const {qrDataUrl} = require("./virtual-camera-qr.cjs");
const {tryEnsureTlsMaterial} = require("./virtual-camera-tls.cjs");

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
    const privateRank = address => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 0 : 1;
    return privateRank(a.address) - privateRank(b.address) || a.name.localeCompare(b.name);
  });
  return result;
}

function commonHeaders(contentType, length) {
  return {
    "content-type":contentType,
    "content-length":length,
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
    "permissions-policy":"accelerometer=(self), gyroscope=(self), magnetometer=(self)",
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, commonHeaders("application/json; charset=utf-8", Buffer.byteLength(body)));
  res.end(body);
}

function html(res, status, body) {
  const headers = commonHeaders("text/html; charset=utf-8", Buffer.byteLength(body));
  headers["content-security-policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";
  res.writeHead(status, headers);
  res.end(body);
}

function certificate(res, file) {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    ...commonHeaders("application/x-x509-ca-cert", body.length),
    "content-disposition":"attachment; filename=FilmMate-VCAM-CA.cer",
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

function urlFor(address, port, token, secure = false) {
  return `${secure ? "https" : "http"}://${address}:${port}/?token=${encodeURIComponent(token)}`;
}

function publicStatus(session) {
  if (!session) return {active:false,recording:false};
  const addresses = session.addresses.length ? session.addresses : ["127.0.0.1"];
  const bootstrapUrls = addresses.map(address => urlFor(address, session.httpPort, session.token, false));
  const secureUrls = session.httpsPort ? addresses.map(address => urlFor(address, session.httpsPort, session.token, true)) : [];
  const primaryUrl = bootstrapUrls[0];
  let qr = null;
  try { qr = qrDataUrl(primaryUrl, {scale:5, margin:4}); } catch { qr = null; }
  return {
    active:true,
    session_id:session.id,
    project:session.project,
    scene:session.scene,
    port:session.httpPort,
    http_port:session.httpPort,
    https_port:session.httpsPort,
    urls:bootstrapUrls,
    secure_urls:secureUrls,
    primary_url:primaryUrl,
    secure_primary_url:secureUrls[0] || null,
    qr_data_url:qr,
    recording:Boolean(session.recording),
    shot_id:session.recording?.shotId || null,
    preset:session.recording?.preset || null,
    sample_count:session.recording?.samples?.length || 0,
    live_pose:session.latestPose || null,
    sensor_transport:session.httpsPort ? "https-lan" : "http-lan-manual-fallback",
    sensor_secure_context_required:true,
    tls_available:Boolean(session.tls?.available && session.httpsPort),
    ca_fingerprint_sha256:session.tls?.fingerprint_sha256 || null,
    tls_error:session.tls?.available ? null : session.tls?.error || null,
    note:session.httpsPort
      ? "QR opens a local bootstrap page. Install and trust the FilmMate local CA once, then open the HTTPS controller for real motion sensors."
      : "HTTPS setup is unavailable on this machine, so manual pan/tilt/roll remains available over LAN HTTP.",
  };
}

function startRecording(session, request = {}) {
  if (!session) throw new Error("virtual_camera_session_not_active");
  if (session.recording) throw new Error("virtual_camera_already_recording");
  const requestedPreset = String(request.preset || "CINEMA").toUpperCase();
  session.recording = {shotId:safeId(request.shotId || "C01", "C01"),preset:PRESETS[requestedPreset] ? requestedPreset : "CINEMA",startedAt:new Date().toISOString(),samples:[],lastSampleAt:0};
  session.latestPose = null;
  notify("virtual-camera:status", publicStatus(session));
  return publicStatus(session);
}

function stopRecording(session) {
  if (!session?.recording) throw new Error("virtual_camera_not_recording");
  const recording = session.recording;
  session.recording = null;
  const take = writeTake(session.project, session.scene, recording);
  session.latestPose = take.analysis?.relative_translation || null;
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
    if (session.recording.samples.length >= 3 && session.recording.samples.length % 2 === 1) {
      session.latestPose = estimateTranslation(session.recording.samples);
    }
  }
  if (session.latestPose) sample.pose_preview = {
    confidence:session.latestPose.confidence,
    metric:false,
    relative_position:session.latestPose.relative_position,
    relative_velocity:session.latestPose.relative_velocity,
    moves:session.latestPose.moves,
    trajectory:(session.latestPose.trajectory || []).slice(-80),
  };
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

function requestHost(req) {
  const host = String(req.headers.host || "127.0.0.1");
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return host.split(":")[0];
}

function mobilePage(session, req, transport) {
  const token = JSON.stringify(session.token);
  const host = requestHost(req);
  const caUrl = session.tls?.available ? `http://${host}:${session.httpPort}/ca.cer?token=${encodeURIComponent(session.token)}` : "";
  const secureUrl = session.httpsPort ? `https://${host}:${session.httpsPort}/?token=${encodeURIComponent(session.token)}` : "";
  const secureLink = JSON.stringify(secureUrl);
  const caLink = JSON.stringify(caUrl);
  const fingerprint = JSON.stringify(session.tls?.fingerprint_sha256 || "");
  const transportLabel = transport === "https" ? "HTTPS SENSOR" : "PAIRING / MANUAL";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="#0b0d10"><title>FilmMate Virtual Camera</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0b0d10;color:#f5f6f7;font:15px system-ui,sans-serif;padding:20px}.top{display:flex;justify-content:space-between;align-items:center}.brand{font-weight:900;font-size:21px}.brand b{color:#b9ff55}.pill{border:1px solid #2a3038;border-radius:999px;padding:6px 9px;color:#9aa3ad;font-size:11px}.monitor{margin:18px 0;border:1px solid #2a3038;border-radius:16px;background:#12161b;aspect-ratio:16/9;display:grid;place-items:center;overflow:hidden}.reticle{width:68%;height:68%;border:1px solid #b9ff5577;position:relative}.reticle:before,.reticle:after{content:"";position:absolute;background:#b9ff5577}.reticle:before{width:1px;height:100%;left:50%}.reticle:after{height:1px;width:100%;top:50%}.readout{position:absolute;bottom:7px;left:8px;font:11px ui-monospace,monospace;color:#b9ff55}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.grid+ .grid{margin-top:8px}.card{border:1px solid #2a3038;background:#171b20;border-radius:11px;padding:10px;text-align:center}.card small{color:#8c96a3;display:block}.card b{font:17px ui-monospace,monospace}.controls{display:grid;gap:10px;margin-top:16px}button,select,input,a{font:inherit}.btn{display:block;text-decoration:none;text-align:center;border:1px solid #333b45;background:#171b20;color:#fff;border-radius:11px;padding:13px;font-weight:800}.btn.primary{background:#b9ff55;color:#10120d;border-color:#b9ff55}.btn.rec{background:#ff5757;border-color:#ff5757}.btn:disabled{opacity:.4}.row{display:flex;gap:8px}.row>*{flex:1}.field{border:1px solid #2a3038;background:#12161b;border-radius:12px;padding:11px}.field label{display:flex;justify-content:space-between;color:#9aa3ad;font-size:12px}.field input{width:100%}.notice{margin-top:12px;border:1px solid #6e552c;background:#211b12;color:#ffd58a;border-radius:11px;padding:11px;line-height:1.5;font-size:12px}.ok{border-color:#496628;background:#14200f;color:#cfff8f}.setup{display:none;margin-top:12px;border:1px solid #384250;background:#10161e;border-radius:12px;padding:12px}.setup b{display:block;margin-bottom:7px}.setup ol{margin:8px 0 12px;padding-left:20px;color:#b8c1cc;font-size:12px;line-height:1.55}.finger{word-break:break-all;color:#9aa3ad;font:10px ui-monospace,monospace}</style></head>
<body><div class="top"><div class="brand">FilmMate <b>VCAM</b></div><span class="pill">${transportLabel}</span></div><div class="monitor"><div class="reticle"><div class="readout" id="readout">READY</div></div></div><div class="grid"><div class="card"><small>PAN</small><b id="pan">0.0°</b></div><div class="card"><small>TILT</small><b id="tilt">0.0°</b></div><div class="card"><small>ROLL</small><b id="roll">0.0°</b></div></div><div class="grid"><div class="card"><small>TRUCK X</small><b id="truck">0.000</b></div><div class="card"><small>PED Y</small><b id="pedestal">0.000</b></div><div class="card"><small>DOLLY Z</small><b id="dolly">0.000</b></div></div><div class="controls"><div class="row"><button class="btn primary" id="sensor">센서 시작</button><select class="btn" id="preset"><option>CINEMA</option><option>HANDHELD</option><option>SMOOTH</option><option>GIMBAL</option><option>RAW</option></select></div><div class="row"><button class="btn rec" id="rec">● REC</button><button class="btn" id="stop" disabled>STOP</button></div><div class="field"><label>PAN 수동 <span id="panValue">0°</span></label><input id="panSlider" type="range" min="-180" max="180" value="0"></div><div class="field"><label>TILT 수동 <span id="tiltValue">0°</span></label><input id="tiltSlider" type="range" min="-90" max="90" value="0"></div><div class="field"><label>ROLL 수동 <span id="rollValue">0°</span></label><input id="rollSlider" type="range" min="-90" max="90" value="0"></div></div><div class="setup" id="setup"><b>센서 HTTPS 최초 설정</b><ol><li>FilmMate 로컬 CA 인증서를 내려받아 설치합니다.</li><li>iPhone은 설정 → 일반 → 정보 → 인증서 신뢰 설정에서 FilmMate VCAM Local CA를 완전히 신뢰로 켭니다.</li><li>그 다음 아래 ‘HTTPS 센서 컨트롤러 열기’를 누릅니다.</li></ol><a class="btn" id="caLink">1. CA 인증서 받기</a><a class="btn primary" id="secureLink" style="margin-top:8px">2. HTTPS 센서 컨트롤러 열기</a><div class="finger" id="finger"></div></div><div class="notice" id="notice"></div>
<script>const TOKEN=${token},SECURE_URL=${secureLink},CA_URL=${caLink},FINGERPRINT=${fingerprint};const state={orientation:{alpha:0,beta:0,gamma:0,absolute:false},motion:{acceleration:{x:0,y:0,z:0},accelerationIncludingGravity:{x:0,y:0,z:0},rotationRate:{alpha:0,beta:0,gamma:0},interval:0},source:'manual'};let dirty=true;const $=id=>document.getElementById(id);async function api(p,o={}){const r=await fetch(p,{...o,headers:{'content-type':'application/json','x-vcam-token':TOKEN,...(o.headers||{})}}),d=await r.json();if(!r.ok)throw new Error(d.error||'request_failed');return d}function screenAngle(){return Number(screen.orientation?.angle??window.orientation??0)||0}function draw(){const o=state.orientation;$('pan').textContent=(o.alpha||0).toFixed(1)+'°';$('tilt').textContent=(o.beta||0).toFixed(1)+'°';$('roll').textContent=(o.gamma||0).toFixed(1)+'°'}function drawPose(p){const q=p?.relative_position||{};$('truck').textContent=(Number(q.x)||0).toFixed(3);$('pedestal').textContent=(Number(q.y)||0).toFixed(3);$('dolly').textContent=(Number(q.z)||0).toFixed(3)}function onOrientation(e){state.orientation={alpha:Number(e.alpha)||0,beta:Number(e.beta)||0,gamma:Number(e.gamma)||0,absolute:Boolean(e.absolute)};state.source='sensor';dirty=true;draw()}function onMotion(e){const a=e.acceleration||{},g=e.accelerationIncludingGravity||{},r=e.rotationRate||{};state.motion={acceleration:{x:Number(a.x)||0,y:Number(a.y)||0,z:Number(a.z)||0},accelerationIncludingGravity:{x:Number(g.x)||0,y:Number(g.y)||0,z:Number(g.z)||0},rotationRate:{alpha:Number(r.alpha)||0,beta:Number(r.beta)||0,gamma:Number(r.gamma)||0},interval:Number(e.interval)||0};dirty=true}async function enableSensors(){try{if(!window.isSecureContext)throw new Error('센서 API는 HTTPS 보안 컨텍스트가 필요합니다. 아래 최초 설정을 완료한 뒤 HTTPS 컨트롤러를 열어주세요.');if(typeof DeviceOrientationEvent==='undefined')throw new Error('이 기기에서 방향 센서를 사용할 수 없습니다.');if(typeof DeviceOrientationEvent.requestPermission==='function'){const results=await Promise.all([DeviceOrientationEvent.requestPermission(),typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'?DeviceMotionEvent.requestPermission():Promise.resolve('granted')]);if(results.some(v=>v!=='granted'))throw new Error('센서 권한이 허용되지 않았습니다.')}window.addEventListener('deviceorientation',onOrientation);window.addEventListener('devicemotion',onMotion);state.source='sensor';$('notice').className='notice ok';$('notice').textContent='센서 연결됨 · 회전과 상대 이동을 전송합니다.';$('sensor').disabled=true}catch(error){$('notice').className='notice';$('notice').textContent=error.message;if(SECURE_URL)$('setup').style.display='block'}}$('sensor').onclick=enableSensors;$('rec').onclick=async()=>{try{await api('/api/record/start',{method:'POST',body:JSON.stringify({shotId:'C01',preset:$('preset').value})});$('rec').disabled=true;$('stop').disabled=false;$('readout').textContent='● REC'}catch(e){$('notice').textContent=e.message}};$('stop').onclick=async()=>{try{const take=await api('/api/record/stop',{method:'POST',body:'{}'});$('rec').disabled=false;$('stop').disabled=true;$('readout').textContent='TAKE '+String(take.take_number).padStart(2,'0')+' SAVED';$('notice').className='notice ok';$('notice').textContent=take.analysis?.prompt||'Take saved.';drawPose(take.analysis?.relative_translation)}catch(e){$('notice').textContent=e.message}};for(const axis of [['panSlider','panValue','alpha'],['tiltSlider','tiltValue','beta'],['rollSlider','rollValue','gamma']]){$(axis[0]).oninput=e=>{state.orientation[axis[2]]=Number(e.target.value);state.source='manual';$(axis[1]).textContent=e.target.value+'°';dirty=true;draw()}}if(CA_URL)$('caLink').href=CA_URL;if(SECURE_URL)$('secureLink').href=SECURE_URL;$('finger').textContent=FINGERPRINT?'CA SHA-256: '+FINGERPRINT:'';if(!window.isSecureContext&&SECURE_URL)$('setup').style.display='block';setInterval(async()=>{if(!dirty)return;dirty=false;try{const result=await api('/api/sample',{method:'POST',body:JSON.stringify({...state,screen_angle:screenAngle(),client_time_ms:Date.now()})});drawPose(result.pose_preview)}catch{$('notice').textContent='PC 연결이 끊겼습니다.'}},33);$('notice').textContent=window.isSecureContext?'센서 시작을 눌러 권한을 허용하세요.':'현재는 페어링/수동 모드입니다. 실제 모션 센서는 HTTPS 최초 설정이 필요합니다.';draw();drawPose(null);</script></body></html>`;
}

function createRequestHandler(session, transport) {
  return async (req, res) => {
    const url = new URL(req.url || "/", `${transport}://localhost`);
    try {
      if (!authorized(session, req, url)) return html(res, 403, "<h1>Invalid FilmMate VCAM session.</h1>");
      if (req.method === "GET" && url.pathname === "/") return html(res, 200, mobilePage(session, req, transport));
      if (req.method === "GET" && url.pathname === "/ca.cer" && session.tls?.available) return certificate(res, session.tls.ca_cer);
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, publicStatus(session));
      if (req.method === "POST" && url.pathname === "/api/sample") {
        const sample = recordSample(session, await parseJsonBody(req));
        return json(res, 200, {ok:true,recording:Boolean(session.recording),sample_count:session.recording?.samples?.length||0,received_at:sample.received_at,pose_preview:sample.pose_preview||null});
      }
      if (req.method === "POST" && url.pathname === "/api/record/start") return json(res, 200, startRecording(session, await parseJsonBody(req)));
      if (req.method === "POST" && url.pathname === "/api/record/stop") return json(res, 200, stopRecording(session));
      return json(res, 404, {error:"not_found"});
    } catch (error) { return json(res, 400, {error:error?.message || String(error)}); }
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve(server.address().port));
  });
}

async function startSession(project, scene) {
  if (activeSession && activeSession.project === project && activeSession.scene === scene) return publicStatus(activeSession);
  if (activeSession) await stopSession();
  resolveScene(project, scene);
  const addressObjects = privateIpv4Addresses();
  const addresses = addressObjects.map(item => item.address);
  if (!addresses.length) addresses.push("127.0.0.1");
  const tls = tryEnsureTlsMaterial({root:path.join(app.getPath("userData"), "virtual-camera-tls"), addresses});
  const session = {id:crypto.randomUUID(),token:crypto.randomBytes(18).toString("base64url"),project:String(project),scene:String(scene),addresses,tls,httpServer:null,httpsServer:null,httpPort:null,httpsPort:null,recording:null,latestSample:null,latestPose:null};
  session.httpServer = http.createServer(createRequestHandler(session, "http"));
  session.httpPort = await listen(session.httpServer);
  if (tls.available) {
    try {
      session.httpsServer = https.createServer({key:fs.readFileSync(tls.server_key),cert:fs.readFileSync(tls.server_cert)}, createRequestHandler(session, "https"));
      session.httpsPort = await listen(session.httpsServer);
    } catch (error) {
      session.httpsServer = null;
      session.httpsPort = null;
      session.tls = {...tls,available:false,error:`https_server_failed:${error?.message || error}`};
    }
  }
  activeSession = session;
  notify("virtual-camera:status", publicStatus(session));
  return publicStatus(session);
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
}

async function stopSession() {
  const session = activeSession;
  activeSession = null;
  if (!session) return {active:false};
  if (session.recording) { try { stopRecording(session); } catch { /* best effort */ } }
  await Promise.all([closeServer(session.httpServer), closeServer(session.httpsServer)]);
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
  app.on("before-quit", () => {
    const session = activeSession;
    activeSession = null;
    try { session?.httpServer?.close(); } catch { /* ignore */ }
    try { session?.httpsServer?.close(); } catch { /* ignore */ }
  });
}

module.exports = {installVirtualCamera};
