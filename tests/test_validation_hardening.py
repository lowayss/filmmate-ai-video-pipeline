import copy
import tempfile
import unittest
from pathlib import Path

from core import micro_shot, prompt_ir


def base_ir():
    return {
        "schema_version": 3,
        "project_id": "P",
        "scene_id": "S1",
        "scope": "shot",
        "target_id": "C01",
        "input_mode": "text_to_video",
        "model_profile": {"name": "Seedance 2.0"},
        "duration_ms": 5000,
        "references": [],
        "timeline": [{
            "cut_id": "C01",
            "start_ms": 0,
            "end_ms": 5000,
            "start_state": "시작 상태",
            "central_action": "한 가지 행동",
            "camera": "고정 카메라",
            "end_state": "종료 상태",
            "audio": {},
            "performance": None,
        }],
        "global_locks": {"continuity": "keep"},
        "negative_constraints": ["no drift"],
        "source_map": [{"source": "test", "target": "C01"}],
    }


def ref(order, tag, role, digest):
    return {
        "order": order,
        "tag": tag,
        "external_id": tag.replace("@", ""),
        "media_type": "image",
        "source_kind": "asset",
        "role": role,
        "path": f"{role}.png",
        "sha256": digest,
    }


class ValidationHardeningTests(unittest.TestCase):
    def test_validate_ir_is_pure_for_cut_alias(self):
        data = base_ir()
        data["scope"] = "cut"
        before = copy.deepcopy(data)
        issues = prompt_ir.validate_ir(
            data,
            request={"unit_type": "shot", "input_mode": "text_to_video"},
        )
        self.assertNotIn("E_IR_SCOPE_REQUEST_MISMATCH", issues)
        self.assertEqual(data, before)

    def test_validate_ir_rejects_non_object_without_crashing(self):
        self.assertEqual(prompt_ir.validate_ir([]), ["E_IR_DOCUMENT_INVALID"])
        self.assertEqual(prompt_ir.validate_ir(None), ["E_IR_DOCUMENT_INVALID"])

    def test_bool_is_not_accepted_as_duration_or_timeline_time(self):
        data = base_ir()
        data["duration_ms"] = True
        data["timeline"][0]["end_ms"] = True
        issues = prompt_ir.validate_ir(data, request={"input_mode": "text_to_video"})
        self.assertIn("E_IR_DURATION_INVALID", issues)
        self.assertIn("E_IR_TIME_RANGE:0", issues)

    def test_malformed_required_roles_returns_issue_code(self):
        request = {
            "workflow_mode": "micro_shot",
            "duration_ms": 8000,
            "micro_brief": "테스트",
            "unit_type": "shot",
            "input_mode": "reference_to_video",
            "required_reference_roles": "character",
            "references": [
                ref(1, "@Image 1", "character", "1" * 64),
                ref(2, "@Image 2", "background", "2" * 64),
            ],
        }
        issues = micro_shot.micro_shot_issues(request)
        self.assertIn("E_MICRO_REQUIRED_ROLES_INVALID", issues)

    def test_micro_shot_rejects_malformed_sha256(self):
        request = {
            "workflow_mode": "micro_shot",
            "duration_ms": 8000,
            "micro_brief": "테스트",
            "unit_type": "shot",
            "input_mode": "reference_to_video",
            "required_reference_roles": ["character", "background"],
            "references": [
                ref(1, "@Image 1", "character", "not-a-hash"),
                ref(2, "@Image 2", "background", "2" * 64),
            ],
        }
        issues = micro_shot.micro_shot_issues(request)
        self.assertIn("E_MICRO_REFERENCE_HASH_INVALID:1", issues)

    def test_invalid_request_reference_is_reported_not_raised(self):
        data = base_ir()
        data["input_mode"] = "reference_to_video"
        data["references"] = [{
            "order": 1,
            "tag": "@Image 1",
            "role": "character",
            "sha256": "1" * 64,
            "use": "identity",
            "exclude": "pose",
            "provenance": "test",
        }]
        issues = prompt_ir.validate_ir(
            data,
            request={"input_mode": "reference_to_video", "references": ["bad-reference"]},
        )
        self.assertIn("E_IR_REQUEST_REFERENCE_INVALID:1", issues)

    def test_compile_package_rejects_file_output_path_cleanly(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ir = base_ir()
            ir["prompt_variants"] = {
                "ko": "ko",
                "en": "en",
                "zh": "zh",
            }
            ir_path = root / "ir.json"
            import json
            ir_path.write_text(json.dumps(ir, ensure_ascii=False), encoding="utf-8")
            output = root / "already-a-file"
            output.write_text("x", encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "output package path must be a directory"):
                prompt_ir.compile_package(ir_path, root, output)


if __name__ == "__main__":
    unittest.main()
