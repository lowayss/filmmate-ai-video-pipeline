from pathlib import Path

path = Path("core/production_commands.py")
text = path.read_text(encoding="utf-8")

replacements = [
(
'''def _payload(entity):\n    raw = (entity or {}).get("current_revision", {}).get("payload_json")\n''',
'''def _payload(entity):\n    revision = (entity or {}).get("current_revision") or {}\n    raw = revision.get("payload_json")\n''',
),
(
'''            revision_id = (target.get("current_revision") or {}).get("revision_id")\n            if not revision_id:\n                raise ValueError("E_PRODUCTION_DEPENDENCY_REVISION_MISSING")\n            dependencies.append((revision_id, str(selector.get("role") or "input")))\n''',
'''            revision_id = (target.get("current_revision") or {}).get("revision_id")\n            if not revision_id:\n                raise ValueError("E_PRODUCTION_DEPENDENCY_REVISION_MISSING")\n            db_current = hap_core.current_revision(db, target["entity_id"])\n            if db_current is None:\n                raise ValueError("E_PRODUCTION_DEPENDENCY_REVISION_MISSING")\n            if db_current["revision_id"] != revision_id:\n                raise ValueError(f"E_PRODUCTION_DEPENDENCY_CHANGED:{revision_id}:{db_current['revision_id']}")\n            dependencies.append((db_current["revision_id"], str(selector.get("role") or "input")))\n''',
),
(
'''    revision_id = (target.get("current_revision") or {}).get("revision_id")\n    if not revision_id:\n        raise ValueError("E_PRODUCTION_REVISION_MISSING")\n    evidence = json.dumps({"delegated_grant_id": grant, "evidence": request.get("evidence")}, ensure_ascii=False)\n''',
'''    revision_id = (target.get("current_revision") or {}).get("revision_id")\n    if not revision_id:\n        raise ValueError("E_PRODUCTION_REVISION_MISSING")\n    db = hap_core.connect(root)\n    try:\n        current = hap_core.current_revision(db, target["entity_id"])\n    finally:\n        db.close()\n    if current is None or current["revision_id"] != revision_id:\n        raise ValueError("E_PRODUCTION_REVISION_SUPERSEDED")\n    evidence = json.dumps({"delegated_grant_id": grant, "evidence": request.get("evidence")}, ensure_ascii=False)\n''',
),
]

for index, (old, new) in enumerate(replacements, start=1):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"race replacement {index} expected once, found {count}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
print(f"applied {len(replacements)} semantic race hardening replacements")
