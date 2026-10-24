import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.js'
import { Queue } from './queue.js'
import { withLock } from './lock.js'

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', 'T')
const nowSeconds = () => Math.floor(Date.now() / 1000)

function runnerLog(line) {
  appendFileSync(join(config.logDir, 'runner.log'), `${stamp()} ${line}\n`)
}

// A job succeeds only if its command ran `q ack` (which deletes it from READY), as SQS DeleteMessage.
// The exit code is logged but does not decide anything.
function runJob(queue, job) {
  const result = spawnSync(config.shell, ['-lc', job.command], {
    cwd: job.cwd,
    encoding: 'utf8',
    timeout: config.commandTimeoutSeconds * 1000,
    maxBuffer: 50 * 1024 * 1024,
    // launchd starts us with a bare PATH: put `q` and this node first so `q ack` always works.
    env: { ...process.env, JOBQ_JOB_ID: String(job.id), PATH: `${config.binDir}:${dirname(process.execPath)}:${process.env.PATH || ''}` },
  })
  const exit = result.error ? result.error.message : `exit ${result.status ?? result.signal}`
  const acked = !queue.isReady(job.id)
  appendFileSync(
    join(config.logDir, `${job.id}.log`),
    `--- ${stamp()} attempt ${job.attempts + 1} · ${exit} · ${acked ? 'acked' : 'not acked'}\n$ ${job.command}\n${result.stdout || ''}${result.stderr || ''}\n`,
  )
  return { acked, exit }
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
  const scheduled = queue.fireDueSchedules(nowSeconds())
  const moved = queue.moveDue(nowSeconds())
  let done = 0
  let failed = 0
  for (const job of queue.readyJobs()) {
    const { acked, exit } = runJob(queue, job)
    if (acked) {
      done += 1
    } else {
      queue.retryLater(job, nowSeconds() + config.retryDelaySeconds)
      failed += 1
      runnerLog(`job ${job.id} not acked (${exit}), retry in ${config.retryDelaySeconds}s`)
    }
  }
  if (purged.length || scheduled || moved || done || failed) {
    runnerLog(`tick: purged ${purged.length}, scheduled ${scheduled}, moved ${moved}, done ${done}, failed ${failed}`)
  }
  return { purged: purged.length, scheduled, moved, done, failed }
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
