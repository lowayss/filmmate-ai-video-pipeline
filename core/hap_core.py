#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import sqlite3
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 3
CREATIVE_TYPES = {"scene", "beat", "cut", "block", "asset", "prompt", "package", "generation", "delivery"}
ENTITY_TYPES = {"project", *CREATIVE_TYPES}
APPROVER_TYPES = {"user", "delegated_user_policy"}

DEFAULT_CONTRACTS = {
    "project": {},
    "scene": {"required_artifacts": {"screenplay": 1}, "qa_required": True},
    "beat": {"required_artifacts": {"beat_record": 1}, "qa_required": True},
    "cut": {"required_artifacts": {"shot_record": 1}, "qa_required": True},
    "block": {"required_artifacts": {"block_manifest": 1}, "qa_required": True},
    "asset": {"required_artifacts": {"asset_image": 1, "asset_record": 1}, "qa_required": True},
    "prompt": {
        "required_artifacts": {
            "prompt_request": 1,
            "prompt_ir": 1,
            "prompt_text_ko": 1,
            "prompt_text_en": 1,
            "prompt_text_zh": 1,
            "prompt_qa_report": 1,
        },
        "qa_required": True,
    },
    "package": {"required_artifacts": {"prompt_text": 1, "package_manifest": 1, "reference_package": 1}, "qa_required": True},
    "generation": {"required_artifacts": {"generated_media": 1, "generation_log": 1}, "qa_required": True},
    "delivery": {"required_artifacts": {"delivery_media": 1, "delivery_report": 1}, "qa_required": True},
}

DDL = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities(
  entity_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, logical_key TEXT NOT NULL,
  parent_id TEXT REFERENCES entities(entity_id), workflow_mode TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL, UNIQUE(parent_id, entity_type, logical_key)
);
CREATE TABLE IF NOT EXISTS revisions(
  revision_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  rev_no INTEGER NOT NULL, producer TEXT NOT NULL, payload_json TEXT NOT NULL,
  source_evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(entity_id, rev_no)
);
CREATE TABLE IF NOT EXISTS dependencies(
  downstream_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  upstream_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  role TEXT NOT NULL, PRIMARY KEY(downstream_revision_id, upstream_revision_id, role)
);
CREATE TABLE IF NOT EXISTS artifacts(
  artifact_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  kind TEXT NOT NULL, relpath TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  mime TEXT NOT NULL, preview_relpath TEXT, created_at TEXT NOT NULL,
  UNIQUE(revision_id, kind, relpath)
);
CREATE TABLE IF NOT EXISTS qa_runs(
  qa_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  status TEXT NOT NULL, method TEXT NOT NULL, checks_json TEXT NOT NULL,
  artifact_snapshot_json TEXT NOT NULL, report_relpath TEXT NOT NULL,
  report_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals(
  approval_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  decision TEXT NOT NULL, approver_type TEXT NOT NULL, approver TEXT NOT NULL,
  evidence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blockers(
  blocker_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  code TEXT NOT NULL, reason TEXT NOT NULL, resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_links(
  source_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(entity_id),
  label TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'missing',
  fingerprint TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);
CREATE TABLE IF NOT EXISTS mutation_keys(
  idempotency_key TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  request_sha256 TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_jobs(
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(entity_id),
  prompt_entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  request_revision_id TEXT NOT NULL REFERENCES revisions(revision_id),
  output_revision_id TEXT REFERENCES revisions(revision_id),
  scene_key TEXT NOT NULL,
  model TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  expected_revision_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  actor TEXT NOT NULL,
  claim_actor TEXT,
  claim_token TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_job_events(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES prompt_jobs(job_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rev_entity ON revisions(entity_id, rev_no DESC);
CREATE INDEX IF NOT EXISTS idx_dep_upstream ON dependencies(upstream_revision_id);
CREATE INDEX IF NOT EXISTS idx_art_revision ON artifacts(revision_id);
CREATE INDEX IF NOT EXISTS idx_source_project ON source_links(project_id);
CREATE INDEX IF NOT EXISTS idx_prompt_job_context ON prompt_jobs(scene_key, model, unit_type, target_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prompt_job_state ON prompt_jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_prompt_job_events ON prompt_job_events(job_id, event_id);
"""

def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def project_root(value: str) -> Path:
    return Path(value).expanduser().resolve()

def db_path(root: Path) -> Path:
    return root / ".hap" / "hap.sqlite3"

def connect(root: Path) -> sqlite3.Connection:
    path = db_path(root)
    if not path.is_file():
        raise SystemExit(f"HAP project is not initialized: {path}")
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    # Existing HAP v2 projects receive additive tables without rewriting their
    # canonical data or projections.
    db.executescript(DDL)
    db.execute(
        "INSERT INTO meta(key,value) VALUES('schema_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    db.commit()
    return db

def new_id(prefix: str, seed: str) -> str:
    token = hashlib.sha256(f"{prefix}|{seed}|{now()}".encode()).hexdigest()[:16]
    return f"{prefix}_{token}"

def current_revision(db: sqlite3.Connection, entity_id: str):
    return db.execute("SELECT * FROM revisions WHERE entity_id=? ORDER BY rev_no DESC LIMIT 1", (entity_id,)).fetchone()

def row_dict(row):
    return dict(row) if row is not None else None

def artifact_rows(db, revision_id):
    return db.execute("SELECT * FROM artifacts WHERE revision_id=? ORDER BY kind, artifact_id", (revision_id,)).fetchall()

def current_map(db):
    return {row["entity_id"]: row for row in db.execute("SELECT r.* FROM revisions r JOIN (SELECT entity_id, MAX(rev_no) n FROM revisions GROUP BY entity_id) x ON x.entity_id=r.entity_id AND x.n=r.rev_no")}

def dependency_details(db, revision_id, currents):
    rows = db.execute(
        "SELECT d.upstream_revision_id,d.role,r.entity_id,e.entity_type,e.logical_key,r.rev_no "
        "FROM dependencies d "
        "JOIN revisions r ON r.revision_id=d.upstream_revision_id "
        "JOIN entities e ON e.entity_id=r.entity_id "
        "WHERE d.downstream_revision_id=? "
        "ORDER BY d.role,e.entity_type,e.logical_key,d.upstream_revision_id",
        (revision_id,),
    ).fetchall()
    details = []
    for row in rows:
        current = currents.get(row["entity_id"])
        current_revision_id = current["revision_id"] if current is not None else None
        details.append({
            "role": row["role"],
            "upstream_entity_id": row["entity_id"],
            "upstream_entity_type": row["entity_type"],
            "upstream_logical_key": row["logical_key"],
            "used_revision_id": row["upstream_revision_id"],
            "used_rev_no": row["rev_no"],
            "current_revision_id": current_revision_id,
            "current_rev_no": current["rev_no"] if current is not None else None,
            "stale": current_revision_id != row["upstream_revision_id"],
        })
    return details

def dependency_stale(db, revision_id, currents):
    return any(item["stale"] for item in dependency_details(db, revision_id, currents))

def artifact_errors(root, db, revision_id):
    errors = []
    for art in artifact_rows(db, revision_id):
        path = (root / art["relpath"]).resolve()
        try: path.relative_to(root)
        except ValueError:
            errors.append(f"{art['artifact_id']}: path escapes project"); continue
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"{art['artifact_id']}: missing or empty")
        elif path.stat().st_size != art["size"] or digest(path) != art["sha256"]:
            errors.append(f"{art['artifact_id']}: content hash changed")
        if art["preview_relpath"]:
            preview = root / art["preview_relpath"]
            if not preview.is_file() or preview.stat().st_size == 0:
                errors.append(f"{art['artifact_id']}: preview missing")
    return errors

def store_object(root: Path, source: Path) -> tuple[str, Path]:
    checksum = digest(source)
    target = root / ".hap" / "objects" / "sha256" / checksum[:2] / checksum
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        fd, temp = tempfile.mkstemp(dir=target.parent, prefix="object.", suffix=".tmp")
        os.close(fd)
        try:
            shutil.copyfile(source, temp)
            if digest(Path(temp)) != checksum:
                raise SystemExit("CAS copy hash mismatch")
            os.replace(temp, target)
        finally:
            if os.path.exists(temp): os.unlink(temp)
    elif digest(target) != checksum:
        raise SystemExit(f"CAS corruption detected: {target}")
    return checksum, target

def store_bytes(root: Path, data: bytes) -> tuple[str, Path]:
    """Store bytes in the HAP CAS without exposing a mutable staging file."""
    if not data:
        raise ValueError("artifact missing or empty")
    checksum = hashlib.sha256(data).hexdigest()
    target = root / ".hap" / "objects" / "sha256" / checksum[:2] / checksum
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        fd, temp = tempfile.mkstemp(dir=target.parent, prefix="object.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            if digest(Path(temp)) != checksum:
                raise ValueError("CAS copy hash mismatch")
            os.replace(temp, target)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    elif digest(target) != checksum:
        raise ValueError(f"CAS corruption detected: {target}")
    return checksum, target

def ensure_entity(db, *, entity_type, logical_key, parent_id, entity_id=None, workflow_mode="full"):
    if entity_type not in ENTITY_TYPES:
        raise ValueError("invalid entity type")
    if parent_id and not db.execute("SELECT 1 FROM entities WHERE entity_id=?", (parent_id,)).fetchone():
        raise ValueError("parent entity not found")
    existing = db.execute(
        "SELECT * FROM entities WHERE parent_id IS ? AND entity_type=? AND logical_key=?",
        (parent_id, entity_type, logical_key),
    ).fetchone()
    if existing:
        return existing
    entity_id = entity_id or f"{entity_type}:{hashlib.sha256(f'{parent_id}|{logical_key}'.encode()).hexdigest()[:20]}"
    db.execute(
        "INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)",
        (entity_id, entity_type, logical_key, parent_id, workflow_mode, now()),
    )
    return db.execute("SELECT * FROM entities WHERE entity_id=?", (entity_id,)).fetchone()

def commit_revision(
    root,
    db,
    *,
    entity_id,
    producer,
    payload,
    source_evidence,
    dependencies=(),
    expected_revision_id=None,
    enforce_expected=False,
    idempotency_key=None,
    request_sha256=None,
    actor="system",
):
    """Create one immutable revision with optimistic concurrency and idempotency."""
    entity = db.execute("SELECT * FROM entities WHERE entity_id=?", (entity_id,)).fetchone()
    if not entity:
        raise ValueError("entity not found")
    if entity["entity_type"] in CREATIVE_TYPES and not source_evidence:
        raise ValueError("creative revision requires source evidence")
    if idempotency_key:
        prior = db.execute("SELECT * FROM mutation_keys WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if prior:
            if prior["entity_id"] != entity_id or prior["request_sha256"] != str(request_sha256 or ""):
                raise ValueError("idempotency_conflict")
            return db.execute("SELECT * FROM revisions WHERE revision_id=?", (prior["revision_id"],)).fetchone(), True
    current = current_revision(db, entity_id)
    current_id = current["revision_id"] if current else None
    if enforce_expected and current_id != expected_revision_id:
        raise ValueError(f"revision_conflict:{expected_revision_id or 'null'}:{current_id or 'null'}")
    rev_no = (current["rev_no"] + 1) if current else 1
    revision_id = f"{entity_id}@{rev_no}"
    db.execute(
        "INSERT INTO revisions VALUES(?,?,?,?,?,?,?)",
        (
            revision_id,
            entity_id,
            rev_no,
            producer,
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            json.dumps(source_evidence, ensure_ascii=False, sort_keys=True),
            now(),
        ),
    )
    for upstream_revision_id, role in dependencies:
        if not db.execute("SELECT 1 FROM revisions WHERE revision_id=?", (upstream_revision_id,)).fetchone():
            raise ValueError(f"dependency not found: {upstream_revision_id}")
        db.execute(
            "INSERT INTO dependencies(downstream_revision_id,upstream_revision_id,role) VALUES(?,?,?)",
            (revision_id, upstream_revision_id, role or "input"),
        )
    if idempotency_key:
        db.execute(
            "INSERT INTO mutation_keys VALUES(?,?,?,?,?,?)",
            (idempotency_key, entity_id, str(request_sha256 or ""), revision_id, actor, now()),
        )
    return db.execute("SELECT * FROM revisions WHERE revision_id=?", (revision_id,)).fetchone(), False

def add_artifact_bytes(root, db, *, revision_id, kind, data, mime="application/octet-stream", artifact_id=None):
    if not db.execute("SELECT 1 FROM revisions WHERE revision_id=?", (revision_id,)).fetchone():
        raise ValueError("revision not found")
    checksum, stored = store_bytes(root, data)
    rel = str(stored.relative_to(root))
    artifact_id = artifact_id or new_id("art", f"{revision_id}|{kind}|{checksum}")
    db.execute(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)",
        (artifact_id, revision_id, kind, rel, checksum, len(data), mime, None, now()),
    )
    return db.execute("SELECT * FROM artifacts WHERE artifact_id=?", (artifact_id,)).fetchone()

def add_qa_bytes(root, db, *, revision_id, status, method, checks, report_data, qa_id=None):
    if status == "pass" and (not checks or not all(value is True for value in checks.values())):
        raise ValueError("passing QA requires every declared check=true")
    artifacts = {row["artifact_id"]: row["sha256"] for row in artifact_rows(db, revision_id)}
    if not artifacts:
        raise ValueError("QA cannot pass a revision with no artifacts")
    report_checksum, report_stored = store_bytes(root, report_data)
    qa_id = qa_id or new_id("qa", revision_id)
    db.execute(
        "INSERT INTO qa_runs VALUES(?,?,?,?,?,?,?,?,?)",
        (
            qa_id,
            revision_id,
            status,
            method,
            json.dumps(checks, ensure_ascii=False, sort_keys=True),
            json.dumps(artifacts, ensure_ascii=False, sort_keys=True),
            str(report_stored.relative_to(root)),
            report_checksum,
            now(),
        ),
    )
    return db.execute("SELECT * FROM qa_runs WHERE qa_id=?", (qa_id,)).fetchone()

def contract_errors(db, entity_type, revision_id):
    contract = DEFAULT_CONTRACTS[entity_type]
    counts = {}
    for art in artifact_rows(db, revision_id): counts[art["kind"]] = counts.get(art["kind"], 0) + 1
    return [f"requires {minimum} {kind}, found {counts.get(kind, 0)}" for kind, minimum in contract.get("required_artifacts", {}).items() if counts.get(kind, 0) < minimum]

def latest_passing_qa(root, db, revision_id):
    rows = db.execute("SELECT * FROM qa_runs WHERE revision_id=? ORDER BY created_at DESC", (revision_id,)).fetchall()
    current = {a["artifact_id"]: a["sha256"] for a in artifact_rows(db, revision_id)}
    for qa in rows:
        report = root / qa["report_relpath"]
        if qa["status"] != "pass" or not report.is_file() or digest(report) != qa["report_sha256"]:
            continue
        snapshot = json.loads(qa["artifact_snapshot_json"])
        checks = json.loads(qa["checks_json"])
        if snapshot == current and checks and all(value is True for value in checks.values()):
            return qa
    return None

def latest_approval(db, revision_id):
    return db.execute("SELECT * FROM approvals WHERE revision_id=? ORDER BY created_at DESC LIMIT 1", (revision_id,)).fetchone()

def derive_state(root, db, entity, revision, currents):
    if revision is None: return {"state": "missing", "errors": ["no revision"]}
    blockers = db.execute("SELECT code,reason FROM blockers WHERE revision_id=? AND resolved_at IS NULL", (revision["revision_id"],)).fetchall()
    if blockers: return {"state": "blocked", "errors": [f"{x['code']}: {x['reason']}" for x in blockers]}
    errors = artifact_errors(root, db, revision["revision_id"])
    stale_dependencies = [item for item in dependency_details(db, revision["revision_id"], currents) if item["stale"]]
    if stale_dependencies:
        stale_errors = [
            f"{item['role']}: {item['upstream_entity_type']} {item['upstream_logical_key']} changed "
            f"from {item['used_revision_id']} to {item['current_revision_id'] or 'missing'}"
            for item in stale_dependencies
        ]
        return {"state": "stale", "errors": [*stale_errors, *errors]}
    errors.extend(contract_errors(db, entity["entity_type"], revision["revision_id"]))
    if errors: return {"state": "working" if not artifact_rows(db, revision["revision_id"]) else "unverified", "errors": errors}
    qa = latest_passing_qa(root, db, revision["revision_id"])
    if DEFAULT_CONTRACTS[entity["entity_type"]].get("qa_required") and not qa:
        return {"state": "unverified", "errors": ["no passing QA for the current artifact hashes"]}
    approval = latest_approval(db, revision["revision_id"])
    if approval and approval["decision"] == "accept":
        return {"state": "accepted", "errors": [], "approval": row_dict(approval)}
    return {"state": "verified", "errors": []}

def write_projection(root, db):
    root = Path(root).expanduser().resolve()
    currents = current_map(db)
    entities = []
    for entity in db.execute("SELECT * FROM entities ORDER BY entity_type, logical_key"):
        revision = currents.get(entity["entity_id"])
        state = derive_state(root, db, entity, revision, currents)
        artifacts = [dict(x) for x in artifact_rows(db, revision["revision_id"])] if revision else []
        dependencies = dependency_details(db, revision["revision_id"], currents) if revision else []
        entities.append({**dict(entity), "current_revision": row_dict(revision), **state, "artifacts": artifacts, "dependencies": dependencies})
    source_links = [dict(row) for row in db.execute(
        "SELECT source_id, project_id, label, kind, path, required, status, fingerprint, metadata_json, checked_at, created_at "
        "FROM source_links ORDER BY required DESC, kind, label"
    )]
    for link in source_links:
        try:
            link["metadata"] = json.loads(link.pop("metadata_json") or "{}")
        except json.JSONDecodeError:
            link["metadata"] = {}
            link.pop("metadata_json", None)
    prompt_jobs = [dict(row) for row in db.execute(
        "SELECT job_id,prompt_entity_id,request_revision_id,output_revision_id,scene_key,model,unit_type,target_id,"
        "request_sha256,input_fingerprint,state,actor,claim_actor,attempt,max_attempts,last_error,heartbeat_at,created_at,updated_at "
        "FROM prompt_jobs ORDER BY updated_at DESC LIMIT 200"
    )]
    projection = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now(),
        "entities": entities,
        "source_links": source_links,
        "prompt_jobs": prompt_jobs,
    }
    target = root / ".hap" / "projection.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=target.parent, prefix="projection.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(projection, handle, ensure_ascii=False, indent=2); handle.write("\n")
        os.replace(temp, target)
    finally:
        if os.path.exists(temp): os.unlink(temp)
    return projection

def cmd_init(args):
    root = project_root(args.project); path = db_path(root)
    if path.exists(): raise SystemExit(f"Already initialized: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    try:
        db.row_factory = sqlite3.Row; db.executescript(DDL)
        created = now(); project_id = args.project_id or f"project:{root.name}"
        db.execute("INSERT INTO meta VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
        db.execute("INSERT INTO meta VALUES('title',?)", (args.title,))
        db.execute("INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)", (project_id,"project",root.name,None,args.mode,created))
        db.commit(); write_projection(root, db); print(project_id)
    finally:
        db.close()

def cmd_add_entity(args):
    root=project_root(args.project); db=connect(root)
    try:
        if args.entity_type not in ENTITY_TYPES: raise SystemExit("invalid entity type")
        entity_id=args.entity_id or f"{args.entity_type}:{args.key}"
        db.execute("INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)",(entity_id,args.entity_type,args.key,args.parent,args.mode,now()))
        db.commit(); write_projection(root,db); print(entity_id)
    finally:
        db.close()

def load_json_arg(value):
    path=Path(value).expanduser()
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else json.loads(value)

def cmd_commit(args):
    root=project_root(args.project); db=connect(root)
    try:
        entity=db.execute("SELECT * FROM entities WHERE entity_id=?",(args.entity,)).fetchone()
        if not entity: raise SystemExit("entity not found")
        payload=load_json_arg(args.payload); evidence=load_json_arg(args.evidence)
        if entity["entity_type"] in CREATIVE_TYPES and not evidence: raise SystemExit("creative revision requires source evidence")
        current=current_revision(db,args.entity)
        rev_no=(current["rev_no"]+1) if current else 1
        revision_id=args.revision_id or f"{args.entity}@{rev_no}"
        db.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?,?)",(revision_id,args.entity,rev_no,args.producer,json.dumps(payload,ensure_ascii=False),json.dumps(evidence,ensure_ascii=False),now()))
        for item in args.depends_on:
            upstream,_,role=item.partition(":role=")
            if not db.execute("SELECT 1 FROM revisions WHERE revision_id=?",(upstream,)).fetchone(): raise SystemExit(f"dependency not found: {upstream}")
            db.execute("INSERT INTO dependencies VALUES(?,?,?)",(revision_id,upstream,role or "input"))
        db.commit(); write_projection(root,db); print(revision_id)
    finally:
        db.close()

def cmd_artifact(args):
    root=project_root(args.project); db=connect(root); source=Path(args.file).expanduser().resolve()
    try:
        if not source.is_file() or source.stat().st_size==0: raise SystemExit("artifact missing or empty")
        if not db.execute("SELECT 1 FROM revisions WHERE revision_id=?",(args.revision,)).fetchone(): raise SystemExit("revision not found")
        checksum, stored = store_object(root, source)
        rel = str(stored.relative_to(root))
        preview=None
        if args.preview:
            p=Path(args.preview).expanduser().resolve()
            if not p.is_file() or p.stat().st_size==0: raise SystemExit("preview missing or empty")
            _, preview_stored = store_object(root, p)
            preview=str(preview_stored.relative_to(root))
        aid=args.artifact_id or new_id("art",f"{args.revision}|{args.kind}|{rel}")
        db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)",(aid,args.revision,args.kind,rel,checksum,source.stat().st_size,mimetypes.guess_type(source.name)[0] or "application/octet-stream",preview,now()))
        db.commit(); write_projection(root,db); print(aid)
    finally:
        db.close()

def cmd_qa(args):
    root=project_root(args.project); db=connect(root); report=Path(args.report).expanduser().resolve()
    try:
        try: rel=str(report.relative_to(root))
        except ValueError: raise SystemExit("QA report must be inside project")
        if not report.is_file() or report.stat().st_size==0: raise SystemExit("QA report missing")
        checks=load_json_arg(args.checks)
        if args.status=="pass" and (not checks or not all(v is True for v in checks.values())): raise SystemExit("passing QA requires every declared check=true")
        artifacts={a["artifact_id"]:a["sha256"] for a in artifact_rows(db,args.revision)}
        if not artifacts: raise SystemExit("QA cannot pass a revision with no artifacts")
        qa_id=args.qa_id or new_id("qa",args.revision)
        db.execute("INSERT INTO qa_runs VALUES(?,?,?,?,?,?,?,?,?)",(qa_id,args.revision,args.status,args.method,json.dumps(checks,ensure_ascii=False),json.dumps(artifacts,ensure_ascii=False),rel,digest(report),now()))
        db.commit(); write_projection(root,db); print(qa_id)
    finally:
        db.close()

def cmd_approve(args):
    root=project_root(args.project); db=connect(root)
    try:
        if args.approver_type not in APPROVER_TYPES: raise SystemExit("invalid approver type")
        rev=db.execute("SELECT * FROM revisions WHERE revision_id=?",(args.revision,)).fetchone()
        entity=db.execute("SELECT e.* FROM entities e JOIN revisions r ON r.entity_id=e.entity_id WHERE r.revision_id=?",(args.revision,)).fetchone()
        currents=current_map(db); state=derive_state(root,db,entity,rev,currents)
        if state["state"]!="verified": raise SystemExit(f"approval requires verified revision, got {state['state']}: {state['errors']}")
        approval_id=args.approval_id or new_id("approval",args.revision)
        db.execute("INSERT INTO approvals VALUES(?,?,?,?,?,?,?)",(approval_id,args.revision,"accept",args.approver_type,args.approver,args.evidence,now()))
        db.commit(); write_projection(root,db); print(approval_id)
    finally:
        db.close()

def cmd_status(args):
    root=project_root(args.project); db=connect(root)
    try:
        print(json.dumps(write_projection(root,db),ensure_ascii=False,indent=2))
    finally:
        db.close()

SOURCE_EXCLUDES = {".git", "node_modules", "__pycache__", ".DS_Store", ".venv"}

def source_fingerprint(value: str):
    source = Path(value).expanduser().resolve()
    if not source.exists():
        return None, {"exists": False, "file_count": 0}
    if source.is_file():
        return digest(source), {"exists": True, "file_count": 1, "path_type": "file"}
    entries = []
    for current, dirs, files in os.walk(source):
        dirs[:] = sorted(d for d in dirs if d not in SOURCE_EXCLUDES and not d.startswith("."))
        for name in sorted(files):
            if name in SOURCE_EXCLUDES or name.startswith("."):
                continue
            file = Path(current) / name
            try:
                relative = file.relative_to(source).as_posix()
                entries.append((relative, digest(file)))
            except (OSError, ValueError):
                continue
    hasher = hashlib.sha256()
    for relative, checksum in entries:
        hasher.update(relative.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(checksum.encode("ascii"))
        hasher.update(b"\n")
    return hasher.hexdigest(), {"exists": True, "file_count": len(entries), "path_type": "directory"}

def cmd_link_source(args):
    root = project_root(args.project); db = connect(root)
    project = db.execute("SELECT entity_id FROM entities WHERE entity_type='project' ORDER BY created_at LIMIT 1").fetchone()
    if not project:
        raise SystemExit("project entity not found")
    source = Path(args.path).expanduser().resolve()
    fingerprint, metadata = source_fingerprint(str(source))
    existing = db.execute("SELECT source_id FROM source_links WHERE project_id=? AND path=?", (project[0], str(source))).fetchone()
    source_id = existing[0] if existing else (args.source_id or f"source:{hashlib.sha256(str(source).encode('utf-8')).hexdigest()[:16]}")
    status = "connected" if fingerprint else "missing"
    db.execute(
        "INSERT INTO source_links(source_id, project_id, label, kind, path, required, status, fingerprint, metadata_json, checked_at, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(source_id) DO UPDATE SET label=excluded.label, kind=excluded.kind, path=excluded.path, required=excluded.required, "
        "status=excluded.status, fingerprint=excluded.fingerprint, metadata_json=excluded.metadata_json, checked_at=excluded.checked_at",
        (source_id, project[0], args.label, args.kind, str(source), int(args.required), status, fingerprint, json.dumps(metadata), now(), now()),
    )
    db.commit(); write_projection(root, db); print(source_id)

def cmd_check_sources(args):
    root = project_root(args.project); db = connect(root)
    query = "SELECT * FROM source_links"
    values = []
    if args.source_id:
        query += " WHERE source_id=?"; values.append(args.source_id)
    rows = db.execute(query, values).fetchall()
    checked = []
    for row in rows:
        fingerprint, metadata = source_fingerprint(row["path"])
        status = "connected" if fingerprint and fingerprint == row["fingerprint"] else ("changed" if fingerprint else "missing")
        db.execute("UPDATE source_links SET status=?, fingerprint=?, metadata_json=?, checked_at=? WHERE source_id=?", (status, fingerprint, json.dumps(metadata), now(), row["source_id"]))
        checked.append({"source_id": row["source_id"], "label": row["label"], "path": row["path"], "required": bool(row["required"]), "status": status, "metadata": metadata})
    db.commit(); projection = write_projection(root, db)
    print(json.dumps({"source_links": checked, "projection": projection}, ensure_ascii=False))

def parser():
    p=argparse.ArgumentParser(description="HAP v3 canonical production state"); sub=p.add_subparsers(dest="command",required=True)
    x=sub.add_parser("init"); x.add_argument("project"); x.add_argument("--title",required=True); x.add_argument("--project-id"); x.add_argument("--mode",choices=["full","asset-only","storyboard-only","prompt-only"],default="full"); x.set_defaults(fn=cmd_init)
    x=sub.add_parser("add-entity"); x.add_argument("project"); x.add_argument("--type",dest="entity_type",required=True,choices=sorted(ENTITY_TYPES)); x.add_argument("--key",required=True); x.add_argument("--entity-id"); x.add_argument("--parent"); x.add_argument("--mode",default="full"); x.set_defaults(fn=cmd_add_entity)
    x=sub.add_parser("commit"); x.add_argument("project"); x.add_argument("--entity",required=True); x.add_argument("--producer",required=True); x.add_argument("--payload",required=True); x.add_argument("--evidence",required=True); x.add_argument("--depends-on",action="append",default=[]); x.add_argument("--revision-id"); x.set_defaults(fn=cmd_commit)
    x=sub.add_parser("add-artifact"); x.add_argument("project"); x.add_argument("--revision",required=True); x.add_argument("--kind",required=True); x.add_argument("--file",required=True); x.add_argument("--preview"); x.add_argument("--artifact-id"); x.set_defaults(fn=cmd_artifact)
    x=sub.add_parser("qa"); x.add_argument("project"); x.add_argument("--revision",required=True); x.add_argument("--status",choices=["pass","fail"],required=True); x.add_argument("--method",required=True); x.add_argument("--checks",required=True); x.add_argument("--report",required=True); x.add_argument("--qa-id"); x.set_defaults(fn=cmd_qa)
    x=sub.add_parser("approve"); x.add_argument("project"); x.add_argument("--revision",required=True); x.add_argument("--approver-type",required=True,choices=sorted(APPROVER_TYPES)); x.add_argument("--approver",required=True); x.add_argument("--evidence",required=True); x.add_argument("--approval-id"); x.set_defaults(fn=cmd_approve)
    x=sub.add_parser("status"); x.add_argument("project"); x.set_defaults(fn=cmd_status)
    x=sub.add_parser("link-source"); x.add_argument("project"); x.add_argument("--path", required=True); x.add_argument("--label", required=True); x.add_argument("--kind", default="skill"); x.add_argument("--required", action="store_true"); x.add_argument("--source-id"); x.set_defaults(fn=cmd_link_source)
    x=sub.add_parser("check-sources"); x.add_argument("project"); x.add_argument("--source-id"); x.set_defaults(fn=cmd_check_sources)
    return p

if __name__=="__main__":
    args=parser().parse_args(); args.fn(args)
