#!/usr/bin/env python3
"""Shared FilmMate/Codex document bridge for HAP canonical text revisions.

The HAP database and CAS remain authoritative. Mutable scene files are updated
only as compatibility projections after an immutable revision is committed.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))

from core import hap_core


DOCUMENT_KINDS = {"screenplay", "conti"}
ACTORS = {"filmmate-user", "codex"}
MAX_TEXT_BYTES = 8 * 1024 * 1024


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json(value, fallback):
    try:
        parsed = json.loads(value or "")
        return parsed
    except (TypeError, json.JSONDecodeError):
        return fallback


def _json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def _scene_dir(root: Path, scene_key: str) -> Path:
    if not scene_key or Path(scene_key).name != scene_key or scene_key in {".", ".."}:
        raise ValueError("invalid_scene_target")
    scenes_root = (root / "scenes").resolve()
    target = (scenes_root / scene_key).resolve()
    try:
        target.relative_to(scenes_root)
    except ValueError as exc:
        raise ValueError("invalid_scene_target") from exc
    if not target.is_dir():
        raise ValueError("scene_not_found")
    return target


def _scene_manifest(scene_dir: Path) -> dict:
    path = scene_dir / "scene-data" / "scene-manifest.json"
    if not path.is_file():
        raise ValueError("scene_manifest_not_found")
    return json.loads(path.read_text(encoding="utf-8"))


def _scene_entity(db: sqlite3.Connection, scene_dir: Path):
    manifest = _scene_manifest(scene_dir)
    scene_id = manifest.get("scene_id") or scene_dir.name.split("_", 1)[0]
    row = db.execute(
        "SELECT * FROM entities WHERE entity_type='scene' AND logical_key IN (?,?) "
        "ORDER BY CASE WHEN logical_key=? THEN 0 ELSE 1 END LIMIT 1",
        (scene_id, scene_dir.name, scene_id),
    ).fetchone()
    if row is None:
        raise ValueError("scene_entity_not_found")
    return row, manifest


def _current_artifact(db: sqlite3.Connection, revision_id: str | None, kind: str):
    if not revision_id:
        return None
    return db.execute(
        "SELECT * FROM artifacts WHERE revision_id=? AND kind=? ORDER BY created_at DESC LIMIT 1",
        (revision_id, kind),
    ).fetchone()


def _artifact_bytes(root: Path, artifact) -> bytes:
    target = (root / artifact["relpath"]).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("artifact_path_escape") from exc
    data = target.read_bytes()
    if len(data) != artifact["size"] or _sha256(data) != artifact["sha256"]:
        raise ValueError(f"artifact_hash_mismatch:{artifact['artifact_id']}")
    return data


def _conhap_dir(scene_dir: Path) -> Path:
    v3 = scene_dir / "conhap-v3"
    return v3 if (v3 / "project.json").is_file() else scene_dir / "conhap"


def _conti_projection_path(scene_dir: Path) -> Path:
    conhap = _conhap_dir(scene_dir)
    candidates = (
        conhap / "text-conti-v3-full-dialogue.md",
        conhap / "text-conti-v2-draft.md",
        conhap / "text-conti.md",
    )
    return next((path for path in candidates if path.is_file()), candidates[-1])


def _projection_path(scene_dir: Path, kind: str) -> Path:
    return scene_dir / "input-screenplay.txt" if kind == "screenplay" else _conti_projection_path(scene_dir)


def _select_conti_entity(db: sqlite3.Connection, scene_entity_id: str):
    rows = db.execute(
        "SELECT e.*, r.revision_id, r.rev_no FROM entities e "
        "LEFT JOIN revisions r ON r.entity_id=e.entity_id "
        "AND r.rev_no=(SELECT MAX(r2.rev_no) FROM revisions r2 WHERE r2.entity_id=e.entity_id) "
        "WHERE e.parent_id=? AND e.entity_type='block'",
        (scene_entity_id,),
    ).fetchall()
    if not rows:
        return None

    def score(row):
        has_storyboard = bool(_current_artifact(db, row["revision_id"], "written_storyboard"))
        has_manifest = bool(_current_artifact(db, row["revision_id"], "block_manifest"))
        conhap_named = "CONHAP" in str(row["logical_key"]).upper()
        return (100 if has_storyboard else 0) + (20 if conhap_named else 0) + (10 if has_manifest else 0) + int(row["rev_no"] or 0)

    return max(rows, key=score)


def _document_record(root: Path, db: sqlite3.Connection, scene_dir: Path, kind: str) -> dict:
    scene, _ = _scene_entity(db, scene_dir)
    if kind == "screenplay":
        entity = scene
        revision = hap_core.current_revision(db, entity["entity_id"])
        artifact_kind = "screenplay"
    else:
        entity = _select_conti_entity(db, scene["entity_id"])
        revision = hap_core.current_revision(db, entity["entity_id"]) if entity else None
        artifact_kind = "written_storyboard"

    artifact = _current_artifact(db, revision["revision_id"] if revision else None, artifact_kind)
    projection_path = _projection_path(scene_dir, kind)
    canonical = artifact is not None
    if artifact:
        data = _artifact_bytes(root, artifact)
    elif projection_path.is_file():
        data = projection_path.read_bytes()
    else:
        data = b""
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"invalid_utf8:{kind}") from exc

    state = "missing"
    revision_payload = {}
    if entity and revision:
        revision_payload = _json(revision["payload_json"], {})
        state = hap_core.derive_state(root, db, entity, revision, hap_core.current_map(db))["state"]
    if not canonical and data:
        # A mutable compatibility file must never inherit the HAP entity's
        # verified/accepted label. Only an artifact on this exact revision is
        # canonical evidence for the text shown in FilmMate.
        state = "legacy_unverified"
    structured_sync_required = bool(revision_payload.get("structured_sync_required"))
    return {
        "kind": kind,
        "content": content,
        "sha256": _sha256(data) if data else None,
        "entity_id": entity["entity_id"] if entity else None,
        "revision_id": revision["revision_id"] if revision else None,
        "state": state,
        "canonical": canonical,
        "source": "hap-cas" if canonical else "legacy-projection",
        "projection_path": str(projection_path.relative_to(scene_dir)),
        "structured_sync_required": structured_sync_required,
        "structured_sync_reason": revision_payload.get("structured_sync_reason") if structured_sync_required else None,
        "structured_sync_base_revision_id": revision_payload.get("structured_sync_base_revision_id") if structured_sync_required else None,
    }


def read_documents(project_root: str | Path, scene_key: str) -> dict:
    root = Path(project_root).expanduser().resolve()
    scene_dir = _scene_dir(root, scene_key)
    db = hap_core.connect(root)
    try:
        documents = {
            kind: _document_record(root, db, scene_dir, kind)
            for kind in ("screenplay", "conti")
        }
        return {
            "ok": True,
            "project_id": root.name,
            "scene": scene_key,
            "documents": documents,
        }
    finally:
        db.close()


def _atomic_write_text(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _current_dependencies(db: sqlite3.Connection, revision_id: str | None, *, exclude_entity_type=None):
    if not revision_id:
        return []
    rows = db.execute(
        "SELECT d.upstream_revision_id,d.role,e.entity_type FROM dependencies d "
        "JOIN revisions r ON r.revision_id=d.upstream_revision_id "
        "JOIN entities e ON e.entity_id=r.entity_id WHERE d.downstream_revision_id=?",
        (revision_id,),
    ).fetchall()
    return [
        (row["upstream_revision_id"], row["role"])
        for row in rows
        if row["entity_type"] != exclude_entity_type
    ]


def _add_pending_structure_manifest(
    root: Path,
    db: sqlite3.Connection,
    revision_id: str,
    scene_id: str,
    base_revision_id: str | None,
):
    """Register only the edited document boundary, never old shot structure.

    The previous blocks/shots/validator artifacts describe the old written
    storyboard. Copying them would make stale structure look current. Codex's
    conhap workflow must create a later structured revision before prompting.
    """
    data = _json_bytes({
        "schema_version": 2,
        "scene_id": scene_id,
        "document_role": "written_storyboard",
        "source": "filmmate-document-editor",
        "structured_sync_required": True,
        "structured_sync_reason": "written_storyboard_text_changed",
        "structured_sync_base_revision_id": base_revision_id,
        "shot_records_carried_forward": False,
        "validator_report_carried_forward": False,
    })
    hap_core.add_artifact_bytes(
        root,
        db,
        revision_id=revision_id,
        kind="block_manifest",
        data=data,
        mime="application/json",
    )


def save_document(payload: dict) -> dict:
    root = Path(payload.get("project_root", "")).expanduser().resolve()
    if not (root / ".hap" / "hap.sqlite3").is_file():
        raise ValueError("hap_project_not_found")
    scene_key = str(payload.get("scene") or "")
    kind = str(payload.get("kind") or "")
    actor = str(payload.get("actor") or "")
    content = str(payload.get("content") if payload.get("content") is not None else "")
    expected_revision_id = payload.get("expected_revision_id")
    expected_scene_revision_id = payload.get("expected_scene_revision_id")
    if kind not in DOCUMENT_KINDS:
        raise ValueError("invalid_document_kind")
    if actor not in ACTORS:
        raise ValueError("invalid_actor")
    data = content.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    if not content.strip():
        raise ValueError("empty_document")
    if len(data) > MAX_TEXT_BYTES:
        raise ValueError("document_too_large")

    scene_dir = _scene_dir(root, scene_key)
    db = hap_core.connect(root)
    revision_id = None
    replayed = False
    unchanged = False
    try:
        db.execute("BEGIN IMMEDIATE")
        scene, manifest = _scene_entity(db, scene_dir)
        scene_revision = hap_core.current_revision(db, scene["entity_id"])
        if scene_revision is None:
            raise ValueError("scene_revision_not_found")

        if kind == "screenplay":
            entity = scene
            current = scene_revision
            artifact_kind = "screenplay"
        else:
            entity = _select_conti_entity(db, scene["entity_id"])
            if entity is None:
                scene_id = manifest.get("scene_id") or scene_dir.name.split("_", 1)[0]
                entity = hap_core.ensure_entity(
                    db,
                    entity_type="block",
                    logical_key=f"{scene_id}_CONHAP",
                    parent_id=scene["entity_id"],
                    entity_id=f"block:{scene_id}_CONHAP",
                    workflow_mode="full",
                )
            current = hap_core.current_revision(db, entity["entity_id"])
            artifact_kind = "written_storyboard"
            current_scene_id = scene_revision["revision_id"]
            if expected_scene_revision_id != current_scene_id:
                raise ValueError(f"revision_conflict:{expected_scene_revision_id or 'null'}:{current_scene_id}")

        current_id = current["revision_id"] if current else None
        request_sha = _sha256(
            f"{root.name}|{scene_key}|{kind}|{expected_revision_id or 'null'}|".encode("utf-8") + data
        )
        idempotency_key = str(payload.get("idempotency_key") or f"document:{request_sha}")
        prior = db.execute("SELECT * FROM mutation_keys WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if prior:
            if prior["entity_id"] != entity["entity_id"] or prior["request_sha256"] != request_sha:
                raise ValueError("idempotency_conflict")
            if current_id != prior["revision_id"]:
                raise ValueError(f"revision_conflict:{prior['revision_id']}:{current_id or 'null'}")
            prior_artifact = _current_artifact(db, prior["revision_id"], artifact_kind)
            if not prior_artifact or prior_artifact["sha256"] != _sha256(data):
                raise ValueError("idempotency_artifact_mismatch")
            replayed = True
            revision_id = prior["revision_id"]
            db.rollback()
        elif current_id != expected_revision_id:
            raise ValueError(f"revision_conflict:{expected_revision_id or 'null'}:{current_id or 'null'}")
        else:
            current_artifact = _current_artifact(db, current_id, artifact_kind)
            if current_artifact and current_artifact["sha256"] == _sha256(data):
                unchanged = True
                revision_id = current_id
                db.rollback()
            else:
                previous_payload = _json(current["payload_json"], {}) if current else {}
                dependencies = []
                if kind == "conti":
                    dependencies = _current_dependencies(db, current_id, exclude_entity_type="scene")
                    dependencies.append((scene_revision["revision_id"], "screenplay"))
                document_edit = {
                    "kind": kind,
                    "sha256": _sha256(data),
                    "actor": actor,
                    "base_revision_id": expected_revision_id,
                }
                if kind == "conti":
                    # Do not inherit shot counts, validation claims, approval
                    # claims, or any other structural metadata from the old
                    # conti revision. The exact edited text is canonical, but
                    # its cut/block structure is intentionally pending.
                    scene_id = manifest.get("scene_id") or scene_dir.name.split("_", 1)[0]
                    next_payload = {
                        "scene_id": previous_payload.get("scene_id") or scene_id,
                        "kind": "written_storyboard_text_edit",
                        "document_edit": document_edit,
                        "structured_sync_required": True,
                        "structured_sync_reason": "written_storyboard_text_changed",
                        "structured_sync_base_revision_id": expected_revision_id,
                        "approval_status": "pending_user_approval",
                    }
                else:
                    next_payload = {
                        **previous_payload,
                        "document_edit": document_edit,
                        "projection_scope": "scene_revision",
                        "approval_status": "pending_user_approval",
                    }
                evidence = [{
                    "kind": "user_edit" if actor == "filmmate-user" else "codex_edit",
                    "actor": actor,
                    "editor": "FilmMate" if actor == "filmmate-user" else "Codex",
                    "base_revision_id": expected_revision_id,
                    "document_kind": kind,
                    "content_sha256": _sha256(data),
                }]
                revision, replayed = hap_core.commit_revision(
                    root,
                    db,
                    entity_id=entity["entity_id"],
                    producer="filmmate-document-editor" if actor == "filmmate-user" else "codex-filmmate-editor",
                    payload=next_payload,
                    source_evidence=evidence,
                    dependencies=dependencies,
                    expected_revision_id=expected_revision_id,
                    enforce_expected=True,
                    idempotency_key=idempotency_key,
                    request_sha256=request_sha,
                    actor=actor,
                )
                revision_id = revision["revision_id"]
                if kind == "conti":
                    _add_pending_structure_manifest(
                        root,
                        db,
                        revision_id,
                        manifest.get("scene_id") or scene_dir.name.split("_", 1)[0],
                        expected_revision_id,
                    )
                hap_core.add_artifact_bytes(
                    root,
                    db,
                    revision_id=revision_id,
                    kind=artifact_kind,
                    data=data,
                    mime="text/markdown; charset=utf-8" if kind == "conti" else "text/plain; charset=utf-8",
                )
                db.commit()

        if not unchanged and not replayed:
            projection = hap_core.write_projection(root, db)
            _atomic_write_text(_projection_path(scene_dir, kind), data.decode("utf-8"))
        else:
            projection = hap_core.write_projection(root, db)
        stale = [
            {
                "entity_id": item["entity_id"],
                "entity_type": item["entity_type"],
                "logical_key": item["logical_key"],
            }
            for item in projection.get("entities", [])
            if item.get("state") == "stale"
        ]
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise
    finally:
        db.close()

    latest = read_documents(root, scene_key)
    return {
        "ok": True,
        "kind": kind,
        "revision_id": revision_id,
        "unchanged": unchanged,
        "idempotent_replay": replayed,
        "stale_dependents": stale,
        "documents": latest["documents"],
    }


def _main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"read", "save"}:
        raise SystemExit("usage: filmmate_documents.py read|save")
    payload = json.load(sys.stdin)
    if sys.argv[1] == "read":
        output = read_documents(payload["project_root"], payload["scene"])
    else:
        output = save_document(payload)
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    try:
        _main()
    except (ValueError, OSError, sqlite3.Error, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
