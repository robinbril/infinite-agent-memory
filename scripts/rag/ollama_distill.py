"""
ollama_distill.py - Distill a local batch via Ollama and write output to <memory>/people/.

Use:
  python ollama_distill.py <batchfile> <memory_dir> [--model <name>] [--ollama-url http://localhost:11434]

For each session in the batch:
  - Ask Ollama for a summary of person-related knowledge.
  - Write the output to <memory_dir>/people/<slug>.md.

Sends NOTHING to an external API. This is the local route for high-PII sessions:
person notes stay on the machine.
"""

import argparse
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_MODEL = "llama3.1"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

SESSION_HDR = re.compile(
    r'^# === SESSION slug=(\S+) date=(\S+) cwd=(\S*) topic=(.*?) ===$',
    re.MULTILINE,
)

DISTILL_PROMPT_TEMPLATE = """You are a knowledge manager. Process the session summary below and extract ONLY person-related knowledge: facts about specific people, agreements, preferences, contact details, and similar personal context.

Write a concise summary in Markdown, max 300 words. Do NOT write technical details, project names, or code. Use the slug as the section header.

SESSION:
{content}

---
Now write the person-related knowledge as Markdown:"""


def split_sessions(batch_text: str) -> list[dict]:
    sessions = []
    positions = [(m.start(), m.end(), m.group(0), m.group(1), m.group(4))
                 for m in SESSION_HDR.finditer(batch_text)]
    for i, (start, end, hdr, slug, topic) in enumerate(positions):
        body_start = end
        body_end = positions[i + 1][0] if i + 1 < len(positions) else len(batch_text)
        sessions.append({
            "header": hdr,
            "slug": slug,
            "topic": topic,
            "body": batch_text[body_start:body_end].strip(),
        })
    return sessions


def ollama_generate(prompt: str, model: str, base_url: str) -> str:
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
            return data.get("response", "").strip()
    except urllib.error.URLError as exc:
        print(f"[ollama_distill] Ollama unreachable: {exc}", file=sys.stderr)
        return ""
    except Exception as exc:
        print(f"[ollama_distill] error calling Ollama: {exc}", file=sys.stderr)
        return ""


def slugify(text: str) -> str:
    return re.sub(r'[^a-z0-9\-_]', '-', text.lower())[:64].strip('-')


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Ollama distill to <memory>/people/")
    parser.add_argument("batchfile", help="Path to _distill-batch-local.md")
    parser.add_argument("memory_dir", help="Path to the memory dir (e.g. ~/agent-memory)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    args = parser.parse_args()

    batch_path = Path(args.batchfile)
    memory_dir = Path(args.memory_dir)
    people_dir = memory_dir / "people"

    if not batch_path.exists():
        print(f"[ollama_distill] batch not found: {batch_path}", file=sys.stderr)
        sys.exit(1)

    batch_text = batch_path.read_text(encoding="utf-8").strip()
    if not batch_text:
        print("[ollama_distill] batch is empty, nothing to do")
        sys.exit(0)

    sessions = split_sessions(batch_text)
    if not sessions:
        print("[ollama_distill] no sessions found")
        sys.exit(0)

    people_dir.mkdir(parents=True, exist_ok=True)
    written = 0

    for s in sessions:
        slug = slugify(s["slug"]) or "session"
        content = s["header"] + "\n" + s["body"]
        prompt = DISTILL_PROMPT_TEMPLATE.format(content=content[:4000])  # cap at 4K chars

        print(f"[ollama_distill] distilling {slug} via {args.model}...")
        result = ollama_generate(prompt, args.model, args.ollama_url)

        if not result:
            print(f"[ollama_distill] empty result for {slug}, skipping")
            continue

        out_path = people_dir / f"{slug}.md"
        header = f"# {s['topic'] or slug}\n\n_Source: session {s['slug']}_\n\n"
        out_path.write_text(header + result + "\n", encoding="utf-8")
        print(f"[ollama_distill] wrote: {out_path}")
        written += 1

    print(f"[ollama_distill] done: {written}/{len(sessions)} session(s) written to {people_dir}")


if __name__ == "__main__":
    main()
