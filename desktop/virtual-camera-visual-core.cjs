function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sampleGray(frame, width, height, x, y) {
  const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
  return frame[iy * width + ix] || 0;
}

function estimateFrameTransform(previous, current, width, height, options = {}) {
  if (!previous || !current || previous.length !== current.length || previous.length !== width * height) {
    return {status:"invalid", dx:0, dy:0, scale:1, score:Infinity, confidence:0};
  }
  const shifts = Number.isFinite(options.maxShift) ? Math.max(1, Math.trunc(options.maxShift)) : 4;
  const scales = options.scales || [0.96, 0.98, 1, 1.02, 1.04];
  const step = Number.isFinite(options.step) ? Math.max(1, Math.trunc(options.step)) : 3;
  const margin = Math.max(shifts + 3, Math.trunc(Math.min(width, height) * 0.12));
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  let best = {dx:0,dy:0,scale:1,score:Infinity,objective:Infinity};
  let second = Infinity;

  for (const scale of scales) {
    for (let dy = -shifts; dy <= shifts; dy += 1) {
      for (let dx = -shifts; dx <= shifts; dx += 1) {
        let error = 0;
        let count = 0;
        for (let y = margin; y < height - margin; y += step) {
          for (let x = margin; x < width - margin; x += step) {
            const px = cx + (x - cx) / scale + dx;
            const py = cy + (y - cy) / scale + dy;
            if (px < 1 || px >= width - 1 || py < 1 || py >= height - 1) continue;
            error += Math.abs(current[y * width + x] - sampleGray(previous, width, height, px, py));
            count += 1;
          }
        }
        const score = count ? error / count : Infinity;
        const identityPenalty = Math.abs(scale - 1) * 0.25 + (Math.abs(dx) + Math.abs(dy)) * 0.001;
        const objective = score + identityPenalty;
        if (objective < best.objective) {
          second = best.score;
          best = {dx,dy,scale,score,objective};
        } else if (score < second) {
          second = score;
        }
      }
    }
  }

  const contrast = Number.isFinite(second) && second > 0 ? Math.max(0, (second - best.score) / second) : 0;
  const texture = frameTexture(current, width, height);
  const confidence = clamp(contrast * 4 + Math.min(0.5, texture / 80), 0, 1);
  return {status:"ok",dx:best.dx,dy:best.dy,scale:Number(best.scale.toFixed(4)),score:Number(best.score.toFixed(3)),confidence:Number(confidence.toFixed(3)),texture:Number(texture.toFixed(2))};
}

function frameTexture(frame, width, height) {
  let total = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const value = frame[y * width + x];
      total += Math.abs(value - frame[y * width + x + 1]) + Math.abs(value - frame[(y + 1) * width + x]);
      count += 2;
    }
  }
  return count ? total / count : 0;
}

function transformToCameraDelta(transform, width, height) {
  if (!transform || transform.status !== "ok") return {x:0,y:0,z:0,confidence:0,metric:false};
  return {
    x: Number(clamp(-transform.dx / Math.max(1, width * 0.12), -1, 1).toFixed(4)),
    y: Number(clamp(transform.dy / Math.max(1, height * 0.12), -1, 1).toFixed(4)),
    z: Number(clamp((transform.scale - 1) / 0.04, -1, 1).toFixed(4)),
    confidence: finite(transform.confidence),
    metric:false,
  };
}

function movementLabels(vector, {metric = false} = {}) {
  const labels = [];
  const x = finite(vector?.x);
  const y = finite(vector?.y);
  const z = finite(vector?.z);
  const threshold = metric ? 0.025 : 0.15;
  if (Math.abs(z) >= threshold) labels.push(`dolly ${z > 0 ? "in" : "out"}${metric ? ` ${Math.abs(z).toFixed(2)}m` : ""}`);
  if (Math.abs(x) >= threshold) labels.push(`truck ${x > 0 ? "right" : "left"}${metric ? ` ${Math.abs(x).toFixed(2)}m` : ""}`);
  if (Math.abs(y) >= threshold) labels.push(`pedestal ${y > 0 ? "up" : "down"}${metric ? ` ${Math.abs(y).toFixed(2)}m` : ""}`);
  return labels;
}

function analyzeVisualTrack(samples = []) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return {status:"insufficient",mode:"none",metric:false,confidence:"unavailable",moves:[],prompt:"Visual pose not captured yet."};
  }
  const xrSamples = samples.filter(sample => sample?.mode === "webxr" && sample?.position && sample?.metric === true);
  if (xrSamples.length >= 2) {
    const first = xrSamples[0].position;
    const last = xrSamples[xrSamples.length - 1].position;
    const displacement = {
      x:Number((finite(last.x)-finite(first.x)).toFixed(4)),
      y:Number((finite(last.y)-finite(first.y)).toFixed(4)),
      z:Number((finite(first.z)-finite(last.z)).toFixed(4)),
    };
    const moves = movementLabels(displacement, {metric:true});
    return {
      status:"ok",mode:"webxr",metric:true,confidence:"high",sample_count:xrSamples.length,
      displacement, moves, dominant_move:moves[0] || "locked-off",
      prompt:`WebXR 6DoF camera move. ${moves.length ? moves.join(", then ") : "Hold camera position"}. Preserve the captured spatial path and orientation timing.`,
    };
  }

  const flowSamples = samples.filter(sample => sample?.mode === "optical-flow" && sample?.delta);
  let x = 0, y = 0, z = 0, confidenceTotal = 0;
  for (const sample of flowSamples) {
    const confidence = clamp(finite(sample.confidence, sample.delta?.confidence), 0, 1);
    if (confidence < 0.15) continue;
    x += finite(sample.delta.x) * confidence;
    y += finite(sample.delta.y) * confidence;
    z += finite(sample.delta.z) * confidence;
    confidenceTotal += confidence;
  }
  const divisor = Math.max(1, Math.sqrt(Math.max(1, flowSamples.length)));
  const displacement = {x:Number((x/divisor).toFixed(4)),y:Number((y/divisor).toFixed(4)),z:Number((z/divisor).toFixed(4))};
  const averageConfidence = flowSamples.length ? confidenceTotal / flowSamples.length : 0;
  const moves = movementLabels(displacement, {metric:false});
  const confidence = averageConfidence >= 0.55 ? "medium" : averageConfidence >= 0.25 ? "low" : "very_low";
  return {
    status:"ok",mode:"optical-flow",metric:false,confidence,sample_count:flowSamples.length,
    displacement,moves,dominant_move:moves[0] || "locked-off",
    note:"Optical-flow displacement is normalized camera-motion intent, not a physical distance measurement.",
    prompt:`Visual camera-motion intent. ${moves.length ? moves.join(", then ") : "Mostly hold position"}. Match the direction and rhythm, but do not infer an exact travel distance from these non-metric values.`,
  };
}

function fuseCameraPrompts(visualAnalysis, imuAnalysis) {
  const parts = [];
  if (visualAnalysis?.prompt) parts.push(visualAnalysis.prompt);
  if (imuAnalysis?.prompt) parts.push(imuAnalysis.prompt);
  if (!parts.length) return "Camera motion not captured yet.";
  const metric = visualAnalysis?.metric === true;
  return `${parts.join(" ")} ${metric ? "Use the WebXR spatial displacement as the primary translation path." : "Use visual tracking for translation direction only; do not claim exact physical distance."}`;
}

function makeVisualTake({shotId="C01", samples=[], startedAt, stoppedAt, takeNumber=1, linkedVcamTake=null, imuAnalysis=null} = {}) {
  const analysis = analyzeVisualTrack(samples);
  return {
    schema_version:1,preview:true,canonical:false,source:"virtual-camera-visual-v3",
    shot_id:String(shotId || "C01"),take_number:Math.max(1,Math.trunc(finite(takeNumber,1))),
    started_at:startedAt || samples[0]?.received_at || new Date().toISOString(),
    stopped_at:stoppedAt || samples[samples.length-1]?.received_at || new Date().toISOString(),
    sample_count:samples.length,tracking_mode:analysis.mode,metric:analysis.metric,
    linked_vcam_take:linkedVcamTake,analysis,
    fused_prompt:fuseCameraPrompts(analysis, imuAnalysis),
    samples,
  };
}

module.exports = {estimateFrameTransform, transformToCameraDelta, movementLabels, analyzeVisualTrack, fuseCameraPrompts, makeVisualTake};
