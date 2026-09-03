const test = require("node:test");
const assert = require("node:assert/strict");
const stage = require("./virtual-camera-stage-engine.js");

test("default camera projects stage origin near center", () => {
  const rig = stage.createRig();
  const p = stage.projectPoint({x:0,y:1.6,z:0}, rig.camera, 1280, 720);
  assert.ok(p);
  assert.ok(Math.abs(p.x - 640) < 0.001);
  assert.ok(Math.abs(p.y - 360) < 0.001);
});

test("WebXR sample maps metric displacement 1:1 from capture origin", () => {
  const rig = stage.createRig();
  stage.applyVisualSample(rig,{mode:"webxr",metric:true,position:{x:2,y:1,z:3},orientation:{x:0,y:0,z:0,w:1}});
  stage.applyVisualSample(rig,{mode:"webxr",metric:true,position:{x:3,y:1.5,z:2.5},orientation:{x:0,y:0,z:0,w:1}});
  assert.equal(rig.metric,true);
  assert.equal(rig.source,"webxr");
  assert.equal(Number(rig.camera.position.x.toFixed(3)),1);
  assert.equal(Number(rig.camera.position.y.toFixed(3)),2.1);
  assert.equal(Number(rig.camera.position.z.toFixed(3)),5.5);
});

test("optical flow moves stage camera but remains non-metric", () => {
  const rig = stage.createRig();
  stage.applyVisualSample(rig,{mode:"optical-flow",delta:{x:1,y:-0.5,z:0.5}});
  assert.equal(rig.metric,false);
  assert.equal(rig.source,"optical-flow");
  assert.equal(Number(rig.camera.position.x.toFixed(3)),0.12);
  assert.equal(Number(rig.camera.position.y.toFixed(3)),1.54);
  assert.equal(Number(rig.camera.position.z.toFixed(3)),5.94);
});

test("positive IMU pan turns camera toward stage-right", () => {
  const rig = stage.createRig();
  stage.applyImuSample(rig,{orientation:{alpha:10,beta:0,gamma:0}});
  stage.applyImuSample(rig,{orientation:{alpha:40,beta:0,gamma:0}});
  const forward = stage.cameraForward(rig.camera);
  assert.ok(forward.x > 0.45);
  assert.ok(forward.z < -0.7);
});

test("scene normalization preserves preview provenance and clamps geometry", () => {
  const scene = stage.normalizeScene({objects:[{id:"../../bad",type:"actor",position:{x:999,y:-999,z:0},size:{x:-4,y:0,z:999}}]});
  assert.equal(scene.preview,true);
  assert.equal(scene.canonical,false);
  assert.equal(scene.objects.length,1);
  assert.ok(!scene.objects[0].id.includes("/"));
  assert.equal(scene.objects[0].position.x,50);
  assert.equal(scene.objects[0].position.y,-10);
  assert.equal(scene.objects[0].size.x,4);
  assert.equal(scene.objects[0].size.y,0.05);
  assert.equal(scene.objects[0].size.z,50);
});

test("path interpolation blends positions and keeps quaternion normalized", () => {
  const a={source:"webxr",metric:true,camera:{position:{x:0,y:0,z:0},quaternion:{x:0,y:0,z:0,w:1},fov_deg:50}};
  const b={source:"webxr",metric:true,camera:{position:{x:2,y:4,z:6},quaternion:{x:0,y:1,z:0,w:0},fov_deg:70}};
  const mid=stage.interpolatePath([a,b],0.5);
  assert.deepEqual(mid.camera.position,{x:1,y:2,z:3});
  assert.equal(mid.camera.fov_deg,60);
  const q=mid.camera.quaternion;
  assert.ok(Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1)<1e-9);
});
