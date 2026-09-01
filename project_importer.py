from __future__ import annotations
import json, re
from pathlib import Path
from screenplay_analyzer import analyze_screenplay

ROOT=Path(__file__).resolve().parent; PACKAGES=ROOT/'packages'

def create_project_from_text(title: str, text: str, preferred_name: str | None = None) -> dict:
    analysis=analyze_screenplay(text)
    if not analysis['scenes']: raise ValueError('screenplay_empty')
    base_name=preferred_name or 'PROJECT_'+re.sub(r'[^0-9A-Za-z가-힣._-]+','_',title).strip('_')
    name=base_name; n=2
    while (PACKAGES/name).exists(): name=f'{base_name}_{n}'; n+=1
    root=PACKAGES/name; (root/'input/screenplay').mkdir(parents=True); (root/'scene-data').mkdir(parents=True)
    (root/'input/screenplay/screenplay-pasted.txt').write_text(text,encoding='utf-8')
    root_manifest={'schema_version':'1.0','package_type':'project','title':title,'created_at':'','scene_hints':[{k:v for k,v in s.items() if k!='source_text'} for s in analysis['scenes']], 'pipeline':{'scene_segmentation':'completed','text_conti':'pending','assets':'pending','storyboard':'pending','prompts':'pending','qa':'pending','package':'pending'}}
    (root/'scene-data/scene-manifest.json').write_text(json.dumps(root_manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    for s in analysis['scenes']:
        slug=re.sub(r'[^0-9A-Za-z가-힣._-]+','_',s['title']).strip('_') or 'scene'
        sd=root/'scenes'/f"{s['scene_id']}_{slug}"; (sd/'scene-data').mkdir(parents=True)
        (sd/'input-screenplay.txt').write_text(s['source_text'],encoding='utf-8')
        manifest={'schema_version':'1.0','package_type':'scene','scene_id':s['scene_id'],'title':s['title'],'location':s['location'],'time':s['time'],'scene_duration':f"{s['estimated_duration_sec']}s",'block_duration':'15초','source_span':{'start':s['source_start'],'end':s['source_end']},'pipeline':{'analysis':'completed','text_conti':'pending','assets':'pending','storyboard':'pending','prompts':'pending','qa':'pending'}}
        (sd/'scene-data/scene-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    return {'project':name,'scene_count':len(analysis['scenes']),'path':str(root)}
