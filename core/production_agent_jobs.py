from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from core import hap_core, production_agent_policy, production_orchestrator

RUN_STATES = {"READY", "PAUSED", "WAITING_REVIEW", "WAITING_WORK", "BLOCKED", "COMPLETE", "CANCELLED", "FAILED"}
TASK_STATES = {"PENDING", "CLAIMED", "WAITING_REVIEW", "WAITING_WORK", "BLOCKED", "COMPLETE", "FAILED"}
DEFAULT_CLAIM_LEASE_SECONDS = production_agent_policy.DEFAULT_CLAIM_LEASE_SECONDS

DDL = """
CREATE TABLE IF NOT EXISTS production_agent_runs(
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES entities(entity_id),
  scene_key TEXT NOT NULL,
  goal TEXT,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  actor TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS production_agent_tasks(
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES production_agent_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  signature TEXT NOT NULL,
  stage TEXT,
  state TEXT NOT NULL,
  plan_status TEXT NOT NULL,
  action TEXT,
  suggested_tool TEXT,
  expected_revision_id TEXT,
  entity_ids_json TEXT NOT NULL DEFAULT '[]',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  instruction TEXT NOT NULL DEFAULT '',
  claim_actor TEXT,
  claim_token TEXT,
  claim_checkpoint TEXT,
  claimed_at TEXT,
  claim_lease_seconds INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, signature)
);
CREATE TABLE IF NOT EXISTS production_agent_events(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES production_agent_runs(run_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES production_agent_tasks(task_id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_scene ON production_agent_runs(scene_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_run ON production_agent_tasks(run_id, ordinal, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON production_agent_tasks(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON production_agent_events(run_id, event_id);
"""


def _connect(root: Path):
    db = hap_core.connect(root)
    db.executescript(DDL)
    columns = {row[1] for row in db.execute("PRAGMA table_info(production_agent_tasks)").fetchall()}
    if "claim_lease_seconds" not in columns:
        db.execute("ALTER TABLE production_agent_tasks ADD COLUMN claim_lease_seconds INTEGER")
    db.commit()
    return db


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _event(db, run_id: str, event: str, actor: str, detail: dict[str, Any] | None = None, task_id: str | None = None):
    db.execute(
        "INSERT INTO production_agent_events(run_id,task_id,event,actor,detail_json,created_at) VALUES(?,?,?,?,?,?)",
        (run_id, task_id, event, actor, _json(detail or {}), hap_core.now()),
    )


def _projection_for_plan(root: Path, db, projection: dict[str, Any] | None):
    return projection if projection is not None else hap_core.write_projection(root, db)


def _row_claim_lease_seconds(row, fallback: Any = None) -> int:
    try:
        stored = row["claim_lease_seconds"]
    except (IndexError, KeyError, TypeError):
        stored = None
    if stored is not None:
        return production_agent_policy.resolve_claim_lease_seconds(stored)
    return production_agent_policy.resolve_claim_lease_seconds(fallback)


def _claim_expired(row, *, now: datetime, lease_seconds: int | None = None) -> bool:
    return production_agent_policy.claim_is_expired(
        row["claimed_at"],
        now=now,
        lease_seconds=_row_claim_lease_seconds(row, lease_seconds),
    )


def _expire_claim_row(db, row, actor: str, *, lease_seconds: int | None = None) -> bool:
    base = _base_task_state({"status": row["plan_status"]})
    effective_lease = _row_claim_lease_seconds(row, lease_seconds)
    now = hap_core.now()
    cursor = db.execute(
        "UPDATE production_agent_tasks SET state=?,claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,last_error='claim_lease_expired',updated_at=? WHERE task_id=? AND state='CLAIMED' AND claim_token=?",
        (base, now, row["task_id"], row["claim_token"]),
    )
    if cursor.rowcount != 1:
        return False
    _event(
        db,
        row["run_id"],
        "task_claim_expired",
        actor,
        {
            "claim_actor": row["claim_actor"],
            "claimed_at": row["claimed_at"],
            "lease_seconds": effective_lease,
        },
        row["task_id"],
    )
    return True


def _recover_expired_claims(db, run_id: str, actor: str, *, lease_seconds: int = DEFAULT_CLAIM_LEASE_SECONDS) -> int:
    now_dt = datetime.now(timezone.utc)
    recovered = 0
    rows = db.execute(
        "SELECT * FROM production_agent_tasks WHERE run_id=? AND state='CLAIMED' ORDER BY ordinal,created_at",
        (run_id,),
    ).fetchall()
    for row in rows:
        if not _claim_expired(row, now=now_dt, lease_seconds=lease_seconds):
            continue
        if _expire_claim_row(db, row, actor, lease_seconds=lease_seconds):
            recovered += 1
    return recovered


def _task_signature(step: dict[str, Any]) -> str:
    basis = {
        "stage": step.get("stage"),
        "status": step.get("status"),
        "action": step.get("action"),
        "suggested_tool": step.get("suggested_tool"),
        "expected_revision_id": step.get("expected_revision_id"),
        "entity_ids": sorted(str(item) for item in (step.get("entity_ids") or [])),
    }
    return hashlib.sha256(_json(basis).encode("utf-8")).hexdigest()


def _base_task_state(step: dict[str, Any]) -> str:
    status = step.get("status")
    if status == "blocked":
        return "BLOCKED"
    if status == "needs_review":
        return "WAITING_REVIEW"
    if status == "in_progress":
        return "WAITING_WORK"
    return "PENDING"


def _release_claimed_tasks_for_control(db, run_id: str, actor: str, reason: str) -> int:
    now = hap_core.now()
    released = 0
    rows = db.execute(
        "SELECT * FROM production_agent_tasks WHERE run_id=? AND state='CLAIMED' ORDER BY ordinal,created_at",
        (run_id,),
    ).fetchall()
    for row in rows:
        base = _base_task_state({"status": row["plan_status"]})
        cursor = db.execute(
            "UPDATE production_agent_tasks SET state=?,claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,last_error=NULL,updated_at=? WHERE task_id=? AND state='CLAIMED' AND claim_token=?",
            (base, now, row["task_id"], row["claim_token"]),
        )
        if cursor.rowcount != 1:
            continue
        released += 1
        _event(
            db,
            run_id,
            "task_claim_released_by_run_control",
            actor,
            {"reason": reason, "claim_actor": row["claim_actor"]},
            row["task_id"],
        )
    return released


def _run_state(plan: dict[str, Any], *, paused: bool = False, cancelled: bool = False) -> str:
    if cancelled:
        return "CANCELLED"
    if paused:
        return "PAUSED"
    if plan.get("target_reached"):
        return "COMPLETE"
    next_step = plan.get("next_step") or {}
    status = next_step.get("status")
    if status == "blocked":
        return "BLOCKED"
    if status == "needs_review":
        return "WAITING_REVIEW"
    if status == "in_progress":
        return "WAITING_WORK"
    return "READY"


def _project_id(db) -> str:
    row = db.execute("SELECT entity_id FROM entities WHERE entity_type='project' ORDER BY created_at LIMIT 1").fetchone()
    if row is None:
        raise ValueError("E_PRODUCTION_AGENT_PROJECT_ENTITY_MISSING")
    return row["entity_id"]


def _run_row(db, run_id: str):
    row = db.execute("SELECT * FROM production_agent_runs WHERE run_id=?", (run_id,)).fetchone()
    if row is None:
        raise ValueError("E_PRODUCTION_AGENT_RUN_NOT_FOUND")
    return row


def _task_row(db, run_id: str, task_id: str):
    row = db.execute("SELECT * FROM production_agent_tasks WHERE run_id=? AND task_id=?", (run_id, task_id)).fetchone()
    if row is None:
        raise ValueError("E_PRODUCTION_AGENT_TASK_NOT_FOUND")
    return row


def _sync_tasks(db, run_row, plan: dict[str, Any], actor: str):
    run_id = run_row["run_id"]
    now = hap_core.now()
    existing = db.execute("SELECT * FROM production_agent_tasks WHERE run_id=? ORDER BY ordinal,created_at", (run_id,)).fetchall()
    active = {row["signature"]: row for row in existing if row["state"] != "COMPLETE"}
    desired = []
    for step in plan.get("steps") or []:
        signature = _task_signature(step)
        desired.append((signature, step))
    desired_signatures = {signature for signature, _ in desired}

    for signature, row in active.items():
        if signature in desired_signatures:
            continue
        db.execute(
            "UPDATE production_agent_tasks SET state='COMPLETE',claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,updated_at=? WHERE task_id=?",
            (now, row["task_id"]),
        )
        _event(db, run_id, "task_resolved_from_canonical_state", actor, {"previous_checkpoint": run_row["checkpoint"], "checkpoint": plan.get("checkpoint")}, row["task_id"])

    for ordinal, (signature, step) in enumerate(desired, start=1):
        row = db.execute("SELECT * FROM production_agent_tasks WHERE run_id=? AND signature=?", (run_id, signature)).fetchone()
        base_state = _base_task_state(step)
        if row is None:
            task_id = hap_core.new_id("agent_task", f"{run_id}|{signature}")
            db.execute(
                "INSERT INTO production_agent_tasks(task_id,run_id,ordinal,signature,stage,state,plan_status,action,suggested_tool,expected_revision_id,entity_ids_json,reasons_json,instruction,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    task_id, run_id, ordinal, signature, step.get("stage"), base_state, str(step.get("status") or ""),
                    step.get("action"), step.get("suggested_tool"), step.get("expected_revision_id"),
                    _json(step.get("entity_ids") or []), _json(step.get("reasons") or []), str(step.get("instruction") or ""), now, now,
                ),
            )
            _event(db, run_id, "task_queued", actor, {"ordinal": ordinal, "stage": step.get("stage"), "state": base_state}, task_id)
            continue
        state = row["state"] if row["state"] in {"CLAIMED", "FAILED"} else base_state
        db.execute(
            "UPDATE production_agent_tasks SET ordinal=?,stage=?,state=?,plan_status=?,action=?,suggested_tool=?,expected_revision_id=?,entity_ids_json=?,reasons_json=?,instruction=?,updated_at=? WHERE task_id=?",
            (
                ordinal, step.get("stage"), state, str(step.get("status") or ""), step.get("action"), step.get("suggested_tool"),
                step.get("expected_revision_id"), _json(step.get("entity_ids") or []), _json(step.get("reasons") or []),
                str(step.get("instruction") or ""), now, row["task_id"],
            ),
        )


def _task_dict(row):
    return {
        "task_id": row["task_id"],
        "order": row["ordinal"],
        "stage": row["stage"],
        "state": row["state"],
        "plan_status": row["plan_status"],
        "action": row["action"],
        "suggested_tool": row["suggested_tool"],
        "expected_revision_id": row["expected_revision_id"],
        "entity_ids": json.loads(row["entity_ids_json"] or "[]"),
        "reasons": json.loads(row["reasons_json"] or "[]"),
        "instruction": row["instruction"],
        "claim_actor": row["claim_actor"],
        "claim_token": row["claim_token"],
        "claim_checkpoint": row["claim_checkpoint"],
        "claimed_at": row["claimed_at"],
        "claim_lease_seconds": row["claim_lease_seconds"],
        "last_error": row["last_error"],
        "updated_at": row["updated_at"],
    }


def _snapshot(db, run_id: str, plan: dict[str, Any] | None = None):
    run = _run_row(db, run_id)
    tasks = db.execute("SELECT * FROM production_agent_tasks WHERE run_id=? ORDER BY ordinal,created_at", (run_id,)).fetchall()
    events = db.execute("SELECT event_id,task_id,event,actor,detail_json,created_at FROM production_agent_events WHERE run_id=? ORDER BY event_id DESC LIMIT 50", (run_id,)).fetchall()
    return {
        "run_id": run["run_id"],
        "scene": run["scene_key"],
        "goal": run["goal"],
        "target": run["target"],
        "state": run["state"],
        "checkpoint": run["checkpoint"],
        "paused": bool(run["paused"]),
        "cancelled": bool(run["cancelled"]),
        "last_error": run["last_error"],
        "created_at": run["created_at"],
        "updated_at": run["updated_at"],
        "tasks": [_task_dict(row) for row in tasks],
        "active_tasks": [_task_dict(row) for row in tasks if row["state"] not in {"COMPLETE", "FAILED"}],
        "events": [
            {"event_id": row["event_id"], "task_id": row["task_id"], "event": row["event"], "actor": row["actor"], "detail": json.loads(row["detail_json"] or "{}"), "created_at": row["created_at"]}
            for row in events
        ],
        "production_plan": plan,
    }


def _refresh_locked(
    root: Path,
    db,
    run_id: str,
    projection: dict[str, Any] | None,
    scene_aliases,
    *,
    actor: str,
    claim_lease_seconds: int,
):
    run = _run_row(db, run_id)
    current_projection = _projection_for_plan(root, db, projection)
    plan = production_orchestrator.build_plan(
        current_projection, scene_aliases, goal=run["goal"], target=run["target"], previous_checkpoint=run["checkpoint"]
    )
    _sync_tasks(db, run, plan, actor)
    _recover_expired_claims(db, run_id, actor, lease_seconds=claim_lease_seconds)
    state = _run_state(plan, paused=bool(run["paused"]), cancelled=bool(run["cancelled"]))
    failed = db.execute("SELECT 1 FROM production_agent_tasks WHERE run_id=? AND state='FAILED' LIMIT 1", (run_id,)).fetchone()
    if failed is not None and not run["paused"] and not run["cancelled"]:
        state = "FAILED"
    now = hap_core.now()
    db.execute(
        "UPDATE production_agent_runs SET state=?,checkpoint=?,updated_at=? WHERE run_id=?",
        (state, plan["checkpoint"], now, run_id),
    )
    if plan.get("checkpoint_changed"):
        _event(db, run_id, "canonical_checkpoint_changed", actor, {"from": run["checkpoint"], "to": plan["checkpoint"]})
    if state == "COMPLETE" and run["state"] != "COMPLETE":
        _event(db, run_id, "target_reached", actor, {"target": run["target"]})
    return _run_row(db, run_id), plan


def _commit_claim_rejection(db, message: str):
    db.commit()
    raise ValueError(message)


def start_run(root: Path, projection: dict[str, Any] | None, scene_aliases, *, goal: str | None = None, target: str | None = None, actor: str = "codex"):
    db = _connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        current_projection = _projection_for_plan(root, db, projection)
        plan = production_orchestrator.build_plan(current_projection, scene_aliases, goal=goal, target=target)
        project_id = _project_id(db)
        now = hap_core.now()
        creation_nonce = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        run_id = hap_core.new_id("agent_run", f"{project_id}|{plan.get('scene')}|{plan.get('target')}|{goal or ''}|{creation_nonce}")
        state = _run_state(plan)
        db.execute(
            "INSERT INTO production_agent_runs(run_id,project_id,scene_key,goal,target,state,checkpoint,actor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (run_id, project_id, str(plan.get("scene") or ""), goal, plan["target"], state, plan["checkpoint"], actor, now, now),
        )
        run = _run_row(db, run_id)
        _sync_tasks(db, run, plan, actor)
        _event(db, run_id, "run_started", actor, {"target": plan["target"], "checkpoint": plan["checkpoint"], "state": state})
        db.commit()
        return _snapshot(db, run_id, plan)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def refresh_run(root: Path, run_id: str, projection: dict[str, Any] | None, scene_aliases, *, actor: str = "codex", claim_lease_seconds: int = DEFAULT_CLAIM_LEASE_SECONDS):
    db = _connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        _, plan = _refresh_locked(
            root, db, run_id, projection, scene_aliases, actor=actor, claim_lease_seconds=claim_lease_seconds
        )
        db.commit()
        return _snapshot(db, run_id, plan)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def claim_next(root: Path, run_id: str, projection: dict[str, Any] | None, scene_aliases, *, actor: str = "codex-worker", claim_lease_seconds: int = DEFAULT_CLAIM_LEASE_SECONDS):
    db = _connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        run, _ = _refresh_locked(
            root, db, run_id, projection, scene_aliases, actor=actor, claim_lease_seconds=claim_lease_seconds
        )
        if run["paused"] or run["cancelled"] or run["state"] != "READY":
            _commit_claim_rejection(db, f"E_PRODUCTION_AGENT_RUN_NOT_CLAIMABLE:{run['state']}")
        task = db.execute(
            "SELECT * FROM production_agent_tasks WHERE run_id=? AND state NOT IN ('COMPLETE','FAILED') ORDER BY ordinal,created_at LIMIT 1",
            (run_id,),
        ).fetchone()
        if task is None:
            _commit_claim_rejection(db, "E_PRODUCTION_AGENT_NO_CLAIMABLE_TASK")
        if task["state"] == "CLAIMED":
            _commit_claim_rejection(db, "E_PRODUCTION_AGENT_TASK_ALREADY_CLAIMED")
        if task["state"] != "PENDING":
            _commit_claim_rejection(db, f"E_PRODUCTION_AGENT_TASK_NOT_CLAIMABLE:{task['state']}")
        if not task["suggested_tool"]:
            _commit_claim_rejection(db, "E_PRODUCTION_AGENT_TASK_REQUIRES_MANUAL_ACTION")
        token = hap_core.new_id(
            "agent_claim",
            f"{run_id}|{task['task_id']}|{actor}|{datetime.now(timezone.utc).isoformat()}",
        )
        effective_lease = production_agent_policy.resolve_claim_lease_seconds(claim_lease_seconds)
        now = hap_core.now()
        cursor = db.execute(
            "UPDATE production_agent_tasks SET state='CLAIMED',claim_actor=?,claim_token=?,claim_checkpoint=?,claimed_at=?,claim_lease_seconds=?,last_error=NULL,updated_at=? WHERE task_id=? AND state='PENDING'",
            (actor, token, run["checkpoint"], now, effective_lease, now, task["task_id"]),
        )
        if cursor.rowcount != 1:
            raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_RACE")
        _event(db, run_id, "task_claimed", actor, {"checkpoint": run["checkpoint"], "suggested_tool": task["suggested_tool"], "lease_seconds": effective_lease}, task["task_id"])
        db.commit()
        claimed = _task_row(db, run_id, task["task_id"])
        return {"run_id": run_id, "checkpoint": run["checkpoint"], "task": _task_dict(claimed)}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def heartbeat_claim(root: Path, run_id: str, task_id: str, claim_token: str, *, actor: str = "codex-worker", claim_lease_seconds: int = DEFAULT_CLAIM_LEASE_SECONDS):
    db = _connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        run = _run_row(db, run_id)
        if run["paused"] or run["cancelled"] or run["state"] != "READY":
            raise ValueError(f"E_PRODUCTION_AGENT_RUN_NOT_EXECUTABLE:{run['state']}")
        task = _task_row(db, run_id, task_id)
        if task["state"] != "CLAIMED" or task["claim_token"] != claim_token:
            raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
        if _claim_expired(task, now=datetime.now(timezone.utc), lease_seconds=claim_lease_seconds):
            _expire_claim_row(db, task, actor, lease_seconds=claim_lease_seconds)
            _commit_claim_rejection(db, "E_PRODUCTION_AGENT_TASK_CLAIM_INVALID:EXPIRED")
        now = hap_core.now()
        cursor = db.execute(
            "UPDATE production_agent_tasks SET claimed_at=?,updated_at=? WHERE task_id=? AND state='CLAIMED' AND claim_token=?",
            (now, now, task_id, claim_token),
        )
        if cursor.rowcount != 1:
            raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_RACE")
        db.commit()
        return {"run_id": run_id, "task": _task_dict(_task_row(db, run_id, task_id)), "heartbeat_at": now}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def peek_next(root: Path, run_id: str, projection: dict[str, Any] | None, scene_aliases, *, actor: str = "codex-worker"):
    snapshot = refresh_run(root, run_id, projection, scene_aliases, actor=actor)
    tasks = snapshot.get("active_tasks") or []
    return {"run": snapshot, "task": tasks[0] if tasks else None}


def control_run(root: Path, run_id: str, action: str, *, actor: str = "filmmate-user", task_id: str | None = None, claim_token: str | None = None, error: str | None = None):
    action = str(action or "").lower()
    db = _connect(root)
    try:
        db.execute("BEGIN IMMEDIATE")
        run = _run_row(db, run_id)
        now = hap_core.now()
        if action == "pause":
            if run["cancelled"]:
                raise ValueError("E_PRODUCTION_AGENT_RUN_CANCELLED")
            released = _release_claimed_tasks_for_control(db, run_id, actor, "run_paused")
            db.execute("UPDATE production_agent_runs SET paused=1,state='PAUSED',updated_at=? WHERE run_id=?", (now, run_id))
            _event(db, run_id, "run_paused", actor, {"released_claims": released})
        elif action == "resume":
            if run["cancelled"]:
                raise ValueError("E_PRODUCTION_AGENT_RUN_CANCELLED")
            db.execute("UPDATE production_agent_runs SET paused=0,state='READY',updated_at=? WHERE run_id=?", (now, run_id))
            _event(db, run_id, "run_resumed", actor)
        elif action == "cancel":
            released = _release_claimed_tasks_for_control(db, run_id, actor, "run_cancelled")
            db.execute("UPDATE production_agent_runs SET cancelled=1,state='CANCELLED',updated_at=? WHERE run_id=?", (now, run_id))
            _event(db, run_id, "run_cancelled", actor, {"released_claims": released})
        elif action == "release_task":
            if not task_id or not claim_token:
                raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_REQUIRED")
            task = _task_row(db, run_id, task_id)
            if task["state"] != "CLAIMED" or task["claim_token"] != claim_token:
                raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
            if _claim_expired(task, now=datetime.now(timezone.utc), lease_seconds=DEFAULT_CLAIM_LEASE_SECONDS):
                _expire_claim_row(db, task, actor, lease_seconds=DEFAULT_CLAIM_LEASE_SECONDS)
                _commit_claim_rejection(db, "E_PRODUCTION_AGENT_TASK_CLAIM_INVALID:EXPIRED")
            base = _base_task_state({"status": task["plan_status"]})
            db.execute(
                "UPDATE production_agent_tasks SET state=?,claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,last_error=?,updated_at=? WHERE task_id=?",
                (base, error, now, task_id),
            )
            _event(db, run_id, "task_released", actor, {"error": error}, task_id)
        elif action == "fail_task":
            if not task_id or not claim_token:
                raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_REQUIRED")
            task = _task_row(db, run_id, task_id)
            if task["state"] != "CLAIMED" or task["claim_token"] != claim_token:
                raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
            if _claim_expired(task, now=datetime.now(timezone.utc), lease_seconds=DEFAULT_CLAIM_LEASE_SECONDS):
                _expire_claim_row(db, task, actor, lease_seconds=DEFAULT_CLAIM_LEASE_SECONDS)
                _commit_claim_rejection(db, "E_PRODUCTION_AGENT_TASK_CLAIM_INVALID:EXPIRED")
            db.execute(
                "UPDATE production_agent_tasks SET state='FAILED',claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,last_error=?,updated_at=? WHERE task_id=?",
                (error or "task_failed", now, task_id),
            )
            db.execute("UPDATE production_agent_runs SET state='FAILED',last_error=?,updated_at=? WHERE run_id=?", (error or "task_failed", now, run_id))
            _event(db, run_id, "task_failed", actor, {"error": error or "task_failed"}, task_id)
        elif action == "retry_task":
            if not task_id:
                raise ValueError("E_PRODUCTION_AGENT_TASK_REQUIRED")
            task = _task_row(db, run_id, task_id)
            if task["state"] != "FAILED":
                raise ValueError("E_PRODUCTION_AGENT_TASK_NOT_FAILED")
            base = _base_task_state({"status": task["plan_status"]})
            db.execute(
                "UPDATE production_agent_tasks SET state=?,claim_actor=NULL,claim_token=NULL,claim_checkpoint=NULL,claimed_at=NULL,claim_lease_seconds=NULL,last_error=NULL,updated_at=? WHERE task_id=?",
                (base, now, task_id),
            )
            db.execute("UPDATE production_agent_runs SET state='READY',last_error=NULL,updated_at=? WHERE run_id=?", (now, run_id))
            _event(db, run_id, "task_retry_requested", actor, {}, task_id)
        else:
            raise ValueError("E_PRODUCTION_AGENT_CONTROL_ACTION_INVALID")
        db.commit()
        return _snapshot(db, run_id)
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def latest_run(root: Path, scene_key: str):
    db = _connect(root)
    try:
        row = db.execute("SELECT run_id FROM production_agent_runs WHERE scene_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (scene_key,)).fetchone()
        return _snapshot(db, row["run_id"]) if row is not None else None
    finally:
        db.close()
