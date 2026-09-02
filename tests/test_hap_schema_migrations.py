import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from core import hap_core


LEGACY_AGENT_TASKS_DDL = """
CREATE TABLE production_agent_tasks(
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
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
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, signature)
)
"""


class HapSchemaMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        hap_core.cmd_init(
            SimpleNamespace(project=str(self.root), title="Schema Migration", project_id="project:p", mode="full")
        )

    def tearDown(self):
        self.temp.cleanup()

    def raw_db(self):
        db = sqlite3.connect(hap_core.db_path(self.root))
        db.row_factory = sqlite3.Row
        return db

    def install_v3_agent_table(self):
        db = self.raw_db()
        try:
            db.execute("DROP TABLE IF EXISTS production_agent_tasks")
            db.execute(LEGACY_AGENT_TASKS_DDL)
            db.execute(
                "INSERT INTO production_agent_tasks("
                "task_id,run_id,ordinal,signature,stage,state,plan_status,action,suggested_tool,"
                "expected_revision_id,entity_ids_json,reasons_json,instruction,claim_actor,claim_token,"
                "claim_checkpoint,claimed_at,last_error,created_at,updated_at"
                ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "task:legacy", "run:legacy", 1, "sig:legacy", "storyboard", "CLAIMED", "pending",
                    "save", "save_production_object", None, "[]", "[]", "legacy", "worker-a", "token-a",
                    "cp:1", "2026-09-02T00:00:00+00:00", None,
                    "2026-09-02T00:00:00+00:00", "2026-09-02T00:00:00+00:00",
                ),
            )
            db.execute("UPDATE meta SET value='3' WHERE key='schema_version'")
            db.commit()
        finally:
            db.close()

    def test_new_projects_start_at_schema_v4(self):
        db = self.raw_db()
        try:
            version = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
        finally:
            db.close()
        projection = json.loads((self.root / ".hap" / "projection.json").read_text(encoding="utf-8"))
        self.assertEqual(hap_core.SCHEMA_VERSION, 4)
        self.assertEqual(version, "4")
        self.assertEqual(projection["schema_version"], 4)

    def test_v3_to_v4_adds_claim_lease_column_and_preserves_rows(self):
        self.install_v3_agent_table()
        db = hap_core.connect(self.root)
        try:
            version = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            columns = {row[1] for row in db.execute("PRAGMA table_info(production_agent_tasks)").fetchall()}
            row = db.execute("SELECT * FROM production_agent_tasks WHERE task_id='task:legacy'").fetchone()
        finally:
            db.close()
        self.assertEqual(version, "4")
        self.assertIn("claim_lease_seconds", columns)
        self.assertEqual(row["claim_token"], "token-a")
        self.assertEqual(row["claimed_at"], "2026-09-02T00:00:00+00:00")
        self.assertIsNone(row["claim_lease_seconds"])

    def test_v4_reconnect_is_idempotent(self):
        self.install_v3_agent_table()
        first = hap_core.connect(self.root)
        first.close()
        second = hap_core.connect(self.root)
        try:
            version = second.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            columns = [row[1] for row in second.execute("PRAGMA table_info(production_agent_tasks)").fetchall()]
        finally:
            second.close()
        self.assertEqual(version, "4")
        self.assertEqual(columns.count("claim_lease_seconds"), 1)

    def test_future_schema_is_rejected_before_current_ddl_runs(self):
        db = self.raw_db()
        try:
            db.execute("DROP TABLE prompt_job_events")
            db.execute("UPDATE meta SET value='99' WHERE key='schema_version'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "E_HAP_SCHEMA_NEWER:99:4"):
            hap_core.connect(self.root)
        db = self.raw_db()
        try:
            version = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
            table_exists = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='prompt_job_events'"
            ).fetchone()
        finally:
            db.close()
        self.assertEqual(version, "99")
        self.assertIsNone(table_exists)

    def test_invalid_schema_version_is_rejected(self):
        db = self.raw_db()
        try:
            db.execute("UPDATE meta SET value='not-a-version' WHERE key='schema_version'")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "E_HAP_SCHEMA_VERSION_INVALID"):
            hap_core.connect(self.root)


if __name__ == "__main__":
    unittest.main()
