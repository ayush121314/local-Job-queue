import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS waiting (
  id INTEGER PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waiting_run_at ON waiting (run_at);
CREATE INDEX IF NOT EXISTS idx_waiting_created_at ON waiting (created_at);
CREATE TABLE IF NOT EXISTS ready (
  id INTEGER PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ready_created_at ON ready (created_at);
CREATE TABLE IF NOT EXISTS ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  every_seconds INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  catch_up TEXT NOT NULL CHECK (catch_up IN ('once', 'all')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_next_at ON schedules (next_at);
`

class Queue {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.addStartColumns()
  }

  // A queue.db made before fire-and-forget has no started_at on READY.
  addStartColumns() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(ready)').all().map((column) => column.name))
    if (!columns.has('started_at')) this.db.exec('ALTER TABLE ready ADD COLUMN started_at INTEGER')
  }

  // One id sequence across both queues, so a job keeps its id when it moves.
  nextId() {
    return Number(this.db.prepare('INSERT INTO ids DEFAULT VALUES').run().lastInsertRowid)
  }

  pushReady({ command, cwd, now }) {
    const id = this.nextId()
    this.db.prepare('INSERT INTO ready (id, command, cwd, attempts, created_at) VALUES (?, ?, ?, 0, ?)').run(id, command, cwd, now)
    return id
  }

  pushWaiting({ command, cwd, runAt, now }) {
    const id = this.nextId()
    this.db.prepare('INSERT INTO waiting (id, command, cwd, run_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, command, cwd, runAt, now)
    return id
  }

  // Reads only rows that are due: the run_at index stops the scan at the first future row.
  moveDue(now) {
    const move = this.db.transaction(() => {
      const due = this.db.prepare('SELECT * FROM waiting WHERE run_at <= ? ORDER BY run_at, id').all(now)
      const insert = this.db.prepare('INSERT INTO ready (id, command, cwd, attempts, created_at) VALUES (?, ?, ?, ?, ?)')
      const remove = this.db.prepare('DELETE FROM waiting WHERE id = ?')
      for (const job of due) {
        insert.run(job.id, job.command, job.cwd, job.attempts, job.created_at)
        remove.run(job.id)
      }
      return due.length
    })
    return move()
  }

  readyJobs() {
    return this.db.prepare('SELECT * FROM ready ORDER BY id').all()
  }

  notStartedJobs() {
    return this.db.prepare('SELECT * FROM ready WHERE started_at IS NULL ORDER BY id').all()
  }

  startedJobs() {
    return this.db.prepare('SELECT * FROM ready WHERE started_at IS NOT NULL ORDER BY id').all()
  }

  markStarted(id, startedAt) {
    this.db.prepare('UPDATE ready SET started_at = ? WHERE id = ?').run(startedAt, id)
  }

  // Called by the job's wrapper when its command has ended. Not acked = retry; acked = already gone.
  finish(id, retryAt) {
    const job = this.db.prepare('SELECT * FROM ready WHERE id = ?').get(id)
    if (!job) return false
    this.retryLater(job, retryAt)
    return true
  }

  // Called by the job's own command (q ack) while it runs.
  ack(id) {
    return this.db.prepare('DELETE FROM ready WHERE id = ?').run(id).changes > 0
  }

  isReady(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM ready WHERE id = ?').get(id))
  }

  retryLater(job, runAt) {
    const retry = this.db.transaction(() => {
      this.db.prepare('INSERT INTO waiting (id, command, cwd, run_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.id, job.command, job.cwd, runAt, job.attempts + 1, job.created_at)
      this.db.prepare('DELETE FROM ready WHERE id = ?').run(job.id)
    })
    retry()
  }

  addSchedule({ command, cwd, everySeconds, firstAt, catchUp, now }) {
    return Number(this.db.prepare(
      'INSERT INTO schedules (command, cwd, every_seconds, next_at, catch_up, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(command, cwd, everySeconds, firstAt, catchUp, now).lastInsertRowid)
  }

  // Due schedules push their command into READY. Slots missed while the laptop was off push once
  // (catch_up 'once') or once per missed slot ('all'); next_at then moves to the next future slot.
  fireDueSchedules(now) {
    const fire = this.db.transaction(() => {
      const due = this.db.prepare('SELECT * FROM schedules WHERE next_at <= ? ORDER BY next_at, id').all(now)
      let pushed = 0
      for (const schedule of due) {
        const slots = Math.floor((now - schedule.next_at) / schedule.every_seconds) + 1
        const times = schedule.catch_up === 'all' ? slots : 1
        for (let i = 0; i < times; i += 1) this.pushReady({ command: schedule.command, cwd: schedule.cwd, now })
        pushed += times
        this.db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?')
          .run(schedule.next_at + slots * schedule.every_seconds, schedule.id)
      }
      return pushed
    })
    return fire()
  }

  schedules() {
    return this.db.prepare('SELECT * FROM schedules ORDER BY next_at, id').all()
  }

  stopSchedule(id) {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
  }

  purgeOlderThan(cutoff) {
    const purge = this.db.transaction(() => {
      const old = [
        ...this.db.prepare('SELECT id FROM waiting WHERE created_at < ?').all(cutoff),
        ...this.db.prepare('SELECT id FROM ready WHERE created_at < ?').all(cutoff),
      ].map((row) => row.id)
      this.db.prepare('DELETE FROM waiting WHERE created_at < ?').run(cutoff)
      this.db.prepare('DELETE FROM ready WHERE created_at < ?').run(cutoff)
      return old
    })
    return purge()
  }

  remove(id) {
    const a = this.db.prepare('DELETE FROM waiting WHERE id = ?').run(id).changes
    const b = this.db.prepare('DELETE FROM ready WHERE id = ?').run(id).changes
    return a + b > 0
  }

  list() {
    return {
      ready: this.readyJobs(),
      waiting: this.db.prepare('SELECT * FROM waiting ORDER BY run_at, id').all(),
      schedules: this.schedules(),
    }
  }

  close() {
    this.db.close()
  }
}

export { Queue }
