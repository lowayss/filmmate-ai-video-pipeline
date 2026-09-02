import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from core import production_agent_claim_guard, production_agent_jobs, production_agent_policy


class ProductionAgentPolicyTests(unittest.TestCase):
    def test_claim_lease_default_floor_and_ceiling_are_canonical(self):
        self.assertEqual(production_agent_policy.DEFAULT_CLAIM_LEASE_SECONDS, 300)
        self.assertEqual(production_agent_policy.MIN_CLAIM_LEASE_SECONDS, 30)
        self.assertEqual(production_agent_policy.MAX_CLAIM_LEASE_SECONDS, 3600)
        self.assertEqual(production_agent_policy.MAX_CLAIM_CLOCK_SKEW_SECONDS, 5)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(), 300)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(None), 300)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(0), 300)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(False), 300)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds("bad"), 300)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(-1), 30)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(1), 30)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(29), 30)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(30), 30)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(301), 301)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(3600), 3600)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(3601), 3600)
        self.assertEqual(production_agent_policy.resolve_claim_lease_seconds(10**9), 3600)

    def test_claim_expiry_boundary_uses_shared_policy(self):
        now = datetime(2026, 9, 2, 10, 0, 0, tzinfo=timezone.utc)
        active = now - timedelta(seconds=299)
        expired = now - timedelta(seconds=300)
        self.assertFalse(production_agent_policy.claim_is_expired(active.isoformat(), now=now))
        self.assertTrue(production_agent_policy.claim_is_expired(expired.isoformat(), now=now))
        self.assertTrue(production_agent_policy.claim_is_expired(None, now=now))
        self.assertTrue(production_agent_policy.claim_is_expired("not-a-timestamp", now=now))

    def test_claim_lease_ceiling_prevents_effectively_permanent_claim(self):
        now = datetime(2026, 9, 2, 10, 0, 0, tzinfo=timezone.utc)
        within_ceiling = now - timedelta(seconds=3599)
        beyond_ceiling = now - timedelta(seconds=3600)
        self.assertFalse(
            production_agent_policy.claim_is_expired(within_ceiling.isoformat(), now=now, lease_seconds=10**9)
        )
        self.assertTrue(
            production_agent_policy.claim_is_expired(beyond_ceiling.isoformat(), now=now, lease_seconds=10**9)
        )

    def test_claim_future_timestamp_allows_only_small_clock_skew(self):
        now = datetime(2026, 9, 2, 10, 0, 0, tzinfo=timezone.utc)
        within_tolerance = now + timedelta(seconds=production_agent_policy.MAX_CLAIM_CLOCK_SKEW_SECONDS)
        unsafe_future = now + timedelta(seconds=production_agent_policy.MAX_CLAIM_CLOCK_SKEW_SECONDS + 1)
        far_future = now + timedelta(days=365)
        self.assertFalse(production_agent_policy.claim_is_expired(within_tolerance.isoformat(), now=now))
        self.assertTrue(production_agent_policy.claim_is_expired(unsafe_future.isoformat(), now=now))
        self.assertTrue(production_agent_policy.claim_is_expired(far_future.isoformat(), now=now))

    def test_queue_and_semantic_guard_delegate_policy_implementation(self):
        jobs_source = Path(production_agent_jobs.__file__).read_text(encoding="utf-8")
        guard_source = Path(production_agent_claim_guard.__file__).read_text(encoding="utf-8")
        self.assertNotIn("DEFAULT_CLAIM_LEASE_SECONDS = 300", jobs_source)
        self.assertNotIn("DEFAULT_CLAIM_LEASE_SECONDS = 300", guard_source)
        self.assertNotIn("def _parse_timestamp", jobs_source)
        self.assertNotIn("def _parse_claimed_at", guard_source)
        self.assertIn("production_agent_policy.claim_is_expired", jobs_source)
        self.assertIn("production_agent_policy.claim_is_expired", guard_source)
        self.assertIn("production_agent_policy.resolve_claim_lease_seconds", jobs_source)


if __name__ == "__main__":
    unittest.main()
