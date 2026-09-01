import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from core import hap_core, production_agent_jobs


class ProductionAgentJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        hap_core.cmd_init(SimpleNamespace(project=str(self.root), title="Agent Queue", project_id="project:p", mode="full"))

    def tearDown(self):
        self.temp.cleanup()

    def projection(self, *, storyboard_state="stale", prompt_state="missing"):
        storyboard_errors = ["character_reference: asset hero changed from asset:hero@1 to asset:hero@2"] if storyboard_state == "stale" else []
        storyboard_deps = [{
            "role": "character_reference", "upstream_entity_id": "asset:hero", "upstream_entity_type": "asset",
            "upstream_logical_key": "hero", "used_revision_id": "asset:hero@1", "current_revision_id": "asset:hero@2",
            "stale": storyboard_state == "stale",
        }] if storyboard_state == "stale" else []
        prompt_revision = None if prompt_state == "missing" else {"revision_id": "prompt:C01@1", "payload_json": "{}"}
        return {
            "entities": [
                {"entity_id": "scene:S1", "entity_type": "scene", "logical_key": "S1", "parent_id": "project:p", "state": "accepted", "current_revision": {"revision_id": "scene:S1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "beat:B1", "entity_type": "beat", "logical_key": "B1", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "beat:B1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "asset:hero", "entity_type": "asset", "logical_key": "hero", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "asset:hero@2", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "cut:C01", "entity_type": "cut", "logical_key": "C01", "parent_id": "scene:S1", "state": storyboard_state, "current_revision": {"revision_id": "cut:C01@3", "payload_json": "{}"}, "dependencies": storyboard_deps, "errors": storyboard_errors},
                {"entity_id": "prompt:C01", "entity_type": "prompt", "logical_key": "C01", "parent_id": "scene:S1", "state": prompt_state, "current_revision": prompt_revision, "dependencies": [], "errors": ["no revision"] if prompt_state == "missing" else []},
            ],
            "prompt_jobs": [],
        }

    def test_run_claims_only_current_canonical_task(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        self.assertEqual(run["state"], "READY")
        self.assertEqual(run["active_tasks"][0]["stage"], "storyboard")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        self.assertEqual(claimed["task"]["state"], "CLAIMED")
        self.assertEqual(claimed["task"]["suggested_tool"], "save_production_object")
        self.assertTrue(claimed["task"]["claim_token"].startswith("agent_claim_"))
        self.assertIsNotNone(claimed["task"]["claimed_at"])

    def test_claim_refresh_and_claim_share_one_transactional_path(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        with mock.patch.object(production_agent_jobs, "refresh_run", side_effect=AssertionError("claim_next must not call refresh_run")):
            claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        self.assertEqual(claimed["task"]["state"], "CLAIMED")
        self.assertEqual(claimed["checkpoint"], run["checkpoint"])

    def test_claim_rejection_keeps_refreshed_checkpoint(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        production_agent_jobs.control_run(self.root, run["run_id"], "pause")
        changed = self.projection(storyboard_state="accepted")
        with self.assertRaisesRegex(ValueError, "NOT_CLAIMABLE:PAUSED"):
            production_agent_jobs.claim_next(self.root, run["run_id"], changed, ["S1"], actor="worker-a")
        db = hap_core.connect(self.root)
        try:
            row = db.execute("SELECT state,checkpoint FROM production_agent_runs WHERE run_id=?", (run["run_id"],)).fetchone()
        finally:
            db.close()
        self.assertEqual(row["state"], "PAUSED")
        self.assertNotEqual(row["checkpoint"], run["checkpoint"])

    def test_repeated_start_run_creates_distinct_runs_and_latest_is_newest(self):
        first = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        second = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        self.assertNotEqual(first["run_id"], second["run_id"])
        latest = production_agent_jobs.latest_run(self.root, "S1")
        self.assertEqual(latest["run_id"], second["run_id"])
        db = hap_core.connect(self.root)
        try:
            count = db.execute("SELECT COUNT(*) FROM production_agent_runs WHERE scene_key='S1'").fetchone()[0]
        finally:
            db.close()
        self.assertEqual(count, 2)

    def test_refresh_resolves_task_only_when_plan_no_longer_requires_it(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        first_task = run["active_tasks"][0]["task_id"]
        refreshed = production_agent_jobs.refresh_run(
            self.root, run["run_id"], self.projection(storyboard_state="accepted"), ["S1"]
        )
        completed = next(task for task in refreshed["tasks"] if task["task_id"] == first_task)
        self.assertEqual(completed["state"], "COMPLETE")
        self.assertEqual(refreshed["active_tasks"][0]["stage"], "prompts")
        self.assertNotEqual(refreshed["checkpoint"], run["checkpoint"])

    def test_pause_resume_and_release_preserve_claim_ownership(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        paused = production_agent_jobs.control_run(self.root, run["run_id"], "pause")
        self.assertEqual(paused["state"], "PAUSED")
        with self.assertRaisesRegex(ValueError, "NOT_CLAIMABLE:PAUSED"):
            production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"])
        production_agent_jobs.control_run(self.root, run["run_id"], "resume")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        with self.assertRaisesRegex(ValueError, "CLAIM_INVALID"):
            production_agent_jobs.control_run(
                self.root, run["run_id"], "release_task", task_id=claimed["task"]["task_id"], claim_token="wrong"
            )
        released = production_agent_jobs.control_run(
            self.root, run["run_id"], "release_task", task_id=claimed["task"]["task_id"],
            claim_token=claimed["task"]["claim_token"], error="worker stopped"
        )
        task = next(task for task in released["tasks"] if task["task_id"] == claimed["task"]["task_id"])
        self.assertEqual(task["state"], "PENDING")
        self.assertEqual(task["last_error"], "worker stopped")
        self.assertIsNone(task["claimed_at"])
        reclaimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        self.assertNotEqual(reclaimed["task"]["claim_token"], claimed["task"]["claim_token"])

    def test_pause_releases_active_claim_and_invalidates_worker_token(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        token = claimed["task"]["claim_token"]
        task_id = claimed["task"]["task_id"]
        paused = production_agent_jobs.control_run(self.root, run["run_id"], "pause", actor="filmmate-user")
        task = next(item for item in paused["tasks"] if item["task_id"] == task_id)
        self.assertEqual(paused["state"], "PAUSED")
        self.assertEqual(task["state"], "PENDING")
        self.assertIsNone(task["claim_token"])
        self.assertIsNone(task["claimed_at"])
        self.assertTrue(any(event["event"] == "task_claim_released_by_run_control" and event["task_id"] == task_id for event in paused["events"]))
        with self.assertRaisesRegex(ValueError, "RUN_NOT_EXECUTABLE:PAUSED"):
            production_agent_jobs.heartbeat_claim(self.root, run["run_id"], task_id, token, actor="worker-a")
        production_agent_jobs.control_run(self.root, run["run_id"], "resume")
        reclaimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        self.assertNotEqual(reclaimed["task"]["claim_token"], token)

    def test_cancel_releases_active_claim(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        task_id = claimed["task"]["task_id"]
        cancelled = production_agent_jobs.control_run(self.root, run["run_id"], "cancel", actor="filmmate-user")
        task = next(item for item in cancelled["tasks"] if item["task_id"] == task_id)
        self.assertEqual(cancelled["state"], "CANCELLED")
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(task["state"], "PENDING")
        self.assertIsNone(task["claim_token"])
        self.assertIsNone(task["claimed_at"])

    def test_expired_claim_is_recovered_from_canonical_queue(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        task_id = claimed["task"]["task_id"]
        db = hap_core.connect(self.root)
        try:
            db.execute("UPDATE production_agent_tasks SET claimed_at=? WHERE task_id=?", ("2000-01-01T00:00:00+00:00", task_id))
            db.commit()
        finally:
            db.close()
        refreshed = production_agent_jobs.refresh_run(self.root, run["run_id"], self.projection(), ["S1"])
        task = next(task for task in refreshed["tasks"] if task["task_id"] == task_id)
        self.assertEqual(task["state"], "PENDING")
        self.assertIsNone(task["claim_token"])
        self.assertIsNone(task["claimed_at"])
        self.assertEqual(task["last_error"], "claim_lease_expired")
        self.assertTrue(any(event["event"] == "task_claim_expired" and event["task_id"] == task_id for event in refreshed["events"]))

    def test_claim_heartbeat_renews_lease_and_rejects_wrong_owner(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        task = claimed["task"]
        with self.assertRaisesRegex(ValueError, "CLAIM_INVALID"):
            production_agent_jobs.heartbeat_claim(self.root, run["run_id"], task["task_id"], "wrong", actor="worker-b")
        heartbeat = production_agent_jobs.heartbeat_claim(
            self.root, run["run_id"], task["task_id"], task["claim_token"], actor="worker-a"
        )
        self.assertEqual(heartbeat["task"]["state"], "CLAIMED")
        self.assertEqual(heartbeat["task"]["claim_token"], task["claim_token"])
        self.assertEqual(heartbeat["task"]["claimed_at"], heartbeat["heartbeat_at"])
        refreshed = production_agent_jobs.refresh_run(
            self.root, run["run_id"], self.projection(), ["S1"], claim_lease_seconds=30
        )
        refreshed_task = next(item for item in refreshed["tasks"] if item["task_id"] == task["task_id"])
        self.assertEqual(refreshed_task["state"], "CLAIMED")

    def test_expired_claim_heartbeat_recovers_queue_immediately(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        task = claimed["task"]
        expired_at = "2000-01-01T00:00:00+00:00"
        db = hap_core.connect(self.root)
        try:
            db.execute("UPDATE production_agent_tasks SET claimed_at=? WHERE task_id=?", (expired_at, task["task_id"]))
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
            production_agent_jobs.heartbeat_claim(
                self.root,
                run["run_id"],
                task["task_id"],
                task["claim_token"],
                actor="worker-a",
                claim_lease_seconds=30,
            )
        db = hap_core.connect(self.root)
        try:
            persisted = db.execute(
                "SELECT state,claim_token,claim_checkpoint,claimed_at,last_error FROM production_agent_tasks WHERE task_id=?",
                (task["task_id"],),
            ).fetchone()
            event = db.execute(
                "SELECT event,detail_json FROM production_agent_events WHERE run_id=? AND task_id=? ORDER BY event_id DESC LIMIT 1",
                (run["run_id"], task["task_id"]),
            ).fetchone()
        finally:
            db.close()
        self.assertEqual(persisted["state"], "PENDING")
        self.assertIsNone(persisted["claim_token"])
        self.assertIsNone(persisted["claim_checkpoint"])
        self.assertIsNone(persisted["claimed_at"])
        self.assertEqual(persisted["last_error"], "claim_lease_expired")
        self.assertEqual(event["event"], "task_claim_expired")
        reclaimed = production_agent_jobs.claim_next(
            self.root, run["run_id"], self.projection(), ["S1"], actor="worker-b", claim_lease_seconds=30
        )
        self.assertEqual(reclaimed["task"]["state"], "CLAIMED")
        self.assertNotEqual(reclaimed["task"]["claim_token"], task["claim_token"])


if __name__ == "__main__":
    unittest.main()
