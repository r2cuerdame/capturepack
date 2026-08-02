param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('save', 'restore', 'save-pending', 'persist-pending', 'restore-pending')]
  [string]$Mode,

  [string]$StateFile = '',

  [string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run',

  [string]$ValueName = 'CapturePack',

  [string]$PendingDir = '',

  [string]$SourceDir = '',

  [string]$AppDataDir = '',

  # QA supplies a private HKCU subtree here. Production deliberately leaves it
  # empty so the four Chromium registrations and login values use their real
  # per-user locations.
  [string]$RegistrySandboxRoot = ''
)

$ErrorActionPreference = 'Stop'

$manifestName = 'com.capturepack.host.json'
$launcherName = 'capturepack-host.cmd'
$pendingStateName = 'state.json'
$browserKeys = [ordered]@{
  chrome = 'Software\Google\Chrome\NativeMessagingHosts\com.capturepack.host'
  edge = 'Software\Microsoft\Edge\NativeMessagingHosts\com.capturepack.host'
  brave = 'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.capturepack.host'
  chromium = 'Software\Chromium\NativeMessagingHosts\com.capturepack.host'
}
$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$startupApprovedKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'

function Require-Argument([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required for mode $Mode"
  }
}

function Resolve-RegistryKey([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RegistrySandboxRoot)) {
    return $RelativePath
  }
  return "$RegistrySandboxRoot\$RelativePath"
}

function Read-StringValue([string]$RelativePath, [string]$Name) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
    (Resolve-RegistryKey $RelativePath),
    $false
  )
  if ($null -eq $key) {
    return [ordered]@{ present = $false; kind = ''; value = '' }
  }
  try {
    if ($key.GetValueNames() -notcontains $Name) {
      return [ordered]@{ present = $false; kind = ''; value = '' }
    }
    $kind = $key.GetValueKind($Name)
    if (
      $kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
      $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString
    ) {
      throw "Expected a string registry value at $RelativePath ($Name), found $kind"
    }
    $value = $key.GetValue(
      $Name,
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    return [ordered]@{
      present = $true
      kind = $kind.ToString()
      value = [string]$value
    }
  } finally {
    $key.Dispose()
  }
}

function Read-BinaryValue([string]$RelativePath, [string]$Name) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
    (Resolve-RegistryKey $RelativePath),
    $false
  )
  if ($null -eq $key) {
    return [ordered]@{ present = $false; value = '' }
  }
  try {
    if ($key.GetValueNames() -notcontains $Name) {
      return [ordered]@{ present = $false; value = '' }
    }
    $value = $key.GetValue($Name)
    if ($value -isnot [byte[]]) {
      throw "Expected REG_BINARY at $RelativePath ($Name)"
    }
    return [ordered]@{
      present = $true
      value = [Convert]::ToBase64String($value)
    }
  } finally {
    $key.Dispose()
  }
}

function Restore-StringValue(
  [string]$RelativePath,
  [string]$Name,
  [object]$State,
  [bool]$RemoveWholeKeyWhenAbsent = $false
) {
  $resolved = Resolve-RegistryKey $RelativePath
  if ($State.present -eq $true) {
    $kind = switch ([string]$State.kind) {
      'ExpandString' { [Microsoft.Win32.RegistryValueKind]::ExpandString; break }
      'String' { [Microsoft.Win32.RegistryValueKind]::String; break }
      default { throw "Unsupported string registry kind: $($State.kind)" }
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($resolved)
    try {
      $key.SetValue($Name, [string]$State.value, $kind)
    } finally {
      $key.Dispose()
    }
    return
  }

  if ($RemoveWholeKeyWhenAbsent) {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($resolved, $false)
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($resolved, $true)
  if ($null -ne $key) {
    try {
      $key.DeleteValue($Name, $false)
    } finally {
      $key.Dispose()
    }
  }
}

function Restore-BinaryValue([string]$RelativePath, [string]$Name, [object]$State) {
  $resolved = Resolve-RegistryKey $RelativePath
  if ($State.present -eq $true) {
    $bytes = [Convert]::FromBase64String([string]$State.value)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($resolved)
    try {
      $key.SetValue($Name, $bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
    } finally {
      $key.Dispose()
    }
    return
  }
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($resolved, $true)
  if ($null -ne $key) {
    try {
      $key.DeleteValue($Name, $false)
    } finally {
      $key.Dispose()
    }
  }
}

function Remove-ExactDirectory([string]$Directory) {
  if ([IO.Directory]::Exists($Directory)) {
    [IO.Directory]::Delete($Directory, $true)
  }
}

function Write-JsonWithoutBom([string]$File, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($File, $json, [Text.UTF8Encoding]::new($false))
}

function Copy-OptionalFile(
  [string]$From,
  [string]$ToDirectory,
  [string]$StoredName
) {
  if (![IO.File]::Exists($From)) {
    return $false
  }
  [IO.File]::Copy($From, [IO.Path]::Combine($ToDirectory, $StoredName), $true)
  return $true
}

function Save-PendingSnapshot {
  Require-Argument 'PendingDir' $PendingDir
  Require-Argument 'AppDataDir' $AppDataDir

  $temporary = "$PendingDir.tmp-$PID"
  Remove-ExactDirectory $temporary
  [IO.Directory]::CreateDirectory($temporary) | Out-Null
  try {
    $manifest = Copy-OptionalFile `
      ([IO.Path]::Combine($AppDataDir, $manifestName)) `
      $temporary `
      $manifestName
    $launcher = Copy-OptionalFile `
      ([IO.Path]::Combine($AppDataDir, $launcherName)) `
      $temporary `
      $launcherName

    # SCHEMA STAYS 1 THOUGH `files.shortcut` IS GONE (#80). Bumping it would
    # make Read-PendingState reject a state.json written by an interrupted
    # 0.3.4 install, and rejecting it fails the very update that was meant to
    # recover from it. Both directions are already safe without a bump: this
    # build ignores the extra field a 0.3.4 file carries, and a 0.3.4 installer
    # reading a file written here treats the missing field as "no shortcut" —
    # which is exactly the truth now.
    $state = [ordered]@{
      schema = 1
      browsers = [ordered]@{
        chrome = Read-StringValue $browserKeys.chrome ''
        edge = Read-StringValue $browserKeys.edge ''
        brave = Read-StringValue $browserKeys.brave ''
        chromium = Read-StringValue $browserKeys.chromium ''
      }
      run = Read-StringValue $runKey 'CapturePack'
      startupApproved = Read-BinaryValue $startupApprovedKey 'CapturePack'
      files = [ordered]@{
        manifest = $manifest
        launcher = $launcher
      }
    }
    # state.json is the readiness marker and is always written last.
    Write-JsonWithoutBom ([IO.Path]::Combine($temporary, $pendingStateName)) $state
    Remove-ExactDirectory $PendingDir
    [IO.Directory]::Move($temporary, $PendingDir)
  } finally {
    Remove-ExactDirectory $temporary
  }
}

function Read-PendingState([string]$Directory) {
  $statePath = [IO.Path]::Combine($Directory, $pendingStateName)
  if (![IO.File]::Exists($statePath)) {
    throw "Pending snapshot has no $pendingStateName"
  }
  $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json
  if ([int]$state.schema -ne 1) {
    throw "Unsupported pending snapshot schema: $($state.schema)"
  }
  return $state
}

function Persist-PendingSnapshot {
  Require-Argument 'SourceDir' $SourceDir
  Require-Argument 'PendingDir' $PendingDir
  [void](Read-PendingState $SourceDir)

  $parent = [IO.Directory]::GetParent($PendingDir)
  if ($null -eq $parent) {
    throw "PendingDir has no parent: $PendingDir"
  }
  [IO.Directory]::CreateDirectory($parent.FullName) | Out-Null
  $temporary = "$PendingDir.tmp-$PID"
  Remove-ExactDirectory $temporary
  [IO.Directory]::CreateDirectory($temporary) | Out-Null
  try {
    foreach ($name in @($manifestName, $launcherName)) {
      $source = [IO.Path]::Combine($SourceDir, $name)
      if ([IO.File]::Exists($source)) {
        [IO.File]::Copy($source, [IO.Path]::Combine($temporary, $name), $true)
      }
    }
    # The marker is copied last, then the complete sibling directory is moved.
    [IO.File]::Copy(
      [IO.Path]::Combine($SourceDir, $pendingStateName),
      [IO.Path]::Combine($temporary, $pendingStateName),
      $true
    )
    Remove-ExactDirectory $PendingDir
    [IO.Directory]::Move($temporary, $PendingDir)
  } finally {
    Remove-ExactDirectory $temporary
  }
}

function Restore-OptionalFile(
  [bool]$WasPresent,
  [string]$StoredName,
  [string]$Destination
) {
  if ($WasPresent) {
    $source = [IO.Path]::Combine($PendingDir, $StoredName)
    if (![IO.File]::Exists($source)) {
      throw "Pending snapshot is missing $StoredName"
    }
    $parent = [IO.Path]::GetDirectoryName($Destination)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    [IO.File]::Copy($source, $Destination, $true)
    return
  }
  if ([IO.File]::Exists($Destination)) {
    [IO.File]::Delete($Destination)
  }
}

function Restore-PendingSnapshot {
  Require-Argument 'PendingDir' $PendingDir
  Require-Argument 'AppDataDir' $AppDataDir
  $state = Read-PendingState $PendingDir

  # Files first. Browser registration is restored last while the installer's
  # stand-down flag still prevents a cached Chromium port from starting early.
  Restore-OptionalFile `
    ($state.files.manifest -eq $true) `
    $manifestName `
    ([IO.Path]::Combine($AppDataDir, $manifestName))
  Restore-OptionalFile `
    ($state.files.launcher -eq $true) `
    $launcherName `
    ([IO.Path]::Combine($AppDataDir, $launcherName))
  # The Start Menu fallback shortcut is deliberately NOT restored (#80): a
  # 0.3.4 snapshot may still carry one, and putting it back would hand the
  # user's capture hotkey to Explorer with nothing left to take it away again.
  # Remove-ExactDirectory below discards the staged copy with the rest.

  Restore-StringValue $runKey 'CapturePack' $state.run
  Restore-BinaryValue $startupApprovedKey 'CapturePack' $state.startupApproved
  Restore-StringValue $browserKeys.chrome '' $state.browsers.chrome $true
  Restore-StringValue $browserKeys.edge '' $state.browsers.edge $true
  Restore-StringValue $browserKeys.brave '' $state.browsers.brave $true
  Restore-StringValue $browserKeys.chromium '' $state.browsers.chromium $true

  # Consume only after every file and registry operation succeeded.
  Remove-ExactDirectory $PendingDir
}

try {
  if ($Mode -eq 'save') {
    Require-Argument 'StateFile' $StateFile
    $temporaryStateFile = "$StateFile.tmp-$PID"
    if ([IO.File]::Exists($temporaryStateFile)) {
      [IO.File]::Delete($temporaryStateFile)
    }
    # The state file itself is the success marker. Remove any previous marker
    # before reading the registry, then publish a fully written sibling file;
    # a failed read can therefore never be mistaken for a fresh snapshot.
    if ([IO.File]::Exists($StateFile)) {
      [IO.File]::Delete($StateFile)
    }
    try {
      $value = Get-ItemPropertyValue -LiteralPath $RegistryPath -Name $ValueName
      if ($value -isnot [byte[]]) {
        throw 'CapturePack StartupApproved is not REG_BINARY'
      }
      [IO.File]::WriteAllText(
        $temporaryStateFile,
        [Convert]::ToBase64String($value)
      )
      [IO.File]::Move($temporaryStateFile, $StateFile)
    } finally {
      if ([IO.File]::Exists($temporaryStateFile)) {
        [IO.File]::Delete($temporaryStateFile)
      }
    }
    exit 0
  }

  if ($Mode -eq 'restore') {
    Require-Argument 'StateFile' $StateFile
    $bytes = [Convert]::FromBase64String([IO.File]::ReadAllText($StateFile))
    New-Item -Path $RegistryPath -Force | Out-Null
    New-ItemProperty `
      -LiteralPath $RegistryPath `
      -Name $ValueName `
      -PropertyType Binary `
      -Value $bytes `
      -Force | Out-Null
    exit 0
  }

  if ($Mode -eq 'save-pending') {
    Save-PendingSnapshot
    exit 0
  }
  if ($Mode -eq 'persist-pending') {
    Persist-PendingSnapshot
    exit 0
  }
  if ($Mode -eq 'restore-pending') {
    Restore-PendingSnapshot
    exit 0
  }
  throw "Unsupported mode: $Mode"
} catch {
  Write-Error $_
  exit 1
}
