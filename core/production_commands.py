from __future__ import annotations

import hashlib
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace

from core import hap_core

READY_STATES = {"accepted", "verified", "ready"}
ACTIVE_PROMPT_JOB_STATES = {"QUEUED", "CLAIMED", "WRITING", "VALIDATING"}
OBJECT_TYPES = {"beat", "cut", "block", "asset", "prompt", "package"}

STAGES = (
    {"key": "analysis", "label": "Scene Analysis", "entity_types": ("scene",), "required": True},
    {"key": "conti", "label": "Written Conti", "entity_types": ("beat", "block"), "required": True},
    {"key": "assets", "label": "References", "entity_types": ("asset",), "required": True},
    {"key": "storyboard", "label": "Storyboard / Shots", "entity_types": ("cut",), "required": True},
    {"key": "prompts", "label": "Video Prompts", "entity_types": ("prompt",), "required": True},
    {"key": "handoff", "label": "Handoff Package", "entity_types": ("package",), "required": False},
)
STAGE_KEYS = {item["key"] for item in STAGES}
STAGE_ALIASES = {
    "analysis": "analysis", "scene_analysis": "analysis",
    "conti": "conti", "text_conti": "conti", "written_conti": "conti",
    "assets": "assets", "asset": "assets", "references": "assets",
    "storyboard": "storyboard", "shots": "storyboard", "shot": "storyboard",
    "prompts": "prompts", "prompt": "prompts",
    "package": "handoff", "handoff": "handoff", "delivery": "handoff",
}
STATUS_PRIORITY = {"blocked": 0, "stale": 1, "needs_review": 2, "in_progress": 3, "missing": 4, "ready": 5}


def _payload(entity):
    revision = (entity or {}).get("current_revision") or {}
    raw = revision.get("payload_json")
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def stage_for_entity(entity):
    payload = _payload(entity)
    explicit = str(payload.get("production_stage") or payload.get("stage") or "").strip().lower()
    if explicit in STAGE_ALIASES:
        return STAGE_ALIASES[explicit]
    entity_type = str((entity or {}).get("entity_type") or "")
    for stage in STAGES:
        if entity_type in stage["entity_types"]:
            return stage["key"]
    return None


def entity_status(entity):
    state = str((entity or {}).get("state") or "missing").lower()
    if state in READY_STATES:
        return "ready"
    if state in {"blocked", "invalid"}:
        return "blocked"
    if state == "stale":
        return "stale"
    if state == "unverified":
        return "needs_review"
    if state == "working":
        return "in_progress"
    if state == "missing":
        return "missing"
    return "in_progress"


def _entity_ref(entity):
    revision = (entity or {}).get("current_revision") or {}
    return {
        "entity_id": (entity or {}).get("entity_id"),
        "entity_type": (entity or {}).get("entity_type"),
        "logical_key": (entity or {}).get("logical_key"),
        "state": (entity or {}).get("state") or "missing",
        "revision_id": revision.get("revision_id"),
    }


def _reasons(entity):
    messages = []
    for dependency in (entity or {}).get("dependencies") or []:
        if not dependency.get("stale"):
            continue
        label = " ".join(filter(None, [dependency.get("upstream_entity_type"), dependency.get("upstream_logical_key")])) or dependency.get("upstream_entity_id") or "upstream object"
        role = f"{dependency.get('role')}: " if dependency.get("role") else ""
        messages.append(f"{role}{label} changed ({dependency.get('used_revision_id') or 'unknown'} → {dependency.get('current_revision_id') or 'missing'})")
    messages.extend(str(item) for item in ((entity or {}).get("errors") or []))
    return list(dict.fromkeys(messages))


def _action(status):
    return {
        "stale": "regenerate_from_current_inputs",
        "blocked": "resolve_blocker",
        "needs_review": "run_qa_or_review",
        "in_progress": "finish_current_work",
        "missing": "create_stage_outputs",
    }.get(status)


def _descendants(entities, owner_id):
    children = {}
    for entity in entities:
        children.setdefault(entity.get("parent_id"), []).append(entity)
    output, queue, seen = [], list(children.get(owner_id, [])), set()
    while queue:
        entity = queue.pop(0)
        entity_id = entity.get("entity_id")
        if not entity_id or entity_id in seen:
            continue
        seen.add(entity_id)
        output.append(entity)
        queue.extend(children.get(entity_id, []))
    return output


def find_scene_entity(projection, scene_aliases):
    aliases = {str(item) for item in (scene_aliases if isinstance(scene_aliases, (list, tuple, set)) else [scene_aliases]) if item}
    for entity in projection.get("entities") or []:
        if str(entity.get("entity_type")) == "scene" and str(entity.get("logical_key")) in aliases:
            return entity
    return None


def _latest_prompt_job(prompt_jobs):
    return sorted(prompt_jobs or [], key=lambda item: str(item.get("updated_at") or ""), reverse=True)[0] if prompt_jobs else None


def _prompt_fallback(prompt_jobs):
    job = _latest_prompt_job(prompt_jobs)
    if not job:
        return None
    state = str(job.get("state") or "").upper()
    if state in ACTIVE_PROMPT_JOB_STATES:
        return {"status": "in_progress", "reason": f"prompt job {state.lower()}", "job_id": job.get("job_id")}
    if state == "STALE":
        return {"status": "stale", "reason": "latest prompt job is stale", "job_id": job.get("job_id")}
    if state in {"FAILED", "REJECTED"}:
        return {"status": "blocked", "reason": job.get("last_error") or f"prompt job {state.lower()}", "job_id": job.get("job_id")}
    if state in {"READY", "USER_APPROVED", "UPLOAD_READY"}:
        return {"status": "needs_review", "reason": "prompt job output is not yet represented by a ready canonical prompt object", "job_id": job.get("job_id")}
    return None


def _stage_summary(definition, entities, prompt_jobs):
    reasons = list(dict.fromkeys(reason for entity in entities for reason in _reasons(entity)))
    if entities:
        status = min((entity_status(item) for item in entities), key=lambda value: STATUS_PRIORITY.get(value, 99))
    else:
        status = "missing"
        if definition["key"] == "prompts":
            fallback = _prompt_fallback(prompt_jobs)
            if fallback:
                status = fallback["status"]
                reasons.append(fallback["reason"])
    if not entities and not reasons:
        reasons.append("no production objects for this stage")
    refs = [_entity_ref(entity) for entity in entities]
    return {
        "key": definition["key"], "label": definition["label"], "required": definition["required"],
        "status": status, "object_count": len(entities),
        "ready_count": sum(entity_status(entity) == "ready" for entity in entities),
        "stale_count": sum(entity_status(entity) == "stale" for entity in entities),
        "reasons": reasons, "entities": refs, "action": _action(status),
    }


def build_scene_state(projection, scene_aliases):
    owner = find_scene_entity(projection, scene_aliases)
    if owner is None:
        raise ValueError("E_PRODUCTION_SCENE_NOT_FOUND")
    children = _descendants(projection.get("entities") or [], owner.get("entity_id"))
    all_entities = [owner, *children]
    buckets = {stage["key"]: [] for stage in STAGES}
    for entity in all_entities:
        stage = stage_for_entity(entity)
        if stage in buckets:
            buckets[stage].append(entity)
    aliases = {str(item) for item in (scene_aliases if isinstance(scene_aliases, (list, tuple, set)) else [scene_aliases]) if item}
    jobs = [job for job in (projection.get("prompt_jobs") or []) if str(job.get("scene_key")) in aliases]
    stages = [_stage_summary(definition, buckets[definition["key"]], jobs) for definition in STAGES]
    required = [stage for stage in stages if stage["required"]]
    blockers = [
        {"stage": stage["key"], "label": stage["label"], "status": stage["status"], "action": stage["action"],
         "reasons": stage["reasons"], "entity_ids": [item["entity_id"] for item in stage["entities"] if item.get("entity_id")]}
        for stage in required if stage["status"] != "ready"
    ]
    stale_objects = [
        {**_entity_ref(entity), "reasons": _reasons(entity), "dependencies": entity.get("dependencies") or []}
        for entity in all_entities if entity_status(entity) == "stale"
    ]
    ready_count = sum(stage["status"] == "ready" for stage in required)
    generate_ready = bool(required) and not blockers
    status = "ready" if generate_ready else min((item["status"] for item in blockers), key=lambda value: STATUS_PRIORITY.get(value, 99), default="missing")
    return {
        "schema_version": 1, "scene_entity_id": owner.get("entity_id"), "scene_key": owner.get("logical_key"),
        "generate_ready": generate_ready, "status": status,
        "progress": round(ready_count / len(required) * 100) if required else 0,
        "ready_stages": ready_count, "required_stages": len(required),
        "stages": {stage["key"]: stage for stage in stages}, "blockers": blockers,
        "stale_objects": stale_objects, "next_action": blockers[0] if blockers else None,
    }


def prepare_scene(projection, scene_aliases):
    state = build_scene_state(projection, scene_aliases)
    work_plan = []
    for index, blocker in enumerate(state["blockers"], start=1):
        work_plan.append({
            "order": index, "stage": blocker["stage"], "status": blocker["status"], "command": blocker["action"],
            "target_entity_ids": blocker["entity_ids"], "reasons": blocker["reasons"],
        })
    return {**state, "work_plan": work_plan, "message": "Scene is generate-ready." if state["generate_ready"] else f"{len(work_plan)} production step(s) remain."}


def stale_regeneration_plan(projection, scene_aliases):
    state = build_scene_state(projection, scene_aliases)
    stage_rank = {stage["key"]: index for index, stage in enumerate(STAGES)}
    tasks = []
    entities = {entity.get("entity_id"): entity for entity in projection.get("entities") or []}
    for item in state["stale_objects"]:
        entity = entities.get(item["entity_id"], {})
        tasks.append({
            "entity_id": item["entity_id"], "entity_type": item["entity_type"], "logical_key": item["logical_key"],
            "stage": stage_for_entity(entity), "current_revision_id": item["revision_id"], "reasons": item["reasons"],
            "command": "save_production_object", "expected_revision_id": item["revision_id"],
            "instruction": "Regenerate from the current upstream revisions; do not reuse stale dependency revision ids.",
        })
    tasks.sort(key=lambda item: (stage_rank.get(item.get("stage"), 99), str(item.get("logical_key") or "")))
    for index, task in enumerate(tasks, start=1):
        task["order"] = index
    return {"scene": state["scene_key"], "stale_count": len(tasks), "tasks": tasks}


def resolve_object(projection, scene_aliases, *, entity_id=None, object_type=None, logical_key=None):
    owner = find_scene_entity(projection, scene_aliases)
    if owner is None:
        raise ValueError("E_PRODUCTION_SCENE_NOT_FOUND")
    candidates = [owner, *_descendants(projection.get("entities") or [], owner.get("entity_id"))]
    if entity_id:
        matches = [item for item in candidates if item.get("entity_id") == entity_id]
    else:
        matches = [item for item in candidates if (not object_type or item.get("entity_type") == object_type) and item.get("logical_key") == logical_key]
    if len(matches) != 1:
        raise ValueError("E_PRODUCTION_OBJECT_NOT_FOUND" if not matches else "E_PRODUCTION_OBJECT_AMBIGUOUS")
    return matches[0]


def _request_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def save_production_object(root: Path, projection, scene_aliases, request):
    object_type = str(request.get("object_type") or "")
    if object_type not in OBJECT_TYPES:
        raise ValueError("E_PRODUCTION_OBJECT_TYPE_INVALID")
    key = str(request.get("key") or "").strip()
    if not key:
        raise ValueError("E_PRODUCTION_OBJECT_KEY_REQUIRED")
    payload = request.get("payload")
    evidence = request.get("source_evidence")
    if not isinstance(payload, dict):
        raise ValueError("E_PRODUCTION_PAYLOAD_INVALID")
    if not evidence:
        raise ValueError("E_PRODUCTION_SOURCE_EVIDENCE_REQUIRED")
    stage = request.get("stage")
    if stage:
        normalized_stage = STAGE_ALIASES.get(str(stage).lower())
        if normalized_stage not in STAGE_KEYS:
            raise ValueError("E_PRODUCTION_STAGE_INVALID")
        payload = {**payload, "production_stage": normalized_stage}
    db = hap_core.connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        current_projection = projection if projection is not None else hap_core.write_projection(root, db)
        owner = find_scene_entity(current_projection, scene_aliases)
        if owner is None:
            raise ValueError("E_PRODUCTION_SCENE_NOT_FOUND")
        entity = hap_core.ensure_entity(db, entity_type=object_type, logical_key=key, parent_id=owner["entity_id"], workflow_mode="full")
        dependencies = []
        for selector in request.get("dependencies") or []:
            if not isinstance(selector, dict):
                raise ValueError("E_PRODUCTION_DEPENDENCY_INVALID")
            target = resolve_object(
                current_projection, scene_aliases,
                entity_id=selector.get("entity_id"), object_type=selector.get("object_type"), logical_key=selector.get("key"),
            )
            projection_revision_id = (target.get("current_revision") or {}).get("revision_id")
            if not projection_revision_id:
                raise ValueError("E_PRODUCTION_DEPENDENCY_REVISION_MISSING")
            db_current = hap_core.current_revision(db, target["entity_id"])
            if db_current is None:
                raise ValueError("E_PRODUCTION_DEPENDENCY_REVISION_MISSING")
            current_revision_id = db_current["revision_id"]
            if current_revision_id != projection_revision_id:
                raise ValueError(f"E_PRODUCTION_DEPENDENCY_CHANGED:{projection_revision_id}:{current_revision_id}")
            expected_revision_id = str(selector.get("revision_id") or "").strip()
            if expected_revision_id and current_revision_id != expected_revision_id:
                raise ValueError(f"E_PRODUCTION_DEPENDENCY_CHANGED:{expected_revision_id}:{current_revision_id}")
            dependencies.append((current_revision_id, str(selector.get("role") or "input")))
        expected_supplied = "expected_revision_id" in request
        request_body = {
            "object_type": object_type, "key": key, "payload": payload, "source_evidence": evidence,
            "dependencies": request.get("dependencies") or [], "expected_revision_id": request.get("expected_revision_id"),
        }
        revision, reused = hap_core.commit_revision(
            root, db, entity_id=entity["entity_id"], producer=str(request.get("producer") or "codex"),
            payload=payload, source_evidence=evidence, dependencies=dependencies,
            expected_revision_id=request.get("expected_revision_id"), enforce_expected=expected_supplied,
            idempotency_key=request.get("idempotency_key"), request_sha256=_request_hash(request_body), actor=str(request.get("actor") or "codex"),
        )
        db.commit()
        updated_projection = hap_core.write_projection(root, db)
        current = next(item for item in updated_projection["entities"] if item.get("entity_id") == entity["entity_id"])
        return {"entity": _entity_ref(current), "revision_id": revision["revision_id"], "reused": reused, "state": current.get("state"), "errors": current.get("errors") or []}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def approve_production_object(root: Path, projection, scene_aliases, request):
    grant = str(request.get("delegated_grant_id") or "").strip()
    if not grant:
        raise ValueError("E_DELEGATED_GRANT_REQUIRED")
    target = resolve_object(
        projection, scene_aliases,
        entity_id=request.get("entity_id"), object_type=request.get("object_type"), logical_key=request.get("key"),
    )
    revision_id = (target.get("current_revision") or {}).get("revision_id")
    if not revision_id:
        raise ValueError("E_PRODUCTION_REVISION_MISSING")
    db = hap_core.connect(root)
    try:
        current = hap_core.current_revision(db, target["entity_id"])
    finally:
        db.close()
    if current is None or current["revision_id"] != revision_id:
        raise ValueError("E_PRODUCTION_REVISION_SUPERSEDED")
    evidence = json.dumps({"delegated_grant_id": grant, "evidence": request.get("evidence")}, ensure_ascii=False)
    stream = io.StringIO()
    with redirect_stdout(stream):
        hap_core.cmd_approve(SimpleNamespace(
            project=str(root), revision=revision_id, approver_type="delegated_user_policy",
            approver=str(request.get("approver") or "codex"), evidence=evidence,
            approval_id=request.get("approval_id"), delegated_grant_id=grant,
        ))
    return {"entity_id": target.get("entity_id"), "revision_id": revision_id, "approval_id": stream.getvalue().strip(), "delegated_grant_id": grant}
