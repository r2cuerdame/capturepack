$ErrorActionPreference = 'Stop'
$taskDir = $PSScriptRoot
$taskSeen = @{}
$taskDeadline = [DateTime]::UtcNow.AddMinutes(30)
while ([DateTime]::UtcNow -lt $taskDeadline) {
  $taskAll = @(Get-CimInstance Win32_Process)
  $taskIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$taskIds.Add(37816)
  do {
    $taskAdded = $false
    foreach ($p in $taskAll) { if ($taskIds.Contains([int]$p.ParentProcessId) -and $taskIds.Add([int]$p.ProcessId)) { $taskAdded=$true } }
  } while ($taskAdded)
  foreach ($p in $taskAll) {
    $taskKey = "$($p.ProcessId):$($p.CreationDate.ToUniversalTime().Ticks)"
    if ($taskIds.Contains([int]$p.ProcessId)) { $taskSeen[$taskKey] = [pscustomobject]@{pid=$p.ProcessId;parentPid=$p.ParentProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('o');name=$p.Name;commandLine=$p.CommandLine;executablePath=$p.ExecutablePath} }
  }
  if (Test-Path (Join-Path $taskDir 'exit.json')) { break }
  Start-Sleep -Seconds 10
}
Start-Sleep -Seconds 3
$taskSurvivors = @(Get-CimInstance Win32_Process | Where-Object { $taskSeen.ContainsKey("$($_.ProcessId):$($_.CreationDate.ToUniversalTime().Ticks)") } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate)
[pscustomobject]@{time=[DateTime]::UtcNow.ToString('o');inspectorPid=$PID;rootPid=37816;observed=$taskSeen.Values;survivors=$taskSurvivors;runnerCompleted=(Test-Path (Join-Path $taskDir 'exit.json'))} | ConvertTo-Json -Depth 7 | Set-Content (Join-Path $taskDir 'independent-cleanup.json') -Encoding UTF8
