const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const {app, ipcMain, BrowserWindow, shell, clipboard} = require("electron");
const {createProjectPathResolver} = require("./project-paths.cjs");
const {tryEnsureTlsMaterial} = require("./virtual-camera-tls.cjs");
const {qrDataUri} = require("./virtual-camera-qr.cjs");
const {makeVisualTake} = require("./virtual-camera-visual-core.cjs");

const MAX_BODY_BYTES = 128 * 1024;
const MIN_SAMPLE_INTERVAL_MS = 40;
let installed = false;
let activeSession = null;

function workspaceRoot() {
  const documentsWorkspace = path.join(app.getPath("documents"), "영화작업용", "scene-package-builder");
  return fs.existsSync(documentsWorkspace) ? documentsWorkspace : path.resolve(__dirname, "..");
}

function resolveScene(project, scene) {
  return createProjectPathResolver(path.join(workspaceRoot(), "packages")).resolveScene(project, scene);
}

function lanAddresses() {
  const rows = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) rows.push({name,address:entry.address});
    }
  }
  rows.sort((a,b) => (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)?0:1) - (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b.address)?0:1));
  return rows;
}

function safeShot(value) {
  return String(value || "C01").replace(/[^0-9A-Za-z가-힣._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "C01";
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store","x-content-type-options":"nosniff"});
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:"});
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve,reject) => {
    const chunks=[]; let size=0;
    req.on("data",chunk=>{size+=chunk.length;if(size>MAX_BODY_BYTES){reject(new Error("payload_too_large"));req.destroy();return;}chunks.push(chunk);});
    req.on("end",()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{});}catch{reject(new Error("invalid_json"));}});
    req.on("error",reject);
  });
}

function notify(channel,payload) {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel,payload);
}

function authorized(session, req, url) {
  const supplied=String(req.headers["x-vcam-visual-token"] || url.searchParams.get("token") || "");
  const expected=String(session.token);
  if (supplied.length !== expected.length) return false;
  try{return crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));}catch{return false;}
}

function sanitizeSample(input={}) {
  const mode = input.mode === "webxr" ? "webxr" : "optical-flow";
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,Number.isFinite(Number(v))?Number(v):0));
  const base={received_at:new Date().toISOString(),client_time_ms:clamp(input.client_time_ms,0,9e15),mode,metric:mode==="webxr" && input.metric===true};
  if(mode==="webxr"){
    base.position={x:clamp(input.position?.x,-1000,1000),y:clamp(input.position?.y,-1000,1000),z:clamp(input.position?.z,-1000,1000)};
    base.orientation={x:clamp(input.orientation?.x,-1,1),y:clamp(input.orientation?.y,-1,1),z:clamp(input.orientation?.z,-1,1),w:clamp(input.orientation?.w,-1,1)};
    base.confidence=1;
  }else{
    base.delta={x:clamp(input.delta?.x,-2,2),y:clamp(input.delta?.y,-2,2),z:clamp(input.delta?.z,-2,2)};
    base.transform={dx:clamp(input.transform?.dx,-20,20),dy:clamp(input.transform?.dy,-20,20),scale:clamp(input.transform?.scale,0.8,1.2),score:clamp(input.transform?.score,0,255)};
    base.confidence=clamp(input.confidence,0,1);
  }
  return base;
}

function visualRoot(sceneDir){return path.join(sceneDir,"previews","virtual-camera-visual");}
function nextTakeNumber(sceneDir,shotId){const dir=path.join(visualRoot(sceneDir),safeShot(shotId));if(!fs.existsSync(dir))return 1;const nums=fs.readdirSync(dir).map(name=>name.match(/^take_(\d{3})\.json$/)).filter(Boolean).map(m=>Number(m[1]));return nums.length?Math.max(...nums)+1:1;}

function linkedImuTake(sceneDir,shotId){
  const shot=safeShot(shotId);const dir=path.join(sceneDir,"previews","virtual-camera",shot);const markerFile=path.join(dir,"selected.json");
  try{const marker=JSON.parse(fs.readFileSync(markerFile,"utf8"));const file=path.join(dir,String(marker.take_file||`take_${String(marker.take_number).padStart(3,"0")}.json`));const take=JSON.parse(fs.readFileSync(file,"utf8"));return {marker,take};}catch{return null;}
}

function writeTake(session,recording){
  const {sceneDir}=resolveScene(session.project,session.scene);const takeNumber=nextTakeNumber(sceneDir,recording.shotId);const linked=linkedImuTake(sceneDir,recording.shotId);
  const take=makeVisualTake({shotId:recording.shotId,samples:recording.samples,startedAt:recording.startedAt,stoppedAt:new Date().toISOString(),takeNumber,linkedVcamTake:linked?.marker||null,imuAnalysis:linked?.take?.analysis||null});
  const dir=path.join(visualRoot(sceneDir),safeShot(recording.shotId));fs.mkdirSync(dir,{recursive:true});const output=path.join(dir,`take_${String(takeNumber).padStart(3,"0")}.json`);const tmp=`${output}.${process.pid}.tmp`;fs.writeFileSync(tmp,`${JSON.stringify(take,null,2)}\n`,`utf8`);fs.renameSync(tmp,output);
  return {...take,path:output,samples:undefined};
}

function listTakes(project,scene){
  const {sceneDir}=resolveScene(project,scene);const root=visualRoot(sceneDir);if(!fs.existsSync(root))return[];const rows=[];
  for(const shot of fs.readdirSync(root,{withFileTypes:true})){if(!shot.isDirectory())continue;const dir=path.join(root,shot.name);for(const name of fs.readdirSync(dir).filter(x=>/^take_\d{3}\.json$/.test(x))){try{const take=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));rows.push({shot_id:take.shot_id,take_number:take.take_number,tracking_mode:take.tracking_mode,metric:take.metric,sample_count:take.sample_count,analysis:take.analysis,fused_prompt:take.fused_prompt,stopped_at:take.stopped_at,path:path.join(dir,name)});}catch{}}}
  return rows.sort((a,b)=>String(b.stopped_at||"").localeCompare(String(a.stopped_at||"")));
}

function publicStatus(session){
  if(!session)return{active:false,recording:false};const addresses=lanAddresses();const host=addresses[0]?.address||"127.0.0.1";const bootstrap=`http://${host}:${session.httpPort}/?token=${encodeURIComponent(session.token)}`;const secure=session.httpsPort?`https://${host}:${session.httpsPort}/?token=${encodeURIComponent(session.token)}`:null;
  return {active:true,project:session.project,scene:session.scene,session_id:session.id,recording:Boolean(session.recording),shot_id:session.recording?.shotId||null,sample_count:session.recording?.samples?.length||0,tracking_mode:session.latestSample?.mode||null,last_sample:session.latestSample||null,bootstrap_url:bootstrap,secure_url:secure,qr_data_uri:qrDataUri(bootstrap,{scale:4,margin:3}),tls:{available:Boolean(session.tls?.available),fingerprint_sha256:session.tls?.fingerprint_sha256||null,error:session.tls?.error||null},webxr_expected:"Android Chrome / compatible WebXR AR browser",ios_fallback:"HTTPS getUserMedia optical flow"};
}

function startRecording(session,request={}){if(!session)throw new Error("visual_session_not_active");if(session.recording)throw new Error("visual_already_recording");session.recording={shotId:safeShot(request.shotId),startedAt:new Date().toISOString(),samples:[],lastSampleAt:0};notify("virtual-camera-visual:status",publicStatus(session));return publicStatus(session);}
function stopRecording(session){if(!session?.recording)throw new Error("visual_not_recording");const recording=session.recording;session.recording=null;const take=writeTake(session,recording);notify("virtual-camera-visual:take",take);notify("virtual-camera-visual:status",publicStatus(session));return take;}
function recordSample(session,input){const now=Date.now();const sample=sanitizeSample(input);session.latestSample=sample;if(session.recording&&now-session.recording.lastSampleAt>=MIN_SAMPLE_INTERVAL_MS){session.recording.samples.push(sample);session.recording.lastSampleAt=now;}notify("virtual-camera-visual:sample",sample);return sample;}

function bootstrapPage(session){const status=publicStatus(session);return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FilmMate Visual Pairing</title><style>body{margin:0;background:#0b0d10;color:#f5f6f7;font:15px system-ui;padding:24px}.card{max-width:620px;margin:auto;border:1px solid #30363d;background:#14181d;border-radius:18px;padding:20px}h1{margin-top:0}.btn{display:block;text-decoration:none;text-align:center;margin:10px 0;border-radius:12px;padding:14px;background:#b9ff55;color:#10120d;font-weight:900}.secondary{background:#222931;color:#fff}.note{color:#9aa3ad;line-height:1.6}.warn{border:1px solid #6e552c;background:#211b12;color:#ffd58a;border-radius:12px;padding:12px}</style></head><body><div class="card"><h1>FilmMate Visual / AR Tracking</h1><p class="note">후면 카메라 또는 WebXR 6DoF를 이용해 VCAM 이동 경로를 보정합니다.</p>${session.tls?.available?`<div class="warn">최초 1회: 아래 CA 인증서를 설치하고 기기에서 신뢰한 뒤 HTTPS 컨트롤러를 여세요.</div><a class="btn secondary" href="/ca.cer?token=${encodeURIComponent(session.token)}">1. FilmMate VCAM CA 설치</a><a class="btn" href="${status.secure_url}">2. HTTPS Visual Tracker 열기</a><p class="note">CA SHA-256: ${session.tls.fingerprint_sha256||"—"}</p>`:`<div class="warn">HTTPS 인증서를 만들 수 없습니다: ${String(session.tls?.error||"OpenSSL unavailable")}. 카메라/getUserMedia는 secure context가 필요하므로 Visual Tracker를 사용할 수 없습니다.</div>`}</div></body></html>`;}

function visualPage(session){const token=JSON.stringify(session.token);return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta name="theme-color" content="#080a0d"><title>FilmMate Visual Tracker</title><style>*{box-sizing:border-box}body{margin:0;background:#080a0d;color:#f4f6f8;font:14px system-ui;padding:16px}.top{display:flex;justify-content:space-between;align-items:center}.brand{font-weight:900;font-size:20px}.brand b{color:#b9ff55}.badge{border:1px solid #35404b;border-radius:999px;padding:6px 9px;color:#9ca7b2}.view{position:relative;margin:14px 0;background:#11161b;border:1px solid #303943;border-radius:16px;overflow:hidden;aspect-ratio:3/4;display:grid;place-items:center}video{width:100%;height:100%;object-fit:cover}.hud{position:absolute;inset:12px;pointer-events:none;border:1px solid #b9ff5555}.hud:before,.hud:after{content:"";position:absolute;background:#b9ff5544}.hud:before{width:1px;height:100%;left:50%}.hud:after{height:1px;width:100%;top:50%}.read{position:absolute;left:10px;bottom:9px;font:11px ui-monospace;color:#cfff91}.controls{display:grid;gap:8px}.row{display:flex;gap:8px}.row>*{flex:1}button,input{font:inherit}.btn{border:1px solid #35404b;background:#171d23;color:#fff;border-radius:12px;padding:13px;font-weight:850}.primary{background:#b9ff55;color:#111;border-color:#b9ff55}.rec{background:#552027;border-color:#873642;color:#ffb1ba}.btn:disabled{opacity:.4}.note{margin-top:10px;border:1px solid #38434e;border-radius:11px;padding:11px;color:#aab4be;line-height:1.5}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:8px 0}.stat{border:1px solid #303943;background:#12171c;border-radius:10px;padding:8px;text-align:center}.stat small{display:block;color:#84909c}.stat b{font:13px ui-monospace;color:#dfffbc}</style></head><body><div class="top"><div class="brand">FilmMate <b>VISUAL V3</b></div><span class="badge" id="mode">CHECKING</span></div><div class="view"><video id="video" playsinline muted></video><canvas id="xr" style="display:none"></canvas><div class="hud"><div class="read" id="read">READY</div></div></div><div class="stats"><div class="stat"><small>X</small><b id="x">0.000</b></div><div class="stat"><small>Y</small><b id="y">0.000</b></div><div class="stat"><small>Z</small><b id="z">0.000</b></div></div><div class="controls"><div class="row"><button class="btn primary" id="xrStart">WebXR 6DoF</button><button class="btn" id="flowStart">카메라 추적</button></div><div class="row"><input class="btn" id="shot" value="C01"><button class="btn rec" id="rec">● REC</button><button class="btn" id="stop" disabled>STOP</button></div></div><div class="note" id="note">지원 기능 확인 중…</div><script>const TOKEN=${token},$=id=>document.getElementById(id);let trackerMode='none',xrSession=null,stream=null,flowTimer=null,lastSent=0,prev=null;const W=64,H=48,work=document.createElement('canvas');work.width=W;work.height=H;const ctx=work.getContext('2d',{willReadFrequently:true});async function api(path,options={}){const response=await fetch(path,{...options,headers:{'content-type':'application/json','x-vcam-visual-token':TOKEN,...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||'request_failed');return data}function readout(v,metric){$('x').textContent=(v.x||0).toFixed(3)+(metric?'m':'');$('y').textContent=(v.y||0).toFixed(3)+(metric?'m':'');$('z').textContent=(v.z||0).toFixed(3)+(metric?'m':'')}function gray(){ctx.drawImage($('video'),0,0,W,H);const d=ctx.getImageData(0,0,W,H).data,a=new Uint8Array(W*H);for(let i=0,j=0;i<d.length;i+=4,j++)a[j]=(d[i]*77+d[i+1]*150+d[i+2]*29)>>8;return a}function sample(a,x,y){x=Math.max(0,Math.min(W-1,Math.round(x)));y=Math.max(0,Math.min(H-1,Math.round(y)));return a[y*W+x]}function estimate(p,c){const scales=[.96,.98,1,1.02,1.04],m=7,cx=(W-1)/2,cy=(H-1)/2;let best={score:1e9,dx:0,dy:0,scale:1};for(const s of scales)for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){let e=0,n=0;for(let y=m;y<H-m;y+=3)for(let x=m;x<W-m;x+=3){const px=cx+(x-cx)/s+dx,py=cy+(y-cy)/s+dy;if(px<1||px>=W-1||py<1||py>=H-1)continue;e+=Math.abs(c[y*W+x]-sample(p,px,py));n++}const score=n?e/n:1e9;if(score<best.score)best={score,dx,dy,scale:s}}let texture=0,n=0;for(let y=1;y<H-1;y+=3)for(let x=1;x<W-1;x+=3){const v=c[y*W+x];texture+=Math.abs(v-c[y*W+x+1])+Math.abs(v-c[(y+1)*W+x]);n+=2}const conf=Math.max(0,Math.min(1,(texture/Math.max(1,n))/45));return{...best,confidence:conf}}async function startFlow(){if(stream)return;stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640},height:{ideal:480}},audio:false});$('video').srcObject=stream;await $('video').play();trackerMode='optical-flow';$('mode').textContent='VISUAL FLOW';$('note').textContent='후면 카메라 특징 이동으로 상대 경로를 추정합니다. 미터 단위가 아닙니다.';prev=null;flowTimer=setInterval(async()=>{if($('video').readyState<2)return;const cur=gray();if(prev){const t=estimate(prev,cur),delta={x:Math.max(-1,Math.min(1,-t.dx/(W*.12))),y:Math.max(-1,Math.min(1,t.dy/(H*.12))),z:Math.max(-1,Math.min(1,(t.scale-1)/.04))};readout(delta,false);try{await api('/api/sample',{method:'POST',body:JSON.stringify({mode:'optical-flow',metric:false,delta,transform:t,confidence:t.confidence,client_time_ms:Date.now()})})}catch{}}prev=cur},125)}async function startXR(){if(!navigator.xr||!(await navigator.xr.isSessionSupported('immersive-ar')))throw new Error('이 브라우저는 WebXR immersive-ar를 지원하지 않습니다. 카메라 추적을 사용하세요.');xrSession=await navigator.xr.requestSession('immersive-ar',{optionalFeatures:['local-floor','dom-overlay'],domOverlay:{root:document.body}});const canvas=$('xr'),gl=canvas.getContext('webgl',{alpha:true,xrCompatible:true});await gl.makeXRCompatible();xrSession.updateRenderState({baseLayer:new XRWebGLLayer(xrSession,gl)});const ref=await xrSession.requestReferenceSpace('local');trackerMode='webxr';$('mode').textContent='WEBXR 6DOF';$('note').textContent='WebXR 공간 포즈 사용 중 · 위치값은 로컬 기준 미터입니다.';xrSession.addEventListener('end',()=>{xrSession=null;trackerMode='none';$('mode').textContent='XR ENDED'});const loop=(time,frame)=>{const pose=frame.getViewerPose(ref);if(pose&&time-lastSent>65){lastSent=time;const p=pose.transform.position,q=pose.transform.orientation;readout({x:p.x,y:p.y,z:-p.z},true);api('/api/sample',{method:'POST',body:JSON.stringify({mode:'webxr',metric:true,position:{x:p.x,y:p.y,z:p.z},orientation:{x:q.x,y:q.y,z:q.z,w:q.w},client_time_ms:Date.now()})}).catch(()=>{})}const layer=xrSession.renderState.baseLayer;gl.bindFramebuffer(gl.FRAMEBUFFER,layer.framebuffer);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);xrSession.requestAnimationFrame(loop)};xrSession.requestAnimationFrame(loop)}$('flowStart').onclick=()=>startFlow().catch(e=>$('note').textContent=e.message);$('xrStart').onclick=()=>startXR().catch(e=>$('note').textContent=e.message);$('rec').onclick=async()=>{try{await api('/api/record/start',{method:'POST',body:JSON.stringify({shotId:$('shot').value})});$('rec').disabled=true;$('stop').disabled=false;$('read').textContent='● REC '+trackerMode.toUpperCase()}catch(e){$('note').textContent=e.message}};$('stop').onclick=async()=>{try{const take=await api('/api/record/stop',{method:'POST',body:'{}'});$('rec').disabled=false;$('stop').disabled=true;$('read').textContent='TAKE '+String(take.take_number).padStart(2,'0')+' SAVED';$('note').textContent=take.fused_prompt||take.analysis?.prompt||'Saved'}catch(e){$('note').textContent=e.message}};(async()=>{try{const xr=Boolean(navigator.xr&&await navigator.xr.isSessionSupported('immersive-ar'));$('xrStart').disabled=!xr;$('note').textContent=xr?'WebXR 6DoF 사용 가능. Android 계열에서는 우선 WebXR를 권장합니다.':'WebXR AR 미지원. HTTPS 후면 카메라 Visual Flow를 사용하세요.';$('mode').textContent=xr?'XR READY':'FLOW READY'}catch{$('xrStart').disabled=true;$('mode').textContent='FLOW READY'}})();</script></body></html>`;}

async function listen(server){await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"0.0.0.0",resolve);});return server.address().port;}

async function startSession(project,scene){
  if(activeSession&&activeSession.project===project&&activeSession.scene===scene)return publicStatus(activeSession);if(activeSession)await stopSession();resolveScene(project,scene);const addresses=lanAddresses().map(x=>x.address);const tls=tryEnsureTlsMaterial({root:path.join(app.getPath("userData"),"virtual-camera","tls"),addresses});const session={id:crypto.randomUUID(),token:crypto.randomBytes(18).toString("base64url"),project:String(project),scene:String(scene),tls,httpServer:null,httpsServer:null,httpPort:null,httpsPort:null,recording:null,latestSample:null};
  const route=secure=>async(req,res)=>{const url=new URL(req.url||"/",`${secure?"https":"http"}://localhost`);try{if(req.method==="GET"&&url.pathname==="/"){if(!authorized(session,req,url))return html(res,403,"<h1>Invalid visual tracking session.</h1>");return html(res,200,secure?visualPage(session):bootstrapPage(session));}if(!authorized(session,req,url))return json(res,403,{error:"unauthorized"});if(!secure&&req.method==="GET"&&url.pathname==="/ca.cer"&&session.tls?.available){const bytes=fs.readFileSync(session.tls.ca_cer);res.writeHead(200,{"content-type":"application/x-x509-ca-cert","content-length":bytes.length,"content-disposition":"attachment; filename=FilmMate-VCAM-CA.cer","cache-control":"no-store"});return res.end(bytes);}if(req.method==="GET"&&url.pathname==="/api/status")return json(res,200,publicStatus(session));if(req.method==="POST"&&url.pathname==="/api/sample")return json(res,200,{ok:true,sample:recordSample(session,await parseBody(req))});if(req.method==="POST"&&url.pathname==="/api/record/start")return json(res,200,startRecording(session,await parseBody(req)));if(req.method==="POST"&&url.pathname==="/api/record/stop")return json(res,200,stopRecording(session));return json(res,404,{error:"not_found"});}catch(error){return json(res,400,{error:error?.message||String(error)});}};
  session.httpServer=http.createServer(route(false));session.httpPort=await listen(session.httpServer);if(tls.available){session.httpsServer=https.createServer({key:fs.readFileSync(tls.server_key),cert:fs.readFileSync(tls.server_cert)},route(true));session.httpsPort=await listen(session.httpsServer);}activeSession=session;notify("virtual-camera-visual:status",publicStatus(session));return publicStatus(session);
}

async function stopSession(){const session=activeSession;activeSession=null;if(!session)return{active:false};if(session.recording){try{stopRecording(session);}catch{}}await Promise.all([session.httpServer&&new Promise(r=>session.httpServer.close(r)),session.httpsServer&&new Promise(r=>session.httpsServer.close(r))].filter(Boolean));notify("virtual-camera-visual:status",{active:false,recording:false});return{active:false};}

function installVisualCamera(){if(installed)return;installed=true;ipcMain.handle("virtual-camera-visual:start-session",(_e,project,scene)=>startSession(project,scene));ipcMain.handle("virtual-camera-visual:stop-session",()=>stopSession());ipcMain.handle("virtual-camera-visual:status",()=>publicStatus(activeSession));ipcMain.handle("virtual-camera-visual:start-recording",(_e,request)=>startRecording(activeSession,request||{}));ipcMain.handle("virtual-camera-visual:stop-recording",()=>stopRecording(activeSession));ipcMain.handle("virtual-camera-visual:list-takes",(_e,project,scene)=>listTakes(project,scene));ipcMain.handle("virtual-camera-visual:open-folder",async(_e,project,scene)=>{const {sceneDir}=resolveScene(project,scene);const root=visualRoot(sceneDir);fs.mkdirSync(root,{recursive:true});const error=await shell.openPath(root);if(error)throw new Error(error);return{path:root};});ipcMain.handle("virtual-camera-visual:copy-text",(_e,text)=>{clipboard.writeText(String(text||""));return true;});app.on("before-quit",()=>{if(activeSession?.httpServer)activeSession.httpServer.close();if(activeSession?.httpsServer)activeSession.httpsServer.close();activeSession=null;});}

module.exports={installVisualCamera,sanitizeSample};
