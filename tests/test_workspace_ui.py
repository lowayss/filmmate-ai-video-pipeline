import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"


class WorkspaceUiContractTests(unittest.TestCase):
    def test_workspace_assets_are_packaged_and_versioned(self):
        package = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["version"], "0.7.2")
        self.assertIn("workspace-ui.css", package["build"]["files"])
        self.assertIn("workspace-ui.js", package["build"]["files"])
        html = (DESKTOP / "index.html").read_text(encoding="utf-8")
        self.assertIn('<link rel="stylesheet" href="workspace-ui.css">', html)
        self.assertIn('<script src="workspace-ui.js"></script>', html)

    def test_codex_generation_requires_explicit_action(self):
        source = (DESKTOP / "prompt-languages.js").read_text(encoding="utf-8")
        self.assertEqual(source.count("startWorker:true"), 1)
        self.assertIn("request.onclick=()=>", source)
        self.assertIn("jobState:'IDLE'", source)
        self.assertNotIn("schedulePromptHandoff(record,{immediate:true,startWorker:true})", source)
        self.assertNotIn("schedulePromptHandoff(record,{immediate:false,startWorker:true})", source)

    def test_workspace_layer_keeps_management_contracts_visible(self):
        source = (DESKTOP / "workspace-ui.js").read_text(encoding="utf-8")
        for token in (
            "filmmate.workspace.v1",
            "다음 작업",
            "선택 레퍼런스",
            "KO·EN·中文 생성",
            "제작 기준서",
            "복사·저장 전 자동 검사",
            "생성 대기",
            "showUiError",
            "saveSceneDocument",
            "새 리비전 저장",
            "revision_conflict",
            "Codex 구조 반영 필요",
            "structured_sync_required",
        ):
            self.assertIn(token, source)

    def test_document_bridge_is_exposed_and_prompt_depends_on_conti(self):
        preload = (DESKTOP / "preload.cjs").read_text(encoding="utf-8")
        prompts = (DESKTOP / "prompt-languages.js").read_text(encoding="utf-8")
        client = (DESKTOP / "prompt-job-client.cjs").read_text(encoding="utf-8")
        package = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
        self.assertIn("saveSceneDocument", preload)
        self.assertIn("scene:save-document", preload)
        self.assertIn("conhap_revision_id", prompts)
        self.assertIn("written_storyboard", prompts)
        self.assertIn("filmMatePromptSourceGate", prompts)
        self.assertIn("FilmMate 0.7.2", client)

    def test_codex_output_schema_is_strict_and_typed(self):
        schema = json.loads((DESKTOP / "prompt-bundle.schema.json").read_text(encoding="utf-8"))
        issues = []

        def walk(value, path="$"):
            if isinstance(value, dict):
                node_type = value.get("type")
                types = set(node_type if isinstance(node_type, list) else [node_type])
                if ("const" in value or "enum" in value) and not node_type:
                    issues.append(f"{path}:missing_type")
                if "object" in types:
                    properties = value.get("properties", {})
                    if value.get("additionalProperties") is not False:
                        issues.append(f"{path}:additionalProperties")
                    if set(value.get("required", [])) != set(properties):
                        issues.append(f"{path}:required_properties")
                for key, item in value.items():
                    walk(item, f"{path}.{key}")
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    walk(item, f"{path}[{index}]")

        walk(schema)
        self.assertEqual(issues, [])
        self.assertEqual(schema["properties"]["schema_version"], {"type": "integer", "const": 3})
        self.assertFalse(schema["properties"]["prompt_ir"]["additionalProperties"])

    def test_codex_worker_preserves_exit_diagnostics(self):
        package = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
        script = (
            "const w=require('./desktop/codex-worker.cjs');"
            "process.stdout.write(w.codexFailureMessage(1,'invalid_json_schema\\nrequest rejected','',''));"
        )
        run = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertEqual(run.stdout, "E_CODEX_EXIT_1: invalid_json_schema request rejected")
        self.assertIn({"from": "../core", "to": "core"}, package["build"]["extraResources"])


if __name__ == "__main__":
    unittest.main()
