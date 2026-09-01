const assert = require("node:assert/strict");
const test = require("node:test");

const {buildSceneProductionState, stageForEntity} = require("./production-state.cjs");

function entity(type, key, state = "verified", extra = {}) {
  return {
    entity_id: `${type}:${key}`,
    entity_type: type,
    logical_key: key,
    state,
    errors: extra.errors || [],
    dependencies: extra.dependencies || [],
    current_revision: {
      revision_id: `${type}:${key}@1`,
      payload_json: JSON.stringify(extra.payload || {}),
    },
  };
}

function readyScene() {
  const scene = entity("scene", "S1");
  const children = [
    entity("block", "B01"),
    entity("asset", "character:jiyeon"),
    entity("cut", "C01"),
    entity("prompt", "C01:seedance"),
  ];
  return {scene, children};
}

test("production readiness becomes generate-ready only when every required stage is ready", () => {
  const {scene, children} = readyScene();
  const result = buildSceneProductionState({sceneEntity: scene, childEntities: children});
  assert.equal(result.generate_ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.progress, 100);
  assert.equal(result.ready_stages, 5);
  assert.equal(result.required_stages, 5);
  assert.deepEqual(result.blockers, []);
});

test("stale dependency explains which upstream revision changed and suggests regeneration", () => {
  const {scene, children} = readyScene();
  children[2] = entity("cut", "C01", "stale", {
    errors: ["an upstream revision changed"],
    dependencies: [{
      role: "character_reference",
      upstream_entity_id: "asset:jiyeon",
      upstream_entity_type: "asset",
      upstream_logical_key: "Jiyeon",
      used_revision_id: "asset:jiyeon@4",
      current_revision_id: "asset:jiyeon@5",
      stale: true,
    }],
  });
  const result = buildSceneProductionState({sceneEntity: scene, childEntities: children});
  assert.equal(result.generate_ready, false);
  assert.equal(result.status, "stale");
  assert.equal(result.stages.storyboard.status, "stale");
  assert.equal(result.next_action.action, "regenerate_from_current_inputs");
  assert.match(result.stages.storyboard.reasons.join("\n"), /Jiyeon changed/);
  assert.match(result.stages.storyboard.reasons.join("\n"), /@4.*@5/);
  assert.equal(result.stale_objects.length, 1);
});

test("active prompt job is shown as in-progress when canonical prompt object does not exist yet", () => {
  const {scene, children} = readyScene();
  const withoutPrompt = children.filter(item => item.entity_type !== "prompt");
  const result = buildSceneProductionState({
    sceneEntity: scene,
    childEntities: withoutPrompt,
    promptJobs: [{job_id:"job-1", state:"WRITING", updated_at:"2026-09-01T10:00:00Z"}],
  });
  assert.equal(result.generate_ready, false);
  assert.equal(result.stages.prompts.status, "in_progress");
  assert.match(result.stages.prompts.reasons.join("\n"), /writing/);
  assert.equal(result.next_action.stage, "prompts");
});

test("unverified canonical objects require review instead of being treated as ready", () => {
  const {scene, children} = readyScene();
  children[1] = entity("asset", "character:jiyeon", "unverified", {errors:["no passing QA for the current artifact hashes"]});
  const result = buildSceneProductionState({sceneEntity: scene, childEntities: children});
  assert.equal(result.generate_ready, false);
  assert.equal(result.stages.assets.status, "needs_review");
  assert.equal(result.stages.assets.action, "run_qa_or_review");
  assert.match(result.stages.assets.reasons[0], /passing QA/);
});

test("explicit production_stage in canonical payload can override fallback entity type mapping", () => {
  const unusual = entity("block", "B01", "verified", {payload:{production_stage:"storyboard"}});
  assert.equal(stageForEntity(unusual), "storyboard");
});
