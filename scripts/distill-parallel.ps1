# distill-parallel.ps1
# Parallel batch (Windows): folds completed agent sessions from the capture
# queue into the memory wiki. Each session gets its own headless agent run
# running concurrently; a serial merge step updates shared pages afterwards.
#
# Pipeline:
#   1. Read queue (pending entries)
#   2. For each session: digest transcript -> write per-session input file
#   3. Run per-session distill jobs in parallel (bounded concurrency)
#   4. Serial merge: build-index.js --write + delete _recall-index.json
#   5. Mark processed sessions done in the queue
#   6. Clean up temp files
#
# Race-safety: parallel jobs write ONLY sources/<slug>.md + summaries/<slug>.md.
# Shared files (index.md, entities/, concepts/) are only touched by the merge step.
#
# Non-destructive: on any per-session failure the entry stays pending and is
# retried in the next run. On a catastrophic failure the lock is left in place
# for the 2-hour stale window.
#
# Configuration via environment:
#   AGENT_MEMORY_DIR   memory location (default ~/agent-memory)
#   DISTILL_AGENT_CMD  headless agent command (default: claude -p with safe flags)
#
# Parameters:
#   -BatchSize      max sessions to process per run (default 15)
#   -Concurrency    max parallel agent jobs (default 3)
#   -MockLLM        if set, use echo instead of claude (for testing)

param(
  [int]$BatchSize   = 15,
  [int]$Concurrency = 3,
  [switch]$MockLLM  = $false
)

$ErrorActionPreference = 'Continue'

# ---- paths ----
$memDir     = if ($env:AGENT_MEMORY_DIR) { $env:AGENT_MEMORY_DIR } else { Join-Path $env:USERPROFILE 'agent-memory' }
$queue      = Join-Path $memDir '_capture-queue.jsonl'
$lockFile   = Join-Path $memDir '_distill-parallel.lock'
$repoRoot   = Split-Path $PSScriptRoot -Parent
$promptF    = Join-Path $PSScriptRoot 'distill-prompt-single.md'
$digester   = Join-Path $PSScriptRoot 'transcript-digest.js'
$buildIndex = Join-Path $PSScriptRoot 'build-index.js'
$logDir     = Join-Path $memDir '_logs'
$log        = Join-Path $logDir 'distill-parallel.log'

# ---- logging ----
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
function Log($m) { "$([DateTime]::Now.ToString('s')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }

# ---- queue check ----
if (!(Test-Path $queue)) { Log 'no queue, nothing to do'; exit 0 }

# ---- lock: lockFile doubles as mutex, 2-hour stale window ----
if (Test-Path $lockFile) {
  $age = (Get-Date) - (Get-Item $lockFile).LastWriteTime
  if ($age.TotalHours -lt 2) { Log 'run already in progress (lock), stop'; exit 0 }
  Log 'stale lock found, removed'
  Remove-Item $lockFile -ErrorAction SilentlyContinue
}
[System.IO.File]::WriteAllText($lockFile, "$([DateTime]::Now.ToString('s'))`n", (New-Object System.Text.UTF8Encoding($false)))

# ---- parse queue ----
$rawLines = Get-Content $queue | Where-Object { $_.Trim() -ne '' }
$entries  = @()
foreach ($ln in $rawLines) { try { $entries += ($ln | ConvertFrom-Json) } catch {} }
$pending  = @($entries | Where-Object { -not $_.done } | Select-Object -First $BatchSize)

if ($pending.Count -eq 0) {
  Log 'no pending sessions'
  Remove-Item $lockFile -ErrorAction SilentlyContinue
  exit 0
}
Log "start: $($pending.Count) session(s), concurrency=$Concurrency"

# ---- read the single-session prompt template ----
if (!(Test-Path $promptF)) {
  Log "distill-prompt-single.md not found at $promptF"
  Remove-Item $lockFile -ErrorAction SilentlyContinue
  exit 1
}
$promptTemplate = Get-Content $promptF -Raw

$today = (Get-Date).ToString('yyyy-MM-dd')

# ---- phase 1: digest all transcripts and write per-session input files ----
# This runs sequentially (node calls) but is fast: no LLM involved.
$sessions = New-Object System.Collections.Generic.List[hashtable]
foreach ($e in $pending) {
  $slug = $e.sessionId
  $tp   = $e.transcriptPath

  if ([string]::IsNullOrWhiteSpace($tp) -or !(Test-Path $tp)) {
    Log "transcript missing, skip: $slug"
    continue
  }

  $digest = & node $digester $tp 2>$null
  if ([string]::IsNullOrWhiteSpace($digest)) {
    Log "empty digest, skip: $slug"
    continue
  }

  # Write per-session input file (temp, cleaned up after merge)
  $inputFile = Join-Path $memDir "_distill-single-${slug}.md"
  $header    = "# === SESSION slug=$slug date=$($e.ts) cwd=$($e.cwd) topic=$($e.topic) ===`n"
  [System.IO.File]::WriteAllText($inputFile, $header + $digest + "`n", (New-Object System.Text.UTF8Encoding($false)))

  # Build the prompt for this session
  $prompt = $promptTemplate `
    -replace '\{\{MEMORY_DIR\}\}',   $memDir `
    -replace '\{\{SESSION_SLUG\}\}', $slug `
    -replace '\{\{DATE\}\}',         $today

  $sessions.Add(@{
    Slug      = $slug
    InputFile = $inputFile
    Prompt    = $prompt
    Entry     = $e
  })
}

if ($sessions.Count -eq 0) {
  Log 'no usable digests, stop'
  Remove-Item $lockFile -ErrorAction SilentlyContinue
  exit 0
}
Log "digests ready: $($sessions.Count) session(s)"

# ---- phase 2: parallel agent runs with bounded concurrency ----
# Each job writes only sources/<slug>.md + summaries/<slug>.md (race-safe).
# We use Start-Job. Jobs inherit the parent's environment via InitializationScript.

$agentCmd = $env:DISTILL_AGENT_CMD

# Scriptblock executed by each background job
$jobScript = {
  param($Slug, $InputFile, $Prompt, $MemDir, $AgentCmd, $MockLLM, $Log)

  function JobLog($m) { "$([DateTime]::Now.ToString('s')) [job:$Slug] $m" | Out-File -FilePath $Log -Append -Encoding utf8 }

  # Ensure output dirs exist (race-safe: multiple jobs may mkdir simultaneously)
  $sourcesDir   = Join-Path $MemDir 'sources'
  $summariesDir = Join-Path $MemDir 'summaries'
  if (!(Test-Path $sourcesDir))   { New-Item -ItemType Directory -Path $sourcesDir   -Force | Out-Null }
  if (!(Test-Path $summariesDir)) { New-Item -ItemType Directory -Path $summariesDir -Force | Out-Null }

  Push-Location $MemDir
  try {
    if ($MockLLM) {
      # Test mode: write stub files instead of calling the LLM
      $stubSource  = "---`nname: $Slug`ntype: source`ningested: $(Get-Date -Format 'yyyy-MM-dd')`norigin: agent-session`n---`n[mock] No LLM in test mode.`n"
      $stubSummary = "---`nname: $Slug`ntype: summary`nsources: [$Slug]`nupdated: $(Get-Date -Format 'yyyy-MM-dd')`n---`n- [mock] Test run for $Slug. (source: $Slug)`n"
      [System.IO.File]::WriteAllText((Join-Path $MemDir "sources/$Slug.md"),   $stubSource,  (New-Object System.Text.UTF8Encoding($false)))
      [System.IO.File]::WriteAllText((Join-Path $MemDir "summaries/$Slug.md"), $stubSummary, (New-Object System.Text.UTF8Encoding($false)))
      JobLog "mock done: $Slug"
      return @{ Slug = $Slug; Ok = $true }
    }

    if ($AgentCmd) {
      $result = $Prompt | Invoke-Expression $AgentCmd 2>&1
    } else {
      $result = $Prompt | & claude -p --model sonnet --permission-mode acceptEdits --allowedTools 'Read' 'Write' 'Edit' 'Grep' 'Glob' 2>&1
    }
    $code = $LASTEXITCODE
    $result | Out-File -FilePath $Log -Append -Encoding utf8
    if ($code -ne 0) {
      JobLog "agent failed (exit $code): $Slug"
      return @{ Slug = $Slug; Ok = $false }
    }
    JobLog "agent done: $Slug"
    return @{ Slug = $Slug; Ok = $true }
  } finally {
    Pop-Location
  }
}

# Run jobs with a bounded concurrency pool
$running  = @{}  # job-id -> slug
$results  = @{}  # slug   -> bool (success)
$queue2   = [System.Collections.Queue]::new()
foreach ($s in $sessions) { $queue2.Enqueue($s) }

while ($queue2.Count -gt 0 -or $running.Count -gt 0) {
  # Fill slots up to $Concurrency
  while ($queue2.Count -gt 0 -and $running.Count -lt $Concurrency) {
    $s   = $queue2.Dequeue()
    $job = Start-Job -ScriptBlock $jobScript -ArgumentList `
             $s.Slug, $s.InputFile, $s.Prompt, $memDir, $agentCmd, $MockLLM.IsPresent, $log
    $running[$job.Id] = $s.Slug
    Log "spawned job $($job.Id) for $($s.Slug)"
  }

  # Poll for any finished job
  $finished = Get-Job | Where-Object { $running.ContainsKey($_.Id) -and $_.State -in 'Completed','Failed' }
  foreach ($job in $finished) {
    $slug = $running[$job.Id]
    try {
      $ret = Receive-Job -Job $job -ErrorAction Stop
      $results[$slug] = if ($ret -is [hashtable]) { $ret.Ok } else { $false }
    } catch {
      Log "job $($job.Id) ($slug) threw: $_"
      $results[$slug] = $false
    }
    Remove-Job -Job $job -Force
    $running.Remove($job.Id)
    Log "job done: $slug ok=$($results[$slug])"
  }

  if ($queue2.Count -gt 0 -or $running.Count -gt 0) { Start-Sleep -Milliseconds 500 }
}

$succeeded = @($results.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key })
$failed    = @($results.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })

Log "parallel phase done: $($succeeded.Count) ok, $($failed.Count) failed"
if ($succeeded.Count -eq 0) {
  Log 'all jobs failed, skipping merge'
  # clean up input files for failed sessions
  foreach ($s in $sessions) { Remove-Item $s.InputFile -ErrorAction SilentlyContinue }
  Remove-Item $lockFile -ErrorAction SilentlyContinue
  exit 1
}

# ---- phase 3: serial merge ----
# Update index.md + entities/concepts via build-index --write, then remove recall cache.
Log 'serial merge: running build-index --write'
Push-Location $memDir
try {
  & node $buildIndex --write $memDir 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  $indexCode = $LASTEXITCODE
} finally { Pop-Location }

if ($indexCode -ne 0) {
  Log "build-index --write exited $indexCode (non-fatal, index may be partial)"
}

# Remove recall index so the next prompt gets a fresh one
$recallIndex = Join-Path $memDir '_recall-index.json'
if (Test-Path $recallIndex) {
  Remove-Item $recallIndex -ErrorAction SilentlyContinue
  Log 'deleted _recall-index.json'
}

# ---- phase 4: mark done in queue ----
# Only sessions whose agent run succeeded are marked done.
$successSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$succeeded)
$out = New-Object System.Collections.Generic.List[string]
foreach ($ln in $rawLines) {
  try {
    $o = $ln | ConvertFrom-Json
    if ($successSet.Contains($o.sessionId)) { $o | Add-Member -NotePropertyName done -NotePropertyValue $true -Force }
    $out.Add(($o | ConvertTo-Json -Compress -Depth 5))
  } catch { $out.Add($ln) }
}
[System.IO.File]::WriteAllText($queue, ([string]::Join("`n", $out) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Log "queue updated: $($succeeded.Count) marked done"

# ---- cleanup ----
foreach ($s in $sessions) { Remove-Item $s.InputFile -ErrorAction SilentlyContinue }
Remove-Item $lockFile -ErrorAction SilentlyContinue

Log "finish: $($succeeded.Count) done, $($failed.Count) still pending"
if ($failed.Count -gt 0) { Log "failed slugs: $($failed -join ', ')" }
exit 0
