(() => {
  const bridge = window.virtualCamera;
  if (!bridge) return;
  let status = {active:false};
  let pose = null;
  let latestTake = null;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

  function isVcamVisible() {
    return Boolean(document.querySelector("[data-virtual-camera-tab].active") && document.querySelector(".vcam-shell"));
  }

  function pairingMarkup() {
    if (!status?.active) return "";
    const tls = Boolean(status.tls_available && status.secure_primary_url);
    return `<section class="vcam-v2-panel" data-vcam-pose-pairing><div class="vcam-v2-head"><div><span>PAIRING V2</span><b>QR + ${tls ? "HTTPS SENSOR" : "MANUAL FALLBACK"}</b></div><em>${tls ? "TLS READY" : "NO TLS"}</em></div><div class="vcam-v2-pair-grid"><div class="vcam-v2-qr">${status.qr_data_url ? `<img src="${esc(status.qr_data_url)}" alt="FilmMate VCAM QR"><small>같은 Wi-Fi에서 스캔</small>` : `<small>QR을 만들 수 없습니다.</small>`}</div><div class="vcam-v2-copy"><label>페어링 링크</label><div><code>${esc(status.primary_url || "")}</code><button class="btn" data-vcam-copy-pair>복사</button></div>${tls ? `<label>HTTPS 센서 링크</label><div><code>${esc(status.secure_primary_url)}</code><button class="btn" data-vcam-copy-secure>복사</button></div><small>휴대폰에서 QR을 연 뒤 최초 HTTPS 설정 안내를 따라 센서 컨트롤러로 이동합니다.</small><small class="vcam-v2-fingerprint">CA SHA-256 · ${esc(status.ca_fingerprint_sha256 || "—")}</small>` : `<small>${esc(status.tls_error || "HTTPS를 사용할 수 없어 수동 회전 컨트롤을 유지합니다.")}</small>`}</div></div></section>`;
  }

  function poseMarkup() {
    const position = pose?.relative_position || {};
    return `<section class="vcam-v2-panel" data-vcam-pose-live><div class="vcam-v2-head"><div><span>RELATIVE 3D POSE</span><b>Dolly / Truck / Pedestal</b></div><em data-vcam-pose-confidence>${esc(String(pose?.confidence || "—").toUpperCase())}</em></div><div class="vcam-v2-readouts"><div><small>TRUCK X</small><b data-vcam-x>${Number(position.x || 0).toFixed(3)}</b></div><div><small>PEDESTAL Y</small><b data-vcam-y>${Number(position.y || 0).toFixed(3)}</b></div><div><small>DOLLY Z</small><b data-vcam-z>${Number(position.z || 0).toFixed(3)}</b></div><div><small>SCALE</small><b>RELATIVE</b></div></div><canvas data-vcam-pose-canvas width="720" height="250"></canvas><small class="vcam-v2-disclaimer">가속도 기반 상대 이동 의도입니다. 실제 미터 단위 거리로 해석하지 않습니다.</small></section>`;
  }

  function drawPose() {
    const canvas = document.querySelector("[data-vcam-pose-canvas]");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width, height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0a0d0f";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#29323a";
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i += 1) { const x = width * i / 8; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let i = 1; i < 4; i += 1) { const y = height * i / 4; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    const trajectory = pose?.trajectory || [];
    if (!trajectory.length) {
      ctx.fillStyle = "#7f8a96";
      ctx.font = "13px system-ui";
      ctx.fillText("REC 후 휴대폰을 움직이면 상대 3D 궤적이 표시됩니다.", 20, height / 2);
      return;
    }
    const maxAbs = Math.max(0.06, ...trajectory.flatMap(point => [Math.abs(Number(point.x)||0), Math.abs(Number(point.y)||0), Math.abs(Number(point.z)||0)]));
    const scale = Math.min(width, height) * 0.37 / maxAbs;
    const project = point => ({x:width/2 + ((Number(point.x)||0) + (Number(point.z)||0)*0.45)*scale, y:height/2 - (Number(point.y)||0)*scale + (Number(point.z)||0)*0.22*scale});
    ctx.strokeStyle = "#b9ff55";
    ctx.lineWidth = 3;
    ctx.beginPath();
    trajectory.forEach((point, index) => { const p = project(point); if (!index) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y); });
    ctx.stroke();
    const last = project(trajectory[trajectory.length - 1]);
    ctx.fillStyle = "#b9ff55";
    ctx.beginPath(); ctx.arc(last.x, last.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#9da8b4";
    ctx.font = "11px ui-monospace,monospace";
    ctx.fillText("X TRUCK · Y PEDESTAL · Z DOLLY", 12, 18);
    ctx.fillText("RELATIVE / NON-METRIC", width - 155, 18);
  }

  function updatePoseReadouts() {
    const p = pose?.relative_position || {};
    const set = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
    set("[data-vcam-x]", Number(p.x || 0).toFixed(3));
    set("[data-vcam-y]", Number(p.y || 0).toFixed(3));
    set("[data-vcam-z]", Number(p.z || 0).toFixed(3));
    set("[data-vcam-pose-confidence]", String(pose?.confidence || "—").toUpperCase());
    drawPose();
  }

  function enhance() {
    if (!isVcamVisible()) return;
    const shell = document.querySelector(".vcam-shell");
    if (!shell) return;
    const connect = shell.querySelector(".vcam-connect");
    if (connect && status?.active) {
      connect.querySelector("[data-vcam-pose-pairing]")?.remove();
      connect.insertAdjacentHTML("beforeend", pairingMarkup());
      connect.querySelector("[data-vcam-copy-pair]")?.addEventListener("click", () => bridge.copyText(status.primary_url || ""));
      connect.querySelector("[data-vcam-copy-secure]")?.addEventListener("click", () => bridge.copyText(status.secure_primary_url || ""));
    }
    if (!shell.querySelector("[data-vcam-pose-live]")) {
      const grid = shell.querySelector(".vcam-grid");
      if (grid) grid.insertAdjacentHTML("afterend", poseMarkup());
    }
    updatePoseReadouts();
  }

  async function refresh() {
    try { status = await bridge.status(); if (status?.live_pose) pose = status.live_pose; }
    catch { status = {active:false}; }
    enhance();
  }

  bridge.onSample(sample => {
    if (sample?.pose_preview) pose = sample.pose_preview;
    updatePoseReadouts();
  });
  bridge.onStatus(next => { status = next || {active:false}; if (next?.live_pose) pose = next.live_pose; enhance(); });
  bridge.onTake(take => { latestTake = take; pose = take?.analysis?.relative_translation || pose; enhance(); });

  const observer = new MutationObserver(() => enhance());
  observer.observe(document.documentElement, {childList:true, subtree:true});
  refresh();
})();
