import { spawnSync } from 'node:child_process'

export const WINDOWS_MEDIUM_INTEGRITY_RID = 8192

export function parseWindowsIntegrityGroups(output) {
  const matches = [...String(output).matchAll(/S-1-16-(\d+)/gu)]
  const rids = [...new Set(matches.map((match) => Number(match[1])))]
    .filter(Number.isSafeInteger)
  if (rids.length !== 1) {
    throw new Error(`expected one Windows integrity SID, observed ${String(rids.length)}`)
  }
  const rid = rids[0]
  return {
    rid,
    sid: `S-1-16-${String(rid)}`,
    level:
      rid === WINDOWS_MEDIUM_INTEGRITY_RID ? 'medium'
        : rid === 4096 ? 'low'
          : rid === 8448 ? 'medium-plus'
            : rid === 12288 ? 'high'
              : rid === 16384 ? 'system'
                : 'unknown',
  }
}

export function readWindowsLaunchIntegrity(spawnCommand = spawnSync) {
  const result = spawnCommand(
    'whoami.exe',
    ['/groups', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `whoami integrity query failed (${String(result.status)}): ${String(result.stderr).trim()}`,
    )
  }
  return parseWindowsIntegrityGroups(result.stdout)
}
