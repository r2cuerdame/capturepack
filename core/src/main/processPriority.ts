import os from 'node:os'

export interface PriorityPort {
  get(pid: number): number
  set(pid: number, priority: number): void
}

const systemPriority: PriorityPort = {
  get: (pid) => os.getPriority(pid),
  set: (pid, priority) => os.setPriority(pid, priority),
}

export const HELPER_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL
export const APP_PRIORITY_CEILING = os.constants.priority.PRIORITY_NORMAL

export function capAtNormal(pid: number, port: PriorityPort = systemPriority): boolean {
  try {
    if (port.get(pid) >= APP_PRIORITY_CEILING) return false
    port.set(pid, APP_PRIORITY_CEILING)
    return true
  } catch {
    return false
  }
}

export function lowerHelperPriority(
  pid: number | undefined,
  port: PriorityPort = systemPriority,
): boolean {
  if (pid === undefined) return false
  try {
    if (port.get(pid) >= HELPER_PRIORITY) return false
    port.set(pid, HELPER_PRIORITY)
    return true
  } catch {
    return false
  }
}

export function capProcessesAtNormal(
  pids: readonly number[],
  port: PriorityPort = systemPriority,
): number[] {
  return pids.filter((pid) => capAtNormal(pid, port))
}
