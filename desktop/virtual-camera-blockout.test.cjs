const test = require("node:test");
const assert = require("node:assert/strict");
const math = require("./virtual-camera-blockout-math.js");

function near(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} not within ${epsilon} of ${expected}`);
}

test("WebXR recenter maps the baseline pose to the blockout camera origin", () => {
  const baseline = {mode:"webxr",metric:true,position:{x:2,y:1,z:-3},orientation:{x:0,y:0,z:0,w:1}};
  const calibration = math.createCalibration({cameraPosition:[0,1.6,5],visualSample:baseline});
  const pose = math.webXrCameraPose(baseline, calibration);
  assert.equal(pose.metric, true);
  assert.equal(pose.source, "webxr");
  assert.deepEqual(pose.position.map(v=>Number(v.toFixed(6))), [0,1.6,5]);
});

test("WebXR translation remains metric and moves the virtual camera one-to-one", () => {
  const baseline = {mode:"webxr",metric:true,position:{x:0,y:0,z:0},orientation:{x:0,y:0,z:0,w:1}};
  const calibration = math.createCalibration({cameraPosition:[1,2,6],visualSample:baseline});
  const pose = math.webXrCameraPose({mode:"webxr",metric:true,position:{x:0.5,y:0.2,z:-1.25},orientation:{x:0,y:0,z:0,w:1}}, calibration);
  assert.deepEqual(pose.position.map(v=>Number(v.toFixed(4))), [1.5,2.2,4.75]);
  assert.equal(pose.metric, true);
});

test("optical flow drives relative blockout motion without becoming metric", () => {
  const start = {position:[0,1.6,5],orientation:[0,0,0,1],metric:false,source:"optical-flow"};
  const pose = math.integrateOpticalPose(start,{mode:"optical-flow",delta:{x:1,y:0.5,z:1}},{translationScale:0.2});
  assert.deepEqual(pose.position.map(v=>Number(v.toFixed(4))), [0.2,1.7,4.8]);
  assert.equal(pose.metric, false);
  assert.equal(pose.source, "optical-flow");
});

test("IMU orientation is relative to the recenter baseline", () => {
  const imu = {orientation:{alpha:40,beta:5,gamma:-2}};
  const calibration = math.createCalibration({imuSample:imu});
  const pose = math.applyImuOrientation({position:[0,1.6,5],orientation:[0,0,0,1],metric:false,source:"imu"},imu,calibration);
  near(pose.orientation[0],0,1e-6);
  near(pose.orientation[1],0,1e-6);
  near(pose.orientation[2],0,1e-6);
  near(Math.abs(pose.orientation[3]),1,1e-6);
});

test("metric camera path reports meters only when every frame is WebXR metric", () => {
  const frames = [
    {client_time_ms:1,position:[0,1.6,5],orientation:[0,0,0,1],fov:50,source:"webxr",metric:true},
    {client_time_ms:2,position:[0,1.6,4],orientation:[0,0,0,1],fov:50,source:"webxr",metric:true},
    {client_time_ms:3,position:[1,1.6,4],orientation:[0,0,0,1],fov:50,source:"webxr",metric:true},
  ];
  const summary = math.summarizeCameraPath(frames);
  assert.equal(summary.metric,true);
  assert.equal(summary.metric_distance_m,2);
  assert.equal(summary.relative_travel_units,null);
  assert.equal(summary.dominant_move,"truck right");
});

test("mixed or visual-flow camera path never masquerades as meters", () => {
  const frames = [
    {client_time_ms:1,position:[0,1.6,5],orientation:[0,0,0,1],fov:50,source:"optical-flow",metric:false},
    {client_time_ms:2,position:[0,1.6,4.6],orientation:[0,0,0,1],fov:50,source:"optical-flow",metric:false},
    {client_time_ms:3,position:[0.2,1.6,4.5],orientation:[0,0,0,1],fov:50,source:"imu",metric:false},
  ];
  const summary = math.summarizeCameraPath(frames);
  assert.equal(summary.metric,false);
  assert.equal(summary.metric_distance_m,null);
  assert.ok(summary.relative_travel_units > 0);
  assert.match(summary.note,/do not interpret it as meters/i);
});

test("blockout state stays preview-only and clamps hostile geometry", () => {
  const state = math.sanitizeBlockoutState({
    preview:false,canonical:true,
    camera:{position:[999,-999,999],orientation:[99,0,0,0],fov:999},
    objects:[{id:"bad id /",type:"unknown",label:"x".repeat(100),position:[99,-99,99],size:[0,-50,999],rotation_y:900}],
  });
  assert.equal(state.preview,true);
  assert.equal(state.canonical,false);
  assert.deepEqual(state.camera.position,[30,-10,30]);
  assert.equal(state.camera.fov,140);
  assert.equal(state.objects[0].type,"prop");
  assert.ok(state.objects[0].label.length <= 48);
  assert.ok(state.objects[0].size.every(value=>value >= 0.1 && value <= 12));
});

test("long paths are reduced to bounded export keyframes", () => {
  const frames = Array.from({length:200},(_,index)=>({client_time_ms:index*33,position:[index/100,1.6,5-index/200],orientation:[0,0,0,1],fov:50,source:"webxr",metric:true}));
  const summary = math.summarizeCameraPath(frames);
  assert.equal(summary.keyframes.length,48);
  assert.deepEqual(summary.keyframes[0].position,[0,1.6,5]);
  assert.deepEqual(summary.keyframes.at(-1).position,[1.99,1.6,4.005]);
});
