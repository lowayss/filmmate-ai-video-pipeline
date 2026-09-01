#!/usr/bin/env python3
"""Validation helpers for FilmMate's 4–15 second micro-shot workflow.

The micro-shot path is deliberately additive. Legacy scene/block requests keep
their existing contract; this module only validates requests that explicitly
set ``workflow_mode`` to ``micro_shot``.
"""
from __future__ import annotations

import re
from pathlib import Path


WORKFLOW_MODE = "micro_shot"
MIN_DURATION_MS = 4_000
MAX_DURATION_MS = 15_000
MEDIA_TYPES = {"image", "video", "audio"}
MEDIA_LABELS = {"image": "Image", "video": "Video", "audio": "Audio"}
MEDIA_EXTENSIONS = {
    "video": {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"},
    "audio": {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"},
}
ROLE_MEDIA = {
    "character": "image",
    "background": "image",
    "location": "image",
    "prop": "image",
    "storyboard": "image",
    "motion": "video",
    "audio": "audio",
}
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _strict_int(value):
    """Return True only for real ints, excluding bool (a Python int subclass)."""
    return type(value) is int


def _role(value):
    return str(value or "").strip().lower()


def infer_media_type(value, fallback="image"):
    """Infer a supported media type from an explicit type or file suffix."""
    explicit = str(value or "").strip().lower()
    if explicit in MEDIA_TYPES:
        return explicit
    suffix = Path(str(value or "")).suffix.lower()
    for media_type, extensions in MEDIA_EXTENSIONS.items():
        if suffix in extensions:
            return media_type
    return fallback if fallback in MEDIA_TYPES else "image"


def media_tag(media_type, index, *, at=True):
    label = MEDIA_LABELS.get(infer_media_type(media_type), "Image")
    prefix = "@" if at else ""
    return f"{prefix}{label} {int(index)}"


def expected_reference_values(references):
    """Return canonical ``(tag, external_id, media_type)`` values in input order."""
    counts = {media_type: 0 for media_type in MEDIA_TYPES}
    values = []
    for reference in references if isinstance(references, list) else []:
        if isinstance(reference, dict):
            path_type = infer_media_type(reference.get("path"))
            media_type = infer_media_type(reference.get("media_type"), path_type)
        else:
            media_type = "image"
        counts[media_type] += 1
        values.append(
            (
                media_tag(media_type, counts[media_type]),
                media_tag(media_type, counts[media_type], at=False),
                media_type,
            )
        )
    return values


def micro_shot_issues(request):
    """Return stable, user-facing validation codes for a micro-shot request.

    Validation is intentionally defensive: malformed user/MCP payloads should
    return deterministic issue codes instead of raising incidental TypeError or
    AttributeError exceptions.
    """
    if not isinstance(request, dict) or request.get("workflow_mode") != WORKFLOW_MODE:
        return []

    issues = []
    duration = request.get("duration_ms")
    if not _strict_int(duration) or not MIN_DURATION_MS <= duration <= MAX_DURATION_MS:
        issues.append(f"E_MICRO_DURATION_RANGE:{MIN_DURATION_MS}:{MAX_DURATION_MS}")
    if not str(request.get("micro_brief") or request.get("source_prompt") or "").strip():
        issues.append("E_MICRO_BRIEF_REQUIRED")
    if request.get("unit_type") not in {None, "shot"}:
        issues.append("E_MICRO_UNIT_TYPE_INVALID")
    if request.get("input_mode") not in {None, "reference_to_video"}:
        issues.append("E_MICRO_INPUT_MODE_INVALID")

    references = request.get("references")
    if not isinstance(references, list):
        issues.append("E_MICRO_REFERENCES_INVALID")
        references = []
    if len(references) < 2:
        issues.append("E_MICRO_CHARACTER_BACKGROUND_REQUIRED")

    configured_roles = request.get("required_reference_roles", [])
    if configured_roles is None:
        configured_roles = []
    elif not isinstance(configured_roles, list):
        issues.append("E_MICRO_REQUIRED_ROLES_INVALID")
        configured_roles = []
    required_roles = [_role(value) for value in configured_roles if _role(value)]
    for role in ("character", "background"):
        if role not in required_roles:
            required_roles.append(role)

    roles = {_role(reference.get("role")) for reference in references if isinstance(reference, dict)}
    missing = [role for role in ("character", "background") if role not in roles]
    if "background" in missing and "location" in roles:
        missing.remove("background")
    if missing:
        issues.append(f"E_MICRO_REQUIRED_ROLE_MISSING:{','.join(missing)}")

    expected = expected_reference_values(references)
    for index, reference in enumerate(references, 1):
        if not isinstance(reference, dict):
            issues.append(f"E_MICRO_REFERENCE_INVALID:{index}")
            continue

        canonical_tag, canonical_id, media_type = expected[index - 1]
        order = reference.get("order")
        if not _strict_int(order) or order != index:
            issues.append(f"E_MICRO_REFERENCE_ORDER:{index}")
        if reference.get("tag") != canonical_tag:
            issues.append(f"E_MICRO_REFERENCE_TAG:{index}:{canonical_tag}")
        if reference.get("external_id") not in {None, "", canonical_id}:
            issues.append(f"E_MICRO_REFERENCE_EXTERNAL_ID:{index}:{canonical_id}")

        declared = reference.get("media_type")
        if declared is not None:
            normalized_declared = str(declared).strip().lower()
            if normalized_declared not in MEDIA_TYPES:
                issues.append(f"E_MICRO_REFERENCE_MEDIA_TYPE_INVALID:{index}")
            elif normalized_declared != media_type:
                issues.append(f"E_MICRO_REFERENCE_MEDIA_TYPE:{index}:{media_type}")

        role = _role(reference.get("role"))
        if role in ROLE_MEDIA and media_type != ROLE_MEDIA[role]:
            issues.append(f"E_MICRO_REFERENCE_ROLE_MEDIA:{index}:{role}:{ROLE_MEDIA[role]}")

        digest = str(reference.get("sha256") or "").strip()
        if not digest:
            issues.append(f"E_MICRO_REFERENCE_HASH_REQUIRED:{index}")
        elif not _SHA256_RE.fullmatch(digest):
            issues.append(f"E_MICRO_REFERENCE_HASH_INVALID:{index}")

    for role in ("character", "background"):
        for index, reference in enumerate(references, 1):
            if isinstance(reference, dict) and _role(reference.get("role")) == role:
                if infer_media_type(reference.get("media_type"), infer_media_type(reference.get("path"))) != "image":
                    issues.append(f"E_MICRO_REQUIRED_ROLE_MEDIA:{role}:{index}")

    previs = [
        reference
        for reference in references
        if isinstance(reference, dict) and str(reference.get("source_kind") or "").strip().lower() == "previs"
    ]
    if previs and any(
        infer_media_type(reference.get("media_type"), infer_media_type(reference.get("path"))) != "video"
        for reference in previs
    ):
        issues.append("E_MICRO_PREVIS_MUST_BE_VIDEO")

    return issues


def is_micro_shot(request):
    return isinstance(request, dict) and request.get("workflow_mode") == WORKFLOW_MODE
