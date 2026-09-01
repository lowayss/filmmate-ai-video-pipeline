const fs = require("node:fs");
const path = require("node:path");

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function createProjectPathResolver(packagesRoot, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = path.resolve(packagesRoot);

  function isDirectory(target) {
    try { return fsImpl.statSync(target).isDirectory(); }
    catch { return false; }
  }

  function resolveProject(project, {requireHap = false} = {}) {
    const projectName = String(project || "");
    const projectDir = path.resolve(root, projectName);
    if (
      !projectName.startsWith("PROJECT_")
      || /[\\/]/.test(projectName)
      || !isPathInside(root, projectDir)
      || !fsImpl.existsSync(projectDir)
      || !isDirectory(projectDir)
    ) {
      throw new Error("invalid_project_target");
    }
    if (requireHap && !fsImpl.existsSync(path.join(projectDir, ".hap", "hap.sqlite3"))) {
      throw new Error("hap_project_not_found");
    }
    return projectDir;
  }

  function resolveHapProject(project) {
    return resolveProject(project, {requireHap: true});
  }

  function resolveScene(project, scene) {
    const projectDir = resolveProject(project);
    const sceneName = String(scene || "");
    const scenesRoot = path.resolve(projectDir, "scenes");
    const sceneDir = path.resolve(scenesRoot, sceneName);
    if (
      !sceneName
      || /[\\/]/.test(sceneName)
      || !isPathInside(scenesRoot, sceneDir)
      || !fsImpl.existsSync(sceneDir)
      || !isDirectory(sceneDir)
    ) {
      throw new Error("invalid_scene_target");
    }
    return {projectDir, sceneDir};
  }

  return {root, resolveProject, resolveHapProject, resolveScene};
}

module.exports = {createProjectPathResolver, isPathInside};
