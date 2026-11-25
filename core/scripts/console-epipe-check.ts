import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { initForensics, logFilePath, logInfo } from '../src/main/log'

const userData = process.env.CAPTUREPACK_LOG_CHECK_USERDATA ?? ''
const faults: string[] = []
const results: { name: string; pass: boolean; detail: string }[] = []
const LINES = 20
let finished = false

function finish(): void {
  if (finished) return
  finished = true
  const log = existsSync(logFilePath()) ? readFileSync(logFilePath(), 'utf8') : ''
  const lines = log.split('\n').filter((line) => line !== '')
  const missing = Array.from({ length: LINES }, (_, i) => `[check] line ${String(i)}`).filter(
    (text) => !log.includes(text),
  )
  results.push({
    name: 'a closed console raises no uncaught exception',
    pass: faults.length === 0,
    detail: `${String(faults.length)} fault(s)${faults[0] === undefined ? '' : `, first: ${faults[0]}`}`,
  })
  results.push({
    name: 'every line still reaches main.log',
    pass: missing.length === 0,
    detail: missing.length === 0 ? '' : `missing ${missing.join(', ')}`,
  })
  results.push({
    name: 'main.log says once that console output stopped',
    pass: lines.filter((line) => line.includes('[log] console output closed')).length === 1,
    detail: '',
  })
  results.push({
    name: 'main.log stays bounded',
    pass: lines.length <= LINES + 5,
    detail: `${String(lines.length)} lines`,
  })
  writeFileSync(path.join(userData, 'result.json'), JSON.stringify(results))
  process.exit(0)
}

async function main(): Promise<void> {
  initForensics({
    onUnhandledError: (summary) => {
      faults.push(summary)
      if (faults.length >= 200) finish()
    },
  })
  for (let i = 0; i < LINES; i += 1) {
    logInfo(`[check] line ${String(i)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  finish()
}

void main()
