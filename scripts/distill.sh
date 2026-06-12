#!/usr/bin/env bash
# distill.sh
# Periodic batch (macOS/Linux): folds completed agent sessions from the capture
# queue into the memory wiki via a headless agent run.
#
# Same pipeline as distill.ps1: read queue -> digest transcripts -> bundle ->
# headless run -> mark done -> log. Non-destructive on failure.
#
# Configuration via environment:
#   AGENT_MEMORY_DIR   memory location (default ~/agent-memory)
#   DISTILL_AGENT_CMD  headless agent command (default: claude -p with safe flags)
#
# Schedule with cron, e.g.:  30 7 * * *  /path/to/repo/scripts/distill.sh
set -u

BATCH_SIZE="${1:-15}"
MEM_DIR="${AGENT_MEMORY_DIR:-$HOME/agent-memory}"
QUEUE="$MEM_DIR/_capture-queue.jsonl"
BATCH_FILE="$MEM_DIR/_distill-batch.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_F="$SCRIPT_DIR/distill-prompt.md"
DIGESTER="$SCRIPT_DIR/transcript-digest.js"
LOG_DIR="$MEM_DIR/_logs"
LOG="$LOG_DIR/distill.log"

mkdir -p "$LOG_DIR"
log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

[ -f "$QUEUE" ] || { log "no queue, nothing to do"; exit 0; }

# lock: the batch file doubles as a mutex (2h staleness window)
if [ -f "$BATCH_FILE" ]; then
  if [ -n "$(find "$BATCH_FILE" -mmin -120 2>/dev/null)" ]; then
    log "run already in progress (lock), stop"; exit 0
  fi
  log "stale lock found, removed"; rm -f "$BATCH_FILE"
fi

# select pending entries and build the batch digest (node does the JSONL work)
node - "$QUEUE" "$DIGESTER" "$BATCH_FILE" "$BATCH_SIZE" <<'EOF'
const fs = require('fs');
const cp = require('child_process');
const [queue, digester, batchFile, batchSize] = process.argv.slice(2);
const lines = fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean);
const entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const pending = entries.filter(e => !e.done).slice(0, Number(batchSize));
// byte cap besides the session cap: a batch beyond ~250KB (~62k tokens) would
// overflow the headless run's context; the remainder stays pending.
const MAX_BATCH_BYTES = 250 * 1024;
const parts = [];
const processed = [];
let total = 0;
for (const e of pending) {
  if (total >= MAX_BATCH_BYTES) break;
  const tp = e.transcriptPath || '';
  if (!tp || !fs.existsSync(tp)) continue;
  const r = cp.spawnSync('node', [digester, tp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const digest = (r.stdout || '').trim();
  if (!digest) continue;
  parts.push(`# === SESSION slug=${e.sessionId} date=${e.ts} cwd=${e.cwd} topic=${e.topic || ''} ===\n${digest}\n`);
  total += digest.length;
  processed.push(e.sessionId);
}
if (!processed.length) { console.error('NO_USABLE'); process.exit(3); }
fs.writeFileSync(batchFile, parts.join('\n'));
fs.writeFileSync(batchFile + '.ids', processed.join('\n'));
console.error(`PREPARED ${processed.length}`);
EOF
rc=$?
if [ "$rc" = "3" ]; then log "no usable digests, stop"; exit 0; fi
[ "$rc" = "0" ] || { log "digest preparation failed ($rc)"; exit 1; }

# run the headless distill from inside the memory dir
PROMPT="$(sed "s|{{MEMORY_DIR}}|$MEM_DIR|g" "$PROMPT_F")"
cd "$MEM_DIR"
if [ -n "${DISTILL_AGENT_CMD:-}" ]; then
  printf '%s' "$PROMPT" | eval "$DISTILL_AGENT_CMD" >> "$LOG" 2>&1
else
  printf '%s' "$PROMPT" | claude -p --permission-mode acceptEdits \
    --allowedTools 'Read' 'Write' 'Edit' 'Grep' 'Glob' >> "$LOG" 2>&1
fi
code=$?
[ "$code" = "0" ] || { log "agent run failed (exit $code), entries stay pending"; exit 1; }

# mark processed sessions done
node - "$QUEUE" "$BATCH_FILE.ids" <<'EOF'
const fs = require('fs');
const [queue, idsFile] = process.argv.slice(2);
const ids = new Set(fs.readFileSync(idsFile, 'utf8').split('\n').filter(Boolean));
const out = fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean).map(l => {
  try {
    const o = JSON.parse(l);
    if (ids.has(o.sessionId)) o.done = true;
    return JSON.stringify(o);
  } catch (_) { return l; }
});
fs.writeFileSync(queue, out.join('\n') + '\n');
EOF

n=$(wc -l < "$BATCH_FILE.ids" | tr -d ' ')
rm -f "$BATCH_FILE" "$BATCH_FILE.ids"
log "done: $n session(s) marked done"
exit 0
