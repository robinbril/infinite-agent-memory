#Requires -Version 5.1
<#
.SYNOPSIS
  Removes infinite-agent-memory hook wiring from Claude Code (and optionally Codex).
  The memory directory is NOT touched - it contains data.

.PARAMETER DryRun
  Show what would be removed without writing anything.

.PARAMETER WithCodex
  Also remove Codex hooks from ~/.codex/hooks.json.

.EXAMPLE
  pwsh uninstall.ps1
  pwsh uninstall.ps1 --DryRun
  pwsh uninstall.ps1 --WithCodex
#>

[CmdletBinding()]
param(
    [switch] $DryRun,
    [switch] $WithCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoDir        = $PSScriptRoot
if (-not $RepoDir) { $RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ClaudeSettings = Join-Path $HOME ".claude\settings.json"
$CodexHooks     = Join-Path $HOME ".codex\hooks.json"

function Log-Ok($msg)   { Write-Host "[ok]      $msg" -ForegroundColor Green }
function Log-Dry($msg)  { Write-Host "[dry-run] would: $msg" -ForegroundColor Cyan }
function Log-Warn($msg) { Write-Host "[warn]    $msg" -ForegroundColor Yellow }

# node detection
$NodeBin = $null
try { & node --version 2>$null | Out-Null; $NodeBin = "node" } catch { }
if (-not $NodeBin) {
    foreach ($c in @("$env:ProgramFiles\nodejs\node.exe")) {
        if (Test-Path $c) { $NodeBin = $c; break }
    }
}

$removeScript = @'
'use strict';
const fs   = require('fs');
const path = require('path');

const filePath = process.argv[2];
const dryRun   = process.argv[3] === '1';

if (!fs.existsSync(filePath)) {
  console.log('[remove] File not found: ' + filePath + ' - nothing to do.');
  process.exit(0);
}

let cfg = {};
try {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  cfg = JSON.parse(raw);
} catch (e) {
  console.error('[remove] Could not parse ' + filePath + ': ' + e.message);
  process.exit(1);
}

if (!cfg.hooks) { console.log('[remove] No hooks section, nothing to do.'); process.exit(0); }

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
  console.log('[remove] No memory hooks found - nothing to do.');
  process.exit(0);
}

if (dryRun) {
  console.log('[dry-run] Would write:\n' + JSON.stringify(cfg, null, 2));
  process.exit(0);
}

fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), { encoding: 'utf8' });
console.log('[remove] Written: ' + filePath);
'@

function Invoke-Remove {
    param([string]$FilePath, [bool]$IsDryRun)
    if (-not $NodeBin) {
        Log-Warn "node not found - cannot patch JSON. Remove memory hook entries from $FilePath manually."
        return
    }
    $tmp = [System.IO.Path]::GetTempFileName() + ".js"
    [System.IO.File]::WriteAllText($tmp, $removeScript, [System.Text.UTF8Encoding]::new($false))
    try {
        $flag = if ($IsDryRun) { "1" } else { "0" }
        & $NodeBin $tmp $FilePath $flag
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "infinite-agent-memory uninstaller" -ForegroundColor White
if ($DryRun) { Write-Host "(dry-run mode - no files will be written)" -ForegroundColor Cyan }
Write-Host ""
Write-Host "Note: the memory directory is NOT removed. Only hook wiring is removed."
Write-Host ""

# ── Claude Code settings.json ─────────────────────────────────────────────────
Write-Host "==> Claude Code settings.json: $ClaudeSettings"
Invoke-Remove -FilePath $ClaudeSettings -IsDryRun ([bool]$DryRun)

# ── Codex hooks.json (optional) ───────────────────────────────────────────────
if ($WithCodex) {
    Write-Host ""
    Write-Host "==> Codex hooks.json: $CodexHooks"
    Invoke-Remove -FilePath $CodexHooks -IsDryRun ([bool]$DryRun)
}

# ── Task Scheduler ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Task Scheduler: Memory-Distill-daily"
$taskName = "Memory-Distill-daily"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    if ($DryRun) {
        Log-Dry "unregister scheduled task '$taskName'"
    } else {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Log-Ok "removed scheduled task '$taskName'"
    }
} else {
    Log-Ok "task '$taskName' not found, nothing to remove"
}

# ── summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==============================" -ForegroundColor White
if ($DryRun) {
    Write-Host "DRY-RUN complete. No files were written." -ForegroundColor Cyan
} else {
    Write-Host "Uninstall complete." -ForegroundColor Green
}
Write-Host ""
$memDir = if ($env:AGENT_MEMORY_DIR) { $env:AGENT_MEMORY_DIR } else { Join-Path $HOME "agent-memory" }
Write-Host "Memory data at $memDir was NOT removed."
