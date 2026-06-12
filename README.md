# Infinite Agent Memory

Persistent, compounding memory for CLI coding agents (Claude Code, Codex). Every session's durable knowledge, design decisions, lessons learned, project facts, gets captured, distilled into a markdown knowledge base, and recalled automatically in future sessions. The model is never told to "check the memory": a local BM25 hook decides per prompt whether stored knowledge is relevant and injects it silently.

No vector store, no embeddings, no daemon, no API keys. Plain markdown plus three zero-dependency Node hooks.

## How it works

```
CAPTURE (session end, free)        DISTILL (daily batch, headless)      RECALL (per prompt, local, ~50ms)
session ends -> rich queue entry -> agent run folds digests into     -> BM25 hook injects the 1-2 relevant
  (topic, size, files touched)      entities/concepts/sources            pages into the prompt context
```

**Capture** (`hooks/session-capture.js`): at session end, substantial sessions (>40KB transcript) are queued with their topic, size and files-touched count. Sessions that already wrote into the memory are skipped.

**Distill** (`scripts/distill.ps1` / `distill.sh`): a scheduled batch compresses each queued transcript ~250x (tool output dropped, conversation kept), bundles a batch, and runs a headless agent that folds durable knowledge into the memory following `SCHEMA.md`: update existing pages over creating new ones, every fact source-tagged, secrets banned.

**Recall**, the part that makes it feel infinite:
- At session start, `hooks/session-recall.js` injects the index: the map of what is known.
- On every prompt, `hooks/prompt-recall.js` scores all pages with field-weighted BM25 (title 5x, headers 3x, key facts 2x) against the prompt plus the working directory name, and injects the top 1-2 pages, with three gates that make silence the default: a score threshold, an on-topic requirement (two title-word matches, two discriminating terms, or an exact entity name), and per-session dedup. Typical cost: ~50ms, zero on trivial prompts, nothing injected on 80-90% of prompts.

Knowledge compounds across sessions, projects and agents: one memory serves every directory you work in, and both Claude Code and Codex.

## Memory structure

```
~/agent-memory/
├── SCHEMA.md        the rules (frontmatter, sections, ingest/query/lint operations)
├── index.md         one line per page, injected at session start
├── entities/        people, companies, products, projects
├── concepts/        recurring topics, frameworks, design decisions, lessons
├── summaries/       per-source distillations
└── sources/         immutable distilled documents
```

Pages carry YAML frontmatter (`name`, `type`, `sources`, `links`, `updated`) and cross-link with `[[slug]]` references. The graph viewer renders those links.

## Install

1. `mkdir ~/agent-memory && cp -r memory/* ~/agent-memory/` (or set `AGENT_MEMORY_DIR`).
2. Wire the hooks: [integrations/claude-code.md](integrations/claude-code.md) for Claude Code (settings.json), [integrations/codex.md](integrations/codex.md) for Codex (AGENTS.md).
3. Schedule the distill (Task Scheduler or cron), same docs.

Requirements: Node 18+, and the agent CLI you distill with on PATH.

## Graph view

```
node graph/server.js              # graph of the memory (wikilink graph)
node graph/server.js .            # graph of the current repo (import graph)
```

Opens a localhost page with a draggable, zoomable force-directed graph: pages colored by type, sized by inbound links, click for content preview, type to search.

## Design choices

- **Lexical retrieval over embeddings.** The memory is small (hundreds of pages, not millions of chunks). BM25 with field weighting retrieves precisely at that scale, costs ~5ms, and removes a whole class of infrastructure. The hook's job is not search, it is deciding when NOT to inject.
- **Silence as default.** Irrelevant context is worse than no context. Three independent gates must all pass before anything is injected.
- **Distill, not log.** Raw transcripts are noise; a 24MB session digests to ~90KB of conversation and distills to a handful of facts on the right pages. Storage is bounded by knowledge, not by usage.
- **Markdown as the database.** Human-readable, diffable, greppable, editable, portable. Open it as an Obsidian vault if you like.
- **Update over create.** The distiller greps for existing pages first; knowledge accumulates on stable pages instead of fragmenting across files.

## License

MIT
