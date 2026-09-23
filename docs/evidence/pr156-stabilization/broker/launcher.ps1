$ErrorActionPreference = 'Stop'
$taskDir = $PSScriptRoot
[pscustomobject]@{pid=$PID;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDir 'launcher-ready.json') -Encoding UTF8
$taskNode = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"' + (Join-Path $taskDir 'waiting-node.cjs') + '"') -WorkingDirectory $taskDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDir 'node.stdout.log') -RedirectStandardError (Join-Path $taskDir 'node.stderr.log')
$taskNode.WaitForExit()
[pscustomobject]@{nodePid=$taskNode.Id;exit=$taskNode.ExitCode;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDir 'probe-exit.json') -Encoding UTF8
