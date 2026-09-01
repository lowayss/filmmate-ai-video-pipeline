import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from core import hap_core, production_commands


class ProductionCommandTests(unittest.TestCase):
    def projection(self):
        return {
            "entities": [
                {"entity_id": "scene:S1", "entity_type": "scene", "logical_key": "S1", "parent_id": "project:p", "state": "accepted", "current_revision": {"revision_id": "scene:S1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "beat:B1", "entity_type": "beat", "logical_key": "B1", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "beat:B1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "asset:hero", "entity_type": "asset", "logical_key": "hero", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "asset:hero@2", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "cut:C01", "entity_type": "cut", "logical_key": "C01", "parent_id": "scene:S1", "state": "stale", "current_revision": {"revision_id": "cut:C01@3", "payload_json": "{}"}, "errors": ["character_reference: asset hero changed from asset:hero@1 to asset:hero@2"], "dependencies": [{"role": "character_reference", "upstream_entity_id": "asset:hero", "upstream_entity_type": "asset", "upstream_logical_key": "hero", "used_revision_id": "asset:hero@1", "current_revision_id": "asset:hero@2", "stale": True}]},
                {"entity_id": "prompt:C01", "entity_type": "prompt", "logical_key": "C01", "parent_id": "scene:S1", "state": "missing", "current_revision": None, "dependencies": [], "errors": ["no revision"]},
            ],
            "prompt_jobs": [],
        }

    def test_prepare_scene_explains_stale_and_next_action(self):
        state = production_commands.prepare_scene(self.projection(), ["S1", "S1_test"])
        self.assertFalse(state["generate_ready"])
        self.assertEqual(state["ready_stages"], 3)
        self.assertEqual(state["required_stages"], 5)
        self.assertEqual(state["next_action"]["stage"], "storyboard")
        self.assertEqual(state["next_action"]["action"], "regenerate_from_current_inputs")
        self.assertIn("asset hero changed", " ".join(state["next_action"]["reasons"]))

    def test_stale_regeneration_plan_targets_current_revision(self):
        plan = production_commands.stale_regeneration_plan(self.projection(), "S1")
        self.assertEqual(plan["stale_count"], 1)
        self.assertEqual(plan["tasks"][0]["entity_id"], "cut:C01")
        self.assertEqual(plan["tasks"][0]["expected_revision_id"], "cut:C01@3")
        self.assertEqual(plan["tasks"][0]["command"], "save_production_object")

    def test_save_production_object_resolves_latest_dependencies_and_conflicts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hap_core.cmd_init(SimpleNamespace(project=str(root), title="Test", project_id="project:p", mode="full"))
            hap_core.cmd_add_entity(SimpleNamespace(project=str(root), entity_type="scene", key="S1", entity_id="scene:S1", parent="project:p", mode="full"))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="scene:S1", producer="test", payload='{"production_stage":"analysis"}', evidence='{"source":"screenplay"}', depends_on=[], revision_id=None))
            hap_core.cmd_add_entity(SimpleNamespace(project=str(root), entity_type="asset", key="hero", entity_id="asset:hero", parent="scene:S1", mode="full"))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="asset:hero", producer="test", payload='{"production_stage":"assets"}', evidence='{"source":"character"}', depends_on=[], revision_id=None))
            saved = production_commands.save_production_object(root, None, ["S1"], {
                "object_type": "cut", "key": "C01", "stage": "storyboard",
                "payload": {"shot": "CU"}, "source_evidence": {"source": "conti"},
                "dependencies": [{"entity_id": "asset:hero", "role": "character_reference", "revision_id": "asset:hero@1"}],
                "expected_revision_id": None, "producer": "codex",
            })
            self.assertTrue(saved["revision_id"].startswith("cut:"))
            self.assertTrue(saved["revision_id"].endswith("@1"))
            db = hap_core.connect(root)
            try:
                dep = db.execute("SELECT upstream_revision_id,role FROM dependencies WHERE downstream_revision_id=?", (saved["revision_id"],)).fetchone()
                self.assertEqual(dep["upstream_revision_id"], "asset:hero@1")
                self.assertEqual(dep["role"], "character_reference")
                refreshed = hap_core.write_projection(root, db)
            finally:
                db.close()
            with self.assertRaisesRegex(ValueError, "revision_conflict"):
                production_commands.save_production_object(root, refreshed, ["S1"], {
                    "object_type": "cut", "key": "C01", "stage": "storyboard",
                    "payload": {"shot": "MS"}, "source_evidence": {"source": "conti"},
                    "dependencies": [], "expected_revision_id": None,
                })

    def test_semantic_write_rejects_upstream_revision_change(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hap_core.cmd_init(SimpleNamespace(project=str(root), title="Test", project_id="project:p", mode="full"))
            hap_core.cmd_add_entity(SimpleNamespace(project=str(root), entity_type="scene", key="S1", entity_id="scene:S1", parent="project:p", mode="full"))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="scene:S1", producer="test", payload='{"production_stage":"analysis"}', evidence='{"source":"screenplay"}', depends_on=[], revision_id=None))
            hap_core.cmd_add_entity(SimpleNamespace(project=str(root), entity_type="asset", key="hero", entity_id="asset:hero", parent="scene:S1", mode="full"))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="asset:hero", producer="test", payload='{"production_stage":"assets","version":1}', evidence='{"source":"character"}', depends_on=[], revision_id=None))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="asset:hero", producer="test", payload='{"production_stage":"assets","version":2}', evidence='{"source":"character"}', depends_on=[], revision_id=None))

            with self.assertRaisesRegex(ValueError, "E_PRODUCTION_DEPENDENCY_CHANGED:asset:hero@1:asset:hero@2"):
                production_commands.save_production_object(root, None, ["S1"], {
                    "object_type": "cut", "key": "C02", "stage": "storyboard",
                    "payload": {"shot": "CU based on v1"}, "source_evidence": {"source": "agent-work-order"},
                    "dependencies": [{"entity_id": "asset:hero", "role": "character_reference", "revision_id": "asset:hero@1"}],
                    "expected_revision_id": None,
                })
            db = hap_core.connect(root)
            try:
                leaked = db.execute("SELECT 1 FROM entities WHERE entity_type='cut' AND logical_key='C02'").fetchone()
            finally:
                db.close()
            self.assertIsNone(leaked)

    def test_semantic_write_uses_immediate_transaction(self):
        source = Path(production_commands.__file__).read_text(encoding="utf-8")
        start = source.index("def save_production_object")
        end = source.index("def approve_production_object")
        mutation_source = source[start:end]
        self.assertIn('db.execute("BEGIN IMMEDIATE")', mutation_source)
        self.assertIn('selector.get("revision_id")', mutation_source)


if __name__ == "__main__":
    unittest.main()
