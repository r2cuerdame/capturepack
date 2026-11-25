#Requires -Version 7
param(
  [Parameter(Mandatory)] [string[]] $Build,
  [string] $Baseline = '',
  [string] $Candidate = '',
  [int] $Rounds = 3,
  [int] $Seconds = 60,
  [int] $SoloSeconds = 60,
  [int] $WarmupSeconds = 90,
  [int] $SettleSeconds = 15,
  [switch] $SkipSolo,
  [switch] $AtDefaults,
  [string] $OutDir = '',
  [double] $CpuLimit = 60,
  [int] $QuietHourStart = 22,
  [int] $QuietHourEnd = 8,
  [double] $CpuFloor = 0.02,
  [double] $GpuFloor = 0.02,
  [double] $MemoryFloorMB = 8,
  [double] $StutterFloor = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class CpDwmSampler {
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    static volatile bool stop;
    static List<double> ms = new List<double>();
    static Thread t;
    public static void Start() {
        stop = false; ms.Clear();
        t = new Thread(() => {
            long last = 0;
            while (!stop) {
                DwmFlush();
                long n = Stopwatch.GetTimestamp();
                if (last != 0) ms.Add((n - last) * 1000.0 / Stopwatch.Frequency);
                last = n;
            }
        });
        t.IsBackground = true; t.Priority = ThreadPriority.BelowNormal; t.Start();
    }
    public static double[] Stop() { stop = true; t.Join(2000); return ms.ToArray(); }
}
'@

if ($OutDir -eq '') { $OutDir = Join-Path ([IO.Path]::GetTempPath()) ('capturepack-perf-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logPath = Join-Path $OutDir 'run.log'
function Write-Run([string]$text) { $line = '{0} {1}' -f (Get-Date -Format 's'), $text; Write-Host $line; Add-Content -Path $logPath -Value $line }

$builds = foreach ($spec in $Build) {
  $parts = $spec -split '\|', 3
  if ($parts.Count -ne 3) { throw "Build must be 'label|fps|path': $spec" }
  $exe = $parts[2]
  if (Test-Path -PathType Container $exe) { $exe = Join-Path $exe 'CapturePack.exe' }
  if (-not (Test-Path -PathType Leaf $exe)) { throw "No CapturePack.exe for $($parts[0]): $exe" }
  [pscustomobject]@{ Label = $parts[0]; Fps = [int]$parts[1]; Exe = (Resolve-Path $exe).Path; Version = (Get-Item $exe).VersionInfo.ProductVersion }
}
if (($builds.Label | Select-Object -Unique).Count -ne $builds.Count) { throw 'Build labels must be unique' }
foreach ($name in @($Baseline, $Candidate) | Where-Object { $_ -ne '' }) {
  if ($builds.Label -notcontains $name) { throw "Unknown build label: $name" }
}
if ($Baseline -ne '' -and $Candidate -ne '' -and -not $AtDefaults -and ($builds | Where-Object Label -eq $Baseline).Fps -ne ($builds | Where-Object Label -eq $Candidate).Fps) {
  Write-Host 'refused: baseline and candidate frame rates differ; pass -AtDefaults to compare each build at its own default'
  exit 2
}
$displays = [System.Windows.Forms.Screen]::AllScreens.Count

function Assert-AllowedHour {
  $h = (Get-Date).Hour
  $quiet = if ($QuietHourStart -gt $QuietHourEnd) { $h -ge $QuietHourStart -or $h -lt $QuietHourEnd } else { $h -ge $QuietHourStart -and $h -lt $QuietHourEnd }
  if ($quiet) { Write-Run "refused: launches are not allowed between ${QuietHourStart}:00 and ${QuietHourEnd}:00"; exit 2 }
}

function Get-SystemCpu([int]$samples = 5) {
  $s = Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples $samples -ErrorAction SilentlyContinue
  ($s.CounterSamples | Measure-Object CookedValue -Average).Average
}

function Wait-CpuBelow {
  for ($i = 0; $i -lt 20; $i++) {
    $cpu = Get-SystemCpu
    if ($cpu -lt $CpuLimit) { return $cpu }
    Write-Run ('system cpu {0:N1}% >= {1}%, waiting 30 s' -f $cpu, $CpuLimit)
    Start-Sleep -Seconds 30
  }
  Write-Run "aborted: system cpu stayed at or above $CpuLimit% for 10 minutes"
  exit 2
}

$launchCount = 0
function Start-Instance($b) {
  Assert-AllowedHour
  $script:launchCount += 1
  $profileDir = Join-Path $OutDir ('profile-{0:D2}-{1}' -f $script:launchCount, ($b.Label -replace '[^\w.-]', '_'))
  $outputDir = Join-Path $profileDir 'packs'
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  $settings = [ordered]@{
    settingsVersion = 3
    fps = $b.Fps
    replaySeconds = 30
    replayMaxWidth = 1920
    captureDisplay = 'all'
    captureBackend = 'auto'
    recordingEnabled = $true
    uiaEnabled = $true
    contextResolution = 'balanced'
    outputDir = $outputDir
    welcomeShown = $true
    welcomeDeferredFromLogin = $false
    showEditorTutorial = $false
    launchAtLogin = $false
    autoUpdateCheck = $false
    notifyOnRecordingStart = $false
    mcpEnabled = $false
    mcpAutoStart = $false
    chromeDomEnabled = $false
    captureHotkey = 'Ctrl+Alt+Shift+F{0}' -f (13 + (2 * $script:launchCount - 2) % 12)
    imageCaptureHotkey = 'Ctrl+Alt+Shift+F{0}' -f (14 + (2 * $script:launchCount - 2) % 12)
  }
  $settings | ConvertTo-Json | Set-Content -Path (Join-Path $profileDir 'settings.json') -Encoding utf8NoBOM
  $psi = [Diagnostics.ProcessStartInfo]::new($b.Exe)
  foreach ($a in @('--openAsHidden', '--no-login-item', "--user-data-dir=$profileDir")) { $psi.ArgumentList.Add($a) }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Environment['CAPTUREPACK_FIELD_QA'] = '0'
  $p = [Diagnostics.Process]::Start($psi)
  $null = $p.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
  $null = $p.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  Write-Run ("started {0} v{1} fps={2} pid={3}" -f $b.Label, $b.Version, $b.Fps, $p.Id)
  [pscustomobject]@{ Build = $b; Root = $p; Profile = $profileDir; Pids = @($p.Id) }
}

function Update-Trees($instances) {
  $all = Get-Process
  foreach ($inst in $instances) {
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($inst.Root.Id)
    do {
      $n = $ids.Count
      foreach ($p in $all) { if ($p.Parent -and $ids.Contains($p.Parent.Id)) { [void]$ids.Add($p.Id) } }
    } while ($ids.Count -ne $n)
    $inst.Pids = @($ids)
  }
}

function Wait-Recording($instances) {
  $deadline = (Get-Date).AddSeconds($WarmupSeconds)
  $pending = @($instances)
  while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $pending = @($pending | Where-Object {
      $log = Join-Path $_.Profile 'logs\main.log'
      $count = if (Test-Path $log) { @(Select-String -Path $log -Pattern '-> recording' -SimpleMatch).Count } else { 0 }
      $count -lt $displays
    })
  }
  foreach ($inst in $pending) { Write-Run "invalid: $($inst.Build.Label) did not reach recording on $displays displays within $WarmupSeconds s" }
  if ($pending.Count -gt 0) { return $false }
  Start-Sleep -Seconds $SettleSeconds
  Update-Trees $instances
  $true
}

function Stop-Instance($inst) {
  Update-Trees @($inst)
  foreach ($id in $inst.Pids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  foreach ($id in $inst.Pids) { try { (Get-Process -Id $id -ErrorAction Stop).WaitForExit(10000) | Out-Null } catch {} }
  Write-Run "stopped $($inst.Build.Label) ($($inst.Pids.Count) processes)"
}

function Get-Percentile([double[]]$v, [double]$p) {
  if ($v.Count -eq 0) { return $null }
  $s = $v | Sort-Object
  $s[[Math]::Min($s.Count - 1, [int][Math]::Floor($p * $s.Count))]
}

function Measure-Window($instances, [int]$secs, [bool]$withDwm) {
  $pidOwner = @{}
  foreach ($inst in $instances) { foreach ($id in $inst.Pids) { $pidOwner[$id] = $inst.Build.Label } }
  $gpuJob = Start-Job -ArgumentList (($pidOwner.Keys | ForEach-Object { $_ }) -join ','), $secs -ScriptBlock {
    param($idText, $n)
    $ids = @($idText -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
    $samples = Get-Counter -Counter @('\GPU Engine(*)\Utilization Percentage', '\GPU Process Memory(*)\Dedicated Usage') -SampleInterval 1 -MaxSamples ($n - 2) -ErrorAction SilentlyContinue
    $sum = @{}
    foreach ($s in $samples) {
      foreach ($c in $s.CounterSamples) {
        $m = [regex]::Match($c.InstanceName, 'pid_(\d+)_')
        if (-not $m.Success) { continue }
        $id = [int]$m.Groups[1].Value
        if ($ids -notcontains $id) { continue }
        $key = if ($c.Path -like '*dedicated usage') { "$id|dedicatedBytes" } else { "$id|" + ($c.InstanceName -replace '.*engtype_', '').ToLowerInvariant() }
        if (-not $sum.ContainsKey($key)) { $sum[$key] = 0.0 }
        $sum[$key] += $c.CookedValue
      }
    }
    $count = [Math]::Max(1, @($samples).Count)
    foreach ($k in $sum.Keys) { [pscustomobject]@{ Key = $k; Avg = $sum[$k] / $count } }
  }
  $sysJob = Start-Job -ArgumentList $secs -ScriptBlock {
    param($n)
    $s = Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples ($n - 2) -ErrorAction SilentlyContinue
    ($s.CounterSamples | Measure-Object CookedValue -Average).Average
  }
  $state = @{}
  foreach ($inst in $instances) {
    $cpu = 0.0
    foreach ($id in $inst.Pids) { $q = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($q) { $cpu += $q.TotalProcessorTime.TotalMilliseconds } }
    $state[$inst.Build.Label] = @{ Prev = $cpu; Cpu = [Collections.Generic.List[double]]::new(); Ws = [Collections.Generic.List[double]]::new(); Priv = [Collections.Generic.List[double]]::new(); Alive = $inst.Pids.Count }
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  if ($withDwm) { [CpDwmSampler]::Start() }
  $prevT = 0.0
  while ($clock.Elapsed.TotalSeconds -lt $secs) {
    Start-Sleep -Milliseconds 1000
    $t = $clock.Elapsed.TotalMilliseconds
    foreach ($inst in $instances) {
      $cpu = 0.0; $ws = 0.0; $priv = 0.0; $alive = 0
      foreach ($id in $inst.Pids) {
        $q = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($q) { $alive += 1; $cpu += $q.TotalProcessorTime.TotalMilliseconds; $ws += $q.WorkingSet64; $priv += $q.PrivateMemorySize64 }
      }
      $st = $state[$inst.Build.Label]
      $st.Cpu.Add(($cpu - $st.Prev) / ($t - $prevT) * 100 / [Environment]::ProcessorCount)
      $st.Prev = $cpu
      $st.Ws.Add($ws / 1MB); $st.Priv.Add($priv / 1MB)
      $st.Alive = [Math]::Min($st.Alive, $alive)
    }
    $prevT = $t
  }
  $frames = if ($withDwm) { [CpDwmSampler]::Stop() } else { @() }
  $gpuRows = @(Receive-Job $gpuJob -Wait -AutoRemoveJob)
  $sysCpu = Receive-Job $sysJob -Wait -AutoRemoveJob
  $per = [ordered]@{}
  foreach ($inst in $instances) {
    $label = $inst.Build.Label
    $st = $state[$label]
    $gpu = [ordered]@{}
    $dedicated = 0.0
    foreach ($row in $gpuRows) {
      $id, $what = $row.Key -split '\|', 2
      if ($pidOwner[[int]$id] -ne $label) { continue }
      if ($what -eq 'dedicatedBytes') { $dedicated += $row.Avg; continue }
      if (-not $gpu.Contains($what)) { $gpu[$what] = 0.0 }
      $gpu[$what] += $row.Avg
    }
    $per[$label] = [ordered]@{
      cpuAvgPct = ($st.Cpu | Measure-Object -Average).Average
      cpuMaxPct = ($st.Cpu | Measure-Object -Maximum).Maximum
      workingSetAvgMB = ($st.Ws | Measure-Object -Average).Average
      workingSetMaxMB = ($st.Ws | Measure-Object -Maximum).Maximum
      privateAvgMB = ($st.Priv | Measure-Object -Average).Average
      gpuDedicatedAvgMB = $dedicated / 1MB
      gpuVideoEncodePct = [double]($gpu['videoencode'] ?? 0)
      gpu3dPct = [double]($gpu['3d'] ?? 0)
      gpuCopyPct = [double]($gpu['copy'] ?? 0)
      gpuEngines = $gpu
      processes = $inst.Pids.Count
      processesAliveMin = $st.Alive
    }
  }
  $window = [ordered]@{ seconds = $secs; systemCpuAvgPct = $sysCpu; instances = $per }
  if ($withDwm) {
    $slow = @($frames | Where-Object { $_ -gt 25 }).Count
    $window.dwm = [ordered]@{
      intervals = $frames.Count
      p50Ms = Get-Percentile $frames 0.5
      p99Ms = Get-Percentile $frames 0.99
      maxMs = ($frames | Measure-Object -Maximum).Maximum
      over25Ms = $slow
      over25PerMinute = if ($secs -gt 0) { $slow * 60.0 / $secs } else { $null }
    }
  }
  $window
}

Assert-AllowedHour
Write-Run ("out={0} displays={1} rounds={2} builds={3}" -f $OutDir, $displays, $Rounds, (($builds | ForEach-Object { "$($_.Label)(v$($_.Version),$($_.Fps)fps)" }) -join ', '))
$result = [ordered]@{
  startedAt = (Get-Date).ToString('o')
  host = [ordered]@{ logicalCores = [Environment]::ProcessorCount; displays = $displays; os = [Environment]::OSVersion.VersionString }
  builds = @($builds | ForEach-Object { [ordered]@{ label = $_.Label; version = $_.Version; fps = $_.Fps; exe = $_.Exe } })
  sideBySide = @()
  solo = @()
  valid = $true
}

$null = Wait-CpuBelow
$running = @($builds | ForEach-Object { Start-Instance $_ })
try {
  if (-not (Wait-Recording $running)) { $result.valid = $false }
  else {
    for ($r = 1; $r -le $Rounds; $r++) {
      $null = Wait-CpuBelow
      $w = Measure-Window $running $Seconds $false
      $w.round = $r
      $result.sideBySide += $w
      Write-Run ("side-by-side round {0}: {1}" -f $r, (($w.instances.GetEnumerator() | ForEach-Object { '{0} cpu={1:N3}% enc={2:N3}% 3d={3:N3}% copy={4:N3}% ws={5:N0}MB' -f $_.Key, $_.Value.cpuAvgPct, $_.Value.gpuVideoEncodePct, $_.Value.gpu3dPct, $_.Value.gpuCopyPct, $_.Value.workingSetAvgMB }) -join ' | '))
    }
  }
} finally {
  foreach ($inst in $running) { Stop-Instance $inst }
}

if (-not $SkipSolo -and $result.valid) {
  $order = @($builds.Label) + @('(none)')
  for ($r = 1; $r -le $Rounds; $r++) {
    $shift = ($r - 1) % $order.Count
    $rotated = @($order[$shift..($order.Count - 1)]) + @(if ($shift -gt 0) { $order[0..($shift - 1)] })
    foreach ($label in $rotated) {
      $null = Wait-CpuBelow
      if ($label -eq '(none)') {
        $w = Measure-Window @() $SoloSeconds $true
      } else {
        $inst = Start-Instance ($builds | Where-Object Label -eq $label)
        try {
          if (-not (Wait-Recording @($inst))) { $result.valid = $false; continue }
          $w = Measure-Window @($inst) $SoloSeconds $true
        } finally { Stop-Instance $inst }
      }
      $w.round = $r
      $w.label = $label
      $result.solo += $w
      Write-Run ('solo round {0} {1}: dwm >25ms/min={2:N1} p99={3:N2}ms system cpu={4:N1}%' -f $r, $label, $w.dwm.over25PerMinute, $w.dwm.p99Ms, $w.systemCpuAvgPct)
    }
  }
}

function Get-Median([double[]]$v) { if ($v.Count -eq 0) { return $null }; $s = $v | Sort-Object; if ($s.Count % 2) { $s[($s.Count - 1) / 2] } else { ($s[$s.Count / 2 - 1] + $s[$s.Count / 2]) / 2 } }

$metrics = @(
  @{ Name = 'cpuAvgPct'; Floor = $CpuFloor },
  @{ Name = 'workingSetAvgMB'; Floor = $MemoryFloorMB },
  @{ Name = 'privateAvgMB'; Floor = $MemoryFloorMB },
  @{ Name = 'gpuDedicatedAvgMB'; Floor = $MemoryFloorMB },
  @{ Name = 'gpuVideoEncodePct'; Floor = $GpuFloor },
  @{ Name = 'gpu3dPct'; Floor = $GpuFloor },
  @{ Name = 'gpuCopyPct'; Floor = $GpuFloor }
)
$summary = [ordered]@{}
foreach ($b in $builds) {
  $row = [ordered]@{}
  foreach ($m in $metrics) { $row[$m.Name] = Get-Median @($result.sideBySide | ForEach-Object { [double]$_.instances[$b.Label][$m.Name] }) }
  $row['stutterPerMinute'] = Get-Median @($result.solo | Where-Object label -eq $b.Label | ForEach-Object { [double]$_.dwm.over25PerMinute })
  $summary[$b.Label] = $row
}
$summary['(none)'] = [ordered]@{ stutterPerMinute = Get-Median @($result.solo | Where-Object label -eq '(none)' | ForEach-Object { [double]$_.dwm.over25PerMinute }) }
$result.medians = $summary

$exitCode = if ($result.valid) { 0 } else { 2 }
if ($Baseline -ne '' -and $Candidate -ne '' -and $result.valid) {
  $base = $builds | Where-Object Label -eq $Baseline
  $cand = $builds | Where-Object Label -eq $Candidate
  $verdict = [ordered]@{ baseline = $Baseline; candidate = $Candidate; baselineFps = $base.Fps; candidateFps = $cand.Fps; mode = $(if ($AtDefaults) { 'each-default' } else { 'same-settings' }); increased = @(); checks = @() }
  foreach ($m in $metrics) {
    $d = @($result.sideBySide | ForEach-Object { [double]$_.instances[$Candidate][$m.Name] - [double]$_.instances[$Baseline][$m.Name] })
    $med = Get-Median $d
    $up = ($d.Count -gt 0) -and (@($d | Where-Object { $_ -le 0 }).Count -eq 0) -and ($med -gt $m.Floor)
    $verdict.checks += [ordered]@{ metric = $m.Name; pairedDiffs = $d; medianDiff = $med; floor = $m.Floor; increased = $up }
    if ($up) { $verdict.increased += $m.Name }
  }
  $bs = @($result.solo | Where-Object label -eq $Baseline | ForEach-Object { [double]$_.dwm.over25PerMinute })
  $cs = @($result.solo | Where-Object label -eq $Candidate | ForEach-Object { [double]$_.dwm.over25PerMinute })
  if ($bs.Count -gt 0 -and $cs.Count -gt 0) {
    $bMax = ($bs | Measure-Object -Maximum).Maximum
    $cMed = Get-Median $cs
    $up = ($cMed -gt $bMax) -and (($cMed - (Get-Median $bs)) -gt $StutterFloor)
    $verdict.checks += [ordered]@{ metric = 'stutterPerMinute'; baseline = $bs; candidate = $cs; floor = $StutterFloor; increased = $up }
    if ($up) { $verdict.increased += 'stutterPerMinute' }
  } elseif (-not $SkipSolo) {
    $result.valid = $false
  }
  $verdict.pass = $result.valid -and $verdict.increased.Count -eq 0
  $result.verdict = $verdict
  $exitCode = if (-not $result.valid) { 2 } elseif ($verdict.pass) { 0 } else { 1 }
  Write-Run ('verdict {0} vs {1}: {2}{3}' -f $Candidate, $Baseline, $(if ($verdict.pass) { 'PASS' } elseif ($exitCode -eq 2) { 'INVALID' } else { 'FAIL' }), $(if ($verdict.increased.Count) { ' increased=' + ($verdict.increased -join ',') } else { '' }))
}
$result.finishedAt = (Get-Date).ToString('o')
$result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir 'results.json') -Encoding utf8NoBOM

$lines = @('| build | version | fps | CPU % | working set MB | private MB | GPU dedicated MB | GPU videoencode % | GPU 3d % | GPU copy % | stutter >25 ms / min |', '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
foreach ($b in $builds) {
  $m = $summary[$b.Label]
  $lines += ('| {0} | {1} | {2} | {3:N3} | {4:N0} | {5:N0} | {6:N0} | {7:N3} | {8:N3} | {9:N3} | {10} |' -f $b.Label, $b.Version, $b.Fps, $m.cpuAvgPct, $m.workingSetAvgMB, $m.privateAvgMB, $m.gpuDedicatedAvgMB, $m.gpuVideoEncodePct, $m.gpu3dPct, $m.gpuCopyPct, $(if ($null -eq $m.stutterPerMinute) { '-' } else { '{0:N1}' -f $m.stutterPerMinute }))
}
if ($null -ne $summary['(none)'].stutterPerMinute) { $lines += ('| (none) | - | - | - | - | - | - | - | - | - | {0:N1} |' -f $summary['(none)'].stutterPerMinute) }
$lines | Set-Content -Path (Join-Path $OutDir 'summary.md') -Encoding utf8NoBOM
$lines | ForEach-Object { Write-Host $_ }
exit $exitCode
