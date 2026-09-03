(() => {
  const bridge=window.virtualCameraBlockout,visual=window.virtualCameraVisual,imu=window.virtualCamera;
  const math=window.FilmMateBlockoutMath,Renderer=window.FilmMateBlockoutRenderer;
  if(!bridge||!math||!Renderer)return;

  const state={status:{recording:false},layout:math.defaultBlockout(),takes:[],latest:null,visualSample:null,imuSample:null,calibration:null,cameraPose:null,path:[],selectedId:"actor-a",renderer:null,loadedKey:null,lastSentAt:0,followPhone:true};
  const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const target=()=>{try{return selected?{project:selected.project,scene:sceneId(selected)}:null}catch{return null}};
  const targetKey=()=>{const t=target();return t?`${t.project}::${t.scene}`:null};
  const shots=()=>{try{return Array.isArray(detail?.conhap?.shots)?detail.conhap.shots:[]}catch{return[]}};
  const visible=()=>Boolean(document.querySelector(".vcam-shell"));
  const currentCamera=()=>state.cameraPose||{position:[...(state.layout.camera?.position||[0,1.6,5])],orientation:[...(state.layout.camera?.orientation||[0,0,0,1])],metric:false,source:"manual"};

  function setCamera(pose,{appendPath=true}={}){
    if(!pose)return;state.cameraPose={...pose,position:[...pose.position],orientation:[...pose.orientation]};
    if(appendPath){state.path.push({position:[...pose.position]});if(state.path.length>360)state.path.splice(0,state.path.length-360);}
    updateReadouts();draw();pushFrame();
  }

  function recenter(){
    const pose=currentCamera();
    state.calibration=math.createCalibration({cameraPosition:pose.position,cameraOrientation:pose.orientation,visualSample:state.visualSample,imuSample:state.imuSample});
    state.path=[];draw();
    const note=document.getElementById("vcam-v4-note");if(note)note.textContent="현재 휴대폰 자세를 3D 카메라 원점으로 다시 맞췄습니다.";
  }

  function updateReadouts(){
    const pose=currentCamera(),p=pose.position||[0,0,0];
    const values={x:p[0],y:p[1],z:p[2]};for(const [axis,value] of Object.entries(values)){const node=document.getElementById(`vcam-v4-${axis}`);if(node)node.textContent=Number(value||0).toFixed(3)+(pose.metric?"m":"");}
    const source=document.getElementById("vcam-v4-source");if(source)source.textContent=pose.source==="webxr"?"WEBXR / METRIC":pose.source==="optical-flow"?"VISUAL / RELATIVE":pose.source==="imu"?"IMU ROTATION":"MANUAL";
    const frames=document.getElementById("vcam-v4-frames");if(frames)frames.textContent=String(state.status.frame_count||0);
  }

  function draw(){
    if(!state.renderer)return;const pose=currentCamera();
    state.renderer.setState({objects:state.layout.objects||[],camera:{position:pose.position,orientation:pose.orientation,fov:Number(state.layout.camera?.fov||50)},path:state.path,selectedId:state.selectedId});
  }

  function pushFrame(){
    if(!state.status.recording)return;const now=Date.now();if(now-state.lastSentAt<30)return;state.lastSentAt=now;
    const pose=currentCamera();bridge.appendFrame({client_time_ms:now,position:pose.position,orientation:pose.orientation,fov:Number(state.layout.camera?.fov||50),source:pose.source||"manual",metric:pose.metric===true}).then(result=>{if(result?.accepted){state.status.frame_count=result.frame_count;updateReadouts();}}).catch(showError);
  }

  function applyVisualSample(sample){
    state.visualSample=sample;if(!state.followPhone)return;
    if(!state.calibration)recenter();
    let pose=currentCamera();
    if(sample?.mode==="webxr"&&sample?.metric===true){
      if(!state.calibration?.visual_position)recenter();
      pose=math.webXrCameraPose(sample,state.calibration)||pose;
    }else if(sample?.mode==="optical-flow"){
      pose=math.integrateOpticalPose(pose,sample,{translationScale:0.1});
      if(state.imuSample)pose=math.applyImuOrientation(pose,state.imuSample,state.calibration);
    }
    setCamera(pose);
  }

  function applyImuSample(sample){
    state.imuSample=sample;if(!state.followPhone)return;
    if(state.visualSample?.mode==="webxr")return;
    if(!state.calibration)recenter();
    const pose=math.applyImuOrientation(currentCamera(),sample,state.calibration);pose.source=state.visualSample?.mode==="optical-flow"?"optical-flow":"imu";pose.metric=false;setCamera(pose,{appendPath:false});
  }

  function nudgeCamera(direction){
    const pose=currentCamera(),p=[...pose.position],step=0.25;
    if(direction==="left")p[0]-=step;if(direction==="right")p[0]+=step;if(direction==="up")p[1]+=step;if(direction==="down")p[1]-=step;if(direction==="in")p[2]-=step;if(direction==="out")p[2]+=step;
    setCamera({...pose,position:p,source:"manual",metric:false});
  }

  function selectedObject(){return (state.layout.objects||[]).find(object=>object.id===state.selectedId)||null;}
  function mutateObject(action){
    const object=selectedObject();if(!object)return;const p=[...object.position];
    if(action==="left")p[0]-=.25;if(action==="right")p[0]+=.25;if(action==="forward")p[2]-=.25;if(action==="back")p[2]+=.25;if(action==="up")p[1]+=.25;if(action==="down")p[1]-=.25;
    if(action.startsWith("rot"))object.rotation_y=Number(object.rotation_y||0)+(action==="rot-left"?-15:15);object.position=p;draw();renderObjectInspector();
  }
  function addObject(type){
    const index=(state.layout.objects||[]).length+1,id=`${type}-${Date.now().toString(36)}`;const base=type==="actor"?{position:[0,0.9,-1],size:[.55,1.8,.4]}:type==="wall"?{position:[0,1,-2],size:[3,2,.18]}:{position:[0,.4,-1],size:[.8,.8,.8]};
    state.layout.objects.push({id,type,label:`${type.toUpperCase()} ${index}`,position:base.position,size:base.size,rotation_y:0});state.selectedId=id;renderObjectInspector();draw();
  }
  function deleteObject(){const index=(state.layout.objects||[]).findIndex(object=>object.id===state.selectedId);if(index<0)return;state.layout.objects.splice(index,1);state.selectedId=state.layout.objects[0]?.id||null;renderObjectInspector();draw();}

  function renderObjectInspector(){
    const node=document.getElementById("vcam-v4-object-inspector");if(!node)return;const object=selectedObject(),list=state.layout.objects||[];
    node.innerHTML=`<div class="vcam-v4-object-list">${list.map(item=>`<button class="${item.id===state.selectedId?'active':''}" data-v4-select="${esc(item.id)}">${esc(item.label)}</button>`).join("")||'<span class="muted">오브젝트 없음</span>'}</div>${object?`<div class="vcam-v4-object-tools"><b>${esc(object.label)}</b><small>X ${object.position[0].toFixed(2)} · Y ${object.position[1].toFixed(2)} · Z ${object.position[2].toFixed(2)} · RY ${Number(object.rotation_y||0).toFixed(0)}°</small><div><button data-v4-object="left">← X</button><button data-v4-object="right">X →</button><button data-v4-object="forward">Z IN</button><button data-v4-object="back">Z OUT</button><button data-v4-object="up">Y +</button><button data-v4-object="down">Y −</button><button data-v4-object="rot-left">↶ 15°</button><button data-v4-object="rot-right">15° ↷</button><button class="danger" id="vcam-v4-delete">삭제</button></div></div>`:''}`;
    node.querySelectorAll("[data-v4-select]").forEach(button=>button.addEventListener("click",()=>{state.selectedId=button.dataset.v4Select;renderObjectInspector();draw();}));
    node.querySelectorAll("[data-v4-object]").forEach(button=>button.addEventListener("click",()=>mutateObject(button.dataset.v4Object)));
    node.querySelector("#vcam-v4-delete")?.addEventListener("click",deleteObject);
  }

  function takeSummary(take){
    if(!take)return"";const a=take.analysis||{},distance=a.metric?a.metric_distance_m!=null?`${Number(a.metric_distance_m).toFixed(2)} m`:"—":a.relative_travel_units!=null?`${Number(a.relative_travel_units).toFixed(2)} relative units`:"—";
    return `<div class="vcam-v4-take-result"><div><b>${esc(take.shot_id)} · 3D CAMERA TAKE ${String(take.take_number).padStart(2,"0")}</b><span>${take.metric?'METRIC':'RELATIVE'}</span></div><p>${esc(a.dominant_move||'locked-off')} · ${esc(distance)} · ${Number(take.frame_count||0)} frames</p><small>${esc(a.note||'')}</small></div>`;
  }

  function renderCard(){
    const shell=document.querySelector(".vcam-shell");if(!shell)return;let host=document.getElementById("vcam-blockout-v4-host");if(!host){host=document.createElement("section");host.id="vcam-blockout-v4-host";host.className="vcam-card vcam-v4-card";shell.appendChild(host);}
    state.renderer?.destroy();state.renderer=null;const t=target(),matches=t&&state.status.recording&&state.status.project===t.project&&state.status.scene===t.scene;
    const shotRows=shots(),options=shotRows.length?shotRows.map((shot,index)=>`<option value="${esc(shot.id||`C${String(index+1).padStart(2,"0")}`)}">${esc(shot.id||`C${String(index+1).padStart(2,"0")}`)}</option>`).join(""):'<option value="C01">C01</option>';
    const latest=state.latest||state.takes[0]||null;
    host.innerHTML=`<div class="vcam-card-head"><div><span class="vcam-kicker">LIVE 3D BLOCKOUT V4</span><h2>휴대폰으로 실제 3D 카메라를 움직입니다</h2></div><span class="vcam-status ${matches?'on':''}">${matches?'● CAMERA REC':'3D READY'}</span></div>
      <div class="vcam-v4-toolbar"><label>Shot<select id="vcam-v4-shot" ${matches?'disabled':''}>${options}</select></label><label>FOV <input id="vcam-v4-fov" type="range" min="18" max="120" value="${Number(state.layout.camera?.fov||50)}"><b id="vcam-v4-fov-value">${Number(state.layout.camera?.fov||50).toFixed(0)}°</b></label><label class="vcam-v4-follow"><input id="vcam-v4-follow" type="checkbox" ${state.followPhone?'checked':''}> PHONE DRIVE</label><button class="btn" id="vcam-v4-recenter">RECENTER</button><button class="btn" id="vcam-v4-save-layout">블록아웃 저장</button></div>
      <div class="vcam-v4-stage"><canvas id="vcam-v4-canvas"></canvas><span class="vcam-v4-label camera">CAMERA VIEW</span><span class="vcam-v4-label observer">BLOCKOUT / PATH</span><div class="vcam-v4-crosshair"></div></div>
      <div class="vcam-v4-readouts"><div><small>SOURCE</small><b id="vcam-v4-source">MANUAL</b></div><div><small>X / TRUCK</small><b id="vcam-v4-x">0.000</b></div><div><small>Y / PED</small><b id="vcam-v4-y">1.600</b></div><div><small>Z / DOLLY</small><b id="vcam-v4-z">5.000</b></div><div><small>FRAMES</small><b id="vcam-v4-frames">${Number(state.status.frame_count||0)}</b></div></div>
      <div class="vcam-v4-camera-tools"><span>Manual camera</span><button data-v4-camera="left">←</button><button data-v4-camera="right">→</button><button data-v4-camera="up">↑</button><button data-v4-camera="down">↓</button><button data-v4-camera="in">DOLLY IN</button><button data-v4-camera="out">DOLLY OUT</button></div>
      <div class="vcam-v4-layout-head"><b>BLOCKOUT OBJECTS</b><div><button class="btn" data-v4-add="actor">+ Actor</button><button class="btn" data-v4-add="prop">+ Prop</button><button class="btn" data-v4-add="wall">+ Wall</button></div></div><div id="vcam-v4-object-inspector"></div>
      <div class="vcam-v4-record"><button class="btn vcam-record" id="vcam-v4-rec" ${matches?'disabled':''}>● REC 3D CAMERA</button><button class="btn" id="vcam-v4-stop" ${!matches?'disabled':''}>STOP & SAVE PATH</button><button class="btn" id="vcam-v4-folder">폴더</button><span id="vcam-v4-note">WebXR은 1m=1 world unit. Visual Flow는 상대 이동만 사용합니다.</span></div>${takeSummary(latest)}`;
    try{state.renderer=new Renderer(document.getElementById("vcam-v4-canvas"));}catch(error){showError(error)}
    bind();renderObjectInspector();updateReadouts();draw();
  }

  function showError(error){const host=document.getElementById("vcam-blockout-v4-host");if(!host)return;let node=host.querySelector(".vcam-v4-error");if(!node){node=document.createElement("div");node.className="vcam-v4-error";host.prepend(node)}node.textContent=error?.message||String(error);}

  async function saveLayout(){const t=target();if(!t)return;const pose=currentCamera();state.layout.camera={position:[...pose.position],orientation:[...pose.orientation],fov:Number(state.layout.camera?.fov||50)};state.layout=await bridge.save(t.project,t.scene,state.layout);const note=document.getElementById("vcam-v4-note");if(note)note.textContent="3D 블록아웃 배치를 preview 영역에 저장했습니다.";}
  async function loadTarget(){
    const t=target();if(!t)return;const key=targetKey();if(state.loadedKey===key)return;state.loadedKey=key;state.calibration=null;state.path=[];state.latest=null;
    try{state.layout=await bridge.load(t.project,t.scene)}catch{state.layout=math.defaultBlockout()}
    state.selectedId=state.layout.objects?.[0]?.id||null;state.cameraPose={position:[...(state.layout.camera?.position||[0,1.6,5])],orientation:[...(state.layout.camera?.orientation||[0,0,0,1])],metric:false,source:"manual"};
    try{state.status=await bridge.status()}catch{state.status={recording:false}}
    try{state.takes=await bridge.listTakes(t.project,t.scene)}catch{state.takes=[]}
  }

  function bind(){const t=target();
    document.getElementById("vcam-v4-fov")?.addEventListener("input",event=>{state.layout.camera.fov=Number(event.target.value);const value=document.getElementById("vcam-v4-fov-value");if(value)value.textContent=`${event.target.value}°`;draw();pushFrame();});
    document.getElementById("vcam-v4-follow")?.addEventListener("change",event=>{state.followPhone=event.target.checked;if(state.followPhone)recenter();});
    document.getElementById("vcam-v4-recenter")?.addEventListener("click",recenter);
    document.getElementById("vcam-v4-save-layout")?.addEventListener("click",()=>saveLayout().catch(showError));
    document.querySelectorAll("[data-v4-camera]").forEach(button=>button.addEventListener("click",()=>nudgeCamera(button.dataset.v4Camera)));
    document.querySelectorAll("[data-v4-add]").forEach(button=>button.addEventListener("click",()=>addObject(button.dataset.v4Add)));
    document.getElementById("vcam-v4-rec")?.addEventListener("click",async()=>{if(!t)return;try{state.status=await bridge.startTake(t.project,t.scene,{shotId:document.getElementById("vcam-v4-shot")?.value||"C01"});state.path=[];state.lastSentAt=0;pushFrame();renderCard()}catch(error){showError(error)}});
    document.getElementById("vcam-v4-stop")?.addEventListener("click",async()=>{try{pushFrame();state.latest=await bridge.stopTake();state.status=await bridge.status();state.takes=await bridge.listTakes(t.project,t.scene);renderCard()}catch(error){showError(error)}});
    document.getElementById("vcam-v4-folder")?.addEventListener("click",()=>t&&bridge.openFolder(t.project,t.scene).catch(showError));
    window.addEventListener("resize",draw,{once:true});
  }

  visual?.onSample(applyVisualSample);imu?.onSample(applyImuSample);
  bridge.onStatus(status=>{state.status=status||{recording:false};updateReadouts();});
  bridge.onTake(take=>{state.latest=take;});
  bridge.onLayout(layout=>{state.layout=math.sanitizeBlockoutState(layout);draw();});

  const observer=new MutationObserver(()=>{
    if(!visible())return;const key=targetKey();if(key!==state.loadedKey||!document.getElementById("vcam-blockout-v4-host")){loadTarget().then(renderCard).catch(showError);}
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  if(visible())loadTarget().then(renderCard).catch(showError);
})();
