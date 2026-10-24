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

function sysctlSeconds(name) {
  const out = execFileSync('sysctl', ['-n', name], { encoding: 'utf8' })
  const match = /sec = (\d+)/.exec(out)
  return match ? Number(match[1]) : 0
}

// Unix seconds of the last boot. Every job started before it died with the restart.
const bootTime = () => sysctlSeconds('kern.boottime')

// Unix seconds of the last wake from sleep. Heartbeats stop while the lid is closed, so a job
// is judged only on time awake since then.
const wakeTime = () => sysctlSeconds('kern.waketime')

// Fire and forget: the command runs on its own, with no time limit, and is deleted when it runs
// `q ack` (as SQS DeleteMessage). When it ends, however it ends, the wrapper's last line reports
// `q finished <id>`, which retries the job if it was not acked. Output and exit code go to logs/<id>.log.
function startJob(queue, job) {
  const logPath = join(config.logDir, `${job.id}.log`)
  appendFileSync(logPath, `--- ${stamp()} attempt ${job.attempts + 1} started\n$ ${job.command}\n`)
  const log = openSync(logPath, 'a')
  // Heartbeat: a loop beats every few minutes while the wrapper ($$) is alive, and stops when the job
  // is acked or the wrapper is gone, so it never outlives its job.
  const wrapper = [
    'wrapper=$$',
    `( while sleep ${config.heartbeatSeconds}; kill -0 $wrapper 2>/dev/null; do q beat "$JOBQ_JOB_ID" >/dev/null 2>&1 || break; done ) &`,
    'beater=$!',
    `${config.shell} -lc "$1"; code=$?`,
    'kill $beater 2>/dev/null',
    'echo "--- exit $code"',
    'q finished "$JOBQ_JOB_ID"',
  ].join('\n')
  const child = spawn(config.shell, ['-c', wrapper, 'jobq', job.command], {
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
  queue.markStarted(job.id, nowSeconds())
}

// Why a started, not-acked job is no longer running, or null when it is alive.
function deadReason(job, { now, bootedAt, wokeAt }) {
  if (job.started_at < bootedAt) return 'the laptop restarted'
  const lastSign = Math.max(job.heartbeat_at ?? job.started_at, wokeAt)
  if (now - lastSign > config.heartbeatStaleSeconds) return 'no heartbeat'
  return null
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

  // Started, not acked, and not alive any more: died with a restart (started before the boot), or
  // crashed / was killed without reporting (no heartbeat for heartbeatStaleSeconds of awake time).
  const clock = { now: nowSeconds(), bootedAt: bootTime(), wokeAt: wakeTime() }
  let retried = 0
  let running = 0
  for (const job of queue.startedJobs()) {
    const why = deadReason(job, clock)
    if (!why) {
      running += 1
      continue
    }
    queue.retryLater(job, nowSeconds() + config.retryDelaySeconds)
    retried += 1
    runnerLog(`job ${job.id} not running any more (${why}), retry in ${config.retryDelaySeconds}s`)
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

export { tick, runTick, deadReason, bootTime, wakeTime }

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runTick()
    if (result === null) runnerLog('tick skipped: another tick is running')
  } catch (error) {
    runnerLog(`tick error: ${error.stack || error.message}`)
    process.exitCode = 1
  }
}
