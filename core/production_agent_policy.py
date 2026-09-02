from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

DEFAULT_CLAIM_LEASE_SECONDS = 300
MIN_CLAIM_LEASE_SECONDS = 30
MAX_CLAIM_CLOCK_SKEW_SECONDS = 5


def resolve_claim_lease_seconds(value: Any = None) -> int:
    """Return the canonical Production Agent claim lease duration.

    Runtime/test overrides are allowed, but no caller can create a lease shorter
    than the shared safety floor. Missing, falsey-zero, or invalid values fall
    back to the canonical default, preserving the queue's previous semantics.
    """
    if value is None or value == "" or value is False or value == 0:
        return DEFAULT_CLAIM_LEASE_SECONDS
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return DEFAULT_CLAIM_LEASE_SECONDS
    return max(MIN_CLAIM_LEASE_SECONDS, seconds)


def parse_utc_timestamp(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or ""))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def claim_is_expired(
    claimed_at: Any,
    *,
    now: datetime | None = None,
    lease_seconds: Any = None,
) -> bool:
    parsed = parse_utc_timestamp(claimed_at)
    if parsed is None:
        return True
    current = now or datetime.now(timezone.utc)
    age_seconds = (current - parsed).total_seconds()
    if age_seconds < -MAX_CLAIM_CLOCK_SKEW_SECONDS:
        return True
    return age_seconds >= resolve_claim_lease_seconds(lease_seconds)
