#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../src/config.js'
import { Queue } from '../src/queue.js'
import { runTick } from '../src/runner.js'
import { describe, parseEvery, parseWhen, span, WhenError } from '../src/when.js'

const USAGE = `q — local job queue

  q add "<command>"              run on the next tick (within 5 min)
  q add <when> "<command>"       run at a time: +30m  +2h  +1d  18:00  9am  "tomorrow 9am"  "mon 10:00"  "28 oct 18:00"
  q every <interval> "<command>" push the command into the queue every 30m / 2h / 1d ...
      --at <when>                first push (default: next tick)
      --catchup once|all         laptop was off: push once (default), or once per missed slot
      --cwd <dir>                folder to run in (default: current folder)

  q ack                          inside a job's command: mark it done (uses $JOBQ_JOB_ID).
                                 A job whose command never runs q ack is retried in 5 min.
  q list                         schedules and both queues
  q remove <id>                  delete a job
  q stop <schedule id>           delete a schedule
  q logs <id>                    output of a job's runs
  q run                          run one tick now`

function takeOption(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value) throw new WhenError(`${name} needs a value`)
  args.splice(index, 2)
  return value
}

function cwdOption(args) {
  const cwd = resolve(takeOption(args, '--cwd') || process.cwd())
  if (!existsSync(cwd)) throw new WhenError(`folder not found: ${cwd}`)
  return cwd
}

function commandFrom(args, usage) {
  if (args.length < 1 || args.length > 2) throw new WhenError(usage)
  const command = args[args.length - 1].trim()
  if (!command) throw new WhenError('the command is empty')
  return command
}

function add(args, queue) {
  const cwd = cwdOption(args)
  const command = commandFrom(args, 'usage: q add [when] "<command>"')
  const now = new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (args.length === 1) {
    const id = queue.pushReady({ command, cwd, now: nowSeconds })
    return console.log(`#${id} queued: runs on the next tick (within 5 min)`)
  }
  const runAt = parseWhen(args[0], now)
  const id = queue.pushWaiting({ command, cwd, runAt, now: nowSeconds })
  console.log(`#${id} will run at ${describe(runAt, now)}`)
}

function every(args, queue) {
  const at = takeOption(args, '--at')
  const catchUp = takeOption(args, '--catchup') || 'once'
  if (catchUp !== 'once' && catchUp !== 'all') throw new WhenError('--catchup is once or all')
  const cwd = cwdOption(args)
  if (args.length !== 2) throw new WhenError('usage: q every <interval> "<command>"')
  const everySeconds = parseEvery(args[0], config.tickSeconds)
  const command = commandFrom(args, 'usage: q every <interval> "<command>"')
  const now = new Date()
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const firstAt = at ? parseWhen(at, now) : nowSeconds
  const id = queue.addSchedule({ command, cwd, everySeconds, firstAt, catchUp, now: nowSeconds })
  console.log(`schedule S${id}: every ${span(everySeconds)}, catch-up ${catchUp}, first push ${at ? 'at ' + describe(firstAt, now) : 'on the next tick'}`)
}

function list(queue) {
  const { ready, waiting, schedules } = queue.list()
  if (!ready.length && !waiting.length && !schedules.length) return console.log('queue is empty')
  const now = new Date()
  const tries = (job) => (job.attempts ? `  (tries ${job.attempts})` : '')
  for (const s of schedules) console.log(`S${s.id}  EVERY ${span(s.every_seconds)}  catch-up ${s.catch_up}  next ${describe(s.next_at, now)}  ${s.command}  [${s.cwd}]`)
  for (const job of ready) {
    const state = job.started_at ? `RUNNING  since ${describe(job.started_at, now).replace('late by', 'for')}` : 'READY    next tick'
    console.log(`#${job.id}  ${state}${tries(job)}  ${job.command}  [${job.cwd}]`)
  }
  for (const job of waiting) console.log(`#${job.id}  WAITING  ${describe(job.run_at, now)}${tries(job)}  ${job.command}  [${job.cwd}]`)
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!action || action === 'help' || action === '--help') return console.log(USAGE)
  if (action === 'logs') {
    const path = join(config.logDir, `${Number(args[0])}.log`)
    return console.log(existsSync(path) ? readFileSync(path, 'utf8') : `no log for #${args[0]} (not run yet, or purged)`)
  }
  if (action === 'run') {
    const r = runTick()
    return console.log(r === null ? 'another tick is running' : `purged ${r.purged}, scheduled ${r.scheduled}, moved ${r.moved}, started ${r.started}, retried ${r.retried}, still running ${r.running}`)
  }
  const queue = new Queue(config.dbPath)
  try {
    if (action === 'add') return add(args, queue)
    if (action === 'every') return every(args, queue)
    if (action === 'list') return list(queue)
    if (action === 'finished') {
      const id = Number(args[0] || process.env.JOBQ_JOB_ID)
      if (!id) throw new WhenError('q finished needs a job id')
      if (queue.finish(id, Math.floor(Date.now() / 1000) + config.retryDelaySeconds)) {
        console.log(`#${id} ended without q ack: retry in ${config.retryDelaySeconds / 60} min`)
      }
      return
    }
    if (action === 'ack') {
      const id = Number(args[0] || process.env.JOBQ_JOB_ID)
      if (!id) throw new WhenError('q ack needs a job id, or run it inside a queued command ($JOBQ_JOB_ID)')
      if (queue.ack(id)) return console.log(`#${id} acked`)
      console.error(`#${id} is not running (already acked, removed or purged)`)
      process.exitCode = 1
      return
    }
    if (action === 'remove') return console.log(queue.remove(Number(args[0])) ? `#${args[0]} removed` : `#${args[0]} not found`)
    if (action === 'stop') {
      const id = Number(String(args[0] || '').replace(/^s/i, ''))
      return console.log(queue.stopSchedule(id) ? `schedule S${id} stopped` : `schedule S${id} not found`)
    }
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
