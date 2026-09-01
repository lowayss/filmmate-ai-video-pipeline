#!/usr/bin/env python3
"""Encoding-safe screenplay scene splitter for Korean screenplay headings."""
from __future__ import annotations
import re

HEADING = re.compile(r"(?im)^\s*#{0,6}\s*(?:S\s*#?\s*|SCENE\s+|씬\s*)(\d+)\s*[.)]?\s*(.*?)\s*$")

def analyze_screenplay(text: str) -> dict:
    if not isinstance(text, str): raise TypeError("screenplay_must_be_text")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    matches = list(HEADING.finditer(text))
    scenes = []
    for index, match in enumerate(matches):
        raw = match.group(2).strip()
        parts = [part.strip() for part in raw.split("/")]
        title = parts[0] or f"씬 {match.group(1)}"
        location = parts[0] or None
        time = parts[1] if len(parts) > 1 else None
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        source = text[start:end].strip()
        scenes.append({"scene_id":f"S{int(match.group(1))}","order":index+1,"title":title,"location":location,"time":time,"source_start":start,"source_end":end,"source_text":source,"estimated_duration_sec":max(15, round(len(source.split()) / 2.5))})
    if not scenes and text.strip():
        scenes.append({"scene_id":"S1","order":1,"title":"분석 필요","location":None,"time":None,"source_start":0,"source_end":len(text),"source_text":text.strip(),"estimated_duration_sec":max(15, round(len(text.split()) / 2.5))})
    return {"schema_version":"1.0","scene_count":len(scenes),"encoding":"utf-8","scenes":scenes}
