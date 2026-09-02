import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from core import hap_core, production_agent_claim_guard, production_agent_jobs, production_agent_policy


class ProductionAgentLeasePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        hap_core.cmd_init(SimpleNamespace(project=str(self.root), title="Lease Persistence", project_id="project:p", mode="full"))

    def tearDown(self):
        self.temp.cleanup()

    def projection(self):
        return {
            "entities": [
                {
                    "entity_id": "scene:S1", "entity_type": "scene", "logical_key": "S1",
                    "parent_id": "project:p", "state": "accepted",
                    "current_revision": {"revision_id": "scene:S1@1", "payload_json": "{}"},
                    "dependencies": [], "errors": [],
                },
                {
                    "entity_id": "beat:B1", "entity_type": "beat", "logical_key": "B1",
                    "parent_id": "scene:S1", "state": "accepted",
                    "current_revision": {"revision_id": "beat:B1@1", "payload_json": "{}"},
                    "dependencies": [], "errors": [],
                },
                {
                    "entity_id": "asset:hero", "entity_type": "asset", "logical_key": "hero",
                    "parent_id": "scene:S1", "state": "accepted",
                    "current_revision": {"revision_id": "asset:hero@2", "payload_json": "{}"},
                    "dependencies": [], "errors": [],
                },
                {
                    "entity_id": "cut:C01", "entity_type": "cut", "logical_key": "C01",
                    "parent_id": "scene:S1", "state": "stale",
                    "current_revision": {"revision_id": "cut:C01@3", "payload_json": "{}"},
                    "dependencies": [{
                        "role": "character_reference",
                        "upstream_entity_id": "asset:hero",
                        "upstream_entity_type": "asset",
                        "upstream_logical_key": "hero",
                        "used_revision_id": "asset:hero@1",
                        "current_revision_id": "asset:hero@2",
                        "stale": True,
                    }],
                    "errors": ["character_reference: asset hero changed from asset:hero@1 to asset:hero@2"],
                },
                {
                    "entity_id": "prompt:C01", "entity_type": "prompt", "logical_key": "C01",
                    "parent_id": "scene:S1", "state": "missing", "current_revision": None,
                    "dependencies": [], "errors": ["no revision"],
                },
            ],
            "prompt_jobs": [],
        }

    def start_and_claim(self, lease_seconds=30):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(
            self.root,
            run["run_id"],
            self.projection(),
            ["S1"],
            actor="worker-a",
            claim_lease_seconds=lease_seconds,
        )
        return run, claimed

    def age_claim(self, task_id, seconds):
        claimed_at = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).replace(microsecond=0).isoformat()
        db = hap_core.connect(self.root)
        try:
            db.execute("UPDATE production_agent_tasks SET claimed_at=? WHERE task_id=?", (claimed_at, task_id))
            db.commit()
        finally:
            db.close()
        return claimed_at

    def test_claim_persists_effective_lease_and_heartbeat_cannot_extend_it(self):
        run, claimed = self.start_and_claim(30)
        task = claimed["task"]
        self.assertEqual(task["claim_lease_seconds"], 30)
        self.age_claim(task["task_id"], 31)
        with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
            production_agent_jobs.heartbeat_claim(
                self.root,
                run["run_id"],
                task["task_id"],
                task["claim_token"],
                actor="worker-a",
                claim_lease_seconds=300,
            )
        db = hap_core.connect(self.root)
        try:
            persisted = db.execute(
                "SELECT state,claim_token,claim_lease_seconds,last_error FROM production_agent_tasks WHERE task_id=?",
                (task["task_id"],),
            ).fetchone()
        finally:
            db.close()
        self.assertEqual(persisted["state"], "PENDING")
        self.assertIsNone(persisted["claim_token"])
        self.assertIsNone(persisted["claim_lease_seconds"])
        self.assertEqual(persisted["last_error"], "claim_lease_expired")

    def test_stale_fail_task_uses_persisted_lease(self):
        run, claimed = self.start_and_claim(30)
        task = claimed["task"]
        self.age_claim(task["task_id"], 31)
        with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
            production_agent_jobs.control_run(
                self.root,
                run["run_id"],
                "fail_task",
                actor="worker-a",
                task_id=task["task_id"],
                claim_token=task["claim_token"],
                error="late worker failure",
            )
        db = hap_core.connect(self.root)
        try:
            task_row = db.execute(
                "SELECT state,claim_token,claim_lease_seconds,last_error FROM production_agent_tasks WHERE task_id=?",
                (task["task_id"],),
            ).fetchone()
            run_row = db.execute("SELECT state,last_error FROM production_agent_runs WHERE run_id=?", (run["run_id"],)).fetchone()
        finally:
            db.close()
        self.assertEqual(task_row["state"], "PENDING")
        self.assertIsNone(task_row["claim_token"])
        self.assertIsNone(task_row["claim_lease_seconds"])
        self.assertEqual(task_row["last_error"], "claim_lease_expired")
        self.assertEqual(run_row["state"], "READY")
        self.assertIsNone(run_row["last_error"])

    def test_default_claim_persists_policy_default(self):
        run = production_agent_jobs.start_run(self.root, self.projection(), ["S1"], goal="영상 생성 준비 완료까지")
        claimed = production_agent_jobs.claim_next(self.root, run["run_id"], self.projection(), ["S1"], actor="worker-a")
        self.assertEqual(claimed["task"]["claim_lease_seconds"], production_agent_policy.DEFAULT_CLAIM_LEASE_SECONDS)

    def test_semantic_guard_uses_persisted_claim_lease(self):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        expired_at = (datetime.now(timezone.utc) - timedelta(seconds=31)).replace(microsecond=0).isoformat()
        try:
            db.executescript("""
            CREATE TABLE production_agent_runs(
              run_id TEXT PRIMARY KEY,state TEXT NOT NULL,checkpoint TEXT NOT NULL,
              paused INTEGER NOT NULL DEFAULT 0,cancelled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE production_agent_tasks(
              task_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,
              claim_token TEXT,claim_checkpoint TEXT,claimed_at TEXT,claim_lease_seconds INTEGER
            );
            INSERT INTO production_agent_runs(run_id,state,checkpoint,paused,cancelled)
            VALUES('run:1','READY','cp:1',0,0);
            """)
            db.execute(
                "INSERT INTO production_agent_tasks(task_id,run_id,state,claim_token,claim_checkpoint,claimed_at,claim_lease_seconds) VALUES(?,?,?,?,?,?,?)",
                ("task:1", "run:1", "CLAIMED", "token:1", "cp:1", expired_at, 30),
            )
            guard = {"run_id": "run:1", "task_id": "task:1", "claim_token": "token:1", "claim_checkpoint": "cp:1"}
            with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
                production_agent_claim_guard.assert_active_claim(db, guard)
        finally:
            db.close()

    def test_connect_migrates_legacy_task_table(self):
        db = hap_core.connect(self.root)
        try:
            db.execute("DROP TABLE IF EXISTS production_agent_tasks")
            db.execute("""
                CREATE TABLE production_agent_tasks(
                  task_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,signature TEXT NOT NULL,
                  stage TEXT,state TEXT NOT NULL,plan_status TEXT NOT NULL,action TEXT,suggested_tool TEXT,
                  expected_revision_id TEXT,entity_ids_json TEXT NOT NULL DEFAULT '[]',reasons_json TEXT NOT NULL DEFAULT '[]',
                  instruction TEXT NOT NULL DEFAULT '',claim_actor TEXT,claim_token TEXT,claim_checkpoint TEXT,claimed_at TEXT,
                  last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,signature)
                )
            """)
            db.commit()
        finally:
            db.close()
        migrated = production_agent_jobs._connect(self.root)
        try:
            columns = {row[1] for row in migrated.execute("PRAGMA table_info(production_agent_tasks)").fetchall()}
        finally:
            migrated.close()
        self.assertIn("claim_lease_seconds", columns)


if __name__ == "__main__":
    unittest.main()
