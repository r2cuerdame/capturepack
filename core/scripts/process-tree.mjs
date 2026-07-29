import { spawn } from 'node:child_process'

/**
 * Stop the command wrapper and every process it launched.
 *
 * `npm run` adds a wrapper between this gate and Node/Electron. Killing only
 * that wrapper leaves the real check alive on Windows, where it can hold files,
 * consume CPU, and contaminate every later RC step. `taskkill /T /F` is the
 * native process-tree operation. POSIX children are spawned into their own
 * process group by qa-gate and are terminated through that group id.
 */
export function terminateProcessTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill.bind(process),
} = {}) {
  const pid = child.pid
  const killWrapper = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      // The wrapper may have exited between the timeout and the fallback.
    }
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    killWrapper()
    return null
  }

  if (platform === 'win32') {
    try {
      const killer = spawnProcess(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      )
      killer.once('error', killWrapper)
      killer.once('close', (code) => {
        if (code !== 0) killWrapper()
      })
      return killer
    } catch {
      killWrapper()
      return null
    }
  }

  try {
    killProcess(-pid, 'SIGKILL')
  } catch {
    killWrapper()
  }
  return null
}
