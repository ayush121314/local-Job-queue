#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../src/config.js'
import { Queue } from '../src/queue.js'
import { runTick } from '../src/runner.js'
import { describe, parseWhen, WhenError } from '../src/when.js'

const USAGE = `q — local job queue

  q add "<command>"            run on the next tick (within 5 min)
  q add <when> "<command>"     run at a time: +30m  +2h  +1d  18:00  9am  "tomorrow 9am"  "mon 10:00"  "28 oct 18:00"
      --cwd <dir>              folder to run in (default: current folder)
  q list                       both queues
  q remove <id>                delete a job
  q logs <id>                  output of a job's runs
  q run                        run one tick now`

function takeOption(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value) throw new WhenError(`${name} needs a value`)
  args.splice(index, 2)
  return value
}

function add(args, queue) {
  const cwd = resolve(takeOption(args, '--cwd') || process.cwd())
  if (!existsSync(cwd)) throw new WhenError(`folder not found: ${cwd}`)
  if (args.length < 1 || args.length > 2) throw new WhenError('usage: q add [when] "<command>"')
  const command = args[args.length - 1].trim()
  if (!command) throw new WhenError('the command is empty')
  const now = new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (args.length === 1) {
    const id = queue.pushReady({ command, cwd, now: nowSeconds })
    console.log(`#${id} queued: runs on the next tick (within 5 min)`)
    return
  }
  const runAt = parseWhen(args[0], now)
  const id = queue.pushWaiting({ command, cwd, runAt, now: nowSeconds })
  console.log(`#${id} will run at ${describe(runAt, now)}`)
}

function list(queue) {
  const { ready, waiting } = queue.list()
  if (!ready.length && !waiting.length) return console.log('queue is empty')
  const now = new Date()
  for (const job of ready) console.log(`#${job.id}  READY    next tick${job.attempts ? `  (tries ${job.attempts})` : ''}  ${job.command}  [${job.cwd}]`)
  for (const job of waiting) console.log(`#${job.id}  WAITING  ${describe(job.run_at, now)}${job.attempts ? `  (tries ${job.attempts})` : ''}  ${job.command}  [${job.cwd}]`)
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!action || action === 'help' || action === '--help') return console.log(USAGE)
  if (action === 'logs') {
    const path = join(config.logDir, `${Number(args[0])}.log`)
    return console.log(existsSync(path) ? readFileSync(path, 'utf8') : `no log for #${args[0]} (not run yet, or purged)`)
  }
  if (action === 'run') {
    const result = runTick()
    return console.log(result === null ? 'another tick is running' : `purged ${result.purged}, moved ${result.moved}, done ${result.done}, failed ${result.failed}`)
  }
  const queue = new Queue(config.dbPath)
  try {
    if (action === 'add') return add(args, queue)
    if (action === 'list') return list(queue)
    if (action === 'remove') return console.log(queue.remove(Number(args[0])) ? `#${args[0]} removed` : `#${args[0]} not found`)
    console.log(USAGE)
    process.exitCode = 1
  } finally {
    queue.close()
  }
}

try {
  main()
} catch (error) {
  if (!(error instanceof WhenError)) throw error
  console.error(error.message)
  process.exitCode = 1
}
