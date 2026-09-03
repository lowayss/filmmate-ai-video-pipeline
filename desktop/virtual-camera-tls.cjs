const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

function uniqueAddresses(addresses = []) {
  return [...new Set(["127.0.0.1", ...addresses.map(String).filter(Boolean)])].sort();
}

function serverConfig(addresses = []) {
  const ips = uniqueAddresses(addresses);
  return [
    "[req]",
    "distinguished_name=dn",
    "prompt=no",
    "req_extensions=req_ext",
    "[dn]",
    "CN=FilmMate VCAM",
    "[req_ext]",
    "subjectAltName=@alt_names",
    "[alt_names]",
    "DNS.1=localhost",
    ...ips.map((address, index) => `IP.${index + 1}=${address}`),
    "",
  ].join("\n");
}

function commandRunner(execFileSync = childProcess.execFileSync) {
  return (args, options = {}) => execFileSync("openssl", args, {stdio:"pipe", ...options});
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function certFingerprint(run, certFile) {
  try {
    return String(run(["x509", "-in", certFile, "-noout", "-fingerprint", "-sha256"])).trim().replace(/^sha256 Fingerprint=/i, "");
  } catch {
    return sha256File(certFile).match(/.{1,2}/g).join(":").toUpperCase();
  }
}

function ensureTlsMaterial({root, addresses = [], execFileSync} = {}) {
  if (!root) throw new Error("virtual_camera_tls_root_required");
  fs.mkdirSync(root, {recursive:true});
  const run = commandRunner(execFileSync);
  const caKey = path.join(root, "ca-key.pem");
  const caCert = path.join(root, "ca-cert.pem");
  const caCer = path.join(root, "FilmMate-VCAM-CA.cer");
  const serverKey = path.join(root, "server-key.pem");
  const serverCert = path.join(root, "server-cert.pem");
  const serverCsr = path.join(root, "server.csr");
  const configFile = path.join(root, "server.cnf");
  const metaFile = path.join(root, "server-meta.json");
  const normalizedAddresses = uniqueAddresses(addresses);

  if (!fs.existsSync(caKey) || !fs.existsSync(caCert)) {
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "3650", "-sha256", "-subj", "/CN=FilmMate VCAM Local CA"]);
  }
  if (!fs.existsSync(caCer)) run(["x509", "-in", caCert, "-outform", "der", "-out", caCer]);

  let metadata = null;
  try { metadata = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { metadata = null; }
  const needsServerCert = !fs.existsSync(serverKey)
    || !fs.existsSync(serverCert)
    || JSON.stringify(metadata?.addresses || []) !== JSON.stringify(normalizedAddresses);

  if (needsServerCert) {
    fs.writeFileSync(configFile, serverConfig(normalizedAddresses), "utf8");
    run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-config", configFile, "-sha256"]);
    run(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "365", "-sha256", "-extensions", "req_ext", "-extfile", configFile]);
    metadata = {addresses:normalizedAddresses, generated_at:new Date().toISOString()};
    fs.writeFileSync(metaFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  try { fs.chmodSync(caKey, 0o600); fs.chmodSync(serverKey, 0o600); } catch { /* best effort */ }
  return {
    available:true,
    root,
    ca_key:caKey,
    ca_cert:caCert,
    ca_cer:caCer,
    server_key:serverKey,
    server_cert:serverCert,
    fingerprint_sha256:certFingerprint(run, caCert),
    addresses:normalizedAddresses,
    generated_at:metadata?.generated_at || null,
  };
}

function tryEnsureTlsMaterial(options = {}) {
  try { return ensureTlsMaterial(options); }
  catch (error) {
    return {available:false,error:error?.message || String(error),root:options.root || null};
  }
}

module.exports = {uniqueAddresses, serverConfig, ensureTlsMaterial, tryEnsureTlsMaterial};
