import json
import unittest
from pathlib import Path

from core import production_agent_execution


class ProductionAgentExecutionTests(unittest.TestCase):
    def test_prompt_and_review_tasks_are_never_auto_executed(self):
        mode, reason = production_agent_execution.task_execution_mode({
            "stage": "prompts", "plan_status": "missing", "suggested_tool": "get_filmmate_prompt_request"
        })
        self.assertEqual(mode, "manual")
        self.assertIn("prompt_pipeline", reason)
        mode, reason = production_agent_execution.task_execution_mode({
            "stage": "storyboard", "plan_status": "needs_review", "suggested_tool": "submit_hap_qa"
        })
        self.assertEqual(mode, "manual")
        self.assertIn("needs_review", reason)

    def test_conti_proposal_is_narrow_and_cannot_rewrite_screenplay(self):
        work_order = {"mode": "proposal", "stage": "conti", "suggested_tool": "save_filmmate_document"}
        normalized = production_agent_execution.validate_proposal(work_order, {
            "schema_version": 1,
            "decision": "execute",
            "tool": "save_filmmate_document",
            "args": {"kind": "conti", "content": "C01. 인물이 문을 연다."},
            "reason": None,
        })
        self.assertEqual(normalized["args"]["kind"], "conti")
        with self.assertRaisesRegex(ValueError, "CONTI_PROPOSAL_INVALID"):
            production_agent_execution.validate_proposal(work_order, {
                "schema_version": 1,
                "decision": "execute",
                "tool": "save_filmmate_document",
                "args": {"kind": "screenplay", "content": "원문 변경"},
                "reason": None,
            })

    def test_object_identity_is_forced_to_current_stale_target(self):
        work_order = {
            "mode": "proposal",
            "stage": "storyboard",
            "suggested_tool": "save_production_object",
            "target_entity": {"entity_type": "cut", "logical_key": "C07", "revision_id": "cut:C07@3"},
        }
        normalized = production_agent_execution.validate_proposal(work_order, {
            "schema_version": 1,
            "decision": "execute",
            "tool": "save_production_object",
            "args": {"object_type": "block", "key": "invented", "stage": "storyboard", "payload": {"shot_intent": "current canon"}},
            "reason": None,
        })
        self.assertEqual(normalized["args"]["object_type"], "cut")
        self.assertEqual(normalized["args"]["key"], "C07")

    def test_approval_and_claim_fields_are_rejected_from_model_output(self):
        work_order = {"mode": "proposal", "stage": "assets", "suggested_tool": "save_production_object", "target_entity": None}
        with self.assertRaisesRegex(ValueError, "PROPOSAL_ARGS_INVALID"):
            production_agent_execution.validate_proposal(work_order, {
                "schema_version": 1,
                "decision": "execute",
                "tool": "save_production_object",
                "args": {"object_type": "asset", "key": "hero", "payload": {"approval_id": "fake"}},
                "reason": None,
            })
        self.assertNotIn("approve_production_object", production_agent_execution.AUTO_TOOLS)
        self.assertNotIn("approve_hap_revision", production_agent_execution.AUTO_TOOLS)

    def test_user_input_decision_requires_reason(self):
        work_order = {"mode": "proposal", "stage": "assets", "suggested_tool": "save_production_object"}
        normalized = production_agent_execution.validate_proposal(work_order, {
            "schema_version": 1, "decision": "needs_user_input", "tool": None, "args": {}, "reason": "actual character image generation is required"
        })
        self.assertEqual(normalized["decision"], "needs_user_input")
        with self.assertRaisesRegex(ValueError, "USER_INPUT_REASON_REQUIRED"):
            production_agent_execution.validate_proposal(work_order, {
                "schema_version": 1, "decision": "needs_user_input", "tool": None, "args": {}, "reason": ""
            })

    def test_desktop_schema_cannot_propose_approval(self):
        schema = json.loads((Path(__file__).parents[1] / "desktop" / "production-agent-action.schema.json").read_text(encoding="utf-8"))
        tools = schema["properties"]["tool"]["enum"]
        self.assertNotIn("approve_production_object", tools)
        self.assertNotIn("approve_hap_revision", tools)


if __name__ == "__main__":
    unittest.main()
