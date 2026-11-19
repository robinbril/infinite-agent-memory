# Codex integration

Codex has a hook system (GA May 2026) with `SessionStart`, `UserPromptSubmit`, and `Stop` events. These map onto all three memory functions, but the output contract differs from Claude Code in two places. Read this file before wiring anything.

## How Codex hooks differ from Claude Code

| Aspect | Claude Code | Codex |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.codex/hooks.json` |
| Context injection (SessionStart, UserPromptSubmit) | Raw text to stdout gets prepended to the prompt | The adapters return JSON to stdout: `{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "<text>"}}` |
| Prompt text in stdin | `input.prompt` (string) | `input.prompt` (string). The adapter can fall back to the transcript on older clients. |
| Transcript format | JSONL with `type: "user"` / `type: "assistant"` top-level entries | JSONL with `type: "response_item"` entries; user messages live at `payload.role === "user"` |
| Windows support | Full | Full (use `command_windows` alongside `command` for PowerShell paths) |
| Hook trust | Auto-trusted via settings.json | First run asks you to review and approve the hook hash |

## What works and what needs adapting

### 1. session-recall.js (SessionStart) - works with output wrapper

The hook fires at session start and receives `session_id`, `cwd`, and `transcript_path` on stdin. `session-recall.js` reads the memory index and writes raw text to stdout. Codex ignores raw stdout from SessionStart hooks; you must wrap it in the `additionalContext` JSON envelope.

**Adapter**: pipe `session-recall.js` output into a one-liner that wraps it:

```json
// ~/.codex/hooks.json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<repo>/integrations/codex-session-recall-adapter.js\"",
            "command_windows": "node \"<repo>\\integrations\\codex-session-recall-adapter.js\"",
            "timeout": 5,
            "statusMessage": "Loading memory index..."
          }
        ]
      }
    ]
  }
}
```

`codex-session-recall-adapter.js` (create in `integrations/`):

```js
#!/usr/bin/env node
// Wraps session-recall.js output in the additionalContext envelope Codex expects.
const { execSync } = require('child_process');
const path = require('path');
const raw = process.stdin.read() || '';
const repoDir = path.join(__dirname, '..');
let ctx = '';
try {
  ctx = execSync(`node "${path.join(repoDir, 'hooks', 'session-recall.js')}"`, {
    input: raw, encoding: 'utf8', timeout: 4000
  });
} catch (_) {}
if (ctx.trim()) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.trim() }
  }));
}
process.exit(0);
```

### 2. Prompt recall on UserPromptSubmit

The [Codex adapter](codex-prompt-recall-adapter.js) passes the current `input.prompt` to the recall hook. Older clients that omit the field can fall back to the latest user message in the transcript. The adapter returns relevant excerpts in `hookSpecificOutput.additionalContext`. [Codex hook reference](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)

Register it:

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"<repo>/integrations/codex-prompt-recall-adapter.js\"",
        "command_windows": "node \"<repo>\\integrations\\codex-prompt-recall-adapter.js\"",
        "timeout": 5,
        "statusMessage": "Recalling memory..."
      }
    ]
  }
]
```

### 3. session-capture.js (Stop) - works directly

Stop hook stdin delivers `session_id`, `cwd`, and `transcript_path`. `session-capture.js` reads exactly those fields and writes only to the queue file (no stdout), so it is compatible as-is.

One caveat: the internal scan in `session-capture.js` looks for `type: "user"` and `type: "assistant"` entries, but Codex uses `type: "response_item"` with `payload.role`. The topic and `wroteToMemory` fields will be empty/false for Codex transcripts, meaning every session above the size threshold will be queued. This is safe (the distiller handles empty topics) but slightly noisy.

Register it directly:

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"<repo>/hooks/session-capture.js\"",
        "command_windows": "node \"<repo>\\hooks\\session-capture.js\"",
        "timeout": 15,
        "statusMessage": "Queueing session for memory distillation..."
      }
    ]
  }
]
```

## Full hooks.json template

Replace `<repo>` with the absolute path to this repository. On Windows, backslashes in `command_windows` must be escaped as `\\`.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<repo>/integrations/codex-session-recall-adapter.js\"",
            "command_windows": "node \"<repo>\\integrations\\codex-session-recall-adapter.js\"",
            "timeout": 5,
            "statusMessage": "Loading memory index..."
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<repo>/integrations/codex-prompt-recall-adapter.js\"",
            "command_windows": "node \"<repo>\\integrations\\codex-prompt-recall-adapter.js\"",
            "timeout": 5,
            "statusMessage": "Recalling memory..."
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"<repo>/hooks/session-capture.js\"",
            "command_windows": "node \"<repo>\\hooks\\session-capture.js\"",
            "timeout": 15,
            "statusMessage": "Queueing session for memory distillation..."
          }
        ]
      }
    ]
  }
}
```

Save this as `~/.codex/hooks.json`. On the first run, Codex will ask you to review and trust each hook hash.

## Memory setup

Same as Claude Code: copy `memory/` to `~/agent-memory` (or set `AGENT_MEMORY_DIR`). A shared memory directory works across both agents.

```
mkdir ~/agent-memory
cp -r <repo>/memory/* ~/agent-memory/
```

## Distill Codex sessions

Codex session logs live under `~/.codex/sessions/` as JSONL. The Stop hook queues them automatically via `session-capture.js`. Run the distill script on a schedule:

```powershell
# Windows Task Scheduler
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\distill.ps1"'
$t = New-ScheduledTaskTrigger -Daily -At 07:30
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Memory-Distill-daily' -Action $a -Trigger $t -Settings $s
```

The digester expects `type: user` / `type: assistant` entries. For Codex transcripts (which use `type: response_item` with `payload.role`), the distiller will process the raw JSONL but the topic extraction will be empty. The distill agent still reads the full file content and extracts knowledge from it; only the auto-topic label is missing.

Override the distill command if you want to use Codex instead of Claude Code:

```
DISTILL_AGENT_CMD='codex exec --full-auto'
```

## Verify

```
echo '{"prompt":"<a question about something in your memory>","session_id":"t1","cwd":"/tmp"}' | node <repo>/hooks/prompt-recall.js
```

A relevant page should print inside `<memory-recall>` tags. Silence means no strong match, which is the designed default.

## Known gaps

- **Prompt text reliability**: The prompt-recall adapter reads the last user `response_item` from the transcript. If the transcript has not been flushed yet at hook time (a race condition possible in short sessions), the adapter exits silently. In practice this is rare and safe.
- **Topic extraction in session-capture**: Codex transcripts use a different JSONL schema than Claude Code. The capture hook queues every large session but leaves the `topic` field blank. The distiller works correctly with a blank topic.
- **Hook trust prompt**: Each new or changed hook definition requires a one-time manual approval in the Codex UI before it runs.
