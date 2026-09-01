const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {createPythonBridge} = require("./python-bridge.cjs");

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "filmmate-bridge-"));
  fs.mkdirSync(path.join(temp, "core"), {recursive:true});
  fs.writeFileSync(path.join(temp, "core", "hap_core.py"), "# hap\n");
  fs.writeFileSync(path.join(temp, "core", "filmmate_documents.py"), "# docs\n");
  return temp;
}

test("python bridge centralizes timeout and successful text/json parsing", () => {
  const temp = fixture();
  const calls = [];
  try {
    const bridge = createPythonBridge({
      root: temp,
      timeoutMs: 777,
      spawnSync(executable, args, options) {
        calls.push({executable,args,options});
        if (args[0].endsWith("filmmate_documents.py")) return {status:0,signal:null,stdout:'{"ok":true,"documents":{}}',stderr:""};
        return {status:0,signal:null,stdout:"hap-ok\n",stderr:""};
      },
    });
    assert.equal(bridge.runHap(temp, ["check-sources", temp]), "hap-ok");
    assert.equal(bridge.runDocumentBridge("read", {project_root:temp}).ok, true);
    assert.equal(calls[0].options.timeout, 777);
    assert.equal(calls[0].options.killSignal, "SIGTERM");
    assert.equal(calls[1].options.input, JSON.stringify({project_root:temp}));
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});

test("python bridge turns spawn, signal, and malformed JSON failures into stable errors", () => {
  const temp = fixture();
  try {
    let mode = "spawn";
    const bridge = createPythonBridge({
      root: temp,
      spawnSync() {
        if (mode === "spawn") return {error:Object.assign(new Error("timed out"), {code:"ETIMEDOUT"})};
        if (mode === "signal") return {status:null,signal:"SIGTERM",stdout:"",stderr:""};
        return {status:0,signal:null,stdout:"not-json",stderr:""};
      },
    });
    assert.throws(() => bridge.runHap(temp, []), /E_BRIDGE_SPAWN:ETIMEDOUT/);
    mode = "signal";
    assert.throws(() => bridge.runHap(temp, []), /E_BRIDGE_SIGNAL:SIGTERM/);
    mode = "json";
    assert.throws(() => bridge.runDocumentBridge("read", {}), /E_DOCUMENT_BRIDGE_RESPONSE_INVALID/);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
