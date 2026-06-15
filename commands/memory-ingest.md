---
name: memory-ingest
description: Process new raw content into the agent memory knowledge base. Creates source/concept/entity pages, cross-links them, updates the index. Usage: /memory-ingest (processes content from the current conversation or from raw/ directory)
---

# /memory-ingest

Process new content into the agent memory.

## Usage

`/memory-ingest` - ingest content from the current conversation context or `<memory-dir>/raw/` directory.

## Steps

1. Identify the content to ingest (pasted text, referenced document, or files in `raw/`)
2. For each new piece of content:
   - Save verbatim to `sources/<slug>.md` with frontmatter (`name`, `ingested`, `origin`)
   - Create `summaries/<slug>.md`: 5-15 bullets, each with `(source: <slug>)` tag
   - Identify entities and concepts the source mentions
   - For each: create or update the corresponding page in `entities/` or `concepts/`
   - Add `[[backlinks]]` from those pages to the new source
3. Update `index.md` with one-line entries for all new/updated pages

Where all paths are relative to `$AGENT_MEMORY_DIR` or `~/agent-memory`.

## Rules

- Raw files and sources are immutable. Never edit anything in `sources/` after ingest.
- Every source page must link to at least one concept or entity page.
- Keep summaries factual. No interpretation beyond what the source states.
- If a concept page already exists, add to it, do not create duplicates.
- Cross-link aggressively. An orphan page (nothing links to it) is a bug.
- Never store secrets. Reference their location instead.
