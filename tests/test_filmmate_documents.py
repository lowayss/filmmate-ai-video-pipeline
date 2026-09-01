import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import mcp_server
from core import filmmate_documents, hap_core


class FilmMateDocumentBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "PROJECT_테스트"
        self.previous_packages = mcp_server.PACKAGES
        mcp_server.PACKAGES = self.root.parent
        self.scene_key = "S1_테스트"
        self.scene_dir = self.root / "scenes" / self.scene_key
        (self.scene_dir / "scene-data").mkdir(parents=True)
        (self.scene_dir / "conhap-v3").mkdir(parents=True)
        (self.root / "scene-data").mkdir(parents=True, exist_ok=True)
        (self.root / "scene-data" / "scene-manifest.json").write_text(
            json.dumps({"title": "테스트"}, ensure_ascii=False), encoding="utf-8"
        )
        (self.scene_dir / "scene-data" / "scene-manifest.json").write_text(
            json.dumps({"scene_id": "S1", "title": "테스트"}, ensure_ascii=False), encoding="utf-8"
        )
        (self.scene_dir / "conhap-v3" / "project.json").write_text("{}\n", encoding="utf-8")
        (self.scene_dir / "conhap-v3" / "blocks.jsonl").write_text(
            '{"block_id":"B01","shot_ids":["C01"]}\n', encoding="utf-8"
        )
        (self.scene_dir / "input-screenplay.txt").write_text("S1. 테스트\n원문 1\n", encoding="utf-8")
        (self.scene_dir / "conhap-v3" / "text-conti.md").write_text("# 글 콘티\nC01 초안\n", encoding="utf-8")

        db_path = self.root / ".hap" / "hap.sqlite3"
        db_path.parent.mkdir(parents=True)
        db = sqlite3.connect(db_path)
        db.row_factory = sqlite3.Row
        db.executescript(hap_core.DDL)
        db.execute("INSERT INTO meta VALUES('schema_version',?)", (str(hap_core.SCHEMA_VERSION),))
        db.execute("INSERT INTO meta VALUES('title','테스트')")
        db.execute(
            "INSERT INTO entities VALUES(?,?,?,?,?,?)",
            ("project:PROJECT_테스트", "project", "PROJECT_테스트", None, "full", hap_core.now()),
        )
        scene = hap_core.ensure_entity(
            db,
            entity_type="scene",
            logical_key="S1",
            parent_id="project:PROJECT_테스트",
            entity_id="scene:S1",
        )
        block = hap_core.ensure_entity(
            db,
            entity_type="block",
            logical_key="S1_CONHAP",
            parent_id=scene["entity_id"],
            entity_id="block:S1_CONHAP",
        )
        prompt = hap_core.ensure_entity(
            db,
            entity_type="prompt",
            logical_key=f"{self.scene_key}|Seedance 2.0|shot|C01",
            parent_id=scene["entity_id"],
            entity_id="prompt:C01",
            workflow_mode="prompt-only",
        )
        scene_revision, _ = hap_core.commit_revision(
            self.root,
            db,
            entity_id=scene["entity_id"],
            producer="test",
            payload={"scene_id": "S1"},
            source_evidence=[{"kind": "fixture"}],
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=scene_revision["revision_id"],
            kind="screenplay",
            data=(self.scene_dir / "input-screenplay.txt").read_bytes(),
            mime="text/plain; charset=utf-8",
        )
        block_revision, _ = hap_core.commit_revision(
            self.root,
            db,
            entity_id=block["entity_id"],
            producer="test",
            payload={"scene_id": "S1"},
            source_evidence=[{"kind": "fixture"}],
            dependencies=[(scene_revision["revision_id"], "screenplay")],
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=block_revision["revision_id"],
            kind="block_manifest",
            data=(self.scene_dir / "conhap-v3" / "blocks.jsonl").read_bytes(),
            mime="application/x-ndjson",
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=block_revision["revision_id"],
            kind="written_storyboard",
            data=(self.scene_dir / "conhap-v3" / "text-conti.md").read_bytes(),
            mime="text/markdown; charset=utf-8",
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=block_revision["revision_id"],
            kind="shot_record",
            data=b'{"cut_id":"C01"}\n',
            mime="application/x-ndjson",
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=block_revision["revision_id"],
            kind="validator_report",
            data=b'{"status":"PASS"}\n',
            mime="application/json",
        )
        prompt_revision, _ = hap_core.commit_revision(
            self.root,
            db,
            entity_id=prompt["entity_id"],
            producer="test",
            payload={"target_id": "C01"},
            source_evidence=[{"kind": "fixture"}],
            dependencies=[
                (scene_revision["revision_id"], "scene"),
                (block_revision["revision_id"], "written_storyboard"),
            ],
        )
        hap_core.add_artifact_bytes(
            self.root,
            db,
            revision_id=prompt_revision["revision_id"],
            kind="prompt_request",
            data=b'{"target_id":"C01"}\n',
            mime="application/json",
        )
        db.commit()
        hap_core.write_projection(self.root, db)
        db.close()

    def tearDown(self):
        mcp_server.PACKAGES = self.previous_packages
        self.temp.cleanup()

    def _save(self, **overrides):
        payload = {
            "project_root": str(self.root),
            "scene": self.scene_key,
            "kind": "screenplay",
            "content": "S1. 테스트\nFilmMate 수정본\n",
            "actor": "filmmate-user",
            "expected_revision_id": "scene:S1@1",
            "expected_scene_revision_id": "scene:S1@1",
            "idempotency_key": "test-screenplay-edit",
        }
        payload.update(overrides)
        return filmmate_documents.save_document(payload)

    def test_screenplay_save_creates_revision_and_marks_dependents_stale(self):
        output = self._save()
        self.assertEqual(output["revision_id"], "scene:S1@2")
        self.assertEqual(
            (self.scene_dir / "input-screenplay.txt").read_text(encoding="utf-8"),
            "S1. 테스트\nFilmMate 수정본\n",
        )
        stale_ids = {item["entity_id"] for item in output["stale_dependents"]}
        self.assertIn("block:S1_CONHAP", stale_ids)
        self.assertIn("prompt:C01", stale_ids)
        latest = filmmate_documents.read_documents(self.root, self.scene_key)
        self.assertTrue(latest["documents"]["screenplay"]["canonical"])
        self.assertEqual(latest["documents"]["screenplay"]["content"], "S1. 테스트\nFilmMate 수정본\n")

    def test_noop_save_does_not_create_another_revision(self):
        first = self._save()
        second = self._save(
            expected_revision_id=first["revision_id"],
            idempotency_key="test-screenplay-noop",
        )
        self.assertTrue(second["unchanged"])
        self.assertEqual(second["revision_id"], "scene:S1@2")

    def test_duplicate_mutation_is_idempotent(self):
        first = self._save()
        replay = self._save()
        self.assertEqual(first["revision_id"], replay["revision_id"])
        self.assertTrue(replay["idempotent_replay"])
        db = hap_core.connect(self.root)
        count = db.execute("SELECT COUNT(*) FROM revisions WHERE entity_id='scene:S1'").fetchone()[0]
        db.close()
        self.assertEqual(count, 2)

    def test_revision_conflict_prevents_overwrite(self):
        self._save()
        with self.assertRaisesRegex(ValueError, "revision_conflict:scene:S1@1:scene:S1@2"):
            self._save(content="오래된 화면에서 덮어쓰기\n", idempotency_key="conflict")

    def test_conti_save_invalidates_old_structure_and_tracks_latest_screenplay(self):
        screenplay = self._save()
        output = self._save(
            kind="conti",
            content="# 글 콘티\nC01 FilmMate 수정\n",
            expected_revision_id="block:S1_CONHAP@1",
            expected_scene_revision_id=screenplay["revision_id"],
            idempotency_key="test-conti-edit",
        )
        self.assertEqual(output["revision_id"], "block:S1_CONHAP@2")
        self.assertEqual(
            (self.scene_dir / "conhap-v3" / "text-conti.md").read_text(encoding="utf-8"),
            "# 글 콘티\nC01 FilmMate 수정\n",
        )
        db = hap_core.connect(self.root)
        kinds = {row["kind"] for row in hap_core.artifact_rows(db, output["revision_id"])}
        dependencies = {
            (row["upstream_revision_id"], row["role"])
            for row in db.execute("SELECT upstream_revision_id,role FROM dependencies WHERE downstream_revision_id=?", (output["revision_id"],))
        }
        db.close()
        self.assertIn("block_manifest", kinds)
        self.assertIn("written_storyboard", kinds)
        self.assertNotIn("shot_record", kinds)
        self.assertNotIn("validator_report", kinds)
        self.assertIn(("scene:S1@2", "screenplay"), dependencies)
        self.assertIn("prompt:C01", {item["entity_id"] for item in output["stale_dependents"]})
        latest = output["documents"]["conti"]
        self.assertTrue(latest["structured_sync_required"])
        self.assertEqual(latest["structured_sync_base_revision_id"], "block:S1_CONHAP@1")

    def test_legacy_projection_never_inherits_verified_hap_label(self):
        db = hap_core.connect(self.root)
        artifact = db.execute(
            "SELECT artifact_id FROM artifacts WHERE revision_id='block:S1_CONHAP@1' AND kind='written_storyboard'"
        ).fetchone()
        db.execute("DELETE FROM artifacts WHERE artifact_id=?", (artifact["artifact_id"],))
        db.commit()
        db.close()
        record = filmmate_documents.read_documents(self.root, self.scene_key)["documents"]["conti"]
        self.assertFalse(record["canonical"])
        self.assertEqual(record["source"], "legacy-projection")
        self.assertEqual(record["state"], "legacy_unverified")

    def test_codex_mcp_reads_and_saves_the_same_canonical_document(self):
        read_result = mcp_server.call("get_filmmate_documents", {
            "project": self.root.name,
            "scene": "S1",
        })
        read_payload = json.loads(read_result["content"][0]["text"])
        self.assertEqual(read_payload["documents"]["screenplay"]["revision_id"], "scene:S1@1")
        save_result = mcp_server.call("save_filmmate_document", {
            "project": self.root.name,
            "scene": "S1",
            "kind": "screenplay",
            "content": "S1. 테스트\nCodex 수정본\n",
            "expected_revision_id": "scene:S1@1",
            "expected_scene_revision_id": "scene:S1@1",
            "idempotency_key": "codex-mcp-edit",
        })
        save_payload = json.loads(save_result["content"][0]["text"])
        self.assertEqual(save_payload["revision_id"], "scene:S1@2")
        db = hap_core.connect(self.root)
        producer = db.execute("SELECT producer FROM revisions WHERE revision_id='scene:S1@2'").fetchone()[0]
        db.close()
        self.assertEqual(producer, "codex-filmmate-editor")


if __name__ == "__main__":
    unittest.main()
