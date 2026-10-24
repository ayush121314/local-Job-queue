import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { Queue } from './queue.js'
import { withLock } from './lock.js'

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', 'T')
const nowSeconds = () => Math.floor(Date.now() / 1000)

function runnerLog(line) {
  appendFileSync(join(config.logDir, 'runner.log'), `${stamp()} ${line}\n`)
}

function runJob(job) {
  const result = spawnSync(config.shell, ['-lc', job.command], {
    cwd: job.cwd,
    encoding: 'utf8',
    timeout: config.commandTimeoutSeconds * 1000,
    maxBuffer: 50 * 1024 * 1024,
  })
  const failed = result.error || result.status !== 0
  const reason = result.error ? result.error.message : `exit ${result.status ?? result.signal}`
  appendFileSync(
    join(config.logDir, `${job.id}.log`),
    `--- ${stamp()} attempt ${job.attempts + 1} · ${reason}\n$ ${job.command}\n${result.stdout || ''}${result.stderr || ''}\n`,
  )
  return { ok: !failed, reason }
}

function purgeLogs(cutoff) {
  for (const name of readdirSync(config.logDir)) {
    if (name === 'runner.log') continue
    const path = join(config.logDir, name)
    if (statSync(path).mtimeMs / 1000 < cutoff) rmSync(path)
  }
}

function tick(queue) {
  const cutoff = nowSeconds() - config.retentionSeconds
  const purged = queue.purgeOlderThan(cutoff)
  purgeLogs(cutoff)
  const moved = queue.moveDue(nowSeconds())
  let done = 0
  let failed = 0
  for (const job of queue.readyJobs()) {
    const { ok, reason } = runJob(job)
    if (ok) {
      queue.ack(job.id)
      done += 1
    } else {
      queue.retryLater(job, nowSeconds() + config.retryDelaySeconds)
      failed += 1
      runnerLog(`job ${job.id} failed (${reason}), retry in ${config.retryDelaySeconds}s`)
    }
  }
  if (purged.length || moved || done || failed) {
    runnerLog(`tick: purged ${purged.length}, moved ${moved}, done ${done}, failed ${failed}`)
  }
  return { purged: purged.length, moved, done, failed }
}

function runTick() {
  mkdirSync(config.logDir, { recursive: true })
  return withLock(config.lockPath, () => {
    const queue = new Queue(config.dbPath)
    try {
      return tick(queue)
    } finally {
      queue.close()
    }
  })
}

export { tick, runTick }

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runTick()
    if (result === null) runnerLog('tick skipped: another tick is running')
  } catch (error) {
    runnerLog(`tick error: ${error.stack || error.message}`)
    process.exitCode = 1
  }
}
