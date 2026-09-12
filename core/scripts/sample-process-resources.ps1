param(
  [Parameter(Mandatory = $true)][int[]]$TargetProcessId,
  [ValidateRange(1, 120)][int]$DurationSeconds = 60,
  [ValidateRange(200, 10000)][int]$IntervalMs = 1000
)
# Read-only, explicit PIDs only. Never discover/launch/stop installed apps.
$ErrorActionPreference = 'Stop'
$until = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
$previous = @{}
$identities = @{}
$gpuAvailable = $true
while ([DateTime]::UtcNow -lt $until) {
  $gpuEngines = @()
  $gpuMemory = @()
  if ($gpuAvailable) {
    try {
      $gpuEngines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)
      $gpuMemory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop)
    } catch { $gpuAvailable = $false }
  }
  $alive = 0
  foreach ($targetId in $TargetProcessId) {
    $target = Get-Process -Id $targetId -ErrorAction SilentlyContinue
    if ($null -eq $target) { continue }
    try {
    # Reject PID reuse rather than reporting an unrelated process.
    $started = $target.StartTime.ToUniversalTime().ToString('o')
    if ($identities.ContainsKey($targetId) -and $identities[$targetId] -ne $started) { continue }
    $identities[$targetId] = $started
    $alive++
    $cpuMs = $target.TotalProcessorTime.TotalMilliseconds
    $stamp = [DateTime]::UtcNow
    $privateBytes = $target.PrivateMemorySize64
    $workingSetBytes = $target.WorkingSet64
    $handles = $target.HandleCount
    $threads = $target.Threads.Count
    $cpuPercent = $null
    if ($previous.ContainsKey($targetId)) {
      $prior = $previous[$targetId]
      $elapsed = ($stamp - $prior.stamp).TotalMilliseconds
      if ($elapsed -gt 0) { $cpuPercent = 100 * ($cpuMs - $prior.cpuMs) / $elapsed }
    }
    $previous[$targetId] = @{ stamp = $stamp; cpuMs = $cpuMs }
    $prefix = 'pid_' + $targetId + '_'
    $engines = @($gpuEngines | Where-Object { $_.Name.StartsWith($prefix) } | ForEach-Object {
      @{ name = $_.Name; utilizationPercent = [double]$_.UtilizationPercentage }
    })
    $memory = @($gpuMemory | Where-Object { $_.Name.StartsWith($prefix) })
    $io = $null
    try {
      $native = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId"
      if ($null -ne $native) {
        $io = @{ readBytes = [double]$native.ReadTransferCount; writeBytes = [double]$native.WriteTransferCount; otherBytes = [double]$native.OtherTransferCount }
      }
    } catch { }
    [ordered]@{
      type = 'process'; utc = $stamp.ToString('o'); pid = $targetId; startedUtc = $started
      cpuMs = $cpuMs; cpuPercentOneCore = $cpuPercent
      privateBytes = $privateBytes; workingSetBytes = $workingSetBytes
      handles = $handles; threads = $threads; io = $io
      gpu = @{ available = $gpuAvailable; engines = $engines
        dedicatedBytes = if ($memory.Count) { ($memory | Measure-Object DedicatedUsage -Sum).Sum } else { $null }
        sharedBytes = if ($memory.Count) { ($memory | Measure-Object SharedUsage -Sum).Sum } else { $null }
        encoderSessions = $null
        encoderSessionNote = 'Not exposed by Windows process counters; video-encode engines are reported when available.'
      }
    } | ConvertTo-Json -Compress -Depth 8
    } catch {
      # Completion between Get-Process and property reads is ordinary. Other
      # errors remain failures instead of being silently reported as zero.
      if (-not $target.HasExited) { throw }
    } finally { $target.Dispose() }
  }
  if ($alive -eq 0) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
