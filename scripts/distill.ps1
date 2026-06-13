# distill.ps1
# Periodic batch (Windows): folds completed agent sessions from the capture
# queue into the memory wiki via a headless agent run.
#
# Pipeline: read queue (pending entries) -> digest each transcript -> bundle ->
#           headless run with the distill prompt -> mark entries done -> log.
#
# Non-destructive: on a failed run, entries stay pending and are retried later.
#
# Configuration via environment:
#   AGENT_MEMORY_DIR   memory location (default ~/agent-memory)
#   DISTILL_AGENT_CMD  headless agent command (default: claude -p with safe flags)
#
# Schedule with Task Scheduler, e.g. daily:
#   $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\distill.ps1"'
#   $t = New-ScheduledTaskTrigger -Daily -At 07:30
#   Register-ScheduledTask -TaskName 'Memory-Distill-daily' -Action $a -Trigger $t

param([int]$BatchSize = 15)

$ErrorActionPreference = 'Continue'

$memDir    = if ($env:AGENT_MEMORY_DIR) { $env:AGENT_MEMORY_DIR } else { Join-Path $env:USERPROFILE 'agent-memory' }
$queue     = Join-Path $memDir '_capture-queue.jsonl'
$batchFile = Join-Path $memDir '_distill-batch.md'
$repoRoot  = Split-Path $PSScriptRoot -Parent
$promptF   = Join-Path $PSScriptRoot 'distill-prompt.md'
$digester  = Join-Path $PSScriptRoot 'transcript-digest.js'
$logDir    = Join-Path $memDir '_logs'
$log       = Join-Path $logDir 'distill.log'

if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
function Log($m) { "$([DateTime]::Now.ToString('s')) $m" | Out-File -FilePath $log -Append -Encoding utf8 }

if (!(Test-Path $queue)) { Log 'no queue, nothing to do'; exit 0 }

# lock: the batch file doubles as a mutex. If it exists and is younger than 2h
# a run is already in progress; older means a crash leftover, clean and continue.
if (Test-Path $batchFile) {
  $age = (Get-Date) - (Get-Item $batchFile).LastWriteTime
  if ($age.TotalHours -lt 2) { Log 'run already in progress (lock), stop'; exit 0 }
  Log 'stale lock found, removed'
  Remove-Item $batchFile -ErrorAction SilentlyContinue
}

# parse queue, take the first BatchSize entries without done
$rawLines = Get-Content $queue | Where-Object { $_.Trim() -ne '' }
$entries  = @()
foreach ($ln in $rawLines) { try { $entries += ($ln | ConvertFrom-Json) } catch {} }
$pending  = @($entries | Where-Object { -not $_.done } | Select-Object -First $BatchSize)

if ($pending.Count -eq 0) { Log 'no pending sessions'; exit 0 }
Log "start: $($pending.Count) session(s) to distill"

# build the batch digest. Besides the session cap a byte cap applies: a batch
# beyond ~250KB (~62k tokens) would overflow the headless run's context; the
# remainder stays pending for the next round.
$MAX_BATCH_BYTES = 120KB
$sb = New-Object System.Text.StringBuilder
$processed = New-Object System.Collections.Generic.HashSet[string]
foreach ($e in $pending) {
  if ($sb.Length -ge $MAX_BATCH_BYTES) { Log "byte cap reached ($([math]::Round($sb.Length/1KB))KB), rest deferred to next round"; break }
  $tp = $e.transcriptPath
  if ([string]::IsNullOrWhiteSpace($tp) -or !(Test-Path $tp)) { Log "transcript missing, skip: $($e.sessionId)"; continue }
  $digest = & node $digester $tp 2>$null
  if ([string]::IsNullOrWhiteSpace($digest)) { Log "empty digest, skip: $($e.sessionId)"; continue }
  [void]$sb.AppendLine("# === SESSION slug=$($e.sessionId) date=$($e.ts) cwd=$($e.cwd) topic=$($e.topic) ===")
  [void]$sb.AppendLine($digest)
  [void]$sb.AppendLine("")
  [void]$processed.Add($e.sessionId)
}

if ($processed.Count -eq 0) { Log 'no usable digests, stop'; exit 0 }
[System.IO.File]::WriteAllText($batchFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))

# run the headless distill from inside the memory dir
$prompt = (Get-Content $promptF -Raw) -replace '\{\{MEMORY_DIR\}\}', $memDir
Push-Location $memDir
try {
  if ($env:DISTILL_AGENT_CMD) {
    $prompt | Invoke-Expression $env:DISTILL_AGENT_CMD 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  } else {
    $prompt | & claude -p --model sonnet --permission-mode acceptEdits --allowedTools 'Read' 'Write' 'Edit' 'Grep' 'Glob' 2>&1 |
      Out-File -FilePath $log -Append -Encoding utf8
  }
  $code = $LASTEXITCODE
} finally { Pop-Location }

if ($code -ne 0) { Log "agent run failed (exit $code), entries stay pending"; exit 1 }

# mark processed sessions done in the queue (leave the rest untouched)
$out = New-Object System.Collections.Generic.List[string]
foreach ($ln in $rawLines) {
  try {
    $o = $ln | ConvertFrom-Json
    if ($processed.Contains($o.sessionId)) { $o | Add-Member -NotePropertyName done -NotePropertyValue $true -Force }
    $out.Add(($o | ConvertTo-Json -Compress -Depth 5))
  } catch { $out.Add($ln) }
}
[System.IO.File]::WriteAllText($queue, ([string]::Join("`n", $out) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

Remove-Item $batchFile -ErrorAction SilentlyContinue
Log "done: $($processed.Count) session(s) marked done"
exit 0
