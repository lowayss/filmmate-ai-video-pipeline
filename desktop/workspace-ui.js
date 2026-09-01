// FilmMate workspace UI layer.
// Keeps canonical HAP/Seedance behavior intact while making navigation,
// progress and prompt work explicit and recoverable.
(function(){
  'use strict';

  const PREF_KEY='filmmate.workspace.v1';
  const DONE=new Set(['ready','accepted','verified','connected']);
  const WARNING=new Set(['stale','blocked','invalid','changed','missing']);
  const stageTabs={analysis:'analysis',text_conti:'conti',assets:'assets',storyboard:'storyboard',prompts:'ready',qa:'ready'};
  const stateLabels={pending:'대기',planned:'계획',working:'작업 중',unverified:'검증 필요',ready:'준비됨',accepted:'승인됨',verified:'검증됨',connected:'연결됨',stale:'갱신 필요',blocked:'차단',invalid:'오류',changed:'변경됨',missing:'누락',legacy_claim:'기존 자료 · 검증 필요',legacy_unverified:'기존 자료 · 검증 필요'};
  let workspaceFilter='all';

  function readPrefs(){
    try{return JSON.parse(localStorage.getItem(PREF_KEY)||'{}')}catch{return{}}
  }
  function writePrefs(patch){
    const next={...readPrefs(),...patch};
    localStorage.setItem(PREF_KEY,JSON.stringify(next));
    return next;
  }
  function scenePrefKey(scene=selected){return `${project?.id||''}:${scene?.scene_id||''}`}
  function saveScenePrefs(){
    if(!selected)return;
    const prefs=readPrefs(),scenes={...(prefs.scenes||{})};
    scenes[scenePrefKey()]={tab:sceneTab,model:aiDraft.model,unitType:aiDraft.unitType,targetId:aiDraft.targetId};
    writePrefs({scenes});
  }
  function stateLabel(value){return stateLabels[value]||value||'대기'}
  function promptSourceGate(){
    if(aiDraft?.workflowMode==='micro_shot'&&typeof globalThis.filmMateMicroShotSourceGate==='function')return globalThis.filmMateMicroShotSourceGate();
    const conti=detail?.documents?.conti||{};
    const reasons=[];
    if(conti.structured_sync_required)reasons.push('수정된 글 콘티를 Codex 콘합 구조에 다시 반영해야 합니다');
    if(['stale','blocked'].includes(conti.state))reasons.push(conti.state==='stale'?'시나리오 변경 뒤 콘티가 갱신되지 않았습니다':'콘티 리비전이 차단 상태입니다');
    const conhapEntity=(detail?.hap?.entities||[]).find(entity=>entity.entity_id===detail?.hap?.conhap_entity_id);
    if(conhapEntity&&['stale','blocked'].includes(conhapEntity.state)&&!reasons.length)reasons.push('현재 콘티 구조가 최신 시나리오와 맞지 않습니다');
    return {blocked:reasons.length>0,reasons};
  }
  globalThis.filmMatePromptSourceGate=promptSourceGate;
  function visualStateClass(value){return String(value||'').startsWith('legacy_')?'warn':statusClass(value)}
  function pipelineEntries(scene){return Object.entries(stages).map(([key,label])=>({key,label,state:scene.pipeline?.[key]||'pending'}))}
  function nextStage(scene){return pipelineEntries(scene).find(item=>!DONE.has(item.state))||{key:'qa',label:'최종 확인',state:'ready'} }
  function hasWarning(scene){return pipelineEntries(scene).some(item=>WARNING.has(item.state)||String(item.state).startsWith('legacy_'))}
  function sceneMatchesFilter(scene){
    if(workspaceFilter==='done')return Number(scene.progress||0)>=100;
    if(workspaceFilter==='attention')return hasWarning(scene);
    if(workspaceFilter==='active')return Number(scene.progress||0)<100&&!hasWarning(scene);
    return true;
  }
  function syncNav(){
    document.querySelectorAll('#nav [data-view]').forEach(item=>item.classList.toggle('active',item.dataset.view===view));
    document.body.classList.toggle('scene-open',Boolean(selected));
  }
  function showUiError(error){
    const message=String(error?.stack||error?.message||error||'알 수 없는 화면 오류');
    $('main').innerHTML=`<div class="ui-error"><strong>화면을 안정적으로 표시하지 못했습니다.</strong><p>프로젝트 데이터는 변경하지 않았습니다. 새로고침 후 다시 확인하세요.</p><pre>${esc(message)}</pre><button class="btn" id="recoverUi">화면 새로고침</button></div>`;
    const recover=$('recoverUi');if(recover)recover.onclick=()=>location.reload();
  }

  const workspacePageHeadBase=pageHead;
  pageHead=(name,sub)=>`<div class="topline"><div><div class="eyebrow">${esc(safeProjectTitle(project))} · WORKSPACE</div><h1>${esc(name)}</h1><p class="sub">${esc(sub)}</p></div><div class="metrics"><div class="metric"><b>${project.scenes.length}</b><small>SCENES</small></div><div class="metric"><b>${project.scenes.reduce((n,s)=>n+(s.shot_count||0),0)}</b><small>CUTS</small></div><div class="metric"><b>${Math.round(project.scenes.reduce((n,s)=>n+Number(s.progress||0),0)/Math.max(1,project.scenes.length))}%</b><small>PROGRESS</small></div></div></div>`;

  sceneCard=(scene)=>{
    const next=nextStage(scene),entries=pipelineEntries(scene),progress=Number(scene.progress||0),note=view==='assets'?`에셋 ${stateLabel(scene.pipeline?.assets)}`:view==='storyboard'?`스토리보드 ${stateLabel(scene.pipeline?.storyboard)}`:view==='ready'?`프롬프트 ${stateLabel(scene.pipeline?.prompts)}`:`${scene.shot_count||0}컷 · ${scene.block_count||0}블록`;
    return `<article class="scene-card" data-scene="${esc(scene.scene_id)}" tabindex="0"><div class="scene-head"><span class="sid">${esc(scene.scene_id)}</span><span class="pill">${esc(scene.scene_duration||'—')}</span></div><h3>${esc(safeSceneTitle(scene))}</h3><div class="muted">${esc(hasReplacement(scene.location)?'원문 인코딩 오류':scene.location||'장소 미확정')} · ${esc(hasReplacement(scene.time)?'원문 인코딩 오류':scene.time||'시간 미확정')}</div><div class="stage-dots" aria-label="제작 단계">${entries.map(item=>`<i class="stage-dot ${visualStateClass(item.state)}" title="${esc(item.label)} · ${esc(stateLabel(item.state))}"></i>`).join('')}</div><div class="progress"><i style="width:${progress}%"></i></div><div class="scene-progress-meta"><span>${progress}% 진행</span><span>${esc(note)}</span></div><div class="scene-next"><strong>다음 작업</strong><span>${esc(next.label)} →</span></div></article>`;
  };

  renderIndex=()=>{
    if(view==='system'){renderSystem();syncNav();return}
    const names={board:['프로젝트 보드','씬별 진행률과 다음 작업을 한곳에서 관리합니다.'],assets:['에셋','씬별 인물·배경·소품 자료를 확인합니다.'],storyboard:['스토리보드','승인 프레임과 누락된 씬을 확인합니다.'],ready:['AI 입력','프롬프트와 패키지 준비 상태를 확인합니다.']},[name,sub]=names[view]||names.board;
    const query=String($('search').value||'').toLowerCase();
    const searched=project.scenes.filter(scene=>(safeSceneTitle(scene)+' '+(scene.location||'')+' '+scene.scene_id).toLowerCase().includes(query));
    const list=searched.filter(sceneMatchesFilter),attention=project.scenes.filter(hasWarning).length,done=project.scenes.filter(scene=>Number(scene.progress||0)>=100).length;
    $('main').innerHTML=`<div class="workspace-page">${pageHead(name,sub)}<div class="board-tools"><div class="filter-tabs" role="tablist" aria-label="씬 상태 필터">${[['all','전체'],['active','진행 중'],['attention','점검 필요'],['done','완료']].map(([key,label])=>`<button class="filter-chip ${workspaceFilter===key?'active':''}" data-workspace-filter="${key}">${label}</button>`).join('')}</div><div class="board-summary">전체 ${project.scenes.length} · 점검 필요 ${attention} · 완료 ${done}</div></div><div class="scene-grid">${list.map(sceneCard).join('')||'<div class="empty">이 조건에 맞는 씬이 없습니다.</div>'}</div></div>`;
    document.querySelectorAll('[data-workspace-filter]').forEach(button=>button.onclick=()=>{workspaceFilter=button.dataset.workspaceFilter;writePrefs({filter:workspaceFilter});renderIndex()});
    document.querySelectorAll('[data-scene]').forEach(card=>{card.onclick=()=>openScene(card.dataset.scene);card.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openScene(card.dataset.scene)}}});
    syncNav();
  };

  const workspaceSceneContentBase=sceneContent;
  function documentEditorView(kind){
    const document=detail?.documents?.[kind]||{},isScreenplay=kind==='screenplay';
    const content=isScreenplay?(document.content??detail?.sourceText??''):(document.content??detail?.conhap?.textConti??'');
    const label=isScreenplay?'시나리오 원문':'글 콘티';
    const revision=document.revision_id||'HAP 미등록';
    const source=document.canonical?'HAP 정본':'기존 파일 · 첫 저장 시 HAP 정본 등록';
    const effect=isScreenplay?'저장하면 이 원문을 사용한 콘티·스토리보드·프롬프트가 갱신 필요 상태로 바뀝니다.':'저장하면 이 콘티를 사용한 스토리보드·프롬프트가 갱신 필요 상태로 바뀝니다.';
    return `<section class="document-workbench" data-document-kind="${kind}"><div class="document-toolbar"><div><div class="document-title"><h2>${label}</h2><span class="stage ${visualStateClass(document.state)}">${esc(stateLabel(document.state))}</span></div><p>${esc(source)} · <code>${esc(revision)}</code></p></div><div class="document-actions"><button class="btn" id="reloadDocument">최신본 불러오기</button><button class="btn" id="resetDocument" disabled>변경 취소</button><button class="btn primary" id="saveDocument" disabled>새 리비전 저장</button></div></div><div class="document-notice"><strong>FilmMate ↔ Codex 공용 정본</strong><span>${esc(effect)}</span></div><textarea id="documentEditor" class="document-editor" data-original-sha="${esc(document.sha256||'')}" spellcheck="false">${esc(content)}</textarea><div class="document-footer"><span id="documentEditStatus">수정 전 · 저장된 최신본</span><span id="documentMetrics"></span></div></section>`;
  }
  function currentDocumentEditor(){return $('documentEditor')}
  function documentEditorDirty(){
    const editor=currentDocumentEditor();
    if(!editor)return false;
    const kind=editor.closest('[data-document-kind]')?.dataset.documentKind;
    const document=detail?.documents?.[kind]||{};
    return editor.value!==String(document.content??(kind==='screenplay'?detail?.sourceText:detail?.conhap?.textConti)??'');
  }
  function confirmDiscardDocumentEdits(){return !documentEditorDirty()||window.confirm('저장하지 않은 텍스트 수정이 있습니다. 변경을 버리고 이동할까요?')}
  function updateDocumentEditorState(){
    const editor=currentDocumentEditor(),save=$('saveDocument'),reset=$('resetDocument'),status=$('documentEditStatus'),metrics=$('documentMetrics');
    if(!editor)return;
    const dirty=documentEditorDirty(),characters=Array.from(editor.value).length,lines=editor.value?editor.value.split(/\n/).length:0;
    if(save)save.disabled=!dirty;if(reset)reset.disabled=!dirty;
    if(status)status.textContent=dirty?'저장되지 않은 변경 사항':'수정 전 · 저장된 최신본';
    if(status)status.classList.toggle('dirty',dirty);
    if(metrics)metrics.textContent=`${characters.toLocaleString('ko-KR')}자 · ${lines.toLocaleString('ko-KR')}줄`;
  }
  async function reloadCurrentDocument(){
    const sceneKey=sceneId(selected),tab=sceneTab;
    detail=await window.sceneFlow.sceneDetail(selected.project,sceneKey);
    sceneTab=tab;renderScene();
  }
  async function refreshAfterDocumentSave(){
    const projectId=selected.project,logicalSceneId=selected.scene_id,sceneKey=sceneId(selected),tab=sceneTab;
    projects=await window.sceneFlow.projects();
    project=projects.find(item=>item.id===projectId)||chooseProject(projects);
    selected=project?.scenes?.find(item=>item.scene_id===logicalSceneId)||null;
    syncProjectSelect();
    if(!selected){detail=null;render();return}
    detail=await window.sceneFlow.sceneDetail(projectId,sceneKey);
    sceneTab=tab;renderScene();
  }
  function bindDocumentEditor(){
    const editor=currentDocumentEditor();if(!editor)return;
    const kind=editor.closest('[data-document-kind]').dataset.documentKind,save=$('saveDocument'),reset=$('resetDocument'),reload=$('reloadDocument');
    editor.addEventListener('input',updateDocumentEditorState);
    editor.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(!save.disabled)save.click()}});
    reset.onclick=()=>{editor.value=String(detail?.documents?.[kind]?.content??(kind==='screenplay'?detail?.sourceText:detail?.conhap?.textConti)??'');updateDocumentEditorState();editor.focus()};
    reload.onclick=async()=>{if(!confirmDiscardDocumentEdits())return;reload.disabled=true;try{await reloadCurrentDocument();toast('HAP 최신본을 다시 불러왔습니다')}catch(error){toast('최신본 불러오기 실패: '+error.message)}finally{reload.disabled=false}};
    save.onclick=async()=>{
      if(!documentEditorDirty())return;
      const document=detail?.documents?.[kind]||{};
      save.disabled=true;save.textContent='저장 중…';
      try{
        const out=await window.sceneFlow.saveSceneDocument(selected.project,sceneId(selected),{kind,content:editor.value,expectedRevisionId:document.revision_id??null,expectedSceneRevisionId:detail?.documents?.screenplay?.revision_id??null});
        await refreshAfterDocumentSave();
        const stale=out.stale_dependents?.length||0;
        toast(out.unchanged?'변경된 내용이 없습니다':`새 리비전 ${out.revision_id} 저장 · 갱신 필요 ${stale}개`);
      }catch(error){
        const message=String(error?.message||error);
        if(message.includes('revision_conflict')){
          const status=$('documentEditStatus');if(status){status.textContent='리비전 충돌 · 최신본을 불러온 뒤 다시 수정하세요';status.classList.add('conflict')}
          toast('다른 수정본이 먼저 저장되어 덮어쓰기를 막았습니다');
        }else toast('문서 저장 실패: '+message);
        save.disabled=false;save.textContent='새 리비전 저장';
      }
    };
    updateDocumentEditorState();
  }
  sceneContent=()=>{
    if(sceneTab==='analysis')return documentEditorView('screenplay');
    if(sceneTab==='conti')return documentEditorView('conti');
    if(sceneTab!=='overview')return workspaceSceneContentBase();
    const scene=selected,breakdown=detail?.breakdown||scene.breakdown||{},next=nextStage(scene),entries=pipelineEntries(scene);
    return `<div class="summary"><div><small>컷</small><strong>${breakdown.shot_count||scene.shot_count||0}</strong></div><div><small>블록</small><strong>${scene.block_count||0}</strong></div><div><small>등록 파일</small><strong>${detail?.files?.length||0}</strong></div><div><small>전체 진행률</small><strong>${scene.progress||0}%</strong></div></div><div class="next-action"><div><small>지금 이어서 할 작업</small><strong>${esc(next.label)} · ${esc(stateLabel(next.state))}</strong></div><button class="btn primary" data-stage-tab="${esc(stageTabs[next.key])}">${esc(next.label)} 열기</button></div><div class="section-title"><h2>제작 단계</h2><span class="muted">정본 상태를 기준으로 표시합니다.</span></div><div class="workflow-list">${entries.map((item,index)=>`<div class="workflow-step ${visualStateClass(item.state)}"><span class="step-no">${String(index+1).padStart(2,'0')}</span><strong>${esc(item.label)}</strong><small>${esc(stateLabel(item.state))}</small><button data-stage-tab="${esc(stageTabs[item.key])}">열기 →</button></div>`).join('')}</div>`;
  };

  renderScene=()=>{
    try{
      const scene=selected,index=project.scenes.findIndex(item=>item.scene_id===scene.scene_id),previous=project.scenes[index-1],next=project.scenes[index+1],tabs=[['overview','상태'],['analysis','원문'],['conti','글 콘티'],['assets','에셋'],['storyboard','스토리보드'],['ready','AI 입력']],approval=detail?.conhap?.textContiVersion||detail?.manifest?.conhap?.text_conti_version||detail?.manifest?.conhap?.approval||'정본 상태 확인';
      $('main').innerHTML=`<div class="scene-page"><div class="scene-header-card"><div class="scene-header-main"><div><div class="scene-breadcrumb"><button id="back">${esc(safeProjectTitle(project))}</button><span>›</span><span>${esc(scene.scene_id)}</span></div><div class="scene-title"><div><h1>${esc(safeSceneTitle(scene))}</h1><p class="sub">${esc(hasReplacement(scene.location)?'원문 인코딩 오류':scene.location||'미확정')} · ${esc(hasReplacement(scene.time)?'원문 인코딩 오류':scene.time||'미확정')} · ${esc(scene.scene_duration||'')}</p></div></div></div><div class="scene-jump"><span class="pill">${esc(approval)}</span><button class="btn" data-scene-jump="${esc(previous?.scene_id||'')}" ${previous?'':'disabled'} title="이전 씬">←</button><button class="btn" data-scene-jump="${esc(next?.scene_id||'')}" ${next?'':'disabled'} title="다음 씬">→</button></div></div><div class="scene-tabs">${tabs.map(([key,label])=>`<button class="scene-tab ${sceneTab===key?'active':''}" data-tab="${key}">${label}</button>`).join('')}</div></div><div class="content">${sceneContent()}</div></div>`;
      $('back').onclick=()=>{if(!confirmDiscardDocumentEdits())return;saveScenePrefs();selected=null;detail=null;render()};
      document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{if(!confirmDiscardDocumentEdits())return;sceneTab=button.dataset.tab;saveScenePrefs();renderScene()});
      document.querySelectorAll('[data-stage-tab]').forEach(button=>button.onclick=()=>{sceneTab=button.dataset.stageTab;saveScenePrefs();renderScene()});
      document.querySelectorAll('[data-scene-jump]').forEach(button=>button.onclick=()=>{if(!confirmDiscardDocumentEdits())return;button.dataset.sceneJump&&openScene(button.dataset.sceneJump)});
      bindMedia();if(sceneTab==='analysis'||sceneTab==='conti')bindDocumentEditor();if(sceneTab==='assets')bindAssetFolder();if(sceneTab==='ready')bindAiControls();
      syncNav();
    }catch(error){showUiError(error)}
  };

  slotView=(role,label,items)=>{
    const selectedCount=items.filter(item=>item.combined||aiDraft.items.some(value=>value.absolutePath===item.absolutePath)).length,open=selectedCount>0||role==='storyboard';
    const cards=items.map(item=>item.combined?`<div class="slot-item selected"><div class="slot-select"><img src="${esc(item.url)}"><span>${esc(aiDraft.targetId)} 합본 · ${currentShotIds().join(' → ')}</span></div><button class="copy-mini" data-copy-image="${esc(item.absolutePath)}">복사</button></div>`:`<div class="slot-item ${aiDraft.items.some(value=>value.absolutePath===item.absolutePath)?'selected':''}"><button class="slot-select" data-toggle="${esc(item.absolutePath)}" data-role="${role}" data-name="${esc(item.name)}" data-url="${esc(item.url)}"><img src="${esc(item.url)}"><span>${esc(item.name)}</span></button><button class="copy-mini" data-copy-image="${esc(item.absolutePath)}">복사</button></div>`).join('');
    return `<section class="slot"><details class="asset-drawer" ${open?'open':''}><summary class="slot-head"><div class="asset-summary"><strong>${esc(label)}</strong><small>${items.length}개</small><small class="selected-count">선택 ${selectedCount}</small>${role==='storyboard'&&aiDraft.unitType==='block'?'<span class="pill">블록 컷 묶음</span>':''}</div></summary><div class="asset-drawer-body"><div class="drawer-actions"><button class="btn" data-pick="${role}">+ 이미지 추가</button></div><div class="slot-grid">${cards||'<div class="asset-empty">등록된 이미지가 없습니다.</div>'}</div></div></details></section>`;
  };

  directionSheetView=()=>{
    const sheet=productionDirectionSheet();
    return `<details class="direction-card"><summary><div class="direction-summary"><div><strong>제작 기준서</strong><small>정본·카메라·연기·컬러 잠금</small></div><span class="pill">필요할 때 펼치기</span></div></summary><div class="direction-body"><div class="direction-head"><div><strong>콘티 기반 작업 계약</strong><small>HAP 정본은 변경하지 않습니다.</small></div><button class="btn" id="copyDirectionSheet">복사</button></div><div class="direction-grid">${sheet.rows.slice(0,4).map(([label,value])=>`<div class="direction-item"><b>${esc(label)}</b><span>${esc(value)}</span></div>`).join('')}</div><details class="direction-more"><summary>전체 기준서 보기</summary><pre>${esc(sheet.markdown)}</pre></details></div></details>`;
  };

  blockGateView=()=>{
    const record=globalThis.filmMatePromptLanguages?.current?.(),label=aiDraft.unitType==='block'?'블록 QA':'컷 QA';
    if(record&&!record.jobId&&record.jobState==='IDLE')return `<section class="block-gate"><div class="gate-head"><div><strong>${label}</strong><small>KO·EN·中文 생성 후 자동 검사합니다.</small></div><span class="gate-badge pending">생성 대기</span></div></section>`;
    const qa=currentPromptQa(),issues=qa.checks.filter(item=>item.status!=='PASS'),summary=qa.status==='PASS'?`${qa.counts.pass}개 검사 통과`:`실패 ${qa.counts.fail} · 경고 ${qa.counts.warn}`;
    return `<section class="block-gate"><div class="gate-head"><div><strong>${label}</strong><small>복사·저장 전 자동 검사</small></div><div class="row"><span class="gate-badge ${qa.status.toLowerCase()}">${qa.status} · ${summary}</span><button class="btn" id="rerunBlockScan">재검사</button></div></div>${issues.length?`<div class="gate-issues">${gateRows(issues)}</div>`:''}<details class="gate-details"><summary>전체 ${qa.checks.length}개 검사 보기</summary><div class="gate-issues">${gateRows(qa.checks)}</div></details></section>`;
  };

  function arrangePromptWorkspace(html){
    const holder=document.createElement('div');holder.innerHTML=html;
    const root=document.createElement('div');root.className='prompt-workbench';
    const setup=document.createElement('div');setup.className='prompt-setup';
    const setupPrimary=document.createElement('div');setupPrimary.className='prompt-setup-primary';
    const setupStatus=document.createElement('div');setupStatus.className='prompt-setup-status';
    const columns=document.createElement('div');columns.className='prompt-columns';
    const assets=document.createElement('section');assets.className='prompt-assets-panel';
    const editor=document.createElement('section');editor.className='prompt-editor-panel';
    const direct=()=>Array.from(holder.children);
    const directClass=name=>direct().find(node=>node.classList?.contains(name));
    const notice=directClass('notice'),toolbar=directClass('ai-toolbar'),skill=directClass('skill-lock'),direction=directClass('direction-card'),gate=directClass('block-gate'),profile=direct().find(node=>node.classList?.contains('list-item')&&node.textContent.includes('작업 프로필'));
    [notice,toolbar].filter(Boolean).forEach(node=>setupPrimary.appendChild(node));if(profile){profile.classList.add('profile-note');setupPrimary.appendChild(profile)}if(skill)setupStatus.appendChild(skill);setup.append(setupPrimary,setupStatus);
    const slots=Array.from(holder.querySelectorAll(':scope > .slot'));assets.insertAdjacentHTML('beforeend',`<div class="panel-heading"><h2>선택 레퍼런스</h2><small>필요한 것만 선택</small></div>`);slots.forEach(node=>assets.appendChild(node));
    const titles=direct().filter(node=>node.classList?.contains('section-title')),orderTitle=titles.find(node=>node.textContent.includes('업로드 순서')),promptTitle=titles.find(node=>node.textContent.includes('영상 프롬프트')),order=directClass('order-list');
    if(order){const box=document.createElement('div');box.className='upload-order';box.innerHTML='<div class="upload-order-head"><strong>업로드 순서</strong><small>@Image 번호 기준</small></div>';box.appendChild(order);assets.appendChild(box)}if(orderTitle)orderTitle.remove();
    const sourceGate=promptSourceGate();
    if(sourceGate.blocked){
      const sourceGateNode=document.createElement('section');sourceGateNode.className='prompt-source-gate blocked';
      sourceGateNode.innerHTML=`<strong>Codex 구조 반영 필요</strong><span>${esc(sourceGate.reasons.join(' · '))}</span><small>구조 반영이 끝나기 전에는 KO·EN·中文 생성을 시작할 수 없습니다.</small>`;
      editor.appendChild(sourceGateNode);
    }
    if(direction)editor.appendChild(direction);if(gate)editor.appendChild(gate);
    const promptHeading=document.createElement('div');promptHeading.className='prompt-editor-heading';promptHeading.innerHTML=`<h2>영상 프롬프트</h2><span>${esc(aiDraft.model)} · ${esc(aiDraft.targetId)}</span>`;editor.appendChild(promptHeading);if(promptTitle)promptTitle.remove();
    const language=directClass('prompt-language-bar'),textarea=holder.querySelector('#aiPrompt'),field=textarea?.closest('.field');if(language)editor.appendChild(language);if(field)editor.appendChild(field);
    const leftovers=direct().filter(node=>!node.classList?.contains('export-bar'));leftovers.forEach(node=>editor.appendChild(node));
    columns.append(assets,editor);root.append(setup,columns);
    const actions=directClass('export-bar');if(actions){const request=actions.querySelector('#requestCodexPrompt');if(request)request.textContent='KO·EN·中文 생성';const approve=actions.querySelector('#approvePromptJob');if(approve)approve.textContent='묶음 승인';const copy=actions.querySelector('#copyPrompt');if(copy)copy.textContent='프롬프트 복사';root.appendChild(actions)}
    return root.outerHTML;
  }

  const workspacePromptLibraryBase=promptLibraryView;
  promptLibraryView=(canonical)=>arrangePromptWorkspace(workspacePromptLibraryBase(canonical));

  const workspaceOpenSceneBase=openScene;
  openScene=async(id)=>{
    await workspaceOpenSceneBase(id);
    const saved=readPrefs().scenes?.[scenePrefKey()];
    if(saved){
      sceneTab=saved.tab||sceneTab;
      if(['Seedance 2.0','Seedance 2.5','Higgsfield','Runway'].includes(saved.model))aiDraft.model=saved.model;
      aiDraft.unitType=saved.unitType==='block'?'block':'shot';
      if(aiDraft.model==='Seedance 2.5')aiDraft.unitType='block';
      const targets=aiDraft.unitType==='block'?aiBlocks():(detail?.conhap?.shots||[]),valid=targets.some(item=>(item.block_id||item.id)===saved.targetId);
      aiDraft.targetId=valid?saved.targetId:(targets[0]?.block_id||targets[0]?.id||aiDraft.targetId);
      syncTargetPackage();renderScene();
    }
    writePrefs({lastScene:scenePrefKey()});
  };

  const workspaceBindAiBase=bindAiControls;
  bindAiControls=()=>{
    workspaceBindAiBase();
    const sourceGate=promptSourceGate(),request=$('requestCodexPrompt');
    if(request&&sourceGate.blocked){request.disabled=true;request.title=sourceGate.reasons.join(' · ')}
    ['aiModel','aiUnit','aiTarget'].forEach(id=>{const control=$(id);if(!control)return;control.addEventListener('change',()=>setTimeout(saveScenePrefs,0))});
  };

  const workspaceRenderBase=render;
  render=()=>{try{workspaceRenderBase();syncNav()}catch(error){showUiError(error)}};

  function bindWorkspaceChrome(){
    const prefs=readPrefs();workspaceFilter=prefs.filter||'all';if(['board','assets','storyboard','ready','system'].includes(prefs.view))view=prefs.view;
    $('nav').onclick=event=>{const item=event.target.closest('[data-view]');if(!item)return;saveScenePrefs();view=item.dataset.view;writePrefs({view});selected=null;detail=null;render()};
    $('projectSelect').onchange=event=>{saveScenePrefs();project=projects.find(item=>item.id===event.target.value)||null;if(project){localStorage.setItem('filmmate.project',project.id);localStorage.removeItem('filmmake.project')}selected=null;detail=null;render()};
    let searchTimer=null;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{if(selected){saveScenePrefs();selected=null;detail=null;view='board';writePrefs({view})}renderIndex()},120)};
    $('refresh').onclick=async()=>{const button=$('refresh');if(button.disabled)return;button.disabled=true;button.textContent='…';const scene=selected?.scene_id,tab=sceneTab;try{await load();if(scene&&project?.scenes.some(item=>item.scene_id===scene)){await openScene(scene);sceneTab=tab;renderScene()}toast('프로젝트 상태를 새로고침했습니다')}catch(error){toast('새로고침 실패: '+error.message)}finally{button.disabled=false;button.textContent='↻'}};
    document.addEventListener('click',event=>{const menu=document.querySelector('.header-menu');if(menu?.open&&!menu.contains(event.target))menu.removeAttribute('open')});
  }

  window.addEventListener('error',event=>{console.error(event.error||event.message)});
  window.addEventListener('unhandledrejection',event=>{console.error(event.reason);toast('작업을 완료하지 못했습니다. 현재 데이터는 유지됩니다.')});
  bindWorkspaceChrome();
  syncNav();
  if(project)render();
  globalThis.filmMateWorkspaceUI={version:'0.7.2',readPrefs,nextStage,stateLabel,promptSourceGate};
})();
