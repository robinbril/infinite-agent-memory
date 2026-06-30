#!/usr/bin/env python
"""Mechanical ingest watcher for <memory>/raw/

Reads raw text dropped into raw/ and writes a structured markdown source page
into sources/ with frontmatter. The auto-order step enriches it afterwards.

Use:
    python ingest_watch.py --once

Privacy-safe: no LLM call. Idempotent: files already archived in raw/_done/ OR
that already have a sources page are skipped. Raw files are ARCHIVED to
raw/_done/, never deleted.

Order in a nightly run (example):
  ingest_watch.py --once   (raw/ -> sources/)
  build_index.py           (refresh dense index)
  autoorder.py --once      (clustering / tagging / links)

Memory dir: env AGENT_MEMORY_DIR, default ~/agent-memory.
"""
import argparse
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# --- Config ---
MEM = Path(os.environ.get("AGENT_MEMORY_DIR") or (Path.home() / "agent-memory"))
RAW_DIR = MEM / "raw"
DONE_DIR = RAW_DIR / "_done"
SOURCES_DIR = MEM / "sources"
LOG_PATH = MEM / "log.md"

# Extensions read as plain text
TEXT_EXTS = {".md", ".txt", ".rst", ".text"}

# Files we never touch
SKIP_PREFIXES = (".", "_")


def ensure_dirs() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    DONE_DIR.mkdir(parents=True, exist_ok=True)
    SOURCES_DIR.mkdir(parents=True, exist_ok=True)


def slugify(name: str) -> str:
    """Filename (without extension) -> url-safe slug."""
    s = name.lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return s or "untitled"


def make_slug(raw_path: Path, today: str) -> str:
    """Slug from filename + date suffix to avoid collisions."""
    base = slugify(raw_path.stem)
    return f"{base}-{today}"


def source_page_path(slug: str) -> Path:
    return SOURCES_DIR / f"{slug}.md"


def already_processed(raw_path: Path, slug: str) -> bool:
    """True if the file is already in _done/ OR the sources page already exists."""
    done_target = DONE_DIR / raw_path.name
    if done_target.exists():
        return True
    if source_page_path(slug).exists():
        return True
    return False


def read_text_content(raw_path: Path) -> str:
    try:
        return raw_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"[read error: {e}]"


def extract_preview(text: str, max_chars: int = 2000) -> str:
    """First `max_chars` characters, cleanly cut on a line boundary."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit("\n", 1)[0]
    return cut + "\n\n_(content truncated - see the raw file for the full text)_"


def build_source_page(raw_path: Path, slug: str, now_iso: str) -> str:
    """Build the markdown source page (frontmatter + body). No LLM."""
    ext = raw_path.suffix.lower()
    size_kb = raw_path.stat().st_size / 1024

    frontmatter = (
        "---\n"
        f"name: {raw_path.name}\n"
        "type: source\n"
        f"ingested: {now_iso}\n"
        f"origin: {raw_path.name}\n"
        f"source_size_kb: {size_kb:.1f}\n"
        "tags: []\n"
        "---\n"
    )

    if ext in TEXT_EXTS:
        raw_text = read_text_content(raw_path)
        preview = extract_preview(raw_text)
        body = (
            f"# {raw_path.stem}\n\n"
            f"**Source:** `{raw_path.name}`  \n"
            f"**Ingested:** {now_iso}\n\n"
            "## Content\n\n"
            f"{preview}\n"
        )
    else:
        body = (
            f"# {raw_path.stem}\n\n"
            f"**Source:** `{raw_path.name}`  \n"
            f"**Ingested:** {now_iso}  \n"
            f"**File type:** `{ext or 'unknown'}`  \n"
            f"**Size:** {size_kb:.1f} KB\n\n"
            "_(Binary or non-text file; content not shown inline.)_\n"
        )

    return frontmatter + "\n" + body


def append_log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass  # a log-write failure must not block the ingest


def process_once() -> int:
    """Process all new files in raw/. Returns the number processed."""
    ensure_dirs()

    candidates = [
        p for p in RAW_DIR.iterdir()
        if p.is_file()
        and not p.name.startswith(SKIP_PREFIXES)
    ]

    if not candidates:
        print("ingest: no new files in raw/")
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    processed = 0

    for raw_path in candidates:
        slug = make_slug(raw_path, today)
        dest = source_page_path(slug)

        if already_processed(raw_path, slug):
            print(f"  skip (already processed): {raw_path.name}")
            continue

        # Write sources page
        page_content = build_source_page(raw_path, slug, now_iso)
        dest.write_text(page_content, encoding="utf-8")
        print(f"  created: sources/{dest.name}")

        # Archive raw file to _done/
        done_target = DONE_DIR / raw_path.name
        # On a name collision in _done/, add a suffix
        if done_target.exists():
            done_target = DONE_DIR / f"{raw_path.stem}_{now_iso.replace(':', '-')}{raw_path.suffix}"
        shutil.move(str(raw_path), str(done_target))
        print(f"  archived: raw/_done/{done_target.name}")

        append_log(f"ingest: {raw_path.name} -> sources/{dest.name}")
        processed += 1

    print(f"ingest: {processed} file(s) processed")
    return processed


def main() -> None:
    parser = argparse.ArgumentParser(description="Memory ingest watcher")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single pass (cron mode)",
    )
    args = parser.parse_args()

    if not args.once:
        print("Use: ingest_watch.py --once", file=sys.stderr)
        sys.exit(1)

    process_once()


if __name__ == "__main__":
    main()
