from __future__ import annotations

from typing import Any

from core import production_agent_policy

DEFAULT_CLAIM_LEASE_SECONDS = production_agent_policy.DEFAULT_CLAIM_LEASE_SECONDS


def assert_active_claim(db, guard: dict[str, Any] | None):
    """Validate Production Agent ownership inside an existing write transaction.

    The caller must already hold the SQLite write transaction that will perform
    the semantic mutation. This makes pause/cancel/claim-revocation linear with
    the write: whichever transaction acquires the lock first wins. The final
    mutation enforces the lease duration persisted with the claim; legacy rows
    without that column/value fall back to the canonical default.
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
    task_columns = {row[1] for row in db.execute("PRAGMA table_info(production_agent_tasks)").fetchall()}
    has_persisted_lease = "claim_lease_seconds" in task_columns
    lease_select = ",t.claim_lease_seconds" if has_persisted_lease else ""
    row = db.execute(
        "SELECT r.state AS run_state,r.checkpoint AS run_checkpoint,r.paused,r.cancelled,"
        "t.state AS task_state,t.claim_token,t.claim_checkpoint,t.claimed_at"
        + lease_select
        + " FROM production_agent_runs r JOIN production_agent_tasks t ON t.run_id=r.run_id "
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
    persisted_lease = row["claim_lease_seconds"] if has_persisted_lease else None
    if production_agent_policy.claim_is_expired(row["claimed_at"], lease_seconds=persisted_lease):
        raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID:EXPIRED")
    return row
