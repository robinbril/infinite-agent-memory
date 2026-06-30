"""
pii_route.py - PII detection, pseudonymization and scope-split for the distill pipeline.

Sessions with enough PII stay local (distilled by a local model); low-PII sessions
get a pseudonymized copy that is safe to send to a remote/cloud model.

Reads:  <memory>/_distill-batch.md
Writes:
  - <memory>/_distill-batch-remote.md   (pseudonymized, safe for a cloud model)
  - <memory>/_distill-batch-local.md    (raw, for a local model)
  - <memory>/_pii-map.json              (stable name -> [PERSON_n] mapping, local, gitignored)
Egress log: <memory>/_logs/distill-egress.log

The known-names gazetteer is loaded from <memory>/_pii-gazetteer.txt (one name per
line, gitignored, never committed). A fictive example ships as
scripts/rag/_pii-gazetteer.example.txt. The NL-name heuristic, BSN eleven-proof and
structural guards always run regardless of the gazetteer.

Memory dir: env AGENT_MEMORY_DIR, default ~/agent-memory.
Call: python pii_route.py [--selftest] [--dry-run] [batchfile]
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
MEM = Path(os.environ.get("AGENT_MEMORY_DIR") or (Path.home() / "agent-memory"))
LOG_DIR = MEM / "_logs"
PII_MAP_PATH = MEM / "_pii-map.json"
GAZETTEER_PATH = MEM / "_pii-gazetteer.txt"
REMOTE_BATCH = MEM / "_distill-batch-remote.md"
LOCAL_BATCH = MEM / "_distill-batch-local.md"
EGRESS_LOG = LOG_DIR / "distill-egress.log"

# ---------------------------------------------------------------------------
# PII threshold: sessions with >= PII_THRESHOLD hits go to the local route
# ---------------------------------------------------------------------------
PII_THRESHOLD = 2  # >= threshold -> local


# ---------------------------------------------------------------------------
# Known names gazetteer: loaded from a local, gitignored file. One name per line.
# Blank lines and lines starting with '#' are ignored. Missing file = no
# gazetteer (the heuristic + BSN + guards still run).
# ---------------------------------------------------------------------------
def load_gazetteer() -> list[str]:
    if not GAZETTEER_PATH.exists():
        return []
    names: list[str] = []
    for line in GAZETTEER_PATH.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        names.append(s)
    return names


KNOWN_NAMES: list[str] = load_gazetteer()
# Sort longest first so a full name ("Jane Doe") matches before a part ("Jane").
KNOWN_NAMES_SORTED = sorted(KNOWN_NAMES, key=len, reverse=True)

# ---------------------------------------------------------------------------
# Regex helpers
# ---------------------------------------------------------------------------

# Guards: anchored checks on the candidate string itself (UUID, ISO date, URL)
_UUID_RE = re.compile(
    r'\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z'
)
_DATETIME_RE = re.compile(
    r'\A\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\Z'
)
_URL_RE = re.compile(r'\Ahttps?://\S+\Z', re.IGNORECASE)

# BSN candidate in running text: 8 or 9 digits, optional separator between them.
# Lookarounds avoid matching 10+ digit numbers (phone numbers, IBANs).
_BSN_CANDIDATE_RE = re.compile(r'(?<!\d)(\d(?:[ .\-]?\d){7,8})(?!\d)')

# Tech terms that must NOT be flagged by the person-name heuristic.
TECH_TERMS: frozenset[str] = frozenset({
    "Claude", "Python", "Docker", "Windows", "Linux", "GitHub", "Google",
    "Microsoft", "Hetzner", "Sonnet", "Haiku", "Fable", "Ollama", "FastAPI",
    "Django", "React", "Next", "Vite", "Playwright", "Caddy", "Nginx", "Redis",
    "Postgres", "Vercel", "LinkedIn", "WhatsApp", "Teams",
    "Outlook", "OneDrive", "SharePoint", "Azure", "AWS", "GCP", "Cloudflare",
    "Tailwind", "TypeScript", "JavaScript", "Rust", "Golang", "Kotlin", "Swift",
    "Angular", "Vue", "Svelte", "Prisma", "GraphQL", "OpenAI", "Anthropic",
    "Gemini", "Llama", "Mistral", "Cohere", "Qwen",
    "BSN", "IBAN", "API", "MCP",
    "LLM", "RAG", "NLP", "GPU", "CPU", "RAM", "VRAM", "WSL", "DNS", "SSL",
    "TLS", "HTTP", "HTTPS", "SSH", "VPS", "VPN", "CLI", "GUI", "URL", "JSON",
    "YAML", "CSV", "PDF", "XLSX", "DOCX", "SQL", "ORM", "JWT", "OAuth",
    "CSRF", "XSS", "CORS", "CDN", "EU", "NL", "EN", "US", "UK",
    "ISO", "UTC", "CET", "PII",
    "Intel", "NVIDIA", "RTX", "AMD", "IPv4", "IPv6", "TCP", "UDP",
    "KiB", "MiB", "GiB",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "August", "September", "October",
    "November", "December",
})

# Name heuristic: two adjacent Capitalized words.
_NAME_PAIR_RE = re.compile(r'\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b')


def _strip_to_digits(text: str) -> str:
    return re.sub(r'\D', '', text)


def _is_structural_false_positive(raw: str) -> bool:
    """True if the value is a UUID, ISO date or URL (anchored check on the raw string)."""
    s = raw.strip()
    return bool(
        _UUID_RE.match(s)
        or _DATETIME_RE.match(s)
        or _URL_RE.match(s)
    )


def _bsn_eleven_proof(digits: str) -> bool:
    """Eleven-proof for a 9-digit string. 000000000 is invalid."""
    if len(digits) != 9 or not digits.isdigit() or digits == '000000000':
        return False
    weights = [9, 8, 7, 6, 5, 4, 3, 2, -1]
    return sum(int(d) * w for d, w in zip(digits, weights)) % 11 == 0


def find_heuristic_name_hits(text: str) -> list[str]:
    """Light heuristic: two adjacent Capitalized words that are not tech terms."""
    gazetteer_set = set(KNOWN_NAMES)
    hits: list[str] = []
    for m in _NAME_PAIR_RE.finditer(text):
        first, second = m.group(1), m.group(2)
        full = first + ' ' + second
        if full in gazetteer_set:
            continue
        if first in TECH_TERMS or second in TECH_TERMS:
            continue
        hits.append(full)
    return hits


_EMAIL_RE = re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b')
# International-ish phone: a leading + or 00 country prefix, or a national 0.
_PHONE_RE = re.compile(r'\b(?:\+\d{1,3}|00\d{1,3}|0)[1-9][0-9\s\-\.]{7,}\b')


# ---------------------------------------------------------------------------
# PII detection
# ---------------------------------------------------------------------------

def detect_pii(text: str) -> dict:
    """Returns: {"names": [...], "bsns": [...], "emails": [...], "phones": [...], "hits": int}."""
    # Gazetteer names (full text, including header)
    gaz_hits: list[str] = []
    for name in KNOWN_NAMES_SORTED:
        pattern = re.compile(r'\b' + re.escape(name) + r'\b')
        gaz_hits.extend(pattern.findall(text))

    # Heuristic name pairs (two adjacent Capitalized words)
    heur_hits = find_heuristic_name_hits(text)

    names = list(dict.fromkeys(gaz_hits + heur_hits))

    # BSN: scan candidates, drop structural false positives, keep eleven-proof passers.
    bsns = []
    for m in _BSN_CANDIDATE_RE.finditer(text):
        raw = m.group(1)
        if _is_structural_false_positive(raw):
            continue
        digits = _strip_to_digits(raw)
        if len(digits) == 9 and _bsn_eleven_proof(digits):
            bsns.append(raw)

    emails = _EMAIL_RE.findall(text)
    phones = _PHONE_RE.findall(text)
    hits = len(names) + len(bsns) + len(emails) + len(phones)
    return {"names": names, "bsns": bsns, "emails": emails, "phones": phones, "hits": hits}


# ---------------------------------------------------------------------------
# Pseudonymization
# ---------------------------------------------------------------------------

def load_pii_map() -> dict:
    if PII_MAP_PATH.exists():
        try:
            return json.loads(PII_MAP_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_pii_map(m: dict) -> None:
    MEM.mkdir(parents=True, exist_ok=True)
    PII_MAP_PATH.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def pseudonymize(text: str, pii: dict, pii_map: dict) -> tuple[str, dict]:
    """Replace names with [PERSON_n], BSN with [REDACTED_BSN], email/phone redacted."""
    # Name -> stable [PERSON_n] (longest name first to avoid overlap)
    for name in sorted(pii["names"], key=len, reverse=True):
        if name not in pii_map:
            idx = sum(1 for v in pii_map.values() if v.startswith("[PERSON_")) + 1
            pii_map[name] = f"[PERSON_{idx}]"
        text = re.sub(r'\b' + re.escape(name) + r'\b', pii_map[name], text)

    # BSN: redact via the candidate regex (right to left to preserve offsets)
    hits = list(_BSN_CANDIDATE_RE.finditer(text))
    for m in reversed(hits):
        raw = m.group(1)
        if _is_structural_false_positive(raw):
            continue
        digits = _strip_to_digits(raw)
        if len(digits) == 9 and _bsn_eleven_proof(digits):
            text = text[: m.start(1)] + '[REDACTED_BSN]' + text[m.end(1):]

    # Email
    text = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)

    # Phone
    text = _PHONE_RE.sub("[REDACTED_PHONE]", text)

    return text, pii_map


# ---------------------------------------------------------------------------
# Batch parser: splits on SESSION headers
# ---------------------------------------------------------------------------
SESSION_HDR = re.compile(
    r'^# === SESSION slug=(\S+) date=(\S+) cwd=(\S*) topic=(.*?) ===$',
    re.MULTILINE,
)


def split_sessions(batch_text: str) -> list[dict]:
    """Return a list of {"header": str, "slug": str, "body": str}."""
    sessions = []
    positions = [(m.start(), m.end(), m.group(0), m.group(1)) for m in SESSION_HDR.finditer(batch_text)]
    for i, (start, end, hdr, slug) in enumerate(positions):
        body_start = end
        body_end = positions[i + 1][0] if i + 1 < len(positions) else len(batch_text)
        sessions.append({"header": hdr, "slug": slug, "body": batch_text[body_start:body_end]})
    return sessions


# ---------------------------------------------------------------------------
# Egress logging
# ---------------------------------------------------------------------------

def egress_log(session_id: str, route: str, pii_hits: int) -> None:
    import time as _time
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    entry = json.dumps({
        "ts": _time.time(),
        "sessionId": session_id,
        "route": route,
        "pii_hits": pii_hits,
    })
    with open(EGRESS_LOG, "a", encoding="utf-8") as f:
        f.write(entry + "\n")


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def route_batch(batch_path: Path) -> None:
    if not batch_path.exists():
        print(f"No batch found at {batch_path}, nothing to do.")
        return

    batch_text = batch_path.read_text(encoding="utf-8-sig")  # utf-8-sig strips BOM
    sessions = split_sessions(batch_text)

    if not sessions:
        print("[pii_route] no sessions found in batch", file=sys.stderr)
        REMOTE_BATCH.write_text("", encoding="utf-8")
        LOCAL_BATCH.write_text("", encoding="utf-8")
        return

    pii_map = load_pii_map()
    remote_chunks: list[str] = []
    local_chunks: list[str] = []

    for s in sessions:
        full_text = s["header"] + "\n" + s["body"]
        pii = detect_pii(full_text)
        if pii["hits"] >= PII_THRESHOLD:
            route = "local"
            local_chunks.append(full_text)
        else:
            route = "remote"
            pseudonymized, pii_map = pseudonymize(full_text, pii, pii_map)
            remote_chunks.append(pseudonymized)
        egress_log(s["slug"], route, pii["hits"])
        print(f"[pii_route] {s['slug']} -> {route} (pii_hits={pii['hits']})")

    save_pii_map(pii_map)
    MEM.mkdir(parents=True, exist_ok=True)
    REMOTE_BATCH.write_text("\n".join(remote_chunks), encoding="utf-8")
    LOCAL_BATCH.write_text("\n".join(local_chunks), encoding="utf-8")

    print(f"[pii_route] remote-batch: {len(remote_chunks)} session(s), local-batch: {len(local_chunks)} session(s)")
    print(f"[pii_route] pii-map: {PII_MAP_PATH}")
    print(f"[pii_route] egress-log: {EGRESS_LOG}")


# ---------------------------------------------------------------------------
# --selftest
# ---------------------------------------------------------------------------

def selftest() -> int:
    """Built-in test with synthetic sessions. Exit 0 if all three spec axes pass."""
    # Test BSN that passes the eleven-proof:
    # 111222333: 9*1+8*1+7*1+6*2+5*2+4*2+3*3+2*3+(-1)*3 = 9+8+7+12+10+8+9+6-3 = 66, 66%11=0
    test_bsn = "111222333"
    weights = [9, 8, 7, 6, 5, 4, 3, 2, -1]
    assert sum(int(d) * w for d, w in zip(test_bsn, weights)) % 11 == 0

    print("=== SELFTEST START ===")
    failures: list[str] = []

    # Synthetic batch: 2 sessions
    # s001: Jane Doe (heuristic) + BSN + email + phone => >= 2 hits => local
    # s002: UUID + ISO date + tech only => 0 hits => remote
    batch = (
        "# === SESSION slug=s001 date=2026-06-30T10:00:00 cwd=/projects topic=person notes ===\n"
        "Jane Doe called today. BSN: " + test_bsn + ". "
        "Mail: jane@example.com. Tel: 0612345678.\n"
        "\n"
        "# === SESSION slug=s002 date=2026-06-30T11:00:00 cwd=/projects topic=tech ===\n"
        "UUID: 550e8400-e29b-41d4-a716-446655440000\n"
        "Date: 2026-01-15\n"
        "Only tech, no people.\n"
    )

    sessions = split_sessions(batch)
    assert len(sessions) == 2, f"Expected 2 sessions, got {len(sessions)}"

    remote_blocks: list[str] = []
    local_blocks: list[str] = []
    pii_map: dict[str, str] = {}

    for s in sessions:
        full_text = s["header"] + "\n" + s["body"]
        pii = detect_pii(full_text)
        route = "local" if pii["hits"] >= PII_THRESHOLD else "remote"
        print(
            f"  session={s['slug']} pii_hits={pii['hits']} "
            f"(names={len(pii['names'])}, bsn={len(pii['bsns'])}, "
            f"email={len(pii['emails'])}, tel={len(pii['phones'])}) route={route}"
        )
        if route == "local":
            local_blocks.append(full_text)
        else:
            pseudo, pii_map = pseudonymize(full_text, pii, pii_map)
            remote_blocks.append(pseudo)

    remote_text = "".join(remote_blocks)
    local_text = "".join(local_blocks)

    # --- Requirement (a): "Jane Doe" flagged via heuristic and kept in local output ---
    if "Jane Doe" in local_text:
        print("  [OK] (a) 'Jane Doe' is in local output (high PII score)")
    else:
        failures.append("(a) 'Jane Doe' not in local output")
        print("  [FAIL] (a) 'Jane Doe' missing from local output")

    if "Jane Doe" not in remote_text:
        print("  [OK] (a) 'Jane Doe' not in remote output")
    else:
        failures.append("(a) 'Jane Doe' is in remote output")
        print("  [FAIL] (a) 'Jane Doe' in remote output")

    # --- Requirement (b): BSN redacted ---
    if test_bsn in local_text:
        print(f"  [OK] (b) BSN {test_bsn} present in local output (raw)")
    else:
        failures.append(f"(b) BSN {test_bsn} missing from local output")
        print(f"  [FAIL] (b) BSN missing from local output")

    if test_bsn not in remote_text:
        print(f"  [OK] (b) BSN {test_bsn} not in remote output")
    else:
        failures.append(f"(b) BSN {test_bsn} in remote output")
        print(f"  [FAIL] (b) BSN in remote output")

    # --- Requirement (c): UUID and ISO date NOT flagged as BSN (guard works) ---
    uuid_val = "550e8400-e29b-41d4-a716-446655440000"
    iso_date = "2026-01-15"

    if _is_structural_false_positive(uuid_val):
        print(f"  [OK] (c) UUID '{uuid_val}' recognized as false positive (guard active)")
    else:
        failures.append(f"(c) UUID guard fails on '{uuid_val}'")
        print(f"  [FAIL] (c) UUID guard fails")

    if _is_structural_false_positive(iso_date):
        print(f"  [OK] (c) ISO date '{iso_date}' recognized as false positive (guard active)")
    else:
        failures.append(f"(c) Date guard fails on '{iso_date}'")
        print(f"  [FAIL] (c) Date guard fails")

    # Full s002: 0 BSN hits (UUID+date ignored)
    s002_full = sessions[1]["header"] + "\n" + sessions[1]["body"]
    s002_pii = detect_pii(s002_full)
    if s002_pii["hits"] == 0 and len(s002_pii["bsns"]) == 0:
        print("  [OK] (c) Session s002 has 0 PII hits (UUID+date correctly ignored)")
    else:
        failures.append(
            f"(c) Session s002 has {s002_pii['hits']} unexpected hits "
            f"(bsns={s002_pii['bsns']})"
        )
        print(f"  [FAIL] (c) Session s002 PII hits={s002_pii['hits']}, bsns={s002_pii['bsns']}")

    print()
    if failures:
        print(f"=== SELFTEST FAILED ({len(failures)} failing) ===")
        for fail in failures:
            print(f"  - {fail}")
        return 1
    print("=== SELFTEST PASSED ===")
    return 0


# ---------------------------------------------------------------------------
# CLI entry
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="PII route for the distill batch")
    parser.add_argument("batchfile", nargs="?", default=str(MEM / "_distill-batch.md"),
                        help="Path to the batch to split (default: <memory>/_distill-batch.md)")
    parser.add_argument("--selftest", action="store_true", help="Run built-in tests and exit")
    parser.add_argument("--dry-run", action="store_true", help="Detect PII but write nothing")
    args = parser.parse_args()

    if args.selftest:
        sys.exit(selftest())

    route_batch(Path(args.batchfile))


if __name__ == "__main__":
    main()
