import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function seconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of seconds`)
  return value
}

const config = {
  binDir: join(root, 'bin'),
  dbPath: process.env.JOBQ_DB || join(root, 'data', 'queue.db'),
  logDir: process.env.JOBQ_LOGS || join(root, 'logs'),
  lockPath: process.env.JOBQ_LOCK || join(root, 'data', 'runner.lock'),
  retentionSeconds: seconds('JOBQ_RETENTION_SECONDS', 3 * 24 * 3600),
  retryDelaySeconds: seconds('JOBQ_RETRY_DELAY_SECONDS', 5 * 60),
  tickSeconds: 300,
  shell: process.env.JOBQ_SHELL || '/bin/zsh',
}

export { config }
