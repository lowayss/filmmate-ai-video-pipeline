from __future__ import annotations

import json
import sys
from pathlib import Path

from core import hap_core, production_orchestrator


def run(payload):
    if not isinstance(payload, dict):
        raise ValueError("E_PRODUCTION_AGENT_REQUEST_INVALID")
    root = Path(payload.get("project_root") or "").expanduser().resolve()
    if not (root / ".hap" / "hap.sqlite3").is_file():
        raise ValueError("E_HAP_PROJECT_REQUIRED")
    aliases = [str(item) for item in (payload.get("scene_aliases") or []) if str(item or "").strip()]
    if not aliases:
        raise ValueError("E_PRODUCTION_SCENE_REQUIRED")
    db = hap_core.connect(root)
    try:
        projection = hap_core.write_projection(root, db)
    finally:
        db.close()
    return production_orchestrator.build_plan(
        projection,
        aliases,
        goal=payload.get("goal"),
        target=payload.get("target"),
        previous_checkpoint=payload.get("previous_checkpoint"),
    )


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        print(json.dumps({"ok": True, "plan": run(payload)}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
