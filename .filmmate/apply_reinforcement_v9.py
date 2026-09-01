from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_all(path, old, new):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count < 1:
        raise SystemExit(f"{path}: expected at least one match: {old[:100]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


# Durable queue gets a non-mutating peek so unsupported/manual work is never claimed.
control_signature = 'def control_run(root: Path, run_id: str, action: str, *, actor: str = "filmmate-user", task_id: str | None = None, claim_token: str | None = None, error: str | None = None):\n'
replace_once(
    "core/production_agent_jobs.py",
    control_signature,
    '''def peek_next(root: Path, run_id: str, projection: dict[str, Any], scene_aliases, *, actor: str = "codex-worker"):\n    snapshot = refresh_run(root, run_id, projection, scene_aliases, actor=actor)\n    tasks = snapshot.get("active_tasks") or []\n    return {"run": snapshot, "task": tasks[0] if tasks else None}\n\n\n''' + control_signature,
)

# MCP exposes the same guarded work-order / proposal boundary as Desktop.
replace_once(
    "mcp_server.py",
    "from core import filmmate_documents, hap_core, production_agent_jobs, production_commands, production_orchestrator, prompt_ir, prompt_jobs\n",
    "from core import filmmate_documents, hap_core, production_agent_execution, production_agent_jobs, production_commands, production_orchestrator, prompt_ir, prompt_jobs\n",
)
replace_once(
    "mcp_server.py",
    '''        if name == "prepare_scene":\n''',
    '''        if name == "claim_production_work_order":\n            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])\n            peeked = production_agent_jobs.peek_next(root, args["run_id"], projection, aliases, actor=str(args.get("actor") or "codex-worker"))\n            task = peeked.get("task")\n            if not task:\n                return result({"claimed": False, "run": peeked.get("run"), "work_order": None})\n            mode, reason = production_agent_execution.task_execution_mode(task)\n            if peeked.get("run", {}).get("state") != "READY" or mode != "proposal":\n                return result({"claimed": False, "run": peeked.get("run"), "work_order": {\n                    "schema_version": 1, "task_id": task.get("task_id"), "stage": task.get("stage"),\n                    "status": task.get("plan_status"), "suggested_tool": task.get("suggested_tool"),\n                    "instruction": task.get("instruction"), "mode": "manual",\n                    "manual_reason": reason or peeked.get("run", {}).get("state"),\n                }})\n            claimed = production_agent_jobs.claim_next(root, args["run_id"], projection, aliases, actor=str(args.get("actor") or "codex-worker"))\n            current = claimed["task"]\n            work_order = production_agent_execution.build_work_order(\n                root, projection, aliases, run_id=args["run_id"], task_id=current["task_id"], claim_token=current["claim_token"]\n            )\n            return result({"claimed": True, "run": peeked.get("run"), "work_order": work_order})\n        if name == "submit_production_work_proposal":\n            root, projection, aliases = semantic_scene_context(args["project"], args["scene"])\n            return result(production_agent_execution.apply_proposal(\n                root, projection, aliases, run_id=args["run_id"], task_id=args["task_id"],\n                claim_token=args["claim_token"], proposal=args["proposal"], actor=str(args.get("actor") or "codex-worker")\n            ))\n        if name == "prepare_scene":\n''',
)
replace_once(
    "mcp_server.py",
    '''    {\n        "name": "prepare_scene",\n''',
    '''    {\n        "name": "claim_production_work_order",\n        "description": "Claim the first automatically executable Production Agent task and return a read-only Codex work order. Prompt, QA/review, blocked, and approval work is not auto-claimed.",\n        "inputSchema": {"type": "object", "properties": {"project": {"type": "string"}, "scene": {"type": "string"}, "run_id": {"type": "string"}, "actor": {"type": "string"}}, "required": ["project", "scene", "run_id"]},\n    },\n    {\n        "name": "submit_production_work_proposal",\n        "description": "Validate and apply one claimed worker proposal through the exact allowlisted semantic tool, then re-read HAP. It cannot approve work, bypass QA, perform low-level HAP writes, or mark a task complete.",\n        "inputSchema": {\n            "type": "object",\n            "properties": {\n                "project": {"type": "string"}, "scene": {"type": "string"}, "run_id": {"type": "string"},\n                "task_id": {"type": "string"}, "claim_token": {"type": "string"}, "proposal": {"type": "object"}, "actor": {"type": "string"}\n            },\n            "required": ["project", "scene", "run_id", "task_id", "claim_token", "proposal"]\n        },\n    },\n    {\n        "name": "prepare_scene",\n''',
)

# Electron main owns the Codex worker process, while Python owns semantic writes.
replace_once(
    "desktop/main.cjs",
    'const {startCodexPromptJob, cancelCodexPromptJob} = require("./codex-worker.cjs");\n',
    'const {startCodexPromptJob, cancelCodexPromptJob} = require("./codex-worker.cjs");\nconst {startProductionAgentWorker, cancelProductionAgentWorker, activeProductionAgentWorkers} = require("./production-agent-worker.cjs");\n',
)
replace_once(
    "desktop/main.cjs",
    '''ipcMain.handle("production-agent:control-run", async (_event, project, scene, request = {}) => {\n  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {...request, action:"control_run", actor:"filmmate-user"}));\n});\n\n''',
    '''ipcMain.handle("production-agent:control-run", async (_event, project, scene, request = {}) => {\n  return await pythonBridge.runProductionAgentAsync(productionAgentPayload(project, scene, {...request, action:"control_run", actor:"filmmate-user"}));\n});\nipcMain.handle("production-agent:start-worker", async (_event, project, scene, runId) => {\n  const basePayload = productionAgentPayload(project, scene);\n  const sendEvent = event => {\n    for (const window of BrowserWindow.getAllWindows()) {\n      if (!window.isDestroyed()) window.webContents.send("production-agent:worker-event", {project, scene, ...event});\n    }\n  };\n  return startProductionAgentWorker({\n    projectDir: basePayload.project_root,\n    bridge: pythonBridge,\n    basePayload,\n    runId,\n    onEvent: sendEvent,\n  });\n});\nipcMain.handle("production-agent:cancel-worker", async (_event, runId) => {\n  return await cancelProductionAgentWorker(runId);\n});\nipcMain.handle("production-agent:worker-status", (_event, runId) => {\n  const active = activeProductionAgentWorkers();\n  return {run_id:String(runId || ""), active:active.includes(String(runId || "")), active_run_ids:active};\n});\n\n''',
)

# Desktop command bar adds an explicit opt-in worker button and event-driven status.
old_state = "let productionAgentState={goal:'',result:null,loading:false,error:null,checkpoint:null,run:null,runLoading:false};"
new_state = "let productionAgentState={goal:'',result:null,loading:false,error:null,checkpoint:null,run:null,runLoading:false,workerRunning:false,workerStatus:null};"
replace_all("desktop/index.html", old_state, new_state)
replace_once(
    "desktop/index.html",
    '''<button class="btn" id="agentRefreshRun" ${a.runLoading?'disabled':''}>새로고침</button>''',
    '''<button class="btn" id="agentRefreshRun" ${a.runLoading?'disabled':''}>새로고침</button>${run.state==='READY'?`<button class="btn primary" id="agentAutoWorker" ${a.workerRunning?'disabled':''}>${a.workerRunning?'자동 실행 중…':'자동 실행'}</button>`:''}${a.workerRunning?'<button class="btn" id="agentStopWorker">Worker 중지</button>':''}''',
)
replace_once(
    "desktop/index.html",
    '''async function runProductionAgentGoal(goal){\n''',
    '''async function startProductionAgentWorkerUi(){if(!productionAgentState.run?.run_id||productionAgentState.workerRunning)return;productionAgentState.workerRunning=true;productionAgentState.workerStatus='시작 중';renderScene();try{await window.sceneFlow.startProductionWorker(selected.project,sceneId(selected),productionAgentState.run.run_id);productionAgentState.workerStatus='Codex 작업 중';renderScene()}catch(e){productionAgentState.workerRunning=false;productionAgentState.workerStatus=null;renderScene();toast('자동 실행 시작 실패: '+(e.message||e))}}\nasync function stopProductionAgentWorkerUi(){if(!productionAgentState.run?.run_id)return;try{await window.sceneFlow.cancelProductionWorker(productionAgentState.run.run_id)}finally{productionAgentState.workerRunning=false;productionAgentState.workerStatus='중지됨';renderScene()}}\nasync function handleProductionAgentWorkerEvent(event){if(!event||event.run_id!==productionAgentState.run?.run_id)return;productionAgentState.workerStatus=event.type==='claimed'?`${event.stage||'작업'} 실행 중`:event.type==='proposal_ready'?'Semantic action 검증 중':event.type==='applied'?'HAP 재검증 중':event.reason||event.type;productionAgentState.workerRunning=!['stopped','completed','failed','cancelled'].includes(event.type);if(['applied','stopped','completed','failed','cancelled'].includes(event.type)){try{await refreshProductionAgentRun()}catch{/* status UI is best effort */}}else if(selected){renderScene()}if(event.type==='completed')toast('Production Agent 목표가 정본 기준으로 완료되었습니다');if(event.type==='stopped'&&event.reason==='needs_user_input')toast('자동 실행 중지 · 사용자 입력 또는 외부 생성이 필요합니다');if(event.type==='failed')toast('Production Agent Worker 실패: '+(event.error||'오류'))}\nasync function runProductionAgentGoal(goal){\n''',
)
replace_once(
    "desktop/index.html",
    '''  if($('agentStartRun'))$('agentStartRun').onclick=startProductionAgentRun;if($('agentRefreshRun'))$('agentRefreshRun').onclick=refreshProductionAgentRun;if($('agentPauseRun'))$('agentPauseRun').onclick=()=>controlProductionAgentRun('pause');if($('agentResumeRun'))$('agentResumeRun').onclick=()=>controlProductionAgentRun('resume');if($('agentCancelRun'))$('agentCancelRun').onclick=()=>controlProductionAgentRun('cancel');if($('agentRetryRun'))$('agentRetryRun').onclick=e=>controlProductionAgentRun('retry_task',e.currentTarget.dataset.task);\n''',
    '''  if($('agentStartRun'))$('agentStartRun').onclick=startProductionAgentRun;if($('agentRefreshRun'))$('agentRefreshRun').onclick=refreshProductionAgentRun;if($('agentPauseRun'))$('agentPauseRun').onclick=()=>controlProductionAgentRun('pause');if($('agentResumeRun'))$('agentResumeRun').onclick=()=>controlProductionAgentRun('resume');if($('agentCancelRun'))$('agentCancelRun').onclick=()=>controlProductionAgentRun('cancel');if($('agentRetryRun'))$('agentRetryRun').onclick=e=>controlProductionAgentRun('retry_task',e.currentTarget.dataset.task);if($('agentAutoWorker'))$('agentAutoWorker').onclick=startProductionAgentWorkerUi;if($('agentStopWorker'))$('agentStopWorker').onclick=stopProductionAgentWorkerUi;\n''',
)
replace_once(
    "desktop/index.html",
    "$('nav').onclick=e=>",
    "if(window.sceneFlow.onProductionAgentWorkerEvent)window.sceneFlow.onProductionAgentWorkerEvent(handleProductionAgentWorkerEvent);\n$('nav').onclick=e=>",
)

print("reinforcement v9 applied")
