#!/usr/bin/env python
"""Nightly memory auto-ordering: tagging, clustering, index rewrite,
link suggestions, dedup/staleness report.

Use:
    python autoorder.py --once

Touches ONLY frontmatter; page body stays byte-identical.
NEVER injects [[links]] into pages. Deletes NOTHING.

Memory dir: env AGENT_MEMORY_DIR, default ~/agent-memory.
Schedule it with cron or Task Scheduler (see scripts/rag/README.md).
"""
import argparse
import json
import os
import re
import shutil
import time
from collections import Counter
from pathlib import Path

import numpy as np
from fastembed import TextEmbedding

# --- Config ---
MODEL_NAME = os.environ.get(
    "AGENT_MEMORY_EMBED_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
MEM = Path(os.environ.get("AGENT_MEMORY_DIR") or (Path.home() / "agent-memory"))
PAGE_DIRS = ["entities", "concepts", "summaries"]
VEC_PATH = MEM / "_vec.json"
LINK_SUGGESTIONS_PATH = MEM / "_link-suggestions.json"
HYGIENE_REPORT_PATH = MEM / "_hygiene-report.md"
EXTRACT_CAP = 2000
CLUSTER_THRESHOLD = 0.50
LINK_THRESHOLD = 0.78
DUPE_THRESHOLD = 0.92
NEAR_DUPE_THRESHOLD = 0.85  # strongly related (often entity<->summary), consolidation candidate
STALE_DAYS = 90

# Generic taxonomy. Tune TAXONOMY_KEYWORDS to your own domain: each label maps
# to a list of lowercase keywords checked against the page text.
TAXONOMY_KEYWORDS: dict[str, list[str]] = {
    "infra": ["vps", "server", "docker", "kubernetes", "deploy", "nginx", "caddy", "container", "compose", "cloud"],
    "security": ["security", "audit", "hardening", "auth", "cve", "pentest", "oauth", "token", "vulnerability"],
    "data": ["database", "postgres", "redis", "sql", "schema", "migration", "query", "index", "cache"],
    "frontend": ["react", "vue", "svelte", "css", "tailwind", "component", "ui", "ux", "browser", "vite"],
    "backend": ["api", "endpoint", "service", "rest", "graphql", "queue", "worker", "rpc", "handler"],
    "ai": ["llm", "model", "agent", "embedding", "rag", "prompt", "vector", "openai", "anthropic", "ollama"],
    "devtools": ["git", "ci", "build", "test", "lint", "hook", "script", "bash", "powershell", "make"],
    "process": ["meeting", "decision", "plan", "roadmap", "milestone", "review", "retro", "spec"],
    "people": ["contact", "team", "stakeholder", "client", "customer", "owner", "lead", "manager"],
    "finance": ["invoice", "payment", "cost", "budget", "billing", "revenue", "subscription", "pricing"],
}


# --- Frontmatter helpers ---

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from body. Returns ({}, full text) if no frontmatter."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 4)
    if end < 0:
        return {}, text
    fm_raw = text[4:end]  # between first --- and second ---
    body = text[end + 4:]  # after second ---
    # Simple line-by-line parse; we only need to read/write tags
    fm: dict = {}
    for line in fm_raw.split("\n"):
        if ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm, body


def serialize_frontmatter(fm: dict) -> str:
    """Serialize a frontmatter dict back to a YAML block."""
    lines = []
    for k, v in fm.items():
        lines.append(f"{k}: {v}")
    return "---\n" + "\n".join(lines) + "\n---"


def get_tags_from_page(path: Path) -> list[str]:
    """Read existing tags from frontmatter, or empty list."""
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return []
    fm, _ = parse_frontmatter(text)
    raw = fm.get("tags", "")
    if not raw:
        return []
    # Remove [ ] and split on comma
    raw = raw.strip("[]")
    return [t.strip() for t in raw.split(",") if t.strip()]


def assign_tags(text: str) -> list[str]:
    """Assign taxonomy labels based on keyword frequency in the page text."""
    lower = text.lower()
    scores: dict[str, int] = {}
    for label, kws in TAXONOMY_KEYWORDS.items():
        count = sum(lower.count(kw) for kw in kws)
        if count > 0:
            scores[label] = count
    if not scores:
        return []
    # Sort on score, take top-3
    sorted_labels = sorted(scores, key=lambda x: -scores[x])
    return sorted_labels[:3]


def rewrite_tags_in_file(path: Path, new_tags: list[str]) -> bool:
    """
    Rewrite ONLY the tags field in frontmatter.
    Body stays byte-identical. Returns True if the file changed.
    """
    original = path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(original)

    tag_str = "[" + ", ".join(new_tags) + "]"
    current_tags = fm.get("tags", "")

    if current_tags == tag_str:
        return False  # already up to date, idempotent

    fm["tags"] = tag_str
    new_fm = serialize_frontmatter(fm)
    new_text = new_fm + body

    # Prove the body is byte-identical
    _, original_body = parse_frontmatter(original)
    _, new_body = parse_frontmatter(new_text)
    assert original_body == new_body, f"Body corruption detected in {path}!"

    path.write_text(new_text, encoding="utf-8")
    return True


# --- Embedding helpers ---

def extract_text(txt: str) -> str:
    """Same extraction logic as build_index.py."""
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


def load_or_build_vectors(pages: dict[str, Path]) -> dict[str, list[float]]:
    """Load existing vectors from _vec.json, build incrementally for new/changed pages."""
    prev: dict = {}
    if VEC_PATH.exists():
        try:
            prev = json.loads(VEC_PATH.read_text(encoding="utf-8"))
        except Exception:
            prev = {}

    prev_vecs = prev.get("vectors", {})
    prev_mt = prev.get("mtimes", {})
    same_model = prev.get("model") == MODEL_NAME

    page_mtimes = {rel: p.stat().st_mtime for rel, p in pages.items()}

    todo = [
        rel for rel in pages
        if not same_model or abs(prev_mt.get(rel, -1) - page_mtimes[rel]) > 1e-6
    ]
    kept = {rel: prev_vecs[rel] for rel in pages if rel not in todo and rel in prev_vecs}

    if todo:
        model = TextEmbedding(model_name=MODEL_NAME)
        slugs = [Path(rel).stem for rel in todo]
        texts = [extract_text(pages[rel].read_text(encoding="utf-8")) for rel in todo]
        inputs = [f"{s}\n{t}" for s, t in zip(slugs, texts)]
        embs = list(model.embed(inputs))
        for rel, emb in zip(todo, embs):
            kept[rel] = [round(float(x), 6) for x in emb]
        print(f"[autoorder] Re-embedded {len(todo)} pages")

    # Write _vec.json if there are new vectors
    if todo:
        dim = len(next(iter(kept.values()))) if kept else 0
        out = {
            "model": MODEL_NAME,
            "dim": dim,
            "builtAt": int(time.time() * 1000),
            "vectors": kept,
            "mtimes": {rel: page_mtimes[rel] for rel in kept},
        }
        tmp = VEC_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(out), encoding="utf-8")
        tmp.replace(VEC_PATH)

    return kept


# --- Cosine similarity ---

def cosine_matrix(vectors: dict[str, list[float]]) -> tuple[list[str], np.ndarray]:
    """Return (sorted keys, NxN cosine-similarity matrix)."""
    keys = sorted(vectors.keys())
    mat = np.array([vectors[k] for k in keys], dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1e-10, norms)
    mat_norm = mat / norms
    sim = mat_norm @ mat_norm.T
    return keys, sim


# --- Greedy threshold clustering ---

def greedy_cluster(keys: list[str], sim: np.ndarray, threshold: float) -> list[list[str]]:
    """Greedy threshold clustering: each page joins the first cluster whose mean
    similarity >= threshold, else starts a new cluster."""
    n = len(keys)
    cluster_members: list[list[int]] = []

    for i in range(n):
        best_cluster = -1
        best_score = -1.0
        for ci, members in enumerate(cluster_members):
            avg_sim = float(np.mean(sim[i, members]))
            if avg_sim > best_score:
                best_score = avg_sim
                best_cluster = ci
        if best_cluster >= 0 and best_score >= threshold:
            cluster_members[best_cluster].append(i)
        else:
            cluster_members.append([i])

    clusters = [[keys[idx] for idx in members] for members in cluster_members]
    return clusters


# --- Cluster label ---

def label_cluster(members: list[str], page_tags: dict[str, list[str]]) -> str:
    """Label a cluster with the top-2 dominant tags, separated by ' / '.
    Two tags together are almost always unique; on identical top-2,
    rewrite_index appends a sequence number as a final fallback.
    """
    tag_counts: Counter = Counter()
    for rel in members:
        for t in page_tags.get(rel, []):
            tag_counts[t] += 1
    if tag_counts:
        top = tag_counts.most_common(2)
        label = " / ".join(t for t, _ in top)
    else:
        # Fallback: use the directory
        dirs = [rel.split("/")[0] for rel in members]
        label = Counter(dirs).most_common(1)[0][0]
    return label


# --- Index rewrite ---

def page_title(rel: str, path: Path) -> str:
    """Read the name from frontmatter or use the slug."""
    try:
        text = path.read_text(encoding="utf-8")
        fm, _ = parse_frontmatter(text)
        name = fm.get("name", "")
        if name:
            return name
    except Exception:
        pass
    return Path(rel).stem


def page_hook(path: Path) -> str:
    """First non-empty body line as a hook."""
    try:
        text = path.read_text(encoding="utf-8")
        fm, body = parse_frontmatter(text)
        for line in body.split("\n"):
            line = line.strip()
            if line and not line.startswith("#") and not line.startswith("-"):
                return line[:120]
            if line.startswith("- "):
                return line[2:120]
    except Exception:
        pass
    return ""


def rewrite_index(
    clusters: list[list[str]],
    pages: dict[str, Path],
    page_tags: dict[str, list[str]],
) -> None:
    """Make index.md.bak and rewrite index.md with clustered sections."""
    index_path = MEM / "index.md"
    bak_path = MEM / "index.md.bak"

    # Backup once: keep a stable rollback anchor instead of overwriting the .bak
    # each run with the previous auto-generated version.
    if index_path.exists() and not bak_path.exists():
        shutil.copy2(index_path, bak_path)
        print(f"[autoorder] Backup: {bak_path}")

    lines = [
        "# Memory Index\n",
        "_Auto-generated by autoorder.py. Do not edit by hand._\n\n",
    ]

    # Sort clusters: larger clusters first
    sorted_clusters = sorted(clusters, key=lambda c: -len(c))

    seen_labels: Counter = Counter()
    for ci, members in enumerate(sorted_clusters):
        if not members:
            continue
        base_label = label_cluster(members, page_tags)
        seen_labels[base_label] += 1
        # Append a sequence number if this label appeared before (final fallback).
        count = seen_labels[base_label]
        label = base_label if count == 1 else f"{base_label} #{count}"
        lines.append(f"## {label} ({len(members)})\n\n")
        for rel in sorted(members):
            path = pages.get(rel)
            if not path:
                continue
            title = page_title(rel, path)
            hook = page_hook(path)
            entry = f"- [{title}]({rel})"
            if hook:
                entry += f": {hook}"
            lines.append(entry + "\n")
        lines.append("\n")

    index_path.write_text("".join(lines), encoding="utf-8")
    print(f"[autoorder] index.md rewritten with {len(sorted_clusters)} clusters")


# --- Link suggestions ---

def write_link_suggestions(keys: list[str], sim: np.ndarray) -> int:
    """Write pairs with cosine > LINK_THRESHOLD to _link-suggestions.json."""
    n = len(keys)
    suggestions = []
    for i in range(n):
        for j in range(i + 1, n):
            score = float(sim[i, j])
            if score >= LINK_THRESHOLD:
                suggestions.append({
                    "a": keys[i],
                    "b": keys[j],
                    "cosine": round(score, 4),
                })
    suggestions.sort(key=lambda x: -x["cosine"])
    LINK_SUGGESTIONS_PATH.write_text(
        json.dumps({"generated": int(time.time()), "pairs": suggestions}, indent=2),
        encoding="utf-8",
    )
    return len(suggestions)


# --- Hygiene report ---

def write_hygiene_report(keys: list[str], sim: np.ndarray, pages: dict[str, Path]) -> None:
    """Write _hygiene-report.md with dupe candidates and stale pages."""
    now = time.time()
    stale_cutoff = now - STALE_DAYS * 86400

    # Dupe candidates
    dupes = []
    n = len(keys)
    for i in range(n):
        for j in range(i + 1, n):
            score = float(sim[i, j])
            if score >= DUPE_THRESHOLD:
                dupes.append((keys[i], keys[j], round(score, 4)))
    dupes.sort(key=lambda x: -x[2])

    # Near-duplicate pairs: strongly related but below the hard dupe threshold.
    # Usually an entity and its summary about the same topic; no delete,
    # but a consolidation / cross-link candidate.
    near = []
    for i in range(n):
        for j in range(i + 1, n):
            score = float(sim[i, j])
            if NEAR_DUPE_THRESHOLD <= score < DUPE_THRESHOLD:
                near.append((keys[i], keys[j], round(score, 4)))
    near.sort(key=lambda x: -x[2])

    # Stale pages
    stale = []
    for rel, path in pages.items():
        try:
            mtime = path.stat().st_mtime
            if mtime < stale_cutoff:
                days_old = int((now - mtime) / 86400)
                stale.append((rel, days_old))
        except Exception:
            pass
    stale.sort(key=lambda x: -x[1])

    lines = [
        "# Memory Hygiene Report\n\n",
        f"_Generated: {time.strftime('%Y-%m-%d %H:%M')}. Report only, nothing deleted._\n\n",
        f"## Dupe candidates (cosine > {DUPE_THRESHOLD})\n\n",
    ]
    if dupes:
        lines.append("| Page A | Page B | Score |\n")
        lines.append("|--------|--------|-------|\n")
        for a, b, score in dupes:
            lines.append(f"| `{a}` | `{b}` | {score} |\n")
    else:
        lines.append("_No dupe candidates found._\n")

    lines.append(
        f"\n## Strongly related pairs ({NEAR_DUPE_THRESHOLD} - {DUPE_THRESHOLD}, "
        "consolidation candidate, no auto-delete)\n\n"
    )
    if near:
        lines.append("| Page A | Page B | Score |\n")
        lines.append("|--------|--------|-------|\n")
        for a, b, score in near:
            lines.append(f"| `{a}` | `{b}` | {score} |\n")
    else:
        lines.append("_No strongly related pairs found._\n")

    lines.append(f"\n## Stale pages (> {STALE_DAYS} days old)\n\n")
    if stale:
        lines.append("| Page | Days old |\n")
        lines.append("|------|----------|\n")
        for rel, days in stale:
            lines.append(f"| `{rel}` | {days} |\n")
    else:
        lines.append("_All pages were recently updated._\n")

    HYGIENE_REPORT_PATH.write_text("".join(lines), encoding="utf-8")
    print(f"[autoorder] Hygiene report: {len(dupes)} dupes, {len(near)} near-dupes, {len(stale)} stale pages")


# --- Body-identity proof ---

def verify_body_identity(sample_paths: list[Path]) -> None:
    """Prove on a sample of pages that the body is byte-identical after a tag rewrite."""
    print("\n[autoorder] === Body-identity verification (3 pages) ===")
    for path in sample_paths[:3]:
        original = path.read_text(encoding="utf-8")
        _, original_body = parse_frontmatter(original)

        # Simulate a tag rewrite
        fm, body = parse_frontmatter(original)
        fm["tags"] = "[test-verify]"
        new_fm = serialize_frontmatter(fm)
        new_text = new_fm + body
        _, new_body = parse_frontmatter(new_text)

        match = original_body == new_body
        print(f"  {path.name}: body byte-identical = {match} (body len: {len(original_body)})")
        if not match:
            raise RuntimeError(f"Body corruption in {path}!")


# --- Main ---

def main() -> None:
    parser = argparse.ArgumentParser(description="Memory auto-ordering")
    parser.add_argument("--once", action="store_true", help="Single run (no daemon)")
    args = parser.parse_args()

    if not args.once:
        print("Use --once for a single run")
        return

    print(f"[autoorder] Start: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[autoorder] Memory dir: {MEM}")

    # 1. Collect all pages
    pages: dict[str, Path] = {}
    for d in PAGE_DIRS:
        ad = MEM / d
        if not ad.is_dir():
            continue
        for f in ad.glob("*.md"):
            if f.name.startswith("_"):
                continue
            rel = f"{d}/{f.name}"
            pages[rel] = f

    print(f"[autoorder] {len(pages)} pages found")

    if not pages:
        print("[autoorder] no pages, nothing to do")
        return

    # Verify body identity on 3 sample pages
    sample = list(pages.values())[:3]
    verify_body_identity(sample)

    # 2. Load or build vectors
    vectors = load_or_build_vectors(pages)
    print(f"[autoorder] {len(vectors)} vectors loaded")

    # 3. Auto-tagging
    page_tags: dict[str, list[str]] = {}
    tagged_count = 0
    for rel, path in pages.items():
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            page_tags[rel] = []
            continue
        new_tags = assign_tags(text)
        if not new_tags:
            new_tags = [rel.split("/")[0]]  # fallback: directory name
        page_tags[rel] = new_tags
        changed = rewrite_tags_in_file(path, new_tags)
        if changed:
            tagged_count += 1

    print(f"[autoorder] Auto-tagging: {tagged_count} pages updated, {len(page_tags)} total")

    # 4. Cosine similarity matrix
    keys, sim = cosine_matrix(vectors)
    print(f"[autoorder] Similarity matrix: {len(keys)}x{len(keys)}")

    # 5. Clustering
    clusters = greedy_cluster(keys, sim, CLUSTER_THRESHOLD)
    print(f"[autoorder] {len(clusters)} clusters found (threshold={CLUSTER_THRESHOLD})")

    # 6. Rewrite index.md
    rewrite_index(clusters, pages, page_tags)

    # 7. Link suggestions
    n_suggestions = write_link_suggestions(keys, sim)
    print(f"[autoorder] Link suggestions: {n_suggestions} pairs (cosine > {LINK_THRESHOLD})")

    # 8. Hygiene report
    write_hygiene_report(keys, sim, pages)

    print(f"\n[autoorder] Done: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[autoorder] Output:")
    print(f"  index.md               -> {MEM / 'index.md'}")
    print(f"  index.md.bak           -> {MEM / 'index.md.bak'}")
    print(f"  _link-suggestions.json -> {LINK_SUGGESTIONS_PATH}")
    print(f"  _hygiene-report.md     -> {HYGIENE_REPORT_PATH}")


if __name__ == "__main__":
    main()
