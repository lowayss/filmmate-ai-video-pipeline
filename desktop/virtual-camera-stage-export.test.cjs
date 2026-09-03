const test = require("node:test");
const assert = require("node:assert/strict");
const stage = require("./virtual-camera-stage-engine.js");
const exp = require("./virtual-camera-stage-export.cjs");

test("FilmMate position maps to Blender axes", () => {
  assert.deepEqual(exp.positionToBlender({x:1,y:2,z:3}),{x:1,y:-3,z:2});
  assert.deepEqual(exp.sizeToBlender({x:2,y:4,z:6}),{x:2,y:6,z:4});
});

test("identity FilmMate camera gets +90deg X basis rotation in Blender", () => {
  const q=exp.quaternionToBlender({x:0,y:0,z:0,w:1});
  assert.ok(Math.abs(q.x-Math.SQRT1_2)<1e-12);
  assert.ok(Math.abs(q.w-Math.SQRT1_2)<1e-12);
  assert.ok(Math.abs(q.y)<1e-12);
  assert.ok(Math.abs(q.z)<1e-12);
});

test("lens conversion produces common full-frame 50deg value", () => {
  const lens=exp.lensFromFov(50);
  assert.ok(lens>38 && lens<39);
});

test("Blender script contains blockout, quaternion keys, timing and provenance", () => {
  const blockout=stage.defaultScene();
  const path={shot_id:"C01",path_number:2,metric:true,units:"meter",samples:[
    {client_time_ms:1000,metric:true,camera:{position:{x:0,y:1.6,z:6},quaternion:{x:0,y:0,z:0,w:1},fov_deg:50}},
    {client_time_ms:2000,metric:true,camera:{position:{x:1,y:1.6,z:5},quaternion:{x:0,y:0,z:0,w:1},fov_deg:50}},
  ]};
  const script=exp.blenderScript(blockout,path,{fps:30});
  assert.match(script,/FilmMate_VCAM_Camera/);
  assert.match(script,/rotation_mode = 'QUATERNION'/);
  assert.match(script,/cam_obj\['filmmate_metric'\] = True/);
  assert.match(script,/frame_end = 31/);
  assert.match(script,/cam_obj\.location = \(1, -5, 1\.6\)/);
  assert.match(script,/point\.interpolation = 'LINEAR'/);
});

test("interchange payload remains preview and non-canonical", () => {
  const payload=exp.interchangePayload(stage.defaultScene(),{samples:[{},{}]},{fps:24});
  assert.equal(payload.preview,true);
  assert.equal(payload.canonical,false);
  assert.equal(payload.target,"blender");
  assert.equal(payload.fps,24);
});
