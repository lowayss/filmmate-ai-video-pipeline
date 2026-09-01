#!/usr/bin/env python3
"""Canonical FilmMate prompt queue backed by HAP SQLite and CAS."""
from __future__ import annotations

import argparse
import json
import secrets
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from core import hap_core, prompt_ir, micro_shot

SCHEMA_VERSION = 3
ALLOWED_TRANSITIONS = {
    "QUEUED": {"CLAIMED", "CANCELLED", "FAILED", "STALE"},
    "CLAIMED": {"WRITING", "VALIDATING", "CANCELLED", "FAILED", "STALE"},
    "WRITING": {"VALIDATING", "CANCELLED", "FAILED", "STALE"},
    "VALIDATING": {"READY", "REJECTED", "FAILED", "STALE"},
    "REJECTED": {"CLAIMED", "VALIDATING", "CANCELLED", "FAILED", "STALE"},
    "FAILED": {"CLAIMED", "CANCELLED", "STALE"},
    "READY": {"USER_APPROVED", "STALE"},
    "USER_APPROVED": {"UPLOAD_READY", "STALE"},
    "UPLOAD_READY": {"STALE"},
    "CANCELLED": set(),
    "STALE": set(),
}

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")

def _row(row):
    return dict(row) if row is not None else None

def _load_json_artifact(root, db, revision_id, kind):
    artifact = db.execute(
        "SELECT * FROM artifacts WHERE revision_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
        (revision_id, kind),
    ).fetchone()
    if not artifact:
        raise ValueError(f"missing_artifact:{kind}")
    path = (root / artifact["relpath"]).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("artifact_path_escape") from exc
    if not path.is_file() or hap_core.digest(path) != artifact["sha256"]:
        raise ValueError(f"artifact_hash_invalid:{kind}")
    return json.loads(path.read_text(encoding="utf-8"))

def _project_entity(db):
    entity = db.execute("SELECT * FROM entities WHERE entity_type='project' ORDER BY created_at LIMIT 1").fetchone()
    if not entity:
        raise ValueError("project entity not found")
    return entity

def _scene_entity(db, scene_key):
    candidates = db.execute(
        "SELECT * FROM entities WHERE entity_type='scene' AND (logical_key=? OR ? LIKE logical_key || '_%')",
        (scene_key, scene_key),
    ).fetchall()
    if len(candidates) != 1:
        raise ValueError("scene entity not found" if not candidates else "scene entity ambiguous")
    return candidates[0]

def _prompt_logical_key(request):
    return "|".join(str(request.get(key) or "") for key in ("scene", "model", "workflow_mode", "unit_type", "target_id"))

def _request_core(request):
    ignored = {"request_sha256", "updated_at", "created_at", "expected_revision_id", "idempotency_key"}
    return {key: value for key, value in request.items() if key not in ignored}

def _validate_request(request):
    for key in ("project", "scene", "model", "unit_type", "target_id", "source_prompt", "skill_provenance"):
        if not request.get(key):
            raise ValueError(f"E_PROMPT_REQUEST_FIELD_REQUIRED:{key}")
    if request["unit_type"] not in {"shot", "block"}:
        raise ValueError("E_PROMPT_HANDOFF_UNIT_TYPE_INVALID")
    references = request.get("references")
    if not isinstance(references, list):
        raise ValueError("E_PROMPT_REFERENCES_INVALID")
    input_mode = request.get("input_mode") or ("reference_to_video" if references else "text_to_video")
    if input_mode not in {"text_to_video", "reference_to_video"}:
        raise ValueError("E_PROMPT_INPUT_MODE_INVALID")
    if input_mode == "text_to_video" and references:
        raise ValueError("E_PROMPT_INPUT_MODE_REFERENCE_MISMATCH")
    if input_mode == "reference_to_video" and not references:
        raise ValueError("E_PROMPT_ASSET_GATE:reference_mode_requires_reference")
    if request.get("workflow_mode") == micro_shot.WORKFLOW_MODE:
        micro_issues = micro_shot.micro_shot_issues(request)
        if micro_issues:
            raise ValueError("E_PROMPT_MICRO_SHOT_GATE:" + "|".join(micro_issues[:12]))
    required_roles = [str(value) for value in request.get("required_reference_roles", [])]
    if input_mode == "text_to_video" and required_roles:
        raise ValueError("E_PROMPT_INPUT_MODE_REQUIRED_ROLE_MISMATCH")
    selected_roles = {str(reference.get("role") or "") for reference in references}
    missing = [role for role in required_roles if role not in selected_roles]
    if missing:
        raise ValueError(f"E_PROMPT_ASSET_GATE:missing_roles:{','.join(missing)}")
    expected_tags = prompt_ir.expected_reference_tags(references)
    for index, reference in enumerate(references, 1):
        if reference.get("order") != index or reference.get("tag") != expected_tags[index - 1]:
            raise ValueError(f"E_PROMPT_REFERENCE_ORDER:{index}")
        if not reference.get("sha256"):
            raise ValueError(f"E_PROMPT_REFERENCE_HASH_REQUIRED:{index}")
    skill = request.get("skill_provenance") or {}
    if skill.get("name") != "seedance-prompt-rules" or skill.get("status") != "PASS" or not skill.get("bundle_sha256"):
        raise ValueError("E_PROMPT_SKILL_GATE")

def _dependencies(root, db, request, *, enforce_ready=True):
    dependencies, seen = [], set()
    currents = hap_core.current_map(db) if enforce_ready else {}
    for item in request.get("input_revisions", []):
        revision_id = str(item.get("revision_id") or "")
        role = str(item.get("role") or "input")
        if not revision_id or revision_id in seen:
            continue
        revision = db.execute("SELECT * FROM revisions WHERE revision_id=?", (revision_id,)).fetchone()
        if not revision:
            raise ValueError(f"E_PROMPT_INPUT_REVISION_NOT_FOUND:{revision_id}")
        entity = db.execute("SELECT * FROM entities WHERE entity_id=?", (revision["entity_id"],)).fetchone()
        if not entity:
            raise ValueError(f"E_PROMPT_INPUT_ENTITY_NOT_FOUND:{revision_id}")
        if enforce_ready:
            current = currents.get(entity["entity_id"])
            current_id = current["revision_id"] if current else "null"
            if current_id != revision_id:
                raise ValueError(f"E_PROMPT_INPUT_STALE:{revision_id}:{current_id}")
            payload = json.loads(revision["payload_json"] or "{}")
            if payload.get("structured_sync_required"):
                raise ValueError(f"E_PROMPT_CONTI_STRUCTURE_STALE:{revision_id}")
            derived = hap_core.derive_state(root, db, entity, revision, currents)
            if derived["state"] in {"stale", "blocked"}:
                raise ValueError(f"E_PROMPT_INPUT_NOT_READY:{revision_id}:{derived['state']}")
        dependencies.append((revision_id, role))
        seen.add(revision_id)
    return dependencies

def _event(db, job_id, from_state, to_state, actor, detail=None):
    db.execute(
        "INSERT INTO prompt_job_events(job_id,from_state,to_state,actor,detail_json,created_at) VALUES(?,?,?,?,?,?)",
        (job_id, from_state, to_state, actor, json.dumps(detail or {}, ensure_ascii=False, sort_keys=True), hap_core.now()),
    )

def _transition(db, job, to_state, actor, detail=None, **updates):
    from_state = job["state"]
    if to_state != from_state and to_state not in ALLOWED_TRANSITIONS.get(from_state, set()):
        raise ValueError(f"invalid_transition:{from_state}:{to_state}")
    fields = {"state": to_state, "updated_at": hap_core.now(), **updates}
    assignments = ",".join(f"{key}=?" for key in fields)
    db.execute(f"UPDATE prompt_jobs SET {assignments} WHERE job_id=?", (*fields.values(), job["job_id"]))
    _event(db, job["job_id"], from_state, to_state, actor, detail)
    return db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job["job_id"],)).fetchone()

def _job_payload(root, db, job):
    request = _load_json_artifact(root, db, job["request_revision_id"], "prompt_request")
    events = []
    for row in db.execute("SELECT * FROM prompt_job_events WHERE job_id=? ORDER BY event_id", (job["job_id"],)):
        event = dict(row)
        event["detail"] = json.loads(event.pop("detail_json") or "{}")
        events.append(event)
    entity = db.execute("SELECT * FROM entities WHERE entity_id=?", (job["prompt_entity_id"],)).fetchone()
    current = hap_core.current_revision(db, job["prompt_entity_id"])
    derived = hap_core.derive_state(root, db, entity, current, hap_core.current_map(db)) if current else {"state": "missing", "errors": []}
    effective_state = "STALE" if derived["state"] == "stale" else job["state"]
    output = None
    if job["output_revision_id"]:
        try:
            output = {
                "prompt_ir": _load_json_artifact(root, db, job["output_revision_id"], "prompt_ir"),
                "prompt_variants": {},
            }
            for language in prompt_ir.LANGUAGES:
                artifact = db.execute(
                    "SELECT * FROM artifacts WHERE revision_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
                    (job["output_revision_id"], f"prompt_text_{language}"),
                ).fetchone()
                if artifact:
                    file = (root / artifact["relpath"]).resolve()
                    if file.is_file() and hap_core.digest(file) == artifact["sha256"]:
                        output["prompt_variants"][language] = file.read_text(encoding="utf-8").strip()
        except (ValueError, json.JSONDecodeError):
            output = None
    return {
        "schema_version": SCHEMA_VERSION,
        "job": {**dict(job), "effective_state": effective_state},
        "request": request,
        "events": events,
        "prompt_entity": dict(entity),
        "current_revision": _row(current),
        "derived_state": derived,
        "output": output,
    }

def enqueue(project_root: Path, request, *, actor="filmmate-user"):
    root = project_root.expanduser().resolve()
    _validate_request(request)
    request_core = _request_core(request)
    request_sha256 = prompt_ir.sha_text(canonical(request_core))
    input_fingerprint = prompt_ir.sha_text(canonical({
        "request": request_core,
        "references": [
            (ref.get("order"), ref.get("tag"), ref.get("media_type"), ref.get("sha256"))
            for ref in request.get("references", [])
        ],
        "input_revisions": request.get("input_revisions", []),
    }))
    idempotency_key = f"prompt-request:{request_sha256}"
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        dependencies = _dependencies(root, db, request)
        existing = db.execute("SELECT * FROM prompt_jobs WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if existing:
            db.commit()
            return _job_payload(root, db, existing)
        project = _project_entity(db)
        scene = _scene_entity(db, request["scene"])
        prompt_entity = hap_core.ensure_entity(
            db,
            entity_type="prompt",
            logical_key=_prompt_logical_key(request),
            parent_id=scene["entity_id"],
            workflow_mode="prompt-only",
        )
        current = hap_core.current_revision(db, prompt_entity["entity_id"])
        expected = request.get("expected_revision_id")
        revision, reused = hap_core.commit_revision(
            root,
            db,
            entity_id=prompt_entity["entity_id"],
            producer="filmmate-prompt-request",
            payload={
                "kind": "prompt_request",
                "request_sha256": request_sha256,
                "input_fingerprint": input_fingerprint,
                "model": request["model"],
                "unit_type": request["unit_type"],
                "workflow_mode": request.get("workflow_mode", "scene_block"),
                "input_mode": request.get("input_mode") or ("reference_to_video" if request.get("references") else "text_to_video"),
                "target_id": request["target_id"],
            },
            source_evidence=request.get("source_evidence", []) or [{"kind": "filmmate_request", "request_sha256": request_sha256}],
            dependencies=dependencies,
            expected_revision_id=expected,
            enforce_expected="expected_revision_id" in request,
            idempotency_key=idempotency_key,
            request_sha256=request_sha256,
            actor=actor,
        )
        if reused:
            raise ValueError("idempotency_conflict")
        canonical_request = {
            **request_core,
            "schema_version": SCHEMA_VERSION,
            "request_sha256": request_sha256,
            "input_fingerprint": input_fingerprint,
            "prompt_entity_id": prompt_entity["entity_id"],
            "request_revision_id": revision["revision_id"],
            "expected_revision_id": current["revision_id"] if current else None,
            "idempotency_key": idempotency_key,
        }
        hap_core.add_artifact_bytes(
            root,
            db,
            revision_id=revision["revision_id"],
            kind="prompt_request",
            data=_json_bytes(canonical_request),
            mime="application/json",
        )
        job_id = f"promptjob_{request_sha256[:24]}"
        timestamp = hap_core.now()
        db.execute(
            "INSERT INTO prompt_jobs(job_id,project_id,prompt_entity_id,request_revision_id,output_revision_id,scene_key,model,unit_type,target_id,request_sha256,input_fingerprint,expected_revision_id,idempotency_key,state,actor,claim_actor,claim_token,attempt,max_attempts,last_error,heartbeat_at,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'QUEUED',?,NULL,NULL,0,3,NULL,NULL,?,?)",
            (
                job_id, project["entity_id"], prompt_entity["entity_id"], revision["revision_id"], None,
                request["scene"], request["model"], request["unit_type"], request["target_id"],
                request_sha256, input_fingerprint, current["revision_id"] if current else None,
                idempotency_key, actor, timestamp, timestamp,
            ),
        )
        _event(db, job_id, None, "QUEUED", actor, {"request_sha256": request_sha256})
        db.commit()
        hap_core.write_projection(root, db)
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def latest(project_root: Path, *, scene, model, unit_type, target_id):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    job = db.execute(
        "SELECT * FROM prompt_jobs WHERE scene_key=? AND model=? AND unit_type=? AND target_id=? ORDER BY updated_at DESC LIMIT 1",
        (scene, model, unit_type, target_id),
    ).fetchone()
    if not job:
        db.close()
        raise ValueError("E_PROMPT_JOB_NOT_FOUND")
    payload = _job_payload(root, db, job)
    db.close()
    return payload

def by_id(project_root: Path, job_id):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
    if not job:
        db.close()
        raise ValueError("E_PROMPT_JOB_NOT_FOUND")
    payload = _job_payload(root, db, job)
    db.close()
    return payload

def claim(project_root: Path, job_id, *, actor="codex"):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job:
            raise ValueError("E_PROMPT_JOB_NOT_FOUND")
        if job["state"] not in {"QUEUED", "REJECTED", "FAILED"}:
            if job["state"] in {"CLAIMED", "WRITING"} and job["claim_actor"] == actor:
                db.commit()
                return _job_payload(root, db, job)
            raise ValueError(f"invalid_transition:{job['state']}:CLAIMED")
        if job["attempt"] >= job["max_attempts"]:
            raise ValueError("E_PROMPT_JOB_RETRY_EXHAUSTED")
        token = secrets.token_urlsafe(24)
        job = _transition(
            db,
            job,
            "CLAIMED",
            actor,
            {"attempt": job["attempt"] + 1},
            claim_actor=actor,
            claim_token=token,
            attempt=job["attempt"] + 1,
            heartbeat_at=hap_core.now(),
            last_error=None,
        )
        db.commit()
        hap_core.write_projection(root, db)
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def heartbeat(project_root: Path, job_id, claim_token, *, actor="codex-worker", state="WRITING", detail=None):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job or job["claim_token"] != claim_token:
            raise ValueError("E_PROMPT_JOB_CLAIM_INVALID")
        if state != job["state"]:
            job = _transition(db, job, state, actor, detail, heartbeat_at=hap_core.now())
        else:
            db.execute("UPDATE prompt_jobs SET heartbeat_at=?,updated_at=? WHERE job_id=?", (hap_core.now(), hap_core.now(), job_id))
            _event(db, job_id, state, state, actor, detail or {"heartbeat": True})
            job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        db.commit()
        hap_core.write_projection(root, db)
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def submit(project_root: Path, job_id, payload, *, actor="codex"):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job:
            raise ValueError("E_PROMPT_JOB_NOT_FOUND")
        claim_token = str(payload.get("claim_token") or "")
        if job["claim_token"] and claim_token != job["claim_token"]:
            raise ValueError("E_PROMPT_JOB_CLAIM_INVALID")
        request = _load_json_artifact(root, db, job["request_revision_id"], "prompt_request")
        if payload.get("request_sha256") != job["request_sha256"]:
            raise ValueError("E_PROMPT_HANDOFF_REQUEST_STALE")
        if payload.get("skill_bundle_sha256") != request.get("skill_provenance", {}).get("bundle_sha256"):
            raise ValueError("E_PROMPT_HANDOFF_SKILL_STALE")
        # Re-check immediately before accepting Codex output. Upstream scene or
        # conhap revisions may have changed while the worker was writing.
        dependencies = _dependencies(root, db, request)
        if job["state"] not in {"CLAIMED", "WRITING", "REJECTED"}:
            raise ValueError(f"invalid_transition:{job['state']}:VALIDATING")
        job = _transition(db, job, "VALIDATING", actor, {"engine": payload.get("engine")}, heartbeat_at=hap_core.now())
        ir = payload.get("prompt_ir") if isinstance(payload.get("prompt_ir"), dict) else {}
        variants = payload.get("prompt_variants") if isinstance(payload.get("prompt_variants"), dict) else {}
        qa = prompt_ir.validate_prompt_bundle(request, ir, variants)
        current = hap_core.current_revision(db, job["prompt_entity_id"])
        bundle_key = f"prompt-bundle:{job_id}:{qa['bundle_sha256']}"
        revision, reused = hap_core.commit_revision(
            root,
            db,
            entity_id=job["prompt_entity_id"],
            producer="codex-seedance-prompt-bundle",
            payload={
                "kind": "prompt_bundle",
                "job_id": job_id,
                "request_revision_id": job["request_revision_id"],
                "request_sha256": job["request_sha256"],
                "bundle_sha256": qa["bundle_sha256"],
                "ir_sha256": qa["ir_sha256"],
                "prompt_sha256": qa["prompt_sha256"],
                "qa_status": qa["status"],
                "engine": payload.get("engine") or "Codex",
            },
            source_evidence=[
                {"kind": "prompt_request_revision", "revision_id": job["request_revision_id"]},
                {"kind": "codex_output", "actor": actor, "engine": payload.get("engine") or "Codex"},
                {"kind": "seedance_skill", "bundle_sha256": payload.get("skill_bundle_sha256")},
            ],
            dependencies=dependencies,
            expected_revision_id=current["revision_id"] if current else None,
            enforce_expected=True,
            idempotency_key=bundle_key,
            request_sha256=qa["bundle_sha256"],
            actor=actor,
        )
        if not reused:
            hap_core.add_artifact_bytes(root, db, revision_id=revision["revision_id"], kind="prompt_request", data=_json_bytes(request), mime="application/json")
            hap_core.add_artifact_bytes(root, db, revision_id=revision["revision_id"], kind="prompt_ir", data=_json_bytes(ir), mime="application/json")
            for language in prompt_ir.LANGUAGES:
                hap_core.add_artifact_bytes(
                    root,
                    db,
                    revision_id=revision["revision_id"],
                    kind=f"prompt_text_{language}",
                    data=(str(variants.get(language) or "").rstrip() + "\n").encode("utf-8"),
                    mime="text/plain; charset=utf-8",
                )
            hap_core.add_artifact_bytes(root, db, revision_id=revision["revision_id"], kind="prompt_qa_report", data=_json_bytes(qa), mime="application/json")
            hap_core.add_qa_bytes(
                root,
                db,
                revision_id=revision["revision_id"],
                status="pass" if qa["status"] == "PASS" else "fail",
                method="filmmate-prompt-ir-v3",
                checks=qa["checks"],
                report_data=_json_bytes(qa),
            )
        target_state = "READY" if qa["status"] == "PASS" else "REJECTED"
        job = _transition(
            db,
            job,
            target_state,
            actor,
            {"qa_status": qa["status"], "issues": qa["issues"][:50], "output_revision_id": revision["revision_id"]},
            output_revision_id=revision["revision_id"],
            last_error=None if qa["status"] == "PASS" else "|".join(qa["issues"][:12]),
            heartbeat_at=hap_core.now(),
        )
        db.commit()
        hap_core.write_projection(root, db)
        result = _job_payload(root, db, job)
        result["qa"] = qa
        if qa["status"] != "PASS":
            result["error"] = f"E_PROMPT_HANDOFF_QA_FAILED:{'|'.join(qa['issues'][:12])}"
        return result
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def fail(project_root: Path, job_id, error, *, actor="codex-worker"):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job:
            raise ValueError("E_PROMPT_JOB_NOT_FOUND")
        job = _transition(db, job, "FAILED", actor, {"error": str(error)}, last_error=str(error), heartbeat_at=hap_core.now())
        db.commit()
        hap_core.write_projection(root, db)
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def cancel(project_root: Path, job_id, *, actor="filmmate-user"):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job:
            raise ValueError("E_PROMPT_JOB_NOT_FOUND")
        job = _transition(db, job, "CANCELLED", actor, {"reason": "user_cancelled"})
        db.commit()
        hap_core.write_projection(root, db)
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def approve(project_root: Path, job_id, *, approver="user", evidence="FilmMate UI explicit approval"):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    db.execute("BEGIN IMMEDIATE")
    try:
        job = db.execute("SELECT * FROM prompt_jobs WHERE job_id=?", (job_id,)).fetchone()
        if not job or job["state"] != "READY" or not job["output_revision_id"]:
            raise ValueError("approval_required:prompt_not_ready")
        revision = db.execute("SELECT * FROM revisions WHERE revision_id=?", (job["output_revision_id"],)).fetchone()
        entity = db.execute("SELECT * FROM entities WHERE entity_id=?", (job["prompt_entity_id"],)).fetchone()
        state = hap_core.derive_state(root, db, entity, revision, hap_core.current_map(db))
        if state["state"] != "verified":
            raise ValueError(f"approval_required:{state['state']}:{'|'.join(state['errors'])}")
        approval_id = hap_core.new_id("approval", revision["revision_id"])
        db.execute(
            "INSERT INTO approvals VALUES(?,?,?,?,?,?,?)",
            (approval_id, revision["revision_id"], "accept", "user", approver, evidence, hap_core.now()),
        )
        job = _transition(db, job, "USER_APPROVED", approver, {"approval_id": approval_id, "evidence": evidence})
        db.commit()
        hap_core.write_projection(root, db)
        return _job_payload(root, db, job)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def history(project_root: Path, *, scene=None, limit=50):
    root = project_root.expanduser().resolve()
    db = hap_core.connect(root)
    query = "SELECT * FROM prompt_jobs"
    values = []
    if scene:
        query += " WHERE scene_key=?"
        values.append(scene)
    query += " ORDER BY updated_at DESC LIMIT ?"
    values.append(max(1, min(int(limit), 200)))
    jobs = [_job_payload(root, db, row) for row in db.execute(query, values)]
    db.close()
    return {"schema_version": SCHEMA_VERSION, "jobs": jobs}

def _stdin_json():
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}

def main():
    parser = argparse.ArgumentParser(description="FilmMate HAP prompt job queue")
    parser.add_argument("action", choices=("enqueue", "latest", "get", "claim", "heartbeat", "submit", "fail", "cancel", "approve", "history"))
    parser.add_argument("project")
    args = parser.parse_args()
    payload = _stdin_json()
    root = Path(args.project)
    if args.action == "enqueue":
        result = enqueue(root, payload.get("request", payload), actor=payload.get("actor", "filmmate-user"))
    elif args.action == "latest":
        result = latest(root, scene=payload["scene"], model=payload["model"], unit_type=payload["unit_type"], target_id=payload["target_id"])
    elif args.action == "get":
        result = by_id(root, payload["job_id"])
    elif args.action == "claim":
        result = claim(root, payload["job_id"], actor=payload.get("actor", "codex"))
    elif args.action == "heartbeat":
        result = heartbeat(root, payload["job_id"], payload["claim_token"], actor=payload.get("actor", "codex-worker"), state=payload.get("state", "WRITING"), detail=payload.get("detail"))
    elif args.action == "submit":
        result = submit(root, payload["job_id"], payload, actor=payload.get("actor", "codex"))
    elif args.action == "fail":
        result = fail(root, payload["job_id"], payload.get("error", "unknown worker error"), actor=payload.get("actor", "codex-worker"))
    elif args.action == "cancel":
        result = cancel(root, payload["job_id"], actor=payload.get("actor", "filmmate-user"))
    elif args.action == "approve":
        result = approve(root, payload["job_id"], approver=payload.get("approver", "user"), evidence=payload.get("evidence", "FilmMate UI explicit approval"))
    else:
        result = history(root, scene=payload.get("scene"), limit=payload.get("limit", 50))
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
