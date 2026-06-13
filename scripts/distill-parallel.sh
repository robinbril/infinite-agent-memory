#!/usr/bin/env bash
# distill-parallel.sh
# Parallel batch (macOS/Linux): folds completed agent sessions from the capture
# queue into the memory wiki. Each session gets its own headless agent run
# running concurrently; a serial merge step updates shared pages afterwards.
#
# Pipeline:
#   1. Read queue (pending entries)
#   2. For each session: digest transcript -> write per-session input file
#   3. Run per-session distill jobs in parallel (bounded concurrency via & + wait-pool)
#   4. Serial merge: build-index.js --write + delete _recall-index.json
#   5. Mark processed sessions done in the queue
#   6. Clean up temp files
#
# Race-safety: parallel jobs write ONLY sources/<slug>.md + summaries/<slug>.md.
# Shared files (index.md, entities/, concepts/) are only touched by the merge step.
#
# Non-destructive: on any per-session failure the entry stays pending.
#
# Configuration via environment:
#   AGENT_MEMORY_DIR   memory location (default ~/agent-memory)
#   DISTILL_AGENT_CMD  headless agent command (default: claude -p with safe flags)
#   MOCK_LLM           if non-empty, use echo instead of claude (for testing)
#
# Usage:
#   ./distill-parallel.sh [batch_size] [concurrency]
#   MOCK_LLM=1 ./distill-parallel.sh 5 2   # test run
#
# Schedule with cron, e.g.:  30 7 * * *  /path/to/repo/scripts/distill-parallel.sh
set -u

BATCH_SIZE="${1:-15}"
CONCURRENCY="${2:-3}"

MEM_DIR="${AGENT_MEMORY_DIR:-$HOME/agent-memory}"
QUEUE="$MEM_DIR/_capture-queue.jsonl"
LOCK_FILE="$MEM_DIR/_distill-parallel.lock"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_F="$SCRIPT_DIR/distill-prompt-single.md"
DIGESTER="$SCRIPT_DIR/transcript-digest.js"
BUILD_INDEX="$SCRIPT_DIR/build-index.js"
LOG_DIR="$MEM_DIR/_logs"
LOG="$LOG_DIR/distill-parallel.log"

TODAY="$(date +%Y-%m-%d)"

mkdir -p "$LOG_DIR"
log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

# ---- queue check ----
[ -f "$QUEUE" ] || { log "no queue, nothing to do"; exit 0; }

# ---- lock: 2-hour stale window ----
if [ -f "$LOCK_FILE" ]; then
  if [ -n "$(find "$LOCK_FILE" -mmin -120 2>/dev/null)" ]; then
    log "run already in progress (lock), stop"; exit 0
  fi
  log "stale lock found, removed"; rm -f "$LOCK_FILE"
fi
date -Iseconds > "$LOCK_FILE"

# ---- parse queue via node, emit per-session JSON lines to stdout ----
# Emits one JSON per line: {"slug":"..","transcriptPath":"..","ts":"..","cwd":"..","topic":".."}
SESSIONS_JSON="$(node - "$QUEUE" "$BATCH_SIZE" <<'NODEEOF'
const fs = require('fs');
const [queue, batchSize] = process.argv.slice(2);
const lines = fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean);
const entries = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const pending = entries.filter(e => !e.done).slice(0, Number(batchSize));
for (const e of pending) {
  process.stdout.write(JSON.stringify({
    slug:           e.sessionId,
    transcriptPath: e.transcriptPath || '',
    ts:             e.ts  || '',
    cwd:            e.cwd || '',
    topic:          e.topic || ''
  }) + '\n');
}
NODEEOF
)"

if [ -z "$SESSIONS_JSON" ]; then
  log "no pending sessions"
  rm -f "$LOCK_FILE"
  exit 0
fi

SESSION_COUNT="$(echo "$SESSIONS_JSON" | wc -l | tr -d ' ')"
log "start: $SESSION_COUNT session(s), concurrency=$CONCURRENCY"

[ -f "$PROMPT_F" ] || { log "distill-prompt-single.md not found at $PROMPT_F"; rm -f "$LOCK_FILE"; exit 1; }
PROMPT_TEMPLATE="$(cat "$PROMPT_F")"

# ---- phase 1: digest each transcript and write per-session input files ----
# Also build the succeeded/failed tracking files
SUCCEEDED_LIST="$MEM_DIR/_distill-parallel-succeeded.txt"
FAILED_LIST="$MEM_DIR/_distill-parallel-failed.txt"
> "$SUCCEEDED_LIST"
> "$FAILED_LIST"

# Collect slugs that got a usable digest into an array
declare -a READY_SLUGS=()

while IFS= read -r line; do
  [ -z "$line" ] && continue
  SLUG="$(echo "$line" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).slug)")"
  TP="$(echo "$line"   | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).transcriptPath)")"
  TS="$(echo "$line"   | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).ts)")"
  CWD_VAL="$(echo "$line" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).cwd)")"
  TOPIC="$(echo "$line" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).topic)")"

  if [ -z "$TP" ] || [ ! -f "$TP" ]; then
    log "transcript missing, skip: $SLUG"
    continue
  fi

  DIGEST="$(node "$DIGESTER" "$TP" 2>/dev/null)"
  if [ -z "$DIGEST" ]; then
    log "empty digest, skip: $SLUG"
    continue
  fi

  # Write per-session input file
  INPUT_FILE="$MEM_DIR/_distill-single-${SLUG}.md"
  printf '# === SESSION slug=%s date=%s cwd=%s topic=%s ===\n%s\n' \
    "$SLUG" "$TS" "$CWD_VAL" "$TOPIC" "$DIGEST" > "$INPUT_FILE"

  READY_SLUGS+=("$SLUG")
done <<< "$SESSIONS_JSON"

READY_COUNT="${#READY_SLUGS[@]}"
if [ "$READY_COUNT" -eq 0 ]; then
  log "no usable digests, stop"
  rm -f "$LOCK_FILE" "$SUCCEEDED_LIST" "$FAILED_LIST"
  exit 0
fi
log "digests ready: $READY_COUNT session(s)"

# ---- phase 2: parallel agent runs with bounded concurrency ----
# Each worker function writes only sources/<slug>.md + summaries/<slug>.md.

run_session() {
  local SLUG="$1"
  local JOB_LOG="$LOG_DIR/distill-parallel-job-${SLUG}.log"

  mkdir -p "$MEM_DIR/sources" "$MEM_DIR/summaries" 2>/dev/null

  # Build per-session prompt by substituting placeholders
  local PROMPT
  PROMPT="$(printf '%s' "$PROMPT_TEMPLATE" \
    | sed "s|{{MEMORY_DIR}}|$MEM_DIR|g" \
    | sed "s|{{SESSION_SLUG}}|$SLUG|g" \
    | sed "s|{{DATE}}|$TODAY|g")"

  cd "$MEM_DIR" || return 1

  if [ -n "${MOCK_LLM:-}" ]; then
    # Test mode: write stub files instead of calling the LLM
    printf -- '---\nname: %s\ntype: source\ningested: %s\norigin: agent-session\n---\n[mock] No LLM in test mode.\n' \
      "$SLUG" "$TODAY" > "$MEM_DIR/sources/${SLUG}.md"
    printf -- '---\nname: %s\ntype: summary\nsources: [%s]\nupdated: %s\n---\n- [mock] Test run for %s. (source: %s)\n' \
      "$SLUG" "$SLUG" "$TODAY" "$SLUG" "$SLUG" > "$MEM_DIR/summaries/${SLUG}.md"
    echo "$(date -Iseconds) [job:$SLUG] mock done" >> "$JOB_LOG"
    echo "$SLUG" >> "$SUCCEEDED_LIST"
    return 0
  fi

  if [ -n "${DISTILL_AGENT_CMD:-}" ]; then
    printf '%s' "$PROMPT" | eval "$DISTILL_AGENT_CMD" >> "$JOB_LOG" 2>&1
  else
    printf '%s' "$PROMPT" | claude -p --model sonnet --permission-mode acceptEdits \
      --allowedTools 'Read' 'Write' 'Edit' 'Grep' 'Glob' >> "$JOB_LOG" 2>&1
  fi
  local CODE=$?

  cat "$JOB_LOG" >> "$LOG"

  if [ "$CODE" -ne 0 ]; then
    echo "$(date -Iseconds) [job:$SLUG] agent failed (exit $CODE)" >> "$LOG"
    echo "$SLUG" >> "$FAILED_LIST"
    return 1
  fi

  echo "$(date -Iseconds) [job:$SLUG] agent done" >> "$LOG"
  echo "$SLUG" >> "$SUCCEEDED_LIST"
  return 0
}

# Bounded concurrency pool using background jobs + wait
RUNNING=0
for SLUG in "${READY_SLUGS[@]}"; do
  # Wait if we have hit the concurrency cap
  while [ "$RUNNING" -ge "$CONCURRENCY" ]; do
    wait -n 2>/dev/null || wait  # wait for any child; -n is bash 4.3+
    RUNNING=$((RUNNING - 1))
  done
  log "spawning job: $SLUG"
  run_session "$SLUG" &
  RUNNING=$((RUNNING + 1))
done

# Wait for all remaining jobs
wait

SUCCEEDED_COUNT="$(wc -l < "$SUCCEEDED_LIST" | tr -d ' ')"
FAILED_COUNT="$(wc -l < "$FAILED_LIST" | tr -d ' ')"
log "parallel phase done: $SUCCEEDED_COUNT ok, $FAILED_COUNT failed"

if [ "$SUCCEEDED_COUNT" -eq 0 ]; then
  log "all jobs failed, skipping merge"
  for SLUG in "${READY_SLUGS[@]}"; do rm -f "$MEM_DIR/_distill-single-${SLUG}.md"; done
  rm -f "$LOCK_FILE" "$SUCCEEDED_LIST" "$FAILED_LIST"
  exit 1
fi

# ---- phase 3: serial merge ----
log "serial merge: running build-index --write"
node "$BUILD_INDEX" --write "$MEM_DIR" >> "$LOG" 2>&1 || log "build-index --write exited non-zero (non-fatal)"

RECALL_INDEX="$MEM_DIR/_recall-index.json"
if [ -f "$RECALL_INDEX" ]; then
  rm -f "$RECALL_INDEX"
  log "deleted _recall-index.json"
fi

# ---- phase 4: mark done in queue ----
SUCCEEDED_SLUGS="$(cat "$SUCCEEDED_LIST")"
node - "$QUEUE" "$SUCCEEDED_SLUGS" <<'NODEEOF'
const fs   = require('fs');
const [queue, ...idArgs] = process.argv.slice(2);
// ids may arrive as a single newline-separated string or as separate args
const ids  = new Set(idArgs.join('\n').split('\n').map(s => s.trim()).filter(Boolean));
const out  = fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean).map(l => {
  try {
    const o = JSON.parse(l);
    if (ids.has(o.sessionId)) o.done = true;
    return JSON.stringify(o);
  } catch (_) { return l; }
});
fs.writeFileSync(queue, out.join('\n') + '\n');
NODEEOF

log "queue updated: $SUCCEEDED_COUNT marked done"

# ---- cleanup ----
for SLUG in "${READY_SLUGS[@]}"; do rm -f "$MEM_DIR/_distill-single-${SLUG}.md"; done
rm -f "$LOCK_FILE" "$SUCCEEDED_LIST" "$FAILED_LIST"

log "finish: $SUCCEEDED_COUNT done, $FAILED_COUNT still pending"
if [ "$FAILED_COUNT" -gt 0 ]; then
  log "failed slugs: $(paste -sd ',' "$FAILED_LIST" 2>/dev/null || echo '(see log)')"
fi
exit 0
