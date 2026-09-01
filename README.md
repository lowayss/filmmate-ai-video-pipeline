# FilmMate

FilmMate is a local production workspace for turning screenplay and reference inputs into traceable AI-video prompt packages.

The project keeps the production stages separate: screenplay/source, scene structure, written conti, references, storyboard, prompt generation, QA, and delivery. It does not call a video-generation service directly. Its final handoff is an ordered set of references plus copy-ready prompts for an external video tool.

## What it supports

- HAP-backed canonical revisions and stale-state tracking
- Scene and block planning for AI-video production
- Character, background, prop, and other reference roles
- Exact external reference order and media tags such as `@Video 1`, `@Image 1`, and `@Audio 1`
- Optional previs video used for motion, blocking, camera, and timing only
- `Micro Shot` mode for one direct 4–15 second shot brief
- Korean, English, and Simplified Chinese prompt variants
- Schema, continuity, protected-token, and source-lock validation
- Electron desktop board plus a lightweight Python package builder

## Micro Shot workflow

The direct short-shot flow accepts:

1. An optional previs video reference
2. A character sheet
3. A background/location sheet
4. A 4–15 second shot brief
5. Optional prop and audio references

The upload order is preserved in the final prompt:

```text
with previs:    @Video 1 → @Image 1 → @Image 2 → ...
without previs: @Image 1 → @Image 2 → ...
```

Reference roles remain separated. A previs video supplies movement and camera intent; it does not replace the approved character identity, wardrobe, background, time, lighting, or style references.

## Requirements

- macOS with Node.js and Python 3
- Electron dependencies installed from `desktop/package-lock.json`
- Codex CLI available when running the prompt worker
- The `seedance-prompt-rules` skill available in the local Codex environment for prompt compilation

## Run the desktop app

```bash
cd desktop
npm ci
npm run dev
```

To create an unsigned arm64 macOS app bundle:

```bash
npm run build:mac
```

The build output is written to `desktop/dist/` and is intentionally ignored by Git.

## Run the Python package builder

```bash
python3 app.py
```

Then open <http://127.0.0.1:8765>.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

## Prompt handoff contract

FilmMate records the exact request, input fingerprint, reference order, source roles, and skill binding before a Codex worker compiles prompts. The worker must return one schema-valid prompt bundle containing Korean, English, and Simplified Chinese variants. Protected cut IDs, reference tags, and required structural sections are checked before the result becomes available in the desktop UI.

## Repository boundaries

This repository contains application source, tests, and build configuration. Local generated projects, media uploads, HAP databases, model caches, application backups, dependency folders, and packaged builds are excluded through `.gitignore`.
