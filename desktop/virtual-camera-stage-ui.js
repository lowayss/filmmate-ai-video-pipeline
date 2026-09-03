(() => {
  const stage = window.FilmMateStage;
  const bridge = window.virtualCameraStage;
  if (!stage || !bridge) return;

  const state = {scene:stage.defaultScene(),rig:stage.createRig(),targetKey:null,paths:[],recording:false,pathSamples:[],pathStartedAt:null,lastCaptureAt:0,replaying:false,replayToken:0,error:null};
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function target() { try { if (typeof selected === "undefined" || !selected) return null; return {project:selected.project,scene:sceneId(selected)}; } catch { return null; } }
  function keyOf(t) { return t ? `${t.project}/${t.scene}` : ""; }
  function card() { return document.getElementById("vcam-stage-v4"); }

  async function ensureLoaded(force=false) {
    const t=target(),key=keyOf(t); if(!t)return;
    if(!force && state.targetKey===key)return;
    state.targetKey=key; state.rig=stage.createRig(); state.replaying=false; state.recording=false; state.pathSamples=[];
    try { state.scene=stage.normalizeScene(await bridge.load(t.project,t.scene)); state.paths=await bridge.listPaths(t.project,t.scene); state.error=null; }
    catch(error) { state.scene=stage.defaultScene(); state.paths=[]; state.error=error?.message||String(error); }
  }

  function install() {
    const shell=document.querySelector(".vcam-shell"); if(!shell)return;
    if(card())return;
    ensureLoaded().then(()=>{ if(!document.querySelector(".vcam-shell")||card())return; const section=document.createElement("section"); section.id="vcam-stage-v4"; section.className="vcam-card vcam-stage-card"; shell.appendChild(section); render(); });
  }

  function objectRows() {
    return state.scene.objects.map((o,index)=>`<div class="stage-object-row"><div class="stage-object-name"><b>${escapeHtml(o.label)}</b><small>${escapeHtml(o.type)}</small></div>${["x","y","z"].map(axis=>`<label>${axis.toUpperCase()}<input type="number" step="0.1" data-stage-object="${index}" data-stage-axis="${axis}" value="${Number(o.position[axis]).toFixed(2)}"></label>`).join("")}</div>`).join("");
  }
  function pathRows() {
    if(!state.paths.length)return `<div class="vcam-empty">저장된 3D Camera Path가 없습니다.</div>`;
    return state.paths.slice(0,8).map(p=>`<div class="stage-path-row"><div><b>${escapeHtml(p.shot_id)} · PATH ${String(p.path_number).padStart(2,"0")}</b><small>${p.metric?"METRIC":"RELATIVE"} · ${p.sample_count} samples</small></div><button class="btn" data-stage-replay="${escapeHtml(p.shot_id)}" data-stage-path="${p.path_number}">재생</button></div>`).join("");
  }

  function render() {
    const node=card(); if(!node)return; const c=state.rig.camera;
    node.innerHTML=`<div class="vcam-card-head"><div><span class="vcam-kicker">LIVE 3D BLOCKOUT · V4</span><h2>휴대폰으로 3D 카메라 직접 운전</h2></div><span class="vcam-status on" id="stage-source">${escapeHtml(state.rig.source.toUpperCase())}${state.rig.metric?" · METRIC":" · RELATIVE"}</span></div>
      <p class="muted">WebXR/Visual 위치와 IMU 회전을 FilmMate 3D 스테이지 카메라에 실시간 적용합니다. +X 오른쪽 · +Y 위 · 카메라 전방 -Z.</p>
      ${state.error?`<div class="vcam-error">${escapeHtml(state.error)}</div>`:""}
      <div class="stage-view-wrap"><canvas id="stage-canvas"></canvas><div class="stage-hud"><span id="stage-pos">X ${c.position.x.toFixed(2)} · Y ${c.position.y.toFixed(2)} · Z ${c.position.z.toFixed(2)}</span><span id="stage-fov-hud">${c.fov_deg.toFixed(0)}mm VIEW / ${c.fov_deg.toFixed(0)}° FOV</span></div></div>
      <div class="stage-toolbar"><button class="btn" id="stage-add-actor">+ Actor</button><button class="btn" id="stage-add-box">+ Block</button><button class="btn" id="stage-reset-camera">카메라 원점</button><button class="btn" id="stage-save">블록아웃 저장</button><button class="btn" id="stage-open-folder">폴더</button></div>
      <div class="stage-fov"><label>FOV <b id="stage-fov-value">${c.fov_deg.toFixed(0)}°</b></label><input id="stage-fov" type="range" min="18" max="100" step="1" value="${c.fov_deg}"></div>
      <div class="stage-path-controls"><label>Shot <input id="stage-shot" value="C01"></label><button class="btn vcam-record" id="stage-record" ${state.recording?"disabled":""}>● 3D PATH REC</button><button class="btn" id="stage-stop" ${state.recording?"":"disabled"}>STOP & SAVE</button><span class="stage-rec-state ${state.recording?"on":""}">${state.recording?`● ${state.pathSamples.length} samples`:state.replaying?"REPLAY":"READY"}</span></div>
      <details class="stage-editor"><summary>블록아웃 위치 편집 <span>${state.scene.objects.length} objects</span></summary><div class="stage-object-list">${objectRows()}</div></details>
      <div class="stage-path-list"><div class="vcam-card-head"><div><span class="vcam-kicker">3D CAMERA PATHS</span><h3>저장된 경로</h3></div></div>${pathRows()}</div>`;
    bind(); draw();
  }

  function bind() {
    document.getElementById("stage-add-actor")?.addEventListener("click",()=>{state.scene=stage.addObject(state.scene,"actor");render();});
    document.getElementById("stage-add-box")?.addEventListener("click",()=>{state.scene=stage.addObject(state.scene,"box");render();});
    document.getElementById("stage-reset-camera")?.addEventListener("click",()=>{stage.resetRig(state.rig);state.replaying=false;state.replayToken++;draw();updateHud();});
    document.getElementById("stage-fov")?.addEventListener("input",e=>{state.rig.camera.fov_deg=stage.clamp(e.target.value,18,100);document.getElementById("stage-fov-value").textContent=`${state.rig.camera.fov_deg.toFixed(0)}°`;draw();updateHud();});
    document.querySelectorAll("[data-stage-object]").forEach(input=>input.addEventListener("input",e=>{const index=Number(e.target.dataset.stageObject),axis=e.target.dataset.stageAxis;if(!state.scene.objects[index])return;state.scene.objects[index].position[axis]=stage.clamp(e.target.value,-50,50);draw();}));
    document.getElementById("stage-save")?.addEventListener("click",async()=>{const t=target();if(!t)return;try{state.scene=stage.normalizeScene(await bridge.save(t.project,t.scene,state.scene));state.error=null;render();}catch(error){state.error=error?.message||String(error);render();}});
    document.getElementById("stage-open-folder")?.addEventListener("click",async()=>{const t=target();if(t)try{await bridge.openFolder(t.project,t.scene);}catch(error){state.error=error?.message||String(error);render();}});
    document.getElementById("stage-record")?.addEventListener("click",()=>{state.replaying=false;state.replayToken++;state.recording=true;state.pathSamples=[];state.pathStartedAt=new Date().toISOString();state.lastCaptureAt=0;render();});
    document.getElementById("stage-stop")?.addEventListener("click",stopAndSavePath);
    document.querySelectorAll("[data-stage-replay]").forEach(button=>button.addEventListener("click",()=>replay(button.dataset.stageReplay,Number(button.dataset.stagePath))));
  }

  async function stopAndSavePath() {
    if(!state.recording)return; state.recording=false; const t=target(),shot=document.getElementById("stage-shot")?.value||"C01";
    try { if(!t)throw new Error("씬 정보를 찾지 못했습니다."); await bridge.savePath(t.project,t.scene,{shot_id:shot,started_at:state.pathStartedAt,stopped_at:new Date().toISOString(),samples:state.pathSamples}); state.paths=await bridge.listPaths(t.project,t.scene); state.error=null; }
    catch(error){state.error=error?.message||String(error);} render();
  }

  function capture(source) {
    if(!state.recording||state.replaying)return; const now=Date.now(); if(now-state.lastCaptureAt<30)return; state.lastCaptureAt=now; state.pathSamples.push(stage.rigSnapshot(state.rig,source,now)); if(state.pathSamples.length>12000)state.pathSamples.shift(); updateHud();
  }

  async function replay(shotId,pathNumber) {
    const t=target(); if(!t)return; try {
      const payload=await bridge.loadPath(t.project,t.scene,shotId,pathNumber); if(!payload.samples?.length)return; state.replaying=true;state.recording=false;const token=++state.replayToken,start=performance.now(),first=payload.samples[0].client_time_ms,last=payload.samples[payload.samples.length-1].client_time_ms,duration=Math.max(800,Math.min(20000,last-first||3000));
      const tick=now=>{if(token!==state.replayToken)return;const u=Math.min(1,(now-start)/duration),pose=stage.interpolatePath(payload.samples,u);if(pose?.camera){state.rig.camera=JSON.parse(JSON.stringify(pose.camera));state.rig.source="replay";state.rig.metric=Boolean(pose.metric);}draw();updateHud();if(u<1)requestAnimationFrame(tick);else{state.replaying=false;updateHud();}};requestAnimationFrame(tick);
    } catch(error){state.error=error?.message||String(error);render();}
  }

  function updateHud() {
    const c=state.rig.camera,source=document.getElementById("stage-source"),pos=document.getElementById("stage-pos"),fov=document.getElementById("stage-fov-hud"),rec=document.querySelector(".stage-rec-state");
    if(source)source.textContent=`${String(state.rig.source||"idle").toUpperCase()}${state.rig.metric?" · METRIC":" · RELATIVE"}`;
    if(pos)pos.textContent=`X ${c.position.x.toFixed(2)} · Y ${c.position.y.toFixed(2)} · Z ${c.position.z.toFixed(2)}`;
    if(fov)fov.textContent=`${c.fov_deg.toFixed(0)}° FOV`;
    if(rec)rec.textContent=state.recording?`● ${state.pathSamples.length} samples`:state.replaying?"REPLAY":"READY";
  }

  function line(ctx,a,b) { if(!a||!b)return;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke(); }
  function draw() {
    const canvas=document.getElementById("stage-canvas"); if(!canvas)return; const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(320,Math.round(rect.width*dpr)),h=Math.max(180,Math.round(rect.height*dpr)); if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} const ctx=canvas.getContext("2d");
    ctx.clearRect(0,0,w,h);ctx.fillStyle="#0a0d11";ctx.fillRect(0,0,w,h);ctx.lineWidth=Math.max(1,dpr);
    const camera=state.rig.camera,grid=state.scene.grid,size=grid.size/2,step=grid.step;ctx.strokeStyle="#25303a";
    for(let n=-size;n<=size+.001;n+=step){line(ctx,stage.projectPoint({x:n,y:0,z:-size},camera,w,h),stage.projectPoint({x:n,y:0,z:size},camera,w,h));line(ctx,stage.projectPoint({x:-size,y:0,z:n},camera,w,h),stage.projectPoint({x:size,y:0,z:n},camera,w,h));}
    const faceColors={actor:"rgba(185,255,85,.18)",table:"rgba(93,182,255,.17)",wall:"rgba(180,185,195,.10)",box:"rgba(255,183,77,.15)",prop:"rgba(210,150,255,.16)"};
    for(const object of state.scene.objects){const projected=stage.projectBox(object,camera,w,h);ctx.fillStyle=faceColors[object.type]||faceColors.box;ctx.strokeStyle=object.type==="actor"?"#b9ff55":"#7e8b98";for(const face of projected.faces){ctx.beginPath();face.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fill();ctx.stroke();}const top=stage.projectPoint({x:object.position.x,y:object.position.y+object.size.y/2+.12,z:object.position.z},camera,w,h);if(top){ctx.fillStyle="#dfe6ed";ctx.font=`${11*dpr}px system-ui`;ctx.textAlign="center";ctx.fillText(object.label,top.x,top.y);}}
    ctx.strokeStyle="rgba(185,255,85,.55)";ctx.beginPath();ctx.moveTo(w/2-12*dpr,h/2);ctx.lineTo(w/2+12*dpr,h/2);ctx.moveTo(w/2,h/2-12*dpr);ctx.lineTo(w/2,h/2+12*dpr);ctx.stroke(); drawTopMap(ctx,w,h,dpr);
  }

  function drawTopMap(ctx,w,h,dpr) {
    const mw=170*dpr,mh=120*dpr,x=w-mw-12*dpr,y=12*dpr,scale=Math.min(mw,mh)/14;ctx.fillStyle="rgba(5,8,11,.82)";ctx.fillRect(x,y,mw,mh);ctx.strokeStyle="#38434e";ctx.strokeRect(x,y,mw,mh);const tx=v=>x+mw/2+v*scale,tz=v=>y+mh/2+v*scale;
    for(const o of state.scene.objects){ctx.fillStyle=o.type==="actor"?"#b9ff55":"#65717d";ctx.fillRect(tx(o.position.x)-2*dpr,tz(o.position.z)-2*dpr,4*dpr,4*dpr);}const c=state.rig.camera,f=stage.cameraForward(c);ctx.fillStyle="#ff6969";ctx.beginPath();ctx.arc(tx(c.position.x),tz(c.position.z),4*dpr,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#ff6969";ctx.beginPath();ctx.moveTo(tx(c.position.x),tz(c.position.z));ctx.lineTo(tx(c.position.x+f.x*1.2),tz(c.position.z+f.z*1.2));ctx.stroke();ctx.fillStyle="#95a1ad";ctx.font=`${9*dpr}px system-ui`;ctx.textAlign="left";ctx.fillText("TOP",x+6*dpr,y+11*dpr);
  }

  window.virtualCameraVisual?.onSample(sample=>{if(state.replaying)return;stage.applyVisualSample(state.rig,sample);capture(sample.mode);draw();updateHud();});
  window.virtualCamera?.onSample(sample=>{if(state.replaying)return;stage.applyImuSample(state.rig,sample);capture("imu");draw();updateHud();});
  const observer=new MutationObserver(()=>install()); observer.observe(document.documentElement,{childList:true,subtree:true}); install();
})();
