---
name: memory-lint
description: Audit the agent memory for orphan pages, missing index entries, contradictions, stale content, and broken wikilinks. Outputs a structured report. Run periodically to keep the knowledge base healthy.
---

# /memory-lint

Audit the agent memory for orphans, contradictions, and stale content.

## Steps

1. **Orphan check**: Find pages in the memory with no inbound links. List them.
2. **Index gap check**: Find pages not listed in `index.md`. Add missing entries.
3. **Contradiction scan**: Read all concept and entity pages. Flag any claims that contradict each other. Report: `[CONFLICT] page-a.md says X, page-b.md says Y`
4. **Staleness check**: Flag pages with `updated:` frontmatter older than 90 days that reference fast-moving topics (frameworks, APIs, tools)
5. **Link rot check**: Find `[[wikilinks]]` that point to pages that do not exist yet
6. Output a lint report with sections: Orphans, Index gaps, Conflicts, Stale pages, Broken links

Where all paths are relative to `$AGENT_MEMORY_DIR` or `~/agent-memory`.

## What to do with findings

- Orphans: usually means the ingest step missed cross-linking. Fix the source page.
- Conflicts: do not auto-resolve. Flag for human review.
- Stale: add `status: needs-review` frontmatter.
- Broken links: either create the missing page stub or remove the link.
