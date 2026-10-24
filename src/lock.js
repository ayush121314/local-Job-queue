import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Runs fn only if no other live process holds the lock; returns null when it is held.
function withLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
  } catch {
    const holder = Number(readFileSync(lockPath, 'utf8'))
    if (holder && isAlive(holder)) return null
    writeFileSync(lockPath, String(process.pid))
  }
  try {
    return fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

export { withLock }
