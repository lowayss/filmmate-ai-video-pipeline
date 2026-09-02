from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from core import filmmate_documents, hap_core, production_agent_jobs, production_commands, production_orchestrator

AUTO_TOOLS = {"save_filmmate_document", "save_production_object"}
MANUAL_TOOLS = {"get_filmmate_prompt_request", "get_filmmate_prompt_job", "submit_hap_qa"}
FORBIDDEN_TOOLS = {"approve_production_object", "approve_hap_revision", "create_hap_revision", "register_hap_artifact"}
STAGE_ORDER = ("analysis", "conti", "assets", "storyboard", "prompts", "handoff")
STAGE_RANK = {stage: index for index, stage in enumerate(STAGE_ORDER)}
STAGE_OBJECT_TYPES = {
    "assets": {"asset"},
    "storyboard": {"cut", "block"},
    "handoff": {"package"},
}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _fresh_projection(root: Path) -> dict[str, Any]:
    db = hap_core.connect(root)
    try:
        return hap_core.write_projection(root, db)
    finally:
        db.close()


def _claim_rows(root: Path, run_id: str, task_id: str):
    db = hap_core.connect(root)
    try:
        db.executescript(production_agent_jobs.DDL)
        run = db.execute("SELECT * FROM production_agent_runs WHERE run_id=?", (run_id,)).fetchone()
        if run is None:
            raise ValueError("E_PRODUCTION_AGENT_RUN_NOT_FOUND")
        task = db.execute(
            "SELECT * FROM production_agent_tasks WHERE run_id=? AND task_id=?",
            (run_id, task_id),
        ).fetchone()
        if task is None:
            raise ValueError("E_PRODUCTION_AGENT_TASK_NOT_FOUND")
        return dict(run), dict(task)
    finally:
        db.close()


def _scene_entities(projection: dict[str, Any], scene_aliases) -> list[dict[str, Any]]:
    owner = production_commands.find_scene_entity(projection, scene_aliases)
    if owner is None:
        raise ValueError("E_PRODUCTION_SCENE_NOT_FOUND")
    entities = projection.get("entities") or []
    children: dict[str | None, list[dict[str, Any]]] = {}
    for entity in entities:
        children.setdefault(entity.get("parent_id"), []).append(entity)
    output = [owner]
    queue = list(children.get(owner.get("entity_id"), []))
    seen = {owner.get("entity_id")}
    while queue:
        entity = queue.pop(0)
        entity_id = entity.get("entity_id")
        if not entity_id or entity_id in seen:
            continue
        seen.add(entity_id)
        output.append(entity)
        queue.extend(children.get(entity_id, []))
    return output


def _entity_context(entity: dict[str, Any]) -> dict[str, Any]:
    revision = entity.get("current_revision") or {}
    raw = revision.get("payload_json")
    if isinstance(raw, dict):
        payload = raw
    else:
        try:
            payload = json.loads(raw) if raw else {}
        except (TypeError, json.JSONDecodeError):
            payload = {}
    return {
        "entity_id": entity.get("entity_id"),
        "entity_type": entity.get("entity_type"),
        "logical_key": entity.get("logical_key"),
        "stage": production_commands.stage_for_entity(entity),
        "state": entity.get("state"),
        "revision_id": revision.get("revision_id"),
        "payload": payload,
        "dependencies": entity.get("dependencies") or [],
        "errors": entity.get("errors") or [],
    }


def _document_context(root: Path, scene_aliases) -> dict[str, Any] | None:
    for alias in scene_aliases:
        try:
            return filmmate_documents.read_documents(root, str(alias))
        except (ValueError, OSError):
            continue
    return None


def _upstream_dependencies(projection: dict[str, Any], scene_aliases, stage: str | None) -> list[dict[str, Any]]:
    rank = STAGE_RANK.get(str(stage or ""), 99)
    output = []
    for entity in _scene_entities(projection, scene_aliases):
        entity_stage = production_commands.stage_for_entity(entity)
        revision = entity.get("current_revision") or {}
        revision_id = revision.get("revision_id")
        if not revision_id or STAGE_RANK.get(str(entity_stage or ""), 99) >= rank:
            continue
        output.append({
            "entity_id": entity.get("entity_id"),
            "role": str(entity_stage or "input"),
            "revision_id": revision_id,
        })
    output.sort(key=lambda item: (STAGE_RANK.get(item["role"], 99), str(item["entity_id"])))
    return output


def _target_entity(task: dict[str, Any], projection: dict[str, Any]) -> dict[str, Any] | None:
    ids = set(json.loads(task.get("entity_ids_json") or "[]"))
    if not ids:
        return None
    candidates = [entity for entity in (projection.get("entities") or []) if entity.get("entity_id") in ids]
    candidates.sort(key=lambda item: (
        0 if production_commands.entity_status(item) == "stale" else 1,
        str(item.get("logical_key") or ""),
    ))
    return candidates[0] if candidates else None


def task_execution_mode(task: dict[str, Any]) -> tuple[str, str | None]:
    tool = str(task.get("suggested_tool") or "")
    stage = str(task.get("stage") or "")
    status = str(task.get("plan_status") or "")
    if tool in FORBIDDEN_TOOLS:
        return "manual", "forbidden_semantic_tool"
    if status in {"blocked", "needs_review", "in_progress"}:
        return "manual", f"task_status_{status}"
    if stage == "prompts":
        return "manual", "prompt_pipeline_requires_specialized_prompt_job"
    if tool in MANUAL_TOOLS:
        return "manual", "specialized_or_review_tool"
    if tool not in AUTO_TOOLS:
        return "manual", "unsupported_semantic_tool"
    return "proposal", None


def build_work_order(
    root: Path,
    projection: dict[str, Any] | None,
    scene_aliases,
    *,
    run_id: str,
    task_id: str,
    claim_token: str,
) -> dict[str, Any]:
    run, task = _claim_rows(root, run_id, task_id)
    if task.get("state") != "CLAIMED" or task.get("claim_token") != claim_token:
        raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
    if run.get("paused") or run.get("cancelled"):
        raise ValueError("E_PRODUCTION_AGENT_RUN_NOT_EXECUTABLE")
    current_projection = projection if projection is not None else _fresh_projection(root)
    plan = production_orchestrator.build_plan(
        current_projection,
        scene_aliases,
        goal=run.get("goal"),
        target=run.get("target"),
        previous_checkpoint=task.get("claim_checkpoint"),
    )
    if plan.get("checkpoint") != task.get("claim_checkpoint"):
        raise ValueError("E_PRODUCTION_AGENT_CLAIM_CHECKPOINT_CHANGED")
    mode, reason = task_execution_mode(task)
    entities = _scene_entities(current_projection, scene_aliases)
    affected_ids = set(json.loads(task.get("entity_ids_json") or "[]"))
    affected = [_entity_context(entity) for entity in entities if entity.get("entity_id") in affected_ids]
    target = _target_entity(task, current_projection)
    documents = _document_context(root, scene_aliases) if task.get("suggested_tool") == "save_filmmate_document" else None
    return {
        "schema_version": 1,
        "run_id": run_id,
        "task_id": task_id,
        "scene": run.get("scene_key"),
        "goal": run.get("goal"),
        "target": run.get("target"),
        "claim_token": claim_token,
        "claim_checkpoint": task.get("claim_checkpoint"),
        "mode": mode,
        "manual_reason": reason,
        "stage": task.get("stage"),
        "status": task.get("plan_status"),
        "action": task.get("action"),
        "suggested_tool": task.get("suggested_tool"),
        "instruction": task.get("instruction"),
        "reasons": json.loads(task.get("reasons_json") or "[]"),
        "target_entity": _entity_context(target) if target else None,
        "affected_entities": affected,
        "upstream_dependencies": _upstream_dependencies(current_projection, scene_aliases, task.get("stage")),
        "documents": documents,
        "execution_policy": {
            "codex_project_access": "read_only",
            "semantic_write_only": True,
            "automatic_approval_forbidden": True,
            "direct_file_mutation_forbidden": True,
            "checkpoint_must_match_claim": True,
            "binary_artifact_fabrication_forbidden": True,
        },
    }


def _contains_forbidden_key(value: Any) -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            if "approv" in lowered or lowered in {"delegated_grant_id", "approval_id", "claim_token", "project_root"}:
                return True
            if _contains_forbidden_key(child):
                return True
    elif isinstance(value, list):
        return any(_contains_forbidden_key(item) for item in value)
    return False


def validate_proposal(work_order: dict[str, Any], proposal: Any) -> dict[str, Any]:
    if not isinstance(proposal, dict) or proposal.get("schema_version") != 1:
        raise ValueError("E_PRODUCTION_AGENT_PROPOSAL_INVALID")
    decision = str(proposal.get("decision") or "")
    if decision not in {"execute", "needs_user_input"}:
        raise ValueError("E_PRODUCTION_AGENT_PROPOSAL_DECISION_INVALID")
    if decision == "needs_user_input":
        reason = str(proposal.get("reason") or "").strip()
        if not reason:
            raise ValueError("E_PRODUCTION_AGENT_USER_INPUT_REASON_REQUIRED")
        return {"schema_version": 1, "decision": decision, "tool": None, "args": {}, "reason": reason}
    if work_order.get("mode") != "proposal":
        raise ValueError("E_PRODUCTION_AGENT_TASK_NOT_AUTOMATABLE")
    tool = str(proposal.get("tool") or "")
    if tool in FORBIDDEN_TOOLS or tool != work_order.get("suggested_tool") or tool not in AUTO_TOOLS:
        raise ValueError("E_PRODUCTION_AGENT_TOOL_MISMATCH")
    args = proposal.get("args")
    if not isinstance(args, dict) or _contains_forbidden_key(args):
        raise ValueError("E_PRODUCTION_AGENT_PROPOSAL_ARGS_INVALID")
    if tool == "save_filmmate_document":
        if work_order.get("stage") != "conti":
            raise ValueError("E_PRODUCTION_AGENT_DOCUMENT_STAGE_INVALID")
        kind = str(args.get("kind") or "conti")
        content = str(args.get("content") or "")
        if kind != "conti" or not content.strip():
            raise ValueError("E_PRODUCTION_AGENT_CONTI_PROPOSAL_INVALID")
        return {"schema_version": 1, "decision": decision, "tool": tool, "args": {"kind": "conti", "content": content}, "reason": None}
    if tool == "save_production_object":
        stage = str(work_order.get("stage") or "")
        allowed_types = STAGE_OBJECT_TYPES.get(stage)
        if not allowed_types:
            raise ValueError("E_PRODUCTION_AGENT_OBJECT_STAGE_INVALID")
        target = work_order.get("target_entity") or {}
        object_type = str(target.get("entity_type") or args.get("object_type") or "")
        key = str(target.get("logical_key") or args.get("key") or "").strip()
        payload = args.get("payload")
        if object_type not in allowed_types or not key or not isinstance(payload, dict):
            raise ValueError("E_PRODUCTION_AGENT_OBJECT_PROPOSAL_INVALID")
        return {
            "schema_version": 1,
            "decision": decision,
            "tool": tool,
            "args": {"object_type": object_type, "key": key, "stage": stage, "payload": payload},
            "reason": None,
        }
    raise ValueError("E_PRODUCTION_AGENT_TOOL_UNSUPPORTED")


def _idempotency_key(work_order: dict[str, Any], normalized: dict[str, Any]) -> str:
    digest = hashlib.sha256(_json(normalized).encode("utf-8")).hexdigest()
    return f"production-agent:{work_order['run_id']}:{work_order['task_id']}:{work_order['claim_checkpoint']}:{digest}"


def _claim_guard(work_order: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": work_order["run_id"],
        "task_id": work_order["task_id"],
        "claim_token": work_order["claim_token"],
        "claim_checkpoint": work_order["claim_checkpoint"],
    }


def _release(root: Path, work_order: dict[str, Any], error: str, actor: str):
    return production_agent_jobs.control_run(
        root,
        work_order["run_id"],
        "release_task",
        actor=actor,
        task_id=work_order["task_id"],
        claim_token=work_order["claim_token"],
        error=error,
    )


def apply_proposal(
    root: Path,
    projection: dict[str, Any] | None,
    scene_aliases,
    *,
    run_id: str,
    task_id: str,
    claim_token: str,
    proposal: Any,
    actor: str = "codex-worker",
) -> dict[str, Any]:
    work_order = build_work_order(
        root, projection, scene_aliases, run_id=run_id, task_id=task_id, claim_token=claim_token
    )
    normalized = validate_proposal(work_order, proposal)
    claim_guard = _claim_guard(work_order)
    if normalized["decision"] == "needs_user_input":
        snapshot = _release(root, work_order, f"E_PRODUCTION_AGENT_USER_INPUT_REQUIRED:{normalized['reason']}", actor)
        return {"applied": False, "resolved": False, "progress_made": False, "stop_reason": "needs_user_input", "work_order": work_order, "run": snapshot}

    if normalized["tool"] == "save_filmmate_document":
        documents = work_order.get("documents") or {}
        docs = documents.get("documents") or {}
        screenplay = docs.get("screenplay") or {}
        conti = docs.get("conti") or {}
        if not screenplay.get("revision_id"):
            raise ValueError("E_PRODUCTION_AGENT_SCENE_REVISION_REQUIRED")
        mutation = filmmate_documents.save_document({
            "project_root": str(root),
            "scene": documents.get("scene") or work_order.get("scene"),
            "kind": "conti",
            "content": normalized["args"]["content"],
            "actor": "codex",
            "expected_revision_id": conti.get("revision_id"),
            "expected_scene_revision_id": screenplay.get("revision_id"),
            "idempotency_key": _idempotency_key(work_order, normalized),
            "claim_guard": claim_guard,
        })
    elif normalized["tool"] == "save_production_object":
        target = work_order.get("target_entity") or {}
        dependencies = [
            {"entity_id": item["entity_id"], "role": item["role"], "revision_id": item["revision_id"]}
            for item in (work_order.get("upstream_dependencies") or [])
        ]
        evidence = [{
            "kind": "production_agent_worker",
            "run_id": run_id,
            "task_id": task_id,
            "claim_checkpoint": work_order.get("claim_checkpoint"),
            "upstream_revision_ids": [item["revision_id"] for item in (work_order.get("upstream_dependencies") or [])],
            "engine": "Codex CLI proposal / FilmMate semantic executor",
        }]
        request = {
            **normalized["args"],
            "source_evidence": evidence,
            "dependencies": dependencies,
            "expected_revision_id": target.get("revision_id") if target else None,
            "producer": "production-agent-codex",
            "actor": "codex",
            "idempotency_key": _idempotency_key(work_order, normalized),
            "claim_guard": claim_guard,
        }
        mutation = production_commands.save_production_object(root, None, scene_aliases, request)
    else:
        raise ValueError("E_PRODUCTION_AGENT_TOOL_UNSUPPORTED")

    snapshot = production_agent_jobs.refresh_run(root, run_id, None, scene_aliases, actor=actor)
    task = next((item for item in snapshot.get("tasks") or [] if item.get("task_id") == task_id), None)
    progress_made = snapshot.get("checkpoint") != work_order.get("claim_checkpoint")
    resolved = bool(task and task.get("state") == "COMPLETE")
    if task and task.get("state") == "CLAIMED":
        message = "canonical_progress_partial" if progress_made else "E_PRODUCTION_AGENT_CANONICAL_STATE_UNCHANGED"
        _release(root, work_order, message, actor)
        snapshot = production_agent_jobs.refresh_run(root, run_id, None, scene_aliases, actor=actor)
    return {
        "applied": True,
        "resolved": resolved,
        "progress_made": progress_made,
        "stop_reason": None if resolved or progress_made else "canonical_state_unchanged",
        "mutation": mutation,
        "run": snapshot,
    }
