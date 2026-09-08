param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('InstallExtension', 'ClickAction', 'FindEditor')]
  [string]$Mode,
  [string]$WindowTitle = 'CapturePack Acceptance Fixture',
  [int]$ExpectedRootPid,
  [string]$ExpectedRootCreationTimeUtc,
  [string]$ExtensionPath,
  [string]$TargetUrl,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CapturePackAcceptanceMouse {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
'@

function Get-ProcessCreationTimeUtc([Microsoft.Management.Infrastructure.CimInstance]$Process) {
  return $Process.CreationDate.ToUniversalTime().ToString('o')
}

function Test-OwnedProcess([int]$ProcessId) {
  if ($ExpectedRootPid -le 0 -or [string]::IsNullOrWhiteSpace($ExpectedRootCreationTimeUtc)) {
    throw 'ExpectedRootPid and ExpectedRootCreationTimeUtc are required'
  }
  $seen = @{}
  $currentPid = $ProcessId
  $childCreation = $null
  while ($currentPid -gt 0) {
    if ($seen.ContainsKey($currentPid)) { throw "process ancestry cycle at PID $currentPid" }
    $seen[$currentPid] = $true
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
    if ($null -eq $process) { throw "process ancestry missing PID $currentPid" }
    $creation = Get-ProcessCreationTimeUtc $process
    if ($null -ne $childCreation -and [DateTimeOffset]::Parse($creation) -gt [DateTimeOffset]::Parse($childCreation)) {
      throw "process ancestry crossed reused parent PID $currentPid"
    }
    if ($currentPid -eq $ExpectedRootPid) {
      return [string]::Equals($creation, $ExpectedRootCreationTimeUtc, [StringComparison]::OrdinalIgnoreCase)
    }
    $childCreation = $creation
    $currentPid = [int]$process.ParentProcessId
  }
  return $false
}

function Find-NamedWindow([string]$ExactFixtureTitle) {
  $desktop = [Windows.Automation.AutomationElement]::RootElement
  $windows = $desktop.FindAll(
    [Windows.Automation.TreeScope]::Children,
    [Windows.Automation.Condition]::TrueCondition
  )
  $matches = @()
  foreach ($window in $windows) {
    $name = $window.Current.Name
    $titleMatches = if ($Mode -eq 'FindEditor') {
      $name.StartsWith($ExactFixtureTitle, [StringComparison]::Ordinal)
    } else {
      $name -eq $ExactFixtureTitle -or $name.StartsWith("$ExactFixtureTitle - ", [StringComparison]::Ordinal)
    }
    if (
      $titleMatches -and
      (Test-OwnedProcess $window.Current.ProcessId)
    ) { $matches += $window }
  }
  if ($matches.Count -gt 1) { throw "multiple owned windows matched exact fixture title: $ExactFixtureTitle" }
  return $matches | Select-Object -First 1
}

function Find-Control(
  [Windows.Automation.AutomationElement]$Root,
  [string]$NamePattern,
  [string]$AutomationIdPattern = '(?!)'
) {
  $all = $Root.FindAll(
    [Windows.Automation.TreeScope]::Descendants,
    [Windows.Automation.Condition]::TrueCondition
  )
  foreach ($item in $all) {
    $type = $item.Current.ControlType.ProgrammaticName
    if (
      $type -in @('ControlType.Button', 'ControlType.CheckBox', 'ControlType.MenuItem', 'ControlType.ListItem') -and
      ($item.Current.Name -match $NamePattern -or $item.Current.AutomationId -match $AutomationIdPattern) -and
      $item.Current.IsEnabled -and
      -not $item.Current.IsOffscreen -and
      (Test-OwnedProcess $item.Current.ProcessId)
    ) { return $item }
  }
  return $null
}

function Find-FolderDialog {
  $desktop = [Windows.Automation.AutomationElement]::RootElement
  $windows = $desktop.FindAll(
    [Windows.Automation.TreeScope]::Children,
    [Windows.Automation.Condition]::TrueCondition
  )
  foreach ($candidate in $windows) {
    if (
      $candidate.Current.ControlType.ProgrammaticName -eq 'ControlType.Window' -and
      $candidate.Current.ClassName -eq '#32770' -and
      $candidate.Current.IsEnabled -and
      -not $candidate.Current.IsOffscreen -and
      (Test-OwnedProcess $candidate.Current.ProcessId)
    ) { return $candidate }
  }
  return $null
}

function Send-Literal([string]$Text) {
  [Windows.Forms.SendKeys]::SendWait(($Text -replace '([+^%~(){}\[\]])', '{$1}'))
}

function Click-Physical([Windows.Automation.AutomationElement]$Element) {
  $rect = $Element.Current.BoundingRectangle
  if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'UIA target has no clickable rectangle' }
  $x = [int][Math]::Round($rect.Left + ($rect.Width / 2))
  $y = [int][Math]::Round($rect.Top + ($rect.Height / 2))
  [CapturePackAcceptanceMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 150
  [CapturePackAcceptanceMouse]::mouse_event([CapturePackAcceptanceMouse]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  [CapturePackAcceptanceMouse]::mouse_event([CapturePackAcceptanceMouse]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  return [ordered]@{
    name = $Element.Current.Name
    automationId = $Element.Current.AutomationId
    controlType = $Element.Current.ControlType.ProgrammaticName
    x = $x
    y = $y
    width = [int]$rect.Width
    height = [int]$rect.Height
    clickedAt = [DateTimeOffset]::UtcNow.ToString('o')
    processId = $Element.Current.ProcessId
    ownedRootPid = $ExpectedRootPid
    ownedRootCreationTimeUtc = $ExpectedRootCreationTimeUtc
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$window = $null
while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline) {
  $window = Find-NamedWindow $WindowTitle
  if ($null -eq $window) { Start-Sleep -Milliseconds 250 }
}
if ($null -eq $window) { throw "Chrome/editor window not found: $WindowTitle" }

if ($Mode -eq 'InstallExtension') {
  if ([string]::IsNullOrWhiteSpace($ExtensionPath) -or -not (Test-Path -LiteralPath $ExtensionPath -PathType Container)) {
    throw "Unpacked extension directory not found: $ExtensionPath"
  }
  if ([string]::IsNullOrWhiteSpace($TargetUrl)) { throw 'TargetUrl is required for InstallExtension' }
  [CapturePackAcceptanceMouse]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  [Windows.Forms.SendKeys]::SendWait('^l')
  Send-Literal 'chrome://extensions/'
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')

  $developer = $null
  while ($null -eq $developer -and [DateTime]::UtcNow -lt $deadline) {
    $developer = Find-Control $window '(?i)^Developer mode$' '(?i)(developer.?mode|devMode)'
    if ($null -eq $developer) { Start-Sleep -Milliseconds 250 }
  }
  if ($null -eq $developer) { throw 'Chrome Developer mode was not exposed through UI Automation' }
  $needsToggle = $true
  try {
    $toggle = $developer.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    $needsToggle = $toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On
  } catch {}
  if ($needsToggle) { Click-Physical $developer | Out-Null; Start-Sleep -Milliseconds 500 }

  $load = Find-Control $window '(?i)^Load unpacked$' '(?i)(load.?unpacked|loadUnpacked)'
  if ($null -eq $load) { throw 'Chrome Load unpacked button was not exposed through UI Automation' }
  $loadClick = Click-Physical $load
  Start-Sleep -Milliseconds 500
  [Windows.Forms.SendKeys]::SendWait('%d')
  Send-Literal ([IO.Path]::GetFullPath($ExtensionPath))
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')

  $select = $null
  $sawFolderDialog = $false
  $lastFolderDialog = $null
  while ($null -eq $select -and [DateTime]::UtcNow -lt $deadline) {
    $dialog = Find-FolderDialog
    if ($null -ne $dialog) {
      $sawFolderDialog = $true
      $lastFolderDialog = $dialog
      $select = Find-Control $dialog '(?i)^Select Folder$' '^1$'
    } elseif ($sawFolderDialog) {
      break
    }
    if ($null -eq $select) { Start-Sleep -Milliseconds 250 }
  }
  if ($null -eq $select -and $sawFolderDialog -and $null -eq (Find-FolderDialog)) {
    $selectClick = [ordered]@{
      method = 'owned-dialog-closed-after-path-enter'
      dialogName = $lastFolderDialog.Current.Name
      processId = $lastFolderDialog.Current.ProcessId
      confirmedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
  } elseif ($null -eq $select) {
    $dialog = Find-FolderDialog
    if ($null -eq $dialog) { throw 'Windows folder picker was never observed or disappeared without owned provenance' }
    [CapturePackAcceptanceMouse]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 200
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($null -ne (Find-FolderDialog) -and [DateTime]::UtcNow -lt $closeDeadline) { Start-Sleep -Milliseconds 100 }
    if ($null -ne (Find-FolderDialog)) { throw 'Windows folder picker did not close after owned default-button confirmation' }
    $selectClick = [ordered]@{
      method = 'owned-dialog-default-enter'
      dialogName = $dialog.Current.Name
      processId = $dialog.Current.ProcessId
      confirmedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
  } else {
    $selectClick = Click-Physical $select
  }
  Start-Sleep -Milliseconds 800
  [CapturePackAcceptanceMouse]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
  [Windows.Forms.SendKeys]::SendWait('^l')
  Send-Literal $TargetUrl
  [Windows.Forms.SendKeys]::SendWait('{ENTER}')
  [ordered]@{
    extensionPath = [IO.Path]::GetFullPath($ExtensionPath)
    loadUnpackedClick = $loadClick
    selectFolderClick = $selectClick
    installedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress -Depth 4
  exit 0
}

if ($Mode -eq 'FindEditor') {
  $rect = $window.Current.BoundingRectangle
  [ordered]@{
    name = $window.Current.Name
    processId = $window.Current.ProcessId
    controlType = $window.Current.ControlType.ProgrammaticName
    offscreen = $window.Current.IsOffscreen
    width = [int]$rect.Width
    height = [int]$rect.Height
    observedAt = [DateTimeOffset]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  exit 0
}

[CapturePackAcceptanceMouse]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
$action = Find-Control $window '(?i)CapturePack'
if ($null -eq $action) {
  $extensions = Find-Control $window '(?i)^Extensions$' '(?i)(toolbar.*extension|extension.*toolbar)'
  if ($null -eq $extensions) { throw 'Chrome Extensions toolbar control was not exposed through UI Automation' }
  Click-Physical $extensions | Out-Null
  Start-Sleep -Milliseconds 500
  $desktop = [Windows.Automation.AutomationElement]::RootElement
  $action = Find-Control $desktop '(?i)CapturePack'
}
if ($null -eq $action) { throw 'CapturePack action was not exposed through the Chrome accessibility tree' }
Click-Physical $action | ConvertTo-Json -Compress
