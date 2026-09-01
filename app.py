#!/usr/bin/env python3
"""Local Codex scene package builder.

Collects scene metadata and attachments, then creates a Codex-ready scene
package with a manifest and deterministic input folders.
"""
from __future__ import annotations

import html
import json
import mimetypes
import re
import shutil
import zipfile
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
PACKAGES = ROOT / "packages"
PACKAGES.mkdir(parents=True, exist_ok=True)

FORM = """<!doctype html><meta charset='utf-8'><title>Codex Scene Package Builder</title>
<style>body{font:16px system-ui;max-width:920px;margin:36px auto;padding:0 20px;background:#f5f5f3;color:#222}main{background:#fff;padding:28px;border-radius:14px;box-shadow:0 4px 20px #0001}label{display:block;margin:14px 0 6px;font-weight:600}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit}textarea{min-height:150px}button{margin-top:22px;padding:12px 18px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:700;cursor:pointer}.hint{color:#666;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}</style>
<main><h1>Codex 시나리오 제작 패키지</h1><p class='hint'>전체 시나리오를 넣으면 Codex가 씬을 나누고, 각 씬의 실제 길이를 계산한 뒤 15초 영상 블록으로 분해합니다.</p>
<form method='post' enctype='multipart/form-data'>
<label>입력 방식</label><select name='input_mode'><option value='full_script'>전체 시나리오 — 자동 씬 분할</option><option value='single_scene'>단일 씬</option></select>
<div class='grid'><div><label>프로젝트명 (선택)</label><input name='project_title' placeholder='100배 줌'></div><div><label>블록 기준 길이</label><input name='block_duration' value='15초' readonly></div></div>
<div class='grid'><div><label>화면비</label><select name='aspect_ratio'><option>16:9</option><option>9:16</option><option>1:1</option></select></div><div><label>영상 모델</label><input name='video_model' value='Seedance'></div></div>
<p class='hint'>단일 씬 모드일 때만 아래 씬 정보를 입력합니다. 전체 시나리오 모드에서는 Codex가 씬 번호·제목·장소·시간·실제 러닝타임을 추출합니다.</p>
<div class='grid'><div><label>씬 번호 (단일 씬 선택 시)</label><input name='scene_id' placeholder='S01'></div><div><label>씬 제목</label><input name='title' placeholder='주택가 옥상'></div></div>
<div class='grid'><div><label>장소</label><input name='location'></div><div><label>시간</label><input name='time' placeholder='늦은 오후'></div></div>
<label>전체 시나리오 / 씬 시나리오</label>
<textarea id='screenplay' name='screenplay' placeholder='전체 시나리오를 붙여넣으세요. 입력 즉시 씬 번호·제목·장소·시간을 자동 추출합니다.'></textarea>
<div id='scene-preview' class='hint' style='margin-top:10px;padding:10px;background:#f1f1ee;border-radius:8px'>시나리오를 입력하면 자동 추출된 씬 정보가 여기에 표시됩니다.</div>
<input type='hidden' id='scene_hints' name='scene_hints'>
<label>캐릭터 시트</label><input type='file' name='characters' multiple accept='image/*,.pdf,.docx,.txt'>
<label>장소 레퍼런스</label><input type='file' name='locations' multiple accept='image/*,.pdf,.docx,.txt'>
<label>소품 레퍼런스</label><input type='file' name='props' multiple accept='image/*,.pdf,.docx,.txt'>
<label>시나리오 파일 (선택)</label><input id='screenplay_file' type='file' name='screenplay_file' accept='.txt,.md,.pdf,.docx'>
<label>연속성 메모 (선택)</label><textarea name='continuity' placeholder='이전 씬과 이어지는 소품, 위치, 동선, 금지사항'></textarea>
<div style='display:flex;gap:10px;flex-wrap:wrap'><button type='submit' name='action' value='package'>입력 패키지만 만들기</button><button type='submit' name='action' value='analyze'>Codex 분석 시작</button></div></form>
<script>
function extractScenes(text){
  const re=/S#?\\s*(\\d+)\\.?\\s*([^\\n]*)/gi, out=[]; let m;
  while((m=re.exec(text))){
    const raw=m[2].trim(), bits=raw.split('/').map(x=>x.trim());
    out.push({scene_id:'S'+m[1], title:bits[0]||'미정', location:bits[0]||'미정', time:bits[1]||'미정'});
  }
  return out;
}
function updateScenes(text){
  const scenes=extractScenes(text), box=document.getElementById('scene-preview');
  document.getElementById('scene_hints').value=JSON.stringify(scenes);
  if(!scenes.length){box.textContent='씬 헤딩을 찾지 못했습니다. 예: S#1. 주택가 옥상 / 늦은 오후'; return;}
  box.innerHTML='<b>자동 추출 씬 '+scenes.length+'개</b><br>'+scenes.map(s=>s.scene_id+' · '+s.title+' · '+s.time).join('<br>');
  const project=document.querySelector('[name=project_title]'); if(!project.value) project.value=scenes[0].title;
  const id=document.querySelector('[name=scene_id]'), title=document.querySelector('[name=title]'), loc=document.querySelector('[name=location]'), time=document.querySelector('[name=time]');
  if(scenes.length===1){id.value=scenes[0].scene_id; title.value=scenes[0].title; loc.value=scenes[0].location; time.value=scenes[0].time;}
}
document.getElementById('screenplay').addEventListener('input', e=>updateScenes(e.target.value));
document.getElementById('screenplay_file').addEventListener('change', e=>{const f=e.target.files[0]; if(f && /\\.(txt|md)$/i.test(f.name)){const r=new FileReader(); r.onload=()=>{document.getElementById('screenplay').value=r.result; updateScenes(r.result)}; r.readAsText(f)}});
</script></main>"""

def safe_name(value: str, fallback: str = "scene") -> str:
    value = re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", value.strip())
    return value.strip("._") or fallback

def save_field(field, target: Path, kind: str, manifest_files: list[dict]) -> None:
    if not field: return
    fields = field if isinstance(field, list) else [field]
    for item in fields:
        if not getattr(item, "filename", None): continue
        name = safe_name(Path(item.filename).name, "attachment")
        out = target / name
        stem, suffix = out.stem, out.suffix
        n = 2
        while out.exists():
            out = target / f"{stem}_{n}{suffix}"; n += 1
        with out.open("wb") as fh: shutil.copyfileobj(item.file, fh)
        manifest_files.append({"kind": kind, "path": str(out.relative_to(target.parent.parent)), "original_name": item.filename, "mime": mimetypes.guess_type(name)[0] or "application/octet-stream"})

class Handler(BaseHTTPRequestHandler):
    def send_html(self, body: str, status=200):
        data = body.encode("utf-8"); self.send_response(status); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path == "/board":
            data = (ROOT / "board.html").read_bytes(); self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data); return
        if self.path == "/api/projects":
            projects=[]
            for package in sorted(PACKAGES.iterdir() if PACKAGES.exists() else []):
                if not package.is_dir(): continue
                mp=package/"scene-data/scene-manifest.json"
                if not mp.exists(): continue
                root=json.loads(mp.read_text(encoding="utf-8")); scenes=[]; total_assets=0
                for sm in sorted((package/"scenes").glob("*/scene-data/scene-manifest.json") if (package/"scenes").exists() else []):
                    s=json.loads(sm.read_text(encoding="utf-8")); pipe=s.get("pipeline",{}); done=sum(v=="completed" for v in pipe.values()); progress=round(done/max(len(pipe),1)*100); scenes.append({"id":s.get("scene_id"),"title":s.get("title"),"location":s.get("location"),"time":s.get("time"),"duration":s.get("scene_duration"),"blocks":s.get("block_count",0),"progress":progress,"ready":progress==100,"pipeline":pipe}); total_assets+=len(list(sm.parent.parent.glob("assets/**/*")))
                projects.append({"title":root.get("title") or package.name,"path":str(package),"scenes":scenes,"asset_count":total_assets})
            payload=json.dumps({"projects":projects},ensure_ascii=False).encode(); self.send_response(200); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(payload))); self.end_headers(); self.wfile.write(payload); return
        query = parse_qs(urlparse(self.path).query)
        if query.get("package") and query.get("scene"):
            package = PACKAGES / safe_name(query["package"][0])
            sid = safe_name(query["scene"][0])
            matches = list((package / "scenes").glob(f"{sid}_*")) if (package / "scenes").exists() else []
            if matches:
                scene_dir = matches[0]
                data = json.loads((scene_dir / "scene-data/scene-manifest.json").read_text(encoding="utf-8"))
                self.send_html(f"""<main style='font:16px system-ui;max-width:1000px;margin:30px auto;padding:24px'><a href='/?package={html.escape(query['package'][0])}'>← 프로젝트 대시보드</a><h1>{html.escape(data['scene_id'])} · {html.escape(data['title'])}</h1><p>{html.escape(data.get('location') or '')} · {html.escape(data.get('time') or '')}</p><div style='display:grid;grid-template-columns:repeat(4,1fr);gap:12px'>{''.join(f"<div style='background:#f1f1ee;padding:16px;border-radius:10px'><b>{k}</b><br><span style='color:#777'>{v}</span></div>" for k,v in data['pipeline'].items())}</div><h2>씬 작업 파일</h2><ul><li>글 콘티: {html.escape(str(scene_dir/'text-conti'))}</li><li>에셋: {html.escape(str(scene_dir/'assets'))}</li><li>스토리보드: {html.escape(str(scene_dir/'storyboard'))}</li><li>프롬프트: {html.escape(str(scene_dir/'prompts'))}</li></ul><button style='padding:12px 18px;background:#111;color:white;border:0;border-radius:8px'>다음 작업 실행</button></main>""")
                return
        self.send_html(FORM)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        raw = (f"Content-Type: {self.headers.get('Content-Type', '')}\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
        message = BytesParser(policy=policy.default).parsebytes(raw)
        fields = {}
        uploads = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name: continue
            filename = part.get_filename()
            if filename:
                uploads.setdefault(name, []).append(type("Upload", (), {"filename": filename, "file": __import__("io").BytesIO(part.get_payload(decode=True) or b"")})())
            else:
                raw_value = part.get_payload(decode=True)
                if raw_value is None:
                    fields[name] = part.get_content()
                else:
                    fields[name] = raw_value.decode("utf-8", errors="replace")
        get = lambda key, default="": fields.get(key, default)
        action = get("action", "package")
        input_mode = get("input_mode", "full_script")
        project_title = get("project_title", "Untitled Project")
        is_project = input_mode == "full_script"
        scene_id = safe_name(get("scene_id", "PROJECT" if is_project else "S01"), "PROJECT" if is_project else "S01")
        title = get("title", project_title if is_project else "Untitled Scene") or (project_title if is_project else "Untitled Scene")
        slug = f"{scene_id}_{safe_name(title)}"
        package = PACKAGES / slug
        if package.exists(): shutil.rmtree(package)
        for folder in ("input/screenplay", "input/characters", "input/locations", "input/props", "scene-data", "text-conti", "assets/characters", "assets/backgrounds", "assets/props", "storyboard", "prompts", "qa", "package"):
            (package / folder).mkdir(parents=True, exist_ok=True)
        screenplay = get("screenplay", "")
        screenplay_file = uploads.get("screenplay_file", [None])[0]
        if screenplay_file and getattr(screenplay_file, "filename", None):
            name = safe_name(Path(screenplay_file.filename).name, "screenplay.txt")
            (package / "input/screenplay" / name).write_bytes(screenplay_file.file.read())
        if screenplay.strip(): (package / "input/screenplay" / "screenplay-pasted.txt").write_text(screenplay, encoding="utf-8")
        files = []
        for key, folder, kind in (("characters","input/characters","character_sheet"),("locations","input/locations","location_reference"),("props","input/props","prop_reference")):
            save_field(uploads.get(key), package / folder, kind, files)
        analyzing = action == "analyze"
        try: scene_hints = json.loads(get("scene_hints", "[]") or "[]")
        except json.JSONDecodeError: scene_hints = []
        manifest = {"schema_version":"1.1","package_type":"project" if is_project else "scene","scene_id":None if is_project else scene_id,"title":title,"status":"analysis_requested" if analyzing else "input_ready","created_at":datetime.now(timezone.utc).isoformat(),"location":None if is_project else get("location"),"time":None if is_project else get("time"),"scene_duration":None if is_project else "to_be_analyzed","block_duration":"15초","block_unit":"Seedance generation block","aspect_ratio":get("aspect_ratio","16:9"),"video_model":get("video_model","Seedance"),"continuity_notes":get("continuity"),"scene_hints":scene_hints,"source_files":files,"pipeline":{"scene_segmentation":"in_progress" if analyzing and is_project else ("pending" if is_project else "not_applicable"),"text_conti":"pending","assets":"pending","storyboard":"pending","prompts":"pending","qa":"pending","package":"ready"},"codex_next_action":"Use scene_hints as editable provisional metadata, then validate against the screenplay before creating scene-breakdown.json and 15-second block plans."}
        (package / "scene-data/scene-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        asset_plan = {"schema_version":"1.0","scene_id":scene_id,"status":"needs_codex_analysis","instruction":"시나리오와 씬 설명을 분석해 필요한 캐릭터·배경·소품·그래픽·특수효과 에셋을 추출하세요.","assets":[]}
        (package / "scene-data/asset-plan.json").write_text(json.dumps(asset_plan, ensure_ascii=False, indent=2), encoding="utf-8")
        codex_task = f'''# Codex 제작 작업 — {title}

이 패키지는 이미지 레퍼런스가 없거나 일부만 있는 상태일 수 있습니다. 먼저 `input/screenplay/`의 시나리오와 `scene-data/scene-manifest.json`을 읽으세요.

## 전체 시나리오 모드

`package_type`이 `project`이면 먼저 전체 시나리오를 장면 전환, 장소, 시간, 연속성, 사건 단위로 씬별 분할합니다. 각 씬에 `scene_id`, `title`, `location`, `time`, `scene_duration`, `characters`, `beats`를 부여합니다. 씬의 실제 러닝타임은 15초로 고정하지 않습니다.

그 다음 각 씬을 `ceil(scene_duration / 15초)`개의 Seedance 블록으로 나누고, 마지막 블록은 씬의 남은 시간에 맞게 설계합니다. 15초는 씬 길이가 아니라 생성 단위입니다.

## 반드시 생성할 파일

1. 프로젝트 모드: `scene-data/scene-breakdown.json` — 전체 시나리오의 씬 분할과 실제 러닝타임
2. 프로젝트 모드: `scene-data/block-plan.json` — 씬별 15초 블록 계획
3. 씬 모드: `text-conti/{scene_id}-text-conti.md` — 씬의 비트와 컷별 글 콘티
4. `scene-data/shot-list.json` — 컷 번호, 시간, 장소, 인물, 행동, 앵글, 소품
5. `scene-data/asset-plan.json` — 시나리오에서 추출한 모든 제작 에셋

## 에셋 추출 규칙

- 시나리오에 명시된 인물, 장소, 배경 구조, 소품, 화면 그래픽, 특수효과를 빠짐없이 추출합니다.
- 첨부된 레퍼런스는 `provided_reference`로 표시합니다.
- 첨부되지 않았지만 제작에 필요한 것은 `needs_generation`으로 표시합니다.
- 같은 에셋이 여러 컷에 쓰이면 하나의 에셋 ID로 묶고 사용 컷을 기록합니다.
- 100배 줌, 거리감, 화면 속 화면처럼 연출상 중요한 요소는 일반 소품과 구분해 `camera_or_visual_rule`로 기록합니다.
- 스마트폰·모니터·방송 화면 UI는 `한 이미지 = 한 화면 상태`로 생성합니다. 한 파일 안에 여러 스마트폰 화면, 비교 패널, 전환 단계, 전후 상태를 함께 배치하지 않습니다.
- 생성형 이미지에는 UI 요소를 전혀 넣지 않습니다. 글자·숫자뿐 아니라 상태 박스, 빈 댓글 버블, 프로필 원, 아바타, 아이콘, 버튼, 입력창, 상태바, 휴대전화 프레임도 모두 금지합니다.
- 생성 결과는 스마트폰 카메라가 촬영한 깨끗한 원본 화면 플레이트만 포함합니다.
- 실제 `LIVE`, 시청자 수, 댓글, 프로필, 반응 아이콘, 신고 문구와 전체 UI 레이아웃은 이미지와 분리된 `ui-copy.json` 및 후반 그래픽 작업으로 합성합니다.
- UI 상태가 시간에 따라 달라지면 변화 내용은 `ui_states` 데이터로 분리하고, 컷 또는 15초 블록 패키지에는 깨끗한 카메라 플레이트 한 장만 첨부합니다.

## 에셋 계획 필드

각 에셋에는 `asset_id`, `category`, `description`, `source`, `status`, `used_in_shots`, `generation_prompt`, `continuity_notes`를 포함합니다.

분석이 끝나면 `scene-manifest.json`의 상태를 `analysis_ready`로 변경하고, 다음 작업을 `generate_missing_assets`로 기록합니다.
'''
        (package / "scene-data/codex-next-task.md").write_text(codex_task, encoding="utf-8")
        (package / "scene-data/README.md").write_text("# Codex 작업 시작\n\n1. `codex-next-task.md`의 지시를 실행합니다.\n2. 시나리오를 분석해 글 콘티·컷 리스트·에셋 계획을 만듭니다.\n3. 이미지가 없는 에셋은 `needs_generation`으로 표시하고 Codex 이미지 생성 단계로 넘깁니다.\n\n현재 상태: input_ready\n", encoding="utf-8")
        scene_tabs = []
        if is_project and analyzing:
            scenes_root = package / "scenes"
            scenes_root.mkdir(exist_ok=True)
            for hint in scene_hints:
                sid = safe_name(hint.get("scene_id", "S01"), "S01")
                stitle = hint.get("title", "미정")
                scene_dir = scenes_root / f"{sid}_{safe_name(stitle)}"
                for sub in ("screenplay", "scene-data", "text-conti", "assets/characters", "assets/backgrounds", "assets/props", "storyboard", "prompts", "qa"):
                    (scene_dir / sub).mkdir(parents=True, exist_ok=True)
                scene_manifest = {"schema_version":"1.0","package_type":"scene","scene_id":sid,"title":stitle,"location":hint.get("location"),"time":hint.get("time"),"scene_duration":"to_be_analyzed","block_duration":"15초","status":"queued","parent_project":scene_id,"pipeline":{"analysis":"queued","text_conti":"pending","assets":"pending","storyboard":"pending","prompts":"pending","qa":"pending"},"codex_next_action":"Analyze this scene against the full screenplay, confirm metadata and calculate actual scene duration before 15-second block planning."}
                (scene_dir / "scene-data/scene-manifest.json").write_text(json.dumps(scene_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                scene_tabs.append({"scene_id":sid,"title":stitle,"time":hint.get("time"),"path":str(scene_dir)})
            (package / "scene-data/scene-breakdown.json").write_text(json.dumps({"status":"provisional","scenes":scene_tabs}, ensure_ascii=False, indent=2), encoding="utf-8")
        zip_path = package / "package" / f"{slug}_input.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for path in package.rglob("*"):
                if path.is_file() and path != zip_path: z.write(path, path.relative_to(package))
        heading = "Codex 분석 요청 생성 완료" if analyzing else "입력 패키지 생성 완료"
        message = "`scene-manifest.json`과 `codex-next-task.md`를 기준으로 Codex가 분석을 이어받습니다." if analyzing else "이제 패키지 안의 매니페스트를 기준으로 Codex 분석을 시작할 수 있습니다."
        tabs_html = ""
        if scene_tabs:
            tabs_html = "<h2>씬별 작업 대시보드</h2><div style='display:grid;grid-template-columns:repeat(2,1fr);gap:14px'>" + "".join(f"<a style='display:block;padding:18px;background:#f1f1ee;border-radius:12px;color:#111;text-decoration:none' href='/?package={html.escape(slug)}&scene={html.escape(s['scene_id'])}'><div style='font-size:22px;font-weight:700'>{html.escape(s['scene_id'])}</div><div style='font-size:18px;margin:8px 0'>{html.escape(s['title'])}</div><div style='color:#666'>{html.escape(s.get('time') or '')}</div><div style='margin-top:12px;color:#a66'>● 분석 대기 · 다음 작업 열기 →</div></a>" for s in scene_tabs) + "</div><p class='hint'>카드를 누르면 해당 씬의 독립 작업 화면으로 이동합니다.</p>"
        self.send_html(f"<main style='font:16px system-ui;max-width:760px;margin:40px auto'><h1>{heading}</h1><p><b>{html.escape(slug)}</b></p><p>{message}</p>{tabs_html}<p>Codex 작업 시작 파일:</p><pre>{html.escape(str(package / 'scene-data/scene-manifest.json'))}</pre><p>입력 ZIP:</p><pre>{html.escape(str(zip_path))}</pre><p><a href='/'>새 프로젝트 만들기</a></p></main>")

if __name__ == "__main__":
    print("Codex Scene Package Builder: http://127.0.0.1:8765")
    # Bind all local interfaces so the Codex in-app browser can reach the app.
    HTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
