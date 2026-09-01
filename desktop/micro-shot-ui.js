// FilmMate's additive 4–15 second single-shot workflow.
// This module never mutates HAP canonical documents. It only creates a
// working request that is sent through the existing prompt-job gate.
(function(){
  'use strict';

  const MICRO='micro_shot';
  const MIN_SECONDS=4;
  const MAX_SECONDS=15;
  const STORAGE_KEY='filmmate.micro-shot.v1';
  const ROLE_ORDER={motion:0,character:1,background:2,location:2,prop:3,audio:4};
  const VIDEO_EXT=/\.(mp4|mov|m4v|webm|avi|mkv)$/i;
  const AUDIO_EXT=/\.(wav|mp3|m4a|aac|flac|ogg)$/i;
  const labelForType=type=>type==='video'?'Video':type==='audio'?'Audio':'Image';
  const mediaType=item=>{
    const explicit=String(item?.mediaType||item?.media_type||'').toLowerCase();
    if(['image','video','audio'].includes(explicit))return explicit;
    const source=String(item?.absolutePath||item?.name||'');
    return VIDEO_EXT.test(source)?'video':AUDIO_EXT.test(source)?'audio':'image';
  };
  const typeTag=(type,index)=>`@${labelForType(type)} ${index}`;
  const externalId=(type,index)=>`${labelForType(type)} ${index}`;
  const storageRead=()=>{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}')}catch{return{}}};
  const storageWrite=value=>localStorage.setItem(STORAGE_KEY,JSON.stringify(value));
  const microKey=()=>`${project?.id||selected?.project||''}:${selected?sceneId(selected):''}`;
  const microStore=()=>{const value=storageRead();return value[microKey()]||null};
  const isMicro=()=>aiDraft.workflowMode===MICRO;
  const clampDuration=value=>Math.min(MAX_SECONDS,Math.max(MIN_SECONDS,Number(value)||5));

  function syncMicroReferenceOrder(){
    if(!isMicro())return [];
    const seen=new Set();
    const items=(aiDraft.items||[]).filter(item=>item&&item.absolutePath&&['character','background','location','prop','motion','audio'].includes(String(item.role||''))).filter(item=>{
      const source=String(item.absolutePath);if(seen.has(source))return false;seen.add(source);return true;
    }).sort((a,b)=>(ROLE_ORDER[a.role]??9)-(ROLE_ORDER[b.role]??9)||(Number(a.sequence??999)-Number(b.sequence??999))||String(a.name||'').localeCompare(String(b.name||'')));
    const counts={image:0,video:0,audio:0};
    items.forEach((item,index)=>{
      const type=mediaType(item);counts[type]+=1;
      item.inputOrder=index+1;
      item.mediaType=type;
      item.tag=item.tag||typeTag(type,counts[type]);
      item.externalId=item.externalId||externalId(type,counts[type]);
      item.sourceKind=item.sourceKind||item.source_kind||(item.role==='motion'?'previs':'asset');
      item.use=item.use||(item.role==='motion'?'motion, blocking, camera, and timing only':`${item.role} identity and continuity only`);
      item.exclude=item.exclude||(item.role==='motion'?'do not inherit its placeholder identity, wardrobe, background, or visual style':'do not inherit unrelated pose, camera, or background details');
    });
    // The tag is derived from the current order so removing/re-adding a
    // reference cannot leave stale Image/Video numbers behind.
    const renumbered=[];const nextCounts={image:0,video:0,audio:0};
    items.forEach(item=>{const type=mediaType(item);nextCounts[type]+=1;item.tag=typeTag(type,nextCounts[type]);item.externalId=externalId(type,nextCounts[type]);renumbered.push(item)});
    aiDraft.items=renumbered;
    aiDraft.uploads=renumbered.filter(item=>item.sourceKind==='previs'||!item.revisionId);
    return renumbered;
  }

  function microReferences(){return syncMicroReferenceOrder()}
  function microBrief(){return String(aiDraft.microBrief||'').trim()}
  function microDuration(){return clampDuration(aiDraft.microDurationSec||5)}

  function buildMicroShotPrompt(){
    const refs=microReferences();
    const brief=microBrief()||'[장면 설명을 입력하세요]';
    const refLines=refs.length?refs.map(item=>{
      const type=mediaType(item),tag=item.tag||typeTag(type,item.inputOrder||1);
      const role=item.role==='motion'?'프리비즈 동작·블로킹·카메라·타이밍만 사용한다. 프리비즈의 얼굴·인물·의상·배경·스타일은 사용하지 않는다.':item.role==='character'?'인물의 얼굴·헤어·체형·의상·정체성만 고정한다. 동작·카메라·배경은 이 레퍼런스에서 추정하지 않는다.':item.role==='background'||item.role==='location'?'공간 구조·장소·광원·시간대만 고정한다. 인물·동작·카메라는 이 레퍼런스에서 추정하지 않는다.':item.role==='prop'?'소품의 형태·재질·색·브랜드 상태만 고정한다. 무관한 배경·인물·동작은 가져오지 않는다.':'샷 로컬 오디오로만 사용한다.';
      return `${tag} — ${item.name||'이름 없는 레퍼런스'}: ${role}`;
    }).join('\n'):'선택된 레퍼런스 없음.';
    const hasPrevis=refs.some(item=>item.role==='motion'&&mediaType(item)==='video');
    return `FilmMate MICRO SHOT REQUEST
작업 모드: 단일 장면 4–15초
목표 길이: ${microDuration()}초

사용자 장면 설명(원문):
${brief}

외부 업로드 순서: 아래 레퍼런스의 input_order와 태그를 그대로 유지한다. ${hasPrevis?'프리비즈가 있으므로 Video 1을 첫 번째로, 이후 Image/Audio 번호는 미디어 종류별로 유지한다.':'프리비즈가 없으므로 선택된 레퍼런스의 순서와 태그를 그대로 유지한다.'}

— REFERENCE ROLES —
${refLines}

— CODEX COMPILATION CONTRACT —
이 요청을 씨댄스·Higgsfield·Runway 계열 외부 영상 생성기에 붙여 넣을 수 있는 최종 프롬프트 묶음으로 컴파일한다. 외부 생성은 FilmMate가 실행하지 않는다.
프리비즈가 있으면 Video 태그는 동작·블로킹·카메라·시간 리듬만 전달한다. 캐릭터 시트는 인물 정체성과 의상, 배경 시트는 공간과 광원, 소품 레퍼런스는 소품의 형태와 재질을 통제한다. 역할이 충돌하면 이 규칙과 각 역할의 범위를 따른다.
프리비즈가 없으면 장면 설명에 없는 카메라를 과장해 발명하지 않는다. 카메라가 미지정이면 고정 또는 최소 이동을 사용하고, 한 번에 하나의 중심 행동과 하나의 주된 카메라 행동만 작성한다.
최종 결과에는 0초부터 ${microDuration()}초까지 연속하는 하드 타임라인을 만들고, 각 구간에 시작 상태·중심 행동·카메라·엔드스테이트를 작성한다. 불필요한 인물·소품·대사·자막·로고·BGM을 추가하지 않는다.
반드시 prompt_ir와 한국어·영어·简体中文 최종 프롬프트를 함께 제출한다. 위의 @Image/@Video/@Audio 태그, CUT MICRO_01, 사용자 장면 설명의 사실과 순서를 세 언어에서 보존한다.`;
  }
  globalThis.filmMateBuildMicroShotPrompt=buildMicroShotPrompt;

  function microSourceGate(){
    const reasons=[];
    if(!microBrief())reasons.push('4–15초 장면 설명을 입력하세요');
    const refs=microReferences(),roles=new Set(refs.map(item=>item.role));
    if(!roles.has('character'))reasons.push('캐릭터 시트를 선택하세요');
    if(!roles.has('background')&&!roles.has('location'))reasons.push('배경 시트를 선택하세요');
    if(microDuration()<MIN_SECONDS||microDuration()>MAX_SECONDS)reasons.push('길이는 4–15초여야 합니다');
    if(typeof seedanceSkillReady==='function'&&!seedanceSkillReady())reasons.push('씨댄스 스킬 원본 점검이 필요합니다');
    return {blocked:reasons.length>0,reasons};
  }
  const legacySourceGate=globalThis.filmMatePromptSourceGate;
  globalThis.filmMateMicroShotSourceGate=microSourceGate;
  globalThis.filmMatePromptSourceGate=()=>isMicro()?microSourceGate():(typeof legacySourceGate==='function'?legacySourceGate():{blocked:false,reasons:[]});

  function microSlot(role,label,selectedItems){
    const cards=selectedItems.map(item=>{
      const type=mediaType(item),preview=type==='video'?`<video src="${esc(item.url||'')}" muted preload="metadata"></video>`:type==='audio'?`<div class="micro-audio-preview">AUDIO</div>`:`<img src="${esc(item.url||'')}" alt="">`;
      return `<div class="slot-item selected micro-selected-item">${preview}<span>${esc(item.name||'')}</span><button type="button" class="copy-mini micro-remove" data-micro-remove="${esc(item.absolutePath)}">제거</button></div>`;
    }).join('');
    const action=role==='motion'||role==='audio'?`<button class="btn" data-micro-pick="${role}">+ ${role==='motion'?'프리비즈 영상':'오디오'} 추가</button>`:'';
    return `<section class="slot micro-slot micro-slot-${role}"><div class="slot-head"><div><strong>${esc(label)}</strong> <span class="muted">${selectedItems.length?'선택됨':'선택 안 됨'}</span></div><div class="row">${action}</div></div><div class="slot-grid">${cards||`<span class="muted">${role==='motion'?'선택하지 않으면 프리비즈 없이 작성합니다.':'선택하지 않으면 오디오 레퍼런스 없이 작성합니다.'}</span>`}</div></section>`;
  }

  function microForm(){
    return `<div class="micro-shot-form"><div class="micro-shot-form-head"><div><strong>단일 장면 입력</strong><small>프리비즈(선택) + 캐릭터 시트 + 배경 시트 + 4–15초 설명</small></div><span class="pill">MICRO SHOT</span></div><div class="micro-shot-fields"><div class="field"><label>작업 방식</label><select id="microWorkflow"><option value="scene_block">기존 콘티 기반 씬/블록</option><option value="micro_shot" selected>단일 장면 · 4–15초</option></select></div><div class="field"><label>목표 길이 (초)</label><input id="microDuration" type="number" min="4" max="15" step="0.5" value="${esc(microDuration())}"></div></div><div class="field"><label>4–15초 장면 설명</label><textarea id="microBrief" rows="5" placeholder="예: 무더운 놀이공원 뒤편에서 탈인형 알바생이 탈을 벗고 땀을 닦다가 낡은 아이스하우스로 들어간다.">${esc(aiDraft.microBrief||'')}</textarea></div><div class="micro-shot-contract"><b>레퍼런스 역할과 순서</b><span>프리비즈가 있으면 <code>Video 1</code> → 캐릭터 <code>Image 1</code> → 배경 <code>Image 2</code> → 소품/오디오</span><span>프리비즈는 움직임만, 캐릭터·배경 시트는 외형과 공간만 통제합니다.</span></div></div>`;
  }

  function microModeChooser(){
    return `<div class="micro-mode-chooser"><div><strong>작업 방식</strong><small>기존 콘티 씬/블록 또는 새 4–15초 단일 장면</small></div><select id="microWorkflow"><option value="scene_block" selected>기존 콘티 기반 씬/블록</option><option value="micro_shot">단일 장면 · 4–15초</option></select></div>`;
  }

  function microOrderView(){
    const refs=microReferences();
    const chips=refs.map(item=>`<div class="order-chip"><b>${esc(item.tag)}</b><span>${esc(item.role)}</span><br><small>${esc(item.name||'')}</small></div>`).join('');
    return `<div class="upload-order micro-upload-order"><div class="upload-order-head"><strong>외부 업로드 순서</strong><small>프롬프트 태그와 동일한 순서</small></div><div class="order-list">${chips||'<span class="muted">캐릭터·배경 시트를 먼저 선택하세요.</span>'}</div></div>`;
  }

  const legacyOrderedAiItems=orderedAiItems;
  orderedAiItems=()=>isMicro()?microReferences():legacyOrderedAiItems();

  const legacyPromptLibraryView=promptLibraryView;
  promptLibraryView=canonical=>{
    if(!isMicro()){
      document.body.classList.remove('micro-shot-mode');
      const holder=document.createElement('div');holder.innerHTML=legacyPromptLibraryView(canonical);
      const setup=holder.querySelector('.prompt-setup-primary');
      if(setup&&!holder.querySelector('.micro-mode-chooser'))setup.insertAdjacentHTML('beforeend',microModeChooser());
      return holder.innerHTML;
    }
    syncMicroReferenceOrder();
    document.body.classList.add('micro-shot-mode');
    const holder=document.createElement('div');holder.innerHTML=legacyPromptLibraryView(canonical);
    const setup=holder.querySelector('.prompt-setup-primary');
    if(setup&&!holder.querySelector('.micro-shot-form'))setup.insertAdjacentHTML('beforeend',microForm());
    const assets=holder.querySelector('.prompt-assets-panel');
    if(assets){
      const heading=assets.querySelector('.panel-heading');
      if(heading){heading.insertAdjacentHTML('afterend',microSlot('motion','프리비즈 영상 (선택)',microReferences().filter(item=>item.role==='motion')));heading.insertAdjacentHTML('afterend',microSlot('audio','오디오 레퍼런스 (선택)',microReferences().filter(item=>item.role==='audio')));}
      const legacyStoryboard=assets.querySelector(':scope > .slot:not(.micro-slot)');if(legacyStoryboard)legacyStoryboard.classList.add('micro-storyboard-legacy');
    }
    const order=holder.querySelector('.upload-order');if(order)order.outerHTML=microOrderView();
    const workbench=holder.querySelector('.prompt-workbench');if(workbench)workbench.classList.add('micro-shot-workbench');
    return holder.innerHTML;
  };

  function saveMicroState(){
    if(!selected)return;
    const value=storageRead();value[microKey()]={active:isMicro(),workflowMode:MICRO,microDurationSec:microDuration(),microBrief:String(aiDraft.microBrief||''),targetId:aiDraft.targetId,items:isMicro()?microReferences():[]};storageWrite(value);
  }
  function enterMicroMode(){
    const saved=microStore();
    aiDraft.workflowMode=MICRO;aiDraft.unitType='shot';aiDraft.targetId=aiDraft.targetId&&String(aiDraft.targetId).startsWith('MICRO_')?aiDraft.targetId:'MICRO_01';
    aiDraft.microDurationSec=clampDuration(saved?.microDurationSec||aiDraft.microDurationSec||5);aiDraft.microBrief=String(saved?.microBrief||aiDraft.microBrief||'');
    if(saved?.items?.length&&!aiDraft.items.some(item=>item?.role==='character'||item?.role==='background'))aiDraft.items=saved.items;
    syncMicroReferenceOrder();aiDraft.prompt=buildAiPrompt();saveMicroState();renderScene();
  }
  function leaveMicroMode(){
    const value=storageRead();value[microKey()]={...(value[microKey()]||{}),active:false,workflowMode:MICRO,microDurationSec:microDuration(),microBrief:String(aiDraft.microBrief||''),targetId:aiDraft.targetId,items:microReferences()};storageWrite(value);
    aiDraft.workflowMode='scene_block';delete aiDraft.microDurationSec;delete aiDraft.microBrief;syncTargetPackage();renderScene();
  }
  function updateMicroPrompt(){
    if(!isMicro())return;
    syncMicroReferenceOrder();aiDraft.prompt=buildAiPrompt();
    const editor=$('aiPrompt');if(editor&&!editor.matches(':focus'))editor.value=aiDraft.prompt;
    saveMicroState();updateLanguageBarIfAvailable();
  }
  function updateLanguageBarIfAvailable(){
    const record=globalThis.filmMatePromptLanguages?.current?.();
    if(record&&typeof globalThis.filmMatePromptLanguages?.update==='function')globalThis.filmMatePromptLanguages.update(record);
  }
  function bindMicroControls(){
    const mode=$('microWorkflow');
    if(mode)mode.onchange=()=>mode.value===MICRO?enterMicroMode():leaveMicroMode();
    const duration=$('microDuration');
    if(duration)duration.onchange=()=>{aiDraft.microDurationSec=clampDuration(duration.value);duration.value=String(aiDraft.microDurationSec);updateMicroPrompt()};
    const brief=$('microBrief');
    if(brief)brief.oninput=()=>{aiDraft.microBrief=brief.value;updateMicroPrompt()};
    document.querySelectorAll('[data-micro-pick]').forEach(button=>button.onclick=async()=>{
      try{
        const role=button.dataset.microPick,picked=await window.sceneFlow.pickPreviewImages(selected.project,sceneId(selected),role);
        aiDraft.items=[...(aiDraft.items||[]).filter(item=>item.role!==role),...picked.map(item=>({...item,role,sourceKind:role==='motion'?'previs':'asset',mediaType:role==='motion'?'video':'audio'}))];
        syncMicroReferenceOrder();updateMicroPrompt();renderScene();
      }catch(error){toast(`${role==='motion'?'프리비즈':'오디오'} 추가 실패: ${error.message}`)}
    });
    document.querySelectorAll('[data-micro-remove]').forEach(button=>button.onclick=event=>{event.stopPropagation();aiDraft.items=(aiDraft.items||[]).filter(item=>item.absolutePath!==button.dataset.microRemove);updateMicroPrompt();renderScene()});
    if(!isMicro())return;
    document.querySelectorAll('[data-toggle]').forEach(button=>button.onclick=()=>{
      const source=button.dataset.toggle,index=(aiDraft.items||[]).findIndex(item=>item.absolutePath===source);
      if(index>=0)aiDraft.items.splice(index,1);
      else{
        const candidate=Object.values(aiCandidates()).flat().find(item=>item.absolutePath===source)||{};
        aiDraft.items.push({role:button.dataset.role,name:button.dataset.name,absolutePath:source,url:button.dataset.url,mediaType:'image',sourceKind:'asset',revisionId:candidate.revisionId||'',provenance:'FilmMate selected asset'});
      }
      updateMicroPrompt();renderScene();
    });
  }
  const legacyBindAiControls=bindAiControls;
  bindAiControls=()=>{legacyBindAiControls();bindMicroControls()};

  function microQa(prompt=String(aiDraft.prompt||''),items=microReferences()){
    const refs=items||[],tags=refs.map(item=>item.tag),roles=new Set(refs.map(item=>item.role)),checks=[];
    const push=(id,label,ok,pass,fail)=>checks.push({id,label,status:ok?'PASS':'FAIL',detail:ok?pass:fail});
    const gate=microSourceGate();
    push('MICRO_BRIEF','4–15초 장면 설명',Boolean(microBrief()),'장면 설명 입력됨','장면 설명 필요');
    push('MICRO_DURATION','길이 범위',microDuration()>=MIN_SECONDS&&microDuration()<=MAX_SECONDS,`${microDuration()}초`, '4–15초만 허용');
    push('MICRO_CHARACTER','캐릭터 시트',roles.has('character'),'캐릭터 시트 선택됨','캐릭터 시트 필요');
    push('MICRO_BACKGROUND','배경 시트',roles.has('background')||roles.has('location'),'배경 시트 선택됨','배경 시트 필요');
    push('MICRO_REFERENCE_ORDER','태그·첨부 순서',tags.every((tag,index)=>prompt.includes(tag)),tags.join(' → ')||'없음','프롬프트의 태그가 첨부 순서와 다름');
    push('MICRO_TIMELINE_CONTRACT','시작·행동·카메라·끝',/시작 상태|Start state/.test(prompt)&&/중심 행동|Central action/.test(prompt)&&/카메라|Camera/.test(prompt)&&/엔드스테이트|End state/.test(prompt),'4요소 계약 확인','4요소 계약 누락');
    push('SEEDANCE_SKILL_SOURCE','씨댄스 스킬 원본',typeof seedanceSkillReady!=='function'||seedanceSkillReady(),'스킬 원본 확인','스킬 원본 점검 필요');
    const status=checks.some(check=>check.status==='FAIL')?'FAIL':'PASS';
    return{schema_version:1,preview:true,canonical:false,status,target_id:aiDraft.targetId,model:aiDraft.model,skill_provenance:typeof seedanceSkillProvenance==='function'?seedanceSkillProvenance():null,checked_at:new Date().toISOString(),counts:{pass:checks.filter(x=>x.status==='PASS').length,warn:0,fail:checks.filter(x=>x.status==='FAIL').length},checks,source_gate:gate};
  }
  const legacyScanSingleShotPrompt=scanSingleShotPrompt;
  scanSingleShotPrompt=(prompt=String(aiDraft.prompt||''),items=packageDisplayItems())=>isMicro()?microQa(prompt,microReferences()):legacyScanSingleShotPrompt(prompt,items);

  const legacyOpenScene=openScene;
  openScene=async id=>{
    await legacyOpenScene(id);
    const saved=microStore();
    if(saved?.active&&saved?.workflowMode===MICRO){
      aiDraft.workflowMode=MICRO;aiDraft.unitType='shot';aiDraft.targetId=saved.targetId||'MICRO_01';aiDraft.microDurationSec=clampDuration(saved.microDurationSec||5);aiDraft.microBrief=String(saved.microBrief||'');
      aiDraft.items=(saved.items||[]).filter(item=>item?.absolutePath&&item.absolutePath);
      aiDraft.uploads=[...(aiDraft.items||[])];syncMicroReferenceOrder();aiDraft.prompt=buildAiPrompt();renderScene();
    }
  };

  globalThis.filmMateMicroShot={version:1,workflowMode:MICRO,minSeconds:MIN_SECONDS,maxSeconds:MAX_SECONDS,buildPrompt:buildMicroShotPrompt,validate:microQa,referenceOrder:microReferences};
})();
