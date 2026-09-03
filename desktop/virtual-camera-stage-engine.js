(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FilmMateStage = api;
})(typeof window !== "undefined" ? window : null, function() {
  "use strict";

  const DEG = Math.PI / 180;
  function finite(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, finite(value))); }
  function vec3(value = {}, fallback = {}) { return {x:finite(value.x,finite(fallback.x)),y:finite(value.y,finite(fallback.y)),z:finite(value.z,finite(fallback.z))}; }
  function quat(value = {}) { return quatNormalize({x:finite(value.x),y:finite(value.y),z:finite(value.z),w:finite(value.w,1)}); }
  function quatNormalize(q) { const len=Math.hypot(finite(q.x),finite(q.y),finite(q.z),finite(q.w,1))||1; return {x:q.x/len,y:q.y/len,z:q.z/len,w:q.w/len}; }
  function quatConjugate(q) { return {x:-finite(q.x),y:-finite(q.y),z:-finite(q.z),w:finite(q.w,1)}; }
  function quatMultiply(a,b) {
    const ax=finite(a.x),ay=finite(a.y),az=finite(a.z),aw=finite(a.w,1),bx=finite(b.x),by=finite(b.y),bz=finite(b.z),bw=finite(b.w,1);
    return quatNormalize({x:aw*bx+ax*bw+ay*bz-az*by,y:aw*by-ax*bz+ay*bw+az*bx,z:aw*bz+ax*by-ay*bx+az*bw,w:aw*bw-ax*bx-ay*by-az*bz});
  }
  function quatFromAxisAngle(axis,radians) { const half=finite(radians)/2,s=Math.sin(half),len=Math.hypot(finite(axis.x),finite(axis.y),finite(axis.z))||1; return quatNormalize({x:axis.x/len*s,y:axis.y/len*s,z:axis.z/len*s,w:Math.cos(half)}); }
  function quatFromCameraEuler(yaw,pitch,roll) { return quatMultiply(quatFromAxisAngle({x:0,y:1,z:0},yaw),quatMultiply(quatFromAxisAngle({x:1,y:0,z:0},pitch),quatFromAxisAngle({x:0,y:0,z:1},roll))); }
  function quatRotate(q,v) {
    const qn=quatNormalize(q),p={x:finite(v.x),y:finite(v.y),z:finite(v.z),w:0},qi=quatConjugate(qn);
    const a={x:qn.w*p.x+qn.x*p.w+qn.y*p.z-qn.z*p.y,y:qn.w*p.y-qn.x*p.z+qn.y*p.w+qn.z*p.x,z:qn.w*p.z+qn.x*p.y-qn.y*p.x+qn.z*p.w,w:qn.w*p.w-qn.x*p.x-qn.y*p.y-qn.z*p.z};
    return {x:a.w*qi.x+a.x*qi.w+a.y*qi.z-a.z*qi.y,y:a.w*qi.y-a.x*qi.z+a.y*qi.w+a.z*qi.x,z:a.w*qi.z+a.x*qi.y-a.y*qi.x+a.z*qi.w};
  }
  function cameraForward(camera) { return quatRotate(camera.quaternion||{x:0,y:0,z:0,w:1},{x:0,y:0,z:-1}); }
  function defaultCamera() { return {position:{x:0,y:1.6,z:6},quaternion:{x:0,y:0,z:0,w:1},fov_deg:50,near:0.05,far:100}; }
  function createRig() { const camera=defaultCamera(); return {camera:JSON.parse(JSON.stringify(camera)),baseCamera:JSON.parse(JSON.stringify(camera)),source:"idle",metric:false,xrOrigin:null,imuOrigin:null,lastVisual:null,lastImu:null}; }
  function resetRig(rig) { const fresh=createRig(); Object.keys(rig).forEach(key=>delete rig[key]); Object.assign(rig,fresh); return rig; }
  function safeId(value,fallback="block") { const id=String(value||"").trim().replace(/[^0-9A-Za-z가-힣._-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,64); return id||fallback; }
  function normalizeObject(input={},index=0) {
    const type=["actor","box","wall","table","prop"].includes(input.type)?input.type:"box",position=vec3(input.position),size=vec3(input.size,type==="actor"?{x:.6,y:1.8,z:.5}:{x:1,y:1,z:1});
    return {id:safeId(input.id,`${type}_${index+1}`),type,label:String(input.label||input.id||`${type} ${index+1}`).slice(0,80),position:{x:clamp(position.x,-50,50),y:clamp(position.y,-10,50),z:clamp(position.z,-50,50)},size:{x:clamp(Math.abs(size.x),.05,50),y:clamp(Math.abs(size.y),.05,50),z:clamp(Math.abs(size.z),.05,50)}};
  }
  function defaultScene() {
    return {schema_version:1,preview:true,canonical:false,coordinate_system:"+X right, +Y up, camera forward -Z",units:"meter",grid:{size:12,step:1},objects:[
      normalizeObject({id:"actor_A",type:"actor",label:"Actor A",position:{x:-1,y:.9,z:0},size:{x:.6,y:1.8,z:.5}},0),
      normalizeObject({id:"actor_B",type:"actor",label:"Actor B",position:{x:1,y:.9,z:-.6},size:{x:.6,y:1.8,z:.5}},1),
      normalizeObject({id:"table_1",type:"table",label:"Table",position:{x:0,y:.45,z:-1.8},size:{x:2.2,y:.9,z:.8}},2),
      normalizeObject({id:"back_wall",type:"wall",label:"Back Wall",position:{x:0,y:1.5,z:-4},size:{x:8,y:3,z:.18}},3)
    ],saved_at:null};
  }
  function normalizeScene(input={}) { const source=input&&typeof input==="object"?input:{}; return {schema_version:1,preview:true,canonical:false,coordinate_system:"+X right, +Y up, camera forward -Z",units:"meter",grid:{size:clamp(source.grid?.size,4,50)||12,step:clamp(source.grid?.step,.25,5)||1},objects:Array.isArray(source.objects)?source.objects.slice(0,64).map(normalizeObject):defaultScene().objects,saved_at:source.saved_at||null}; }
  function addObject(scene,type="box") { const normalized=normalizeScene(scene),count=normalized.objects.filter(o=>o.type===type).length+1,defaults=type==="actor"?{size:{x:.6,y:1.8,z:.5},position:{x:(count%3)-1,y:.9,z:-1}}:{size:{x:1,y:1,z:1},position:{x:(count%3)-1,y:.5,z:-2}}; normalized.objects.push(normalizeObject({id:`${type}_${count}`,type,label:`${type} ${count}`,...defaults},normalized.objects.length)); return normalized; }
  function circularDegreesDelta(origin,current) { let delta=finite(current)-finite(origin); return ((delta+180)%360+360)%360-180; }
  function applyImuSample(rig,sample={}) {
    if(!rig?.camera)return rig; const o=sample.orientation||{};
    if(!rig.imuOrigin)rig.imuOrigin={alpha:finite(o.alpha),beta:finite(o.beta),gamma:finite(o.gamma),baseQuaternion:{...rig.camera.quaternion}};
    rig.lastImu=sample; if(rig.source==="webxr")return rig;
    const yaw=-circularDegreesDelta(rig.imuOrigin.alpha,o.alpha)*DEG,pitch=-circularDegreesDelta(rig.imuOrigin.beta,o.beta)*DEG,roll=-circularDegreesDelta(rig.imuOrigin.gamma,o.gamma)*DEG;
    rig.camera.quaternion=quatMultiply(rig.imuOrigin.baseQuaternion,quatFromCameraEuler(yaw,pitch,roll)); if(rig.source==="idle")rig.source="imu"; return rig;
  }
  function applyVisualSample(rig,sample={},options={}) {
    if(!rig?.camera)return rig; const flowScale=finite(options.flowScale,.12);
    if(sample.mode==="webxr"&&sample.position){
      if(!rig.xrOrigin)rig.xrOrigin={position:vec3(sample.position),quaternion:quat(sample.orientation||{x:0,y:0,z:0,w:1}),basePosition:{...rig.camera.position},baseQuaternion:{...rig.camera.quaternion}};
      const p=vec3(sample.position),o=rig.xrOrigin.position; rig.camera.position={x:rig.xrOrigin.basePosition.x+(p.x-o.x),y:rig.xrOrigin.basePosition.y+(p.y-o.y),z:rig.xrOrigin.basePosition.z+(p.z-o.z)};
      if(sample.orientation){const relative=quatMultiply(quatConjugate(rig.xrOrigin.quaternion),quat(sample.orientation));rig.camera.quaternion=quatMultiply(rig.xrOrigin.baseQuaternion,relative);} rig.source="webxr";rig.metric=true;
    }else if(sample.mode==="optical-flow"&&sample.delta){const d=vec3(sample.delta);rig.camera.position.x+=d.x*flowScale;rig.camera.position.y+=d.y*flowScale;rig.camera.position.z-=d.z*flowScale;rig.source="optical-flow";rig.metric=false;}
    rig.lastVisual=sample; return rig;
  }
  function worldToCamera(point,camera) { const relative={x:finite(point.x)-finite(camera.position?.x),y:finite(point.y)-finite(camera.position?.y),z:finite(point.z)-finite(camera.position?.z)}; return quatRotate(quatConjugate(quat(camera.quaternion)),relative); }
  function projectPoint(point,camera,width,height) { const local=worldToCamera(point,camera),near=Math.max(.001,finite(camera.near,.05)),depth=-local.z;if(depth<=near)return null;const fov=clamp(camera.fov_deg,15,140)*DEG,focal=(Math.max(1,height)*.5)/Math.tan(fov*.5);return{x:finite(width)*.5+local.x*focal/depth,y:finite(height)*.5-local.y*focal/depth,depth,local}; }
  const BOX_EDGES=[[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]],BOX_FACES=[[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
  function boxVertices(object){const p=object.position,s=object.size,hx=s.x/2,hy=s.y/2,hz=s.z/2;return[{x:p.x-hx,y:p.y-hy,z:p.z-hz},{x:p.x+hx,y:p.y-hy,z:p.z-hz},{x:p.x-hx,y:p.y+hy,z:p.z-hz},{x:p.x+hx,y:p.y+hy,z:p.z-hz},{x:p.x-hx,y:p.y-hy,z:p.z+hz},{x:p.x+hx,y:p.y-hy,z:p.z+hz},{x:p.x-hx,y:p.y+hy,z:p.z+hz},{x:p.x+hx,y:p.y+hy,z:p.z+hz}];}
  function projectBox(object,camera,width,height){const vertices=boxVertices(object),projected=vertices.map(v=>projectPoint(v,camera,width,height)),faces=[];for(const indices of BOX_FACES){const points=indices.map(i=>projected[i]);if(points.some(p=>!p))continue;faces.push({indices,points,depth:points.reduce((sum,p)=>sum+p.depth,0)/points.length});}faces.sort((a,b)=>b.depth-a.depth);return{vertices,projected,faces,edges:BOX_EDGES};}
  function rigSnapshot(rig,source,clientTimeMs=Date.now()){return{client_time_ms:finite(clientTimeMs,Date.now()),source:String(source||rig.source||"stage").slice(0,32),metric:Boolean(rig.metric),camera:{position:{...rig.camera.position},quaternion:{...rig.camera.quaternion},fov_deg:finite(rig.camera.fov_deg,50)}};}
  function interpolatePath(path=[],t=0){if(!Array.isArray(path)||!path.length)return null;if(path.length===1)return path[0];const c=clamp(t,0,1),index=c*(path.length-1),ai=Math.floor(index),bi=Math.min(path.length-1,ai+1),mix=index-ai,a=path[ai],b=path[bi],lerp=(x,y)=>finite(x)+(finite(y)-finite(x))*mix,aq=quat(a.camera?.quaternion),bq=quat(b.camera?.quaternion),q=quatNormalize({x:lerp(aq.x,bq.x),y:lerp(aq.y,bq.y),z:lerp(aq.z,bq.z),w:lerp(aq.w,bq.w)});return{source:b.source||a.source,metric:Boolean(a.metric&&b.metric),camera:{position:{x:lerp(a.camera?.position?.x,b.camera?.position?.x),y:lerp(a.camera?.position?.y,b.camera?.position?.y),z:lerp(a.camera?.position?.z,b.camera?.position?.z)},quaternion:q,fov_deg:lerp(a.camera?.fov_deg,b.camera?.fov_deg)}};}
  return {DEG,finite,clamp,vec3,quat,quatNormalize,quatConjugate,quatMultiply,quatFromCameraEuler,quatRotate,cameraForward,defaultCamera,createRig,resetRig,defaultScene,normalizeScene,normalizeObject,addObject,circularDegreesDelta,applyImuSample,applyVisualSample,worldToCamera,projectPoint,boxVertices,projectBox,BOX_EDGES,BOX_FACES,rigSnapshot,interpolatePath};
});
