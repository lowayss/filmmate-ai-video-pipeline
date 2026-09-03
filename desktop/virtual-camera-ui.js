(() => {
  const bridge = window.virtualCamera;
  if (!bridge) return;

  const state = {
    status:{active:false,recording:false},
    takes:[],
    lastSample:null,
    latestTake:null,
    loading:false,
  };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  const currentTarget = () => {
    try {
      if (typeof selected === "undefined" || !selected) return null;
      return {project:selected.project, scene:sceneId(selected), sceneId:selected.scene_id};
    } catch { return null; }
  };
  const shots = () => {
    try { return Array.isArray(detail?.conhap?.shots) ? detail.conhap.shots : []; }
    catch { return []; }
  };

  function installTab() {
    const tabs = document.querySelector(".scene-tabs");
    if (!tabs || tabs.querySelector("[data-virtual-camera-tab]")) return;
    const button = document.createElement("button");
    button.className = "scene-tab vcam-tab";
    button.dataset.virtualCameraTab = "true";
    button.textContent = "가상 카메라";
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      tabs.querySelectorAll(".scene-tab").forEach(tab => tab.classList.remove("active"));
      button.classList.add("active");
      renderPanel();
    };
    tabs.appendChild(button);
  }

  function motionReadout(sample) {
    const orientation = sample?.orientation || {};
    const value = axis => Number(orientation[axis] || 0).toFixed(1) + "°";
    const map = {pan:"alpha",tilt:"beta",roll:"gamma"};
    for (const [id, axis] of Object.entries(map)) {
      const node = document.getElementById(`vcam-${id}`);
      if (node) node.textContent = value(axis);
    }
    const sampleNode = document.getElementById("vcam-live-samples");
    if (sampleNode && state.status.recording) sampleNode.textContent = String(state.status.sample_count || 0);
  }

  function sessionMatchesTarget() {
    const target = currentTarget();
    const status = state.status || {};
    return Boolean(target && status.active && status.project === target.project && status.scene === target.scene);
  }

  function connectionCard() {
    const status = state.status || {};
    const current = sessionMatchesTarget();
    const url = current ? (status.primary_url || "") : "";
    const secureNote = current && status.sensor_secure_context_required
      ? `<div class="vcam-note">휴대폰 브라우저의 자이로/가속도 센서는 HTTPS 보안 컨텍스트를 요구할 수 있습니다. LAN HTTP에서는 수동 PAN/TILT/ROLL 컨트롤을 함께 제공합니다.</div>`
      : "";
    return `<section class="vcam-card vcam-connect">
      <div class="vcam-card-head"><div><span class="vcam-kicker">PHONE CONTROLLER</span><h2>스마트폰 연결</h2></div><span class="vcam-status ${current ? "on" : ""}">${current ? "SESSION ON" : status.active ? "OTHER SCENE" : "OFFLINE"}</span></div>
      ${current ? `<div class="vcam-url"><code>${escapeHtml(url)}</code><button class="btn" id="vcam-copy-url">링크 복사</button></div><div class="vcam-small">같은 Wi-Fi의 스마트폰에서 링크를 열면 컨트롤러가 실행됩니다.</div>${secureNote}<button class="btn danger" id="vcam-stop-session">세션 종료</button>` : `<p class="muted">${status.active ? "다른 씬의 VCAM 세션이 실행 중입니다. 시작하면 현재 씬으로 전환됩니다." : "현재 씬 전용 로컬 컨트롤러를 시작합니다. 기존 HAP 정본은 수정하지 않습니다."}</p><button class="btn primary" id="vcam-start-session">${status.active ? "현재 씬으로 세션 전환" : "모바일 카메라 세션 시작"}</button>`}
    </section>`;
  }

  function captureCard() {
    const status = state.status || {};
    const sessionReady = sessionMatchesTarget();
    const shotOptions = shots();
    const options = shotOptions.length
      ? shotOptions.map((shot, index) => `<option value="${escapeHtml(shot.id || `C${String(index + 1).padStart(2,"0")}`)}">${escapeHtml(shot.id || `C${String(index + 1).padStart(2,"0")}`)} · ${escapeHtml(shot.shot_intent || shot.new_information || "shot")}</option>`).join("")
      : `<option value="C01">C01</option>`;
    return `<section class="vcam-card">
      <div class="vcam-card-head"><div><span class="vcam-kicker">TAKE RECORDER</span><h2>카메라 Take</h2></div><span class="vcam-rec ${status.recording ? "on" : ""}">${status.recording ? "● REC" : "READY"}</span></div>
      <div class="vcam-controls"><label>Shot<select id="vcam-shot" ${status.recording ? "disabled" : ""}>${options}</select></label><label>Stabilization<select id="vcam-preset" ${status.recording ? "disabled" : ""}><option>CINEMA</option><option>HANDHELD</option><option>SMOOTH</option><option>GIMBAL</option><option>RAW</option></select></label></div>
      <div class="vcam-monitor"><div class="vcam-reticle"><span>VIRTUAL CAMERA</span></div><div class="vcam-readouts"><div><small>PAN</small><b id="vcam-pan">0.0°</b></div><div><small>TILT</small><b id="vcam-tilt">0.0°</b></div><div><small>ROLL</small><b id="vcam-roll">0.0°</b></div><div><small>SAMPLES</small><b id="vcam-live-samples">${status.sample_count || 0}</b></div></div></div>
      <div class="vcam-actions"><button class="btn vcam-record" id="vcam-record" ${!sessionReady || status.recording ? "disabled" : ""}>● REC TAKE</button><button class="btn" id="vcam-stop-record" ${!status.recording ? "disabled" : ""}>STOP & SAVE</button></div>
    </section>`;
  }

  function latestTakeCard() {
    const take = state.latestTake;
    if (!take) return "";
    const analysis = take.analysis || {};
    return `<section class="vcam-card vcam-analysis"><div class="vcam-card-head"><div><span class="vcam-kicker">MOTION ANALYSIS</span><h2>${escapeHtml(take.shot_id)} · TAKE ${String(take.take_number).padStart(2,"0")}</h2></div><span class="vcam-status on">SAVED</span></div><div class="vcam-motion-tags">${(analysis.moves || []).map(move => `<span>${escapeHtml(move)}</span>`).join("") || "<span>locked-off</span>"}</div><label class="vcam-prompt-label">AI 카메라 프롬프트</label><div class="vcam-prompt">${escapeHtml(analysis.prompt || "")}</div><div class="vcam-small">회전/손떨림은 센서로 분석합니다. 정확한 XYZ 이동거리는 비주얼-관성 포즈 추적 전에는 추정하지 않습니다.</div><button class="btn" id="vcam-copy-prompt">프롬프트 복사</button></section>`;
  }

  function takesCard() {
    return `<section class="vcam-card"><div class="vcam-card-head"><div><span class="vcam-kicker">TAKES</span><h2>저장된 Take</h2></div><button class="btn" id="vcam-open-folder">폴더 열기</button></div><div class="vcam-take-list">${state.takes.length ? state.takes.map(take => `<div class="vcam-take ${take.selected ? "selected" : ""}"><div><b>${escapeHtml(take.shot_id)} · TAKE ${String(take.take_number).padStart(2,"0")}${take.selected ? " ★" : ""}</b><small>${escapeHtml(take.preset || "CINEMA")} · ${take.sample_count || 0} samples · ${escapeHtml(take.analysis?.dominant_move || "locked-off")}</small></div><button class="btn" data-vcam-select="${escapeHtml(take.shot_id)}" data-vcam-take="${take.take_number}" ${take.selected ? "disabled" : ""}>${take.selected ? "선택됨" : "이 Take 선택"}</button></div>`).join("") : `<div class="vcam-empty">아직 저장된 Take가 없습니다.</div>`}</div></section>`;
  }

  function renderPanel() {
    const content = document.querySelector(".scene-page .content");
    if (!content) return;
    content.innerHTML = `<div class="vcam-shell"><div class="vcam-intro"><div><span class="vcam-kicker">VIRTUAL CAMERA</span><h2>휴대폰으로 카메라 움직임을 연기하고 기록합니다</h2><p class="muted">씬별 Take를 작업용 preview로 저장하고, Pan/Tilt/Roll 움직임을 AI 영상용 카메라 문장으로 변환합니다.</p></div></div><div class="vcam-grid">${connectionCard()}${captureCard()}</div>${latestTakeCard()}${takesCard()}</div>`;
    bindPanel();
    motionReadout(state.lastSample);
  }

  async function refreshTakes() {
    const target = currentTarget();
    if (!target) return;
    try { state.takes = await bridge.listTakes(target.project, target.scene); }
    catch { state.takes = []; }
  }

  async function refreshStatus() {
    try { state.status = await bridge.status(); }
    catch { state.status = {active:false,recording:false}; }
  }

  function panelVisible() { return Boolean(document.querySelector("[data-virtual-camera-tab].active")); }

  function showError(error) {
    const shell = document.querySelector(".vcam-shell");
    if (!shell) return;
    let notice = shell.querySelector(".vcam-error");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "vcam-error";
      shell.prepend(notice);
    }
    notice.textContent = error?.message || String(error);
  }

  function bindPanel() {
    const target = currentTarget();
    document.getElementById("vcam-start-session")?.addEventListener("click", async () => {
      if (!target) return showError(new Error("씬 대상 정보를 찾지 못했습니다."));
      try { state.status = await bridge.startSession(target.project, target.scene); await refreshTakes(); renderPanel(); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-stop-session")?.addEventListener("click", async () => {
      try { state.status = await bridge.stopSession(); renderPanel(); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-copy-url")?.addEventListener("click", async () => {
      try { await bridge.copyText(state.status.primary_url || ""); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-record")?.addEventListener("click", async () => {
      const shotId = document.getElementById("vcam-shot")?.value || "C01";
      const preset = document.getElementById("vcam-preset")?.value || "CINEMA";
      try { state.status = await bridge.startRecording({shotId,preset}); renderPanel(); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-stop-record")?.addEventListener("click", async () => {
      try { state.latestTake = await bridge.stopRecording(); await refreshStatus(); await refreshTakes(); renderPanel(); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-copy-prompt")?.addEventListener("click", async () => {
      try { await bridge.copyText(state.latestTake?.analysis?.prompt || ""); }
      catch (error) { showError(error); }
    });
    document.getElementById("vcam-open-folder")?.addEventListener("click", async () => {
      if (!target) return;
      try { await bridge.openFolder(target.project, target.scene); }
      catch (error) { showError(error); }
    });
    document.querySelectorAll("[data-vcam-select]").forEach(button => button.addEventListener("click", async () => {
      if (!target) return;
      try { await bridge.selectTake(target.project, target.scene, button.dataset.vcamSelect, Number(button.dataset.vcamTake)); await refreshTakes(); renderPanel(); }
      catch (error) { showError(error); }
    }));
  }

  bridge.onSample(sample => {
    state.lastSample = sample;
    if (state.status.recording) state.status.sample_count = (state.status.sample_count || 0) + 1;
    motionReadout(sample);
  });
  bridge.onStatus(status => {
    state.status = status || {active:false,recording:false};
    if (panelVisible()) renderPanel();
  });
  bridge.onTake(async take => {
    state.latestTake = take;
    await refreshTakes();
    if (panelVisible()) renderPanel();
  });

  const observer = new MutationObserver(() => installTab());
  observer.observe(document.documentElement, {childList:true,subtree:true});
  installTab();
  refreshStatus();
})();
