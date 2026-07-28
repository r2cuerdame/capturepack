# CapturePack — Windows UI Automation dump (GOAL "Static object picking (v0)").
#
# READ-ONLY BY CONSTRUCTION. This script only READS UI state: it enumerates the
# top-level windows and walks the control tree of the top few of them through
# System.Windows.Automation. It never synthesizes keyboard or mouse input, never
# focuses / moves / resizes / closes a window, never invokes a control pattern,
# and never writes a file. Run it standalone as often as you like.
#
# COVERAGE. The window list is the GUARANTEED FLOOR of object picking (GOAL:
# "windows are always selectable"), so it is collected first and printed before
# anything expensive happens. Control trees then REFINE that floor: they are
# walked for the top N windows in z-order — the foreground window first, with a
# guaranteed slice of the budget, then the rest until the deadline. A window
# that was never reached, or that exposes no tree at all (Chromium and Electron
# windows typically do not), is reported as such instead of silently looking
# like a window with no controls: the editor can then say "no object data for
# this window" honestly, and still snap a box to the window itself.
#
# Output: NDJSON on stdout — one JSON document per line, in this order:
#   1. {"root_bounds":{...},"monitors":[...],"windows":[...]}
#   2. ONE LINE PER WINDOW whose tree was attempted, in walk order:
#      {"window":<index into windows>,"tree":"collected"|"truncated"|"unavailable",
#       "elements":[...],"elapsed_ms":<n>}
#   3. {"done":true,"truncated":<bool>,"visited":<n>,"elapsed_ms":<n>}
# Each line is flushed the moment it is complete, so a parent that kills this
# process on its hard budget keeps EVERYTHING printed so far: the window list
# always, plus every window whose tree finished. A missing "done" line means the
# walk did not finish — the caller treats the dump as truncated, and any window
# without a line of its own as "skipped" (i.e. no object data for that window,
# which is not the same claim as "that window has no objects").
#
# COORDINATE SPACE: every bounds rectangle is in the coordinate space THIS
# process sees, which depends on a DPI awareness this script deliberately does
# not try to control (forcing it would need Add-Type -MemberDefinition, i.e. a
# C# compile, which costs more than the whole budget). Instead the caller is
# handed the yardsticks: `monitors` is every display's rectangle IN THIS SAME
# SPACE, so mapping a rectangle onto one display's snapshot is a per-monitor
# affine transform that cannot be fooled by DPI virtualization. `root_bounds`
# (the UIA desktop root, i.e. the primary display) is the cruder fallback.
# The monitor list is read AFTER the first UIA call on purpose: initializing the
# UI Automation client is what settles this process's DPI awareness, and both
# readings must come from the same state.

# PARAMETERS come from the ENVIRONMENT, not from param(): the caller runs this
# file through -EncodedCommand (execution policy is set by Group Policy on
# managed machines and the -ExecutionPolicy switch cannot override it, so -File
# would simply be refused there), and a param() block is not valid in a command
# string. Every value has a working default, so the script still runs standalone.
#
#   CAPTUREPACK_UIA_MAX_DEPTH     control-tree depth cap (each window = 0)
#   CAPTUREPACK_UIA_MAX_ELEMENTS  soft cap on emitted elements across ALL windows
#   CAPTUREPACK_UIA_MAX_WINDOWS   how many windows may be walked at all
#   CAPTUREPACK_UIA_DEADLINE      absolute Unix ms instant of the caller's HARD
#                                 kill — the only budget origin both sides share
#   CAPTUREPACK_UIA_BUDGET_MS     fallback budget when no deadline is given

function Get-EnvInt([string]$name, [int]$fallback) {
  $raw = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $fallback }
  $value = 0
  if ([int]::TryParse($raw, [ref]$value) -and $value -gt 0) { return $value }
  return $fallback
}

function Get-EnvLong([string]$name) {
  $raw = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($raw)) { return 0L }
  $value = 0L
  if ([long]::TryParse($raw, [ref]$value) -and $value -gt 0) { return $value }
  return 0L
}

$MaxDepth = Get-EnvInt 'CAPTUREPACK_UIA_MAX_DEPTH' 12
$MaxElements = Get-EnvInt 'CAPTUREPACK_UIA_MAX_ELEMENTS' 3000
# Defaults match src/main/uia.ts (which always sets these explicitly); the cap
# is deliberately above what the budget can afford so the DEADLINE is the only
# thing that ever cuts, and every window past it is reported as "skipped".
$MaxWindows = Get-EnvInt 'CAPTUREPACK_UIA_MAX_WINDOWS' 24
$BudgetMs = Get-EnvInt 'CAPTUREPACK_UIA_BUDGET_MS' 1200
# Leftover budget buys a bigger dump (see the emit loop): a desktop of cheap
# trees must not be cut off at a number chosen for the expensive case.
$MaxElementsHard = $MaxElements * 2

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
# Self-imposed soft budget: a killed process's LAST line is lost, so stop
# walking well before the caller's hard kill and finish the line in hand.
#
# The budget MUST be measured from the caller's origin, not from this line:
# powershell.exe startup (plus the UIAutomation/WinForms assembly loads below)
# is 100-1500 ms of the caller's budget that this process never sees. Measuring
# from a local stopwatch would let the walk run happily past the hard kill on
# exactly the slow machines the soft budget exists for. The deadline is an
# absolute instant on the shared wall clock; the stopwatch then only converts it
# into "elapsed" terms for the loop checks below.
$deadlineUnixMs = Get-EnvLong 'CAPTUREPACK_UIA_DEADLINE'
if ($deadlineUnixMs -gt 0) {
  $remainingMs = $deadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $softBudgetMs = [Math]::Max(150, [int][Math]::Min([double]($remainingMs - 350), [double]$BudgetMs))
} else {
  $softBudgetMs = [Math]::Max(150, $BudgetMs - 350)
}
# Floor of a per-window slice: below this a tree walk cannot get anywhere, so
# the window is reported as skipped rather than started and abandoned.
$MinSliceMs = 80

# Window titles are routinely non-ASCII (한국어 / 日本語 / …) and the caller
# decodes stdout as UTF-8. Numbers are formatted culture-invariantly so a
# comma-decimal locale can never produce malformed JSON.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

function Write-JsonLine([string]$line) {
  [Console]::Out.Write($line)
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
}

function ConvertTo-JsonString([string]$value) {
  if ([string]::IsNullOrEmpty($value)) { return '""' }
  # Backslash FIRST, then quote, then the control characters we can represent;
  # anything else in C0 becomes a space so a single line can never be broken.
  $s = $value -replace '\\', '\\'
  $s = $s -replace '"', '\"'
  $s = $s -replace "`r", '\r'
  $s = $s -replace "`n", '\n'
  $s = $s -replace "`t", '\t'
  $s = $s -replace '[\x00-\x1F]', ' '
  return '"' + $s + '"'
}

function ConvertTo-JsonBounds($rect) {
  $x = [int][Math]::Round($rect.X)
  $y = [int][Math]::Round($rect.Y)
  $w = [int][Math]::Round($rect.Width)
  $h = [int][Math]::Round($rect.Height)
  return '{"x":' + $x + ',"y":' + $y + ',"width":' + $w + ',"height":' + $h + '}'
}

function Test-UsableRect($rect) {
  if ($null -eq $rect) { return $false }
  if ($rect.IsEmpty) { return $false }
  $values = @($rect.X, $rect.Y, $rect.Width, $rect.Height)
  foreach ($v in $values) {
    if ([double]::IsNaN($v) -or [double]::IsInfinity($v)) { return $false }
  }
  return ($rect.Width -gt 0 -and $rect.Height -gt 0)
}

# Assembly loading only — never Add-Type -MemberDefinition, which would invoke
# the C# compiler and eat most of the budget before any UI is read.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$rootElement = $AE::RootElement
$rootBounds = $null
# This is also the FIRST UI Automation call, which is what settles the process's
# DPI awareness — the monitor list below is only meaningful after it.
try { $rootBounds = $rootElement.Current.BoundingRectangle } catch { $rootBounds = $null }

# ---------------------------------------------------------------------------
# 0. Monitor rectangles — the caller's yardstick for mapping onto a snapshot
# ---------------------------------------------------------------------------

$monitorJson = New-Object System.Text.StringBuilder
$monitorCount = 0
try {
  Add-Type -AssemblyName System.Windows.Forms
  foreach ($screenInfo in [System.Windows.Forms.Screen]::AllScreens) {
    $rect = New-Object System.Windows.Rect(
      [double]$screenInfo.Bounds.X, [double]$screenInfo.Bounds.Y,
      [double]$screenInfo.Bounds.Width, [double]$screenInfo.Bounds.Height)
    if (-not (Test-UsableRect $rect)) { continue }
    if ($monitorCount -gt 0) { [void]$monitorJson.Append(',') }
    [void]$monitorJson.Append('{"device":').Append((ConvertTo-JsonString ([string]$screenInfo.DeviceName)))
    [void]$monitorJson.Append(',"primary":').Append($(if ($screenInfo.Primary) { 'true' } else { 'false' }))
    [void]$monitorJson.Append(',"bounds":').Append((ConvertTo-JsonBounds $rect)).Append('}')
    $monitorCount++
  }
} catch {
  # No monitor list: the caller falls back to root_bounds. Never fatal.
  $monitorJson = New-Object System.Text.StringBuilder
}

# ---------------------------------------------------------------------------
# 1. Top-level windows — the floor, printed before anything expensive runs
# ---------------------------------------------------------------------------

$windowCache = New-Object System.Windows.Automation.CacheRequest
# Full (not None) on purpose: a None-mode element carries ONLY the cached
# properties and cannot be asked anything else ever again — GetUpdatedCache on
# one throws "contains only cached data". The control-tree walk below needs a
# live reference to each window, and re-finding them by handle afterwards would
# cost one extra cross-process call per window. Measured: Full is not slower
# here (the properties are fetched in the same round trip either way).
$windowCache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
foreach ($prop in @(
    $AE::NameProperty,
    $AE::ClassNameProperty,
    $AE::ProcessIdProperty,
    $AE::NativeWindowHandleProperty,
    $AE::BoundingRectangleProperty,
    $AE::IsOffscreenProperty
  )) { [void]$windowCache.Add($prop) }

# The desktop root's children come back in Z-ORDER, top-most first — the same
# order the window manager keeps them in. That order is what decides which
# window the editor offers under a given pixel, so it is recorded per window as
# `z` rather than left implicit in the array order.
$topLevel = @()
try {
  $windowCache.Push()
  try {
    $topLevel = $rootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition)
  } finally { $windowCache.Pop() }
} catch { $topLevel = @() }

# The FOREGROUND window, without P/Invoke: the focused element's top-level
# ancestor. (GetForegroundWindow would need Add-Type -MemberDefinition, i.e. a
# C# compile, which costs more than the whole budget.)
$foreground = $null
$foregroundHandle = 0
try {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $AE::FocusedElement
  $guard = 0
  while ($null -ne $node -and $guard -lt 64) {
    if ([System.Windows.Automation.Automation]::Compare($node, $rootElement)) { $node = $null; break }
    $parent = $walker.GetParent($node)
    if ($null -eq $parent -or [System.Windows.Automation.Automation]::Compare($parent, $rootElement)) { break }
    $node = $parent
    $guard++
  }
  $foreground = $node
  if ($null -ne $foreground) { $foregroundHandle = [int]$foreground.Current.NativeWindowHandle }
} catch {
  $foreground = $null
  $foregroundHandle = 0
}

$processNames = @{}
function Get-ProcessNameById([int]$processId) {
  if ($processId -le 0) { return '' }
  if ($processNames.ContainsKey($processId)) { return $processNames[$processId] }
  $name = ''
  try { $name = [System.Diagnostics.Process]::GetProcessById($processId).ProcessName } catch { $name = '' }
  $processNames[$processId] = $name
  return $name
}

# The wallpaper. Progman/WorkerW ARE top-level windows covering the whole
# desktop, so walking them would spend budget on the one "window" a user never
# means, and offering them for picking would turn every click on empty space
# into a full-desktop box. They stay in the list (this is a dump), they are
# never walked, and the editor does not offer them.
$desktopClasses = @('Progman', 'WorkerW')

$windowJson = New-Object System.Text.StringBuilder
$windowRecords = New-Object System.Collections.ArrayList
foreach ($win in $topLevel) {
  if ($windowRecords.Count -ge 64) { break }
  try {
    $bounds = $win.Cached.BoundingRectangle
    if (-not (Test-UsableRect $bounds)) { continue }
    if ($win.Cached.IsOffscreen) { continue }
    $handle = 0
    try { $handle = [int]$win.Cached.NativeWindowHandle } catch { $handle = 0 }
    $className = [string]$win.Cached.ClassName
    $title = [string]$win.Cached.Name
    if ([string]::IsNullOrWhiteSpace($title)) { $title = $className }
    $processName = Get-ProcessNameById ([int]$win.Cached.ProcessId)
    $isFocused = ($foregroundHandle -ne 0 -and $handle -eq $foregroundHandle)
    $z = $windowRecords.Count
    if ($z -gt 0) { [void]$windowJson.Append(',') }
    [void]$windowJson.Append('{"title":').Append((ConvertTo-JsonString $title))
    [void]$windowJson.Append(',"process":').Append((ConvertTo-JsonString $processName))
    [void]$windowJson.Append(',"class_name":').Append((ConvertTo-JsonString $className))
    [void]$windowJson.Append(',"bounds":').Append((ConvertTo-JsonBounds $bounds))
    [void]$windowJson.Append(',"focused":').Append($(if ($isFocused) { 'true' } else { 'false' }))
    [void]$windowJson.Append(',"z":').Append($z).Append('}')
    [void]$windowRecords.Add([PSCustomObject]@{
      Element = $win
      Z = $z
      Focused = $isFocused
      Walkable = (-not ($desktopClasses -contains $className))
    })
  } catch { continue }
}

$line1 = New-Object System.Text.StringBuilder
[void]$line1.Append('{"root_bounds":')
if (Test-UsableRect $rootBounds) { [void]$line1.Append((ConvertTo-JsonBounds $rootBounds)) } else { [void]$line1.Append('null') }
[void]$line1.Append(',"monitors":[').Append($monitorJson.ToString()).Append(']')
[void]$line1.Append(',"windows":[').Append($windowJson.ToString()).Append(']}')
Write-JsonLine $line1.ToString()

# ---------------------------------------------------------------------------
# 2. Control trees — foreground first, then z-order, in ONE shared budget
# ---------------------------------------------------------------------------

$treeCache = New-Object System.Windows.Automation.CacheRequest
$treeCache.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
$treeCache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
$treeCache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
foreach ($prop in @(
    $AE::NameProperty,
    $AE::ControlTypeProperty,
    $AE::AutomationIdProperty,
    $AE::ClassNameProperty,
    $AE::BoundingRectangleProperty,
    $AE::IsOffscreenProperty
  )) { [void]$treeCache.Add($prop) }

# Shared across every window: the element allowance and the visit guard are one
# budget, not one per window (see the caps below).
$script:emitted = 0
$script:visited = 0
$script:truncated = $false
# Visiting is cheap (the tree is already in memory) but not free: cap it so a
# pathological tree cannot spin past the budget between stopwatch checks.
$maxVisits = [Math]::Max(2000, $MaxElements * 8)
# Out-parameters of Invoke-WindowTree: a PowerShell function's return value is
# whatever it wrote to the pipeline, which one stray expression would corrupt.
$script:treeStatus = 'skipped'
$script:treeCount = 0

<#
Walks ONE window's cached control tree and prints its line. `windowDeadlineMs`
is this window's slice of the shared budget; `windowCap` bounds how much of the
shared element allowance a single window may take, so the foreground window
cannot starve the rest of the desktop (and one huge tree cannot starve the
foreground). Sets $script:treeStatus / $script:treeCount; prints nothing on the
pipeline.
#>
function Invoke-WindowTree($element, [int]$windowIndex, [double]$windowDeadlineMs, [int]$windowCap) {
  $script:treeStatus = 'unavailable'
  $script:treeCount = 0
  $json = New-Object System.Text.StringBuilder
  # ONE cross-process call fetches the whole cached subtree; walking it
  # afterwards is pure in-process work. (Walking with live TreeWalker calls
  # instead would be one cross-process round trip per element — far over
  # budget.) A window that exposes no tree at all lands here and is reported as
  # "unavailable" — an ATTEMPTED window with no data, which is a different
  # claim from a window that was never reached.
  $cachedRoot = $null
  try { $cachedRoot = $element.GetUpdatedCache($treeCache) } catch { $cachedRoot = $null }
  if ($null -eq $cachedRoot) {
    Write-JsonLine ('{"window":' + $windowIndex + ',"tree":"unavailable","elements":[],"elapsed_ms":' +
      $stopwatch.ElapsedMilliseconds + '}')
    return
  }

  $count = 0
  $windowTruncated = $false
  # Explicit stack — recursion depth 12 x thousands of nodes is not worth the
  # PowerShell function-call overhead.
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($cachedRoot, 0))

  while ($stack.Count -gt 0) {
    $frame = $stack.Pop()
    $node = $frame[0]
    $depth = [int]$frame[1]
    $script:visited++
    if ($script:visited -ge $maxVisits) { $windowTruncated = $true; break }
    if (($script:visited % 64) -eq 0 -and $stopwatch.ElapsedMilliseconds -ge $windowDeadlineMs) {
      $windowTruncated = $true
      break
    }

    try {
      $bounds = $node.Cached.BoundingRectangle
      $offscreen = $false
      try { $offscreen = [bool]$node.Cached.IsOffscreen } catch { $offscreen = $false }
      if ((Test-UsableRect $bounds) -and -not $offscreen) {
        if ($count -ge $windowCap) { $windowTruncated = $true; break }
        if ($script:emitted -ge $MaxElements) {
          # The soft cap is raised while budget is left over: a fast desktop
          # gets the bigger dump it can afford, a slow one stops at the number
          # the expensive case was sized for.
          if ($script:emitted -ge $MaxElementsHard -or
              $stopwatch.ElapsedMilliseconds -ge ($softBudgetMs * 0.5)) {
            $windowTruncated = $true
            break
          }
        }
        $name = [string]$node.Cached.Name
        $automationId = [string]$node.Cached.AutomationId
        $className = [string]$node.Cached.ClassName
        $controlType = ''
        try {
          $programmatic = [string]$node.Cached.ControlType.ProgrammaticName
          $controlType = $programmatic -replace '^ControlType\.', ''
        } catch { $controlType = '' }
        if ($count -gt 0) { [void]$json.Append(',') }
        [void]$json.Append('{"name":').Append((ConvertTo-JsonString $name))
        [void]$json.Append(',"control_type":').Append((ConvertTo-JsonString $controlType))
        [void]$json.Append(',"automation_id":').Append((ConvertTo-JsonString $automationId))
        [void]$json.Append(',"class_name":').Append((ConvertTo-JsonString $className))
        [void]$json.Append(',"bounds":').Append((ConvertTo-JsonBounds $bounds))
        [void]$json.Append(',"depth":').Append($depth)
        [void]$json.Append(',"window":').Append($windowIndex).Append('}')
        $count++
        $script:emitted++
      }
    } catch { }

    if ($depth -ge $MaxDepth) { continue }
    $children = $null
    try { $children = $node.CachedChildren } catch { $children = $null }
    if ($null -eq $children) { continue }
    # Pushed in reverse so the stack pops siblings in document order — `depth`
    # then reads as a pre-order walk, which is what a tree consumer expects.
    # ($depth + 1) MUST stay parenthesized: PowerShell's comma binds tighter
    # than `+`, so `@(child, $depth + 1)` would build `(child, $depth) + 1` — a
    # three-element array whose [1] is the PARENT's depth (i.e. depth never
    # grows).
    $childDepth = $depth + 1
    for ($i = $children.Count - 1; $i -ge 0; $i--) {
      $stack.Push(@($children[$i], $childDepth))
    }
  }

  $script:treeCount = $count
  $script:treeStatus = if ($windowTruncated) { 'truncated' } else { 'collected' }
  if ($windowTruncated) { $script:truncated = $true }
  $line = New-Object System.Text.StringBuilder
  [void]$line.Append('{"window":').Append($windowIndex)
  [void]$line.Append(',"tree":"').Append($script:treeStatus).Append('"')
  [void]$line.Append(',"elements":[').Append($json.ToString()).Append(']')
  [void]$line.Append(',"elapsed_ms":').Append($stopwatch.ElapsedMilliseconds).Append('}')
  Write-JsonLine $line.ToString()
}

# Walk order: the foreground window first (it is what the user was looking at,
# and it is the one whose controls matter most), then straight down the z-order.
$order = New-Object System.Collections.ArrayList
foreach ($record in $windowRecords) {
  if ($record.Focused -and $record.Walkable) { [void]$order.Add($record) }
}
foreach ($record in $windowRecords) {
  if (-not $record.Walkable) { continue }
  if ($record.Focused -and $order.Count -gt 0 -and $order[0].Z -eq $record.Z) { continue }
  [void]$order.Add($record)
}

$attempted = 0
foreach ($record in $order) {
  if ($attempted -ge $MaxWindows) { $script:truncated = $true; break }
  $now = [double]$stopwatch.ElapsedMilliseconds
  $left = $softBudgetMs - $now
  if ($left -le $MinSliceMs) { $script:truncated = $true; break }
  $treesLeft = [Math]::Max(1, [Math]::Min($MaxWindows, $order.Count) - $attempted)
  if ($attempted -eq 0) {
    # The foreground window's GUARANTEED slice: half of what is left, so the
    # window the user was actually looking at can never be squeezed out by the
    # ones behind it.
    $slice = [Math]::Max($MinSliceMs, $left * 0.5)
  } else {
    $slice = [Math]::Max($MinSliceMs, $left / $treesLeft)
  }
  $windowDeadline = [Math]::Min([double]$softBudgetMs, $now + $slice)
  # Element allowance per window, from the same shared pool: the foreground
  # window may take most of it, any other window a fifth, so no single tree can
  # consume the dump.
  $windowCap = if ($attempted -eq 0) {
    [Math]::Max(300, [int]($MaxElements * 0.6))
  } else {
    [Math]::Max(150, [int]($MaxElements * 0.2))
  }
  Invoke-WindowTree $record.Element $record.Z $windowDeadline $windowCap | Out-Null
  $attempted++
}
# Windows that never got a line of their own (past the window cap, or out of
# budget) leave the dump incomplete — and the caller reports them as skipped.
if ($attempted -lt $order.Count) { $script:truncated = $true }

Write-JsonLine ('{"done":true,"truncated":' + $(if ($script:truncated) { 'true' } else { 'false' }) +
  ',"windows_walked":' + $attempted +
  ',"elements":' + $script:emitted +
  ',"visited":' + $script:visited +
  ',"elapsed_ms":' + $stopwatch.ElapsedMilliseconds + '}')
exit 0
