// Seedance performance compiler.
// The performance card is internal directing data. It is compiled into
// observable model-facing instructions and never wraps/replaces the prompt
// builder by itself.
(function(global){
  'use strict';

  const modoriByShot={
    C01:{goal:'기억을 설명하지 않고 샌드의 모서리를 먼저 관찰한다',subtext:'두 사람 사이의 가까움을 말로 드러내지 않는다',trigger:'장면 시작과 샌드의 공유 상태',target:'샌드에서 서로의 얼굴로 짧게 이동하는 시선',tactic:'관찰을 숨긴 채 평상 상태를 유지한다',fac:'AU 없음에 가까운 기준 상태. 눈썹·입술·턱을 과장하지 않는다.',visible:'지훈의 시선이 샌드 모서리에 먼저 머물고 수연의 얼굴을 짧게 본 뒤 다시 샌드로 돌아온다. 눈썹·입술·턱은 거의 움직이지 않는다.',body:'짧고 고른 호흡, 어깨와 손은 안정적이다',recovery:'샌드와 상대 사이의 중립적인 시선으로 돌아간다',faceCritical:true},
    C02:{goal:'깨끗한 모서리를 내밀어 지훈을 안심시킨다',subtext:'아무렇지 않은 척하지만 지훈의 반응을 확인한다',trigger:'수연이 지훈 쪽으로 모서리를 돌려 내미는 순간',target:'지훈 얼굴과 자신이 내민 샌드 모서리',tactic:'가벼운 설명으로 긴장을 낮춘다',fac:'AU12 약함. 입꼬리가 아주 조금만 올라가고 AU6은 거의 동반하지 않는다. 눈가는 크게 바뀌지 않는다.',visible:'수연은 깨끗한 모서리를 지훈 쪽으로 내밀고, 입꼬리만 아주 조금 올린다. 눈가는 크게 변하지 않는다.',body:'대사 직전에 짧은 들숨, 샌드를 내민 손은 일정한 속도를 유지한다',recovery:'대사 뒤 시선이 샌드로 내려가고 표정은 평상 상태에 가까워진다',faceCritical:true},
    C03:{goal:'질문을 피하면서 수연의 자국과 거리를 둔다',subtext:'가까워지고 싶지만 그 흔적을 바로 마주하는 것은 피한다',trigger:'수연이 작은 한입을 지적하는 말',target:'샌드 모서리→수연 얼굴→다시 샌드',tactic:'확인하는 척하며 회피한다',fac:'AU7 약함이 먼저 onset되고 AU24처럼 입술이 아주 짧게 눌린다. 큰 놀람이나 자동 미소는 없다.',visible:'지훈은 모서리를 확인하는 동안 시선을 잠깐 멈추고, 입술을 아주 짧게 누른 뒤 작은 한입을 문다. 큰 놀람이나 미소는 없다.',body:'시선이 멈춘 뒤 짧은 호흡 정지, 손가락은 포장지를 한 번만 더 움직인다',recovery:'대사가 끝나면 입술 긴장이 풀리고 시선은 샌드에 남는다',faceCritical:true},
    C04:{goal:'핑계를 유지하며 수연의 자국에서 먼 모서리를 찾는다',subtext:'말은 가볍게 하지만 행동은 접촉을 피한다',trigger:'배가 안 고프다는 말과 이어지는 수연의 반박',target:'수연 얼굴→손끝의 샌드 회전→먼 모서리',tactic:'말장난으로 실제 회피를 가린다',fac:'AU4가 아주 약하게 onset되고 AU7이 미세하게 유지된다. 입술은 대사 중 중립에 가깝고 눈썹·입·고개를 동시에 키우지 않는다.',visible:'지훈은 수연의 얼굴을 잠깐 본 뒤 손끝으로 샌드를 한 번 돌려 자국에서 먼 모서리를 찾는다. 미간과 눈꺼풀이 미세하게 긴장했다가 풀린다.',body:'수연의 웃음 뒤 짧게 날숨하고 손끝으로 샌드를 한 번만 돌린다',recovery:'먼 모서리를 찾은 뒤 미간과 눈꺼풀 긴장이 서서히 풀린다',faceCritical:true},
    C05:{goal:'체육대회 이야기를 농담의 리듬으로 이어간다',subtext:'샌드의 교환이 두 사람의 안전한 대화가 된다',trigger:'서로 한입씩 먹으며 대화를 시작하는 순간',target:'말하는 상대와 손에서 손으로 이동하는 샌드',tactic:'가벼운 농담으로 친밀함을 숨긴다',fac:'AU12 약함, AU6은 거의 없음. 입꼬리만 작게 움직이고 눈가는 과장하지 않는다.',visible:'둘은 대사와 샌드의 왕복을 따라 짧게 웃지만 미소를 고정하지 않는다. 시선이 말하는 상대와 손 사이를 자연스럽게 이동한다.',body:'대사 사이 짧은 쉼과 자연스러운 깜빡임, 샌드가 넘어갈 때 시선이 손을 따라간다',recovery:'농담이 끝나도 미소를 고정하지 않고 상대와 샌드 사이로 돌아간다',faceCritical:true},
    C06:{goal:'걱정을 직접 고백하지 않고 샌드를 내민다',subtext:'말보다 행동으로 상대를 붙잡아 두고 싶다',trigger:'수연이 계주에 나간다고 말하고 마지막 말을 건네는 순간',target:'수연의 얼굴→지훈 손의 샌드→수연의 손',tactic:'장난스러운 말 뒤 손을 먼저 내민다',fac:'AU12 한쪽이 아주 약하게 먼저 나타난다. AU6은 거의 없고, 눈썹을 치켜올리는 놀람은 만들지 않는다.',visible:'지훈은 마지막 대사 뒤 짧게 숨을 내쉬고 얼굴보다 손이 먼저 움직여 샌드를 수연에게 내민다. 눈썹을 크게 올리지 않는다.',body:'마지막 대사 뒤 짧은 날숨, 손이 먼저 움직이고 얼굴은 한 박자 늦게 따라간다',recovery:'샌드를 내민 뒤 시선은 수연에게 돌아오되 고정 응시는 하지 않는다',faceCritical:true},
    C07:{goal:'담임 흉내로 직접적인 감정을 공동의 웃음으로 바꾼다',subtext:'둘만 아는 농담 안에서 긴장을 안전하게 풀어낸다',trigger:'담임의 말버릇을 이어받고 상대의 반박을 듣는 순간',target:'서로의 흉내와 상대의 반응',tactic:'말투를 흉내 내며 웃음을 참다가 함께 푼다',fac:'AU12 약함이 대사 후 onset되고 AU6이 약하게 늦춰 따라온다. 웃음은 짧고 좌우가 완벽히 대칭이지 않다.',visible:'수연의 담임 흉내 뒤 지훈이 말투를 이어 받고, 대사가 끝난 뒤 입꼬리가 먼저 올라간다. 눈가가 조금 늦게 따라오며 짧게 웃는다.',body:'흉내 사이 호흡을 한 번 끊고, 웃음 직전 턱과 어깨를 크게 흔들지 않는다',recovery:'웃음 뒤 입술과 눈꺼풀이 서서히 평상 상태로 돌아간다',faceCritical:true},
    C08:{goal:'마지막 한입이 남았다는 물리적 상태를 보여준다',subtext:'얼굴 감정보다 소품의 소진과 끝의 도래가 먼저다',trigger:'웃음이 지나가고 포장지와 샌드의 상태가 변하는 순간',target:'샌드·포장지·지훈 손등',tactic:'얼굴 연기 대신 손과 소품으로 반응한다',fac:'얼굴이 핵심 프레임에 없으므로 FACS를 적용하지 않는다.',visible:'얼굴 연기를 추가하지 않는다. 손·포장지·샌드의 상태와 포장지 마찰만 이어간다.',body:'포장지 마찰과 매미 소리만 유지한다',recovery:'마지막 한입과 두 사람의 손 상태를 다음 컷으로 상속한다',faceCritical:false},
    C09:{goal:'마지막 몫을 손의 순서로 결정한다',subtext:'지훈은 작은 쪽을 고르는 선택으로 자기 몫을 줄인다',trigger:'수연이 샌드를 둘로 가르는 순간',target:'작은 조각과 지훈의 손',tactic:'망설이지 않은 척 손을 먼저 뻗는다',fac:'얼굴이 프레임 밖이므로 FACS를 적용하지 않는다.',visible:'얼굴 연기를 추가하지 않는다. 수연이 샌드를 둘로 가르고 지훈의 손이 작은 조각을 한 번에 집는 동작만 읽힌다.',body:'손의 움직임은 한 번에 이어지고 불필요한 고개 움직임을 만들지 않는다',recovery:'작은 조각을 집은 손과 수연의 잠깐의 시선을 다음 컷으로 넘긴다',faceCritical:false},
    C10:{goal:'지훈이 고른 작은 몫을 알아차리고 더 큰 몫으로 바꾼다',subtext:'배려를 설명하지 않고 손의 교환으로 실행한다',trigger:'지훈이 작은 조각을 집은 것을 수연이 보는 순간',target:'작은 조각→지훈 손→큰 조각',tactic:'말보다 손의 교환을 먼저 선택한다',fac:'AU1이 약하게 onset되어 판단의 순간만 보인다. 눈을 크게 뜨거나 놀란 표정을 만들지 않는다.',visible:'수연은 작은 조각을 본 뒤 짧게 들이쉬고, 작은 조각을 지훈 손에서 빼내 큰 조각을 놓는다. 눈을 크게 뜨지 않는다.',body:'짧은 들숨 뒤 작은 조각을 빼고 큰 조각을 같은 손바닥에 놓는다',recovery:'교환이 끝나면 시선은 큰 조각과 지훈에게 번갈아 머문다',faceCritical:true},
    C11:{goal:'작은 조각은 자신이 가져가고 지훈에게 큰 조각을 남긴다',subtext:'수연의 배려를 말이 아니라 몫의 선택으로 확정한다',trigger:'지훈 손바닥에 큰 조각만 남은 상태',target:'자기 손의 작은 조각과 지훈의 손바닥',tactic:'행동을 짧고 자연스럽게 끝낸다',fac:'AU7 약함으로 시선을 안정시키고, 입 주변을 과장하지 않는다.',visible:'수연은 자기 작은 조각과 지훈 손바닥을 한 번씩 확인하고, 입 주변은 중립에 가깝게 유지한다.',body:'작은 조각을 가져가는 손과 지훈 손바닥을 한 번씩 확인한다',recovery:'행동 뒤 시선은 지훈의 큰 조각으로 이동하고 다음 컷의 선택을 기다린다',faceCritical:true},
    C12:{goal:'이번에는 자국을 피하지 않고 한입을 선택한다',subtext:'회피를 멈추지만 감정을 얼굴로 설명하지 않는다',trigger:'수연이 작은 조각을 가져간 뒤 큰 조각의 자국이 남은 순간',target:'큰 조각의 자국과 손에 든 소품',tactic:'짧은 망설임 뒤 행동으로 답한다',fac:'AU7 약함이 먼저 나타나고 AU24가 아주 짧게 지나간다. 행동 직전 눈꺼풀 긴장이 정점에 도달한 뒤 풀린다. 과장된 미소는 금지한다.',visible:'지훈의 시선이 큰 조각의 자국에 먼저 고정되고, 눈꺼풀 긴장이 짧게 생긴 뒤 풀린다. 과장된 미소는 없다.',body:'짧은 호흡 정지 뒤 시선이 자국에 고정되고, 행동 후 숨을 내쉰다',recovery:'행동 뒤 얼굴은 즉시 웃음으로 리셋되지 않고 작은 잔여 긴장을 남긴다',faceCritical:true},
    C13:{goal:'방금의 선택을 설명하지 않고 함께 웃음으로 받아들인다',subtext:'관계의 변화는 고백이 아니라 서로의 반응으로 남는다',trigger:'수연이 지훈의 흔적과 입가의 크림을 보는 순간',target:'서로의 얼굴과 지훈 입가의 흔적',tactic:'수연이 먼저 반응하고 지훈이 늦게 따라간다',fac:'수연은 AU12 약함이 먼저 onset되고 AU6이 조금 늦게 동반된다. 지훈은 수연의 웃음을 본 뒤 AU12가 약하게 따라온다.',visible:'수연의 웃음이 먼저 시작되고 지훈이 한 박자 늦게 따라 웃는다. 웃음 뒤 표정과 호흡에 작은 잔여 반응을 남긴다.',body:'웃음 직전 짧은 들숨, 웃음 뒤 작은 날숨과 자연스러운 깜빡임',recovery:'완벽한 중립으로 리셋하지 않고 웃음의 잔여 반응을 둔 채 CUT TO BLACK',faceCritical:true}
  };

  function fallbackCue(shot){
    const camera=shot?.camera||{};
    const faceCritical=!['LS','ELS','WS'].includes(String(camera.shot_size||'').toUpperCase());
    return {goal:'정본에 지정된 중심 행동을 수행한다',subtext:'콘티에 없는 내면 동기나 감정을 추가하지 않는다',trigger:shot?.new_information||'정본에 지정된 사건',target:shot?.continuity?.gaze_target||'정본에 지정된 시선 대상',tactic:shot?.screen?.subject_action||shot?.shot_intent||'지정된 중심 행동을 수행한다',fac:faceCritical?'콘티에 명시된 관찰 가능한 얼굴 변화만 사용한다. AU를 추가로 발명하지 않는다.':'얼굴이 핵심 프레임에 없으므로 FACS를 적용하지 않는다.',visible:shot?.screen?.subject_action||shot?.shot_intent||'지정된 중심 행동만 화면에 보인다.',body:'호흡·손·고개 중 정본에 지정된 신호만 먼저 반응한다.',recovery:shot?.continuity?.state_out||'다음 엔드스테이트로 회복한다',faceCritical,expressionEvent:false};
  }
  function isModori(context){return String(context?.projectTitle||'')==='모서리'||String(context?.projectTitle||'').includes('모서리')}
  function cueFor(shot,context){const id=String(shot?.id||'');return isModori(context)?(modoriByShot[id]||fallbackCue(shot)):fallbackCue(shot)}
  function render(shot,context={}){
    const cue=cueFor(shot,context);
    if(cue.faceCritical===false)return `표정·연기(관찰 가능한 지시): ${cue.visible}\n몸·호흡: ${cue.body}\n회복 상태: ${cue.recovery}`;
    const hasExpressionEvent=cue.expressionEvent!==false&&!String(cue.fac||'').includes('AU 없음');
    const timing=!hasExpressionEvent?'정본에 표정 변화 사건이 없으므로 기준 상태를 유지한다. 임의의 onset·apex·offset을 만들지 않는다.':context.hasExactTiming?`기준 상태에서 ${context.start}에 작은 onset → ${context.apex}에 짧은 apex/유지 → ${context.offset}부터 offset → ${context.end}까지 회복한다.`:'기준 상태에서 시작한다. 컷별 정확한 초 단위 시각은 정본에 없으므로 사건 직후 낮은 강도로 onset하고, 짧게 유지한 뒤 offset한다. 정점 뒤 작은 잔여 반응을 남긴다.';
    const rawDialogue=shot?.audio?.dialogue&&shot.audio.dialogue!=='none'?shot.audio.dialogue:null;
    const speech=rawDialogue?'아래 대사·나레이션의 { } 원문에만 입 모양과 호흡을 맞춘다. 발화문을 이 연기 항목에서 반복하거나 바꾸지 않는다.':'대사 없음. 불필요한 입 움직임이나 새 발화를 만들지 않는다.';
    return `표정·연기(관찰 가능한 지시): ${cue.visible}\n시선·상대: ${cue.target}\n얼굴/FACS: ${cue.fac}\n강도·시간: ${timing}\n대사·발화 리듬: ${speech}\n몸·호흡: ${cue.body}\n회복 상태: ${cue.recovery}\n금지: 자동 미소·고정 응시·감정 급변·표정 루프·얼굴 변형·기계적인 립싱크.`;
  }
  global.filmMateSeedancePerformance={cueFor,render};
})(globalThis);
