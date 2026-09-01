from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


orchestrator = Path("core/production_orchestrator.py")
replace_once(
    orchestrator,
    '''def _stage_blockers(state: dict[str, Any], target: str) -> list[dict[str, Any]]:\n    if target == TARGET_STALE_CLEAR:\n        return [\n            {\n                "stage": item.get("stage"),\n                "label": item.get("stage") or "stale object",\n                "status": "stale",\n                "action": "regenerate_from_current_inputs",\n                "reasons": item.get("reasons") or [],\n                "entity_ids": [item.get("entity_id")] if item.get("entity_id") else [],\n                "expected_revision_id": item.get("revision_id"),\n            }\n            for item in (state.get("stale_objects") or [])\n        ]\n''',
    '''def _stage_blockers(state: dict[str, Any], target: str, stale_plan: dict[str, Any] | None = None) -> list[dict[str, Any]]:\n    if target == TARGET_STALE_CLEAR:\n        return [\n            {\n                "stage": item.get("stage"),\n                "label": item.get("stage") or "stale object",\n                "status": "stale",\n                "action": "regenerate_from_current_inputs",\n                "reasons": item.get("reasons") or [],\n                "entity_ids": [item.get("entity_id")] if item.get("entity_id") else [],\n                "expected_revision_id": item.get("expected_revision_id"),\n            }\n            for item in ((stale_plan or {}).get("tasks") or [])\n        ]\n''',
    "stale-plan signature",
)
replace_once(
    orchestrator,
    '''    state = production_commands.build_scene_state(projection, scene_aliases)\n    cp = checkpoint(projection, state)\n    blockers = _stage_blockers(state, resolved_target)\n''',
    '''    state = production_commands.build_scene_state(projection, scene_aliases)\n    cp = checkpoint(projection, state)\n    stale_plan = production_commands.stale_regeneration_plan(projection, scene_aliases) if resolved_target == TARGET_STALE_CLEAR else None\n    blockers = _stage_blockers(state, resolved_target, stale_plan)\n''',
    "stale-plan call",
)

server = Path("mcp_server.py")
replace_once(
    server,
    'from core import filmmate_documents, hap_core, production_commands, prompt_ir, prompt_jobs\n',
    'from core import filmmate_documents, hap_core, production_commands, production_orchestrator, prompt_ir, prompt_jobs\n',
    "orchestrator import",
)
replace_once(
    server,
    '''def call(name, args):\n    try:\n        if name == "prepare_scene":\n''',
    '''def call(name, args):\n    try:\n        if name == "run_production_agent":\n            _root, projection, aliases = semantic_scene_context(args["project"], args["scene"])\n            return result(production_orchestrator.build_plan(\n                projection, aliases, goal=args.get("goal"), target=args.get("target"),\n                previous_checkpoint=args.get("previous_checkpoint"),\n            ))\n        if name == "prepare_scene":\n''',
    "agent call",
)
replace_once(
    server,
    '''SEMANTIC_TOOLS = [\n    {\n        "name": "prepare_scene",\n''',
    '''SEMANTIC_TOOLS = [\n    {\n        "name": "run_production_agent",\n        "description": "Plan or resume a stateless Production Agent control loop from one natural-language goal. It re-reads canonical HAP state, returns the ordered steps and exact next semantic tool, and requires a fresh checkpoint after every write. It never invents completion or auto-approves creative work.",\n        "inputSchema": {\n            "type": "object",\n            "properties": {\n                "project": {"type": "string"},\n                "scene": {"type": "string"},\n                "goal": {"type": "string"},\n                "target": {"type": "string", "enum": ["generate_ready", "handoff_ready", "stale_clear"]},\n                "previous_checkpoint": {"type": "string"}\n            },\n            "required": ["project", "scene", "goal"]\n        },\n    },\n    {\n        "name": "prepare_scene",\n''',
    "agent tool schema",
)
print("reinforcement v6 integration applied")
