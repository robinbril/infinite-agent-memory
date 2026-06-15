#Requires -Version 5.1
<#
.SYNOPSIS
  One-command installer for infinite-agent-memory on Windows (PowerShell).

.DESCRIPTION
  - Creates the memory directory (default: ~/agent-memory, override via
    $env:AGENT_MEMORY_DIR or -MemoryDir).
  - Copies the memory template (SCHEMA.md, index.md, subdirs) without
    overwriting existing content.
  - Merges the three Claude Code hooks into ~/.claude/settings.json
    (idempotent JSON merge - existing keys are preserved).
  - Optionally wires Codex hooks into ~/.codex/hooks.json (--WithCodex).
  - Registers a Task Scheduler job for the daily distill.
  - Supports --DryRun to preview changes without writing anything.

.PARAMETER MemoryDir
  Override the memory directory. Default: ~/agent-memory.
  Also respected as $env:AGENT_MEMORY_DIR.

.PARAMETER DryRun
  Show what would happen without writing any files.

.PARAMETER WithCodex
  Also wire the Codex hooks.json integration.

.EXAMPLE
  pwsh install.ps1
  pwsh install.ps1 --DryRun
  pwsh install.ps1 --MemoryDir D:\my-memory
  pwsh install.ps1 --WithCodex
  pwsh install.ps1 --WithSkills
#>

[CmdletBinding()]
param(
    [string]  $MemoryDir  = "",
    [switch]  $DryRun,
    [switch]  $WithCodex,
    [switch]  $WithSkills
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── resolve paths ─────────────────────────────────────────────────────────────
$RepoDir = $PSScriptRoot
if (-not $RepoDir) { $RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

if ($MemoryDir -eq "") {
    $MemoryDir = if ($env:AGENT_MEMORY_DIR) { $env:AGENT_MEMORY_DIR } else { Join-Path $HOME "agent-memory" }
}

$ClaudeSettings = Join-Path $HOME ".claude\settings.json"
$CodexHooks     = Join-Path $HOME ".codex\hooks.json"

# ── helpers ───────────────────────────────────────────────────────────────────
function Log-Ok($msg)   { Write-Host "[ok]       $msg" -ForegroundColor Green }
function Log-Dry($msg)  { Write-Host "[dry-run]  would: $msg" -ForegroundColor Cyan }
function Log-Warn($msg) { Write-Host "[warn]     $msg" -ForegroundColor Yellow }
function Log-Info($msg) { Write-Host "           $msg" }

function Invoke-OrDry($description, [scriptblock]$action) {
    if ($DryRun) {
        Log-Dry $description
    } else {
        & $action
    }
}

# ── node detection ─────────────────────────────────────────────────────────────
$NodeBin = $null
$NodeVer  = ""
try {
    $NodeVer = (& node --version 2>$null)
    $NodeBin = "node"
} catch { }
if (-not $NodeBin) {
    # Try common install locations
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:APPDATA\nvm\current\node.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $NodeBin = $c; $NodeVer = (& $c --version 2>$null); break }
    }
}

# ── JSON merge helper (runs inline Node script) ───────────────────────────────
function Invoke-JsonMerge {
    param(
        [string]   $SettingsPath,
        [string]   $RepoPath,
        [bool]     $IsCodex,
        [bool]     $IsDryRun
    )

    if (-not $NodeBin) {
        Log-Warn "node not found - cannot merge JSON. Install Node 18+ and re-run."
        return
    }

    $DryFlag = if ($IsDryRun) { "1" } else { "0" }

    if ($IsCodex) {
        $script = @'
'use strict';
const fs   = require('fs');
const path = require('path');

const hooksPath = process.argv[2];
const repoDir   = process.argv[3];
const dryRun    = process.argv[4] === '1';

const winPath = (p) => p.replace(/\//g, '\\\\');

const events = [
  {
    event:   'SessionStart',
    cmd:     `node "${repoDir}/integrations/codex-session-recall-adapter.js"`,
    cmdWin:  `node "${winPath(repoDir)}\\integrations\\codex-session-recall-adapter.js"`,
    timeout: 5,
    status:  'Loading memory index...'
  },
  {
    event:   'UserPromptSubmit',
    cmd:     `node "${repoDir}/integrations/codex-prompt-recall-adapter.js"`,
    cmdWin:  `node "${winPath(repoDir)}\\integrations\\codex-prompt-recall-adapter.js"`,
    timeout: 5,
    status:  'Recalling memory...'
  },
  {
    event:   'Stop',
    cmd:     `node "${repoDir}/hooks/session-capture.js"`,
    cmdWin:  `node "${winPath(repoDir)}\\hooks\\session-capture.js"`,
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
  const already = list.some(entry => (entry.hooks||[]).some(h => h.command === cmd || h.command_windows === cmdWin));
  if (already) {
    console.log('[merge-codex] ' + event + ': already wired, skipping');
  } else {
    list.push({ hooks: [{ type: 'command', command: cmd, command_windows: cmdWin, timeout, statusMessage: status }] });
    hooks.hooks[event] = list;
    changed++;
    console.log('[merge-codex] ' + event + ': added memory hook');
  }
}

if (changed === 0) { console.log('[merge-codex] All hooks already present.'); process.exit(0); }
if (dryRun) { console.log('[dry-run] Would write:\n' + JSON.stringify(hooks, null, 2)); process.exit(0); }

const dir = path.dirname(hooksPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), { encoding: 'utf8' });
console.log('[merge-codex] Written: ' + hooksPath);
'@
    } else {
        $script = @'
'use strict';
const fs   = require('fs');
const path = require('path');

const settingsPath = process.argv[2];
const repoDir      = process.argv[3];
const dryRun       = process.argv[4] === '1';

const events = [
  { event: 'SessionStart',     cmd: `node "${repoDir}/hooks/session-recall.js"`,   timeout: 3000  },
  { event: 'UserPromptSubmit', cmd: `node "${repoDir}/hooks/prompt-recall.js"`,    timeout: 3000  },
  { event: 'SessionEnd',       cmd: `node "${repoDir}/hooks/session-capture.js"`,  timeout: 15000 }
];

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
  const already = list.some(entry => (entry.hooks||[]).some(h => h.command === cmd));
  if (already) {
    console.log('[merge] ' + event + ': already wired, skipping');
  } else {
    list.push({ hooks: [{ type: 'command', command: cmd, timeout }] });
    settings.hooks[event] = list;
    changed++;
    console.log('[merge] ' + event + ': added memory hook');
  }
}

if (changed === 0) { console.log('[merge] All hooks already present.'); process.exit(0); }
if (dryRun) { console.log('[dry-run] Would write:\n' + JSON.stringify(settings, null, 2)); process.exit(0); }

const dir = path.dirname(settingsPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: 'utf8' });
console.log('[merge] Written: ' + settingsPath);
'@
    }

    # Write to a temp file (avoids heredoc/quoting issues on Windows)
    $tmp = [System.IO.Path]::GetTempFileName() + ".js"
    [System.IO.File]::WriteAllText($tmp, $script, [System.Text.UTF8Encoding]::new($false))
    try {
        & $NodeBin $tmp $SettingsPath $RepoPath $DryFlag
    } finally {
        Remove-Item $tmp -ErrorAction SilentlyContinue
    }
}

# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "infinite-agent-memory installer" -ForegroundColor White
if ($DryRun) { Write-Host "(dry-run mode - no files will be written)" -ForegroundColor Cyan }
Write-Host ""

# ── step 1: memory directory ─────────────────────────────────────────────────
Write-Host "==> Memory directory: $MemoryDir"

if (Test-Path $MemoryDir) {
    Log-Ok "already exists, skipping creation"
} else {
    Invoke-OrDry "create $MemoryDir" {
        New-Item -ItemType Directory -Path $MemoryDir -Force | Out-Null
        Log-Ok "created $MemoryDir"
    }
}

# copy template files without overwriting
foreach ($fname in @("SCHEMA.md", "index.md")) {
    $src  = Join-Path $RepoDir "memory\$fname"
    $dest = Join-Path $MemoryDir $fname
    if (Test-Path $dest) {
        Log-Ok "$fname already present, not overwriting"
    } elseif (Test-Path $src) {
        Invoke-OrDry "copy $fname to $MemoryDir" {
            Copy-Item $src $dest
            Log-Ok "copied $fname"
        }
    }
}

foreach ($sub in @("entities", "concepts", "summaries", "sources")) {
    $destDir = Join-Path $MemoryDir $sub
    if (Test-Path $destDir) {
        Log-Ok "$sub/ already present"
    } else {
        Invoke-OrDry "create $destDir" {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            Log-Ok "created $sub/"
        }
        $keep = Join-Path $RepoDir "memory\$sub\.gitkeep"
        if (Test-Path $keep) {
            Invoke-OrDry "copy .gitkeep into $sub/" {
                Copy-Item $keep (Join-Path $destDir ".gitkeep")
            }
        }
    }
}

# ── step 2: node check ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "==> Node.js check"
if ($NodeBin) {
    Log-Ok "found $NodeBin $NodeVer"
} else {
    Log-Warn "node not found on PATH - hooks will fail at runtime. Install Node 18+."
}

# ── step 3: Claude Code settings.json ────────────────────────────────────────
Write-Host ""
Write-Host "==> Claude Code settings.json: $ClaudeSettings"

# Normalise repo path to forward slashes for the node script
$RepoDirFwd = $RepoDir -replace '\\', '/'

Invoke-JsonMerge -SettingsPath $ClaudeSettings -RepoPath $RepoDirFwd -IsCodex $false -IsDryRun ([bool]$DryRun)

# ── step 4: Codex hooks.json (optional) ──────────────────────────────────────
if ($WithCodex) {
    Write-Host ""
    Write-Host "==> Codex hooks.json: $CodexHooks"
    Invoke-JsonMerge -SettingsPath $CodexHooks -RepoPath $RepoDirFwd -IsCodex $true -IsDryRun ([bool]$DryRun)
}

# ── step 4.5: skills and slash commands (optional) ───────────────────────────
Write-Host ""
Write-Host "==> Skills and commands"
if ($WithSkills) {
    # skill: memory
    $skillMemorySrc  = Join-Path $RepoDir "skills\memory\SKILL.md"
    $skillMemoryDest = Join-Path $HOME ".claude\skills\memory\SKILL.md"
    if (Test-Path $skillMemoryDest) {
        Log-Ok "skills/memory/SKILL.md already present, not overwriting"
    } elseif (Test-Path $skillMemorySrc) {
        Invoke-OrDry "copy skills/memory/SKILL.md to $skillMemoryDest" {
            New-Item -ItemType Directory -Path (Split-Path $skillMemoryDest) -Force | Out-Null
            Copy-Item $skillMemorySrc $skillMemoryDest
            Log-Ok "copied skills/memory/SKILL.md"
        }
    }

    # skill: graph
    $skillGraphSrc  = Join-Path $RepoDir "skills\graph\SKILL.md"
    $skillGraphDest = Join-Path $HOME ".claude\skills\graph\SKILL.md"
    if (Test-Path $skillGraphDest) {
        Log-Ok "skills/graph/SKILL.md already present, not overwriting"
    } elseif (Test-Path $skillGraphSrc) {
        Invoke-OrDry "copy skills/graph/SKILL.md to $skillGraphDest" {
            New-Item -ItemType Directory -Path (Split-Path $skillGraphDest) -Force | Out-Null
            Copy-Item $skillGraphSrc $skillGraphDest
            Log-Ok "copied skills/graph/SKILL.md"
        }
    }

    # slash commands
    $commandsSrc  = Join-Path $RepoDir "commands"
    $commandsDest = Join-Path $HOME ".claude\commands"
    foreach ($f in (Get-ChildItem -Path $commandsSrc -Filter "*.md" -File)) {
        $destFile = Join-Path $commandsDest $f.Name
        if (Test-Path $destFile) {
            Log-Ok "commands/$($f.Name) already present, not overwriting"
        } else {
            Invoke-OrDry "copy commands/$($f.Name) to $commandsDest" {
                New-Item -ItemType Directory -Path $commandsDest -Force | Out-Null
                Copy-Item $f.FullName $destFile
                Log-Ok "copied commands/$($f.Name)"
            }
        }
    }
} else {
    Log-Info "pass -WithSkills to install skill definitions and slash commands"
}

# ── step 5: Task Scheduler for daily distill ──────────────────────────────────
Write-Host ""
Write-Host "==> Task Scheduler: Memory-Distill-daily"

$distillScript = Join-Path $RepoDir "scripts\distill.ps1"
if (Test-Path $distillScript) {
    $taskName = "Memory-Distill-daily"
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Log-Ok "task '$taskName' already registered"
    } else {
        Invoke-OrDry "register Task Scheduler job '$taskName' (daily 07:30)" {
            $a = New-ScheduledTaskAction -Execute 'powershell.exe' `
                 -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$distillScript`""
            $t = New-ScheduledTaskTrigger -Daily -At "07:30"
            $s = New-ScheduledTaskSettingsSet -StartWhenAvailable `
                 -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
                 -MultipleInstances IgnoreNew
            Register-ScheduledTask -TaskName $taskName -Action $a -Trigger $t -Settings $s -Force | Out-Null
            Log-Ok "registered '$taskName' (daily 07:30)"
        }
    }
} else {
    Log-Warn "distill.ps1 not found at $distillScript - skipping Task Scheduler registration"
}

# ── summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==============================" -ForegroundColor White
if ($DryRun) {
    Write-Host "DRY-RUN complete. No files were written." -ForegroundColor Cyan
} else {
    Write-Host "Install complete." -ForegroundColor Green
}
Write-Host ""
Write-Host "  Memory dir : $MemoryDir"
Write-Host "  settings   : $ClaudeSettings"
if ($WithCodex)  { Write-Host "  Codex hooks: $CodexHooks" }
if ($WithSkills) { Write-Host "  Skills     : ~/.claude/skills/memory, ~/.claude/skills/graph" }
if ($WithSkills) { Write-Host "  Commands   : ~/.claude/commands/" }
if ($NodeBin) {
    Write-Host "  Node       : $NodeBin $NodeVer [ok]"
} else {
    Write-Host "  Node       : NOT FOUND - install Node 18+" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next: open a new Claude Code session to verify memory recall is active."
Write-Host "Verify with:"
Write-Host "  echo '{`"prompt`":`"test`",`"session_id`":`"t1`",`"cwd`":`"/tmp`"}' | node `"$RepoDirFwd/hooks/prompt-recall.js`""
