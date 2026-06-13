#!/usr/bin/env bash
# uninstall.sh - removes infinite-agent-memory hook wiring from Claude Code
# and optionally from Codex. The memory directory is LEFT INTACT (it is data).
#
# Usage:
#   bash uninstall.sh
#   bash uninstall.sh --dry-run
#   bash uninstall.sh --with-codex

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
WITH_CODEX=0
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_HOOKS="$HOME/.codex/hooks.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=1 ;;
    --with-codex) WITH_CODEX=1 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

ok()   { echo "[ok]      $*"; }
dry()  { echo "[dry-run] would: $*"; }
warn() { echo "[warn]    $*"; }

echo ""
echo "infinite-agent-memory uninstaller"
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run mode - no files will be written)"
echo ""
echo "Note: the memory directory is NOT removed. Only hook wiring is removed."
echo ""

# Node is needed for the JSON patch
NODE_BIN=""
if command -v node >/dev/null 2>&1; then NODE_BIN="node"; fi

REMOVE_SCRIPT="$(cat <<'NODEEOF'
'use strict';
const fs   = require('fs');
const path = require('path');

const settingsPath = process.argv[2];
const repoDir      = process.argv[3];
const dryRun       = process.argv[4] === '1';
const isCodex      = process.argv[5] === '1';

if (!fs.existsSync(settingsPath)) {
  console.log('[remove] File not found: ' + settingsPath + ' - nothing to do.');
  process.exit(0);
}

let cfg = {};
try {
  const raw = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
  cfg = JSON.parse(raw);
} catch (e) {
  console.error('[remove] Could not parse ' + settingsPath + ': ' + e.message);
  process.exit(1);
}

if (!cfg.hooks) { console.log('[remove] No hooks section found, nothing to do.'); process.exit(0); }

// Patterns that identify our hooks (repo-relative path segments)
const ourPatterns = [
  'hooks/session-recall.js',
  'hooks/prompt-recall.js',
  'hooks/session-capture.js',
  'integrations/codex-session-recall-adapter.js',
  'integrations/codex-prompt-recall-adapter.js'
];

function isOurHook(h) {
  const cmd = (h.command || '') + (h.command_windows || '');
  return ourPatterns.some(p => cmd.includes(p));
}

let changed = 0;
for (const event of Object.keys(cfg.hooks)) {
  const before = cfg.hooks[event].length;
  cfg.hooks[event] = cfg.hooks[event]
    .map(entry => {
      if (!entry.hooks) return entry;
      const filtered = entry.hooks.filter(h => !isOurHook(h));
      return filtered.length === 0 ? null : { ...entry, hooks: filtered };
    })
    .filter(Boolean);
  const after = cfg.hooks[event].length;
  if (after < before) {
    console.log('[remove] ' + event + ': removed ' + (before - after) + ' memory hook group(s)');
    changed++;
  }
  if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
}

if (changed === 0) {
  console.log('[remove] No memory hooks found in ' + settingsPath + ' - nothing to do.');
  process.exit(0);
}

if (dryRun) {
  console.log('[dry-run] Would write:\n' + JSON.stringify(cfg, null, 2));
  process.exit(0);
}

fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
console.log('[remove] Written: ' + settingsPath);
NODEEOF
)"

# ── Claude Code settings.json ─────────────────────────────────────────────────
echo "==> Claude Code settings.json: $CLAUDE_SETTINGS"
if [[ -n "$NODE_BIN" ]]; then
  DRY_FLAG="$DRY_RUN"
  echo "$REMOVE_SCRIPT" | node - "$CLAUDE_SETTINGS" "$REPO_DIR" "$DRY_FLAG" "0"
else
  warn "node not found - cannot patch JSON automatically."
  warn "Remove the three memory hook entries from $CLAUDE_SETTINGS manually."
fi

# ── Codex hooks.json (optional) ───────────────────────────────────────────────
if [[ $WITH_CODEX -eq 1 ]]; then
  echo ""
  echo "==> Codex hooks.json: $CODEX_HOOKS"
  if [[ -n "$NODE_BIN" ]]; then
    echo "$REMOVE_SCRIPT" | node - "$CODEX_HOOKS" "$REPO_DIR" "$DRY_RUN" "1"
  else
    warn "node not found - cannot patch Codex hooks.json automatically."
  fi
fi

# ── crontab ───────────────────────────────────────────────────────────────────
echo ""
echo "==> Crontab"
DISTILL_SCRIPT="${REPO_DIR}/scripts/distill.sh"
if crontab -l 2>/dev/null | grep -qF "$DISTILL_SCRIPT"; then
  if [[ $DRY_RUN -eq 1 ]]; then
    dry "remove distill cron entry"
  else
    crontab -l 2>/dev/null | grep -vF "$DISTILL_SCRIPT" | crontab -
    ok "removed distill cron entry"
  fi
else
  ok "distill not in crontab, nothing to remove"
fi

echo ""
echo "=============================="
if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY-RUN complete. No files were written."
else
  echo "Uninstall complete."
fi
echo ""
echo "Memory data at ${AGENT_MEMORY_DIR:-$HOME/agent-memory} was NOT removed."
