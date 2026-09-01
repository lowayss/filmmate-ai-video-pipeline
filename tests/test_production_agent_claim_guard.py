import sqlite3
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from core import filmmate_documents, production_agent_claim_guard, production_agent_jobs, production_commands


class ProductionAgentClaimGuardTests(unittest.TestCase):
    def database(self, claimed_at=None):
        db = sqlite3.connect(":memory:")
        db.row_factory = sqlite3.Row
        db.executescript("""
        CREATE TABLE production_agent_runs(
          run_id TEXT PRIMARY KEY,state TEXT NOT NULL,checkpoint TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,cancelled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE production_agent_tasks(
          task_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,
          claim_token TEXT,claim_checkpoint TEXT,claimed_at TEXT
        );
        """)
        db.execute(
            "INSERT INTO production_agent_runs(run_id,state,checkpoint,paused,cancelled) VALUES(?,?,?,?,?)",
            ("run:1", "READY", "cp:1", 0, 0),
        )
        db.execute(
            "INSERT INTO production_agent_tasks(task_id,run_id,state,claim_token,claim_checkpoint,claimed_at) VALUES(?,?,?,?,?,?)",
            (
                "task:1",
                "run:1",
                "CLAIMED",
                "token:1",
                "cp:1",
                claimed_at or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            ),
        )
        return db

    def guard(self):
        return {
            "run_id": "run:1",
            "task_id": "task:1",
            "claim_token": "token:1",
            "claim_checkpoint": "cp:1",
        }

    def test_active_claim_is_accepted(self):
        db = self.database()
        try:
            row = production_agent_claim_guard.assert_active_claim(db, self.guard())
            self.assertEqual(row["task_state"], "CLAIMED")
        finally:
            db.close()

    def test_guard_lease_matches_queue_default(self):
        self.assertEqual(production_agent_claim_guard.DEFAULT_CLAIM_LEASE_SECONDS, production_agent_jobs.DEFAULT_CLAIM_LEASE_SECONDS)
        self.assertEqual(production_agent_claim_guard.DEFAULT_CLAIM_LEASE_SECONDS, 300)

    def test_pause_or_revoked_token_blocks_semantic_write(self):
        db = self.database()
        try:
            db.execute("UPDATE production_agent_runs SET paused=1,state='PAUSED' WHERE run_id='run:1'")
            with self.assertRaisesRegex(ValueError, "RUN_NOT_EXECUTABLE:PAUSED"):
                production_agent_claim_guard.assert_active_claim(db, self.guard())
            db.execute("UPDATE production_agent_runs SET paused=0,state='READY' WHERE run_id='run:1'")
            db.execute("UPDATE production_agent_tasks SET state='PENDING',claim_token=NULL,claim_checkpoint=NULL WHERE task_id='task:1'")
            with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID"):
                production_agent_claim_guard.assert_active_claim(db, self.guard())
        finally:
            db.close()

    def test_checkpoint_change_blocks_semantic_write(self):
        db = self.database()
        try:
            db.execute("UPDATE production_agent_runs SET checkpoint='cp:2' WHERE run_id='run:1'")
            with self.assertRaisesRegex(ValueError, "CLAIM_CHECKPOINT_CHANGED"):
                production_agent_claim_guard.assert_active_claim(db, self.guard())
        finally:
            db.close()

    def test_expired_or_missing_lease_blocks_semantic_write(self):
        expired = (
            datetime.now(timezone.utc)
            - timedelta(seconds=production_agent_claim_guard.DEFAULT_CLAIM_LEASE_SECONDS + 1)
        ).replace(microsecond=0).isoformat()
        db = self.database(expired)
        try:
            with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
                production_agent_claim_guard.assert_active_claim(db, self.guard())
            db.execute("UPDATE production_agent_tasks SET claimed_at=NULL WHERE task_id='task:1'")
            with self.assertRaisesRegex(ValueError, "TASK_CLAIM_INVALID:EXPIRED"):
                production_agent_claim_guard.assert_active_claim(db, self.guard())
        finally:
            db.close()

    def test_both_semantic_mutators_validate_claim_after_write_lock(self):
        for module, function_name, next_name in (
            (production_commands, "def save_production_object", "def approve_production_object"),
            (filmmate_documents, "def save_document", "def _main"),
        ):
            source = Path(module.__file__).read_text(encoding="utf-8")
            section = source[source.index(function_name):source.index(next_name)]
            begin = section.index('db.execute("BEGIN IMMEDIATE")')
            guard = section.index("production_agent_claim_guard.assert_active_claim")
            self.assertLess(begin, guard)


if __name__ == "__main__":
    unittest.main()
