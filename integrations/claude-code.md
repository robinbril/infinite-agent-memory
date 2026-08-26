# Claude Code integration

Three hooks wire the memory into every Claude Code session, in every project directory. No instructions to the model needed: recall is automatic.

## 1. Create the memory

```
mkdir ~/agent-memory
cp -r <repo>/memory/* ~/agent-memory/
```

Or set `AGENT_MEMORY_DIR` to another location (add it to your shell profile AND to the `env` block in settings.json so hooks see it).

Keep the memory OUTSIDE `~/.claude`: Claude Code treats paths under `~/.claude` as sensitive and blocks headless writes there, which would force the distill run through workarounds.

## 2. Register the hooks

Merge into `~/.claude/settings.json` (replace `<repo>` with the absolute path to this repository; on Windows, escape backslashes):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [
        { "type": "command", "command": "node \"<repo>/hooks/session-recall.js\"", "timeout": 3000 }
      ]}
    ],
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "node \"<repo>/hooks/prompt-recall.js\"", "timeout": 3000 }
      ]}
    ],
    "SessionEnd": [
      { "hooks": [
        { "type": "command", "command": "node \"<repo>/hooks/session-capture.js\"", "timeout": 15000 }
      ]}
    ]
  }
}
```

If `node` is not on the PATH that Claude Code uses, write the full path to the node executable.

## 3. Schedule the distill

Windows (Task Scheduler):

```powershell
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\distill.ps1"'
$t = New-ScheduledTaskTrigger -Daily -At 07:30
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Memory-Distill-daily' -Action $a -Trigger $t -Settings $s
```

macOS/Linux (cron):

```
30 7 * * * /path/to/repo/scripts/distill.sh
```

The distill calls `claude -p` headless on your existing CLI login. Override the agent command with `DISTILL_AGENT_CMD` if you want different flags or a different agent.

## 4. Verify

```
echo '{"prompt":"<a question about something in your memory>","session_id":"t1","cwd":"/tmp"}' | node <repo>/hooks/prompt-recall.js
```

A relevant page should print inside `<memory-recall>` tags. A generic prompt ("ok go ahead") should print nothing: silence is the designed default.

## 5. Memory for subagents

`prompt-recall.js` feeds the main session. A subagent or delegate spawned on another model/seat starts with zero memory. `scripts/memory-slice.js` closes that gap: it scores a prompt file with the same BM25 over `_recall-index.json` and emits the top matching page extracts, so the orchestrator can prepend them to the worker's prompt.

```
node scripts/memory-slice.js <promptfile> [out.md]
```

No `out.md`: the slice goes to stdout. With `out.md`: the slice is written there and its path is echoed. Tune with `MEMORY_SLICE_TOP` (default 4), `MEMORY_SLICE_MIN` (default 3.0), `MEMORY_SLICE_MAXCHARS` (default 9000). It reads the same `$AGENT_MEMORY_DIR/_recall-index.json` the hook maintains, so no extra build step. It always exits 0: a missing index or unreadable file writes nothing and never breaks the delegation.

## 6. Optional: dense recall upgrade

The BM25 core needs nothing beyond Node. If you want semantic recall on top (paraphrased prompts that share no keywords with a page), the `scripts/rag/` Python module adds a local embedding layer that fuses with BM25 via reciprocal-rank fusion.

Quick version:

```bash
pip install fastembed numpy
python scripts/rag/build_index.py          # build the vector index (_vec.json)
python scripts/rag/embed_server.py         # start the local embed service (keep running)
```

Then enable fusion by adding the flag to the `env` block in `~/.claude/settings.json`:

```json
{ "env": { "AGENT_MEMORY_DENSE": "1" } }
```

The hook stays exactly the BM25 behaviour when the flag is unset, and falls back to BM25 if the embed service or `_vec.json` is unavailable. Full setup, PII routing, and scheduling: [scripts/rag/README.md](../scripts/rag/README.md).
