import { spawn } from 'node:child_process'

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function continuousSamplerScript(rootPid, intervalMs) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error('rootPid must be a positive integer')
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('intervalMs must be a positive integer')
  return `
$ErrorActionPreference='Stop'
$rootPid=[int]${String(rootPid)}
$intervalMs=[int]${String(intervalMs)}
$nextSample=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# The field harness permits at most 600s of retained capture plus 30s warmup.
# Keep an independent lifetime bound even if its parent is terminated abruptly.
$samplingDeadline=$nextSample+900000
while([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $samplingDeadline) {
  try {
    $nodes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate)
    $ids=New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add($rootPid)
    do {
      $added=$false
      foreach($node in $nodes) {
        if($ids.Contains([int]$node.ParentProcessId) -and -not $ids.Contains([int]$node.ProcessId)) {
          [void]$ids.Add([int]$node.ProcessId)
          $added=$true
        }
      }
    } while($added)
    $gpuByPid=@{}
    $gpuError=$null
    try {
      $gpuSample=Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop
      foreach($counter in @($gpuSample.CounterSamples)) {
        $instance=[string]$counter.InstanceName
        if($instance -notmatch 'pid_([0-9]+)_') { continue }
        $processId=[int]$Matches[1]
        if(-not $ids.Contains($processId)) { continue }
        $engine='unknown'
        if($instance -match 'engtype_([^_]+)') { $engine=[string]$Matches[1] }
        if(-not $gpuByPid.ContainsKey($processId)) { $gpuByPid[$processId]=@() }
        $gpuByPid[$processId] += [pscustomobject]@{
          engine=$engine
          utilization_percent=[double]$counter.CookedValue
          instance=$instance
        }
      }
    } catch {
      $gpuError=[string]$_.Exception.Message
    }
    $rows=@()
    foreach($node in $nodes) {
      if(-not $ids.Contains([int]$node.ProcessId)) { continue }
      $process=Get-Process -Id ([int]$node.ProcessId) -ErrorAction SilentlyContinue
      if($null -eq $process) { continue }
      $rows += [pscustomobject]@{
        pid=[int]$node.ProcessId
        parent_pid=[int]$node.ParentProcessId
        name=[string]$node.Name
        command_line=[string]$node.CommandLine
        executable_path=[string]$node.ExecutablePath
        creation_date=$node.CreationDate.ToUniversalTime().ToString('o')
        cpu_seconds=[double]$process.CPU
        private_bytes=[long]$process.PrivateMemorySize64
        working_set_bytes=[long]$process.WorkingSet64
        handle_count=[int]$process.HandleCount
        thread_count=[int]$process.Threads.Count
        gpu_engines=@($gpuByPid[[int]$node.ProcessId])
      }
    }
    $record=[pscustomobject]@{
      wall_time_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      gpu_available=($null -eq $gpuError)
      gpu_error=$gpuError
      processes=@($rows)
    }
  } catch {
    $record=[pscustomobject]@{
      wall_time_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      error=[string]$_.Exception.Message
    }
  }
  $json=$record | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  $nextSample += $intervalMs
  $remaining=$nextSample-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
  else { $nextSample=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
}
`
}

export function createContinuousProcessSampler({
  rootPid,
  intervalMs,
  onSample,
  onError = () => {},
  spawnProcess = spawn,
  stopProcess = async (child) => { child.kill('SIGKILL') },
  silenceTimeoutMs = Math.max(15_000, intervalMs * 2),
  maxLineBytes = 4 * 1024 * 1024,
  maxStderrBytes = 64 * 1024,
} = {}) {
  if (typeof onSample !== 'function') throw new Error('onSample must be a function')
  const script = continuousSamplerScript(rootPid, intervalMs)
  const child = spawnProcess(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let lineParts = []
  let lineBytes = 0
  let stderrBytes = 0
  let stderrText = ''
  let stopping = false
  let faulted = false
  let stopPromise = null
  let watchdog = null

  const requestStop = () => {
    if (stopPromise === null) {
      stopping = true
      stopPromise = Promise.resolve().then(() => stopProcess(child)).catch((error) => {
        reportError(`continuous sampler cleanup failed: ${String(error)}`)
      })
    }
    return stopPromise
  }
  const reportError = (message) => {
    if (faulted) return
    faulted = true
    try { onError(new Error(message)) } catch {}
    void requestStop()
  }
  const resetWatchdog = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      reportError(`continuous sampler deadline exceeded after ${String(silenceTimeoutMs)} ms without a sample`)
    }, silenceTimeoutMs)
  }
  const emitLine = () => {
    const raw = Buffer.concat(lineParts, lineBytes).toString('utf8').replace(/^\uFEFF/u, '').replace(/\r$/u, '')
    lineParts = []
    lineBytes = 0
    if (raw === '') return
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      reportError(`continuous sampler returned invalid JSON: ${String(error)}`)
      return
    }
    resetWatchdog()
    try {
      onSample(parsed)
    } catch (error) {
      reportError(`continuous sampler consumer failed: ${String(error)}`)
    }
  }
  const addPart = (part) => {
    if (faulted || part.length === 0) return
    lineBytes += part.length
    if (lineBytes > maxLineBytes) {
      reportError(`continuous sampler line exceeded ${String(maxLineBytes)} bytes`)
      return
    }
    lineParts.push(part)
  }

  child.stdout.on('data', (chunkValue) => {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    let offset = 0
    while (!faulted) {
      const newline = chunk.indexOf(0x0a, offset)
      if (newline < 0) {
        addPart(chunk.subarray(offset))
        break
      }
      addPart(chunk.subarray(offset, newline))
      if (!faulted) emitLine()
      offset = newline + 1
      if (offset >= chunk.length) break
    }
  })
  child.stderr.on('data', (chunkValue) => {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    stderrBytes += chunk.length
    if (stderrBytes <= maxStderrBytes) stderrText += chunk.toString('utf8')
    else reportError(`continuous sampler stderr exceeded ${String(maxStderrBytes)} bytes`)
  })
  child.once('error', (error) => reportError(`continuous sampler process error: ${String(error)}`))
  child.once('close', (code) => {
    clearTimeout(watchdog)
    if (!stopping) {
      const diagnostic = stderrText.trim()
      reportError(
        `continuous sampler exited unexpectedly (code ${String(code)})`
        + (diagnostic === '' ? '' : `: ${diagnostic}`),
      )
    }
  })
  resetWatchdog()

  return {
    child,
    async stop() {
      clearTimeout(watchdog)
      await requestStop()
    },
  }
}
