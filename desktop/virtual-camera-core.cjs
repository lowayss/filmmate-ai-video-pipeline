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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeId(value, fallback = "SHOT") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z가-힣._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function wrapDegrees(value) {
  let result = finite(value) % 360;
  if (result > 180) result -= 360;
  if (result <= -180) result += 360;
  return result;
}

function circularDeltaDegrees(previous, next) {
  return wrapDegrees(finite(next) - finite(previous));
}

function sanitizeSample(input = {}, now = Date.now()) {
  const orientation = input.orientation || input;
  const motion = input.motion || input;
  const acceleration = motion.acceleration || {};
  const accelerationGravity = motion.accelerationIncludingGravity || {};
  const rotationRate = motion.rotationRate || {};
  return {
    received_at: new Date(now).toISOString(),
    client_time_ms: clamp(finite(input.client_time_ms, now), 0, 9e15),
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
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
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
    const magnitudeSquared = finite(a.x) ** 2 + finite(a.y) ** 2 + finite(a.z) ** 2;
    return total + magnitudeSquared;
  }, 0);
  return Math.sqrt(sum / samples.length);
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
    return {
      status: "insufficient",
      duration_sec: 0,
      sample_count: Array.isArray(samples) ? samples.length : 0,
      moves: [],
      prompt: "Camera motion not captured yet.",
      translation_confidence: "unavailable",
    };
  }
  const firstMs = finite(samples[0].client_time_ms, Date.parse(samples[0].received_at || 0));
  const lastMs = finite(samples[samples.length - 1].client_time_ms, Date.parse(samples[samples.length - 1].received_at || 0));
  const durationSec = Math.max(0, (lastMs - firstMs) / 1000);
  const delta = cumulativeOrientationDelta(samples);
  const moves = movementLabels(delta);
  const rms = accelerationRms(samples);
  const presetName = String(options.preset || "CINEMA").toUpperCase();
  const preset = PRESETS[presetName] || PRESETS.CINEMA;
  const handheld = rms >= 0.8;
  const motionText = moves.length ? moves.join(", then ") : "mostly locked-off orientation";
  const texture = presetName === "GIMBAL" ? "stabilized gimbal feel" : presetName === "RAW" ? "raw handheld response" : handheld ? "subtle handheld texture" : "controlled camera motion";
  const durationText = durationSec > 0 ? `${durationSec.toFixed(2)}s` : "short take";
  return {
    status: "ok",
    duration_sec: Number(durationSec.toFixed(3)),
    sample_count: samples.length,
    orientation_delta_deg: {
      yaw: Number(delta.yaw.toFixed(2)),
      pitch: Number(delta.pitch.toFixed(2)),
      roll: Number(delta.roll.toFixed(2)),
    },
    acceleration_rms: Number(rms.toFixed(3)),
    handheld,
    stabilization: preset.label,
    smoothing: preset.smoothing,
    moves,
    dominant_move: moves[0] || "locked-off",
    translation_confidence: "unavailable",
    note: "Phone orientation and acceleration can describe rotation/handheld texture, but cannot reliably recover metric XYZ camera translation without visual/inertial pose tracking.",
    prompt: `Virtual camera take, ${durationText}. ${motionText}. ${texture}. Preserve subject framing and continuity.`,
  };
}

function makeTake({shotId, preset, samples, startedAt, stoppedAt, takeNumber = 1, source = "virtual-camera"}) {
  const safeShot = safeId(shotId, "SHOT");
  const normalizedPreset = PRESETS[String(preset || "CINEMA").toUpperCase()] ? String(preset).toUpperCase() : "CINEMA";
  const analysis = analyzeMotion(samples, {preset:normalizedPreset});
  return {
    schema_version: 1,
    preview: true,
    canonical: false,
    source,
    shot_id: safeShot,
    take_number: Math.max(1, Math.trunc(finite(takeNumber, 1))),
    preset: normalizedPreset,
    started_at: startedAt || samples?.[0]?.received_at || new Date().toISOString(),
    stopped_at: stoppedAt || samples?.[samples.length - 1]?.received_at || new Date().toISOString(),
    sample_count: Array.isArray(samples) ? samples.length : 0,
    analysis,
    samples: Array.isArray(samples) ? samples : [],
  };
}

module.exports = {
  PRESETS,
  safeId,
  wrapDegrees,
  circularDeltaDegrees,
  sanitizeSample,
  analyzeMotion,
  makeTake,
};
