---
name: memory
description: Persistent agent memory at $AGENT_MEMORY_DIR (default ~/agent-memory). Use when the user wants to (1) add a document/email/note/transcript to long-term memory, (2) ask a question that memory may already answer, (3) check memory health. Triggers include "add to memory", "save this", "remember this", "what do we know about X", "lint the memory", and any time you would otherwise re-derive knowledge that could compound.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Memory - Persistent Agent Knowledge Base

Karpathy-style knowledge compounding. Three layers: raw sources, memory pages, this skill. Authoritative spec lives at `<memory-dir>/SCHEMA.md`, read it before doing anything.

## Locate the memory

```js
const memDir = process.env.AGENT_MEMORY_DIR || (os.homedir() + '/agent-memory');
```

In skill context: read `$AGENT_MEMORY_DIR` if set, otherwise `~/agent-memory`. All paths below are relative to this directory.

## First step always

Read `SCHEMA.md` and `index.md` in the memory directory. The schema defines conventions; the index tells you what already exists. Skip neither.

## Dispatch by user intent

| User says | Operation |
|---|---|
| "add this to memory", "save this", "remember this document/email/PDF" | **Ingest** |
| "what do we know about X", "search memory for Y", or any question that might be answered by existing pages | **Query** |
| "lint memory", "check memory health", "find orphans/contradictions" | **Lint** |

If unclear, ask which operation. Do not guess for ingest, getting the source slug wrong fragments the memory.

## Ingest

1. Save the raw input verbatim to `sources/<kebab-slug>.md` with frontmatter:
   ```yaml
   ---
   name: <slug>
   ingested: <YYYY-MM-DD>
   origin: <where it came from>
   ---
   ```
2. Write `summaries/<slug>.md`: 5-15 bullets, each with `(source: <slug>)` tag.
3. Identify entities (people, companies, products, projects) and concepts (recurring ideas, frameworks). For each:
   - Glob for existing page: `entities/<name>.md` or `concepts/<name>.md`
   - If exists: Edit, add new facts to `## Key facts`, append source to frontmatter `sources:`, bump `updated:`.
   - If new: Write with full frontmatter and section structure from SCHEMA.md.
4. Cross-link liberally: `[[other-slug]]` for any related page (existing or planned).
5. Update `index.md`: add one line per new page under the right section.
6. Report to the user: list of pages created/updated.

## Query

1. Read `index.md` to scope.
2. Grep titles and frontmatter for keywords from the user's question.
3. Read matched pages. Follow `[[links]]` one hop if the answer is incomplete.
4. Synthesize the answer. Cite pages: `(see [[slug]])`.
5. **Compound the memory**: if your reasoning produced new understanding the memory did not already contain, a synthesis across pages, a new fact looked up, a corrected misconception, file it back. Either:
   - Append to a relevant page's `## Key facts`, or
   - Create a new `concepts/<topic>.md` if it is a new recurring idea.
6. Briefly note to the user what you filed back, so they can correct if you over-saved.

## Lint

Run these checks against the memory directory:

- **Contradictions**: same entity, different stated facts. Grep entity names across pages, compare.
- **Orphans**: pages not in `index.md` AND not linked from any other page.
- **Dead links**: `[[slug]]` references that do not resolve to a real file.
- **Stale**: `updated:` > 6 months ago on fast-moving topics.
- **Source-less facts**: bullets in `## Key facts` without a `(source: ...)` tag.
- **Schema drift**: pages missing required frontmatter fields per SCHEMA.md.

Output as a checklist grouped by category. Do **not** auto-fix, present findings and ask which to address.

## Hard rules

- Never edit anything under `sources/` after ingest. Sources are immutable. If the source was wrong, create a new source and supersede.
- Never invent facts. If the memory does not say it, say so.
- Always include the `(source: <slug>)` tag when adding a fact.
- If a memory page disagrees with what the user just said, surface the disagreement before overwriting. The memory could be stale, or the user could be misremembering, let them choose.
- Never store secrets (API keys, tokens, passwords). Reference their location instead.
