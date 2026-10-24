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
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ready_created_at ON ready (created_at);
CREATE TABLE IF NOT EXISTS ids (id INTEGER PRIMARY KEY AUTOINCREMENT);
`

class Queue {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  // One id sequence across both queues, so a job keeps its id when it moves.
  nextId() {
    return this.db.prepare('INSERT INTO ids DEFAULT VALUES').run().lastInsertRowid
  }

  pushReady({ command, cwd, now }) {
    const id = this.nextId()
    this.db.prepare('INSERT INTO ready (id, command, cwd, attempts, created_at) VALUES (?, ?, ?, 0, ?)').run(id, command, cwd, now)
    return Number(id)
  }

  pushWaiting({ command, cwd, runAt, now }) {
    const id = this.nextId()
    this.db.prepare('INSERT INTO waiting (id, command, cwd, run_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, command, cwd, runAt, now)
    return Number(id)
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

  ack(id) {
    this.db.prepare('DELETE FROM ready WHERE id = ?').run(id)
  }

  retryLater(job, runAt) {
    const retry = this.db.transaction(() => {
      this.db.prepare('INSERT INTO waiting (id, command, cwd, run_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(job.id, job.command, job.cwd, runAt, job.attempts + 1, job.created_at)
      this.db.prepare('DELETE FROM ready WHERE id = ?').run(job.id)
    })
    retry()
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
    }
  }

  close() {
    this.db.close()
  }
}

export { Queue }
