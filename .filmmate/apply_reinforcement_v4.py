from pathlib import Path
import re


def replace_exact(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"missing replacement target: {label}")
    if text.count(old) != 1:
        raise SystemExit(f"ambiguous replacement target: {label} ({text.count(old)})")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_regex(path, pattern, replacement, label):
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"regex replacement failed: {label} ({count})")
    path.write_text(updated, encoding="utf-8")


hap = Path("core/hap_core.py")
old_dependency = '''def dependency_stale(db, revision_id, currents):
    deps = db.execute("SELECT upstream_revision_id FROM dependencies WHERE downstream_revision_id=?", (revision_id,)).fetchall()
    for dep in deps:
        upstream = db.execute("SELECT entity_id FROM revisions WHERE revision_id=?", (dep[0],)).fetchone()
        current = currents.get(upstream[0])
        if not upstream or current is None or current["revision_id"] != dep[0]:
            return True
    return False
'''
new_dependency = '''def dependency_details(db, revision_id, currents):
    rows = db.execute(
        "SELECT d.upstream_revision_id,d.role,r.entity_id,e.entity_type,e.logical_key,r.rev_no "
        "FROM dependencies d "
        "JOIN revisions r ON r.revision_id=d.upstream_revision_id "
        "JOIN entities e ON e.entity_id=r.entity_id "
        "WHERE d.downstream_revision_id=? "
        "ORDER BY d.role,e.entity_type,e.logical_key,d.upstream_revision_id",
        (revision_id,),
    ).fetchall()
    details = []
    for row in rows:
        current = currents.get(row["entity_id"])
        current_revision_id = current["revision_id"] if current is not None else None
        details.append({
            "role": row["role"],
            "upstream_entity_id": row["entity_id"],
            "upstream_entity_type": row["entity_type"],
            "upstream_logical_key": row["logical_key"],
            "used_revision_id": row["upstream_revision_id"],
            "used_rev_no": row["rev_no"],
            "current_revision_id": current_revision_id,
            "current_rev_no": current["rev_no"] if current is not None else None,
            "stale": current_revision_id != row["upstream_revision_id"],
        })
    return details

def dependency_stale(db, revision_id, currents):
    return any(item["stale"] for item in dependency_details(db, revision_id, currents))
'''
replace_exact(hap, old_dependency, new_dependency, "hap dependency details")

old_stale = '''    errors = artifact_errors(root, db, revision["revision_id"])
    if dependency_stale(db, revision["revision_id"], currents):
        return {"state": "stale", "errors": ["an upstream revision changed", *errors]}
'''
new_stale = '''    errors = artifact_errors(root, db, revision["revision_id"])
    stale_dependencies = [item for item in dependency_details(db, revision["revision_id"], currents) if item["stale"]]
    if stale_dependencies:
        stale_errors = [
            f"{item['role']}: {item['upstream_entity_type']} {item['upstream_logical_key']} changed "
            f"from {item['used_revision_id']} to {item['current_revision_id'] or 'missing'}"
            for item in stale_dependencies
        ]
        return {"state": "stale", "errors": [*stale_errors, *errors]}
'''
replace_exact(hap, old_stale, new_stale, "hap stale explanation")

old_projection = '''        state = derive_state(root, db, entity, revision, currents)
        artifacts = [dict(x) for x in artifact_rows(db, revision["revision_id"])] if revision else []
        entities.append({**dict(entity), "current_revision": row_dict(revision), **state, "artifacts": artifacts})
'''
new_projection = '''        state = derive_state(root, db, entity, revision, currents)
        artifacts = [dict(x) for x in artifact_rows(db, revision["revision_id"])] if revision else []
        dependencies = dependency_details(db, revision["revision_id"], currents) if revision else []
        entities.append({**dict(entity), "current_revision": row_dict(revision), **state, "artifacts": artifacts, "dependencies": dependencies})
'''
replace_exact(hap, old_projection, new_projection, "hap projection dependency payload")

main = Path("desktop/main.cjs")
replace_exact(
    main,
    'const {createPythonBridge} = require("./python-bridge.cjs");\n',
    'const {createPythonBridge} = require("./python-bridge.cjs");\nconst {buildSceneProductionState} = require("./production-state.cjs");\n',
    "main production-state require",
)

old_children = '''            const sceneEntity = hapProjection?.entities?.find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene.name));
            const childEntities = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
            const aggregate = (types, empty = "pending") => {
'''
new_children = '''            const sceneEntity = hapProjection?.entities?.find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene.name));
            const childEntities = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
            const scenePromptJobs = (hapProjection?.prompt_jobs || []).filter(job => job.scene_key === manifest.scene_id || job.scene_key === scene.name);
            const production = sceneEntity ? buildSceneProductionState({sceneEntity, childEntities, promptJobs:scenePromptJobs}) : null;
            const aggregate = (types, empty = "pending") => {
'''
replace_exact(main, old_children, new_children, "project scene production calculation")

old_progress = '''              path: sceneDir,
              progress: stages.length ? Math.round(done / stages.length * 100) : 0,
              state_source: sceneEntity ? "hap-v2" : "legacy-evidence-only",
'''
new_progress = '''              path: sceneDir,
              production,
              progress: production?.progress ?? (stages.length ? Math.round(done / stages.length * 100) : 0),
              state_source: sceneEntity ? "hap-v2" : "legacy-evidence-only",
'''
replace_exact(main, old_progress, new_progress, "project card production payload")

old_detail_children = '''  const sceneEntity = (hapProjection?.entities || []).find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene));
  const sceneChildren = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
  const assetLibrary = listSceneAssetLibrary(sceneDir, project, scene);
'''
new_detail_children = '''  const sceneEntity = (hapProjection?.entities || []).find(entity => entity.entity_type === "scene" && (entity.logical_key === manifest.scene_id || entity.logical_key === scene));
  const sceneChildren = sceneEntity ? (hapProjection.entities || []).filter(entity => entity.parent_id === sceneEntity.entity_id) : [];
  const scenePromptJobs = (hapProjection?.prompt_jobs || []).filter(job => job.scene_key === manifest.scene_id || job.scene_key === scene);
  const production = sceneEntity ? buildSceneProductionState({sceneEntity, childEntities:sceneChildren, promptJobs:scenePromptJobs}) : null;
  const assetLibrary = listSceneAssetLibrary(sceneDir, project, scene);
'''
replace_exact(main, old_detail_children, new_detail_children, "scene detail production calculation")

old_detail_return = '''    documents,
    conhap,
    hap:{
'''
new_detail_return = '''    documents,
    conhap,
    production,
    hap:{
'''
replace_exact(main, old_detail_return, new_detail_return, "scene detail production response")

old_hap_entities = '''      entities:sceneChildren.map(entity => ({entity_id:entity.entity_id,entity_type:entity.entity_type,logical_key:entity.logical_key,current_revision_id:entity.current_revision?.revision_id || null,state:entity.state})),
'''
new_hap_entities = '''      entities:sceneChildren.map(entity => ({entity_id:entity.entity_id,entity_type:entity.entity_type,logical_key:entity.logical_key,current_revision_id:entity.current_revision?.revision_id || null,state:entity.state,errors:entity.errors || [],dependencies:entity.dependencies || []})),
'''
replace_exact(main, old_hap_entities, new_hap_entities, "scene detail dependency diagnostics")

index = Path("desktop/index.html")
replace_exact(
    index,
    '</style>\n<link rel="stylesheet" href="workspace-ui.css">',
    '''.readiness-card{border:1px solid #6e552c;background:#17140e;border-radius:13px;padding:15px 16px;margin:14px 0}.readiness-card.ready{border-color:#496628;background:#111a0e}.readiness-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.readiness-head strong{display:block;font-size:15px}.readiness-head small{display:block;color:var(--muted);margin-top:4px}.readiness-stages{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.readiness-reasons{display:grid;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}.readiness-reason{font-size:12px;color:var(--muted);line-height:1.45}.readiness-reason b{color:var(--text)}\n</style>\n<link rel="stylesheet" href="workspace-ui.css">''',
    "readiness styles",
)

scene_card_block = '''function productionStatusClass(status){return status==='ready'?'done':status==='blocked'||status==='stale'?'warn':'plan'}
function productionStatusLabel(status){return status==='ready'?'READY':status==='stale'?'STALE':status==='blocked'?'BLOCKED':status==='needs_review'?'REVIEW':status==='in_progress'?'WORKING':'MISSING'}
function productionReadinessView(p){
  if(!p)return'';
  const stageRows=Object.values(p.stages||{}),headline=p.generate_ready?'Generate-ready':'생성 준비 전',sub=p.generate_ready?'현재 정본 기준으로 필수 프리프로덕션 단계가 모두 준비됐습니다.':`${p.ready_stages||0}/${p.required_stages||0} 필수 단계 준비 · 다음 조치: ${p.next_action?.action||'상태 확인'}`;
  const reasons=(p.blockers||[]).flatMap(blocker=>(blocker.reasons||[]).slice(0,3).map(reason=>`<div class="readiness-reason"><b>${esc(blocker.label||blocker.stage)}</b> · ${esc(reason)}</div>`));
  return `<section class="readiness-card ${p.generate_ready?'ready':''}"><div class="readiness-head"><div><strong>${headline}</strong><small>${esc(sub)}</small></div><span class="gate-badge ${p.generate_ready?'pass':p.status==='blocked'||p.status==='stale'?'fail':'warn'}">${productionStatusLabel(p.status)}</span></div><div class="readiness-stages">${stageRows.map(stage=>`<span class="stage ${productionStatusClass(stage.status)}">${esc(stage.label)} · ${productionStatusLabel(stage.status)}</span>`).join('')}</div>${reasons.length?`<div class="readiness-reasons">${reasons.join('')}</div>`:''}</section>`;
}
function sceneCard(s){let note=view==='assets'?`에셋 ${s.pipeline?.assets||'pending'}`:view==='storyboard'?`스토리보드 ${s.pipeline?.storyboard||'pending'}`:view==='ready'?(s.production?.generate_ready?'Generate-ready':`${s.production?.ready_stages||0}/${s.production?.required_stages||0} 준비`):`${s.shot_count||0}컷 · ${s.block_count||0}블록`;return `<article class="scene-card" data-scene="${esc(s.scene_id)}"><div class="scene-head"><span class="sid">${esc(s.scene_id)}</span><span class="pill">${s.production?productionStatusLabel(s.production.status):esc(s.scene_duration||'—')}</span></div><h3>${esc(safeSceneTitle(s))}</h3><div class="muted">${esc(hasReplacement(s.location)?'원문 인코딩 오류':s.location||'장소 미확정')} · ${esc(hasReplacement(s.time)?'원문 인코딩 오류':s.time||'시간 미확정')}</div><div class="progress"><i style="width:${s.progress||0}%"></i></div><div class="row"><div class="stage-row">${Object.entries(stages).slice(0,4).map(([k,l])=>`<span class="stage ${statusClass(s.pipeline?.[k])}">${l}</span>`).join('')}</div><span class="muted">${esc(note)} →</span></div></article>`}
'''
replace_regex(
    index,
    r"function sceneCard\(s\)\{.*?\nasync function loadSeedanceSkillPolicy",
    scene_card_block + "async function loadSeedanceSkillPolicy",
    "scene card production UI",
)

scene_content = '''function sceneContent(){const s=selected,b=detail?.breakdown||s.breakdown||{};if(sceneTab==='overview')return `${productionReadinessView(detail?.production||s.production)}<div class="summary"><div><small>컷</small>${b.shot_count||s.shot_count||0}</div><div><small>등록 파일</small>${detail?.files?.length||0}</div><div><small>에셋</small>${s.pipeline?.assets||'pending'}</div><div><small>스토리보드</small>${s.pipeline?.storyboard||'pending'}</div></div><div class="section-title"><h2>제작 단계</h2></div><div class="list">${Object.entries(stages).map(([k,l])=>`<div class="list-item row"><strong>${l}</strong><span class="stage ${statusClass(s.pipeline?.[k])}">${esc(s.pipeline?.[k]||'pending')}</span></div>`).join('')}</div>`;if(sceneTab==='analysis')return `<div class="doc">${esc(detail?.sourceText||'원문 없음')}</div>`;if(sceneTab==='conti')return `<div class="doc">${esc(detail?.conhap?.textConti||'글 콘티 없음')}</div>`;if(sceneTab==='assets')return assetView();if(sceneTab==='storyboard')return storyboardView();return readyView()}
function activeConhapDir'''
replace_regex(
    index,
    r"function sceneContent\(\)\{.*?\nfunction activeConhapDir",
    scene_content,
    "scene overview readiness UI",
)

replace_exact(
    index,
    "function readyView(){return promptLibraryView(selected?.state_source==='hap-v2')}",
    "function readyView(){return productionReadinessView(detail?.production||selected?.production)+promptLibraryView(selected?.state_source==='hap-v2')}",
    "ready tab readiness UI",
)

print("FilmMate reinforcement v4 integration applied")
