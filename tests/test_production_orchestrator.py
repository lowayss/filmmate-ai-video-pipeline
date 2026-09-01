import unittest

from core import production_orchestrator


class ProductionOrchestratorTests(unittest.TestCase):
    def projection(self, *, cut_state="stale", prompt_state="missing", package_state="missing"):
        cut_dependencies = []
        cut_errors = []
        if cut_state == "stale":
            cut_dependencies = [{
                "role": "character_reference",
                "upstream_entity_id": "asset:hero",
                "upstream_entity_type": "asset",
                "upstream_logical_key": "hero",
                "used_revision_id": "asset:hero@1",
                "current_revision_id": "asset:hero@2",
                "stale": True,
            }]
            cut_errors = ["character_reference: asset hero changed from asset:hero@1 to asset:hero@2"]
        return {
            "entities": [
                {"entity_id": "scene:S1", "entity_type": "scene", "logical_key": "S1", "parent_id": "project:p", "state": "accepted", "current_revision": {"revision_id": "scene:S1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "beat:B1", "entity_type": "beat", "logical_key": "B1", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "beat:B1@1", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "asset:hero", "entity_type": "asset", "logical_key": "hero", "parent_id": "scene:S1", "state": "accepted", "current_revision": {"revision_id": "asset:hero@2", "payload_json": "{}"}, "dependencies": [], "errors": []},
                {"entity_id": "cut:C01", "entity_type": "cut", "logical_key": "C01", "parent_id": "scene:S1", "state": cut_state, "current_revision": {"revision_id": "cut:C01@3", "payload_json": "{}"}, "dependencies": cut_dependencies, "errors": cut_errors},
                {"entity_id": "prompt:C01", "entity_type": "prompt", "logical_key": "C01", "parent_id": "scene:S1", "state": prompt_state, "current_revision": None if prompt_state == "missing" else {"revision_id": "prompt:C01@1", "payload_json": "{}"}, "dependencies": [], "errors": ["no revision"] if prompt_state == "missing" else []},
                {"entity_id": "package:S1", "entity_type": "package", "logical_key": "S1", "parent_id": "scene:S1", "state": package_state, "current_revision": None if package_state == "missing" else {"revision_id": "package:S1@1", "payload_json": "{}"}, "dependencies": [], "errors": ["no revision"] if package_state == "missing" else []},
            ],
            "prompt_jobs": [],
        }

    def test_generate_ready_plan_prioritizes_stale_storyboard(self):
        plan = production_orchestrator.build_plan(
            self.projection(), ["S1", "S1_test"], goal="S1 영상 생성 준비 완료 상태까지 만들어줘"
        )
        self.assertEqual(plan["target"], "generate_ready")
        self.assertFalse(plan["target_reached"])
        self.assertEqual(plan["next_step"]["stage"], "storyboard")
        self.assertEqual(plan["next_step"]["status"], "stale")
        self.assertEqual(plan["next_step"]["suggested_tool"], "save_production_object")
        self.assertFalse(plan["next_step"]["auto_execute"])
        self.assertTrue(plan["execution_policy"]["recheck_after_every_write"])

    def test_after_storyboard_refresh_prompt_is_next(self):
        plan = production_orchestrator.build_plan(
            self.projection(cut_state="accepted"), "S1", target="generate_ready"
        )
        self.assertEqual(plan["next_step"]["stage"], "prompts")
        self.assertEqual(plan["next_step"]["status"], "missing")
        self.assertEqual(plan["next_step"]["suggested_tool"], "get_filmmate_prompt_request")

    def test_handoff_target_includes_package_after_generate_ready(self):
        projection = self.projection(cut_state="accepted", prompt_state="accepted", package_state="missing")
        generate = production_orchestrator.build_plan(projection, "S1", target="generate_ready")
        handoff = production_orchestrator.build_plan(projection, "S1", goal="업로드 패키지까지 준비해줘")
        self.assertTrue(generate["target_reached"])
        self.assertEqual(handoff["target"], "handoff_ready")
        self.assertFalse(handoff["target_reached"])
        self.assertEqual(handoff["next_step"]["stage"], "handoff")
        self.assertEqual(handoff["next_step"]["suggested_tool"], "save_production_object")

    def test_stale_clear_goal_ignores_missing_prompt(self):
        plan = production_orchestrator.build_plan(
            self.projection(), "S1", goal="낡은 결과만 최신 revision으로 재생성해줘"
        )
        self.assertEqual(plan["target"], "stale_clear")
        self.assertEqual(len(plan["steps"]), 1)
        self.assertEqual(plan["next_step"]["stage"], "storyboard")

    def test_checkpoint_reports_no_change_until_canonical_state_moves(self):
        projection = self.projection()
        first = production_orchestrator.build_plan(projection, "S1")
        second = production_orchestrator.build_plan(projection, "S1", previous_checkpoint=first["checkpoint"])
        self.assertFalse(second["checkpoint_changed"])
        moved = self.projection(cut_state="accepted")
        third = production_orchestrator.build_plan(moved, "S1", previous_checkpoint=first["checkpoint"])
        self.assertTrue(third["checkpoint_changed"])

    def test_blocked_stage_never_has_auto_executor(self):
        projection = self.projection(cut_state="blocked", prompt_state="missing")
        projection["entities"][3]["errors"] = ["B_CONTINUITY: eyeline conflict"]
        plan = production_orchestrator.build_plan(projection, "S1")
        self.assertEqual(plan["stop_reason"], "blocked")
        self.assertIsNone(plan["next_step"]["suggested_tool"])
        self.assertTrue(plan["next_step"]["requires_user_action"])
        self.assertFalse(plan["next_step"]["auto_execute"])


if __name__ == "__main__":
    unittest.main()
