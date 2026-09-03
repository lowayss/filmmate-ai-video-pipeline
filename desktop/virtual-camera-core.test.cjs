const test = require("node:test");
const assert = require("node:assert/strict");
const {
  circularDeltaDegrees,
  sanitizeSample,
  analyzeMotion,
  makeTake,
} = require("./virtual-camera-core.cjs");

test("circular yaw delta crosses 360 degrees without a jump", () => {
  assert.equal(circularDeltaDegrees(358, 2), 4);
  assert.equal(circularDeltaDegrees(2, 358), -4);
});

test("sanitizeSample clamps hostile or invalid sensor values", () => {
  const sample = sanitizeSample({
    alpha: 9999,
    beta: "bad",
    gamma: -999,
    motion: {acceleration:{x:999,y:-999,z:NaN}},
  }, 1000);
  assert.equal(sample.orientation.alpha, 360);
  assert.equal(sample.orientation.beta, 0);
  assert.equal(sample.orientation.gamma, -90);
  assert.equal(sample.motion.acceleration.x, 200);
  assert.equal(sample.motion.acceleration.y, -200);
  assert.equal(sample.motion.acceleration.z, 0);
});

test("analyzeMotion identifies a pan without claiming metric translation", () => {
  const samples = [
    sanitizeSample({client_time_ms:0,alpha:10,beta:0,gamma:0}, 1000),
    sanitizeSample({client_time_ms:500,alpha:18,beta:0,gamma:0}, 1500),
    sanitizeSample({client_time_ms:1000,alpha:30,beta:0,gamma:0}, 2000),
  ];
  const result = analyzeMotion(samples, {preset:"CINEMA"});
  assert.equal(result.status, "ok");
  assert.equal(result.orientation_delta_deg.yaw, 20);
  assert.match(result.dominant_move, /^pan right/);
  assert.equal(result.translation_confidence, "unavailable");
});

test("makeTake marks captures as non-canonical preview artifacts", () => {
  const samples = [
    sanitizeSample({client_time_ms:0,alpha:0,beta:0,gamma:0}, 1000),
    sanitizeSample({client_time_ms:1000,alpha:8,beta:-5,gamma:0}, 2000),
  ];
  const take = makeTake({shotId:"C01",preset:"GIMBAL",samples,takeNumber:2});
  assert.equal(take.preview, true);
  assert.equal(take.canonical, false);
  assert.equal(take.shot_id, "C01");
  assert.equal(take.take_number, 2);
  assert.equal(take.preset, "GIMBAL");
});
