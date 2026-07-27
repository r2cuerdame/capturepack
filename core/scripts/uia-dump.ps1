# CapturePack — Windows UI Automation dump (GOAL "Static object picking (v0)").
#
# READ-ONLY BY CONSTRUCTION. This script only READS UI state: it enumerates the
# top-level windows and walks the FOREGROUND window's control tree through
# System.Windows.Automation. It never synthesizes keyboard or mouse input, never
# focuses / moves / resizes / closes a window, never invokes a control pattern,
# and never writes a file. Run it standalone as often as you like.
#
# Output: NDJSON on stdout — one JSON document per line, in this order:
#   1. {"root_bounds":{...},"monitors":[...],"windows":[...]}
#   2. {"elements":[...],"truncated":<bool>,"visited":<n>,"elapsed_ms":<n>}
# Line 1 is emitted BEFORE the (potentially expensive) control-tree walk, so a
# parent that kills this process on its hard budget still gets the window list.
# A missing line 2 therefore means "the tree walk did not finish" — the caller
# treats that as truncated.
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

param(
  # Maximum control-tree depth to walk (the foreground window itself is depth 0).
  [int]$MaxDepth = 12,
  # Maximum number of elements to EMIT.
  [int]$MaxElements = 3000,
  # Budget the caller enforces by killing this process. Used here only to stop
  # walking early enough to still print what was collected.
  [int]$BudgetMs = 1200
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
# Self-imposed soft budget: a killed process prints NOTHING, so stop walking
# well before the caller's hard kill and emit what has been collected.
$softBudgetMs = [Math]::Max(150, $BudgetMs - 350)

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
# 1. Top-level windows
# ---------------------------------------------------------------------------

$windowCache = New-Object System.Windows.Automation.CacheRequest
$windowCache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
foreach ($prop in @(
    $AE::NameProperty,
    $AE::ClassNameProperty,
    $AE::ProcessIdProperty,
    $AE::NativeWindowHandleProperty,
    $AE::BoundingRectangleProperty,
    $AE::IsOffscreenProperty
  )) { [void]$windowCache.Add($prop) }

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

$windowJson = New-Object System.Text.StringBuilder
$windowCount = 0
foreach ($win in $topLevel) {
  if ($windowCount -ge 64) { break }
  try {
    $bounds = $win.Cached.BoundingRectangle
    if (-not (Test-UsableRect $bounds)) { continue }
    if ($win.Cached.IsOffscreen) { continue }
    $handle = 0
    try { $handle = [int]$win.Cached.NativeWindowHandle } catch { $handle = 0 }
    $title = [string]$win.Cached.Name
    if ([string]::IsNullOrWhiteSpace($title)) { $title = [string]$win.Cached.ClassName }
    $processName = Get-ProcessNameById ([int]$win.Cached.ProcessId)
    $isFocused = ($foregroundHandle -ne 0 -and $handle -eq $foregroundHandle)
    if ($windowCount -gt 0) { [void]$windowJson.Append(',') }
    [void]$windowJson.Append('{"title":').Append((ConvertTo-JsonString $title))
    [void]$windowJson.Append(',"process":').Append((ConvertTo-JsonString $processName))
    [void]$windowJson.Append(',"bounds":').Append((ConvertTo-JsonBounds $bounds))
    [void]$windowJson.Append(',"focused":').Append($(if ($isFocused) { 'true' } else { 'false' })).Append('}')
    $windowCount++
  } catch { continue }
}

$line1 = New-Object System.Text.StringBuilder
[void]$line1.Append('{"root_bounds":')
if (Test-UsableRect $rootBounds) { [void]$line1.Append((ConvertTo-JsonBounds $rootBounds)) } else { [void]$line1.Append('null') }
[void]$line1.Append(',"monitors":[').Append($monitorJson.ToString()).Append(']')
[void]$line1.Append(',"windows":[').Append($windowJson.ToString()).Append(']}')
Write-JsonLine $line1.ToString()

# ---------------------------------------------------------------------------
# 2. The foreground window's control tree
# ---------------------------------------------------------------------------

if ($null -eq $foreground -or $stopwatch.ElapsedMilliseconds -ge $softBudgetMs) {
  # No foreground window, or the budget is already spent: the caller still has
  # the window list from line 1. Emitting an EMPTY, untruncated element set is
  # the honest answer for "no foreground window".
  $truncated = if ($null -eq $foreground) { 'false' } else { 'true' }
  Write-JsonLine ('{"elements":[],"truncated":' + $truncated + ',"visited":0,"elapsed_ms":' + $stopwatch.ElapsedMilliseconds + '}')
  exit 0
}

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

# ONE cross-process call fetches the whole cached subtree; walking it afterwards
# is pure in-process work. (Walking with live TreeWalker calls instead would be
# one cross-process round trip per element — far over budget.)
$cachedRoot = $null
try { $cachedRoot = $foreground.GetUpdatedCache($treeCache) } catch { $cachedRoot = $null }

if ($null -eq $cachedRoot) {
  Write-JsonLine ('{"elements":[],"truncated":true,"visited":0,"elapsed_ms":' + $stopwatch.ElapsedMilliseconds + '}')
  exit 0
}

$elementJson = New-Object System.Text.StringBuilder
$emitted = 0
$visited = 0
$truncated = $false
# Visiting is cheap (the tree is already in memory) but not free: cap it so a
# pathological tree cannot spin past the budget between stopwatch checks.
$maxVisits = [Math]::Max(1000, $MaxElements * 8)

# Explicit stack — recursion depth 12 x thousands of nodes is not worth the
# PowerShell function-call overhead.
$stack = New-Object System.Collections.Stack
$stack.Push(@($cachedRoot, 0))

while ($stack.Count -gt 0) {
  $frame = $stack.Pop()
  $element = $frame[0]
  $depth = [int]$frame[1]
  $visited++
  if ($visited -ge $maxVisits) { $truncated = $true; break }
  if (($visited % 128) -eq 0 -and $stopwatch.ElapsedMilliseconds -ge $softBudgetMs) { $truncated = $true; break }

  try {
    $bounds = $element.Cached.BoundingRectangle
    $offscreen = $false
    try { $offscreen = [bool]$element.Cached.IsOffscreen } catch { $offscreen = $false }
    if ((Test-UsableRect $bounds) -and -not $offscreen) {
      if ($emitted -ge $MaxElements) { $truncated = $true; break }
      $name = [string]$element.Cached.Name
      $automationId = [string]$element.Cached.AutomationId
      $className = [string]$element.Cached.ClassName
      $controlType = ''
      try {
        $programmatic = [string]$element.Cached.ControlType.ProgrammaticName
        $controlType = $programmatic -replace '^ControlType\.', ''
      } catch { $controlType = '' }
      if ($emitted -gt 0) { [void]$elementJson.Append(',') }
      [void]$elementJson.Append('{"name":').Append((ConvertTo-JsonString $name))
      [void]$elementJson.Append(',"control_type":').Append((ConvertTo-JsonString $controlType))
      [void]$elementJson.Append(',"automation_id":').Append((ConvertTo-JsonString $automationId))
      [void]$elementJson.Append(',"class_name":').Append((ConvertTo-JsonString $className))
      [void]$elementJson.Append(',"bounds":').Append((ConvertTo-JsonBounds $bounds))
      [void]$elementJson.Append(',"depth":').Append($depth).Append('}')
      $emitted++
    }
  } catch { }

  if ($depth -ge $MaxDepth) { continue }
  $children = $null
  try { $children = $element.CachedChildren } catch { $children = $null }
  if ($null -eq $children) { continue }
  # Pushed in reverse so the stack pops siblings in document order — `depth`
  # then reads as a pre-order walk, which is what a tree consumer expects.
  # ($depth + 1) MUST stay parenthesized: PowerShell's comma binds tighter than
  # `+`, so `@(child, $depth + 1)` would build `(child, $depth) + 1` — a
  # three-element array whose [1] is the PARENT's depth (i.e. depth never grows).
  $childDepth = $depth + 1
  for ($i = $children.Count - 1; $i -ge 0; $i--) {
    $stack.Push(@($children[$i], $childDepth))
  }
}

Write-JsonLine ('{"elements":[' + $elementJson.ToString() + '],"truncated":' + $(if ($truncated) { 'true' } else { 'false' }) + ',"visited":' + $visited + ',"elapsed_ms":' + $stopwatch.ElapsedMilliseconds + '}')
exit 0
