$ErrorActionPreference = 'Stop'
$taskDir = $PSScriptRoot
[pscustomobject]@{pid=$PID;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $taskDir 'launcher-ready.json') -Encoding UTF8
$taskNode = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + (Join-Path $taskDir 'run-ab.cjs') + '"') -WorkingDirectory 'C:\_WorktreeArchive\Herder-2026-09-12\worktrees\job_01M21Z4M10PGMW2N12MNTC3EN3\core' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDir 'ab.stdout.log') -RedirectStandardError (Join-Path $taskDir 'ab.stderr.log')
$taskNode.WaitForExit()
[pscustomobject]@{nodePid=$taskNode.Id;exit=$taskNode.ExitCode;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $taskDir 'exit.json') -Encoding UTF8
