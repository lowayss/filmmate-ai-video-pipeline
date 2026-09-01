#!/usr/bin/env python3
"""Materialize the editable text/asset/prompt workspace for a scene."""
from __future__ import annotations
import json
from pathlib import Path
from scene_breakdown import generate_breakdown, find_scene

def compile_workspace(project: str, scene: str, duration_sec: int | None = None, shot_count: int = 6) -> dict:
    result = generate_breakdown(project, scene, duration_sec, shot_count)
    breakdown = result["breakdown"]
    root = find_scene(project, scene)
    (root / "text-conti").mkdir(exist_ok=True)
    (root / "assets" / "needed").mkdir(parents=True, exist_ok=True)
    (root / "prompts").mkdir(exist_ok=True)
    (root / "storyboard").mkdir(exist_ok=True)
    (root / "text-conti" / "scene-breakdown.json").write_text(json.dumps(breakdown, ensure_ascii=False, indent=2), encoding="utf-8")
    asset_plan = {"schema_version":"1.0","scene_id":scene,"assets":breakdown["assets"]}
    (root / "assets" / "asset-plan.json").write_text(json.dumps(asset_plan, ensure_ascii=False, indent=2), encoding="utf-8")
    prompt_files=[]
    for block in breakdown["blocks"]:
        prompt = f"{breakdown['title']}, {breakdown['location']}, {breakdown['time']}. {block['block_id']} ({block['duration_sec']} seconds), shots {', '.join(block['shot_ids'])}. Maintain identity, geography, eyeline, screen direction and continuity. One cinematic continuous action, no text, no UI, no storyboard panels."
        file = root / "prompts" / f"{block['block_id']}_prompt.txt"
        file.write_text(prompt, encoding="utf-8")
        prompt_files.append({"block_id":block["block_id"],"file":str(file.relative_to(root)),"prompt":prompt,"status":"draft"})
    prompt_manifest = {"schema_version":"1.0","scene_id":scene,"blocks":prompt_files}
    (root / "prompts" / "prompt-manifest.json").write_text(json.dumps(prompt_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"scene":scene,"breakdown":result["path"],"asset_plan":str(root / "assets/asset-plan.json"),"prompt_manifest":str(root / "prompts/prompt-manifest.json"),"prompt_count":len(prompt_files)}

if __name__ == "__main__":
    import argparse
    p=argparse.ArgumentParser();p.add_argument("project");p.add_argument("scene");p.add_argument("--duration",type=int);p.add_argument("--shots",type=int,default=6)
    print(json.dumps(compile_workspace(p.parse_args().project,p.parse_args().scene,p.parse_args().duration,p.parse_args().shots),ensure_ascii=False,indent=2))
