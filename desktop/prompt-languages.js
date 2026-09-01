// FilmMate prompt-language controller.
// FilmMate creates the immutable HAP request, launches a read-only Codex worker,
// then receives one complete ko/en/zh bundle after Prompt IR and QA validation.
(function(){
  'use strict';

  const LANGUAGES={
    ko:{label:'한국어',short:'KO'},
    en:{label:'English',short:'EN'},
    zh:{label:'简体中文',short:'中文'},
  };
  const promptLanguageRecords=new Map();
  let handoffTimer=null;
  let handoffPollTimer=null;
  function variantReady(status){return status==='ready'||status==='approved'}
  function promptSourceGate(){
    return typeof globalThis.filmMatePromptSourceGate==='function'
      ? globalThis.filmMatePromptSourceGate()
      : {blocked:false,reasons:[]};
  }

  function promptContext(overrides={}){
    const items=overrides.items||packageDisplayItems();
    const workflowMode=overrides.workflowMode||aiDraft.workflowMode||'scene_block';
    const inputMode=overrides.inputMode||((items||[]).length?'reference_to_video':'text_to_video');
    const unitType=overrides.unitType||aiDraft.unitType||'shot';
    const targetId=overrides.targetId||aiDraft.targetId||'';
    const target=unitType==='block'?aiBlocks().find(x=>(x.block_id||x.id)===targetId):null;
    const inputRevisions=workflowMode==='micro_shot'?[]:[
      detail?.hap?.scene_revision_id?{revision_id:detail.hap.scene_revision_id,role:'scene'}:null,
      detail?.hap?.conhap_revision_id?{revision_id:detail.hap.conhap_revision_id,role:'written_storyboard'}:null,
      ...(detail?.hap?.entities||[]).filter(entity=>entity.current_revision_id&&(entity.logical_key===targetId||entity.entity_type==='block'&&unitType==='block'||entity.entity_type==='cut'&&unitType==='shot')).map(entity=>({revision_id:entity.current_revision_id,role:entity.entity_type})),
    ].filter(Boolean).filter((item,index,list)=>list.findIndex(other=>other.revision_id===item.revision_id)===index);
    return {
      project:overrides.project||selected?.project||project?.id||'',
      scene:overrides.scene||sceneId(selected||{path:'/scenes/unknown'}),
      model:overrides.model||aiDraft.model||'',
      unitType,
      workflowMode,
      inputMode,
      targetId,
      skillBundleSha256:seedanceSkillPolicy?.bundle_sha256||'',
      microBrief:String(overrides.microBrief||aiDraft.microBrief||''),
      references:(items||[]).map((item,index)=>({
        order:item.inputOrder||index+1,
        tag:item.tag||'',
        externalId:item.externalId||item.external_id||'',
        mediaType:item.mediaType||item.media_type||'',
        sourceKind:item.sourceKind||item.source_kind||'',
        role:workflowMode==='micro_shot'&&item.role==='location'?'background':(item.role||''),name:item.name||'',path:item.absolutePath||'',absolutePath:item.absolutePath||'',
        revisionId:item.revisionId||item.sourceRevision||'',provenance:item.provenance||'',use:item.use||'',exclude:item.exclude||'',
      })),
      inputRevisions,
      shotIds:workflowMode==='micro_shot'?[targetId]:currentShotIds(),
      durationSec:workflowMode==='micro_shot'?Number(aiDraft.microDurationSec||5):(unitType==='block'?(target?.duration_sec||modelBlockDurationSec()):(currentShotIds().length?timedShotSchedule().find(x=>x.id===targetId)?.duration:5)||5),
      requiredReferenceRoles:workflowMode==='micro_shot'?['character','background']:[],
    };
  }
  function promptContextKey(overrides={}){return JSON.stringify(promptContext(overrides))}
  function currentPromptRecord(){return promptLanguageRecords.get(promptContextKey())||null}
  function recordForPrompt(prompt){
    const value=String(prompt||''),current=currentPromptRecord();
    if(current&&Object.values(current.variants).includes(value))return current;
    for(const record of promptLanguageRecords.values())if(Object.values(record.variants).includes(value))return record;
    return null;
  }
  function promptProtectedStrings(){
    const registry=detail?.conhap?.project?.asset_registry||[];
    return [...new Set([
      aiDraft.model,
      aiDraft.targetId,
      ...currentShotIds(),
      ...packageDisplayItems().flatMap(item=>[item.name,item.role,item.tag,item.externalId,item.external_id]),
      ...registry.flatMap(item=>[item.id,item.name]),
    ].map(value=>String(value||'').trim()).filter(Boolean))];
  }
  function createPromptRecord(key,canonical){
    return {
      key,
      context:promptContext(),
      generatedKorean:String(canonical||''),
      variants:{ko:String(canonical||''),en:'',zh:''},
      status:{ko:'waiting',en:'waiting',zh:'waiting'},
      language:'ko',
      translationSource:null,
      translationMeta:null,
      requestSource:String(canonical||''),
      requestSha256:null,
      jobId:null,
      claimToken:null,
      jobState:'IDLE',
      jobRevisionId:null,
      promptIr:null,
      workerStarted:false,
      workerStarting:false,
      syncing:false,
      error:null,
      protectedStrings:promptProtectedStrings(),
    };
  }
  function ensurePromptRecord(canonical){
    const key=promptContextKey();
    let record=promptLanguageRecords.get(key);
    if(!record||record.generatedKorean!==String(canonical||'')){
      record=createPromptRecord(key,canonical);
      promptLanguageRecords.set(key,record);
    }
    return record;
  }
  function serializePromptRecord(record){
    return {
      promptLanguage:record.language,
      promptVariants:{...record.variants},
      promptVariantStatus:{...record.status},
      promptTranslationMeta:record.translationMeta?{...record.translationMeta}:null,
      promptVariantKey:record.key,
      promptProtectedStrings:[...record.protectedStrings],
    };
  }
  function syncDraftFromRecord(record){
    if(!record)return;
    const selectedLanguage=record.language==='ko'||variantReady(record.status[record.language])?record.language:'ko';
    record.language=selectedLanguage;
    Object.assign(aiDraft,serializePromptRecord(record));
    aiDraft.prompt=record.variants[selectedLanguage]||record.variants.ko;
  }
  function currentLanguageForPrompt(prompt){
    const record=recordForPrompt(prompt);
    if(record){
      for(const language of ['ko','en','zh'])if(record.variants[language]===String(prompt||''))return{language,record};
      return{language:record.language||'ko',record};
    }
    const value=String(prompt||'');
    if(value.includes('— TOOL SETTINGS —'))return{language:'en',record:null};
    if(value.includes('— 工具设置 —'))return{language:'zh',record:null};
    return{language:'ko',record:null};
  }

  const buildAiPromptBeforeLanguages=buildAiPrompt;
  buildAiPrompt=()=>{
    const canonical=aiDraft.workflowMode==='micro_shot'&&typeof globalThis.filmMateBuildMicroShotPrompt==='function'
      ? globalThis.filmMateBuildMicroShotPrompt()
      : buildAiPromptBeforeLanguages();
    const record=ensurePromptRecord(canonical);
    syncDraftFromRecord(record);
    return aiDraft.prompt;
  };

  function languageStatusLabel(status){
    return {idle:'생성 전',ready:'전달 완료',waiting:'전달 대기',queued:'Codex 대기열',claimed:'Codex 접수',writing:'Codex 작성 중',validating:'검증 중',checking:'확인 중',stale:'재전달 필요',error:'수신 거부',rejected:'검증 거부',approved:'승인 완료'}[status]||status||'전달 대기';
  }
  function handoffReady(record){
    return Boolean(record&&['ko','en','zh'].every(language=>variantReady(record.status[language]))&&record.translationSource===record.variants.ko&&['codex-to-filmmate','codex-to-filmmate-hap'].includes(record.translationMeta?.delivery));
  }
  function handoffSummary(record){
    if(handoffReady(record))return'Codex 전달 완료 · KO / EN / 中文';
    if(record?.syncing)return'Codex 전달 확인 중';
    if(record?.error)return`Codex 전달 거부 · ${record.error}`;
    return `${languageStatusLabel(String(record?.jobState||'queued').toLowerCase())} · KO / EN / 中文 묶음 필요`;
  }
  function languageBarView(record){
    if(!record)return'';
    const tabs=Object.entries(LANGUAGES).map(([language,profile])=>{
      const status=record.status[language]||'queued',active=record.language===language,disabled=language!=='ko'&&!variantReady(status);
      return `<button type="button" class="prompt-language-tab ${active?'active':''} ${status}" data-prompt-language="${language}" ${disabled?'disabled':''} title="${esc(profile.label)} · ${esc(languageStatusLabel(status))}"><i></i>${esc(profile.label)}</button>`;
    }).join('');
    return `<div class="prompt-language-bar"><div class="prompt-language-tabs" role="tablist" aria-label="프롬프트 언어">${tabs}</div><span id="promptTranslationSummary" class="prompt-translation-summary">${esc(handoffSummary(record))}</span><button type="button" class="prompt-language-refresh" id="refreshPromptLanguages" title="Codex에서 전달된 최신 3개 언어 묶음 확인">↻</button></div>`;
  }
  function updateLanguageBar(record=currentPromptRecord()){
    if(!record)return;
    document.querySelectorAll('[data-prompt-language]').forEach(button=>{
      const language=button.dataset.promptLanguage,status=record.status[language]||'queued';
      button.className=`prompt-language-tab ${record.language===language?'active':''} ${status}`;
      button.disabled=language!=='ko'&&!variantReady(status);
      button.title=`${LANGUAGES[language].label} · ${languageStatusLabel(status)}`;
    });
    const summary=$('promptTranslationSummary');
    if(summary){
      summary.textContent=handoffSummary(record);
    }
    const refresh=$('refreshPromptLanguages');
    if(refresh)refresh.disabled=record.syncing;
    const approve=$('approvePromptJob');
    if(approve)approve.disabled=record.syncing||record.jobState!=='READY';
    const request=$('requestCodexPrompt');
    const sourceGate=promptSourceGate();
    if(request){
      request.disabled=record.syncing||record.workerStarting||sourceGate.blocked;
      request.title=sourceGate.blocked?sourceGate.reasons.join(' · '):'';
    }
  }
  function commitPromptEditor(record=currentPromptRecord()){
   const editor=$('aiPrompt');
    if(!record||!editor)return;
    const language=record.language||'ko',value=editor.value,changed=record.variants[language]!==value;
    if(!changed){syncDraftFromRecord(record);updatePromptCharacterCount(value);updateLanguageBar(record);return}
    record.variants[language]=value;
    if(language==='ko'){
      record.requestSource=value;
      record.status={ko:'waiting',en:'waiting',zh:'waiting'};
      record.translationSource=null;
      record.translationMeta=null;
      record.requestSha256=null;
      record.jobId=null;
      record.claimToken=null;
      record.jobState='IDLE';
      record.jobRevisionId=null;
      record.promptIr=null;
      record.workerStarted=false;
      record.workerStarting=false;
      record.error=null;
      // Editing only marks the bundle stale. Codex starts from the explicit
      // KO·EN·中文 generation action so opening or typing never mutates HAP.
    }else{
      record.status[language]='ready';
    }
    syncDraftFromRecord(record);
    updatePromptCharacterCount(value);
    updateLanguageBar(record);
  }
  function selectPromptLanguage(language){
    const record=currentPromptRecord();
    if(!record)return;
    commitPromptEditor(record);
    if(language!=='ko'&&!variantReady(record.status[language]))return;
    record.language=language;
    syncDraftFromRecord(record);
    renderScene();
  }
  function schedulePromptHandoff(record=currentPromptRecord(),options={}){
    if(!record||!seedanceSkillReady()||!record.requestSource.trim()||record.requestSource.startsWith('SKILL_GATE_BLOCKED'))return;
    const sourceGate=promptSourceGate();
    if(sourceGate.blocked){
      record.error=`E_PROMPT_SOURCE_GATE:${sourceGate.reasons.join('|')}`;
      record.status={ko:'error',en:'error',zh:'error'};
      updateLanguageBar(record);
      toast(`프롬프트 생성 차단 · ${sourceGate.reasons.join(' · ')}`);
      return;
    }
    if(!options.force&&handoffReady(record))return;
    clearTimeout(handoffTimer);
    handoffTimer=setTimeout(()=>syncPromptHandoff(record,options),options.immediate?0:250);
  }
  function startHandoffPolling(record=currentPromptRecord()){
    clearInterval(handoffPollTimer);
    if(!record||handoffReady(record))return;
    handoffPollTimer=setInterval(()=>{
      if(sceneTab!=='ready'||currentPromptRecord()!==record||handoffReady(record)){clearInterval(handoffPollTimer);return}
      schedulePromptHandoff(record,{force:true,immediate:true,startWorker:false});
    },2000);
  }
  async function startCodexPrompt(record){
    if(!record?.jobId||record.workerStarted||record.workerStarting||['READY','USER_APPROVED','UPLOAD_READY','REJECTED','FAILED','STALE','CANCELLED'].includes(record.jobState))return;
    record.workerStarting=true;
    try{
      const result=await window.sceneFlow.startCodexPrompt(selected.project,record.jobId,seedanceSkillProvenance());
      record.workerStarted=true;
      record.jobState=String(result?.state||'WRITING').toUpperCase();
      startHandoffPolling(record);
    }catch(error){
      record.workerStarting=false;
      record.error=String(error?.message||error);
      record.status={ko:'error',en:'error',zh:'error'};
      updateLanguageBar(record);
      return;
    }
    record.workerStarting=false;
    updateLanguageBar(record);
  }
  async function syncPromptHandoff(record,options={}){
    if(record.syncing)return;
    record.syncing=true;
    record.error=null;
    if(currentPromptRecord()===record)updateLanguageBar(record);
    try{
      const result=await window.sceneFlow.syncPromptHandoff({
        ...record.context,
        sourcePrompt:record.requestSource,
        protectedStrings:record.protectedStrings,
        skillProvenance:seedanceSkillProvenance(),
      });
      const job=result?.job||{};
      const state=String(job.effective_state||job.state||'QUEUED').toUpperCase();
      record.jobId=job.job_id||record.jobId;
      record.jobState=state;
      record.requestSha256=job.request_sha256||result.request_sha256||null;
      record.jobRevisionId=job.output_revision_id||null;
      if(result?.output?.prompt_variants&&Object.keys(result.output.prompt_variants).length===3&&['READY','USER_APPROVED','UPLOAD_READY'].includes(state)){
        record.variants={...result.output.prompt_variants};
        record.promptIr=result.output.prompt_ir||null;
        record.status={ko:'ready',en:'ready',zh:'ready'};
        record.translationSource=result.output.prompt_variants.ko;
        record.translationMeta={schema_version:3,delivery:'codex-to-filmmate-hap',request_sha256:record.requestSha256,source_sha256:null,skill_bundle_sha256:seedanceSkillPolicy.bundle_sha256,engine:job.engine||'Codex',created_at:job.updated_at||null,cached:false,validation:result.qa||null};
        record.error=null;
        if(currentPromptRecord()===record){record.syncing=false;syncDraftFromRecord(record);renderScene();toast('Codex가 KO · EN · 中文 프롬프트를 한 번에 전달했습니다')}
        return;
      }
      if(['REJECTED','FAILED','STALE','CANCELLED'].includes(state)){
        record.status={ko:'error',en:'error',zh:'error'};
        record.error=String(job.last_error||result.error||`Codex 작업 ${state}`);
      }else if(!handoffReady(record)){
        record.status={ko:state==='VALIDATING'?'checking':'waiting',en:'waiting',zh:'waiting'};
      }
      if(options.startWorker!==false&&!['READY','USER_APPROVED','UPLOAD_READY','REJECTED','FAILED','STALE','CANCELLED'].includes(state))await startCodexPrompt(record);
    }catch(error){
      record.status={ko:'error',en:'error',zh:'error'};
      record.error=String(error?.message||error);
    }finally{
      record.syncing=false;
      if(currentPromptRecord()===record){syncDraftFromRecord(record);updateLanguageBar(record)}
    }
  }

  const promptLibraryViewBeforeLanguages=promptLibraryView;
  promptLibraryView=(canonical)=>{
    let record=currentPromptRecord();
    if(!record&&aiDraft.prompt)record=ensurePromptRecord(aiDraft.prompt);
    if(record)syncDraftFromRecord(record);
    const html=promptLibraryViewBeforeLanguages(canonical);
    return html.replace('<div class="field"><textarea id="aiPrompt"',`${languageBarView(record)}<div class="field"><textarea id="aiPrompt"`);
  };

  const languageNormalization={
    en:[
      ['— TOOL SETTINGS —','— 도구 설정 —'],['— REFERENCE ROLES —','— 레퍼런스 역할 —'],['— CANON AND CONTINUITY LOCKS —','— 정본·연속성 잠금 —'],['— EXECUTION RULES —','— 실행 규칙 —'],['— HARD TIMELINE —','— 하드 타임라인 —'],['— SHARED AUDIO AND TEXT LOCKS —','— 사운드·텍스트 공통 잠금 —'],['— CORE PROHIBITIONS —','— 핵심 금지 —'],['— STORYBOARD PRESERVATION RESULT —','— 콘티 반영 결과 —'],['— LIVE-ACTION COLOR BASE —','— 실사 컬러 베이스 —'],
      ['Performance and expression (observable direction):','표정·연기(관찰 가능한 지시):'],['Continuity anchor:','연속성 앵커:'],['Central action:','중심 행동:'],['Camera:','카메라:'],['Recovery state:','회복 상태:'],['End state:','엔드스테이트:'],['do not replay it as a new event','재실행하지 않는다'],['restrained natural saturation','절제된 자연 채도'],['automatic smile','자동 미소'],['expression loop','표정 루프'],['mechanical lip-sync','기계적인 립싱크'],['Action goal:','행동 목표:'],['Subtext:','서브텍스트:'],['Trigger:','트리거:'],['Surface tactic:','표면 전술:'],
    ],
    zh:[
      ['— 工具设置 —','— 도구 설정 —'],['— 参考素材角色 —','— 레퍼런스 역할 —'],['— 正本与连续性锁定 —','— 정본·연속성 잠금 —'],['— 执行规则 —','— 실행 규칙 —'],['— 硬时间线 —','— 하드 타임라인 —'],['— 音频与文本通用锁定 —','— 사운드·텍스트 공통 잠금 —'],['— 核心禁止项 —','— 핵심 금지 —'],['— 分镜保留结果 —','— 콘티 반영 결과 —'],['— 实拍色彩基底 —','— 실사 컬러 베이스 —'],
      ['表演与表情（可观察指示）：','표정·연기(관찰 가능한 지시):'],['连续性锚点：','연속성 앵커:'],['中心动作：','중심 행동:'],['摄影机：','카메라:'],['恢复状态：','회복 상태:'],['结束状态：','엔드스테이트:'],['不得作为新事件重新执行','재실행하지 않는다'],['克制的自然饱和度','절제된 자연 채도'],['自动微笑','자동 미소'],['表情循环','표정 루프'],['机械式口型同步','기계적인 립싱크'],['动作目标：','행동 목표:'],['潜台词：','서브텍스트:'],['触发点：','트리거:'],['表层策略：','표면 전술:'],
    ],
  };
  function normalizePromptForQa(prompt,language){
    let normalized=String(prompt||'');
    for(const [translated,korean] of languageNormalization[language]||[])normalized=normalized.split(translated).join(korean);
    return normalized;
  }
  function addLanguageQa(qa,prompt){
    const {language,record}=currentLanguageForPrompt(prompt),activeReady=Boolean(record&&record.status[language]==='ready'),allReady=handoffReady(record);
    qa.checks.push(qaCheck('PROMPT_LANGUAGE_VARIANT','선택 언어 프롬프트',activeReady?'PASS':'FAIL',activeReady?`${LANGUAGES[language].label} 구조 검사 대상`:`${LANGUAGES[language].label} Codex 전달본이 없음`));
    qa.checks.push(qaCheck('PROMPT_LANGUAGE_SET','Codex 3개 언어 일괄 전달',allReady?'PASS':'FAIL',allReady?'Codex가 한국어·영어·중국어를 같은 요청으로 전달했고 잠금 검사를 통과함':'Codex의 KO·EN·中文 전체 묶음 전달이 필요함'));
    qa.status=qa.checks.some(check=>check.status==='FAIL')?'FAIL':qa.checks.some(check=>check.status==='WARN')?'WARN':'PASS';
    qa.counts={pass:qa.checks.filter(check=>check.status==='PASS').length,warn:qa.checks.filter(check=>check.status==='WARN').length,fail:qa.checks.filter(check=>check.status==='FAIL').length};
    qa.language={selected:language,label:LANGUAGES[language].label,all_ready:allReady,status:record?{...record.status}:{ko:'ready',en:'missing',zh:'missing'},translation_meta:record?.translationMeta||null};
    return qa;
  }
  const scanSeedanceBlockBeforeLanguages=scanSeedanceBlock;
  scanSeedanceBlock=(block,prompt=String(aiDraft.prompt||''),items=packageDisplayItems())=>{
    const {language}=currentLanguageForPrompt(prompt);
    return addLanguageQa(scanSeedanceBlockBeforeLanguages(block,normalizePromptForQa(prompt,language),items),prompt);
  };
  const scanSingleShotPromptBeforeLanguages=scanSingleShotPrompt;
  scanSingleShotPrompt=(prompt=String(aiDraft.prompt||''),items=packageDisplayItems())=>{
    const {language}=currentLanguageForPrompt(prompt);
    return addLanguageQa(scanSingleShotPromptBeforeLanguages(normalizePromptForQa(prompt,language),items),prompt);
  };

  const buildUploadPackConfigBeforeLanguages=buildUploadPackConfig;
  buildUploadPackConfig=()=>{
    const current=currentPromptRecord(),config=buildUploadPackConfigBeforeLanguages();
    config.blocks=(config.blocks||[]).map(block=>{
      const key=promptContextKey({model:config.model,unitType:'block',targetId:block.blockId,items:block.items}),record=promptLanguageRecords.get(key)||recordForPrompt(block.prompt);
      return record?{...block,...serializePromptRecord(record)}:block;
    });
    config.prompt_languages={schema_version:1,languages:['ko','en','zh'],delivery_mode:'codex_to_filmmate_bundle_handoff'};
    if(current)syncDraftFromRecord(current);
    return config;
  };

  const bindAiControlsBeforeLanguages=bindAiControls;
  bindAiControls=()=>{
    bindAiControlsBeforeLanguages();
    const record=currentPromptRecord(),editor=$('aiPrompt');
    if(!record||!editor)return;
    editor.addEventListener('input',()=>commitPromptEditor(record));
    document.querySelectorAll('[data-prompt-language]').forEach(button=>button.onclick=()=>selectPromptLanguage(button.dataset.promptLanguage));
    const refresh=$('refreshPromptLanguages');
    if(refresh)refresh.onclick=()=>{
      commitPromptEditor(record);
      if(!record.jobId){toast('먼저 KO·EN·中文 생성을 시작하세요');return}
      schedulePromptHandoff(record,{force:true,immediate:true,startWorker:false});
    };
    const request=$('requestCodexPrompt');
    if(request)request.onclick=()=>{
      commitPromptEditor(record);
      record.workerStarted=false;
      record.workerStarting=false;
      schedulePromptHandoff(record,{force:true,immediate:true,startWorker:true});
    };
    const approve=$('approvePromptJob');
    if(approve)approve.onclick=async()=>{
      try{
        const result=await window.sceneFlow.approvePromptJob(selected.project,record.jobId,'FilmMate UI: 현재 KO·EN·中文 묶음 승인');
        record.jobState=String(result?.job?.effective_state||result?.job?.state||'USER_APPROVED').toUpperCase();
        record.status={ko:'approved',en:'approved',zh:'approved'};
        renderScene();
        toast('현재 프롬프트 묶음을 정본으로 승인했습니다');
      }catch(error){toast(`승인 차단 · ${error?.message||error}`)}
    };
    updateLanguageBar(record);
    if(record.jobId&&!['READY','USER_APPROVED','UPLOAD_READY','REJECTED','FAILED','STALE','CANCELLED'].includes(record.jobState))startHandoffPolling(record);
  };

  globalThis.filmMatePromptLanguages={
    records:promptLanguageRecords,
    current:currentPromptRecord,
    schedule:schedulePromptHandoff,
    sync:syncPromptHandoff,
    normalizePromptForQa,
    serializePromptRecord,
  };
})();
