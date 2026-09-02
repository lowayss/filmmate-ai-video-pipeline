import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from core import hap_core, production_agent_bridge


ROOT = Path(__file__).resolve().parents[1]


class ProductionAgentDesktopTests(unittest.TestCase):
    def test_bridge_reads_canonical_hap_and_returns_checkpoint(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            hap_core.cmd_init(SimpleNamespace(project=str(root), title="Test", project_id="project:p", mode="full"))
            hap_core.cmd_add_entity(SimpleNamespace(project=str(root), entity_type="scene", key="S1", entity_id="scene:S1", parent="project:p", mode="full"))
            hap_core.cmd_commit(SimpleNamespace(project=str(root), entity="scene:S1", producer="test", payload='{"production_stage":"analysis"}', evidence='{"source":"screenplay"}', depends_on=[], revision_id=None))
            plan = production_agent_bridge.run({
                "project_root": str(root),
                "scene_aliases": ["S1"],
                "goal": "영상 생성 준비 완료까지 진행해줘",
            })
            self.assertEqual(plan["target"], "generate_ready")
            self.assertFalse(plan["target_reached"])
            self.assertEqual(len(plan["checkpoint"]), 64)
            self.assertEqual(plan["execution_policy"]["stateless"], True)

    def test_desktop_exposes_command_bar_contract(self):
        preload = (ROOT / "desktop" / "preload.cjs").read_text(encoding="utf-8")
        main = (ROOT / "desktop" / "main.cjs").read_text(encoding="utf-8")
        bridge = (ROOT / "desktop" / "python-bridge.cjs").read_text(encoding="utf-8")
        html = (ROOT / "desktop" / "index.html").read_text(encoding="utf-8")
        self.assertIn("runProductionAgent", preload)
        self.assertIn('production-agent:run', main)
        self.assertIn("runProductionAgentAsync", bridge)
        self.assertIn('id=\"agentGoal\"', html)
        self.assertIn("productionAgentCommandView", html)
        self.assertIn("previous_checkpoint", main)
        self.assertIn("checkpoint_changed", html)


if __name__ == "__main__":
    unittest.main()
