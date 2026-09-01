from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

DEFAULT_CLAIM_LEASE_SECONDS = 300


def _parse_claimed_at(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _claim_expired(claimed_at: Any, *, now: datetime | None = None) -> bool:
    parsed = _parse_claimed_at(claimed_at)
    if parsed is None:
        return True
    current = now or datetime.now(timezone.utc)
    return (current - parsed).total_seconds() >= DEFAULT_CLAIM_LEASE_SECONDS


def assert_active_claim(db, guard: dict[str, Any] | None):
    """Validate Production Agent ownership inside an existing write transaction.

    The caller must already hold the SQLite write transaction that will perform
    the semantic mutation. This makes pause/cancel/claim-revocation linear with
    the write: whichever transaction acquires the lock first wins. The final
    mutation also enforces the same default claim lease used by the queue, so a
    worker cannot wake from a long sleep and write through an abandoned claim.
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
        "t.state AS task_state,t.claim_token,t.claim_checkpoint,t.claimed_at "
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
    if _claim_expired(row["claimed_at"]):
        raise ValueError("E_PRODUCTION_AGENT_TASK_CLAIM_INVALID:EXPIRED")
    return row
