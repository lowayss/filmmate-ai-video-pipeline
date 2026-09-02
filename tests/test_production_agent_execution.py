import json
import unittest
from pathlib import Path
from unittest import mock

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

    def test_apply_object_proposal_pins_dependency_revisions_and_uses_canonical_mutation(self):
        work_order = {
            "schema_version": 1,
            "run_id": "run:1",
            "task_id": "task:1",
            "scene": "S1",
            "claim_token": "claim:1",
            "claim_checkpoint": "checkpoint:1",
            "mode": "proposal",
            "stage": "storyboard",
            "suggested_tool": "save_production_object",
            "target_entity": {"entity_type": "cut", "logical_key": "C01", "revision_id": "cut:C01@3"},
            "upstream_dependencies": [
                {"entity_id": "asset:hero", "role": "assets", "revision_id": "asset:hero@2"},
                {"entity_id": "scene:S1", "role": "analysis", "revision_id": "scene:S1@1"},
            ],
        }
        proposal = {
            "schema_version": 1,
            "decision": "execute",
            "tool": "save_production_object",
            "args": {"object_type": "cut", "key": "C01", "stage": "storyboard", "payload": {"shot": "CU"}},
            "reason": None,
        }
        completed_run = {
            "checkpoint": "checkpoint:2",
            "tasks": [{"task_id": "task:1", "state": "COMPLETE"}],
        }
        with mock.patch.object(production_agent_execution, "build_work_order", return_value=work_order), \
             mock.patch.object(production_agent_execution.production_commands, "save_production_object", return_value={"revision_id": "cut:C01@4"}) as save, \
             mock.patch.object(production_agent_execution.production_agent_jobs, "refresh_run", return_value=completed_run) as refresh:
            result = production_agent_execution.apply_proposal(
                Path("/tmp/project"), None, ["S1"], run_id="run:1", task_id="task:1", claim_token="claim:1", proposal=proposal
            )
        self.assertTrue(result["resolved"])
        args = save.call_args.args
        request = args[3]
        self.assertIsNone(args[1])
        self.assertEqual(request["expected_revision_id"], "cut:C01@3")
        self.assertEqual(
            request["dependencies"],
            [
                {"entity_id": "asset:hero", "role": "assets", "revision_id": "asset:hero@2"},
                {"entity_id": "scene:S1", "role": "analysis", "revision_id": "scene:S1@1"},
            ],
        )
        self.assertEqual(request["claim_guard"], {
            "run_id": "run:1", "task_id": "task:1", "claim_token": "claim:1", "claim_checkpoint": "checkpoint:1"
        })
        self.assertIsNone(refresh.call_args.args[2])

    def test_apply_conti_proposal_carries_claim_guard_into_document_transaction(self):
        work_order = {
            "schema_version": 1,
            "run_id": "run:1",
            "task_id": "task:1",
            "scene": "S1",
            "claim_token": "claim:1",
            "claim_checkpoint": "checkpoint:1",
            "mode": "proposal",
            "stage": "conti",
            "suggested_tool": "save_filmmate_document",
            "target_entity": None,
            "upstream_dependencies": [],
            "documents": {
                "scene": "S1",
                "documents": {
                    "screenplay": {"revision_id": "scene:S1@2"},
                    "conti": {"revision_id": "block:S1_CONHAP@3"},
                },
            },
        }
        proposal = {
            "schema_version": 1,
            "decision": "execute",
            "tool": "save_filmmate_document",
            "args": {"kind": "conti", "content": "C01. 문이 열린다."},
            "reason": None,
        }
        completed_run = {
            "checkpoint": "checkpoint:2",
            "tasks": [{"task_id": "task:1", "state": "COMPLETE"}],
        }
        with mock.patch.object(production_agent_execution, "build_work_order", return_value=work_order), \
             mock.patch.object(production_agent_execution.filmmate_documents, "save_document", return_value={"revision_id": "block:S1_CONHAP@4"}) as save, \
             mock.patch.object(production_agent_execution.production_agent_jobs, "refresh_run", return_value=completed_run):
            result = production_agent_execution.apply_proposal(
                Path("/tmp/project"), None, ["S1"], run_id="run:1", task_id="task:1", claim_token="claim:1", proposal=proposal
            )
        self.assertTrue(result["resolved"])
        payload = save.call_args.args[0]
        self.assertEqual(payload["expected_revision_id"], "block:S1_CONHAP@3")
        self.assertEqual(payload["expected_scene_revision_id"], "scene:S1@2")
        self.assertEqual(payload["claim_guard"], {
            "run_id": "run:1", "task_id": "task:1", "claim_token": "claim:1", "claim_checkpoint": "checkpoint:1"
        })

    def test_desktop_schema_cannot_propose_approval(self):
        schema = json.loads((Path(__file__).parents[1] / "desktop" / "production-agent-action.schema.json").read_text(encoding="utf-8"))
        tools = schema["properties"]["tool"]["enum"]
        self.assertNotIn("approve_production_object", tools)
        self.assertNotIn("approve_hap_revision", tools)


if __name__ == "__main__":
    unittest.main()
