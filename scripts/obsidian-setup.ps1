# obsidian-setup.ps1
# Registers the agent-memory directory as an Obsidian vault, writes a minimal
# .obsidian/ config (graph plugin on, wikilink mode), and patches any existing
# Obsidian shortcuts with --disable-gpu-sandbox (Intel Arc / Electron gotcha).
#
# Usage:
#   .\obsidian-setup.ps1                       # uses ~/agent-memory
#   .\obsidian-setup.ps1 -MemoryDir D:\my-mem  # custom path
#
# Idempotent: safe to run multiple times.

param(
    [string]$MemoryDir = (Join-Path $env:USERPROFILE "agent-memory")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-BomFree {
    param([string]$Path, [string]$Content)
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function New-HexId {
    # 16 lowercase hex chars, matches Obsidian's vault-id format
    -join ((1..16) | ForEach-Object { "{0:x}" -f (Get-Random -Maximum 16) })
}

# ---------------------------------------------------------------------------
# 1. Resolve and validate the memory directory
# ---------------------------------------------------------------------------

$MemoryDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MemoryDir)

if (-not (Test-Path $MemoryDir)) {
    Write-Host "Creating memory directory: $MemoryDir"
    New-Item -ItemType Directory -Path $MemoryDir | Out-Null
}

Write-Host "Memory dir : $MemoryDir"

# ---------------------------------------------------------------------------
# 2. Write minimal .obsidian/ config
# ---------------------------------------------------------------------------

$obsidianDir = Join-Path $MemoryDir ".obsidian"
if (-not (Test-Path $obsidianDir)) {
    New-Item -ItemType Directory -Path $obsidianDir | Out-Null
}

# app.json: disable Markdown links so [[slug]] wikilinks feed the graph
$appJsonPath = Join-Path $obsidianDir "app.json"
if (-not (Test-Path $appJsonPath)) {
    Write-BomFree -Path $appJsonPath -Content '{"useMarkdownLinks":false}'
    Write-Host "Created  : $appJsonPath"
} else {
    # Merge useMarkdownLinks:false into existing config without destroying other keys
    $existing = Get-Content $appJsonPath -Raw | ConvertFrom-Json
    $existing | Add-Member -NotePropertyName "useMarkdownLinks" -NotePropertyValue $false -Force
    Write-BomFree -Path $appJsonPath -Content ($existing | ConvertTo-Json -Compress)
    Write-Host "Updated  : $appJsonPath (useMarkdownLinks set)"
}

# core-plugins.json: enable the graph plugin
$corePluginsPath = Join-Path $obsidianDir "core-plugins.json"
if (-not (Test-Path $corePluginsPath)) {
    Write-BomFree -Path $corePluginsPath -Content '["graph"]'
    Write-Host "Created  : $corePluginsPath"
} else {
    $plugins = Get-Content $corePluginsPath -Raw | ConvertFrom-Json
    if ($plugins -notcontains "graph") {
        $plugins += "graph"
        Write-BomFree -Path $corePluginsPath -Content ($plugins | ConvertTo-Json -Compress)
        Write-Host "Updated  : $corePluginsPath (graph added)"
    } else {
        Write-Host "OK       : $corePluginsPath (graph already enabled)"
    }
}

# ---------------------------------------------------------------------------
# 3. Register vault in Obsidian's global obsidian.json
# ---------------------------------------------------------------------------

$obsidianGlobalDir = Join-Path $env:APPDATA "obsidian"
$obsidianGlobalJson = Join-Path $obsidianGlobalDir "obsidian.json"

if (-not (Test-Path $obsidianGlobalDir)) {
    New-Item -ItemType Directory -Path $obsidianGlobalDir | Out-Null
}

$globalConfig = @{ vaults = @{} }
if (Test-Path $obsidianGlobalJson) {
    $raw = Get-Content $obsidianGlobalJson -Raw
    if ($raw.Trim()) {
        $parsed = $raw | ConvertFrom-Json
        # ConvertFrom-Json gives a PSCustomObject; convert vaults to hashtable
        $globalConfig.vaults = @{}
        if ($parsed.vaults) {
            $parsed.vaults.PSObject.Properties | ForEach-Object {
                $globalConfig.vaults[$_.Name] = @{
                    path = $_.Value.path
                    ts   = $_.Value.ts
                    open = if ($null -ne $_.Value.open) { $_.Value.open } else { $false }
                }
            }
        }
    }
}

# Check if this path is already registered
$existingId = $null
foreach ($id in $globalConfig.vaults.Keys) {
    if ($globalConfig.vaults[$id].path -eq $MemoryDir) {
        $existingId = $id
        break
    }
}

if ($existingId) {
    Write-Host "OK       : vault already registered (id $existingId)"
} else {
    $newId = New-HexId
    $globalConfig.vaults[$newId] = @{
        path = $MemoryDir
        ts   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        open = $true
    }
    $json = $globalConfig | ConvertTo-Json -Depth 5 -Compress
    Write-BomFree -Path $obsidianGlobalJson -Content $json
    Write-Host "Registered: vault id $newId -> $MemoryDir"
}

# ---------------------------------------------------------------------------
# 4. Patch Obsidian shortcuts with --disable-gpu-sandbox
#    (Electron/Chromium GPU-sandbox crash on Intel Arc iGPU, Windows)
# ---------------------------------------------------------------------------

$lnkSearchPaths = @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
    ([System.Environment]::GetFolderPath("Desktop")),
    (Join-Path $env:USERPROFILE "Desktop")
) | Sort-Object -Unique

$wsh = New-Object -ComObject WScript.Shell
$patched = 0
$skipped = 0

foreach ($searchPath in $lnkSearchPaths) {
    if (-not (Test-Path $searchPath)) { continue }
    Get-ChildItem -Path $searchPath -Filter "Obsidian*.lnk" -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
        $lnk = $wsh.CreateShortcut($_.FullName)
        if ($lnk.Arguments -notlike "*--disable-gpu-sandbox*") {
            $lnk.Arguments = ("$($lnk.Arguments) --disable-gpu-sandbox").Trim()
            $lnk.Save()
            Write-Host "Patched  : $($_.FullName)"
            $patched++
        } else {
            Write-Host "OK       : $($_.FullName) (already patched)"
            $skipped++
        }
    }
}

if ($patched -eq 0 -and $skipped -eq 0) {
    Write-Host "Note     : no Obsidian.lnk shortcuts found; patch manually if needed"
    Write-Host "           Add --disable-gpu-sandbox to the shortcut target argument"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Obsidian vault setup complete."
Write-Host "  Vault   : $MemoryDir"
Write-Host "  Config  : $obsidianDir"
Write-Host "  Shortcut: $patched patched, $skipped already OK"
Write-Host ""
Write-Host "Open Obsidian -> the vault should appear in the vault switcher."
Write-Host "Graph view: Ctrl+G (or Cmd+G on Mac) inside the vault."
Write-Host ""
Write-Host "Verify: after opening the vault, check that .obsidian/workspace.json"
Write-Host "  has been written (its mtime will be recent). If the file does not"
Write-Host "  appear within 10 seconds of Obsidian opening, the vault did not load."
