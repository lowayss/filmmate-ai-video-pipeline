(function(root,factory){
  const api=factory();
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  else root.FilmMateBlockoutMath=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  const finite=(value,fallback=0)=>{const n=Number(value);return Number.isFinite(n)?n:fallback;};
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,finite(value,min)));
  const radians=degrees=>finite(degrees)*Math.PI/180;
  const round=(value,digits=5)=>Number(finite(value).toFixed(digits));
  const vec3=(value,fallback=[0,0,0])=>Array.isArray(value)&&value.length>=3?[finite(value[0]),finite(value[1]),finite(value[2])]:fallback.slice();
  const quat=(value,fallback=[0,0,0,1])=>Array.isArray(value)&&value.length>=4?[finite(value[0]),finite(value[1]),finite(value[2]),finite(value[3])]:fallback.slice();
  const length3=v=>Math.hypot(finite(v?.[0]),finite(v?.[1]),finite(v?.[2]));
  const normalize3=v=>{const n=length3(v)||1;return [finite(v?.[0])/n,finite(v?.[1])/n,finite(v?.[2])/n];};
  const add3=(a,b)=>[finite(a?.[0])+finite(b?.[0]),finite(a?.[1])+finite(b?.[1]),finite(a?.[2])+finite(b?.[2])];
  const sub3=(a,b)=>[finite(a?.[0])-finite(b?.[0]),finite(a?.[1])-finite(b?.[1]),finite(a?.[2])-finite(b?.[2])];
  const scale3=(v,s)=>[finite(v?.[0])*finite(s),finite(v?.[1])*finite(s),finite(v?.[2])*finite(s)];
  const distance3=(a,b)=>length3(sub3(a,b));

  function quatNormalize(value){
    const q=quat(value);const n=Math.hypot(...q)||1;
    return q.map(v=>v/n);
  }
  const quatInverse=value=>{const q=quatNormalize(value);return [-q[0],-q[1],-q[2],q[3]];};
  function quatMultiply(a,b){
    const A=quat(a),B=quat(b);const [ax,ay,az,aw]=A,[bx,by,bz,bw]=B;
    return quatNormalize([
      aw*bx+ax*bw+ay*bz-az*by,
      aw*by-ax*bz+ay*bw+az*bx,
      aw*bz+ax*by-ay*bx+az*bw,
      aw*bw-ax*bx-ay*by-az*bz,
    ]);
  }
  function quatAxis(axis,angle){
    const n=normalize3(axis),s=Math.sin(angle/2),c=Math.cos(angle/2);
    return [n[0]*s,n[1]*s,n[2]*s,c];
  }
  function quatRotateVector(q,value){
    const n=quatNormalize(q),v=vec3(value),p=[v[0],v[1],v[2],0];
    const mulRaw=(a,b)=>[
      a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
      a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
      a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
      a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
    ];
    const r=mulRaw(mulRaw(n,p),quatInverse(n));return [r[0],r[1],r[2]];
  }
  function deviceOrientationQuaternion(sample){
    const o=sample?.orientation||sample||{};
    const yaw=radians(o.alpha),pitch=radians(o.beta),roll=radians(-finite(o.gamma));
    return quatMultiply(quatMultiply(quatAxis([0,1,0],yaw),quatAxis([1,0,0],pitch)),quatAxis([0,0,1],roll));
  }
  function sampleQuaternion(sample){
    const o=sample?.orientation||{};
    if(sample?.mode==="webxr"&&[o.x,o.y,o.z,o.w].every(v=>Number.isFinite(Number(v)))) return quatNormalize([o.x,o.y,o.z,o.w]);
    return deviceOrientationQuaternion(sample);
  }

  function createCalibration({cameraPosition=[0,1.6,5],cameraOrientation=[0,0,0,1],visualSample=null,imuSample=null}={}){
    return {
      origin_position:vec3(cameraPosition,[0,1.6,5]),
      origin_orientation:quatNormalize(cameraOrientation),
      visual_position:visualSample?.mode==="webxr"?vec3([visualSample.position?.x,visualSample.position?.y,visualSample.position?.z]):null,
      visual_orientation:visualSample?.mode==="webxr"?sampleQuaternion(visualSample):null,
      imu_orientation:imuSample?sampleQuaternion(imuSample):null,
    };
  }

  function webXrCameraPose(sample,calibration){
    if(sample?.mode!=="webxr"||sample?.metric!==true||!calibration) return null;
    const basePos=calibration.visual_position||vec3([sample.position?.x,sample.position?.y,sample.position?.z]);
    const nowPos=vec3([sample.position?.x,sample.position?.y,sample.position?.z]);
    const delta=sub3(nowPos,basePos);
    const baseQ=calibration.visual_orientation||sampleQuaternion(sample);
    const relQ=quatMultiply(quatInverse(baseQ),sampleQuaternion(sample));
    const outQ=quatMultiply(calibration.origin_orientation||[0,0,0,1],relQ);
    return {position:add3(calibration.origin_position||[0,1.6,5],delta),orientation:outQ,metric:true,source:"webxr"};
  }

  function integrateOpticalPose(currentPose,sample,{translationScale=0.12}={}){
    const current=currentPose||{position:[0,1.6,5],orientation:[0,0,0,1],metric:false,source:"optical-flow"};
    if(sample?.mode!=="optical-flow") return {...current};
    const d=sample.delta||{};
    const x=clamp(d.x,-2,2)*translationScale;
    const y=clamp(d.y,-2,2)*translationScale;
    const z=clamp(d.z,-2,2)*translationScale;
    const next=add3(current.position||[0,1.6,5],[x,y,-z]);
    return {position:next.map((v,i)=>clamp(v,i===1?-5:-20,i===1?15:20)),orientation:quatNormalize(current.orientation||[0,0,0,1]),metric:false,source:"optical-flow"};
  }

  function applyImuOrientation(currentPose,imuSample,calibration){
    const current=currentPose||{position:[0,1.6,5],orientation:[0,0,0,1],metric:false,source:"imu"};
    if(!imuSample?.orientation) return {...current};
    const base=calibration?.imu_orientation||sampleQuaternion(imuSample);
    const rel=quatMultiply(quatInverse(base),sampleQuaternion(imuSample));
    return {...current,orientation:quatMultiply(calibration?.origin_orientation||[0,0,0,1],rel)};
  }

  function sanitizeCameraFrame(frame={}){
    const position=vec3(frame.position,[0,1.6,5]).map((v,i)=>clamp(v,i===1?-20:-100,i===1?100:100));
    return {
      client_time_ms:clamp(frame.client_time_ms,0,9e15),
      position:position.map(v=>round(v,6)),
      orientation:quatNormalize(frame.orientation||[0,0,0,1]).map(v=>round(v,7)),
      fov:round(clamp(frame.fov,12,140),3),
      source:["webxr","optical-flow","imu","manual"].includes(frame.source)?frame.source:"manual",
      metric:frame.metric===true,
    };
  }

  function downsampleFrames(frames,maxFrames=60){
    const source=Array.isArray(frames)?frames:[];const cap=Math.max(2,Math.trunc(finite(maxFrames,60)));
    if(source.length<=cap) return source.map(sanitizeCameraFrame);
    const result=[];for(let i=0;i<cap;i++){const index=Math.round(i*(source.length-1)/(cap-1));result.push(sanitizeCameraFrame(source[index]));}return result;
  }

  function summarizeCameraPath(frames=[]){
    const clean=(Array.isArray(frames)?frames:[]).map(sanitizeCameraFrame);
    if(clean.length<2) return {status:"insufficient",frame_count:clean.length,metric:false,metric_distance_m:null,relative_travel_units:0,net_displacement:[0,0,0],dominant_move:"locked-off",keyframes:clean};
    let travel=0;for(let i=1;i<clean.length;i++)travel+=distance3(clean[i-1].position,clean[i].position);
    const allMetric=clean.every(frame=>frame.metric===true&&frame.source==="webxr");
    const net=sub3(clean[clean.length-1].position,clean[0].position).map(v=>round(v,5));
    const abs=net.map(Math.abs);let dominant="locked-off";const index=abs.indexOf(Math.max(...abs));
    if(Math.max(...abs)>=0.02){if(index===0)dominant=`truck ${net[0]>=0?"right":"left"}`;else if(index===1)dominant=`pedestal ${net[1]>=0?"up":"down"}`;else dominant=`dolly ${net[2]<=0?"in":"out"}`;}
    return {
      status:"ok",frame_count:clean.length,metric:allMetric,
      metric_distance_m:allMetric?round(travel,4):null,
      relative_travel_units:allMetric?null:round(travel,4),
      net_displacement:net,dominant_move:dominant,
      keyframes:downsampleFrames(clean,48),
      note:allMetric?"WebXR path distance is expressed in local-space meters.":"Path length is relative preview space only; do not interpret it as meters.",
    };
  }

  function defaultBlockout(){
    return {
      schema_version:1,preview:true,canonical:false,source:"virtual-camera-blockout-v4",
      camera:{position:[0,1.6,5],orientation:[0,0,0,1],fov:50},
      objects:[
        {id:"actor-a",type:"actor",label:"ACTOR A",position:[0,0.9,0],size:[0.55,1.8,0.4],rotation_y:0},
        {id:"actor-b",type:"actor",label:"ACTOR B",position:[1.5,0.9,-0.7],size:[0.55,1.8,0.4],rotation_y:-20},
        {id:"prop-a",type:"prop",label:"PROP",position:[-1.2,0.4,-0.2],size:[0.8,0.8,0.8],rotation_y:0},
      ],
    };
  }
  function sanitizeBlockoutState(input={}){
    const fallback=defaultBlockout();const objects=Array.isArray(input.objects)?input.objects.slice(0,50):fallback.objects;
    return {
      schema_version:1,preview:true,canonical:false,source:"virtual-camera-blockout-v4",
      camera:{
        position:vec3(input.camera?.position,fallback.camera.position).map((v,i)=>clamp(v,i===1?-10:-30,i===1?20:30)),
        orientation:quatNormalize(input.camera?.orientation||fallback.camera.orientation),
        fov:clamp(input.camera?.fov||fallback.camera.fov,12,140),
      },
      objects:objects.map((object,index)=>({
        id:String(object?.id||`object-${index+1}`).replace(/[^0-9A-Za-z_-]/g,"_").slice(0,48),
        type:["actor","prop","wall"].includes(object?.type)?object.type:"prop",
        label:String(object?.label||object?.type||`OBJECT ${index+1}`).slice(0,48),
        position:vec3(object?.position).map((v,i)=>clamp(v,i===1?-2:-20,i===1?10:20)),
        size:vec3(object?.size,[1,1,1]).map(v=>clamp(Math.abs(v)||0.1,0.1,12)),
        rotation_y:clamp(object?.rotation_y,-360,360),
      })),
    };
  }

  return {finite,clamp,radians,round,vec3,add3,sub3,scale3,distance3,quatNormalize,quatInverse,quatMultiply,quatAxis,quatRotateVector,deviceOrientationQuaternion,sampleQuaternion,createCalibration,webXrCameraPose,integrateOpticalPose,applyImuOrientation,sanitizeCameraFrame,downsampleFrames,summarizeCameraPath,defaultBlockout,sanitizeBlockoutState};
});
