from __future__ import annotations

import hashlib
import json
from typing import Any

from core import production_commands

TARGET_GENERATE_READY = "generate_ready"
TARGET_HANDOFF_READY = "handoff_ready"
TARGET_STALE_CLEAR = "stale_clear"
TARGETS = {TARGET_GENERATE_READY, TARGET_HANDOFF_READY, TARGET_STALE_CLEAR}

STAGE_ORDER = ("analysis", "conti", "assets", "storyboard", "prompts", "handoff")
STAGE_RANK = {stage: index for index, stage in enumerate(STAGE_ORDER)}


def infer_target(goal: str | None = None, explicit: str | None = None) -> str:
    if explicit:
        value = str(explicit).strip().lower()
        if value not in TARGETS:
            raise ValueError("E_PRODUCTION_AGENT_TARGET_INVALID")
        return value
    text = str(goal or "").strip().lower()
    if any(token in text for token in ("handoff", "upload", "delivery", "패키지", "업로드", "납품", "전달")):
        return TARGET_HANDOFF_READY
    if any(token in text for token in ("stale", "regenerate", "refresh", "재생성", "업데이트", "낡은", "최신화")):
        return TARGET_STALE_CLEAR
    return TARGET_GENERATE_READY


def _entity_checkpoint(entity: dict[str, Any]) -> dict[str, Any]:
    current = entity.get("current_revision") or {}
    return {
        "entity_id": entity.get("entity_id"),
        "state": entity.get("state"),
        "revision_id": current.get("revision_id"),
        "dependencies": [
            {
                "role": item.get("role"),
                "used": item.get("used_revision_id"),
                "current": item.get("current_revision_id"),
                "stale": bool(item.get("stale")),
            }
            for item in (entity.get("dependencies") or [])
        ],
    }


def checkpoint(projection: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    scene_id = state.get("scene_entity_id")
    scene_entities = []
    if scene_id:
        children_by_parent: dict[str | None, list[dict[str, Any]]] = {}
        for entity in projection.get("entities") or []:
            children_by_parent.setdefault(entity.get("parent_id"), []).append(entity)
        queue = [entity for entity in projection.get("entities") or [] if entity.get("entity_id") == scene_id]
        seen = set()
        while queue:
            entity = queue.pop(0)
            entity_id = entity.get("entity_id")
            if not entity_id or entity_id in seen:
                continue
            seen.add(entity_id)
            scene_entities.append(_entity_checkpoint(entity))
            queue.extend(children_by_parent.get(entity_id, []))
    aliases = {str(state.get("scene_key") or "")}
    prompt_jobs = [
        {
            "job_id": job.get("job_id"),
            "state": job.get("state"),
            "output_revision_id": job.get("output_revision_id"),
            "updated_at": job.get("updated_at"),
        }
        for job in (projection.get("prompt_jobs") or [])
        if str(job.get("scene_key") or "") in aliases
    ]
    basis = {
        "scene_entity_id": scene_id,
        "generate_ready": state.get("generate_ready"),
        "status": state.get("status"),
        "entities": sorted(scene_entities, key=lambda item: str(item.get("entity_id") or "")),
        "prompt_jobs": sorted(prompt_jobs, key=lambda item: str(item.get("job_id") or "")),
    }
    encoded = json.dumps(basis, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {"token": hashlib.sha256(encoded).hexdigest(), "basis": basis}


def _stage_blockers(state: dict[str, Any], target: str) -> list[dict[str, Any]]:
    if target == TARGET_STALE_CLEAR:
        return [
            {
                "stage": item.get("stage"),
                "label": item.get("stage") or "stale object",
                "status": "stale",
                "action": "regenerate_from_current_inputs",
                "reasons": item.get("reasons") or [],
                "entity_ids": [item.get("entity_id")] if item.get("entity_id") else [],
                "expected_revision_id": item.get("revision_id"),
            }
            for item in (state.get("stale_objects") or [])
        ]
    blockers = [dict(item) for item in (state.get("blockers") or [])]
    if target == TARGET_HANDOFF_READY:
        handoff = (state.get("stages") or {}).get("handoff") or {}
        if handoff.get("status") != "ready":
            blockers.append({
                "stage": "handoff",
                "label": handoff.get("label") or "Handoff Package",
                "status": handoff.get("status") or "missing",
                "action": handoff.get("action") or "create_stage_outputs",
                "reasons": handoff.get("reasons") or ["handoff package is not ready"],
                "entity_ids": [item.get("entity_id") for item in (handoff.get("entities") or []) if item.get("entity_id")],
            })
    return blockers


def _suggested_tool(stage: str | None, status: str | None, *, entity_ids: list[str] | None = None) -> str | None:
    if status == "stale":
        return "save_production_object"
    if status == "blocked":
        return None
    if status == "needs_review":
        return "submit_hap_qa"
    if status == "in_progress":
        return "get_filmmate_prompt_job" if stage == "prompts" else None
    if status == "missing":
        if stage == "conti":
            return "save_filmmate_document"
        if stage == "prompts":
            return "get_filmmate_prompt_request"
        if stage in {"assets", "storyboard", "handoff"}:
            return "save_production_object"
        return None
    return None


def _stop_reason(step: dict[str, Any] | None, reached: bool) -> str:
    if reached:
        return "target_reached"
    if not step:
        return "no_action_available"
    status = step.get("status")
    if status == "blocked":
        return "blocked"
    if status == "needs_review":
        return "waiting_for_qa_or_review"
    if status == "in_progress":
        return "waiting_for_current_work"
    if status in {"missing", "stale"}:
        return "waiting_for_agent_output"
    return "waiting_for_next_step"


def _instruction(step: dict[str, Any]) -> str:
    stage = step.get("stage") or "production"
    status = step.get("status")
    if status == "stale":
        return f"Regenerate the {stage} output from current upstream revisions, then save it as a new canonical revision."
    if status == "missing":
        return f"Create the missing {stage} output from canonical inputs, then save it through the suggested semantic tool."
    if status == "needs_review":
        return f"Run QA/review for the current {stage} revision; do not approve or mark it ready without passing evidence."
    if status == "in_progress":
        return f"Resume or inspect the current {stage} work and re-run the production agent after it changes canonical state."
    if status == "blocked":
        return f"Resolve the blocker on {stage}; the production agent will not bypass it."
    return f"Resolve the current {stage} step and re-check canonical state."


def build_plan(
    projection: dict[str, Any],
    scene_aliases,
    *,
    goal: str | None = None,
    target: str | None = None,
    previous_checkpoint: str | None = None,
) -> dict[str, Any]:
    resolved_target = infer_target(goal, target)
    state = production_commands.build_scene_state(projection, scene_aliases)
    cp = checkpoint(projection, state)
    blockers = _stage_blockers(state, resolved_target)
    blockers.sort(key=lambda item: (STAGE_RANK.get(item.get("stage"), 99), str(item.get("entity_ids") or "")))
    steps = []
    for index, blocker in enumerate(blockers, start=1):
        stage = blocker.get("stage")
        status = blocker.get("status")
        tool = _suggested_tool(stage, status, entity_ids=blocker.get("entity_ids"))
        step = {
            "order": index,
            "stage": stage,
            "label": blocker.get("label"),
            "status": status,
            "action": blocker.get("action"),
            "reasons": blocker.get("reasons") or [],
            "entity_ids": blocker.get("entity_ids") or [],
            "expected_revision_id": blocker.get("expected_revision_id"),
            "suggested_tool": tool,
            "requires_creative_output": status in {"missing", "stale"},
            "requires_qa_or_review": status == "needs_review",
            "requires_user_action": status == "blocked",
            "auto_execute": False,
        }
        step["instruction"] = _instruction(step)
        step["after_step"] = "Re-run run_production_agent with this checkpoint token after canonical state changes."
        steps.append(step)
    reached = not steps
    next_step = steps[0] if steps else None
    checkpoint_changed = None if previous_checkpoint is None else previous_checkpoint != cp["token"]
    return {
        "schema_version": 1,
        "goal": str(goal or "").strip() or None,
        "target": resolved_target,
        "scene": state.get("scene_key"),
        "generate_ready": state.get("generate_ready"),
        "target_reached": reached,
        "status": "ready" if reached else state.get("status"),
        "progress": state.get("progress"),
        "checkpoint": cp["token"],
        "checkpoint_changed": checkpoint_changed,
        "previous_checkpoint": previous_checkpoint,
        "stop_reason": _stop_reason(next_step, reached),
        "next_step": next_step,
        "steps": steps,
        "production": state,
        "execution_policy": {
            "stateless": True,
            "recheck_after_every_write": True,
            "fake_completion_forbidden": True,
            "automatic_approval_forbidden": True,
            "stale_dependency_reuse_forbidden": True,
        },
    }
