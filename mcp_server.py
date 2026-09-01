#!/usr/bin/env python3
"""Stdio MCP server and the FilmMake stage projector.

Canonical state is regenerated from .hap/hap.sqlite3 on every read.  The
mutable projection.json file is never an input to Desktop or MCP status.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import package_compiler
import scene_breakdown
import workspace_compiler
from core import filmmate_documents, hap_core, production_agent_jobs, production_commands, production_orchestrator, prompt_ir, prompt_jobs
from package_compiler import compile_package
from scene_breakdown import generate_breakdown
from screenplay_analyzer import analyze_screenplay
from workspace_compiler import compile_workspace


ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"
STAGE_ORDER = ("analysis", "text_conti", "assets", "storyboard", "prompts", "qa", "package")
LEGACY_ARTIFACT_ROLES = {
    "reference",
    "character_reference",
    "background_reference",
    "location_reference",
    "prop_reference",
    "ui_reference",
    "camera_plate",
}
ENTITY_STAGE_TYPES = {
    "text_conti": {"beat"},
    "assets": {"asset"},
    "storyboard": {"cut", "block"},
    "prompts": {"prompt", "package"},
    "package": {"package"},
}
STATE_PRIORITY = {
    "BLOCKED": 0,
    "STALE": 1,
    "INVALID": 2,
    "QA_FAILED": 3,
    "REJECTED": 4,
    "ABSENT": 5,
    "DRAFT": 6,
    "QA_PENDING": 7,
    "ACCEPTANCE_PENDING": 8,
    "READY": 9,
}


def result(value):
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}]}


def _segment(value, label):
    value = str(value or "")
    if (
        not value
        or value in {".", ".."}
        or "\x00" in value
        or "/" in value
        or "\\" in value
        or any(token in value for token in ("*", "?", "[", "]"))
        or Path(value).is_absolute()
    ):
        raise ValueError(f"E_PATH_SEGMENT_INVALID:{label}")
    return value


def _contained(root: Path, target: Path, *, must_exist=False):
    root = root.expanduser().resolve()
    target = target.expanduser().resolve(strict=must_exist)
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError("E_PATH_ESCAPE") from exc
    return target


def packages_root():
    PACKAGES.mkdir(parents=True, exist_ok=True)
    return PACKAGES.resolve()


def project_dir(project, *, must_exist=True):
    root = packages_root()
    candidate = _contained(root, root / _segment(project, "project"), must_exist=False)
    if must_exist and (not candidate.is_dir() or candidate.is_symlink()):
        raise ValueError("E_PROJECT_NOT_FOUND")
    if candidate.exists():
        candidate = _contained(root, candidate, must_exist=True)
    return candidate


def scene_dir(project, scene, *, must_exist=True):
    project_root = project_dir(project, must_exist=True)
    scenes_root = _contained(project_root, project_root / "scenes", must_exist=False)
    requested = _segment(scene, "scene")
    if not scenes_root.is_dir():
        if must_exist:
            raise ValueError("E_SCENE_NOT_FOUND")
        return _contained(project_root, scenes_root / requested, must_exist=False)
    candidates = []
    for item in scenes_root.iterdir():
        if item.is_symlink() or not item.is_dir():
            continue
        if item.name == requested or item.name.startswith(f"{requested}_"):
            candidates.append(_contained(project_root, item, must_exist=True))
    if len(candidates) != 1:
        if must_exist:
            raise ValueError("E_SCENE_NOT_FOUND" if not candidates else "E_SCENE_AMBIGUOUS")
        return _contained(project_root, scenes_root / requested, must_exist=False)
    return candidates[0]


def manifest_path(project, scene=None):
    root = project_dir(project)
    return (scene_dir(project, scene) if scene else root) / "scene-data" / "scene-manifest.json"


def canonical_project(project):
    try:
        return (project_dir(project) / ".hap" / "hap.sqlite3").is_file()
    except ValueError:
        return False


def capture_call(function, args):
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream):
        returned = function(SimpleNamespace(**args))
    output = stream.getvalue().strip()
    return output if output else returned


def require_hap(project):
    root = project_dir(project)
    if not (root / ".hap" / "hap.sqlite3").is_file():
        raise ValueError("E_HAP_PROJECT_REQUIRED")
    return root


def regenerate_hap_projection(project):
    """Regenerate from SQLite; projection.json is output only, never input."""
    root = require_hap(project)
    raw = capture_call(hap_core.cmd_status, {"project": str(root)})
    if isinstance(raw, dict):
        projection = raw
    else:
        try:
            projection = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("E_HAP_STATUS_INVALID") from exc
    if not isinstance(projection, dict) or not isinstance(projection.get("entities"), list):
        raise ValueError("E_HAP_STATUS_INVALID")
    projection["status_source"] = "sqlite-regenerated"
    return projection


def normalize_state(value):
    raw = str(value or "ABSENT").upper()
    aliases = {
        "MISSING": "ABSENT",
        "WORKING": "DRAFT",
        "PLANNED": "DRAFT",
        "UNVERIFIED": "QA_PENDING",
        "VERIFIED": "ACCEPTANCE_PENDING",
        # Old core's ACCEPTED is intentionally not release-terminal.
        "ACCEPTED": "ACCEPTANCE_PENDING",
    }
    normalized = aliases.get(raw, raw)
    return normalized if normalized in STATE_PRIORITY else "INVALID"


def aggregate_entities(entities):
    if not entities:
        return "ABSENT"
    states = [normalize_state(entity.get("state")) for entity in entities]
    if states and all(state == "READY" for state in states):
        return "READY"
    return min(states, key=lambda state: STATE_PRIORITY.get(state, 2))


def descendants(entities, owner_id):
    children_by_parent = {}
    for entity in entities:
        children_by_parent.setdefault(entity.get("parent_id"), []).append(entity)
    found = []
    queue = list(children_by_parent.get(owner_id, []))
    seen = set()
    while queue:
        entity = queue.pop(0)
        entity_id = entity.get("entity_id")
        if not entity_id or entity_id in seen:
            continue
        seen.add(entity_id)
        found.append(entity)
        queue.extend(children_by_parent.get(entity_id, []))
    return found


def canonical_scene_projection(project, scene_path: Path, manifest, projection):
    scene_id = manifest.get("scene_id") or scene_path.name.split("_", 1)[0]
    entities = projection.get("entities", [])
    owner = next(
        (
            entity
            for entity in entities
            if str(entity.get("entity_type", "")).lower() == "scene"
            and entity.get("logical_key") in {scene_id, scene_path.name}
        ),
        None,
    )
    if owner is None:
        pipeline = {stage: "ABSENT" for stage in STAGE_ORDER}
        return {
            "scene_id": scene_id,
            "scene_key": scene_path.name,
            "state_source": "hap-v2",
            "pipeline": pipeline,
            "progress": 0,
            "release_ready": False,
            "integrity_errors": ["E_HAP_SCENE_ENTITY_MISSING"],
        }
    children = descendants(entities, owner.get("entity_id"))
    by_type = {}
    for entity in children:
        by_type.setdefault(str(entity.get("entity_type", "")).lower(), []).append(entity)
    pipeline = {"analysis": normalize_state(owner.get("state"))}
    for stage, entity_types in ENTITY_STAGE_TYPES.items():
        pipeline[stage] = aggregate_entities(
            [entity for entity_type in entity_types for entity in by_type.get(entity_type, [])]
        )
    qa_entities = [
        entity
        for entity_type in {"beat", "cut", "block", "asset", "prompt", "package"}
        for entity in by_type.get(entity_type, [])
    ]
    pipeline["qa"] = aggregate_entities(qa_entities)
    pipeline = {stage: pipeline.get(stage, "ABSENT") for stage in STAGE_ORDER}
    ready = sum(value == "READY" for value in pipeline.values())
    return {
        "scene_id": scene_id,
        "scene_key": scene_path.name,
        "entity_id": owner.get("entity_id"),
        "state_source": "hap-v2",
        "pipeline": pipeline,
        "progress": round(ready / len(STAGE_ORDER) * 100),
        "release_ready": pipeline["package"] == "READY",
        "integrity_errors": [],
    }


def _has_images(directory):
    return directory.is_dir() and any(
        item.is_file() and item.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        for item in directory.iterdir()
    )


def legacy_scene_projection(project, scene_path: Path, manifest):
    conhap_name = "conhap-v3" if (scene_path / "conhap-v3" / "project.json").is_file() else "conhap"
    conhap = scene_path / conhap_name
    artifact_registry = scene_path / "scene-data" / "artifacts.json"
    asset_evidence = (
        (scene_path / "assets" / "asset-plan.json").is_file()
        or artifact_registry.is_file()
        or _has_images(conhap / "reference-sheets")
    )
    delivery = scene_path / "delivery"
    package_evidence = delivery.is_dir() and any(
        item.is_file() and item.suffix.lower() in {".zip", ".json"} for item in delivery.iterdir()
    )
    evidence = {
        "analysis": (scene_path / "input-screenplay.txt").is_file(),
        "text_conti": (conhap / "text-conti.md").is_file(),
        "assets": asset_evidence,
        "storyboard": _has_images(conhap / "frames"),
        "prompts": (scene_path / "prompts" / "prompt-manifest.json").is_file(),
        "qa": (conhap / "qa" / "qa.jsonl").is_file() or (scene_path / "qa" / "qa-report.json").is_file(),
        "package": package_evidence,
    }
    pipeline = {
        stage: "LEGACY_UNVERIFIED" if evidence.get(stage) else "ABSENT"
        for stage in STAGE_ORDER
    }
    return {
        "scene_id": manifest.get("scene_id") or scene_path.name.split("_", 1)[0],
        "scene_key": scene_path.name,
        "state_source": "legacy-evidence-only",
        "pipeline": pipeline,
        "progress": 0,
        "release_ready": False,
        "integrity_errors": [],
    }


def read_project_status(project, scene=None):
    root = project_dir(project)
    root_manifest_path = root / "scene-data" / "scene-manifest.json"
    if not root_manifest_path.is_file():
        raise ValueError("E_MANIFEST_NOT_FOUND")
    root_manifest = json.loads(root_manifest_path.read_text(encoding="utf-8"))
    canonical = (root / ".hap" / "hap.sqlite3").is_file()
    projection = regenerate_hap_projection(project) if canonical else None
    scenes_root = root / "scenes"
    scene_paths = []
    if scene:
        scene_paths = [scene_dir(project, scene)]
    elif scenes_root.is_dir():
        for item in sorted(scenes_root.iterdir(), key=lambda value: value.name):
            if item.is_symlink() or not item.is_dir():
                continue
            scene_paths.append(_contained(root, item, must_exist=True))
    scenes = []
    for scene_path in scene_paths:
        manifest_file = scene_path / "scene-data" / "scene-manifest.json"
        if not manifest_file.is_file():
            continue
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        projected = (
            canonical_scene_projection(project, scene_path, manifest, projection)
            if projection is not None
            else legacy_scene_projection(project, scene_path, manifest)
        )
        scenes.append({**projected, "title": manifest.get("title"), "location": manifest.get("location"), "time": manifest.get("time")})
    return {
        "project": project,
        "title": root_manifest.get("title") or project,
        "state_source": "hap-v2" if canonical else "legacy-evidence-only",
        "status_source": "sqlite-regenerated" if canonical else "legacy-files-inspected",
        "release_ready": bool(scenes) and all(item["release_ready"] for item in scenes),
        "scenes": scenes,
        "projection_meta": {
            key: projection.get(key)
            for key in ("schema_version", "generated_at", "ledger_sequence", "ledger_hash")
            if projection is not None and projection.get(key) is not None
        },
    }


def register_artifact(args):
    target = scene_dir(args["project"], args["scene"])
    source = Path(args["source"]).expanduser().resolve()
    if not source.is_file():
        return {"error": "artifact_source_not_found"}
    role = str(args.get("role", "reference"))
    if role not in LEGACY_ARTIFACT_ROLES:
        return {"error": "E_ROLE_NOT_ALLOWED"}
    bucket = _contained(target, target / "artifacts" / role, must_exist=False)
    bucket.mkdir(parents=True, exist_ok=True)
    bucket = _contained(target, bucket, must_exist=True)
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    safe_name = "".join(character if character.isalnum() or character in "._-" else "_" for character in source.name)
    dest = _contained(target, bucket / f"{checksum[:16]}_{safe_name}", must_exist=False)
    if not dest.exists():
        shutil.copy2(source, dest)
    registry_path = _contained(target, target / "scene-data" / "artifacts.json", must_exist=False)
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {"schema_version": "1.0", "artifacts": []}
    logical_id = str(args.get("logical_id", source.stem))
    version = 1 + max([artifact.get("version", 0) for artifact in registry["artifacts"] if artifact.get("logical_id") == logical_id] or [0])
    record = {
        "logical_id": logical_id,
        "version": version,
        "role": role,
        "file": str(dest.relative_to(target)),
        "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
        "source_name": source.name,
        "actor": args.get("actor", "codex"),
    }
    registry["artifacts"].append(record)
    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"artifact": record, "registry_path": str(registry_path)}


def get_filmmate_prompt_request(args):
    payload = prompt_jobs.latest(
        require_hap(args["project"]),
        scene=args["scene"],
        model=args["model"],
        unit_type=args["unit_type"],
        target_id=args["target_id"],
    )
    claimed = prompt_jobs.claim(require_hap(args["project"]), payload["job"]["job_id"], actor="codex")
    return {
        "status": "claimed_for_codex",
        "job": claimed["job"],
        "request": claimed["request"],
        "claim_token": claimed["job"].get("claim_token"),
        "instructions": [
            "Use the full seedance-prompt-rules skill, not a summary.",
            "Create one schema-valid Prompt IR and complete Korean, English, and Simplified Chinese versions in one task.",
            "Preserve every protected string, CUT ID, @Image tag, {dialogue}, <sound>, and 【screen text】 exactly.",
            "Submit prompt_ir and all three variants together with submit_filmmate_prompt_bundle.",
        ],
    }


def semantic_scene_context(project, scene):
    root = require_hap(project)
    target = scene_dir(project, scene)
    manifest_file = target / "scene-data" / "scene-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8")) if manifest_file.is_file() else {}
    aliases = [scene, target.name, manifest.get("scene_id")]
    return root, regenerate_hap_projection(project), [item for item in aliases if item]


def submit_filmmate_prompt_bundle(args):
    payload = {**args, "actor": "codex"}
    root = require_hap(args["project"])
    job = prompt_jobs.by_id(root, args["job_id"]) if args.get("job_id") else prompt_jobs.latest(
        root,
        scene=args["scene"],
        model=args["model"],
        unit_type=args["unit_type"],
        target_id=args["target_id"],
    )
    payload["job_id"] = job["job"]["job_id"]
    if not payload.get("claim_token"):
        claimed = prompt_jobs.claim(root, payload["job_id"], actor="codex")
        payload["claim_token"] = claimed["job"].get("claim_token")
    submitted = prompt_jobs.submit(root, payload["job_id"], payload, actor="codex")
    return {
        "status": "ready" if submitted.get("job", {}).get("effective_state") == "READY" else submitted.get("job", {}).get("state"),
        "job": submitted.get("job"),
        "revision_id": submitted.get("job", {}).get("output_revision_id"),
        "qa": submitted.get("qa"),
        "error": submitted.get("error"),
        "languages": ["ko", "en", "zh"],
    }


def call(name, args):
    try:
        if name == "run_production_agent":
            _root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_orchestrator.build_plan(
                projection, aliases, goal=args.get("goal"), target=args.get("target"),
                previous_checkpoint=args.get("previous_checkpoint"),
            ))
        if name == "start_production_run":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_agent_jobs.start_run(
                root, projection, aliases, goal=args.get("goal"), target=args.get("target"), actor=str(args.get("actor") or "codex")
            ))
        if name == "get_production_run":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_agent_jobs.refresh_run(
                root, args["run_id"], projection, aliases, actor=str(args.get("actor") or "codex")
            ))
        if name == "claim_production_task":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_agent_jobs.claim_next(
                root, args["run_id"], projection, aliases, actor=str(args.get("actor") or "codex-worker")
            ))
        if name == "control_production_run":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            snapshot = production_agent_jobs.control_run(
                root, args["run_id"], args["action"], actor=str(args.get("actor") or "codex"),
                task_id=args.get("task_id"), claim_token=args.get("claim_token"), error=args.get("error"),
            )
            if args["action"] in {"resume", "retry_task"} and not snapshot.get("cancelled"):
                snapshot = production_agent_jobs.refresh_run(root, args["run_id"], projection, aliases, actor=str(args.get("actor") or "codex"))
            return result(snapshot)
        if name == "prepare_scene":
            _root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_commands.prepare_scene(projection, aliases))
        if name == "get_generate_ready":
            _root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_commands.build_scene_state(projection, aliases))
        if name == "prepare_stale_regeneration":
            _root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            return result(production_commands.stale_regeneration_plan(projection, aliases))
        if name == "save_production_object":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            saved = production_commands.save_production_object(root, projection, aliases, args)
            refreshed = regenerate_hap_projection(args["project"])
            return result({**saved, "production": production_commands.build_scene_state(refreshed, aliases)})
        if name == "approve_production_object":
            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])
            approved = production_commands.approve_production_object(root, projection, aliases, args)
            refreshed = regenerate_hap_projection(args["project"])
            return result({**approved, "production": production_commands.build_scene_state(refreshed, aliases)})
        if name == "list_scene_projects":
            return result({"projects": [item.name for item in packages_root().iterdir() if item.is_dir() and not item.is_symlink() and not item.name.startswith(".")]})
        if name == "get_scene_status":
            status = read_project_status(args["project"], args.get("scene"))
            return result(status["scenes"][0] if args.get("scene") and status["scenes"] else status)
        if name == "start_next_scene_stage":
            status = read_project_status(args["project"], args.get("scene"))
            scene_status = status["scenes"][0] if args.get("scene") and status["scenes"] else None
            if scene_status is None:
                candidates = [item for item in status["scenes"] if not item["release_ready"]]
                scene_status = candidates[0] if candidates else (status["scenes"][0] if status["scenes"] else None)
            if scene_status is None:
                return result({"source": status["state_source"], "read_only": True, "next": None, "message": "No scene exists; no state was written."})
            unresolved = next((stage for stage in STAGE_ORDER if scene_status["pipeline"][stage] != "READY"), None)
            return result({
                "source": scene_status["state_source"],
                "read_only": True,
                "scene": scene_status["scene_id"],
                "next": {"stage": unresolved, "state": scene_status["pipeline"].get(unresolved)} if unresolved else None,
                "action": "MIGRATE_TO_HAP" if scene_status["state_source"] == "legacy-evidence-only" else "CREATE_REVISION_OR_RESOLVE_GATE",
                "message": "Readiness was projected from evidence; no completion state was written.",
            })
        if name == "complete_scene_stage":
            return result({"error": "E_STATUS_WRITE_FORBIDDEN", "message": "Readiness is derived and cannot be manually completed."})
        if name == "get_hap_projection":
            return result(regenerate_hap_projection(args["project"]))
        if name == "get_filmmate_documents":
            root = require_hap(args["project"])
            target = scene_dir(args["project"], args["scene"])
            return result(filmmate_documents.read_documents(root, target.name))
        if name == "save_filmmate_document":
            root = require_hap(args["project"])
            target = scene_dir(args["project"], args["scene"])
            return result(filmmate_documents.save_document({
                "project_root": str(root),
                "scene": target.name,
                "kind": args["kind"],
                "content": args["content"],
                "actor": "codex",
                "expected_revision_id": args.get("expected_revision_id"),
                "expected_scene_revision_id": args.get("expected_scene_revision_id"),
                "idempotency_key": args.get("idempotency_key"),
            }))
        if name == "get_filmmate_prompt_request":
            return result(get_filmmate_prompt_request(args))
        if name == "submit_filmmate_prompt_bundle":
            return result(submit_filmmate_prompt_bundle(args))
        if name == "get_filmmate_prompt_job":
            return result(prompt_jobs.by_id(require_hap(args["project"]), args["job_id"]))
        if name == "get_filmmate_prompt_history":
            return result(prompt_jobs.history(require_hap(args["project"]), scene=args.get("scene"), limit=args.get("limit", 50)))
        if name == "cancel_filmmate_prompt":
            return result(prompt_jobs.cancel(require_hap(args["project"]), args["job_id"], actor="filmmate-user"))
        if name == "create_hap_entity":
            root = require_hap(args["project"])
            output = capture_call(hap_core.cmd_add_entity, {"project": str(root), "entity_type": args["entity_type"], "key": args["key"], "entity_id": args.get("entity_id"), "parent": args.get("parent"), "mode": args.get("mode", "full")})
            return result({"entity_id": output})
        if name == "create_hap_revision":
            root = require_hap(args["project"])
            output = capture_call(hap_core.cmd_commit, {"project": str(root), "entity": args["entity_id"], "producer": args["producer"], "payload": json.dumps(args["payload"], ensure_ascii=False), "evidence": json.dumps(args["source_evidence"], ensure_ascii=False), "depends_on": args.get("depends_on", []), "revision_id": args.get("revision_id")})
            return result({"revision_id": output})
        if name == "register_hap_artifact":
            root = require_hap(args["project"])
            output = capture_call(hap_core.cmd_artifact, {"project": str(root), "revision": args["revision_id"], "kind": args["kind"], "file": args["source"], "preview": args.get("preview"), "artifact_id": args.get("artifact_id")})
            return result({"artifact_id": output})
        if name == "submit_hap_qa":
            root = require_hap(args["project"])
            output = capture_call(hap_core.cmd_qa, {"project": str(root), "revision": args["revision_id"], "status": args["status"], "method": args["method"], "checks": json.dumps(args["checks"], ensure_ascii=False), "report": args["report"], "qa_id": args.get("qa_id")})
            return result({"qa_id": output})
        if name == "approve_hap_revision":
            if args.get("approver_type") == "user":
                return result({"error": "E_DIRECT_USER_APPROVAL_FORBIDDEN", "message": "Direct user approval requires an authenticated Desktop UI approval channel."})
            if args.get("approver_type") != "delegated_user_policy" or not args.get("delegated_grant_id"):
                return result({"error": "E_DELEGATED_GRANT_REQUIRED"})
            grant_id = _segment(args["delegated_grant_id"], "delegated_grant_id")
            root = require_hap(args["project"])
            evidence = json.dumps({"delegated_grant_id": grant_id, "evidence": args["evidence"]}, ensure_ascii=False)
            output = capture_call(hap_core.cmd_approve, {
                "project": str(root),
                "revision": args["revision_id"],
                "approver_type": "delegated_user_policy",
                "approver": args["approver"],
                "evidence": evidence,
                "approval_id": args.get("approval_id"),
                "delegated_grant_id": grant_id,
            })
            return result({"approval_id": output, "delegated_grant_id": grant_id})
        if name == "compile_prompt_preview":
            root = require_hap(args["project"])
            prompt_path = _contained(root, Path(args["prompt_ir"]), must_exist=True)
            token = prompt_ir.sha_file(prompt_path)[:16]
            out = _contained(root, root / ".hap" / "previews" / "prompt-packages" / token, must_exist=False)
            if (out / "manifest.json").is_file():
                manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            else:
                manifest = prompt_ir.compile_package(prompt_path, root, out)
            return result({"mode": "preview", "ready": False, "path": str(out), "manifest": manifest})
        if name == "register_artifact":
            if canonical_project(args["project"]):
                return result({"error": "E_CANONICAL_WRITE_REQUIRED", "message": "Register against an exact revision through hap-core."})
            return result(register_artifact(args))
        if name == "compile_delivery_package":
            if canonical_project(args["project"]):
                return result({"error": "E_SEEDANCE_GATE_REQUIRED", "message": "Canonical projects require the Seedance prompt, reference-role, upload-order, QA, and approval gates."})
            target = scene_dir(args["project"], args["scene"])
            return result(compile_package(args["project"], target.name, args.get("prompt")))
        if name == "generate_scene_breakdown":
            if canonical_project(args["project"]):
                return result({"error": "E_CANONICAL_WRITE_REQUIRED", "message": "Write revisions through conhap and hap-core."})
            target = scene_dir(args["project"], args["scene"])
            return result(generate_breakdown(args["project"], target.name, args.get("duration_sec"), args.get("shot_count", 6)))
        if name == "analyze_screenplay":
            text = args.get("text")
            if text is None and args.get("source"):
                text = Path(args["source"]).expanduser().read_text(encoding="utf-8")
            return result(analyze_screenplay(text or ""))
        if name == "compile_scene_workspace":
            if canonical_project(args["project"]):
                return result({"error": "E_CANONICAL_WRITE_REQUIRED", "message": "Legacy workspace compilation cannot write a canonical project."})
            target = scene_dir(args["project"], args["scene"])
            return result(compile_workspace(args["project"], target.name, args.get("duration_sec"), args.get("shot_count", 6)))
        return result({"error": "unknown_tool", "tool": name})
    except (ValueError, SystemExit, OSError, KeyError, json.JSONDecodeError) as exc:
        return result({"error": str(exc)})


SEMANTIC_TOOLS = [
    {
        "name": "run_production_agent",
        "description": "Plan or resume a stateless Production Agent control loop from one natural-language goal. It re-reads canonical HAP state, returns the ordered steps and exact next semantic tool, and requires a fresh checkpoint after every write. It never invents completion or auto-approves creative work.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string"},
                "scene": {"type": "string"},
                "goal": {"type": "string"},
                "target": {"type": "string", "enum": ["generate_ready", "handoff_ready", "stale_clear"]},
                "previous_checkpoint": {"type": "string"}
            },
            "required": ["project", "scene", "goal"]
        },
    },
    {
        "name": "start_production_run",
        "description": "Create a durable Production Agent run from the current canonical scene plan. The queue persists in HAP SQLite and completion remains derived from canonical state.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "goal": {"type": "string"}, "target": {"type": "string", "enum": ["generate_ready", "handoff_ready", "stale_clear"]}, "actor": {"type": "string"}}, "required": ["project", "scene", "goal"]},
    },
    {
        "name": "get_production_run",
        "description": "Refresh a durable Production Agent run from current HAP state. Tasks disappear only when the canonical blocker is actually resolved.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "run_id": {"type": "string"}, "actor": {"type": "string"}}, "required": ["project", "scene", "run_id"]},
    },
    {
        "name": "claim_production_task",
        "description": "Claim exactly the first executable Production Agent task for one worker. Later tasks cannot be claimed before the leading task resolves in canonical state.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "run_id": {"type": "string"}, "actor": {"type": "string"}}, "required": ["project", "scene", "run_id"]},
    },
    {
        "name": "control_production_run",
        "description": "Pause, resume, cancel, release, fail, or explicitly retry a Production Agent task. It never marks creative work complete; canonical refresh decides that.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "run_id": {"type": "string"}, "action": {"type": "string", "enum": ["pause", "resume", "cancel", "release_task", "fail_task", "retry_task"]}, "task_id": {"type": "string"}, "claim_token": {"type": "string"}, "error": {"type": "string"}, "actor": {"type": "string"}}, "required": ["project", "scene", "run_id", "action"]},
    },
    {
        "name": "prepare_scene",
        "description": "Build a production-aware work plan for one scene. Returns Generate-ready status, blockers, stale objects, and ordered next actions without writing fake completion state.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project", "scene"]},
    },
    {
        "name": "get_generate_ready",
        "description": "Read the canonical Production Object readiness model for one scene: Scene Analysis, Written Conti, References, Storyboard/Shots, Video Prompts, and optional Handoff Package.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project", "scene"]},
    },
    {
        "name": "prepare_stale_regeneration",
        "description": "Return an ordered regeneration plan for stale Production Objects, including the exact current revision that must be replaced. This plans regeneration; it does not claim new creative output exists.",
        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project", "scene"]},
    },
    {
        "name": "save_production_object",
        "description": "Create or revise a semantic FilmMate Production Object under a scene. Dependencies are resolved to their latest canonical revisions automatically. expected_revision_id is required and must be null only when creating a new object.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string"}, "scene": {"type": "string"},
                "object_type": {"type": "string", "enum": ["beat", "cut", "block", "asset", "prompt", "package"]},
                "key": {"type": "string"},
                "stage": {"type": "string", "enum": ["conti", "assets", "storyboard", "prompts", "handoff"]},
                "payload": {"type": "object"}, "source_evidence": {"type": "object"},
                "dependencies": {
                    "type": "array",
                    "items": {"type": "object", "properties": {
                        "entity_id": {"type": "string"}, "object_type": {"type": "string"}, "key": {"type": "string"}, "role": {"type": "string"}
                    }}
                },
                "expected_revision_id": {"type": ["string", "null"]},
                "idempotency_key": {"type": "string"}, "producer": {"type": "string"}
            },
            "required": ["project", "scene", "object_type", "key", "payload", "source_evidence", "expected_revision_id"]
        },
    },
    {
        "name": "approve_production_object",
        "description": "Approve the current verified revision of a Production Object using an explicit delegated user-policy grant. Stale, blocked, unverified, or superseded revisions cannot be approved.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {"type": "string"}, "scene": {"type": "string"},
                "entity_id": {"type": "string"}, "object_type": {"type": "string"}, "key": {"type": "string"},
                "approver": {"type": "string"}, "evidence": {"type": "string"}, "delegated_grant_id": {"type": "string"}, "approval_id": {"type": "string"}
            },
            "required": ["project", "scene", "approver", "evidence", "delegated_grant_id"]
        },
    },
]

TOOLS = SEMANTIC_TOOLS + [
    {"name": "list_scene_projects", "description": "List contained FilmMake projects.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_scene_status", "description": "Read the shared DB-regenerated stage projection; legacy files are evidence-only.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project"]}},
    {"name": "start_next_scene_stage", "description": "Read the next unresolved gate without writing a stage or completion value.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project"]}},
    {"name": "register_artifact", "description": "Legacy artifact import with fixed role allowlist. Canonical projects use hap-core.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "source": {"type": "string"}, "role": {"type": "string", "enum": sorted(LEGACY_ARTIFACT_ROLES)}, "logical_id": {"type": "string"}, "actor": {"type": "string"}}, "required": ["project", "scene", "source"]}},
    {"name": "compile_delivery_package", "description": "Legacy preview compiler only; never establishes readiness.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "prompt": {"type": "string"}}, "required": ["project", "scene"]}},
    {"name": "generate_scene_breakdown", "description": "Legacy draft breakdown only.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "duration_sec": {"type": "integer"}, "shot_count": {"type": "integer"}}, "required": ["project", "scene"]}},
    {"name": "analyze_screenplay", "description": "Split a Korean screenplay into editable scene source spans.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "source": {"type": "string"}}}},
    {"name": "compile_scene_workspace", "description": "Legacy-only workspace materialization.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "duration_sec": {"type": "integer"}, "shot_count": {"type": "integer"}}, "required": ["project", "scene"]}},
    {"name": "get_hap_projection", "description": "Regenerate canonical projection directly from SQLite and return it.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}}, "required": ["project"]}},
    {"name": "get_filmmate_documents", "description": "Read the latest HAP/CAS screenplay and written-conti revisions before Codex reviews or edits FilmMate text.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}}, "required": ["project", "scene"]}},
    {"name": "save_filmmate_document", "description": "Save a Codex screenplay or written-conti edit as a new immutable HAP revision with optimistic conflict protection and downstream STALE propagation.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "kind": {"type": "string", "enum": ["screenplay", "conti"]}, "content": {"type": "string"}, "expected_revision_id": {"type": ["string", "null"]}, "expected_scene_revision_id": {"type": ["string", "null"]}, "idempotency_key": {"type": "string"}}, "required": ["project", "scene", "kind", "content", "expected_revision_id"]}},
    {"name": "get_filmmate_prompt_request", "description": "Claim the exact HAP-backed FilmMate cut/block request before prompt writing. Use the full seedance-prompt-rules skill and return one Prompt IR plus KO, EN, and Simplified Chinese together.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "model": {"type": "string"}, "unit_type": {"type": "string", "enum": ["shot", "block"]}, "target_id": {"type": "string"}}, "required": ["project", "scene", "model", "unit_type", "target_id"]}},
    {"name": "submit_filmmate_prompt_bundle", "description": "Submit one immutable HAP prompt revision containing schema-valid Prompt IR and complete KO, EN, and Simplified Chinese Seedance prompts. Never submit a single language or a summary.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "model": {"type": "string"}, "unit_type": {"type": "string", "enum": ["shot", "block"]}, "target_id": {"type": "string"}, "job_id": {"type": "string"}, "claim_token": {"type": "string"}, "request_sha256": {"type": "string"}, "skill_bundle_sha256": {"type": "string"}, "prompt_ir": {"type": "object"}, "prompt_variants": {"type": "object", "properties": {"ko": {"type": "string"}, "en": {"type": "string"}, "zh": {"type": "string"}}, "required": ["ko", "en", "zh"], "additionalProperties": False}, "engine": {"type": "string"}}, "required": ["project", "scene", "model", "unit_type", "target_id", "request_sha256", "skill_bundle_sha256", "prompt_ir", "prompt_variants"]}},
    {"name": "get_filmmate_prompt_job", "description": "Read one HAP-backed prompt job, current revision, derived state, and immutable event history.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "job_id": {"type": "string"}}, "required": ["project", "job_id"]}},
    {"name": "get_filmmate_prompt_history", "description": "Read prompt job history for a project or scene without changing readiness.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["project"]}},
    {"name": "cancel_filmmate_prompt", "description": "Cancel one queued or claimed FilmMate prompt job and preserve its event history.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "job_id": {"type": "string"}}, "required": ["project", "job_id"]}},
    {"name": "create_hap_entity", "description": "Create a scoped HAP entity without declaring completion.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "entity_type": {"type": "string", "enum": ["project", "scene", "beat", "cut", "block", "asset", "prompt", "package", "generation", "delivery"]}, "key": {"type": "string"}, "entity_id": {"type": "string"}, "parent": {"type": "string"}, "mode": {"type": "string"}}, "required": ["project", "entity_type", "key"]}},
    {"name": "create_hap_revision", "description": "Create an immutable revision with source evidence and exact dependencies.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "entity_id": {"type": "string"}, "producer": {"type": "string"}, "payload": {"type": "object"}, "source_evidence": {"type": "array"}, "depends_on": {"type": "array", "items": {"type": "string"}}, "revision_id": {"type": "string"}}, "required": ["project", "entity_id", "producer", "payload", "source_evidence"]}},
    {"name": "register_hap_artifact", "description": "Bind a real immutable artifact to one exact revision.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "revision_id": {"type": "string"}, "kind": {"type": "string"}, "source": {"type": "string"}, "preview": {"type": "string"}, "artifact_id": {"type": "string"}}, "required": ["project", "revision_id", "kind", "source"]}},
    {"name": "submit_hap_qa", "description": "Record QA evidence against exact revision artifact hashes.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "revision_id": {"type": "string"}, "status": {"type": "string", "enum": ["pass", "fail"]}, "method": {"type": "string"}, "checks": {"type": "object"}, "report": {"type": "string"}, "qa_id": {"type": "string"}}, "required": ["project", "revision_id", "status", "method", "checks", "report"]}},
    {"name": "approve_hap_revision", "description": "Delegated-policy approval only. Direct user approval is authenticated Desktop UI work.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "revision_id": {"type": "string"}, "approver_type": {"type": "string", "enum": ["delegated_user_policy"]}, "delegated_grant_id": {"type": "string"}, "approver": {"type": "string"}, "evidence": {"type": "string"}, "approval_id": {"type": "string"}}, "required": ["project", "revision_id", "approver_type", "delegated_grant_id", "approver", "evidence"]}},
    {"name": "compile_prompt_preview", "description": "Compile validated Prompt IR to a non-release preview package.", "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "prompt_ir": {"type": "string"}}, "required": ["project", "prompt_ir"]}},
]


def serve():
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            request_id = request.get("id")
            if method == "initialize":
                output = {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "scene-pipeline", "version": "0.7.0", "toolRegistryVersion": "documents-v1-prompt-jobs-v3"}}}
            elif method == "notifications/initialized":
                continue
            elif method == "tools/list":
                output = {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
            elif method == "tools/call":
                output = {"jsonrpc": "2.0", "id": request_id, "result": call(request["params"]["name"], request["params"].get("arguments", {}))}
            else:
                output = {"jsonrpc": "2.0", "id": request_id, "result": {}}
            sys.stdout.write(json.dumps(output, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as exc:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": request.get("id") if "request" in locals() else None, "error": {"code": -32000, "message": str(exc)}}, ensure_ascii=False) + "\n")
            sys.stdout.flush()


def cli():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--project-status")
    parser.add_argument("--scene")
    parser.add_argument("--packages-root")
    args = parser.parse_args()
    global PACKAGES
    if args.packages_root:
        PACKAGES = Path(args.packages_root).expanduser().resolve()
        package_compiler.PACKAGES = PACKAGES
        scene_breakdown.PACKAGES = PACKAGES
        workspace_compiler.PACKAGES = PACKAGES
    if args.project_status:
        print(json.dumps(read_project_status(args.project_status, args.scene), ensure_ascii=False))
    else:
        serve()


if __name__ == "__main__":
    cli()
