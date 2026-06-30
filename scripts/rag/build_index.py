#!/usr/bin/env python
"""Build or refresh the dense embedding index for the memory.

mtime-incremental: only embeds new or changed pages, reuses the rest.
Writes <memory>/_vec.json with a 384d MiniLM vector per page. Fully local.
Run nightly (cron / Task Scheduler) or by hand. Same page scope as the
prompt-recall hook (entities, concepts, summaries; sources excluded on purpose).

Memory dir: env AGENT_MEMORY_DIR, default ~/agent-memory.
"""
import json
import os
import re
import time
from pathlib import Path

from fastembed import TextEmbedding

MODEL_NAME = os.environ.get(
    "AGENT_MEMORY_EMBED_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
MEM = Path(os.environ.get("AGENT_MEMORY_DIR") or (Path.home() / "agent-memory"))
PAGE_DIRS = ["entities", "concepts", "summaries"]
VEC_PATH = MEM / "_vec.json"
EXTRACT_CAP = 2000


def extract(txt):
    """Title-less: What + Key facts sections, fall back to the whole body."""
    if txt.startswith("---"):
        end = txt.find("\n---", 4)
        if end > 0:
            txt = txt[end + 4:]
    picked, cap = [], False
    for ln in txt.split("\n"):
        head = re.match(r"^##\s+(.+)", ln)
        if head:
            cap = bool(re.match(r"^(what|key facts)", head.group(1).strip(), re.I))
            if cap:
                picked.append(ln)
            continue
        if cap:
            picked.append(ln)
    out = "\n".join(picked).strip()
    if len(out) < 40:
        out = txt.strip()
    return out[:EXTRACT_CAP]


def main():
    prev = {}
    if VEC_PATH.exists():
        try:
            prev = json.loads(VEC_PATH.read_text(encoding="utf-8"))
        except Exception:
            prev = {}
    prev_vecs = prev.get("vectors", {})
    prev_mt = prev.get("mtimes", {})
    same_model = prev.get("model") == MODEL_NAME

    pages = {}
    for d in PAGE_DIRS:
        ad = MEM / d
        if not ad.is_dir():
            continue
        for f in ad.glob("*.md"):
            if f.name.startswith("_"):
                continue
            pages[f"{d}/{f.name}"] = f.stat().st_mtime

    todo = [
        rel for rel, mt in pages.items()
        if not same_model or abs(prev_mt.get(rel, -1) - mt) > 1e-6
    ]
    kept = {rel: prev_vecs[rel] for rel in pages if rel not in todo and rel in prev_vecs}

    if todo:
        model = TextEmbedding(model_name=MODEL_NAME)
        slugs = [Path(rel).stem for rel in todo]
        texts = [extract((MEM / rel).read_text(encoding="utf-8")) for rel in todo]
        inputs = [f"{s}\n{t}" for s, t in zip(slugs, texts)]
        embs = list(model.embed(inputs))
        for rel, emb in zip(todo, embs):
            kept[rel] = [round(float(x), 6) for x in emb]

    dim = len(next(iter(kept.values()))) if kept else 0
    out = {
        "model": MODEL_NAME,
        "dim": dim,
        "builtAt": int(time.time() * 1000),
        "vectors": kept,
        "mtimes": {rel: pages[rel] for rel in kept},
    }
    tmp = VEC_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out), encoding="utf-8")
    tmp.replace(VEC_PATH)
    print(f"[build-index] {len(kept)} pages indexed, {len(todo)} re-embedded, dim={dim} -> {VEC_PATH}")


if __name__ == "__main__":
    main()
