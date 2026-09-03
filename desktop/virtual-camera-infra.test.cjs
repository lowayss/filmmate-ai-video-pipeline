const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {qrMatrix, qrSvg} = require("./virtual-camera-qr.cjs");
const {serverConfig, ensureTlsMaterial} = require("./virtual-camera-tls.cjs");

test("offline QR encoder creates a fixed version-4 matrix", () => {
  const value = "https://192.168.0.123:54321/?token=abc";
  const matrix = qrMatrix(value);
  assert.equal(matrix.length, 33);
  assert.equal(matrix.every(row => row.length === 33), true);
  const svg = qrSvg(value);
  assert.match(svg, /^<svg/);
  assert.match(svg, /<rect/);
});

test("QR encoder rejects payloads beyond local pairing capacity", () => {
  assert.throws(() => qrMatrix("x".repeat(79)), /qr_payload_too_long/);
});

test("TLS config contains localhost and private IP SANs", () => {
  const config = serverConfig(["192.168.0.44", "10.0.0.7"]);
  assert.match(config, /DNS\.1=localhost/);
  assert.match(config, /IP\.\d+=192\.168\.0\.44/);
  assert.match(config, /IP\.\d+=10\.0\.0\.7/);
  assert.match(config, /IP\.\d+=127\.0\.0\.1/);
});

test("TLS material orchestration is testable without invoking the real openssl binary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "filmmate-vcam-tls-"));
  const fakeExec = (_command, args) => {
    const valueAfter = flag => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : null;
    };
    for (const flag of ["-keyout", "-out"]) {
      const target = valueAfter(flag);
      if (target) fs.writeFileSync(target, `fake ${path.basename(target)}\n`, "utf8");
    }
    if (args.includes("-fingerprint")) return Buffer.from("sha256 Fingerprint=AA:BB:CC\n");
    return Buffer.from("");
  };
  try {
    const material = ensureTlsMaterial({root, addresses:["192.168.0.44"], execFileSync:fakeExec});
    assert.equal(material.available, true);
    assert.equal(material.fingerprint_sha256, "AA:BB:CC");
    assert.equal(fs.existsSync(material.ca_cer), true);
    assert.equal(fs.existsSync(material.server_cert), true);
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
});
