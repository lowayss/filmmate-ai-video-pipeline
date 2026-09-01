#!/usr/bin/env python3
"""Compile a deterministic, AI-site-ready delivery package for one scene."""
from __future__ import annotations
import hashlib, json, re, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"

def scene_dir(project: str, scene: str) -> Path:
    base = PACKAGES / project / "scenes"
    exact = base / scene
    matches = [exact] if exact.is_dir() else list(base.glob(f"{scene}_*"))
    if not matches: raise FileNotFoundError(f"scene_not_found: {project}/{scene}")
    return matches[0]

def safe_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", value).strip("_") or "scene"

def compile_package(project: str, scene: str, prompt: str | None = None) -> dict:
    root = scene_dir(project, scene)
    manifest = json.loads((root / "scene-data/scene-manifest.json").read_text(encoding="utf-8"))
    registry_path = root / "scene-data/artifacts.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8")) if registry_path.exists() else {"artifacts": []}
    # Delivery selects the newest version per logical artifact; older versions
    # remain in artifacts.json for comparison and rollback.
    artifacts = sorted(registry.get("artifacts", []), key=lambda a: (a.get("role", "reference"), a.get("logical_id", ""), -int(a.get("version", 0))))
    selected, seen = [], set()
    for artifact in artifacts:
        logical_id = artifact.get("logical_id")
        if logical_id in seen: continue
        file = root / artifact["file"]
        if file.is_file():
            seen.add(logical_id)
            selected.append({**artifact, "source": file})
    delivery = root / "delivery"
    delivery.mkdir(parents=True, exist_ok=True)
    refs = []
    for index, artifact in enumerate(selected, 1):
        ext = artifact["source"].suffix.lower() or ".bin"
        name = f"Image_{index:02d}_{safe_name(artifact['logical_id'])}{ext}"
        target = delivery / name
        target.write_bytes(artifact["source"].read_bytes())
        refs.append({"image_number": index, "filename": name, "role": artifact.get("role", "reference"), "logical_id": artifact["logical_id"], "version": artifact.get("version", 1), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    final_prompt = prompt or manifest.get("prompt") or f"{manifest.get('title', scene)}. Maintain identity, spatial continuity, camera direction and action timing. Generate one 15-second cinematic block."
    zip_path = delivery / f"{safe_name(project)}_{safe_name(scene)}_AI_package.zip"
    package_manifest = {"schema_version":"1.0", "project":project, "scene":scene, "created_at":manifest.get("created_at"), "prompt":final_prompt, "references":refs, "zip":str(zip_path), "file_count":len(refs) + 2}
    (delivery / "prompt.txt").write_text(final_prompt, encoding="utf-8")
    (delivery / "upload-order.json").write_text(json.dumps(package_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(delivery.iterdir()):
            if file.name == zip_path.name: continue
            archive.write(file, file.name)
    (delivery / "upload-order.json").write_text(json.dumps(package_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return package_manifest

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("project"); parser.add_argument("scene"); parser.add_argument("--prompt")
    print(json.dumps(compile_package(parser.parse_args().project, parser.parse_args().scene, parser.parse_args().prompt), ensure_ascii=False, indent=2))
