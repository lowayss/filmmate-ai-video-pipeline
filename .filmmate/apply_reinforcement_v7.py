from pathlib import Path


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# desktop/python-bridge.cjs
p = Path("desktop/python-bridge.cjs")
replace_once(
    p,
    '''  function documentBridgePath() {\n    return coreScriptPath("filmmate_documents.py");\n  }\n''',
    '''  function documentBridgePath() {\n    return coreScriptPath("filmmate_documents.py");\n  }\n\n  function productionAgentBridgePath() {\n    return coreScriptPath("production_agent_bridge.py");\n  }\n''',
    "python bridge path",
)
replace_once(
    p,
    '''  function parseDocumentResult(output) {\n    let parsed;\n    try {\n      parsed = JSON.parse(String(output || "").trim());\n    } catch {\n      throw new Error(`E_DOCUMENT_BRIDGE_RESPONSE_INVALID:${String(output || "").trim().slice(0, 500)}`);\n    }\n    if (!parsed || parsed.ok !== true) {\n      throw new Error(parsed?.error || "document_bridge_failed");\n    }\n    return parsed;\n  }\n''',
    '''  function parseDocumentResult(output) {\n    let parsed;\n    try {\n      parsed = JSON.parse(String(output || "").trim());\n    } catch {\n      throw new Error(`E_DOCUMENT_BRIDGE_RESPONSE_INVALID:${String(output || "").trim().slice(0, 500)}`);\n    }\n    if (!parsed || parsed.ok !== true) {\n      throw new Error(parsed?.error || "document_bridge_failed");\n    }\n    return parsed;\n  }\n\n  function parseProductionAgentResult(output) {\n    let parsed;\n    try {\n      parsed = JSON.parse(String(output || "").trim());\n    } catch {\n      throw new Error(`E_PRODUCTION_AGENT_RESPONSE_INVALID:${String(output || "").trim().slice(0, 500)}`);\n    }\n    if (!parsed || parsed.ok !== true || !parsed.plan) {\n      throw new Error(parsed?.error || "production_agent_bridge_failed");\n    }\n    return parsed.plan;\n  }\n''',
    "python bridge parser",
)
replace_once(
    p,
    '''  async function runDocumentBridgeAsync(command, payload) {\n    const result = await runPythonAsync(documentBridgePath(), [String(command || "")], {\n      input: JSON.stringify(payload ?? {}),\n    });\n    return parseDocumentResult(result.stdout);\n  }\n''',
    '''  async function runDocumentBridgeAsync(command, payload) {\n    const result = await runPythonAsync(documentBridgePath(), [String(command || "")], {\n      input: JSON.stringify(payload ?? {}),\n    });\n    return parseDocumentResult(result.stdout);\n  }\n\n  async function runProductionAgentAsync(payload) {\n    const result = await runPythonAsync(productionAgentBridgePath(), [], {\n      input: JSON.stringify(payload ?? {}),\n    });\n    return parseProductionAgentResult(result.stdout);\n  }\n''',
    "python bridge async runner",
)
replace_once(
    p,
    '''    hapScriptPath,\n    documentBridgePath,\n    runPython,\n''',
    '''    hapScriptPath,\n    documentBridgePath,\n    productionAgentBridgePath,\n    runPython,\n''',
    "python bridge return path",
)
replace_once(
    p,
    '''    runDocumentBridge,\n    runDocumentBridgeAsync,\n  };\n''',
    '''    runDocumentBridge,\n    runDocumentBridgeAsync,\n    runProductionAgentAsync,\n  };\n''',
    "python bridge return runner",
)

# desktop/preload.cjs
p = Path("desktop/preload.cjs")
replace_once(
    p,
    '''  exportAiPackage: (project, scene, config) => ipcRenderer.invoke("ai:export-package", project, scene, config),\n});\n''',
    '''  exportAiPackage: (project, scene, config) => ipcRenderer.invoke("ai:export-package", project, scene, config),\n  runProductionAgent: (project, scene, request) => ipcRenderer.invoke("production-agent:run", project, scene, request),\n});\n''',
    "preload production agent",
)

# desktop/main.cjs
p = Path("desktop/main.cjs")
replace_once(
    p,
    '''ipcMain.handle("project:connect-codex-sources", async (_event, project) => {\n  let projectDir;\n  try { projectDir = projectPaths.resolveHapProject(project); }\n  catch { throw new Error("hap_project_not_found"); }\n  return await connectCodexSources(projectDir);\n});\n''',
    '''ipcMain.handle("project:connect-codex-sources", async (_event, project) => {\n  let projectDir;\n  try { projectDir = projectPaths.resolveHapProject(project); }\n  catch { throw new Error("hap_project_not_found"); }\n  return await connectCodexSources(projectDir);\n});\n\nipcMain.handle("production-agent:run", async (_event, project, scene, request = {}) => {\n  const projectDir = projectPaths.resolveHapProject(project);\n  const {sceneDir} = projectPaths.resolveScene(project, scene);\n  const manifest = readJson(path.join(sceneDir, "scene-data", "scene-manifest.json")) || {};\n  const aliases = [scene, sceneDir.name, manifest.scene_id].filter(Boolean);\n  return await pythonBridge.runProductionAgentAsync({\n    project_root: projectDir,\n    scene_aliases: aliases,\n    goal: request?.goal,\n    target: request?.target,\n    previous_checkpoint: request?.previous_checkpoint,\n  });\n});\n''',
    "main production agent ipc",
)

# desktop/index.html
p = Path("desktop/index.html")
replace_once(
    p,
    '''</style>\n<link rel="stylesheet" href="workspace-ui.css">\n''',
    '''.agent-console{border:1px solid #3c4855;background:#11161c;border-radius:14px;padding:14px 15px;margin:18px 0 4px}.agent-command-row{display:grid;grid-template-columns:1fr auto;gap:8px}.agent-command-row input{width:100%;border:1px solid var(--line);background:#0c1015;color:var(--text);border-radius:9px;padding:11px 12px}.agent-command-row input:focus{outline:none;border-color:var(--lime)}.agent-quick{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.agent-quick button{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:999px;padding:6px 9px;font-size:11px;cursor:pointer}.agent-quick button:hover{color:var(--lime);border-color:#596631}.agent-result{margin-top:12px;border-top:1px solid var(--line);padding-top:12px}.agent-result-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.agent-result-head strong{display:block}.agent-result-head small{display:block;color:var(--muted);margin-top:4px}.agent-next{margin-top:10px;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:11px 12px}.agent-next .row{align-items:flex-start}.agent-next small{display:block;color:var(--muted);line-height:1.5;margin-top:5px}.agent-step-list{display:grid;gap:6px;margin-top:8px}.agent-step{display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;color:var(--muted);font-size:12px}.agent-step b{color:var(--text)}.agent-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.agent-error{margin-top:10px;color:var(--danger);font-size:12px}.agent-checkpoint{font:10px ui-monospace,monospace;color:var(--muted)}@media(max-width:700px){.agent-command-row{grid-template-columns:1fr}.agent-result-head{display:block}.agent-step{grid-template-columns:24px 1fr}.agent-step span:last-child{grid-column:2}}\n</style>\n<link rel="stylesheet" href="workspace-ui.css">\n''',
    "agent css",
)
replace_once(
    p,
    '''let projects=[],project=null,view='board',selected=null,detail=null,sceneTab='overview',seedanceSkillPolicy={status:'LOADING',name:'seedance-prompt-rules'},aiDraft={model:'Seedance 2.0',unitType:'shot',targetId:'C01',items:[],uploads:[],prompt:'',combinedStoryboard:null,skillBundleSha256:null};\nlet deletingProject=false;\n''',
    '''let projects=[],project=null,view='board',selected=null,detail=null,sceneTab='overview',seedanceSkillPolicy={status:'LOADING',name:'seedance-prompt-rules'},aiDraft={model:'Seedance 2.0',unitType:'shot',targetId:'C01',items:[],uploads:[],prompt:'',combinedStoryboard:null,skillBundleSha256:null};\nlet productionAgentState={goal:'',result:null,loading:false,error:null,checkpoint:null};\nlet deletingProject=false;\n''',
    "agent state",
)
replace_once(
    p,
    '''syncTargetPackage();render()}catch(e){toast('씬을 열지 못했습니다: '+e.message)}}\n''',
    '''syncTargetPackage();productionAgentState={goal:'',result:null,loading:false,error:null,checkpoint:null};render()}catch(e){toast('씬을 열지 못했습니다: '+e.message)}}\n''',
    "agent reset on scene open",
)
agent_functions = r'''function agentTargetLabel(target){return target==='handoff_ready'?'업로드/전달 준비':target==='stale_clear'?'Stale 최신화':'영상 생성 준비'}
function agentStopLabel(reason){return reason==='target_reached'?'목표 달성':reason==='blocked'?'차단됨':reason==='waiting_for_qa_or_review'?'QA/검토 대기':reason==='waiting_for_current_work'?'진행 중 작업 대기':reason==='waiting_for_agent_output'?'제작 결과 대기':'다음 단계 대기'}
function productionAgentCommandView(){
  const a=productionAgentState,r=a.result,next=r?.next_step,steps=(r?.steps||[]).slice(0,5),progress=Math.max(0,Math.min(100,Number(r?.progress||0))),changed=r?.checkpoint_changed===true?'정본 변경 감지':r?.checkpoint_changed===false?'정본 변경 없음':'기준점 생성';
  const result=r?`<div class="agent-result"><div class="agent-result-head"><div><strong>${r.target_reached?'✓ 목표 상태 도달':`Production Agent · ${esc(agentTargetLabel(r.target))}`}</strong><small>${esc(agentStopLabel(r.stop_reason))} · 진행률 ${progress}% · ${esc(changed)}</small></div><span class="gate-badge ${r.target_reached?'pass':r.stop_reason==='blocked'?'fail':'warn'}">${r.target_reached?'READY':esc(String(next?.status||r.status||'WAIT').toUpperCase())}</span></div><div class="progress"><i style="width:${progress}%"></i></div>${next?`<div class="agent-next"><div class="row"><div><b>${esc(next.label||next.stage||'다음 작업')}</b><small>${esc(next.instruction||'')}</small></div><span class="pill">${esc(next.suggested_tool||'수동 확인')}</span></div>${(next.reasons||[]).slice(0,3).map(x=>`<small>• ${esc(x)}</small>`).join('')}</div>`:''}${steps.length?`<div class="agent-step-list">${steps.map(step=>`<div class="agent-step"><span>${step.order}</span><b>${esc(step.label||step.stage)}</b><span>${esc(step.suggested_tool||step.status||'확인')}</span></div>`).join('')}</div>`:''}<div class="agent-meta"><span class="pill">${esc(agentTargetLabel(r.target))}</span><span class="pill">재확인마다 HAP 정본 읽기</span><span class="agent-checkpoint">${esc(String(r.checkpoint||'').slice(0,16))}</span></div></div>`:'';
  return `<section class="agent-console"><div class="agent-command-row"><input id="agentGoal" value="${esc(a.goal)}" placeholder="예: 이 씬 영상 생성 준비 완료까지 진행해줘" ${a.loading?'disabled':''}><button class="btn primary" id="agentRun" ${a.loading?'disabled':''}>${a.loading?'상태 분석 중…':'Agent 실행'}</button></div><div class="agent-quick"><button data-agent-goal="영상 생성 준비 완료까지 진행해줘">Generate-ready</button><button data-agent-goal="업로드 패키지까지 준비해줘">업로드 준비</button><button data-agent-goal="stale 결과를 최신 revision 기준으로 업데이트해줘">Stale 최신화</button></div>${a.error?`<div class="agent-error">${esc(a.error)}</div>`:''}${result}</section>`;
}
async function runProductionAgentGoal(goal){
  const value=String(goal??productionAgentState.goal??'').trim();if(!value){toast('Production Agent에게 목표를 입력하세요');return}
  productionAgentState.goal=value;productionAgentState.loading=true;productionAgentState.error=null;renderScene();
  try{
    const result=await window.sceneFlow.runProductionAgent(selected.project,sceneId(selected),{goal:value,previous_checkpoint:productionAgentState.checkpoint});
    productionAgentState.result=result;productionAgentState.checkpoint=result?.checkpoint||productionAgentState.checkpoint;productionAgentState.loading=false;
    detail=await window.sceneFlow.sceneDetail(selected.project,sceneId(selected));if(detail?.production)selected.production=detail.production;renderScene();
  }catch(e){productionAgentState.loading=false;productionAgentState.error=e.message||String(e);renderScene();toast('Production Agent 실패: '+(e.message||e))}
}
function bindProductionAgent(){
  const input=$('agentGoal'),run=$('agentRun');if(!input||!run)return;
  input.oninput=e=>productionAgentState.goal=e.target.value;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();runProductionAgentGoal(input.value)}};run.onclick=()=>runProductionAgentGoal(input.value);
  document.querySelectorAll('[data-agent-goal]').forEach(button=>button.onclick=()=>{productionAgentState.goal=button.dataset.agentGoal;runProductionAgentGoal(button.dataset.agentGoal)});
}
'''
replace_once(
    p,
    '''function productionStatusLabel(status){return status==='ready'?'READY':status==='stale'?'STALE':status==='blocked'?'BLOCKED':status==='needs_review'?'REVIEW':status==='in_progress'?'WORKING':'MISSING'}\n''',
    agent_functions + '''function productionStatusLabel(status){return status==='ready'?'READY':status==='stale'?'STALE':status==='blocked'?'BLOCKED':status==='needs_review'?'REVIEW':status==='in_progress'?'WORKING':'MISSING'}\n''',
    "agent view functions",
)
replace_once(
    p,
    '''</span></div><div class="scene-tabs">''',
    '''</span></div>${productionAgentCommandView()}<div class="scene-tabs">''',
    "agent command placement",
)
replace_once(
    p,
    '''bindMedia();if(sceneTab==='assets')bindAssetFolder();if(sceneTab==='ready')bindAiControls()}\n''',
    '''bindMedia();bindProductionAgent();if(sceneTab==='assets')bindAssetFolder();if(sceneTab==='ready')bindAiControls()}\n''',
    "agent binding",
)

print("reinforcement v7 UI bridge applied")
