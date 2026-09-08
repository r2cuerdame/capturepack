param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$EvidenceDir
)

$ErrorActionPreference = 'Stop'
if ($env:CAPTUREPACK_DISPOSABLE_WINDOWS_ACCEPTANCE -ne '1') {
  throw 'BLOCKED: installer lifecycle may run only in a disposable Windows user/managed room (set CAPTUREPACK_DISPOSABLE_WINDOWS_ACCEPTANCE=1 there)'
}
$installerPath = [IO.Path]::GetFullPath($Installer)
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
if (![IO.File]::Exists($installerPath)) { throw "Installer not found: $installerPath" }
[IO.Directory]::CreateDirectory($evidencePath) | Out-Null
$installPath = [IO.Path]::Combine($evidencePath, 'installed')
$appData = [IO.Path]::Combine([Environment]::GetFolderPath('ApplicationData'), 'CapturePack')
$defaultInstall = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Programs', 'capturepack')
$hostKeys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.capturepack.host',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.capturepack.host',
  'HKCU:\Software\Chromium\NativeMessagingHosts\com.capturepack.host'
)

function Assert-DisposableState {
  if (Get-Process chrome, CapturePack -ErrorAction SilentlyContinue) {
    throw 'Disposable-user precondition failed: Chrome or CapturePack is already running'
  }
  if ((Test-Path $appData) -or (Test-Path $defaultInstall) -or (Test-Path $installPath)) {
    throw 'Disposable-user precondition failed: CapturePack app/install data already exists'
  }
  foreach ($key in $hostKeys) {
    if (Test-Path $key) { throw "Disposable-user precondition failed: $key already exists" }
  }
  $existing = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Where-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName -eq 'CapturePack' }
  if ($existing) { throw 'Disposable-user precondition failed: CapturePack uninstall registration exists' }
}

function Run-Setup([string]$Phase) {
  $started = [DateTimeOffset]::UtcNow
  $process = Start-Process `
    -FilePath $installerPath `
    -ArgumentList @('/S', "/D=$installPath") `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "$Phase setup failed with exit $($process.ExitCode)" }
  $exe = [IO.Path]::Combine($installPath, 'CapturePack.exe')
  $uninstaller = [IO.Path]::Combine($installPath, 'Uninstall CapturePack.exe')
  if (![IO.File]::Exists($exe) -or ![IO.File]::Exists($uninstaller)) {
    throw "$Phase setup did not produce the packaged app and uninstaller in $installPath"
  }
  return [ordered]@{
    phase = $Phase
    startedAt = $started.ToString('o')
    finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    exeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant()
    uninstaller = $uninstaller
  }
}

Assert-DisposableState
$evidence = [ordered]@{
  schema = 1
  installer = $installerPath
  installerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash.ToLowerInvariant()
  user = [Environment]::UserName
  machine = [Environment]::MachineName
  install = $null
  update = $null
  remove = $null
  status = 'FAIL'
}
try {
  $evidence.install = Run-Setup 'install'
  [IO.Directory]::CreateDirectory($appData) | Out-Null
  $hostManifest = [IO.Path]::Combine($appData, 'com.capturepack.host.json')
  $hostLauncher = [IO.Path]::Combine($appData, 'capturepack-host.cmd')
  [IO.File]::WriteAllText($hostManifest, '{"name":"com.capturepack.host","type":"stdio"}', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($hostLauncher, '@echo off', [Text.UTF8Encoding]::new($false))
  New-Item -Path $hostKeys[0] -Force | Out-Null
  Set-Item -Path $hostKeys[0] -Value $hostManifest
  $evidence.update = Run-Setup 'same-candidate update'
  $restoredHost = (Get-Item -LiteralPath $hostKeys[0]).GetValue('')
  if ($restoredHost -ne $hostManifest -or !(Test-Path -LiteralPath $hostManifest) -or !(Test-Path -LiteralPath $hostLauncher)) {
    throw 'same-candidate update did not restore the exact enabled Chrome native-host state'
  }
  $evidence.update.hostStateRestored = $true
  $uninstaller = $evidence.update.uninstaller
  $removeStarted = [DateTimeOffset]::UtcNow
  $removed = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru -WindowStyle Hidden
  if ($removed.ExitCode -ne 0) { throw "uninstall failed with exit $($removed.ExitCode)" }
  Start-Sleep -Milliseconds 500
  $residue = [Collections.Generic.List[string]]::new()
  if (Test-Path $installPath) { $residue.Add($installPath) }
  foreach ($file in @('com.capturepack.host.json', 'capturepack-host.cmd', 'installer-pending\state.json')) {
    $candidate = [IO.Path]::Combine($appData, $file)
    if (Test-Path $candidate) { $residue.Add($candidate) }
  }
  foreach ($key in $hostKeys) { if (Test-Path $key) { $residue.Add($key) } }
  if (Get-Process CapturePack -ErrorAction SilentlyContinue) { $residue.Add('CapturePack.exe process') }
  $evidence.remove = [ordered]@{
    startedAt = $removeStarted.ToString('o')
    finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    residue = @($residue)
  }
  if ($residue.Count -ne 0) { throw "uninstall residue: $($residue -join ', ')" }
  $evidence.status = 'PASS'
} finally {
  $evidence.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $json = $evidence | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText(
    [IO.Path]::Combine($evidencePath, 'installer-lifecycle.json'),
    $json,
    [Text.UTF8Encoding]::new($false)
  )
}

Write-Output ($evidence | ConvertTo-Json -Depth 8)
