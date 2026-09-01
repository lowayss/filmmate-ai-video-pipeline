from __future__ import annotations

from typing import Any


def assert_active_claim(db, guard: dict[str, Any] | None):
    """Validate Production Agent ownership inside an existing write transaction.

    The caller must already hold the SQLite write transaction that will perform
    the semantic mutation. This makes pause/cancel/claim-revocation linear with
    the write: whichever transaction acquires the lock first wins.
    """
    if guard is None:
        return None
    if not isinstance(guard, dict):
        raise ValueError("E_PRODUCTION_AGENT_CLAIM_GUARD_INVALID")
    run_id = str(guard.get("run_id") or "")
    task_id = str(guard.get("task_id") or "")
    claim_token = str(guard.get("claim_token") or "")
    checkpoint = str(guard.get("claim_checkpoint") or "")
    if not run_id or not task_id or not claim_token or not checkpoint:
        raise ValueError("E_PRODUCTION_AGENT_CLAIM_GUARD_INVALID")
    row = db.execute(
        "SELECT r.state AS run_state,r.checkpoint AS run_checkpoint,r.paused,r.cancelled,"
        "t.state AS task_state,t.claim_token,t.claim_checkpoint "
        "FROM production_agent_runs r JOIN production_agent_tasks t ON t.run_id=r.run_id "
        "WHERE r.run_id=? AND t.task_id=?",
        (run_id, task_id),
    ).fetchone()
    if row is None:
        raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
    if row["paused"] or row["cancelled"] or row["run_state"] != "READY":
        raise ValueError(f"E_PRODUCTION_AGENT_RUN_NOT_EXECUTABLE:{row['run_state']}")
    if row["task_state"] != "CLAIMED" or row["claim_token"] != claim_token:
        raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID")
    if row["claim_checkpoint"] != checkpoint or row["run_checkpoint"] != checkpoint:
        raise ValueError("E_PRODUCTION_AGENT_CLAIM_CHECKPOINT_CHANGED")
    return row
