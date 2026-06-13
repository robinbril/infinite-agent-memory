# Codex integration

Codex has a hook system (GA May 2026) with `SessionStart`, `UserPromptSubmit`, and `Stop` events. These map onto all three memory functions, but the output contract differs from Claude Code in two places. Read this file before wiring anything.

## How Codex hooks differ from Claude Code

| Aspect | Claude Code | Codex |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.codex/hooks.json` |
| Context injection (SessionStart, UserPromptSubmit) | Raw text to stdout gets prepended to the prompt | Must return JSON to stdout: `{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "<text>"}}` |
| Prompt text in stdin | `input.prompt` (string) | Not delivered as a stable top-level field; read from `input.transcript_path` instead |
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

### 2. prompt-recall.js (UserPromptSubmit) - works with output wrapper and prompt shim

`prompt-recall.js` reads `input.prompt` from stdin to score the memory. Codex's UserPromptSubmit stdin does NOT include the prompt text as a stable top-level field. The closest workaround is to read the last user message from `input.transcript_path` at hook time.

Additionally, the output must be wrapped in the `additionalContext` envelope.

**Adapter**: `integrations/codex-prompt-recall-adapter.js`

```js
#!/usr/bin/env node
// Reads the latest user message from transcript_path (Codex format),
// synthesises the "prompt" field prompt-recall.js expects, and wraps
// the output in the additionalContext envelope.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (_) {}

  // Extract last user message from transcript (Codex format: response_item entries)
  let lastPrompt = '';
  const tp = input.transcript_path || '';
  if (tp && fs.existsSync(tp)) {
    try {
      const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch (_) { continue; }
        if (o.type === 'response_item' && o.payload && o.payload.role === 'user') {
          const c = o.payload.content;
          if (Array.isArray(c)) {
            const txt = c.map(p => (p && p.text) || '').join(' ').trim();
            if (txt && !txt.startsWith('<environment_context')) { lastPrompt = txt; break; }
          }
        }
      }
    } catch (_) {}
  }

  if (!lastPrompt) { process.exit(0); }

  const synth = JSON.stringify({
    prompt: lastPrompt,
    session_id: input.session_id || 'codex',
    cwd: input.cwd || process.cwd()
  });

  const repoDir = path.join(__dirname, '..');
  let ctx = '';
  try {
    ctx = execSync(`node "${path.join(repoDir, 'hooks', 'prompt-recall.js')}"`, {
      input: synth, encoding: 'utf8', timeout: 3000
    });
  } catch (_) {}

  if (ctx.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.trim() }
    }));
  }
  process.exit(0);
});
```

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
