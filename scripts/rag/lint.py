"""
lint.py - Mechanical memory lint (no LLM).

Checks:
  1. Orphan check: pages with no inbound [[slug]] wikilinks
  2. Index-gap check: pages not listed in index.md
  3. Broken-wikilink check: [[slug]] refs pointing to non-existent pages
  4. Staleness check: pages with updated:/date: frontmatter older than 90 days

Output: appends to <memory>/_logs/lint.log and <memory>/log.md
Notify: desktop notification (or a WOULD_NOTIFY log line) only when issues > 5

Usage:
  python lint.py --once

Memory dir: env AGENT_MEMORY_DIR, default ~/agent-memory.
"""

import argparse
import datetime
import os
import platform
import re
import subprocess
import sys
from pathlib import Path


MEM_ROOT = Path(os.environ.get("AGENT_MEMORY_DIR") or (Path.home() / "agent-memory"))
LOG_FILE = MEM_ROOT / "_logs" / "lint.log"

# Subdirs that contain pages (not raw drops, not system files)
PAGE_DIRS = ["entities", "concepts", "summaries", "sources", "people"]

# Subdirs intentionally excluded from index.md (sources/ is raw input, people/
# is local-only PII; recall and auto-order only cover entities/concepts/summaries).
INDEX_SCOPE_DIRS = {"entities", "concepts", "summaries"}
NOTIFY_THRESHOLD = 5
STALE_DAYS = 90

# Frontmatter date fields to check (in priority order)
DATE_FIELDS = ["updated", "date"]

WIKILINK_RE = re.compile(r"\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
DATE_FIELD_RE = re.compile(r"^(updated|date)\s*:\s*(.+)$", re.MULTILINE)


def collect_pages(mem_root: Path) -> dict[str, Path]:
    """Return slug -> path for all .md pages in PAGE_DIRS."""
    pages: dict[str, Path] = {}
    for subdir in PAGE_DIRS:
        d = mem_root / subdir
        if not d.exists():
            continue
        for p in d.glob("*.md"):
            slug = p.stem
            pages[slug] = p
    return pages


def extract_wikilinks(text: str) -> list[str]:
    return WIKILINK_RE.findall(text)


def read_index_slugs(mem_root: Path) -> set[str]:
    """Extract all slugs referenced in index.md."""
    index_path = mem_root / "index.md"
    if not index_path.exists():
        return set()
    text = index_path.read_text(encoding="utf-8", errors="replace")
    # index.md uses markdown links like [slug](entities/slug.md)
    link_re = re.compile(r"\]\((?:[^)]+/)([^)/]+)\.md\)")
    slugs = set(link_re.findall(text))
    # Also capture bare [[slug]] if any
    slugs.update(extract_wikilinks(text))
    return slugs


def parse_frontmatter_date(text: str) -> datetime.date | None:
    """Extract the first date value from YAML frontmatter, return as date or None."""
    fm_match = FRONTMATTER_RE.match(text)
    if not fm_match:
        return None
    fm_body = fm_match.group(1)
    m = DATE_FIELD_RE.search(fm_body)
    if not m:
        return None
    raw = m.group(2).strip().strip("\"'")
    # Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM
    try:
        return datetime.datetime.strptime(raw[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def get_mtime_date(path: Path) -> datetime.date:
    return datetime.date.fromtimestamp(path.stat().st_mtime)


def run_lint(mem_root: Path) -> dict:
    """Run all four checks. Returns dict with issue lists."""
    pages = collect_pages(mem_root)
    all_slugs = set(pages.keys())

    # Build inbound link map: slug -> set of slugs that link to it
    inbound: dict[str, set[str]] = {slug: set() for slug in all_slugs}
    all_wikilinks: dict[str, list[str]] = {}  # slug -> list of wikilinks it contains

    for slug, path in pages.items():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        links = extract_wikilinks(text)
        all_wikilinks[slug] = links
        for target in links:
            target_clean = target.strip()
            if target_clean in inbound:
                inbound[target_clean].add(slug)

    # Also count index.md links as inbound
    index_slugs = read_index_slugs(mem_root)
    for slug in index_slugs:
        if slug in inbound:
            inbound[slug].add("__index__")

    now = datetime.date.today()
    cutoff = now - datetime.timedelta(days=STALE_DAYS)

    orphans = []
    index_gaps = []
    broken_links = []
    stale = []

    for slug, path in sorted(pages.items()):
        # Subdir of this page
        subdir = path.parent.name

        # 1. Orphan check: sources/ and people/ are intentionally not linked from
        # other pages; they need no inbound links.
        if subdir not in ("sources", "people"):
            if not inbound[slug]:
                orphans.append(slug)

        # 2. Index-gap check: only for indexed subdirs (entities/concepts/summaries).
        # sources/ and people/ are intentionally not in index.md.
        if subdir in INDEX_SCOPE_DIRS and slug not in index_slugs:
            index_gaps.append(slug)

        # 3. Broken wikilinks
        for target in all_wikilinks.get(slug, []):
            t = target.strip()
            if t not in all_slugs:
                broken_links.append(f"{slug} -> [[{t}]]")

        # 4. Staleness check
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        page_date = parse_frontmatter_date(text)
        if page_date is None:
            page_date = get_mtime_date(path)
        if page_date < cutoff:
            stale.append(f"{slug} ({page_date})")

    return {
        "orphans": orphans,
        "index_gaps": index_gaps,
        "broken_links": broken_links,
        "stale": stale,
    }


def build_report(results: dict, ts: str) -> str:
    orphans = results["orphans"]
    gaps = results["index_gaps"]
    broken = results["broken_links"]
    stale = results["stale"]
    total = len(orphans) + len(gaps) + len(broken) + len(stale)

    lines = [
        f"[{ts}] lint run",
        f"Total issues: {total} (orphans={len(orphans)} index_gaps={len(gaps)} broken_links={len(broken)} stale={len(stale)})",
        "",
    ]

    if orphans:
        lines.append("== Orphans (no inbound links) ==")
        for s in orphans:
            lines.append(f"  {s}")
        lines.append("")

    if gaps:
        lines.append("== Index gaps (not in index.md) ==")
        for s in gaps:
            lines.append(f"  {s}")
        lines.append("")

    if broken:
        lines.append("== Broken wikilinks ==")
        for s in broken:
            lines.append(f"  {s}")
        lines.append("")

    if stale:
        lines.append(f"== Stale pages (older than {STALE_DAYS} days) ==")
        for s in stale:
            lines.append(f"  {s}")
        lines.append("")

    lines.append("-" * 60)
    return "\n".join(lines)


def append_memory_log(mem_root: Path, ts: str, total: int, results: dict) -> None:
    """Append a summary line to <memory>/log.md."""
    o = len(results["orphans"])
    s = len(results["stale"])
    b = len(results["broken_links"])
    line = f"[{ts}] lint: {total} issues found (orphans={o} index_gaps={len(results['index_gaps'])} stale={s} broken_links={b})\n"
    try:
        with open(mem_root / "log.md", "a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError as exc:
        print(f"WARNING: could not write {mem_root / 'log.md'}: {exc}", file=sys.stderr)


def _notify_command(title: str, msg: str) -> list[str] | None:
    """Pick a desktop-notification command for the current OS, or None."""
    system = platform.system()
    if system == "Windows":
        msg_e = msg.replace("'", "`'")
        title_e = title.replace("'", "`'")
        ps = (
            "$ErrorActionPreference='Stop';"
            "if (Get-Command New-BurntToastNotification -ErrorAction SilentlyContinue) {"
            f" New-BurntToastNotification -Text '{title_e}', '{msg_e}' "
            "} else {"
            " Add-Type -AssemblyName System.Windows.Forms;"
            " $n=New-Object System.Windows.Forms.NotifyIcon;"
            " $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true;"
            f" $n.ShowBalloonTip(5000,'{title_e}','{msg_e}',[System.Windows.Forms.ToolTipIcon]::Info)"
            "}"
        )
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps]
    if system == "Darwin":
        script = f'display notification "{msg}" with title "{title}"'
        return ["osascript", "-e", script]
    # Linux / other: notify-send if present
    return ["notify-send", title, msg]


def notify(total: int, log_path: Path) -> None:
    """Fire a desktop notification if total > NOTIFY_THRESHOLD, else skip."""
    if total <= NOTIFY_THRESHOLD:
        return

    title = "Memory Lint"
    msg = f"{total} issues found in memory. Check {log_path}"
    cmd = _notify_command(title, msg)

    try:
        if not cmd:
            raise RuntimeError("no notifier for this platform")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "").strip() or f"exit {result.returncode}")
        print(f"[notify] Notification fired ({total} issues)")
    except Exception as exc:
        # Last resort: log that we would have notified
        print(f"[notify] WOULD_NOTIFY: {total} issues (notify failed: {exc})")
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(f"WOULD_NOTIFY: {total} issues (notifier unavailable: {exc})\n")
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Mechanical memory lint")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument(
        "--memory-root",
        type=Path,
        default=MEM_ROOT,
        help="Override memory root path",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=NOTIFY_THRESHOLD,
        help=f"Notify threshold (default {NOTIFY_THRESHOLD})",
    )
    args = parser.parse_args()

    if not args.once:
        print("Use --once to run. (No daemon mode implemented.)")
        return 1

    mem_root = args.memory_root
    threshold = args.threshold

    if not mem_root.exists():
        print(f"ERROR: memory root not found: {mem_root}", file=sys.stderr)
        return 2

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] Starting memory lint on {mem_root}")

    results = run_lint(mem_root)
    total = (
        len(results["orphans"])
        + len(results["index_gaps"])
        + len(results["broken_links"])
        + len(results["stale"])
    )

    report = build_report(results, ts)
    print(report)

    # Append to log
    with open(LOG_FILE, "a", encoding="utf-8") as fh:
        fh.write(report + "\n")

    # Append to <memory>/log.md
    append_memory_log(mem_root, ts, total, results)

    # Notify only if over threshold
    if total > threshold:
        notify(total, LOG_FILE)
    else:
        print(f"[notify] Skipped: {total} issues <= threshold {threshold}")

    print(f"[done] {total} total issues. Log: {LOG_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
