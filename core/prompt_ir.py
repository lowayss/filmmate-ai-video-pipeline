#!/usr/bin/env python3
"""FilmMate Prompt IR v3 and deterministic Seedance bundle validation."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

try:
    from . import micro_shot
except ImportError:  # direct ``python core/prompt_ir.py`` compatibility
    import micro_shot


SCHEMA_VERSION = 3
LANGUAGES = ("ko", "en", "zh")
ALLOWED_SCOPES = {"shot", "cut", "block"}
ALLOWED_REFERENCE_ROLES = {
    "storyboard",
    "character",
    "background",
    "location",
    "prop",
    "continuity_frame",
    "motion",
    "camera",
    "audio",
}
SECTION_PROFILES = {
    "ko": {
        "required": ("— 도구 설정 —", "— 레퍼런스 역할 —", "— 정본·연속성 잠금 —", "— 실행 규칙 —", "— 하드 타임라인 —", "— 사운드·텍스트 공통 잠금 —", "— 핵심 금지 —", "— 콘티 반영 결과 —"),
        "action": "중심 행동:", "camera": "카메라:", "end": "엔드스테이트:",
    },
    "en": {
        "required": ("— TOOL SETTINGS —", "— REFERENCE ROLES —", "— CANON AND CONTINUITY LOCKS —", "— EXECUTION RULES —", "— HARD TIMELINE —", "— SHARED AUDIO AND TEXT LOCKS —", "— CORE PROHIBITIONS —", "— STORYBOARD PRESERVATION RESULT —"),
        "action": "Central action:", "camera": "Camera:", "end": "End state:",
    },
    "zh": {
        "required": ("— 工具设置 —", "— 参考素材角色 —", "— 正本与连续性锁定 —", "— 执行规则 —", "— 硬时间线 —", "— 音频与文本通用锁定 —", "— 核心禁止项 —", "— 分镜保留结果 —"),
        "action": "中心动作：", "camera": "摄影机：", "end": "结束状态：",
    },
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha_bytes(data: bytes):
    return hashlib.sha256(data).hexdigest()


def sha_text(value: str):
    return sha_bytes(str(value).encode("utf-8"))


def sha_file(path: Path):
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def ir_sha256(data):
    return sha_text(canonical(data))


def _protected_strings(source_prompt, provided=()):
    source = str(source_prompt or "")
    provided = provided if isinstance(provided, (list, tuple, set)) else ()
    patterns = (
        r"@(?:Image|Video|Audio)\s+\d+",
        r"CUT\s+[A-Za-z_-]*\d+[A-Za-z0-9_-]*",
        r"\{[^{}\n]*\}",
        r"<[^<>\n]*>",
        r"【[^】\n]*】",
    )
    values = [str(value).strip() for value in provided if str(value).strip()]
    for pattern in patterns:
        values.extend(re.findall(pattern, source))
    return sorted(set(values), key=lambda value: (-len(value), value))


def _timeline_id(segment):
    return str(segment.get("cut_id") or segment.get("id") or "").strip()


def _reference_tag(reference, index):
    return str(reference.get("tag") or f"@Image {index}")


def _strict_int(value):
    """Return True only for real ints, excluding bool (a Python int subclass)."""
    return type(value) is int


def expected_reference_tags(references):
    """Get the exact prompt tokens for references in their external order."""
    return [value[0] for value in micro_shot.expected_reference_values(references)]


def validate_ir(data, project_root: Path | None = None, request=None):
    if not isinstance(data, dict):
        return ["E_IR_DOCUMENT_INVALID"]
    request = request if isinstance(request, dict) else {}
    errors = []
    required = (
        "schema_version", "project_id", "scene_id", "scope", "target_id", "input_mode",
        "model_profile", "duration_ms", "references", "timeline",
        "global_locks", "negative_constraints", "source_map",
    )
    for key in required:
        if key not in data:
            errors.append(f"E_IR_FIELD_MISSING:{key}")
    if data.get("schema_version") != SCHEMA_VERSION:
        errors.append("E_IR_SCHEMA_VERSION")
    scope = data.get("scope")
    if scope not in ALLOWED_SCOPES:
        errors.append("E_IR_SCOPE_INVALID")
    effective_scope = "shot" if scope == "cut" else scope
    if data.get("input_mode") not in {"text_to_video", "reference_to_video"}:
        errors.append("E_IR_INPUT_MODE_INVALID")
    request_mode = request.get("input_mode") or ("reference_to_video" if request.get("references") else "text_to_video")
    if data.get("input_mode") != request_mode:
        errors.append("E_IR_INPUT_MODE_REQUEST_MISMATCH")
    duration = data.get("duration_ms")
    if not _strict_int(duration) or duration <= 0:
        errors.append("E_IR_DURATION_INVALID")
        duration = 0
    request_duration = request.get("duration_ms")
    if _strict_int(request_duration) and request_duration > 0 and duration != request_duration:
        errors.append(f"E_IR_DURATION_REQUEST_MISMATCH:{request_duration}:{duration}")
    profile = data.get("model_profile")
    if not isinstance(profile, dict) or not str(profile.get("name") or "").strip():
        errors.append("E_IR_MODEL_PROFILE_INVALID")
        profile = {}
    elif request.get("model") and profile.get("name") != request.get("model"):
        errors.append("E_IR_MODEL_MISMATCH")
    verified_max = profile.get("verified_max_duration_ms")
    if _strict_int(verified_max) and verified_max > 0 and duration > verified_max:
        errors.append("E_IR_VERIFIED_DURATION_LIMIT")

    expected_scope = request.get("unit_type")
    if expected_scope and effective_scope != expected_scope:
        errors.append("E_IR_SCOPE_REQUEST_MISMATCH")
    if request.get("target_id") and data.get("target_id") != request.get("target_id"):
        errors.append("E_IR_TARGET_REQUEST_MISMATCH")
    if request.get("project") and data.get("project_id") != request.get("project"):
        errors.append("E_IR_PROJECT_REQUEST_MISMATCH")
    if request.get("scene") and data.get("scene_id") != request.get("scene"):
        errors.append("E_IR_SCENE_REQUEST_MISMATCH")
    if request.get("workflow_mode") == micro_shot.WORKFLOW_MODE:
        errors.extend(micro_shot.micro_shot_issues(request))

    timeline = data.get("timeline")
    if not isinstance(timeline, list) or not timeline:
        errors.append("E_IR_TIMELINE_REQUIRED")
        timeline = []
    previous_end = 0
    actual_cut_ids = []
    for index, segment in enumerate(timeline):
        if not isinstance(segment, dict):
            errors.append(f"E_IR_SEGMENT_INVALID:{index}")
            continue
        cut_id = _timeline_id(segment)
        if not cut_id:
            errors.append(f"E_IR_CUT_ID_REQUIRED:{index}")
        else:
            actual_cut_ids.append(cut_id)
        start = segment.get("start_ms")
        end = segment.get("end_ms")
        if not _strict_int(start) or not _strict_int(end) or start < 0 or end <= start or end > duration:
            errors.append(f"E_IR_TIME_RANGE:{index}")
        else:
            if start != previous_end:
                errors.append(f"E_IR_TIME_NOT_CONTIGUOUS:{index}:{previous_end}:{start}")
            previous_end = end
        for field in ("start_state", "central_action", "camera", "end_state"):
            value = segment.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"E_IR_SEGMENT_FIELD:{index}:{field}")
        if isinstance(segment.get("central_action"), list):
            errors.append(f"E_IR_MULTIPLE_CENTRAL_ACTIONS:{index}")
        if isinstance(segment.get("camera"), list):
            errors.append(f"E_IR_MULTIPLE_CAMERA_ACTIONS:{index}")
        audio = segment.get("audio", {})
        if audio is not None and not isinstance(audio, dict):
            errors.append(f"E_IR_AUDIO_INVALID:{index}")
        performance = segment.get("performance")
        if performance:
            if not isinstance(performance, dict):
                errors.append(f"E_IR_PERFORMANCE_INVALID:{index}")
            else:
                aus = performance.get("aus", [])
                if aus and (not isinstance(aus, list) or len(aus) > 3):
                    errors.append(f"E_IR_FACS_OVERLOADED:{index}")
                for field in ("trigger", "observable_change", "recovery_state"):
                    if not str(performance.get(field) or "").strip():
                        errors.append(f"E_IR_PERFORMANCE_FIELD:{index}:{field}")
    if timeline and previous_end != duration:
        errors.append(f"E_IR_TIMELINE_END:{previous_end}:{duration}")
    expected_cut_ids = [str(value) for value in request.get("cut_ids", [])]
    if expected_cut_ids and actual_cut_ids != expected_cut_ids:
        errors.append("E_IR_CUT_ORDER_MISMATCH")

    references = data.get("references")
    if not isinstance(references, list):
        errors.append("E_IR_REFERENCES_INVALID")
        references = []
    request_references = request.get("references") if isinstance(request.get("references"), list) else []
    if data.get("input_mode") == "text_to_video" and references:
        errors.append("E_IR_INPUT_MODE_REFERENCE_MISMATCH")
    if data.get("input_mode") == "reference_to_video" and not references:
        errors.append("E_IR_REFERENCE_MODE_REQUIRES_REFERENCE")
    if len(references) != len(request_references):
        errors.append("E_IR_REFERENCE_COUNT_MISMATCH")
    expected_tags = expected_reference_tags(references)
    for index, reference in enumerate(references, 1):
        if not isinstance(reference, dict):
            errors.append(f"E_IR_REFERENCE_INVALID:{index}")
            continue
        if reference.get("order") != index or _reference_tag(reference, index) != expected_tags[index - 1]:
            errors.append(f"E_IR_REFERENCE_ORDER:{index}")
        if reference.get("role") not in ALLOWED_REFERENCE_ROLES:
            errors.append(f"E_IR_REFERENCE_ROLE:{index}")
        if not str(reference.get("sha256") or ""):
            errors.append(f"E_IR_REFERENCE_HASH_REQUIRED:{index}")
        for field in ("use", "exclude", "provenance"):
            if not reference.get(field):
                errors.append(f"E_IR_REFERENCE_FIELD:{index}:{field}")
        if index <= len(request_references):
            expected = request_references[index - 1]
            if not isinstance(expected, dict):
                errors.append(f"E_IR_REQUEST_REFERENCE_INVALID:{index}")
            else:
                if reference.get("sha256") != expected.get("sha256"):
                    errors.append(f"E_IR_REFERENCE_HASH_MISMATCH:{index}")
                if reference.get("role") != expected.get("role"):
                    errors.append(f"E_IR_REFERENCE_ROLE_MISMATCH:{index}")
                if reference.get("tag") != expected.get("tag"):
                    errors.append(f"E_IR_REFERENCE_TAG_MISMATCH:{index}")
        if project_root is not None and reference.get("path"):
            source = (project_root.expanduser().resolve() / reference["path"]).resolve()
            try:
                source.relative_to(project_root.expanduser().resolve())
            except ValueError:
                errors.append(f"E_REFERENCE_PATH_ESCAPE:{index}")
                continue
            if not source.is_file():
                errors.append(f"E_REFERENCE_MISSING:{index}")
            elif reference.get("sha256") != sha_file(source):
                errors.append(f"E_REFERENCE_HASH_MISMATCH:{index}")

    locks = data.get("global_locks")
    if not isinstance(locks, dict) or not locks:
        errors.append("E_IR_GLOBAL_LOCKS_REQUIRED")
    negatives = data.get("negative_constraints")
    if not isinstance(negatives, list) or not negatives:
        errors.append("E_IR_NEGATIVE_CONSTRAINTS_REQUIRED")
    source_map = data.get("source_map")
    if not isinstance(source_map, list) or not source_map:
        errors.append("E_IR_SOURCE_MAP_REQUIRED")
    return errors


def _count_line_marker(prompt, marker):
    return sum(1 for line in str(prompt).splitlines() if line.lstrip().startswith(marker))


def validate_prompt_bundle(request, prompt_ir, variants):
    request = request if isinstance(request, dict) else {}
    issues = validate_ir(prompt_ir, request=request)
    checks = {
        "ir_schema": not any(
            issue.startswith("E_IR_SCHEMA")
            or issue.startswith("E_IR_FIELD")
            or issue == "E_IR_DOCUMENT_INVALID"
            for issue in issues
        ),
        "ir_context": not any("REQUEST_MISMATCH" in issue for issue in issues),
        "timeline_contiguous": not any("E_IR_TIME" in issue or "E_IR_TIMELINE" in issue for issue in issues),
        "one_action_one_camera": not any("MULTIPLE_CENTRAL_ACTIONS" in issue or "MULTIPLE_CAMERA_ACTIONS" in issue for issue in issues),
        "reference_hashes": not any("REFERENCE" in issue for issue in issues),
        "facs_conditional": not any("FACS" in issue or "PERFORMANCE" in issue for issue in issues),
    }
    if not isinstance(variants, dict):
        variants = {}
        issues.append("E_PROMPT_VARIANTS_REQUIRED")
    timeline = prompt_ir.get("timeline", []) if isinstance(prompt_ir, dict) else []
    protected = _protected_strings(request.get("source_prompt"), request.get("protected_strings", []))
    input_mode = request.get("input_mode") or ("reference_to_video" if request.get("references") else "text_to_video")
    expected_refs = expected_reference_tags(request.get("references", []))
    expected_cuts = [str(value) for value in request.get("cut_ids", [])]
    for language in LANGUAGES:
        prompt = variants.get(language)
        prefix = f"{language}:"
        if not isinstance(prompt, str) or not prompt.strip():
            issues.append(f"E_PROMPT_VARIANT_REQUIRED:{language}")
            checks[f"{prefix}present"] = False
            continue
        profile = SECTION_PROFILES[language]
        missing_sections = [section for section in profile["required"] if section not in prompt]
        if missing_sections:
            issues.extend(f"E_PROMPT_SECTION_MISSING:{language}:{section}" for section in missing_sections)
        checks[f"{prefix}sections"] = not missing_sections
        marker_ok = all(_count_line_marker(prompt, profile[key]) == len(timeline) for key in ("action", "camera", "end"))
        if not marker_ok:
            issues.append(f"E_PROMPT_TIMELINE_MARKERS:{language}")
        checks[f"{prefix}timeline_markers"] = marker_ok
        identity_ok = all(prompt.count(value) == str(request.get("source_prompt") or "").count(value) for value in protected)
        if not identity_ok:
            issues.append(f"E_PROMPT_PROTECTED_MISMATCH:{language}")
        checks[f"{prefix}protected"] = identity_ok
        references_ok = all(tag in prompt for tag in expected_refs)
        if not references_ok:
            issues.append(f"E_PROMPT_REFERENCE_TAGS:{language}")
        checks[f"{prefix}references"] = references_ok
        reference_mode_ok = not (input_mode == "text_to_video" and re.search(r"@(?:Image|Video|Audio)\s+\d+", prompt))
        if not reference_mode_ok:
            issues.append(f"E_PROMPT_REFERENCE_TAGS_UNEXPECTED:{language}")
        checks[f"{prefix}reference_mode"] = reference_mode_ok
        cuts_ok = all(cut_id in prompt for cut_id in expected_cuts)
        if not cuts_ok:
            issues.append(f"E_PROMPT_CUT_IDS:{language}")
        checks[f"{prefix}cut_ids"] = cuts_ok
    if all(isinstance(variants.get(language), str) for language in LANGUAGES):
        if variants["ko"].strip() == variants["en"].strip() or variants["ko"].strip() == variants["zh"].strip():
            issues.append("E_PROMPT_LANGUAGE_UNCHANGED")
            checks["language_distinct"] = False
        else:
            checks["language_distinct"] = True
    checks["all_checks_pass"] = not issues
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "PASS" if not issues else "FAIL",
        "checks": checks,
        "issues": issues,
        "ir_sha256": ir_sha256(prompt_ir),
        "prompt_sha256": {language: sha_text(variants.get(language, "")) for language in LANGUAGES},
        "bundle_sha256": sha_text(canonical({"ir": prompt_ir, "variants": variants})),
    }


def render_prompt(data, language="ko"):
    variants = data.get("prompt_variants", {})
    if isinstance(variants, dict) and variants.get(language):
        return str(variants[language]).rstrip() + "\n"
    raise ValueError(f"prompt variant missing: {language}")


def compile_package(ir_path: Path, project_root: Path, output: Path):
    ir_path = ir_path.expanduser().resolve()
    project_root = project_root.expanduser().resolve()
    output = output.expanduser().resolve()
    data = json.loads(ir_path.read_text(encoding="utf-8"))
    errors = validate_ir(data, project_root)
    if errors:
        raise SystemExit("\n".join(errors))
    if output.exists() and not output.is_dir():
        raise SystemExit("output package path must be a directory")
    if output.exists() and any(output.iterdir()):
        raise SystemExit("output package directory must be empty")
    refs_dir = output / "references"
    refs_dir.mkdir(parents=True, exist_ok=True)
    manifest_refs = []
    for reference in data["references"]:
        source = (project_root / reference["path"]).resolve()
        suffix = source.suffix.lower() or ".bin"
        name = f"{reference['order']:02d}_{reference['role']}{suffix}"
        shutil.copyfile(source, refs_dir / name)
        manifest_refs.append({**reference, "package_path": f"references/{name}"})
    prompt_files = {}
    for language in LANGUAGES:
        prompt_path = output / f"prompt.{language}.txt"
        prompt_path.write_text(render_prompt(data, language), encoding="utf-8")
        prompt_files[language] = prompt_path.name
    package_hash = sha_text(canonical({"ir": data, "refs": [(r["order"], r["sha256"]) for r in data["references"]]}))
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "package_hash": package_hash,
        "source_ir": str(ir_path),
        "ir_sha256": ir_sha256(data),
        "prompt_files": prompt_files,
        "prompt_sha256": {language: sha_file(output / filename) for language, filename in prompt_files.items()},
        "references": manifest_refs,
        "ready_claim": False,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "README.txt").write_text("manifest.json의 references.order 순서대로 첨부합니다. HAP QA와 사용자 승인 전에는 업로드 준비 완료가 아닙니다.\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ir")
    parser.add_argument("--project", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = compile_package(Path(args.ir).resolve(), Path(args.project).resolve(), Path(args.out).resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
