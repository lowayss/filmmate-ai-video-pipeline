#!/usr/bin/env python3
"""Create editable scene breakdowns from the package manifest.

This intentionally produces a transparent draft: Codex can revise the beats,
shots and asset requirements without destroying the original screenplay data.
"""
from __future__ import annotations
import json, math, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"

def find_scene(project: str, scene: str) -> Path:
    base = PACKAGES / project / "scenes"
    exact = base / scene
    if exact.is_dir(): return exact
    matches = list(base.glob(f"{scene}_*"))
    if not matches: raise FileNotFoundError(f"scene_not_found: {project}/{scene}")
    return matches[0]

def parse_seconds(value) -> int | None:
    if value is None: return None
    match = re.search(r"(\d+)", str(value))
    return int(match.group(1)) if match else None

def generate_breakdown(project: str, scene: str, duration: int | None = None, shot_count: int = 6) -> dict:
    root = find_scene(project, scene)
    manifest_path = root / "scene-data/scene-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    duration = duration or parse_seconds(manifest.get("scene_duration")) or 30
    shot_count = max(1, int(shot_count))
    shot_duration = duration / shot_count
    block_count = math.ceil(duration / 15)
    title = manifest.get("title") or scene
    location = manifest.get("location") or "장소 미확정"
    time = manifest.get("time") or "시간 미확정"
    shots = []
    for index in range(shot_count):
        start, end = round(index * shot_duration, 2), round(min(duration, (index + 1) * shot_duration), 2)
        shots.append({"shot_id":f"C{index+1:02d}","start_sec":start,"end_sec":end,"duration_sec":round(end-start,2),"beat":"행동 비트 입력 필요","camera":"카메라 설계 필요","continuity":"이전 컷과 시선축·공간축 확인 필요","status":"draft"})
    blocks = []
    for index in range(block_count):
        start, end = index * 15, min(duration, (index + 1) * 15)
        blocks.append({"block_id":f"B{index+1:02d}","start_sec":start,"end_sec":end,"duration_sec":end-start,"shot_ids":[s["shot_id"] for s in shots if s["start_sec"] < end and s["end_sec"] > start],"status":"draft"})
    assets = [
        {"asset_id":f"location_{scene}","type":"location","name":location,"state":"needed","reason":"공간 지리와 조명 기준"},
        {"asset_id":"character_primary","type":"character","name":"주요 인물","state":"needed","reason":"인물 동일성 기준"},
        {"asset_id":f"time_{scene}","type":"lighting","name":time,"state":"needed","reason":"시간대·빛 연속성 기준"},
    ]
    result = {"schema_version":"1.0","project":project,"scene_id":scene,"title":title,"location":location,"time":time,"duration_sec":duration,"block_duration_sec":15,"shot_count":len(shots),"block_count":len(blocks),"shots":shots,"blocks":blocks,"assets":assets,"prompt_draft":f"{title}, {location}, {time}. Maintain spatial continuity, character identity and camera direction. Generate the selected 15-second block as one continuous cinematic action.","status":"draft"}
    out = root / "scene-data/scene-breakdown.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"breakdown":result,"path":str(out)}

if __name__ == "__main__":
    import argparse
    p=argparse.ArgumentParser();p.add_argument("project");p.add_argument("scene");p.add_argument("--duration",type=int);p.add_argument("--shots",type=int,default=6)
    a=p.parse_args(); print(json.dumps(generate_breakdown(a.project,a.scene,a.duration,a.shots),ensure_ascii=False,indent=2))
