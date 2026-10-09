'use strict'

function lifecycleLogEvidence({ mainLog, fallbackMainLog, displayId }) {
  const display = String(displayId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const contains = (text, pattern) => new RegExp(`\\[capture\\] display ${display}: ${pattern}`, 'u').test(text)
  const ready = contains(mainLog, 'DXGI native replay READY \\(')
  const suspended = contains(mainLog, 'shipping replay encoders suspended; native replay owns the display')
  const snapshot = contains(mainLog, 'selected DXGI native replay snapshot \\(')
  const failed = contains(fallbackMainLog, 'DXGI native replay unavailable \\(native-runtime-failed\\)')
  const restarted = contains(fallbackMainLog, 'native replay unavailable; restarting shipping replay workload')
  const freshReady = contains(fallbackMainLog, 'video/[^ ]+ -> replay\\.(?:mp4|webm),')
  const readiness = new RegExp(`\\[capture\\] display ${display}: primary recorder readiness after [0-9.]+ ms \\(([0-9]+) presented frames, timeout=false, [^)]*presentation-span=([0-9.]+) ms`, 'u').exec(fallbackMainLog)
  const advancing = readiness !== null && Number(readiness[1]) >= 2 && Number(readiness[2]) > 0
  const recording = contains(fallbackMainLog, 'starting -> recording')
  const index = (text, message) => text.indexOf(`[capture] display ${displayId}: ${message}`)
  const readyIndex = index(mainLog, 'DXGI native replay READY (')
  const suspendIndex = index(mainLog, 'shipping replay encoders suspended;')
  const snapshotIndex = index(mainLog, 'selected DXGI native replay snapshot (')
  const ordered = readyIndex >= 0 && readyIndex < suspendIndex && suspendIndex < snapshotIndex
  return { ready, suspended, snapshot, failed, restarted, fresh_ready: freshReady,
    ready_suspend_snapshot_ordered: ordered,
    advancing_presentations: advancing, frame_evidence_recording: recording,
    pass: ready && suspended && snapshot && ordered && failed && restarted && freshReady && advancing && recording }
}

module.exports = { lifecycleLogEvidence }
