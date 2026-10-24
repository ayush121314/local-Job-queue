import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jobq-'))
process.env.JOBQ_DB = join(dir, 'queue.db')
process.env.JOBQ_LOGS = join(dir, 'logs')
process.env.JOBQ_LOCK = join(dir, 'runner.lock')

const { Queue } = await import('../src/queue.js')
const { runTick } = await import('../src/runner.js')
const { withLock } = await import('../src/lock.js')

const now = () => Math.floor(Date.now() / 1000)
let queue

beforeEach(() => {
  queue?.close()
  queue = new Queue(process.env.JOBQ_DB)
  queue.db.exec('DELETE FROM waiting; DELETE FROM ready; DELETE FROM schedules;')
})

test('a ready job runs once and is removed on success', () => {
  const marker = join(dir, 'ran.txt')
  const id = queue.pushReady({ command: `echo hi >> ${marker}`, cwd: dir, now: now() })
  assert.deepEqual(runTick(), { purged: 0, scheduled: 0, moved: 0, done: 1, failed: 0 })
  assert.equal(readFileSync(marker, 'utf8'), 'hi\n')
  assert.deepEqual(queue.list(), { ready: [], waiting: [], schedules: [] })
  assert.match(readFileSync(join(dir, 'logs', `${id}.log`), 'utf8'), /exit 0/)
  runTick()
  assert.equal(readFileSync(marker, 'utf8'), 'hi\n')
})

test('only due waiting jobs move; future ones stay untouched', () => {
  queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() - 60, now: now() })
  const later = queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() + 3600, now: now() })
  const result = runTick()
  assert.equal(result.moved, 1)
  assert.equal(result.done, 1)
  assert.deepEqual(queue.list().waiting.map((job) => job.id), [later])
})

test('a failed job goes back to waiting with a retry time and attempts + 1', () => {
  const id = queue.pushReady({ command: 'exit 3', cwd: dir, now: now() })
  assert.equal(runTick().failed, 1)
  const [job] = queue.list().waiting
  assert.equal(job.id, id)
  assert.equal(job.attempts, 1)
  assert.ok(job.run_at >= now() + 290)
  assert.match(readFileSync(join(dir, 'logs', `${id}.log`), 'utf8'), /exit 3/)
})

test('a job left in ready (runner killed mid-run) runs again on the next tick', () => {
  queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() - 1, now: now() })
  queue.moveDue(now())
  assert.equal(queue.list().ready.length, 1)
  assert.equal(runTick().done, 1)
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
  const inner = withLock(process.env.JOBQ_LOCK, () => runTick())
  assert.equal(inner, null)
})

test('ids stay unique across both queues', () => {
  const a = queue.pushReady({ command: 'true', cwd: dir, now: now() })
  const b = queue.pushWaiting({ command: 'true', cwd: dir, runAt: now() + 60, now: now() })
  assert.notEqual(a, b)
})

test('a schedule pushes its command when due and moves next_at forward one slot', () => {
  const marker = join(dir, 'every.txt')
  const t = now()
  const id = queue.addSchedule({ command: `echo tick >> ${marker}`, cwd: dir, everySeconds: 600, firstAt: t - 5, catchUp: 'once', now: t })
  const result = runTick()
  assert.equal(result.scheduled, 1)
  assert.equal(result.done, 1)
  assert.equal(readFileSync(marker, 'utf8'), 'tick\n')
  assert.equal(queue.schedules()[0].next_at, t - 5 + 600)
  assert.equal(runTick().scheduled, 0)
  assert.ok(queue.stopSchedule(id))
  assert.deepEqual(queue.schedules(), [])
})

test('laptop off 6h, hourly schedule, catch-up once: one push, next slot kept', () => {
  const t = now()
  const first = t - 6 * 3600 + 10
  queue.addSchedule({ command: 'true', cwd: dir, everySeconds: 3600, firstAt: first, catchUp: 'once', now: t })
  assert.equal(runTick().scheduled, 1)
  assert.equal(queue.schedules()[0].next_at, first + 6 * 3600)
})

test('laptop off 6h, hourly schedule, catch-up all: one push per missed slot', () => {
  const marker = join(dir, 'all.txt')
  const t = now()
  const first = t - 6 * 3600 + 10
  queue.addSchedule({ command: `echo x >> ${marker}`, cwd: dir, everySeconds: 3600, firstAt: first, catchUp: 'all', now: t })
  const result = runTick()
  assert.equal(result.scheduled, 6)
  assert.equal(result.done, 6)
  assert.equal(readFileSync(marker, 'utf8'), 'x\n'.repeat(6))
  assert.equal(queue.schedules()[0].next_at, first + 6 * 3600)
})

test('a schedule that is not due yet is not touched', () => {
  const t = now()
  queue.addSchedule({ command: 'true', cwd: dir, everySeconds: 600, firstAt: t + 600, catchUp: 'once', now: t })
  assert.equal(runTick().scheduled, 0)
  assert.equal(queue.schedules()[0].next_at, t + 600)
})
