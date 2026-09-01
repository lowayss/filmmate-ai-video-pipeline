const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function bridgeError(prefix, error, fallback = "python spawn failed") {
  const code = error?.code || error?.name || "spawn_error";
  return new Error(`${prefix}:${code}:${error?.message || fallback}`);
}

function createPythonBridge(options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, ".."));
  const resourcesPath = options.resourcesPath ? path.resolve(options.resourcesPath) : null;
  const fsImpl = options.fsImpl || fs;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const spawn = options.spawn || childProcess.spawn;
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
    if (result?.error) throw bridgeError("E_BRIDGE_SPAWN", result.error);
    if (result?.signal) throw new Error(`E_BRIDGE_SIGNAL:${result.signal}`);
    if (result?.status !== 0) {
      throw new Error(String(result?.stderr || result?.stdout || "python_command_failed").trim());
    }
    return result;
  }

  function runPythonAsync(script, args = [], runOptions = {}) {
    const executable = pythonExecutable();
    const perCallTimeout = positiveInt(runOptions.timeoutMs, timeoutMs);
    const perCallMaxBuffer = positiveInt(runOptions.maxBuffer, maxBuffer);
    const {input, timeoutMs: _timeout, maxBuffer: _buffer, ...spawnOptions} = runOptions;

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, [script, ...args], {
          stdio: ["pipe", "pipe", "pipe"],
          ...spawnOptions,
        });
      } catch (error) {
        reject(bridgeError("E_BRIDGE_SPAWN", error));
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback();
      };
      const fail = error => finish(() => reject(error));
      const totalBytes = () => Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
      const append = (kind, chunk) => {
        if (settled) return;
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        if (kind === "stdout") stdout += text;
        else stderr += text;
        if (totalBytes() > perCallMaxBuffer) {
          try { child.kill("SIGTERM"); } catch { /* best effort */ }
          fail(new Error(`E_BRIDGE_MAX_BUFFER:${perCallMaxBuffer}`));
        }
      };

      child.stdout?.on("data", chunk => append("stdout", chunk));
      child.stderr?.on("data", chunk => append("stderr", chunk));
      child.once("error", error => fail(bridgeError("E_BRIDGE_SPAWN", error)));
      child.once("close", (status, signal) => {
        if (settled) return;
        if (signal) {
          fail(new Error(`E_BRIDGE_SIGNAL:${signal}`));
          return;
        }
        if (status !== 0) {
          fail(new Error(String(stderr || stdout || "python_command_failed").trim()));
          return;
        }
        finish(() => resolve({status, signal:null, stdout, stderr}));
      });

      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* best effort */ }
        fail(new Error(`E_BRIDGE_TIMEOUT:${perCallTimeout}`));
      }, perCallTimeout);

      if (child.stdin) {
        child.stdin.on?.("error", () => {});
        child.stdin.end(input === undefined || input === null ? undefined : String(input));
      }
    });
  }

  function hapScriptPath() {
    return coreScriptPath("hap_core.py");
  }

  function documentBridgePath() {
    return coreScriptPath("filmmate_documents.py");
  }

  function parseDocumentResult(output) {
    let parsed;
    try {
      parsed = JSON.parse(String(output || "").trim());
    } catch {
      throw new Error(`E_DOCUMENT_BRIDGE_RESPONSE_INVALID:${String(output || "").trim().slice(0, 500)}`);
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error(parsed?.error || "document_bridge_failed");
    }
    return parsed;
  }

  function runHap(_projectDir, args) {
    return String(runPython(hapScriptPath(), Array.isArray(args) ? args : []).stdout || "").trim();
  }

  async function runHapAsync(_projectDir, args) {
    const result = await runPythonAsync(hapScriptPath(), Array.isArray(args) ? args : []);
    return String(result.stdout || "").trim();
  }

  function runDocumentBridge(command, payload) {
    const result = runPython(documentBridgePath(), [String(command || "")], {
      input: JSON.stringify(payload ?? {}),
    });
    return parseDocumentResult(result.stdout);
  }

  async function runDocumentBridgeAsync(command, payload) {
    const result = await runPythonAsync(documentBridgePath(), [String(command || "")], {
      input: JSON.stringify(payload ?? {}),
    });
    return parseDocumentResult(result.stdout);
  }

  return {
    pythonExecutable,
    coreScriptPath,
    hapScriptPath,
    documentBridgePath,
    runPython,
    runPythonAsync,
    runHap,
    runHapAsync,
    runDocumentBridge,
    runDocumentBridgeAsync,
  };
}

module.exports = {
  DEFAULT_MAX_BUFFER,
  DEFAULT_TIMEOUT_MS,
  createPythonBridge,
};
