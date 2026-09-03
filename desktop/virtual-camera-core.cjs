const PRESETS = Object.freeze({
  RAW: {label: "RAW", smoothing: 0},
  HANDHELD: {label: "HANDHELD", smoothing: 0.12},
  CINEMA: {label: "CINEMA", smoothing: 0.32},
  SMOOTH: {label: "SMOOTH", smoothing: 0.5},
  GIMBAL: {label: "GIMBAL", smoothing: 0.72},
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function safeId(value, fallback = "SHOT") {
  const cleaned = String(value || "").trim().replace(/[^0-9A-Za-z가-힣._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return cleaned || fallback;
}

function wrapDegrees(value) {
  let result = finite(value) % 360;
  if (result > 180) result -= 360;
  if (result <= -180) result += 360;
  return result;
}

function circularDeltaDegrees(previous, next) { return wrapDegrees(finite(next) - finite(previous)); }

function sanitizeSample(input = {}, now = Date.now()) {
  const orientation = input.orientation || input;
  const motion = input.motion || input;
  const acceleration = motion.acceleration || {};
  const accelerationGravity = motion.accelerationIncludingGravity || {};
  const rotationRate = motion.rotationRate || {};
  return {
    received_at: new Date(now).toISOString(),
    client_time_ms: clamp(finite(input.client_time_ms, now), 0, 9e15),
    screen_angle: wrapDegrees(clamp(finite(input.screen_angle), -360, 360)),
    orientation: {
      alpha: clamp(finite(orientation.alpha), -360, 360),
      beta: clamp(finite(orientation.beta), -180, 180),
      gamma: clamp(finite(orientation.gamma), -90, 90),
      absolute: Boolean(orientation.absolute),
    },
    motion: {
      acceleration: {
        x: clamp(finite(acceleration.x), -200, 200),
        y: clamp(finite(acceleration.y), -200, 200),
        z: clamp(finite(acceleration.z), -200, 200),
      },
      accelerationIncludingGravity: {
        x: clamp(finite(accelerationGravity.x), -200, 200),
        y: clamp(finite(accelerationGravity.y), -200, 200),
        z: clamp(finite(accelerationGravity.z), -200, 200),
      },
      rotationRate: {
        alpha: clamp(finite(rotationRate.alpha), -2000, 2000),
        beta: clamp(finite(rotationRate.beta), -2000, 2000),
        gamma: clamp(finite(rotationRate.gamma), -2000, 2000),
      },
      interval: clamp(finite(motion.interval), 0, 1000),
    },
    source: String(input.source || "device").slice(0, 32),
  };
}

function cumulativeOrientationDelta(samples) {
  let yaw = 0, pitch = 0, roll = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].orientation || {};
    const current = samples[index].orientation || {};
    yaw += circularDeltaDegrees(previous.alpha, current.alpha);
    pitch += circularDeltaDegrees(previous.beta, current.beta);
    roll += circularDeltaDegrees(previous.gamma, current.gamma);
  }
  return {yaw, pitch, roll};
}

function accelerationRms(samples) {
  if (!samples.length) return 0;
  const sum = samples.reduce((total, sample) => {
    const a = sample.motion?.acceleration || {};
    return total + finite(a.x) ** 2 + finite(a.y) ** 2 + finite(a.z) ** 2;
  }, 0);
  return Math.sqrt(sum / samples.length);
}

function screenNormalizedAcceleration(sample) {
  const a = sample.motion?.acceleration || {};
  const angle = finite(sample.screen_angle) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    x: finite(a.x) * cos - finite(a.y) * sin,
    y: finite(a.x) * sin + finite(a.y) * cos,
    z: finite(a.z),
  };
}

function damped(value, dt, rate = 3.6) { return value * Math.exp(-rate * dt); }
function deadzone(value, zone = 0.13) { return Math.abs(value) < zone ? 0 : value - Math.sign(value) * zone; }

function estimateTranslation(samples = [], options = {}) {
  if (!Array.isArray(samples) || samples.length < 3) {
    return {status:"insufficient",confidence:"unavailable",relative_position:{x:0,y:0,z:0},moves:[],trajectory:[]};
  }
  const trajectory = [{t:0,x:0,y:0,z:0}];
  const velocity = {x:0,y:0,z:0};
  const position = {x:0,y:0,z:0};
  let activeSamples = 0;
  let idleSamples = 0;
  const gain = clamp(finite(options.gain, 1.35), 0.2, 4);
  const startMs = finite(samples[0].client_time_ms);
  for (let index = 1; index < samples.length; index += 1) {
    const previousMs = finite(samples[index - 1].client_time_ms, startMs);
    const currentMs = finite(samples[index].client_time_ms, previousMs + 33);
    const dt = clamp((currentMs - previousMs) / 1000, 0.005, 0.12);
    const raw = screenNormalizedAcceleration(samples[index]);
    const a = {x:deadzone(raw.x), y:deadzone(raw.y), z:deadzone(raw.z)};
    const magnitude = Math.hypot(a.x, a.y, a.z);
    if (magnitude > 0.08) { activeSamples += 1; idleSamples = 0; } else { idleSamples += 1; }
    for (const axis of ["x","y","z"]) {
      velocity[axis] = damped(velocity[axis] + a[axis] * dt * gain, dt);
      if (idleSamples >= 4) velocity[axis] *= 0.45;
      if (Math.abs(velocity[axis]) < 0.006) velocity[axis] = 0;
      position[axis] = clamp(position[axis] + velocity[axis] * dt, -3, 3);
    }
    if (index % 3 === 0 || index === samples.length - 1) {
      trajectory.push({
        t:Number(((currentMs - startMs) / 1000).toFixed(3)),
        x:Number(position.x.toFixed(4)), y:Number(position.y.toFixed(4)), z:Number(position.z.toFixed(4)),
      });
    }
  }
  const duration = Math.max(0, (finite(samples[samples.length - 1].client_time_ms) - startMs) / 1000);
  const activityRatio = activeSamples / Math.max(1, samples.length - 1);
  const displacement = Math.hypot(position.x, position.y, position.z);
  const sourceSensorRatio = samples.filter(sample => sample.source === "sensor").length / samples.length;
  let confidence = "low";
  if (samples.length >= 30 && duration >= 0.8 && activityRatio >= 0.08 && sourceSensorRatio >= 0.6) confidence = "medium";
  if (duration > 12 || sourceSensorRatio < 0.35 || displacement < 0.015) confidence = displacement < 0.015 ? "low" : confidence;
  const moves = [];
  const threshold = 0.035;
  if (Math.abs(position.z) >= threshold) moves.push(`dolly ${position.z < 0 ? "in" : "out"}`);
  if (Math.abs(position.x) >= threshold) moves.push(`truck ${position.x > 0 ? "right" : "left"}`);
  if (Math.abs(position.y) >= threshold) moves.push(`pedestal ${position.y > 0 ? "up" : "down"}`);
  return {
    status:"ok",
    method:"damped_acceleration_relative_pose",
    confidence,
    metric:false,
    relative_units:"camera-relative arbitrary units",
    relative_position:{x:Number(position.x.toFixed(4)),y:Number(position.y.toFixed(4)),z:Number(position.z.toFixed(4))},
    relative_velocity:{x:Number(velocity.x.toFixed(4)),y:Number(velocity.y.toFixed(4)),z:Number(velocity.z.toFixed(4))},
    moves,
    dominant_move:moves[0] || "no reliable translation",
    activity_ratio:Number(activityRatio.toFixed(3)),
    sensor_ratio:Number(sourceSensorRatio.toFixed(3)),
    trajectory:trajectory.slice(-160),
    note:"Relative camera-local pose is derived from gravity-free acceleration with damping. It is useful for dolly/truck/pedestal intent, not for real-world meter measurements.",
  };
}

function movementLabels(delta) {
  const moves = [];
  if (Math.abs(delta.yaw) >= 5) moves.push(`pan ${delta.yaw > 0 ? "right" : "left"} ${Math.abs(delta.yaw).toFixed(1)}°`);
  if (Math.abs(delta.pitch) >= 4) moves.push(`tilt ${delta.pitch > 0 ? "down" : "up"} ${Math.abs(delta.pitch).toFixed(1)}°`);
  if (Math.abs(delta.roll) >= 6) moves.push(`roll ${delta.roll > 0 ? "clockwise" : "counter-clockwise"} ${Math.abs(delta.roll).toFixed(1)}°`);
  return moves;
}

function analyzeMotion(samples = [], options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return {status:"insufficient",duration_sec:0,sample_count:Array.isArray(samples)?samples.length:0,moves:[],prompt:"Camera motion not captured yet.",translation_confidence:"unavailable"};
  }
  const firstMs = finite(samples[0].client_time_ms, Date.parse(samples[0].received_at || 0));
  const lastMs = finite(samples[samples.length - 1].client_time_ms, Date.parse(samples[samples.length - 1].received_at || 0));
  const durationSec = Math.max(0, (lastMs - firstMs) / 1000);
  const delta = cumulativeOrientationDelta(samples);
  const rotationMoves = movementLabels(delta);
  const translation = estimateTranslation(samples, options.translation || {});
  const moves = [...translation.moves, ...rotationMoves];
  const rms = accelerationRms(samples);
  const presetName = String(options.preset || "CINEMA").toUpperCase();
  const preset = PRESETS[presetName] || PRESETS.CINEMA;
  const handheld = rms >= 0.8;
  const motionText = moves.length ? moves.join(", then ") : "mostly locked-off camera";
  const texture = presetName === "GIMBAL" ? "stabilized gimbal feel" : presetName === "RAW" ? "raw handheld response" : handheld ? "subtle handheld texture" : "controlled camera motion";
  const durationText = durationSec > 0 ? `${durationSec.toFixed(2)}s` : "short take";
  const translationGuard = translation.moves.length ? "Use the translation as relative movement intent only; do not infer an exact travel distance." : "";
  return {
    status:"ok",
    duration_sec:Number(durationSec.toFixed(3)),
    sample_count:samples.length,
    orientation_delta_deg:{yaw:Number(delta.yaw.toFixed(2)),pitch:Number(delta.pitch.toFixed(2)),roll:Number(delta.roll.toFixed(2))},
    acceleration_rms:Number(rms.toFixed(3)), handheld, stabilization:preset.label, smoothing:preset.smoothing,
    moves, dominant_move:moves[0] || "locked-off",
    translation_confidence:translation.confidence,
    relative_translation:translation,
    note:"Rotation is sensor-derived. Translation is camera-relative and deliberately non-metric unless a future visual/inertial tracker provides calibrated scale.",
    prompt:`Virtual camera take, ${durationText}. ${motionText}. ${texture}. Preserve subject framing and continuity. ${translationGuard}`.trim(),
  };
}

function makeTake({shotId, preset, samples, startedAt, stoppedAt, takeNumber = 1, source = "virtual-camera"}) {
  const safeShot = safeId(shotId, "SHOT");
  const normalizedPreset = PRESETS[String(preset || "CINEMA").toUpperCase()] ? String(preset).toUpperCase() : "CINEMA";
  const analysis = analyzeMotion(samples, {preset:normalizedPreset});
  return {
    schema_version:2, preview:true, canonical:false, source, shot_id:safeShot,
    take_number:Math.max(1,Math.trunc(finite(takeNumber,1))), preset:normalizedPreset,
    started_at:startedAt || samples?.[0]?.received_at || new Date().toISOString(),
    stopped_at:stoppedAt || samples?.[samples.length - 1]?.received_at || new Date().toISOString(),
    sample_count:Array.isArray(samples)?samples.length:0,
    analysis, samples:Array.isArray(samples)?samples:[],
  };
}

module.exports = {PRESETS,safeId,wrapDegrees,circularDeltaDegrees,sanitizeSample,screenNormalizedAcceleration,estimateTranslation,analyzeMotion,makeTake};
