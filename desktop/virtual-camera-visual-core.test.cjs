const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateFrameTransform,
  transformToCameraDelta,
  analyzeVisualTrack,
  fuseCameraPrompts,
  makeVisualTake,
} = require("./virtual-camera-visual-core.cjs");

function proceduralFrame(width, height, {dx=0,dy=0,scale=1} = {}) {
  const frame = new Uint8Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px = cx + (x - cx) / scale + dx;
      const py = cy + (y - cy) / scale + dy;
      const value = 128 + 48 * Math.sin(px * 0.41) + 35 * Math.cos(py * 0.31) + 22 * Math.sin((px + py) * 0.19);
      frame[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return frame;
}

test("visual transform stays near zero for a locked frame", () => {
  const width=64,height=48,frame=proceduralFrame(width,height);
  const transform=estimateFrameTransform(frame,frame,width,height);
  assert.equal(transform.status,"ok");
  assert.equal(transform.dx,0);
  assert.equal(transform.dy,0);
  assert.equal(transform.scale,1);
});

test("visual transform recovers horizontal image shift", () => {
  const width=64,height=48,previous=proceduralFrame(width,height),current=proceduralFrame(width,height,{dx:2});
  const transform=estimateFrameTransform(previous,current,width,height);
  assert.equal(transform.dx,2);
  const delta=transformToCameraDelta(transform,width,height);
  assert.ok(delta.x < 0);
  assert.equal(delta.metric,false);
});

test("visual transform recovers expansion as dolly-in intent", () => {
  const width=64,height=48,previous=proceduralFrame(width,height),current=proceduralFrame(width,height,{scale:1.04});
  const transform=estimateFrameTransform(previous,current,width,height);
  assert.equal(transform.scale,1.04);
  const delta=transformToCameraDelta(transform,width,height);
  assert.ok(delta.z > 0.8);
});

test("WebXR track preserves metric 6DoF displacement", () => {
  const samples=[
    {mode:"webxr",metric:true,position:{x:0,y:1.6,z:0}},
    {mode:"webxr",metric:true,position:{x:0.12,y:1.72,z:-0.42}},
  ];
  const analysis=analyzeVisualTrack(samples);
  assert.equal(analysis.mode,"webxr");
  assert.equal(analysis.metric,true);
  assert.equal(analysis.displacement.z,0.42);
  assert.ok(analysis.moves.some(move=>move.startsWith("dolly in")));
  assert.ok(analysis.moves.some(move=>move.startsWith("truck right")));
});

test("optical-flow track remains explicitly non-metric", () => {
  const samples=[
    {mode:"optical-flow",metric:false,delta:{x:0.4,y:0,z:0.6},confidence:0.8},
    {mode:"optical-flow",metric:false,delta:{x:0.3,y:0,z:0.5},confidence:0.8},
  ];
  const analysis=analyzeVisualTrack(samples);
  assert.equal(analysis.metric,false);
  assert.equal(analysis.mode,"optical-flow");
  assert.match(analysis.prompt,/do not infer an exact travel distance/i);
});

test("fused prompt uses WebXR as primary metric translation", () => {
  const visual={metric:true,prompt:"WebXR move."};
  const imu={prompt:"Pan right 12 degrees."};
  assert.match(fuseCameraPrompts(visual,imu),/primary translation path/);
});

test("visual take remains preview and links an IMU take", () => {
  const take=makeVisualTake({shotId:"C02",takeNumber:3,samples:[{mode:"webxr",metric:true,position:{x:0,y:0,z:0}},{mode:"webxr",metric:true,position:{x:0,y:0,z:-0.2}}],linkedVcamTake:{take_number:2},imuAnalysis:{prompt:"Pan right."}});
  assert.equal(take.preview,true);
  assert.equal(take.canonical,false);
  assert.equal(take.take_number,3);
  assert.equal(take.linked_vcam_take.take_number,2);
  assert.match(take.fused_prompt,/Pan right/);
});
