from __future__ import annotations

import json
import sys
from pathlib import Path

from core import hap_core, production_agent_jobs, production_orchestrator


def _context(payload):
    if not isinstance(payload, dict):
        raise ValueError("E_PRODUCTION_AGENT_REQUEST_INVALID")
    root = Path(payload.get("project_root") or "").expanduser().resolve()
    if not (root / ".hap" / "hap.sqlite3").is_file():
        raise ValueError("E_HAP_PROJECT_REQUIRED")
    aliases = [str(item) for item in (payload.get("scene_aliases") or []) if str(item or "").strip()]
    if not aliases:
        raise ValueError("E_PRODUCTION_SCENE_REQUIRED")
    db = hap_core.connect(root)
    try:
        projection = hap_core.write_projection(root, db)
    finally:
        db.close()
    return root, aliases, projection


def run(payload):
    root, aliases, projection = _context(payload)
    action = str(payload.get("action") or "plan").lower()
    if action == "plan":
        return production_orchestrator.build_plan(
            projection,
            aliases,
            goal=payload.get("goal"),
            target=payload.get("target"),
            previous_checkpoint=payload.get("previous_checkpoint"),
        )
    if action == "start_run":
        return production_agent_jobs.start_run(
            root, projection, aliases, goal=payload.get("goal"), target=payload.get("target"), actor=str(payload.get("actor") or "filmmate-user")
        )
    if action == "get_run":
        return production_agent_jobs.refresh_run(
            root, str(payload.get("run_id") or ""), projection, aliases, actor=str(payload.get("actor") or "filmmate-user")
        )
    if action == "latest_run":
        latest = None
        for alias in aliases:
            latest = production_agent_jobs.latest_run(root, str(alias))
            if latest is not None:
                break
        if latest is None:
            return None
        return production_agent_jobs.refresh_run(root, latest["run_id"], projection, aliases, actor=str(payload.get("actor") or "filmmate-user"))
    if action == "claim_task":
        return production_agent_jobs.claim_next(
            root, str(payload.get("run_id") or ""), projection, aliases, actor=str(payload.get("actor") or "codex-worker")
        )
    if action == "control_run":
        snapshot = production_agent_jobs.control_run(
            root,
            str(payload.get("run_id") or ""),
            str(payload.get("control") or ""),
            actor=str(payload.get("actor") or "filmmate-user"),
            task_id=payload.get("task_id"),
            claim_token=payload.get("claim_token"),
            error=payload.get("error"),
        )
        if str(payload.get("control") or "").lower() in {"resume", "retry_task"} and not snapshot.get("cancelled"):
            return production_agent_jobs.refresh_run(root, snapshot["run_id"], projection, aliases, actor=str(payload.get("actor") or "filmmate-user"))
        return snapshot
    raise ValueError("E_PRODUCTION_AGENT_BRIDGE_ACTION_INVALID")


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        print(json.dumps({"ok": True, "result": run(payload)}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
