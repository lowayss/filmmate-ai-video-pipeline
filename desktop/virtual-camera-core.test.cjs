const test = require("node:test");
const assert = require("node:assert/strict");
const {
  circularDeltaDegrees,
  sanitizeSample,
  screenNormalizedAcceleration,
  estimateTranslation,
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
    screen_angle: 450,
    motion: {acceleration:{x:999,y:-999,z:NaN}},
  }, 1000);
  assert.equal(sample.orientation.alpha, 360);
  assert.equal(sample.orientation.beta, 0);
  assert.equal(sample.orientation.gamma, -90);
  assert.equal(sample.screen_angle, 0);
  assert.equal(sample.motion.acceleration.x, 200);
  assert.equal(sample.motion.acceleration.y, -200);
  assert.equal(sample.motion.acceleration.z, 0);
});

test("screen orientation remaps local acceleration axes", () => {
  const sample = sanitizeSample({screen_angle:90,motion:{acceleration:{x:1,y:0,z:0}}});
  const acceleration = screenNormalizedAcceleration(sample);
  assert.ok(Math.abs(acceleration.x) < 0.001);
  assert.ok(acceleration.y > 0.9);
});

test("relative translation identifies dolly intent without metric distance claim", () => {
  const samples = [];
  for (let index = 0; index < 45; index += 1) {
    samples.push(sanitizeSample({
      client_time_ms:index * 33,
      screen_angle:0,
      orientation:{alpha:0,beta:0,gamma:0},
      motion:{acceleration:{x:0,y:0,z:index < 18 ? -1.8 : index < 30 ? 0 : 0.8}},
      source:"sensor",
    }, 1000 + index * 33));
  }
  const result = estimateTranslation(samples);
  assert.equal(result.status, "ok");
  assert.equal(result.metric, false);
  assert.ok(result.relative_position.z < 0);
  assert.match(result.dominant_move, /^dolly in/);
  assert.notEqual(result.confidence, "unavailable");
});

test("analyzeMotion combines translation intent and pan rotation", () => {
  const samples = [];
  for (let index = 0; index < 40; index += 1) {
    samples.push(sanitizeSample({
      client_time_ms:index * 33,
      alpha:10 + index * 0.8,
      beta:0,
      gamma:0,
      motion:{acceleration:{x:0,y:0,z:index < 20 ? -1.2 : 0.5}},
      source:"sensor",
    }, 1000 + index * 33));
  }
  const result = analyzeMotion(samples, {preset:"CINEMA"});
  assert.equal(result.status, "ok");
  assert.match(result.moves.join(" | "), /dolly in/);
  assert.match(result.moves.join(" | "), /pan right/);
  assert.equal(result.relative_translation.metric, false);
  assert.match(result.prompt, /do not infer an exact travel distance/);
});

test("makeTake marks captures as non-canonical preview artifacts", () => {
  const samples = [
    sanitizeSample({client_time_ms:0,alpha:0,beta:0,gamma:0}, 1000),
    sanitizeSample({client_time_ms:1000,alpha:8,beta:-5,gamma:0}, 2000),
  ];
  const take = makeTake({shotId:"C01",preset:"GIMBAL",samples,takeNumber:2});
  assert.equal(take.schema_version, 2);
  assert.equal(take.preview, true);
  assert.equal(take.canonical, false);
  assert.equal(take.shot_id, "C01");
  assert.equal(take.take_number, 2);
  assert.equal(take.preset, "GIMBAL");
});
