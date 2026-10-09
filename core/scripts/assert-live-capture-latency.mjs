#!/usr/bin/env node
// Assert the live capture-now -> painted editor path in the Windows e2e job.
// Saved-pack corpus replay cannot measure this endpoint.
import { readFileSync } from 'node:fs'

const [logPath, limitArg] = process.argv.slice(2)
const limitMs = Number(limitArg)
if (!logPath || !Number.isFinite(limitMs) || limitMs <= 0) {
  console.error('usage: node scripts/assert-live-capture-latency.mjs <main.log> <max-ms>')
  process.exit(2)
}

const lines = readFileSync(logPath, 'utf8').split(/\r?\n/u)
  .filter((line) => line.includes('[capture] latency video —'))
if (lines.length !== 1) {
  console.error(`FAIL: expected exactly one live video capture latency line, got ${lines.length}`)
  process.exit(1)
}

const line = lines[0]
const visible = /(?:^|[,; ]+)editor-visible ([0-9]+) ms(?:[,;]|$)/u.exec(line)
const handsOff = /(?:^|;\s*)hands-off ([0-9]+) ms(?:;|$)/u.exec(line)
if (!visible || !handsOff) {
  console.error('FAIL: live capture has no measured editor-visible/hands-off endpoint')
  process.exit(1)
}
const visibleMs = Number(visible[1])
const handsOffMs = Number(handsOff[1])
if (handsOffMs > visibleMs || handsOffMs > limitMs) {
  console.error(`FAIL: capture->painted-editor ${handsOffMs} ms exceeds ${limitMs} ms or its visible stage`)
  process.exit(1)
}
console.log(`OK: live capture->painted-editor ${handsOffMs} ms / ${limitMs} ms`)
