import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
import contextlib
import io
from pathlib import Path

from screenplay_analyzer import analyze_screenplay
from scene_breakdown import generate_breakdown
from package_compiler import compile_package
from core import hap_core
import mcp_server


class PipelineTests(unittest.TestCase):
    def decode(self, response):
        return json.loads(response["content"][0]["text"])

    def test_hap_mcp_registers_revision_artifact_qa_and_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            old = mcp_server.PACKAGES
            try:
                mcp_server.PACKAGES = Path(temp)
                project = Path(temp) / "P"
                with contextlib.redirect_stdout(io.StringIO()):
                    hap_core.cmd_init(type("A",(),{"project":str(project),"title":"테스트","project_id":"project:P","mode":"full"})())
                entity = self.decode(mcp_server.call("create_hap_entity",{"project":"P","entity_type":"scene","key":"S1","entity_id":"scene:S1","parent":"project:P"}))
                self.assertEqual(entity["entity_id"], "scene:S1")
                revision = self.decode(mcp_server.call("create_hap_revision",{"project":"P","entity_id":"scene:S1","producer":"sihap","payload":{"title":"옥상"},"source_evidence":[{"source":"input.txt:1"}]}))
                self.assertEqual(revision["revision_id"], "scene:S1@1")
                source = project / "S1.txt"; source.write_text("S#1. 옥상",encoding="utf-8")
                artifact = self.decode(mcp_server.call("register_hap_artifact",{"project":"P","revision_id":"scene:S1@1","kind":"screenplay","source":str(source)}))
                self.assertIn("artifact_id", artifact)
                rejected = self.decode(mcp_server.call("approve_hap_revision",{"project":"P","revision_id":"scene:S1@1","approver_type":"user","approver":"user","evidence":"승인"}))
                self.assertEqual(rejected["error"], "E_DIRECT_USER_APPROVAL_FORBIDDEN")
                report = project / "qa.json"; report.write_text("{}",encoding="utf-8")
                qa = self.decode(mcp_server.call("submit_hap_qa",{"project":"P","revision_id":"scene:S1@1","status":"pass","method":"view_image_and_text","checks":{"source_fidelity":True},"report":str(report)}))
                self.assertIn("qa_id", qa)
                approved = self.decode(mcp_server.call("approve_hap_revision",{"project":"P","revision_id":"scene:S1@1","approver_type":"delegated_user_policy","approver":"user","delegated_grant_id":"grant:test","evidence":"승인"}))
                self.assertIn("approval_id", approved)
                projection = self.decode(mcp_server.call("get_hap_projection",{"project":"P"}))
                scene = next(x for x in projection["entities"] if x["entity_id"]=="scene:S1")
                self.assertEqual(scene["state"], "accepted")
            finally:
                mcp_server.PACKAGES = old

    def test_hap_source_link_detects_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "P"
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_init(type("A", (), {"project": str(project), "title": "소스 점검", "project_id": "project:P", "mode": "full"})())
            source = Path(temp) / "skill"
            source.mkdir()
            (source / "SKILL.md").write_text("v1", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_link_source(type("A", (), {"project": str(project), "path": str(source), "label": "테스트 스킬", "kind": "skill", "required": True, "source_id": "source:test"})())
            projection = hap_core.write_projection(project, hap_core.connect(project))
            self.assertEqual(projection["source_links"][0]["status"], "connected")
            (source / "SKILL.md").write_text("v2", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_check_sources(type("A", (), {"project": str(project), "source_id": None})())
            projection = hap_core.write_projection(project, hap_core.connect(project))
            self.assertEqual(projection["source_links"][0]["status"], "changed")

    def test_mcp_does_not_expose_manual_completion(self):
        request = {"jsonrpc":"2.0","id":1,"method":"tools/list"}
        run = subprocess.run([sys.executable, "mcp_server.py"], input=json.dumps(request)+"\n", text=True, capture_output=True, check=True)
        response = json.loads(run.stdout.strip())
        names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertNotIn("complete_scene_stage", names)

    def test_manual_completion_call_is_rejected(self):
        request = {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"complete_scene_stage","arguments":{"project":"P","stage":"storyboard"}}}
        run = subprocess.run([sys.executable, "mcp_server.py"], input=json.dumps(request)+"\n", text=True, capture_output=True, check=True)
        response = json.loads(run.stdout.strip())
        payload = json.loads(response["result"]["content"][0]["text"])
        self.assertEqual(payload["error"], "E_STATUS_WRITE_FORBIDDEN")

    @unittest.skip("legacy mutable preview handoff superseded by HAP prompt jobs")
    def test_codex_prompt_bundle_handoff_is_atomic_and_protected(self):
        with tempfile.TemporaryDirectory() as temp:
            old = mcp_server.PACKAGES
            try:
                mcp_server.PACKAGES = Path(temp)
                request_dir = Path(temp) / "P" / "scenes" / "S1_test" / "previews" / "filmmate-codex-handoff" / "Seedance_2.0" / "shot" / "C01"
                request_dir.mkdir(parents=True)
                request = {
                    "schema_version": 1,
                    "project": "P",
                    "scene": "S1_test",
                    "model": "Seedance 2.0",
                    "unit_type": "shot",
                    "target_id": "C01",
                    "request_sha256": "request-hash",
                    "source_prompt": "CUT C01 {안녕}",
                    "protected_strings": ["CUT C01", "{안녕}"],
                    "skill_provenance": {"bundle_sha256": "skill-hash"},
                }
                (request_dir / "request.json").write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
                context = {"project":"P", "scene":"S1_test", "model":"Seedance 2.0", "unit_type":"shot", "target_id":"C01"}
                loaded = self.decode(mcp_server.call("get_filmmate_prompt_request", context))
                self.assertEqual(loaded["request"]["request_sha256"], "request-hash")
                delivered = self.decode(mcp_server.call("submit_filmmate_prompt_bundle", {
                    **context,
                    "request_sha256":"request-hash",
                    "skill_bundle_sha256":"skill-hash",
                    "prompt_variants":{"ko":"CUT C01 {안녕}", "en":"CUT C01 {안녕}", "zh":"CUT C01 {안녕}"},
                }))
                self.assertEqual(delivered["status"], "delivered")
                self.assertTrue((request_dir / "response.json").is_file())
                rejected = self.decode(mcp_server.call("submit_filmmate_prompt_bundle", {
                    **context,
                    "request_sha256":"request-hash",
                    "skill_bundle_sha256":"skill-hash",
                    "prompt_variants":{"ko":"CUT C01 {안녕}", "en":"CUT C01 hello", "zh":"CUT C01 {안녕}"},
                }))
                self.assertIn("E_PROMPT_HANDOFF_PROTECTED_MISMATCH", rejected["error"])
            finally:
                mcp_server.PACKAGES = old

    def test_hap_prompt_job_bundle_is_atomic_and_stales_on_input_change(self):
        with tempfile.TemporaryDirectory() as temp:
            from core import prompt_jobs
            project = Path(temp) / "P"
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_init(type("A", (), {"project":str(project), "title":"프롬프트 테스트", "project_id":"project:P", "mode":"full"})())
                hap_core.cmd_add_entity(type("A", (), {"project":str(project), "entity_type":"scene", "key":"S1", "entity_id":"scene:S1", "parent":"project:P", "mode":"full"})())
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"scene:S1", "producer":"conhap", "payload":json.dumps({"scene_id":"S1"}), "evidence":json.dumps([{"kind":"screenplay"}]), "revision_id":None, "depends_on":[], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
            asset = project / "assets" / "character.png"
            asset.parent.mkdir(parents=True)
            asset.write_bytes(b"test-image")
            reference = {"order":1, "tag":"@Image 1", "role":"character", "name":"character.png", "path":"assets/character.png", "sha256":hap_core.digest(asset), "source_revision":"scene:S1@1", "use":"identity and continuity only", "exclude":"do not inherit unrelated pose", "provenance":"test asset"}
            request = {"schema_version":3, "project":"P", "scene":"S1", "model":"Seedance 2.0", "unit_type":"shot", "input_mode":"reference_to_video", "target_id":"C01", "duration_ms":5000, "cut_ids":["C01"], "source_prompt":"CUT C01 {안녕}", "protected_strings":["CUT C01","{안녕}"], "references":[reference], "required_reference_roles":[], "input_revisions":[{"revision_id":"scene:S1@1","role":"scene"}], "source_evidence":[{"kind":"test"}], "model_profile":{"name":"Seedance 2.0", "scope":"shot", "duration_ms":5000}, "skill_provenance":{"name":"seedance-prompt-rules", "entrypoint":"SKILL.md", "bundle_sha256":"skill-hash", "status":"PASS"}}
            first = prompt_jobs.enqueue(project, request)
            second = prompt_jobs.enqueue(project, request)
            self.assertEqual(first["job"]["job_id"], second["job"]["job_id"])
            claimed = prompt_jobs.claim(project, first["job"]["job_id"], actor="codex-worker")
            prompt_ir = {"schema_version":3, "project_id":"P", "scene_id":"S1", "scope":"shot", "input_mode":"reference_to_video", "target_id":"C01", "model_profile":{"name":"Seedance 2.0"}, "duration_ms":5000, "references":[reference], "timeline":[{"cut_id":"C01", "start_ms":0, "end_ms":5000, "start_state":"인물이 서 있다.", "central_action":"인물이 멈춘다.", "camera":"미디엄 고정.", "end_state":"인물이 정지한다.", "audio":{"dialogue":"{안녕}"}}], "global_locks":{"character":"character.png 고정", "continuity":"이전 상태 유지"}, "negative_constraints":["새 인물 추가 금지"], "source_map":[{"source":"test", "target":"C01"}]}
            variants = {"ko":"— 도구 설정 —\n— 레퍼런스 역할 —\n— 정본·연속성 잠금 —\n— 실행 규칙 —\n— 하드 타임라인 —\nCUT C01 @Image 1\n중심 행동: 인물이 멈춘다.\n카메라: 미디엄 고정.\n엔드스테이트: 인물이 정지한다.\n— 사운드·텍스트 공통 잠금 — {안녕}\n— 핵심 금지 —\n— 콘티 반영 결과 —", "en":"— TOOL SETTINGS —\n— REFERENCE ROLES —\n— CANON AND CONTINUITY LOCKS —\n— EXECUTION RULES —\n— HARD TIMELINE —\nCUT C01 @Image 1\nCentral action: The person stops.\nCamera: Locked medium shot.\nEnd state: The person is still.\n— SHARED AUDIO AND TEXT LOCKS — {안녕}\n— CORE PROHIBITIONS —\n— STORYBOARD PRESERVATION RESULT —", "zh":"— 工具设置 —\n— 参考素材角色 —\n— 正本与连续性锁定 —\n— 执行规则 —\n— 硬时间线 —\nCUT C01 @Image 1\n中心动作：人物停下。\n摄影机：固定中景。\n结束状态：人物保持静止。\n— 音频与文本通用锁定 — {안녕}\n— 核心禁止项 —\n— 分镜保留结果 —"}
            submitted = prompt_jobs.submit(project, first["job"]["job_id"], {"claim_token":claimed["job"]["claim_token"], "request_sha256":first["job"]["request_sha256"], "skill_bundle_sha256":"skill-hash", "prompt_ir":prompt_ir, "prompt_variants":variants, "engine":"test-codex"})
            self.assertEqual(submitted["job"]["state"], "READY")
            self.assertEqual(submitted["qa"]["status"], "PASS")
            approved = prompt_jobs.approve(project, first["job"]["job_id"])
            self.assertEqual(approved["job"]["state"], "USER_APPROVED")
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"scene:S1", "producer":"conhap", "payload":json.dumps({"scene_id":"S1", "changed":True}), "evidence":json.dumps([{"kind":"test-change"}]), "revision_id":None, "depends_on":[], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
            stale = prompt_jobs.by_id(project, first["job"]["job_id"])
            self.assertEqual(stale["job"]["effective_state"], "STALE")

    def test_prompt_gate_rejects_old_or_text_only_conti_structure(self):
        from core import prompt_jobs
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "P"
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_init(type("A", (), {"project":str(project), "title":"입력 게이트", "project_id":"project:P", "mode":"full"})())
                hap_core.cmd_add_entity(type("A", (), {"project":str(project), "entity_type":"scene", "key":"S1", "entity_id":"scene:S1", "parent":"project:P", "mode":"full"})())
                hap_core.cmd_add_entity(type("A", (), {"project":str(project), "entity_type":"block", "key":"S1_CONHAP", "entity_id":"block:S1_CONHAP", "parent":"scene:S1", "mode":"full"})())
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"scene:S1", "producer":"test", "payload":json.dumps({"scene_id":"S1"}), "evidence":json.dumps([{"kind":"screenplay"}]), "revision_id":None, "depends_on":[], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"block:S1_CONHAP", "producer":"conhap", "payload":json.dumps({"scene_id":"S1"}), "evidence":json.dumps([{"kind":"conti"}]), "revision_id":None, "depends_on":["scene:S1@1:role=screenplay"], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
            db = hap_core.connect(project)
            hap_core.add_artifact_bytes(project, db, revision_id="block:S1_CONHAP@1", kind="block_manifest", data=b'{"block_id":"B01"}\n', mime="application/json")
            hap_core.add_artifact_bytes(project, db, revision_id="block:S1_CONHAP@1", kind="written_storyboard", data=b'# conti\n', mime="text/markdown")
            db.commit()
            db.close()
            request = {
                "schema_version":3, "project":"P", "scene":"S1", "model":"Seedance 2.0",
                "unit_type":"block", "input_mode":"text_to_video", "target_id":"B01",
                "duration_ms":15000, "cut_ids":["C01"], "source_prompt":"CUT C01",
                "protected_strings":["CUT C01"], "references":[], "required_reference_roles":[],
                "input_revisions":[
                    {"revision_id":"scene:S1@1", "role":"scene"},
                    {"revision_id":"block:S1_CONHAP@1", "role":"written_storyboard"},
                ],
                "source_evidence":[{"kind":"test"}],
                "skill_provenance":{"name":"seedance-prompt-rules", "entrypoint":"SKILL.md", "bundle_sha256":"skill-hash", "status":"PASS"},
            }
            queued = prompt_jobs.enqueue(project, request)
            claimed = prompt_jobs.claim(project, queued["job"]["job_id"], actor="codex-worker")
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"scene:S1", "producer":"test", "payload":json.dumps({"scene_id":"S1", "changed":True}), "evidence":json.dumps([{"kind":"edit"}]), "revision_id":None, "depends_on":[], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
            with self.assertRaisesRegex(ValueError, "E_PROMPT_INPUT_STALE:scene:S1@1:scene:S1@2"):
                prompt_jobs.submit(project, queued["job"]["job_id"], {
                    "claim_token":claimed["job"]["claim_token"],
                    "request_sha256":queued["job"]["request_sha256"],
                    "skill_bundle_sha256":"skill-hash",
                })

            db = hap_core.connect(project)
            revision, _ = hap_core.commit_revision(
                project,
                db,
                entity_id="block:S1_CONHAP",
                producer="filmmate-document-editor",
                payload={"scene_id":"S1", "structured_sync_required":True},
                source_evidence=[{"kind":"user_edit"}],
                dependencies=[("scene:S1@2", "screenplay")],
                expected_revision_id="block:S1_CONHAP@1",
                enforce_expected=True,
            )
            hap_core.add_artifact_bytes(project, db, revision_id=revision["revision_id"], kind="block_manifest", data=b'{"structured_sync_required":true}\n', mime="application/json")
            hap_core.add_artifact_bytes(project, db, revision_id=revision["revision_id"], kind="written_storyboard", data=b'# edited conti\n', mime="text/markdown")
            db.commit()
            db.close()
            blocked_request = {
                **request,
                "source_prompt":"CUT C01 changed",
                "input_revisions":[
                    {"revision_id":"scene:S1@2", "role":"scene"},
                    {"revision_id":"block:S1_CONHAP@2", "role":"written_storyboard"},
                ],
            }
            with self.assertRaisesRegex(ValueError, "E_PROMPT_CONTI_STRUCTURE_STALE:block:S1_CONHAP@2"):
                prompt_jobs.enqueue(project, blocked_request)

    def test_text_to_video_prompt_does_not_require_or_invent_references(self):
        from core import prompt_ir, prompt_jobs
        request = {
            "schema_version":3, "project":"P", "scene":"S1", "model":"Seedance 2.0",
            "unit_type":"shot", "input_mode":"text_to_video", "target_id":"C01",
            "duration_ms":5000, "cut_ids":["C01"], "source_prompt":"CUT C01 {안녕}",
            "protected_strings":["CUT C01", "{안녕}"], "references":[],
            "required_reference_roles":[],
            "skill_provenance":{"name":"seedance-prompt-rules", "bundle_sha256":"skill-hash", "status":"PASS"},
        }
        prompt_jobs._validate_request(request)
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "P"
            with contextlib.redirect_stdout(io.StringIO()):
                hap_core.cmd_init(type("A", (), {"project":str(project), "title":"텍스트 영상", "project_id":"project:P", "mode":"full"})())
                hap_core.cmd_add_entity(type("A", (), {"project":str(project), "entity_type":"scene", "key":"S1", "entity_id":"scene:S1", "parent":"project:P", "mode":"full"})())
                hap_core.cmd_commit(type("A", (), {"project":str(project), "entity":"scene:S1", "producer":"conhap", "payload":json.dumps({"scene_id":"S1"}), "evidence":json.dumps([{"kind":"screenplay"}]), "revision_id":None, "depends_on":[], "expected_revision_id":None, "idempotency_key":None, "request_sha256":None, "actor":"test"})())
            queued = prompt_jobs.enqueue(project, {**request, "input_revisions":[{"revision_id":"scene:S1@1", "role":"scene"}]})
            self.assertEqual(queued["job"]["state"], "QUEUED")
            self.assertEqual(queued["request"]["input_mode"], "text_to_video")
            self.assertEqual(queued["request"]["references"], [])
        ir = {
            "schema_version":3, "project_id":"P", "scene_id":"S1", "scope":"shot",
            "input_mode":"text_to_video", "target_id":"C01", "model_profile":{"name":"Seedance 2.0"},
            "duration_ms":5000, "references":[],
            "timeline":[{"cut_id":"C01", "start_ms":0, "end_ms":5000, "start_state":"서 있다.", "central_action":"멈춘다.", "camera":"고정 미디엄.", "end_state":"정지한다."}],
            "global_locks":{"continuity":"정본 유지"}, "negative_constraints":["새 인물 금지"],
            "source_map":[{"source":"screenplay", "target":"C01"}],
        }
        variants = {
            "ko":"— 도구 설정 —\n— 레퍼런스 역할 —\n레퍼런스 없음. @태그를 만들지 않는다.\n— 정본·연속성 잠금 —\n— 실행 규칙 —\n— 하드 타임라인 —\nCUT C01\n중심 행동: 멈춘다.\n카메라: 고정 미디엄.\n엔드스테이트: 정지한다.\n— 사운드·텍스트 공통 잠금 — {안녕}\n— 핵심 금지 —\n— 콘티 반영 결과 —",
            "en":"— TOOL SETTINGS —\n— REFERENCE ROLES —\nNo references. Do not invent tags.\n— CANON AND CONTINUITY LOCKS —\n— EXECUTION RULES —\n— HARD TIMELINE —\nCUT C01\nCentral action: Stop.\nCamera: Locked medium.\nEnd state: Still.\n— SHARED AUDIO AND TEXT LOCKS — {안녕}\n— CORE PROHIBITIONS —\n— STORYBOARD PRESERVATION RESULT —",
            "zh":"— 工具设置 —\n— 参考素材角色 —\n无参考素材，不创建标签。\n— 正本与连续性锁定 —\n— 执行规则 —\n— 硬时间线 —\nCUT C01\n中心动作：停下。\n摄影机：固定中景。\n结束状态：保持静止。\n— 音频与文本通用锁定 — {안녕}\n— 核心禁止项 —\n— 分镜保留结果 —",
        }
        qa = prompt_ir.validate_prompt_bundle(request, ir, variants)
        self.assertEqual(qa["status"], "PASS")
        self.assertTrue(all("@Image" not in value for value in variants.values()))
        invented = {**variants, "en": variants["en"].replace("CUT C01", "CUT C01 @Image 1")}
        invented_qa = prompt_ir.validate_prompt_bundle(request, ir, invented)
        self.assertEqual(invented_qa["status"], "FAIL")
        self.assertIn("E_PROMPT_REFERENCE_TAGS_UNEXPECTED:en", invented_qa["issues"])
        invalid = {**request, "input_mode":"reference_to_video"}
        with self.assertRaisesRegex(ValueError, "reference_mode_requires_reference"):
            prompt_jobs._validate_request(invalid)

    def test_korean_scene_split_preserves_spans(self):
        text = "S#1. 주택가 옥상 / 늦은 오후\n기석이 올라온다.\n\nS2. 주택가 골목 / 밤\n기석이 걷는다."
        result = analyze_screenplay(text)
        self.assertEqual(result["scene_count"], 2)
        self.assertEqual(result["scenes"][0]["title"], "주택가 옥상")
        self.assertEqual(result["scenes"][1]["time"], "밤")
        self.assertEqual(text[result["scenes"][0]["source_start"]:result["scenes"][0]["source_end"]].strip(), result["scenes"][0]["source_text"])

    def test_blocks_are_at_most_fifteen_seconds(self):
        with tempfile.TemporaryDirectory() as temp:
            import scene_breakdown
            old = scene_breakdown.PACKAGES
            try:
                scene_breakdown.PACKAGES = Path(temp)
                scene = Path(temp) / "P" / "scenes" / "S1_test" / "scene-data"
                scene.mkdir(parents=True)
                (scene / "scene-manifest.json").write_text(json.dumps({"title":"테스트","location":"옥상","time":"밤","created_at":"x"}), encoding="utf-8")
                result = generate_breakdown("P", "S1_test", duration=38, shot_count=7)["breakdown"]
                self.assertEqual(sum(block["duration_sec"] for block in result["blocks"]), 38)
                self.assertTrue(all(block["duration_sec"] <= 15 for block in result["blocks"]))
            finally:
                scene_breakdown.PACKAGES = old

    def test_delivery_zip_matches_upload_order(self):
        with tempfile.TemporaryDirectory() as temp:
            import package_compiler
            old = package_compiler.PACKAGES
            try:
                package_compiler.PACKAGES = Path(temp)
                root = Path(temp) / "P" / "scenes" / "S1_test"
                (root / "scene-data").mkdir(parents=True)
                (root / "artifacts" / "reference").mkdir(parents=True)
                (root / "scene-data" / "scene-manifest.json").write_text(json.dumps({"title":"테스트","created_at":"x"}), encoding="utf-8")
                (root / "scene-data" / "artifacts.json").write_text(json.dumps({"artifacts":[{"logical_id":"b","version":1,"role":"reference","file":"artifacts/reference/b.txt"},{"logical_id":"a","version":1,"role":"reference","file":"artifacts/reference/a.txt"}]}), encoding="utf-8")
                (root / "artifacts" / "reference" / "a.txt").write_text("a", encoding="utf-8")
                (root / "artifacts" / "reference" / "b.txt").write_text("b", encoding="utf-8")
                result = compile_package("P", "S1_test")
                with zipfile.ZipFile(result["zip"]) as archive:
                    order = json.loads(archive.read("upload-order.json"))
                    self.assertEqual([r["filename"] for r in result["references"]], [r["filename"] for r in order["references"]])
                    self.assertIn(result["references"][0]["filename"], archive.namelist())
            finally:
                package_compiler.PACKAGES = old


if __name__ == "__main__":
    unittest.main()
