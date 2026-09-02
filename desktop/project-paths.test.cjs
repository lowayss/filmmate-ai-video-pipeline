const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {createProjectPathResolver, isPathInside} = require("./project-paths.cjs");

test("project and scene paths stay inside the packages root", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "filmmate-paths-"));
  try {
    const packages = path.join(temp, "packages");
    const project = path.join(packages, "PROJECT_demo");
    const scene = path.join(project, "scenes", "S1_room");
    fs.mkdirSync(path.join(project, ".hap"), {recursive:true});
    fs.mkdirSync(scene, {recursive:true});
    fs.writeFileSync(path.join(project, ".hap", "hap.sqlite3"), "test");

    const resolver = createProjectPathResolver(packages);
    assert.equal(resolver.resolveProject("PROJECT_demo"), project);
    assert.equal(resolver.resolveHapProject("PROJECT_demo"), project);
    assert.deepEqual(resolver.resolveScene("PROJECT_demo", "S1_room"), {projectDir:project, sceneDir:scene});
    assert.equal(isPathInside(packages, project), true);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});

test("path traversal and missing targets are rejected deterministically", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "filmmate-paths-"));
  try {
    const packages = path.join(temp, "packages");
    const project = path.join(packages, "PROJECT_demo");
    fs.mkdirSync(path.join(project, "scenes", "S1"), {recursive:true});
    const resolver = createProjectPathResolver(packages);

    assert.throws(() => resolver.resolveProject("../PROJECT_demo"), /invalid_project_target/);
    assert.throws(() => resolver.resolveProject("PROJECT_demo/../../outside"), /invalid_project_target/);
    assert.throws(() => resolver.resolveProject("PROJECT_demo/scenes"), /invalid_project_target/);
    assert.throws(() => resolver.resolveProject("PROJECT_demo\\scenes"), /invalid_project_target/);
    assert.throws(() => resolver.resolveScene("PROJECT_demo", "../outside"), /invalid_scene_target/);
    assert.throws(() => resolver.resolveScene("PROJECT_demo", "S1/nested"), /invalid_scene_target/);
    assert.throws(() => resolver.resolveHapProject("PROJECT_demo"), /hap_project_not_found/);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
