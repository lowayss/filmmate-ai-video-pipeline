import sqlite3
import unittest

from core import hap_core


class ProductionDependencyTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(hap_core.DDL)
        created = hap_core.now()
        self.db.execute(
            "INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)",
            ("project:test", "project", "test", None, "full", created),
        )
        self.db.execute(
            "INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)",
            ("asset:jiyeon", "asset", "Jiyeon", "project:test", "full", created),
        )
        self.db.execute(
            "INSERT INTO entities(entity_id,entity_type,logical_key,parent_id,workflow_mode,created_at) VALUES(?,?,?,?,?,?)",
            ("cut:C03", "cut", "C03", "project:test", "full", created),
        )
        self.db.execute(
            "INSERT INTO revisions VALUES(?,?,?,?,?,?,?)",
            ("asset:jiyeon@1", "asset:jiyeon", 1, "test", "{}", "[]", created),
        )
        self.db.execute(
            "INSERT INTO revisions VALUES(?,?,?,?,?,?,?)",
            ("cut:C03@1", "cut:C03", 1, "test", "{}", "[]", created),
        )
        self.db.execute(
            "INSERT INTO dependencies(downstream_revision_id,upstream_revision_id,role) VALUES(?,?,?)",
            ("cut:C03@1", "asset:jiyeon@1", "character_reference"),
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_dependency_details_identify_current_and_used_revision(self):
        details = hap_core.dependency_details(self.db, "cut:C03@1", hap_core.current_map(self.db))
        self.assertEqual(len(details), 1)
        self.assertEqual(details[0]["upstream_entity_type"], "asset")
        self.assertEqual(details[0]["upstream_logical_key"], "Jiyeon")
        self.assertEqual(details[0]["used_revision_id"], "asset:jiyeon@1")
        self.assertEqual(details[0]["current_revision_id"], "asset:jiyeon@1")
        self.assertFalse(details[0]["stale"])

    def test_dependency_details_explain_stale_revision_change(self):
        created = hap_core.now()
        self.db.execute(
            "INSERT INTO revisions VALUES(?,?,?,?,?,?,?)",
            ("asset:jiyeon@2", "asset:jiyeon", 2, "test", "{}", "[]", created),
        )
        self.db.commit()
        details = hap_core.dependency_details(self.db, "cut:C03@1", hap_core.current_map(self.db))
        self.assertTrue(details[0]["stale"])
        self.assertEqual(details[0]["used_revision_id"], "asset:jiyeon@1")
        self.assertEqual(details[0]["current_revision_id"], "asset:jiyeon@2")


if __name__ == "__main__":
    unittest.main()
