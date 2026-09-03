(() => {
  const bridge = window.virtualCameraVisual;
  if (!bridge) return;
  const state={status:{active:false,recording:false},takes:[],latest:null,lastSample:null};
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const target=()=>{try{return selected?{project:selected.project,scene:sceneId(selected)}:null}catch{return null}};
  const shots=()=>{try{return Array.isArray(detail?.conhap?.shots)?detail.conhap.shots:[]}catch{return[]}};
  const matches=()=>{const t=target(),s=state.status;return Boolean(t&&s.active&&s.project===t.project&&s.scene===t.scene)};

  function samplePosition(sample){
    if(sample?.mode==="webxr")return{x:Number(sample.position?.x||0),y:Number(sample.position?.y||0),z:Number(-(sample.position?.z||0)),metric:true};
    return{x:Number(sample?.delta?.x||0),y:Number(sample?.delta?.y||0),z:Number(sample?.delta?.z||0),metric:false};
  }

  function updateReadout(sample){
    const p=samplePosition(sample);for(const axis of ["x","y","z"]){const node=document.getElementById(`vcam-v3-${axis}`);if(node)node.textContent=p[axis].toFixed(3)+(p.metric?"m":"");}
    const mode=document.getElementById("vcam-v3-mode");if(mode)mode.textContent=sample?.mode==="webxr"?"WEBXR 6DOF":sample?.mode==="optical-flow"?"VISUAL FLOW":"WAITING";
    const confidence=document.getElementById("vcam-v3-confidence");if(confidence)confidence.textContent=sample?.mode==="webxr"?"HIGH":sample?.confidence!=null?`${Math.round(Number(sample.confidence)*100)}%`:"—";
  }

  function renderCard(){
    const shell=document.querySelector(".vcam-shell");if(!shell)return;
    let host=document.getElementById("vcam-visual-v3-host");if(!host){host=document.createElement("section");host.id="vcam-visual-v3-host";host.className="vcam-card vcam-v3-card";shell.appendChild(host);}
    const current=matches(),s=state.status||{},shotOptions=shots();
    const options=shotOptions.length?shotOptions.map((shot,index)=>`<option value="${esc(shot.id||`C${String(index+1).padStart(2,"0")}`)}">${esc(shot.id||`C${String(index+1).padStart(2,"0")}`)}</option>`).join(""):'<option value="C01">C01</option>';
    const latest=state.latest||state.takes[0]||null;
    host.innerHTML=`<div class="vcam-card-head"><div><span class="vcam-kicker">VISUAL / AR POSE V3</span><h2>카메라 영상으로 VCAM 경로 보정</h2></div><span class="vcam-status ${current?'on':''}">${current?(s.recording?'● REC':'TRACK READY'):'OFFLINE'}</span></div>
    ${current?`<div class="vcam-v3-pair"><img src="${esc(s.qr_data_uri||'')}" alt="Visual tracker QR"><div><strong>휴대폰 Visual Tracker</strong><p>QR → CA 설치 → HTTPS Tracker. Android WebXR 지원 기기는 6DoF, iPhone은 후면 카메라 Visual Flow를 사용합니다.</p><div class="vcam-v3-links"><button class="btn" id="vcam-v3-copy">페어링 링크 복사</button><button class="btn danger" id="vcam-v3-stop-session">세션 종료</button></div><small>TLS ${s.tls?.available?'READY':'UNAVAILABLE'}${s.tls?.fingerprint_sha256?` · ${esc(String(s.tls.fingerprint_sha256).slice(0,23))}…`:''}</small></div></div>`:`<p class="muted">기존 IMU VCAM 위에 Visual/AR 추적을 추가합니다. WebXR가 되면 실제 로컬 미터 포즈를, 그렇지 않으면 non-metric 비주얼 이동 의도를 기록합니다.</p><button class="btn primary" id="vcam-v3-start-session">Visual / AR 세션 시작</button>`}
    <div class="vcam-v3-live"><div><small>MODE</small><b id="vcam-v3-mode">${esc(s.tracking_mode?String(s.tracking_mode).toUpperCase():'WAITING')}</b></div><div><small>X / TRUCK</small><b id="vcam-v3-x">0.000</b></div><div><small>Y / PEDESTAL</small><b id="vcam-v3-y">0.000</b></div><div><small>Z / DOLLY</small><b id="vcam-v3-z">0.000</b></div><div><small>CONFIDENCE</small><b id="vcam-v3-confidence">—</b></div></div>
    <div class="vcam-v3-record"><label>Shot<select id="vcam-v3-shot" ${!current||s.recording?'disabled':''}>${options}</select></label><button class="btn vcam-record" id="vcam-v3-rec" ${!current||s.recording?'disabled':''}>● VISUAL REC</button><button class="btn" id="vcam-v3-stop" ${!s.recording?'disabled':''}>STOP & FUSE</button><button class="btn" id="vcam-v3-folder" ${!current?'disabled':''}>폴더</button></div>
    ${latest?`<div class="vcam-v3-result"><div><strong>${esc(latest.shot_id)} · VISUAL TAKE ${String(latest.take_number).padStart(2,'0')}</strong><span class="vcam-status on">${latest.metric?'METRIC 6DOF':esc(String(latest.tracking_mode||'VISUAL').toUpperCase())}</span></div><p>${esc(latest.fused_prompt||latest.analysis?.prompt||'')}</p><button class="btn" id="vcam-v3-copy-prompt">융합 프롬프트 복사</button></div>`:''}`;
    bind();updateReadout(state.lastSample||s.last_sample);
  }

  async function refresh(){try{state.status=await bridge.status()}catch{state.status={active:false,recording:false}}const t=target();if(t){try{state.takes=await bridge.listTakes(t.project,t.scene)}catch{state.takes=[]}}}
  function error(message){const host=document.getElementById("vcam-visual-v3-host");if(!host)return;let node=host.querySelector(".vcam-v3-error");if(!node){node=document.createElement("div");node.className="vcam-v3-error";host.prepend(node)}node.textContent=message?.message||String(message)}
  function bind(){const t=target();document.getElementById("vcam-v3-start-session")?.addEventListener("click",async()=>{if(!t)return;try{state.status=await bridge.startSession(t.project,t.scene);renderCard()}catch(e){error(e)}});document.getElementById("vcam-v3-stop-session")?.addEventListener("click",async()=>{try{state.status=await bridge.stopSession();renderCard()}catch(e){error(e)}});document.getElementById("vcam-v3-copy")?.addEventListener("click",()=>bridge.copyText(state.status.bootstrap_url||""));document.getElementById("vcam-v3-rec")?.addEventListener("click",async()=>{try{state.status=await bridge.startRecording({shotId:document.getElementById("vcam-v3-shot")?.value||"C01"});renderCard()}catch(e){error(e)}});document.getElementById("vcam-v3-stop")?.addEventListener("click",async()=>{try{state.latest=await bridge.stopRecording();await refresh();renderCard()}catch(e){error(e)}});document.getElementById("vcam-v3-folder")?.addEventListener("click",()=>t&&bridge.openFolder(t.project,t.scene));document.getElementById("vcam-v3-copy-prompt")?.addEventListener("click",()=>bridge.copyText((state.latest||state.takes[0])?.fused_prompt||""));}
  function visible(){return Boolean(document.querySelector(".vcam-shell"))}
  bridge.onSample(sample=>{state.lastSample=sample;updateReadout(sample)});bridge.onStatus(status=>{state.status=status||{active:false,recording:false};if(visible())renderCard()});bridge.onTake(async take=>{state.latest=take;await refresh();if(visible())renderCard()});
  const observer=new MutationObserver(()=>{if(visible()&&!document.getElementById("vcam-visual-v3-host"))renderCard()});observer.observe(document.documentElement,{childList:true,subtree:true});refresh().then(()=>{if(visible())renderCard()});
})();
