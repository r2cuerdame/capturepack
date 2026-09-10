import { isAbsolute, normalize, resolve } from 'node:path'

function text(value) {
  return typeof value === 'string' ? value : ''
}

export function processIdentity(process) {
  if (!Number.isInteger(process?.pid) || process.pid <= 0 || text(process.creationTimeUtc) === '') {
    throw new Error('process identity requires a positive PID and creation time')
  }
  return { pid: process.pid, creationTimeUtc: process.creationTimeUtc }
}

export function identityKey(process) {
  const identity = processIdentity(process)
  return `${String(identity.pid)}@${identity.creationTimeUtc}`
}

export function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid &&
    text(left?.creationTimeUtc).toLowerCase() === text(right?.creationTimeUtc).toLowerCase()
}

export function findProcess(processes, identity) {
  return processes.find((process) => sameProcessIdentity(process, identity)) ?? null
}

export function traceProcessAncestry(processes, candidateIdentity, rootIdentity, { strict = false } = {}) {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  const candidate = findProcess(processes, candidateIdentity)
  const root = findProcess(processes, rootIdentity)
  if (candidate === null) throw new Error(`process identity is no longer live: ${identityKey(candidateIdentity)}`)
  if (root === null) throw new Error(`owned root identity is no longer live: ${identityKey(rootIdentity)}`)
  if (strict && sameProcessIdentity(candidate, root)) throw new Error('candidate must be a strict descendant of the owned root')

  const chain = []
  const visited = new Set()
  let current = candidate
  while (true) {
    if (visited.has(current.pid)) throw new Error(`process ancestry contains a cycle at PID ${String(current.pid)}`)
    visited.add(current.pid)
    chain.push(current)
    if (sameProcessIdentity(current, root)) return chain
    if (!Number.isInteger(current.parentPid) || current.parentPid <= 0) {
      throw new Error(`process ancestry ended before owned root ${identityKey(root)}`)
    }
    const parent = byPid.get(current.parentPid)
    if (parent === undefined) throw new Error(`process ancestry is missing parent PID ${String(current.parentPid)}`)
    if (Date.parse(parent.creationTimeUtc) > Date.parse(current.creationTimeUtc)) {
      throw new Error(`process ancestry crosses a reused parent PID ${String(parent.pid)}`)
    }
    current = parent
  }
}

function canonicalPath(value) {
  return normalize(resolve(value)).toLowerCase()
}

export function verifyChromeRoot(processes, spawnedPid, preExistingChrome, expectedExecutable, expectedProfile) {
  const root = processes.find((process) => process.pid === spawnedPid) ?? null
  if (root === null) throw new Error(`launched Chrome root PID ${String(spawnedPid)} exited or was reused`)
  if (text(root.name).toLowerCase() !== 'chrome.exe') throw new Error(`launched PID ${String(spawnedPid)} is not chrome.exe`)
  if (preExistingChrome.some((process) => process.pid === root.pid)) {
    throw new Error(`unique-profile Chrome reused pre-existing/protected PID ${identityKey(root)}`)
  }
  if (!isAbsolute(text(root.executablePath)) || canonicalPath(root.executablePath) !== canonicalPath(expectedExecutable)) {
    throw new Error('launched Chrome executable identity does not match the prepared browser')
  }
  const commandLine = text(root.commandLine).toLowerCase()
  const profile = canonicalPath(expectedProfile)
  if (commandLine === '' || !commandLine.includes(profile)) {
    throw new Error('launched Chrome root command line does not contain the unique user-data-dir')
  }
  return root
}

export function selectOwnedProcessTrees(processes, roots, protectedProcesses = []) {
  const protectedKeys = new Set(protectedProcesses.map(identityKey))
  const selected = new Map()
  for (const rootIdentity of roots) {
    const root = findProcess(processes, rootIdentity)
    if (root === null) continue
    for (const candidate of processes) {
      try {
        const chain = traceProcessAncestry(processes, candidate, root)
        if (chain.some((entry) => protectedKeys.has(identityKey(entry)))) {
          throw new Error(`owned process tree intersects protected process ${identityKey(candidate)}`)
        }
        selected.set(identityKey(candidate), { ...candidate, depth: chain.length - 1 })
      } catch (error) {
        if (String(error).includes('intersects protected process')) throw error
      }
    }
  }
  return [...selected.values()].sort((left, right) => right.depth - left.depth)
}

export function assertProcessesPreserved(before, after) {
  const missing = before.filter((process) => findProcess(after, process) === null).map(identityKey)
  if (missing.length > 0) throw new Error(`pre-existing Chrome identity was killed or replaced: ${missing.join(', ')}`)
  return before.map((process) => processIdentity(process))
}
