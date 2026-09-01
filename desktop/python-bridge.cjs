const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createPythonBridge(options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, ".."));
  const resourcesPath = options.resourcesPath ? path.resolve(options.resourcesPath) : null;
  const fsImpl = options.fsImpl || fs;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = positiveInt(options.timeoutMs ?? process.env.FILMMATE_BRIDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxBuffer = positiveInt(options.maxBuffer, DEFAULT_MAX_BUFFER);

  function pythonExecutable() {
    return options.python
      || process.env.FILMMATE_PYTHON
      || process.env.SCENEFLOW_PYTHON
      || "/usr/bin/python3";
  }

  function coreScriptPath(filename) {
    const workspace = path.join(root, "core", filename);
    if (fsImpl.existsSync(workspace)) return workspace;
    if (resourcesPath) {
      const bundled = path.join(resourcesPath, "core", filename);
      if (fsImpl.existsSync(bundled)) return bundled;
    }
    throw new Error(`E_BRIDGE_SCRIPT_MISSING:${filename}`);
  }

  function runPython(script, args = [], runOptions = {}) {
    const executable = pythonExecutable();
    const result = spawnSync(executable, [script, ...args], {
      encoding: "utf8",
      maxBuffer,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      ...runOptions,
    });
    if (result?.error) {
      const code = result.error.code || result.error.name || "spawn_error";
      throw new Error(`E_BRIDGE_SPAWN:${code}:${result.error.message || "python spawn failed"}`);
    }
    if (result?.signal) {
      throw new Error(`E_BRIDGE_SIGNAL:${result.signal}`);
    }
    if (result?.status !== 0) {
      throw new Error(String(result?.stderr || result?.stdout || "python_command_failed").trim());
    }
    return result;
  }

  function hapScriptPath() {
    return coreScriptPath("hap_core.py");
  }

  function documentBridgePath() {
    return coreScriptPath("filmmate_documents.py");
  }

  function runHap(_projectDir, args) {
    return String(runPython(hapScriptPath(), Array.isArray(args) ? args : []).stdout || "").trim();
  }

  function runDocumentBridge(command, payload) {
    const result = runPython(documentBridgePath(), [String(command || "")], {
      input: JSON.stringify(payload ?? {}),
    });
    const output = String(result.stdout || "").trim();
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error(`E_DOCUMENT_BRIDGE_RESPONSE_INVALID:${output.slice(0, 500)}`);
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error(parsed?.error || "document_bridge_failed");
    }
    return parsed;
  }

  return {
    pythonExecutable,
    coreScriptPath,
    hapScriptPath,
    documentBridgePath,
    runPython,
    runHap,
    runDocumentBridge,
  };
}

module.exports = {
  DEFAULT_MAX_BUFFER,
  DEFAULT_TIMEOUT_MS,
  createPythonBridge,
};
