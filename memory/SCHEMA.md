# Memory Schema

This is a persistent, compounding knowledge base in plain markdown. No RAG, no vector store, no embeddings: the agent reads it, updates it, and uses it to answer questions. Retrieval is handled by a local BM25 hook that injects relevant pages automatically.

## Three layers

1. **`sources/`**: immutable distilled documents. Never edited after ingest. Examples: distilled session digests, pasted emails, meeting notes, transcripts.
2. **Memory pages**: agent-generated and maintained.
   - `entities/`: pages about specific people, companies, products, projects (one file per entity).
   - `concepts/`: pages about recurring topics, frameworks, design decisions, lessons learned (one file per concept).
   - `summaries/`: per-source distillations (one file per source).
3. **This `SCHEMA.md`**: the rules. Defines conventions, frontmatter, and operations.

## File conventions

Every memory page (`entities/`, `concepts/`, `summaries/`) starts with frontmatter:

```yaml
---
name: short-kebab-slug
type: entity | concept | summary
sources: [source-slug-1, source-slug-2]
links: [other-page-slug]
updated: 2026-01-15
---
```

Body uses these section headers when relevant:
- `## What`: short, neutral definition
- `## Why it matters`: why this is worth remembering
- `## Key facts`: bullet list, each fact ending with a `(source: source-slug)` tag
- `## Decisions`: for design decisions: what was decided, rejected alternatives, reason, date
- `## Open questions`: gaps to investigate next
- `## Links`: `[[other-page]]` references

Sources have minimal frontmatter (`name`, `ingested`, `origin`) and contain distilled text.

## index.md

Top-level index, one line per page: `- [Title](path/file.md): one-line hook`. Keep under 200 lines. When it overflows, split into per-type indices.

## Three operations

### Ingest
Add new knowledge to the memory.

1. Save distilled text to `sources/<slug>.md` with frontmatter.
2. Create `summaries/<slug>.md`: 5-15 bullet distillation, each bullet with the source reference.
3. For each entity/concept the source mentions:
   - If a page exists: update it. Add new facts, append to `sources:` frontmatter, bump `updated:`.
   - If not: create a new page in `entities/` or `concepts/`.
4. Update `index.md` with any new pages.
5. Cross-link: every new fact should link to other pages via `[[slug]]` where natural.

### Query
Answer a question using the memory.

1. Read `index.md` first to locate relevant pages.
2. Read those pages. Follow `[[links]]` one hop if needed.
3. Synthesise the answer. Cite pages used.
4. If the answer required reasoning the memory did not already contain, file the new understanding back as a `concepts/` page or a `## Key facts` update. The memory compounds.

### Lint
Health-check the memory.

- **Contradictions**: same fact stated differently across pages.
- **Orphans**: pages not referenced from `index.md` or any other page.
- **Dead links**: `[[slug]]` references to nonexistent pages.
- **Stale**: pages with `updated:` older than 6 months that still appear in active queries.
- **Source gaps**: facts without a `(source: ...)` tag.
- **Schema drift**: pages missing required frontmatter fields.

Report findings as a checklist. Do not auto-fix without user approval.

## What this is NOT

- Not a search engine. The agent reads pages directly; the recall hook handles relevance.
- Not a database. No queries, no joins, no schema enforcement beyond convention.
- Not a chat log. Only durable knowledge goes in; the capture/distill pipeline filters.

## Secrets

Never store tokens, API keys, passwords, bearer values, cookies, or service keys. Reference their location instead ("the key lives in the project's .env").
