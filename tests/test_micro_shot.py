import unittest

from core import micro_shot, prompt_ir, prompt_jobs


def reference(order, tag, role, media_type, name, path, digest):
    return {
        "order": order,
        "tag": tag,
        "external_id": tag.replace("@", ""),
        "media_type": media_type,
        "source_kind": "previs" if role == "motion" else "asset",
        "role": role,
        "name": name,
        "path": path,
        "sha256": digest,
        "source_revision": "",
        "use": "motion, blocking, camera, and timing only" if role == "motion" else f"{role} identity and continuity only",
        "exclude": "do not inherit placeholder identity, wardrobe, background, or style" if role == "motion" else "do not inherit unrelated pose, camera, or background details",
        "provenance": "test",
    }


class MicroShotContractTests(unittest.TestCase):
    def setUp(self):
        self.references = [
            reference(1, "@Video 1", "motion", "video", "previs.mp4", "artifacts/prompt_inputs/motion/previs.mp4", "1" * 64),
            reference(2, "@Image 1", "character", "image", "character.png", "artifacts/prompt_inputs/character/character.png", "2" * 64),
            reference(3, "@Image 2", "background", "image", "background.png", "artifacts/prompt_inputs/background/background.png", "3" * 64),
        ]
        self.request = {
            "schema_version": 3,
            "project": "P",
            "scene": "S1",
            "model": "Seedance 2.0",
            "workflow_mode": micro_shot.WORKFLOW_MODE,
            "unit_type": "shot",
            "input_mode": "reference_to_video",
            "target_id": "MICRO_01",
            "duration_ms": 8000,
            "cut_ids": ["MICRO_01"],
            "micro_brief": "인물이 낡은 놀이공원 입구를 발견하고 안으로 들어간다.",
            "source_prompt": "CUT MICRO_01 @Video 1 @Image 1 @Image 2",
            "protected_strings": ["CUT MICRO_01", "@Video 1", "@Image 1", "@Image 2"],
            "references": self.references,
            "required_reference_roles": ["character", "background"],
            "skill_provenance": {"name": "seedance-prompt-rules", "status": "PASS", "bundle_sha256": "skill"},
        }

    def test_mixed_media_tags_follow_external_input_order(self):
        self.assertEqual(
            micro_shot.expected_reference_values(self.references),
            [("@Video 1", "Video 1", "video"), ("@Image 1", "Image 1", "image"), ("@Image 2", "Image 2", "image")],
        )
        prompt_jobs._validate_request(self.request)

    def test_micro_shot_requires_four_to_fifteen_seconds(self):
        invalid = {**self.request, "duration_ms": 3_999}
        with self.assertRaisesRegex(ValueError, "E_PROMPT_MICRO_SHOT_GATE:E_MICRO_DURATION_RANGE"):
            prompt_jobs._validate_request(invalid)

    def test_prompt_bundle_preserves_video_and_image_tags(self):
        ir = {
            "schema_version": 3,
            "project_id": "P",
            "scene_id": "S1",
            "scope": "shot",
            "target_id": "MICRO_01",
            "input_mode": "reference_to_video",
            "model_profile": {"name": "Seedance 2.0"},
            "duration_ms": 8000,
            "references": self.references,
            "timeline": [{
                "cut_id": "MICRO_01",
                "start_ms": 0,
                "end_ms": 8000,
                "start_state": "인물이 탈을 벗고 땀을 흘리며 서 있다.",
                "central_action": "인물이 낡은 입구를 발견하고 안으로 들어간다.",
                "camera": "프리비즈의 진행 방향을 따르는 느린 트래킹 하나.",
                "end_state": "인물이 입구 안쪽에서 멈춘다.",
                "audio": {},
                "performance": None,
            }],
            "global_locks": {"continuity": "정본 입력 순서와 상태 유지"},
            "negative_constraints": ["프리비즈의 인물·의상·배경을 복사하지 않는다."],
            "source_map": [{"source": "micro_brief", "target": "MICRO_01"}],
        }
        variants = {
            "ko": "— 도구 설정 —\n— 레퍼런스 역할 —\n@Video 1 @Image 1 @Image 2\n— 정본·연속성 잠금 —\n— 실행 규칙 —\n— 하드 타임라인 —\nCUT MICRO_01\n중심 행동: 입구로 들어간다.\n카메라: 트래킹.\n엔드스테이트: 안쪽에 멈춘다.\n— 사운드·텍스트 공통 잠금 —\n— 핵심 금지 —\n— 콘티 반영 결과 —",
            "en": "— TOOL SETTINGS —\n— REFERENCE ROLES —\n@Video 1 @Image 1 @Image 2\n— CANON AND CONTINUITY LOCKS —\n— EXECUTION RULES —\n— HARD TIMELINE —\nCUT MICRO_01\nCentral action: Enter the entrance.\nCamera: Tracking.\nEnd state: Stops inside.\n— SHARED AUDIO AND TEXT LOCKS —\n— CORE PROHIBITIONS —\n— STORYBOARD PRESERVATION RESULT —",
            "zh": "— 工具设置 —\n— 参考素材角色 —\n@Video 1 @Image 1 @Image 2\n— 正本与连续性锁定 —\n— 执行规则 —\n— 硬时间线 —\nCUT MICRO_01\n中心动作：走进入口。\n摄影机：跟踪。\n结束状态：在里面停下。\n— 音频与文本通用锁定 —\n— 核心禁止项 —\n— 分镜保留结果 —",
        }
        qa = prompt_ir.validate_prompt_bundle(self.request, ir, variants)
        self.assertEqual(qa["status"], "PASS", qa["issues"])
        for language in ("ko", "en", "zh"):
            self.assertIn("@Video 1", variants[language])
            self.assertIn("@Image 1", variants[language])
            self.assertIn("@Image 2", variants[language])


if __name__ == "__main__":
    unittest.main()
