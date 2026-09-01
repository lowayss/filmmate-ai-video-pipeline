const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SKILL_NAME = "seedance-prompt-rules";
const DEFAULT_SKILL_DIR = path.join(os.homedir(), ".codex", "skills", SKILL_NAME);
const REQUIRED_FILES = [
  "SKILL.md",
  "references/core-formula.md",
  "references/copy-ready-block.md",
  "references/long-video.md",
  "references/multi-reference.md",
  "references/audio-text.md",
  "references/live-action-color.md",
  "references/facs-expression.md",
  "references/qa-checklist.md",
];
const RULE_CONTRACTS = [
  {id:"WORKFLOW",file:"SKILL.md",markers:["시작 상태 → 중심 행동 → 카메라 → 엔드스테이트","공통 강제 게이트"]},
  {id:"NO_INVENTION",file:"SKILL.md",markers:["스토리·대사·포즈·카메라·소품·배경·사운드를 임의로 추가하지 않는다"]},
  {id:"ONE_ACTION_CAMERA",file:"SKILL.md",markers:["한 블록에는 중심 신체 행동 하나와 주된 카메라 행동 하나만 둔다"]},
  {id:"REFERENCE_ROLES",file:"references/core-formula.md",markers:["정의하는 속성","사용하지 않는 속성"]},
  {id:"COPY_STRUCTURE",file:"references/copy-ready-block.md",markers:["— REFERENCE DEFINITIONS —","— TECHNICAL BLOCK —"]},
  {id:"HARD_TIMELINE",file:"references/long-video.md",markers:["시간 구간은 연속·비중첩","콘티 반영 결과"]},
  {id:"MULTI_REFERENCE",file:"references/multi-reference.md",markers:["스토리보드 그리드는 샷 순서","선화 스타일과 패널 안의 문자는 사용하지 않는다"]},
  {id:"AUDIO_TEXT",file:"references/audio-text.md",markers:["`{ }`는 발화 의도나 요약을 표시하는 영역이 아니라 실제 발화 원문","샷 안에 넣고"]},
  {id:"LIVE_ACTION_COLOR",file:"references/live-action-color.md",markers:["채도는 절제하면서 색상 간 분리와 피부색을 보존","모션그래픽"]},
  {id:"FACS_PERFORMANCE",file:"references/facs-expression.md",markers:["AI 연기 방지 게이트","트리거 → AU + 자연어 얼굴 변화"]},
  {id:"FINAL_QA",file:"references/qa-checklist.md",markers:["씨댄스 통합 QA 체크리스트","검증하지 않은 품질·지원 범위·완료 상태"]},
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function loadSeedanceSkillPolicy(skillDir = DEFAULT_SKILL_DIR) {
  const contents = new Map();
  const files = [];
  const missing_files = [];
  let latestMtime = 0;
  const bundle = crypto.createHash("sha256");
  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.join(skillDir, relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      missing_files.push(relativePath);
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    const text = bytes.toString("utf8");
    const stat = fs.statSync(absolutePath);
    latestMtime = Math.max(latestMtime, stat.mtimeMs);
    contents.set(relativePath, text);
    bundle.update(relativePath).update("\0").update(bytes).update("\0");
    files.push({path:relativePath,sha256:sha256(bytes),size:bytes.length,mtime:new Date(stat.mtimeMs).toISOString()});
  }
  const rule_checks = RULE_CONTRACTS.map(contract => {
    const text = contents.get(contract.file) || "";
    const missing_markers = contract.markers.filter(marker => !text.includes(marker));
    return {id:contract.id,file:contract.file,status:missing_markers.length ? "FAIL" : "PASS",missing_markers};
  });
  const status = missing_files.length || rule_checks.some(check => check.status === "FAIL") ? "BLOCKED" : "READY";
  const bundle_sha256 = bundle.digest("hex");
  return {
    schema_version:1,
    name:SKILL_NAME,
    status,
    path:skillDir,
    bundle_sha256,
    short_hash:bundle_sha256.slice(0,12),
    required_file_count:REQUIRED_FILES.length,
    loaded_file_count:files.length,
    missing_files,
    files,
    rule_checks,
    checked_at:new Date().toISOString(),
    source_updated_at:latestMtime ? new Date(latestMtime).toISOString() : null,
  };
}

function bindingError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function assertSeedanceSkillBinding(provenance, skillDir = DEFAULT_SKILL_DIR) {
  const current = loadSeedanceSkillPolicy(skillDir);
  if (current.status !== "READY") throw bindingError("E_SEEDANCE_SKILL_REQUIRED", "seedance-prompt-rules 원본 또는 필수 규칙이 누락됨");
  if (!provenance || provenance.name !== SKILL_NAME || !provenance.bundle_sha256) throw bindingError("E_SEEDANCE_SKILL_PROVENANCE_REQUIRED", "프롬프트에 씨댄스 스킬 출처가 없음");
  if (provenance.bundle_sha256 !== current.bundle_sha256) throw bindingError("E_SEEDANCE_SKILL_STALE", "프롬프트 생성 후 seedance-prompt-rules가 변경됨");
  return current;
}

module.exports = {SKILL_NAME,DEFAULT_SKILL_DIR,REQUIRED_FILES,RULE_CONTRACTS,loadSeedanceSkillPolicy,assertSeedanceSkillBinding};
