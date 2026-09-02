const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {PassThrough} = require("node:stream");
const test = require("node:test");

const {createPythonBridge} = require("./python-bridge.cjs");

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "filmmate-bridge-"));
  fs.mkdirSync(path.join(temp, "core"), {recursive:true});
  fs.writeFileSync(path.join(temp, "core", "hap_core.py"), "# hap\n");
  fs.writeFileSync(path.join(temp, "core", "filmmate_documents.py"), "# docs\n");
  return temp;
}

function fakeChild({stdout="", stderr="", status=0, signal=null, close=true} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  if (close) {
    process.nextTick(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", status, signal);
    });
  }
  return child;
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

test("async bridge parses HAP and document results without blocking spawnSync", async () => {
  const temp = fixture();
  const calls = [];
  try {
    const bridge = createPythonBridge({
      root: temp,
      timeoutMs: 250,
      spawn(executable, args, options) {
        calls.push({executable,args,options});
        if (args[0].endsWith("filmmate_documents.py")) {
          return fakeChild({stdout:'{"ok":true,"documents":{"screenplay":{}}}'});
        }
        return fakeChild({stdout:"hap-async\n"});
      },
    });
    assert.equal(await bridge.runHapAsync(temp, ["check-sources", temp]), "hap-async");
    const docs = await bridge.runDocumentBridgeAsync("read", {project_root:temp});
    assert.equal(docs.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].options.stdio, ["pipe","pipe","pipe"]);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});

test("async bridge enforces timeout and output buffer limits", async () => {
  const temp = fixture();
  try {
    const timeoutBridge = createPythonBridge({
      root: temp,
      timeoutMs: 20,
      spawn() { return fakeChild({close:false}); },
    });
    await assert.rejects(() => timeoutBridge.runHapAsync(temp, []), /E_BRIDGE_TIMEOUT:20/);

    const bufferBridge = createPythonBridge({
      root: temp,
      maxBuffer: 4,
      spawn() { return fakeChild({stdout:"12345"}); },
    });
    await assert.rejects(() => bufferBridge.runHapAsync(temp, []), /E_BRIDGE_MAX_BUFFER:4/);
  } finally {
    fs.rmSync(temp, {recursive:true, force:true});
  }
});
