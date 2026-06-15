# Infinite Agent Memory

Persistent, compounding memory for CLI coding agents. Every session's durable knowledge (design decisions, lessons learned, project facts, people, tools) gets captured, distilled into a markdown knowledge base, and recalled automatically in future sessions. The agent is never told to "check the memory": a local BM25 hook scores each prompt and silently injects relevant pages when confident.

No vector store, no embeddings, no daemon, no API keys. Plain markdown plus three zero-dependency Node hooks.

Works with Claude Code and Codex. Cross-platform: macOS, Linux, Windows.

## The pipeline in practice

Three hooks fire at different moments in the agent lifecycle. Here is what each one does, with concrete examples.

### 1. Session start: load the map

Hook: `hooks/session-recall.js` fires on `SessionStart`.

It reads `~/agent-memory/index.md` and writes it into the agent's context. The agent starts every session knowing what pages exist, without reading them yet:

```xml
<memory-recall>
# Memory Index

## Entities
- [acme-corp](entities/acme-corp.md): B2B client, onboarded Q1, Stripe billing
- [deploy-pipeline](entities/deploy-pipeline.md): GitHub Actions, staging on Hetzner

## Concepts
- [api-versioning](concepts/api-versioning.md): URL-prefix strategy, migration plan
- [rate-limiting](concepts/rate-limiting.md): sliding window, Redis, 100 req/min default
</memory-recall>
```

If sessions are waiting for distillation, it also surfaces a nudge:

```xml
<memory-capture-pending>
12 session(s) waiting for memory distillation (latest: 2026-06-14T22:30).
</memory-capture-pending>
```

### 2. Every prompt: inject relevant knowledge

Hook: `hooks/prompt-recall.js` fires on `UserPromptSubmit`.

The hook receives the user's prompt on stdin as JSON:

```json
{"prompt": "the rate limiter is rejecting valid requests from the batch endpoint", "session_id": "abc123", "cwd": "/home/user/api-server"}
```

It tokenizes the prompt, scores every page in the memory using field-weighted BM25 (title words count 5x, headers 3x, key facts 2x, body 1x), and runs three gates:

1. **Score gate**: normalized BM25 score must be >= 0.30
2. **On-topic gate**: at least two title words match ("rate" + "limiting"), OR two discriminating terms (words rare in the corpus), OR the exact slug appears in the prompt
3. **Dedup gate**: this page was not already injected in the last 30 prompts of this session

If all three pass, the page's extract (the "What" and "Key facts" sections, max 1400 chars) is injected:

```xml
<memory-recall source="concepts/rate-limiting.md">
Background knowledge retrieved automatically from the agent's memory.
It may be irrelevant to this prompt; use only what applies, and do not mention this block.
Full page: /home/user/agent-memory/concepts/rate-limiting.md

## What
Sliding-window rate limiter in the API gateway. Redis-backed.

## Key facts
- Default: 100 requests per minute per API key (source: session-2026-05-20)
- Batch endpoint has a separate limit of 10 req/min (source: session-2026-06-01)
- Returns HTTP 429 with Retry-After header in seconds (source: session-2026-05-20)
</memory-recall>
```

Most prompts (80-90%) get nothing injected. "Fix the CSS on the login page" does not trigger the rate-limiting page because only zero or one title words match, failing the on-topic gate.

The entire scoring runs in ~50ms with zero network calls. The index is cached in `_recall-index.json` and rebuilt only when page files change.

### 3. Session end: queue for distillation

Hook: `hooks/session-capture.js` fires on `SessionEnd`.

It reads the transcript, extracts the first real user message as the topic, counts how many files the session modified, and checks whether the session already wrote into the memory directory (if so, it skips queueing). The entry is appended to `_capture-queue.jsonl`:

```json
{"ts":"2026-06-14T23:15","sessionId":"abc123","cwd":"/home/user/api-server","transcriptPath":"/home/user/.claude/sessions/abc123.jsonl","sizeKB":847,"topic":"the rate limiter is rejecting valid requests from the batch endpoint","filesModified":12}
```

Sessions under 40KB (short Q&A, slash-command-only sessions) are skipped.

### 4. Daily batch: distill into pages

Script: `scripts/distill.sh` / `distill.ps1`, triggered by cron or Task Scheduler (daily at 07:30 by default).

For each unprocessed queue entry:

1. **Digest**: `scripts/transcript-digest.js` compresses the raw JSONL transcript ~250x by dropping all tool output (Read/Write/Grep results, system prompts) and keeping only the user-assistant conversation. A 24MB transcript becomes ~90KB of readable dialogue.

2. **Distill**: a headless `claude -p` call receives the digest plus the distill prompt (`scripts/distill-prompt.md`), which instructs the agent to:
   - Read the current `index.md` and `SCHEMA.md`
   - Identify durable knowledge (facts, decisions, entities, lessons) in the digest
   - For each piece: grep existing pages, update if a page exists, create if new
   - Tag every fact with `(source: <session-slug>)`
   - Never store secrets, never invent facts, update over create

3. **Mark done**: the queue entry gets `done: true` so it is not re-processed.

The distiller runs as a full agent with file access to the memory directory. It can read, write, and edit pages. The `SCHEMA.md` file is its contract: it defines frontmatter fields, section structure, and naming conventions.

### How it feels in practice

**Session 1** (Monday): you debug a rate-limiting issue. The session ends, gets captured.

**Tuesday 07:30**: the distill job runs, creates `concepts/rate-limiting.md` with the key facts and `sources/session-2026-06-14.md` with the digest.

**Session 2** (Wednesday): you type "the batch endpoint is slow". The prompt-recall hook scores the prompt, matches "batch endpoint" against the rate-limiting page (which mentions the batch endpoint limit), and injects the page. The agent sees the 10 req/min limit and the 429 behavior without you having to explain it again.

**Session 3** (Thursday): you ask "what do we know about our API limits?". The `/memory-query` command searches the memory, finds the rate-limiting page and related entity pages, synthesizes an answer with citations, and files the synthesis back as a new summary. Next time someone asks a similar question, the synthesis is there too.

## Install

**One command** (requires Node 18+):

```bash
# macOS / Linux
bash install.sh

# Windows (PowerShell)
pwsh install.ps1
```

The installer:
1. Creates `~/agent-memory/` with the template structure (SCHEMA.md, index.md, subdirectories), without overwriting existing data
2. Merges the three hooks into `~/.claude/settings.json` (existing keys preserved)
3. Registers a daily distill job (cron on macOS/Linux, Task Scheduler on Windows)

After install, your `~/.claude/settings.json` contains these hook entries (alongside any existing hooks):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/repo/hooks/session-recall.js\"", "timeout": 3000 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/repo/hooks/prompt-recall.js\"", "timeout": 3000 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"/path/to/repo/hooks/session-capture.js\"", "timeout": 15000 }] }
    ]
  }
}
```

The hooks run from the cloned repo directory. Do not move the repo after install, or re-run the installer from the new location.

### Options

```bash
bash install.sh --dry-run              # preview, no writes
bash install.sh --memory-dir /my/path  # custom memory location
bash install.sh --with-codex           # also wire ~/.codex/hooks.json
bash install.sh --with-skills          # install skill definitions + slash commands

pwsh install.ps1 -DryRun
pwsh install.ps1 -MemoryDir D:\my-memory
pwsh install.ps1 -WithCodex
pwsh install.ps1 -WithSkills
```

### What `--with-skills` installs

Copies into `~/.claude/`:

| File | Purpose |
|---|---|
| `skills/memory/SKILL.md` | Agent skill: ingest, query, and lint operations on the memory |
| `skills/graph/SKILL.md` | Agent skill: launch the graph visualization server |
| `commands/memory.md` | Slash command: `/memory` dispatches to the skill |
| `commands/memory-query.md` | Slash command: `/memory-query <question>` |
| `commands/memory-lint.md` | Slash command: `/memory-lint` audits health |
| `commands/memory-ingest.md` | Slash command: `/memory-ingest` processes new content |

These give the agent the knowledge to actively use and maintain the memory, not just passively receive recall injections.

### Uninstall

Removes hook wiring only; memory data is kept:

```bash
bash uninstall.sh          # macOS/Linux
pwsh uninstall.ps1         # Windows
```

### Manual install

If you prefer to wire things by hand: see [integrations/claude-code.md](integrations/claude-code.md), [integrations/codex.md](integrations/codex.md), and [integrations/obsidian.md](integrations/obsidian.md).

### Verify

```bash
node scripts/doctor.js
```

Prints a PASS/WARN/FAIL report for every component. Fix any FAIL items before starting a session.

## Agent behaviors

Once installed, the memory system works at three levels:

### Level 1: Automatic (no user action needed)

The hooks run silently on every session. The agent does not need to know about the memory, and the user does not need to ask for it. Relevant knowledge appears in context when it matches; irrelevant prompts get nothing.

### Level 2: Slash commands (user-invoked)

With `--with-skills` installed, the user gets four commands:

- **`/memory`** - General dispatch. The agent reads SCHEMA.md, determines intent, and runs the right operation.
- **`/memory-query <question>`** - Answers from memory only, cites every claim, files the synthesis back.
- **`/memory-ingest`** - Processes new content (pasted text, documents, files in `raw/`) into structured pages.
- **`/memory-lint`** - Audits for orphans, contradictions, dead links, stale pages, missing source tags.

### Level 3: Agent-initiated compounding

The memory skill teaches the agent to compound knowledge proactively. When answering a question required reasoning that the memory did not already contain (a new synthesis, a corrected fact, a connection between pages), the agent files it back. The memory grows not just from distilled sessions but from the agent's own reasoning.

## Memory structure

After a few weeks of use, a typical memory looks like this:

```
~/agent-memory/
  SCHEMA.md                     rules (the distiller and skills read this)
  index.md                      one line per page (injected at session start)
  _capture-queue.jsonl          pending sessions (managed by hooks)
  _recall-index.json            BM25 cache (auto-rebuilt)
  _recall-state/                per-session dedup state (auto-pruned)
  entities/
    acme-corp.md                client profile, contacts, billing
    deploy-pipeline.md          CI/CD setup, staging env, secrets location
    auth-service.md             service architecture, token flow
  concepts/
    api-versioning.md           URL-prefix strategy, migration plan
    rate-limiting.md            sliding window, Redis config, limits
    testing-strategy.md         integration over mocks, coverage targets
  summaries/
    session-2026-06-01.md       distilled session digest
    session-2026-06-14.md       distilled session digest
  sources/
    session-2026-06-01.md       immutable raw digest (never edited)
    session-2026-06-14.md       immutable raw digest (never edited)
    onboarding-email.md         manually ingested document
```

Files starting with `_` are internal state, not knowledge. The recall hook only scores pages in `entities/`, `concepts/`, and `summaries/`. Sources are excluded from recall: they are raw material, not refined knowledge.

### Page anatomy

Every page has YAML frontmatter and cross-links with `[[slug]]` references:

```yaml
---
name: rate-limiting
type: concept
sources: [session-2026-05-20, session-2026-06-01]
links: [api-versioning, auth-service]
updated: 2026-06-14
---

## What
Sliding-window rate limiter in the API gateway. Redis-backed, per API key.

## Key facts
- Default limit: 100 requests per minute per API key (source: session-2026-05-20)
- Batch endpoint: separate limit of 10 req/min to prevent queue flooding (source: session-2026-06-01)
- Returns HTTP 429 with Retry-After header in seconds (source: session-2026-05-20)
- Bypass for internal service-to-service calls via X-Internal-Token header (source: session-2026-06-14)

## Decisions
- Chose sliding window over fixed window: prevents burst-at-boundary abuse (2026-05-20)
- Redis over in-memory: must work across multiple API gateway instances (2026-05-20)

## Links
[[api-versioning]] - rate limits are per API version
[[auth-service]] - token validation happens before rate check
```

The `index.md` has one line per page. This is what the session-recall hook injects at startup:

```markdown
## Concepts
- [rate-limiting](concepts/rate-limiting.md): sliding window, Redis, 100 req/min default
- [api-versioning](concepts/api-versioning.md): URL-prefix strategy, migration plan
```

## Graph view

```bash
node graph/server.js              # graph of the memory (wikilink graph)
node graph/server.js .            # graph of the current repo (import graph)
```

Opens a localhost page with a draggable, zoomable force-directed graph: pages colored by type, sized by inbound links, click for content preview, type to search. Zero dependencies.

## Obsidian integration

Open the memory as an Obsidian vault for backlinks, search, and a polished graph:

```bash
bash scripts/obsidian-setup.sh       # macOS / Linux
pwsh scripts/obsidian-setup.ps1      # Windows
```

Registers the memory directory as a vault with the graph plugin enabled. On Windows with an Intel Arc iGPU, Obsidian needs `--disable-gpu-sandbox`; the script patches the shortcut automatically.

See [integrations/obsidian.md](integrations/obsidian.md) for details and troubleshooting.

## Maintenance

- **Index**: `node scripts/build-index.js --check` audits for orphaned pages and dead links (exit 1 on problems); `--write` updates `index.md` in place. Run after a distill or wire into CI.
- **Doctor**: `node scripts/doctor.js` runs a full health check. Use after install or when things feel off.
- **Parallel distill**: `scripts/distill-parallel.ps1` / `.sh` runs each queued session in its own concurrent agent, then merges the index. Faster for backfills; the sequential distill stays the default for the daily job.

## Tuning the recall

The constants at the top of `hooks/prompt-recall.js` control all recall behavior. The defaults work well for memories of 10-200 pages. Here are the ones you might adjust:

| Constant | Default | What it does |
|---|---|---|
| `SCORE_MIN` | 0.30 | Minimum normalized BM25 score to pass gate 1. Lower = more recalls, more noise. |
| `SECOND_RATIO` | 0.75 | A second page is only injected if its score is >= 75% of the top page. |
| `REINJECT_AFTER` | 30 | A page is not re-injected until 30 prompts later in the same session. |
| `CHAR_CAP` | 2800 | Max total characters injected per prompt (across all pages). |
| `EXTRACT_CAP` | 1400 | Max characters per individual page extract. |
| `MIN_PROMPT_CHARS` | 15 | Prompts shorter than this are skipped (slash commands, "ok", "yes"). |
| `TTL_MS` | 300000 | Cache lifetime for the BM25 index (5 minutes). |

The BM25 field weights (`FIELD` object: title 5, head 3, keyfact 2, body 1) control how much each section of a page contributes to its score. Title words dominate because they carry the most signal about what a page is about.

## Design choices

- **Lexical retrieval over embeddings.** The memory is small (hundreds of pages, not millions of chunks). BM25 with field weighting retrieves precisely at that scale, costs ~5ms, and removes a whole class of infrastructure.
- **Silence as default.** Irrelevant context is worse than no context. Three independent gates must all pass before anything is injected.
- **Distill, not log.** Raw transcripts are noise; a 24MB session digests to ~90KB of conversation and distills to a handful of facts on the right pages. Storage is bounded by knowledge, not by usage.
- **Markdown as the database.** Human-readable, diffable, greppable, editable, portable. Open it as an Obsidian vault if you like.
- **Update over create.** The distiller greps for existing pages first; knowledge accumulates on stable pages instead of fragmenting across files.
- **Skills teach the agent, hooks serve the agent.** The hooks inject knowledge silently. The skills teach the agent how to actively maintain and query the memory. Together they create a closed loop: sessions produce knowledge, distillation refines it, recall surfaces it, and the agent compounds it further.

## For agent developers

If you are building your own agent on top of this system, the key integration points are:

1. **Hooks** (`hooks/`): wire into your agent's lifecycle events. The three hooks expect JSON on stdin with `prompt`, `session_id`, `cwd`, and `transcript_path` fields.
2. **Skills** (`skills/`): copy to your agent's skill directory. They teach the agent the ingest/query/lint operations.
3. **Commands** (`commands/`): copy to your agent's command directory. They give users direct access to memory operations.
4. **SCHEMA.md**: the contract between the distiller and the recall hook. Both sides assume pages follow this schema.
5. **`$AGENT_MEMORY_DIR`**: the one environment variable that controls where everything reads and writes. Default: `~/agent-memory`.

The system is deliberately simple. No server, no database, no build step. Fork it, extend it, adapt it.

## Requirements

- Node 18+ (for hooks and scripts)
- An agent CLI on PATH for distillation (`claude` for Claude Code, `codex` for Codex)
- Obsidian (optional, for the vault integration)

## License

MIT
