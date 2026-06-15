#!/usr/bin/env bash
# install.sh - one-command installer for infinite-agent-memory (macOS/Linux)
# Usage:
#   bash install.sh
#   bash install.sh --dry-run
#   bash install.sh --memory-dir /custom/path
#   bash install.sh --with-codex
#   bash install.sh --with-skills
#   AGENT_MEMORY_DIR=/custom/path bash install.sh

set -euo pipefail

# ── defaults ────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMORY_DIR="${AGENT_MEMORY_DIR:-$HOME/agent-memory}"
DRY_RUN=0
WITH_CODEX=0
WITH_SKILLS=0
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"

# ── argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --with-codex)  WITH_CODEX=1 ;;
    --with-skills) WITH_SKILLS=1 ;;
    --memory-dir)  MEMORY_DIR="$2"; shift ;;
    --memory-dir=*) MEMORY_DIR="${1#*=}" ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

# ── helpers ──────────────────────────────────────────────────────────────────
log()  { echo "  $*"; }
ok()   { echo "[ok] $*"; }
dry()  { echo "[dry-run] would: $*"; }
warn() { echo "[warn] $*"; }

say_dry_or_run() {
  # say_dry_or_run "description" cmd [args...]
  local desc="$1"; shift
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "$desc"
  else
    "$@"
  fi
}

# ── step 1: memory directory ─────────────────────────────────────────────────
echo ""
echo "==> Memory directory: $MEMORY_DIR"

if [[ -d "$MEMORY_DIR" ]]; then
  ok "already exists, skipping creation"
else
  say_dry_or_run "create $MEMORY_DIR" mkdir -p "$MEMORY_DIR"
  [[ $DRY_RUN -eq 0 ]] && ok "created $MEMORY_DIR"
fi

# copy memory template (only files that do not yet exist)
for src in "$REPO_DIR/memory/SCHEMA.md" "$REPO_DIR/memory/index.md"; do
  fname="$(basename "$src")"
  dest="$MEMORY_DIR/$fname"
  if [[ -f "$dest" ]]; then
    ok "$fname already present, not overwriting"
  else
    say_dry_or_run "copy $fname to $MEMORY_DIR/" cp "$src" "$dest"
    [[ $DRY_RUN -eq 0 ]] && ok "copied $fname"
  fi
done

for subdir in entities concepts summaries sources; do
  dest_dir="$MEMORY_DIR/$subdir"
  if [[ -d "$dest_dir" ]]; then
    ok "  $subdir/ already present"
  else
    say_dry_or_run "create $dest_dir/" mkdir -p "$dest_dir"
    [[ $DRY_RUN -eq 0 ]] && ok "created $subdir/"
    # copy .gitkeep if present so git tracks the empty dir
    keep="$REPO_DIR/memory/$subdir/.gitkeep"
    [[ -f "$keep" ]] && say_dry_or_run "copy .gitkeep into $subdir/" cp "$keep" "$dest_dir/.gitkeep"
  fi
done

# ── step 2: node check ───────────────────────────────────────────────────────
echo ""
echo "==> Node.js check"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
  NODE_VER="$(node --version)"
  ok "found $NODE_BIN $NODE_VER"
else
  warn "node not found on PATH - hooks will fail at runtime. Install Node 18+ and ensure it is on your PATH."
fi

# ── step 3: Claude Code settings.json hook wiring ────────────────────────────
echo ""
echo "==> Claude Code settings.json: $CLAUDE_SETTINGS"

# build the hook commands using the repo absolute path
SS_CMD="node \"${REPO_DIR}/hooks/session-recall.js\""
PR_CMD="node \"${REPO_DIR}/hooks/prompt-recall.js\""
SE_CMD="node \"${REPO_DIR}/hooks/session-capture.js\""

# We use Node to merge JSON so we stay dependency-free (no jq required)
# The merge script: idempotent, only adds hooks that are not yet present
MERGE_SCRIPT="$(cat <<'NODEEOF'
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const settingsPath = process.argv[2];
const repoDir      = process.argv[3];
const dryRun       = process.argv[4] === '1';

// Commands to wire
const events = [
  {
    event: 'SessionStart',
    cmd: `node "${repoDir}/hooks/session-recall.js"`,
    timeout: 3000
  },
  {
    event: 'UserPromptSubmit',
    cmd: `node "${repoDir}/hooks/prompt-recall.js"`,
    timeout: 3000
  },
  {
    event: 'SessionEnd',
    cmd: `node "${repoDir}/hooks/session-capture.js"`,
    timeout: 15000
  }
];

// Read existing settings
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
    settings = JSON.parse(raw);
  } catch (e) {
    console.error('[merge] Could not parse settings.json: ' + e.message);
    process.exit(1);
  }
}

if (!settings.hooks) settings.hooks = {};
let changed = 0;

for (const { event, cmd, timeout } of events) {
  const list = settings.hooks[event] || [];
  // Check if this exact command is already wired anywhere in this event's hook list
  const alreadyWired = list.some(entry => {
    const hooks = entry.hooks || [];
    return hooks.some(h => h.command === cmd);
  });
  if (alreadyWired) {
    console.log('[merge] ' + event + ': already wired, skipping');
  } else {
    list.push({ hooks: [{ type: 'command', command: cmd, timeout }] });
    settings.hooks[event] = list;
    changed++;
    console.log('[merge] ' + event + ': added memory hook');
  }
}

if (changed === 0) {
  console.log('[merge] All hooks already present, nothing to do.');
  process.exit(0);
}

if (dryRun) {
  console.log('[dry-run] Would write:\n' + JSON.stringify(settings, null, 2));
  process.exit(0);
}

// Ensure parent dir exists
const dir = path.dirname(settingsPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Write BOM-free UTF-8
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8' });
console.log('[merge] Written: ' + settingsPath);
NODEEOF
)"

if [[ -n "$NODE_BIN" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "$MERGE_SCRIPT" | node - "$CLAUDE_SETTINGS" "$REPO_DIR" "1"
  else
    echo "$MERGE_SCRIPT" | node - "$CLAUDE_SETTINGS" "$REPO_DIR" "0"
  fi
else
  warn "Skipping settings.json merge (node not available). Run manually after installing Node."
fi

# ── step 4: Codex hooks.json (optional) ──────────────────────────────────────
if [[ $WITH_CODEX -eq 1 ]]; then
  echo ""
  echo "==> Codex hooks.json: $CODEX_HOOKS"

  CODEX_MERGE_SCRIPT="$(cat <<'NODEEOF'
'use strict';
const fs = require('fs');
const path = require('path');

const hooksPath = process.argv[2];
const repoDir   = process.argv[3];
const dryRun    = process.argv[4] === '1';

const events = [
  {
    event: 'SessionStart',
    cmd:     `node "${repoDir}/integrations/codex-session-recall-adapter.js"`,
    cmdWin:  `node "${repoDir.replace(/\//g,'\\\\')}/integrations/codex-session-recall-adapter.js"`,
    timeout: 5,
    status:  'Loading memory index...'
  },
  {
    event: 'UserPromptSubmit',
    cmd:     `node "${repoDir}/integrations/codex-prompt-recall-adapter.js"`,
    cmdWin:  `node "${repoDir.replace(/\//g,'\\\\')}/integrations/codex-prompt-recall-adapter.js"`,
    timeout: 5,
    status:  'Recalling memory...'
  },
  {
    event: 'Stop',
    cmd:     `node "${repoDir}/hooks/session-capture.js"`,
    cmdWin:  `node "${repoDir.replace(/\//g,'\\\\')}/hooks/session-capture.js"`,
    timeout: 15,
    status:  'Queueing session for memory distillation...'
  }
];

let hooks = {};
if (fs.existsSync(hooksPath)) {
  try {
    const raw = fs.readFileSync(hooksPath, 'utf8').replace(/^﻿/, '');
    hooks = JSON.parse(raw);
  } catch (e) {
    console.error('[merge-codex] Could not parse hooks.json: ' + e.message);
    process.exit(1);
  }
}

if (!hooks.hooks) hooks.hooks = {};
let changed = 0;

for (const { event, cmd, cmdWin, timeout, status } of events) {
  const list = hooks.hooks[event] || [];
  const alreadyWired = list.some(entry => {
    const hs = entry.hooks || [];
    return hs.some(h => h.command === cmd || h.command_windows === cmdWin);
  });
  if (alreadyWired) {
    console.log('[merge-codex] ' + event + ': already wired, skipping');
  } else {
    list.push({ hooks: [{ type: 'command', command: cmd, command_windows: cmdWin, timeout, statusMessage: status }] });
    hooks.hooks[event] = list;
    changed++;
    console.log('[merge-codex] ' + event + ': added memory hook');
  }
}

if (changed === 0) {
  console.log('[merge-codex] All Codex hooks already present, nothing to do.');
  process.exit(0);
}

if (dryRun) {
  console.log('[dry-run] Would write:\n' + JSON.stringify(hooks, null, 2));
  process.exit(0);
}

const dir = path.dirname(hooksPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), { encoding: 'utf8' });
console.log('[merge-codex] Written: ' + hooksPath);
NODEEOF
)"

  if [[ -n "$NODE_BIN" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "$CODEX_MERGE_SCRIPT" | node - "$CODEX_HOOKS" "$REPO_DIR" "1"
    else
      echo "$CODEX_MERGE_SCRIPT" | node - "$CODEX_HOOKS" "$REPO_DIR" "0"
    fi
  else
    warn "Skipping Codex hooks.json merge (node not available)."
  fi
fi

# ── step 4.5: skills and slash commands (optional) ───────────────────────────
echo ""
echo "==> Skills and commands"
if [[ $WITH_SKILLS -eq 1 ]]; then
  # skill: memory
  SKILL_MEMORY_SRC="${REPO_DIR}/skills/memory/SKILL.md"
  SKILL_MEMORY_DEST="$HOME/.claude/skills/memory/SKILL.md"
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "create ~/.claude/skills/memory/ if needed"
    dry "copy skills/memory/SKILL.md to $SKILL_MEMORY_DEST (skip if exists)"
  else
    mkdir -p "$(dirname "$SKILL_MEMORY_DEST")"
    if [[ -f "$SKILL_MEMORY_DEST" ]]; then
      ok "skills/memory/SKILL.md already present, not overwriting"
    else
      cp "$SKILL_MEMORY_SRC" "$SKILL_MEMORY_DEST"
      ok "copied skills/memory/SKILL.md"
    fi
  fi

  # skill: graph
  SKILL_GRAPH_SRC="${REPO_DIR}/skills/graph/SKILL.md"
  SKILL_GRAPH_DEST="$HOME/.claude/skills/graph/SKILL.md"
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "create ~/.claude/skills/graph/ if needed"
    dry "copy skills/graph/SKILL.md to $SKILL_GRAPH_DEST (skip if exists)"
  else
    mkdir -p "$(dirname "$SKILL_GRAPH_DEST")"
    if [[ -f "$SKILL_GRAPH_DEST" ]]; then
      ok "skills/graph/SKILL.md already present, not overwriting"
    else
      cp "$SKILL_GRAPH_SRC" "$SKILL_GRAPH_DEST"
      ok "copied skills/graph/SKILL.md"
    fi
  fi

  # slash commands
  COMMANDS_SRC="${REPO_DIR}/commands"
  COMMANDS_DEST="$HOME/.claude/commands"
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "create ~/.claude/commands/ if needed"
    for f in "$COMMANDS_SRC"/*.md; do
      fname="$(basename "$f")"
      dry "copy commands/$fname to $COMMANDS_DEST/$fname (skip if exists)"
    done
  else
    mkdir -p "$COMMANDS_DEST"
    for f in "$COMMANDS_SRC"/*.md; do
      fname="$(basename "$f")"
      dest_f="$COMMANDS_DEST/$fname"
      if [[ -f "$dest_f" ]]; then
        ok "commands/$fname already present, not overwriting"
      else
        cp "$f" "$dest_f"
        ok "copied commands/$fname"
      fi
    done
  fi
else
  log "pass --with-skills to install skill definitions and slash commands"
fi

# ── step 5: schedule the distill ─────────────────────────────────────────────
echo ""
echo "==> Distill schedule"
CRON_CMD="30 7 * * * $NODE_BIN \"${REPO_DIR}/scripts/distill.sh\""
DISTILL_SCRIPT="${REPO_DIR}/scripts/distill.sh"
if [[ -f "$DISTILL_SCRIPT" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "add cron: 30 7 * * * ${DISTILL_SCRIPT}"
  else
    # check if already scheduled
    if crontab -l 2>/dev/null | grep -qF "$DISTILL_SCRIPT"; then
      ok "distill already in crontab"
    else
      (crontab -l 2>/dev/null; echo "30 7 * * * \"${DISTILL_SCRIPT}\"") | crontab -
      ok "added cron job: daily at 07:30"
    fi
  fi
else
  warn "distill.sh not found at $DISTILL_SCRIPT - skipping cron registration"
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================="
if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY-RUN complete. No files were written."
else
  echo "Install complete."
fi
echo ""
echo "  Memory dir : $MEMORY_DIR"
echo "  settings   : $CLAUDE_SETTINGS"
[[ $WITH_CODEX -eq 1 ]] && echo "  Codex hooks: $CODEX_HOOKS"
[[ $WITH_SKILLS -eq 1 ]] && echo "  Skills     : ~/.claude/skills/memory, ~/.claude/skills/graph"
[[ $WITH_SKILLS -eq 1 ]] && echo "  Commands   : ~/.claude/commands/"
if [[ -n "$NODE_BIN" ]]; then
  echo "  Node       : $NODE_BIN $NODE_VER [ok]"
else
  echo "  Node       : NOT FOUND - install Node 18+"
fi
echo ""
echo "Next: open a new Claude Code session to verify memory recall is active."
echo "Verify with:"
echo "  echo '{\"prompt\":\"test\",\"session_id\":\"t1\",\"cwd\":\"/tmp\"}' | node \"${REPO_DIR}/hooks/prompt-recall.js\""
