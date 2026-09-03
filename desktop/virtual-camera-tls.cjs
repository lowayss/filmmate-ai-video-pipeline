const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

function uniqueAddresses(addresses = []) {
  return [...new Set(["127.0.0.1", ...addresses.map(String).filter(Boolean)])].sort();
}

function caConfig() {
  return [
    "[req]",
    "distinguished_name=dn",
    "prompt=no",
    "x509_extensions=v3_ca",
    "[dn]",
    "CN=FilmMate VCAM Local CA",
    "[v3_ca]",
    "basicConstraints=critical,CA:true,pathlen:0",
    "keyUsage=critical,keyCertSign,cRLSign",
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid:always,issuer",
    "",
  ].join("\n");
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
    "basicConstraints=critical,CA:false",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function ensureTlsMaterial({root, addresses = [], execFileSync} = {}) {
  if (!root) throw new Error("virtual_camera_tls_root_required");
  fs.mkdirSync(root, {recursive:true});
  const run = commandRunner(execFileSync);
  const caKey = path.join(root, "ca-key.pem");
  const caCert = path.join(root, "ca-cert.pem");
  const caCer = path.join(root, "FilmMate-VCAM-CA.cer");
  const caConfigFile = path.join(root, "ca.cnf");
  const caMetaFile = path.join(root, "ca-meta.json");
  const serverKey = path.join(root, "server-key.pem");
  const serverCert = path.join(root, "server-cert.pem");
  const serverCsr = path.join(root, "server.csr");
  const configFile = path.join(root, "server.cnf");
  const metaFile = path.join(root, "server-meta.json");
  const normalizedAddresses = uniqueAddresses(addresses);

  const caMetadata = readJson(caMetaFile);
  const needsCa = !fs.existsSync(caKey) || !fs.existsSync(caCert) || caMetadata?.schema_version !== 2;
  if (needsCa) {
    for (const file of [caKey, caCert, caCer, serverKey, serverCert, serverCsr, path.join(root, "ca-cert.srl")]) {
      try { fs.rmSync(file, {force:true}); } catch { /* best effort */ }
    }
    fs.writeFileSync(caConfigFile, caConfig(), "utf8");
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "3650", "-sha256", "-config", caConfigFile, "-extensions", "v3_ca"]);
    fs.writeFileSync(caMetaFile, `${JSON.stringify({schema_version:2,generated_at:new Date().toISOString()}, null, 2)}\n`, "utf8");
  }
  if (!fs.existsSync(caCer)) run(["x509", "-in", caCert, "-outform", "der", "-out", caCer]);
  const caFingerprint = certFingerprint(run, caCert);

  let metadata = readJson(metaFile);
  const needsServerCert = !fs.existsSync(serverKey)
    || !fs.existsSync(serverCert)
    || JSON.stringify(metadata?.addresses || []) !== JSON.stringify(normalizedAddresses)
    || metadata?.ca_fingerprint_sha256 !== caFingerprint;

  if (needsServerCert) {
    fs.writeFileSync(configFile, serverConfig(normalizedAddresses), "utf8");
    run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey, "-out", serverCsr, "-config", configFile, "-sha256"]);
    run(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", serverCert, "-days", "365", "-sha256", "-extensions", "req_ext", "-extfile", configFile]);
    metadata = {schema_version:2,addresses:normalizedAddresses,ca_fingerprint_sha256:caFingerprint,generated_at:new Date().toISOString()};
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
    fingerprint_sha256:caFingerprint,
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

module.exports = {uniqueAddresses, caConfig, serverConfig, ensureTlsMaterial, tryEnsureTlsMaterial};
