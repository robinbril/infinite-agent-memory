# Codex CLI integration

Codex has no hook system, so the memory is wired through `AGENTS.md` (read at session start) plus the same distill pipeline.

## 1. Create the memory

Same as Claude Code: copy `memory/` to `~/agent-memory` (or set `AGENT_MEMORY_DIR`). One memory serves both agents; knowledge captured by Claude Code sessions is readable by Codex and vice versa.

## 2. AGENTS.md snippet

Add to your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`):

```markdown
## Persistent memory

A local knowledge base lives at `~/agent-memory` (markdown pages, schema in SCHEMA.md).

- At the start of a task, read `~/agent-memory/index.md` to see what is known.
- Before answering questions about past work, projects, decisions or gotchas, grep
  `~/agent-memory/entities` and `~/agent-memory/concepts` for relevant pages and read them.
- When you learn something durable (a design decision, a lesson, a project fact),
  fold it into the memory following `~/agent-memory/SCHEMA.md`: update an existing
  page when one exists, otherwise create one, and keep `index.md` current.
- Never store secrets in the memory.
```

## 3. Optional: recall preview from the shell

The recall scorer works standalone. To see what the memory knows about a topic:

```
echo '{"prompt":"<your question>","session_id":"shell","cwd":"."}' | node <repo>/hooks/prompt-recall.js
```

Wire that into any shell alias or wrapper you like.

## 4. Distill Codex sessions

Codex session logs live under `~/.codex/sessions` as JSONL. The capture hook is Claude Code-specific, but the distill runner is agent-agnostic: append entries to `~/agent-memory/_capture-queue.jsonl` yourself, e.g.

```json
{"ts":"2026-01-15T10:00","sessionId":"<id>","cwd":"<project>","transcriptPath":"<path to jsonl>","topic":"<short description>"}
```

then run `scripts/distill.sh` (or `.ps1`). The digester reads any JSONL with `type: user|assistant` message entries; for other formats, pre-digest to plain text and adapt `transcript-digest.js`.

To distill with Codex instead of Claude Code, set:

```
DISTILL_AGENT_CMD='codex exec --full-auto'
```
