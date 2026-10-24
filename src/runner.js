import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.js'
import { Queue } from './queue.js'
import { withLock } from './lock.js'

const stamp = () => new Date().toLocaleString('sv-SE').replace(' ', 'T')
const nowSeconds = () => Math.floor(Date.now() / 1000)

function runnerLog(line) {
  appendFileSync(join(config.logDir, 'runner.log'), `${stamp()} ${line}\n`)
}

// Start time of a live process in unix seconds, or null when no such process exists.
function processStartedAt(pid) {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return started ? Math.floor(Date.parse(started) / 1000) : null
  } catch {
    return null
  }
}

// Alive = a process with this pid exists AND started when we started it; after a reboot the
// pid may belong to some other process, which the start time tells apart.
function isRunning(job) {
  const startedAt = processStartedAt(job.pid)
  return startedAt !== null && Math.abs(startedAt - job.started_at) <= 5
}

// Fire and forget: the command runs on its own, with no time limit, and is deleted when it runs
// `q ack` (as SQS DeleteMessage). Its output and exit code go to logs/<id>.log.
function startJob(queue, job) {
  const logPath = join(config.logDir, `${job.id}.log`)
  appendFileSync(logPath, `--- ${stamp()} attempt ${job.attempts + 1} started\n$ ${job.command}\n`)
  const log = openSync(logPath, 'a')
  const child = spawn(config.shell, ['-c', `${config.shell} -lc "$1"; echo "--- exit $?"`, 'jobq', job.command], {
    cwd: job.cwd,
    detached: true,
    stdio: ['ignore', log, log],
    // launchd starts us with a bare PATH: put `q` and this node first so `q ack` always works.
    env: {
      ...process.env,
      JOBQ_JOB_ID: String(job.id),
      JOBQ_ATTEMPT: String(job.attempts + 1),
      PATH: `${config.binDir}:${dirname(process.execPath)}:${process.env.PATH || ''}`,
    },
  })
  closeSync(log)
  child.unref()
  queue.markStarted(job.id, child.pid, processStartedAt(child.pid) ?? nowSeconds())
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

  let retried = 0
  let running = 0
  for (const job of queue.startedJobs()) {
    if (isRunning(job)) {
      running += 1
      continue
    }
    // Ended (or the laptop restarted) without `q ack`: acked jobs are no longer in READY.
    queue.retryLater(job, nowSeconds() + config.retryDelaySeconds)
    retried += 1
    runnerLog(`job ${job.id} ended without q ack, retry in ${config.retryDelaySeconds}s`)
  }

  const toStart = queue.notStartedJobs()
  for (const job of toStart) startJob(queue, job)

  const started = toStart.length
  if (purged.length || scheduled || moved || started || retried) {
    runnerLog(`tick: purged ${purged.length}, scheduled ${scheduled}, moved ${moved}, started ${started}, retried ${retried}, still running ${running}`)
  }
  return { purged: purged.length, scheduled, moved, started, retried, running }
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

export { tick, runTick, isRunning }

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runTick()
    if (result === null) runnerLog('tick skipped: another tick is running')
  } catch (error) {
    runnerLog(`tick error: ${error.stack || error.message}`)
    process.exitCode = 1
  }
}
