import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jobq-'))
process.env.JOBQ_DB = join(dir, 'queue.db')
process.env.JOBQ_LOGS = join(dir, 'logs')
process.env.JOBQ_LOCK = join(dir, 'runner.lock')
process.env.JOBQ_HEARTBEAT_SECONDS = '1'
process.env.JOBQ_HEARTBEAT_STALE_SECONDS = '3'

const { Queue } = await import('../src/queue.js')
const { runTick, bootTime, deadReason } = await import('../src/runner.js')
const { withLock } = await import('../src/lock.js')

const now = () => Math.floor(Date.now() / 1000)
const Q = join(import.meta.dirname, '..', 'bin', 'q.js')
const ACK = `${process.execPath} ${Q} ack`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(100)
  }
  return false
}

const logOf = (id) => {
  const path = join(dir, 'logs', `${id}.log`)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

let queue

beforeEach(() => {
  queue?.close()
  queue = new Queue(process.env.JOBQ_DB)
  queue.db.exec('DELETE FROM waiting; DELETE FROM ready; DELETE FROM schedules;')
})

test('a job is started in the background and deleted when its command acks', async () => {
  const marker = join(dir, 'ran.txt')
  const id = queue.pushReady({ command: `echo hi >> ${marker} && ${ACK}`, cwd: dir, now: now() })
  assert.equal(runTick().started, 1)
  assert.ok(await waitFor(() => !queue.isReady(id)), 'job acked')
  assert.equal(readFileSync(marker, 'utf8'), 'hi\n')
  assert.ok(await waitFor(() => /--- exit 0/.test(logOf(id))))
  assert.equal(runTick().started, 0)
  assert.equal(readFileSync(marker, 'utf8'), 'hi\n')
})

test('the runner does not wait: a long job keeps running across ticks with no time limit', async () => {
  const id = queue.pushReady({ command: `sleep 3 && ${ACK}`, cwd: dir, now: now() })
  const begin = Date.now()
  runTick()
  assert.ok(Date.now() - begin < 2000, 'tick returned without waiting')
  const second = runTick()
  assert.equal(second.running, 1)
  assert.equal(second.retried, 0)
  assert.equal(second.started, 0)
  assert.ok(await waitFor(() => !queue.isReady(id)), 'acked after it finished')
})

test('jobs run in parallel', async () => {
  const a = queue.pushReady({ command: `sleep 2 && ${ACK}`, cwd: dir, now: now() })
  const b = queue.pushReady({ command: `sleep 2 && ${ACK}`, cwd: dir, now: now() })
  const begin = Date.now()
  assert.equal(runTick().started, 2)
  assert.ok(await waitFor(() => !queue.isReady(a) && !queue.isReady(b)))
  assert.ok(Date.now() - begin < 3800, 'both finished in about 2s, not 4s')
})

test('a command that ends without q ack is retried at once by its wrapper (q finished)', async () => {
  const id = queue.pushReady({ command: 'echo no-ack; exit 0', cwd: dir, now: now() })
  runTick()
  assert.ok(await waitFor(() => queue.list().waiting.some((job) => job.id === id)), 'back in waiting without another tick')
  const [job] = queue.list().waiting
  assert.equal(job.attempts, 1)
  assert.ok(job.run_at >= now() + 290)
  assert.match(logOf(id), /--- exit 0/)
})

test('a command that crashes without q ack is retried the same way', async () => {
  const id = queue.pushReady({ command: 'kill -9 $$', cwd: dir, now: now() })
  runTick()
  assert.ok(await waitFor(() => queue.list().waiting.some((job) => job.id === id)))
})

test('a job that acks and then exits non-zero is done', async () => {
  const id = queue.pushReady({ command: `${ACK} && exit 4`, cwd: dir, now: now() })
  runTick()
  assert.ok(await waitFor(() => /--- exit 4/.test(logOf(id))))
  await sleep(500)
  assert.deepEqual(queue.list().waiting, [])
  assert.equal(queue.isReady(id), false)
})

test('a job started before the last boot (laptop restarted) is retried', () => {
  const id = queue.pushReady({ command: 'true', cwd: dir, now: now() })
  queue.markStarted(id, bootTime() - 10)
  assert.equal(runTick().retried, 1)
  assert.equal(queue.list().waiting[0].id, id)
})

test('a job started hours ago that still beats is left running', () => {
  const id = queue.pushReady({ command: 'true', cwd: dir, now: now() })
  queue.markStarted(id, now() - 6 * 3600)
  queue.beat(id, now())
  const result = runTick()
  assert.equal(result.retried, 0)
  assert.equal(result.running, 1)
  assert.ok(queue.isReady(id))
})

test('JOBQ_JOB_ID and JOBQ_ATTEMPT are passed to the command', async () => {
  const marker = join(dir, 'env.txt')
  const id = queue.pushReady({ command: `echo "$JOBQ_JOB_ID $JOBQ_ATTEMPT" > ${marker} && ${ACK}`, cwd: dir, now: now() })
  runTick()
  assert.ok(await waitFor(() => !queue.isReady(id)))
  assert.equal(readFileSync(marker, 'utf8'), `${id} 1\n`)
})

test('only due waiting jobs move; future ones stay untouched', async () => {
  const due = queue.pushWaiting({ command: ACK, cwd: dir, runAt: now() - 60, now: now() })
  const later = queue.pushWaiting({ command: ACK, cwd: dir, runAt: now() + 3600, now: now() })
  const result = runTick()
  assert.equal(result.moved, 1)
  assert.equal(result.started, 1)
  assert.ok(await waitFor(() => !queue.isReady(due)))
  assert.deepEqual(queue.list().waiting.map((job) => job.id), [later])
})

test('jobs and logs older than 3 days are purged', () => {
  const old = now() - 3 * 86400 - 10
  const oldId = queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() + 3600, now: old })
  queue.pushReady({ command: 'false', cwd: dir, now: old })
  const keep = queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() + 3600, now: now() })
  const oldLog = join(dir, 'logs', `${oldId}.log`)
  writeFileSync(oldLog, 'old')
  utimesSync(oldLog, old, old)
  assert.equal(runTick().purged, 2)
  assert.deepEqual(queue.list().waiting.map((job) => job.id), [keep])
  assert.equal(existsSync(oldLog), false)
})

test('a second tick while one holds the lock is skipped', () => {
  assert.equal(withLock(process.env.JOBQ_LOCK, () => runTick()), null)
})

test('ids stay unique across both queues', () => {
  const a = queue.pushReady({ command: 'true', cwd: dir, now: now() })
  const b = queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() + 60, now: now() })
  assert.notEqual(a, b)
})

test('q ack outside a job fails', () => {
  const env = { ...process.env }
  delete env.JOBQ_JOB_ID
  const run = spawnSync(process.execPath, [Q, 'ack'], { env, encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /needs a job id/)
})

test('a schedule pushes its command when due and moves next_at forward one slot', async () => {
  const marker = join(dir, 'every.txt')
  const t = now()
  const id = queue.addSchedule({ command: `echo tick >> ${marker} && ${ACK}`, cwd: dir, everySeconds: 600, firstAt: t - 5, catchUp: 'once', now: t })
  const result = runTick()
  assert.equal(result.scheduled, 1)
  assert.equal(result.started, 1)
  assert.ok(await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'tick\n'))
  assert.equal(queue.schedules()[0].next_at, t - 5 + 600)
  assert.equal(runTick().scheduled, 0)
  assert.ok(queue.stopSchedule(id))
})

test('laptop off 6h, hourly schedule, catch-up once: one push, next slot kept', () => {
  const t = now()
  const first = t - 6 * 3600 + 10
  queue.addSchedule({ command: 'true', cwd: dir, everySeconds: 3600, firstAt: first, catchUp: 'once', now: t })
  assert.equal(runTick().scheduled, 1)
  assert.equal(queue.schedules()[0].next_at, first + 6 * 3600)
})

test('laptop off 6h, hourly schedule, catch-up all: one push per missed slot', async () => {
  const marker = join(dir, 'all.txt')
  const t = now()
  const first = t - 6 * 3600 + 10
  queue.addSchedule({ command: `echo x >> ${marker} && ${ACK}`, cwd: dir, everySeconds: 3600, firstAt: first, catchUp: 'all', now: t })
  const result = runTick()
  assert.equal(result.scheduled, 6)
  assert.equal(result.started, 6)
  assert.ok(await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8') === 'x\n'.repeat(6)))
  assert.equal(queue.schedules()[0].next_at, first + 6 * 3600)
})

test('a schedule that is not due yet is not touched', () => {
  const t = now()
  queue.addSchedule({ command: 'true', cwd: dir, everySeconds: 600, firstAt: t + 600, catchUp: 'once', now: t })
  assert.equal(runTick().scheduled, 0)
  assert.equal(queue.schedules()[0].next_at, t + 600)
})

test('a running job keeps beating, and the beat only overwrites its own row', async () => {
  const id = queue.pushReady({ command: `sleep 3 && ${ACK}`, cwd: dir, now: now() })
  runTick()
  const startedAt = queue.list().ready[0].started_at
  assert.ok(await waitFor(() => (queue.list().ready[0]?.heartbeat_at ?? 0) > startedAt, 3000), 'heartbeat moved forward')
  assert.equal(queue.db.prepare('SELECT COUNT(*) AS n FROM ready').get().n, 1)
  assert.ok(await waitFor(() => !queue.isReady(id)))
})

test('wrapper and command force-killed: the beat stops and the next tick retries the job', async () => {
  const id = queue.pushReady({ command: 'sleep 60 # jobq-kill-test', cwd: dir, now: now() })
  runTick()
  await sleep(500)
  spawnSync('pkill', ['-9', '-f', 'jobq-kill-test'])
  await sleep(4500)
  assert.equal(runTick().retried, 1)
  assert.equal(queue.list().waiting[0].id, id)
})

test('dead or alive: restart, stale beat, fresh beat, and the wake-from-sleep grace', () => {
  const t = 10_000
  const job = (started, beat) => ({ started_at: started, heartbeat_at: beat })
  assert.equal(deadReason(job(t - 50, t - 50), { now: t, bootedAt: t - 10, wokeAt: 0 }), 'the laptop restarted')
  assert.equal(deadReason(job(t - 50, t - 10), { now: t, bootedAt: 0, wokeAt: 0 }), 'no heartbeat')
  assert.equal(deadReason(job(t - 50, t - 1), { now: t, bootedAt: 0, wokeAt: 0 }), null)
  assert.equal(deadReason(job(t - 7200, t - 7200), { now: t, bootedAt: 0, wokeAt: t - 1 }), null, 'just woke up: wait')
  assert.equal(deadReason(job(t - 7200, t - 7200), { now: t, bootedAt: 0, wokeAt: t - 10 }), 'no heartbeat', 'awake long enough')
})
