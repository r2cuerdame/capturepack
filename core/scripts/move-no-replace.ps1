param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Source,

  [Parameter(Mandatory = $true, Position = 1)]
  [string] $Destination
)

$ErrorActionPreference = 'Stop'

$nativeSource = @'
using System.Runtime.InteropServices;

public static class CapturePackMoveNoReplace
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveFileW(string existingPath, string newPath);
}
'@

function ConvertTo-ExtendedPath([string] $Value) {
  $normalized = $Value.Replace('/', '\')
  if ($normalized.StartsWith('\\?\', [StringComparison]::Ordinal)) {
    return $normalized
  }
  if ($normalized.StartsWith('\\', [StringComparison]::Ordinal)) {
    return '\\?\UNC\' + $normalized.Substring(2)
  }
  if (
    $normalized.Length -ge 3 -and
    [char]::IsLetter($normalized[0]) -and
    $normalized[1] -eq ':' -and
    $normalized[2] -eq '\'
  ) {
    return '\\?\' + $normalized
  }
  return $normalized
}

try {
  Add-Type -TypeDefinition $nativeSource
  $nativeSourcePath = ConvertTo-ExtendedPath $Source
  $nativeDestinationPath = ConvertTo-ExtendedPath $Destination
  if ([CapturePackMoveNoReplace]::MoveFileW($nativeSourcePath, $nativeDestinationPath)) {
    exit 0
  }

  $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [Console]::Error.WriteLine("WIN32_ERROR=$nativeError")
  if ($nativeError -eq 80 -or $nativeError -eq 183) {
    exit 2
  }
  exit 3
}
catch {
  [Console]::Error.WriteLine('MOVE_HELPER_FAILED')
  exit 3
}
