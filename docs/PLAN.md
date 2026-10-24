# job-queue — plan

A local queue of shell commands on this Mac. Push a command (now or at a time); a runner pops and runs it.
Like SQS: a command is deleted only after it succeeds.

## Flow

```
q add "cmd"          ──push──▶  READY   ──pop──▶  runner runs it
q add 18:00 "cmd"    ──push──▶  WAITING (sorted by run_at)
                                   └── every 5 min: due rows move ──▶ READY
```

Every runner tick (launchd: at login/boot and every 5 minutes):
1. **Purge:** delete rows older than 3 days (by `created_at`) from both queues, and their logs.
2. **Move:** `SELECT … FROM waiting WHERE run_at <= now ORDER BY run_at` (index range scan: only due rows are read), insert into `ready`, delete from `waiting` — one transaction.
3. **Pop:** take `ready` rows oldest first; run each with `zsh -lc "<command>"` in its folder.
   - exit 0 → delete the row (ack).
   - non-zero / timeout → `attempts + 1`, back to `waiting` with `run_at = now + retry delay`.
   - runner killed mid-command → the row is still in `ready`, so it runs again next tick (at-least-once, as SQS).

## Storage (SQLite, `data/queue.db`, WAL)

```
waiting(id PK, command, cwd, run_at, attempts, created_at)   INDEX(run_at), INDEX(created_at)
ready  (id PK, command, cwd, attempts, created_at)           INDEX(created_at)
```
`id` is kept when a job moves between queues. All times are unix seconds.

## Push side — `q`

| Command | Does |
|---|---|
| `q add "<cmd>"` | READY, runs on the next tick |
| `q add <when> "<cmd>"` | WAITING. `<when>`: `+30m` `+2h` `+1d`, `18:00`, `9am`, `9:30pm` (today, or tomorrow if passed), `tomorrow 9am`, `mon 10:00`, `28 oct 18:00`. A past time is refused. Prints when it will run. |
| `--cwd <dir>` | Folder to run in (default: the folder you ran `q` from) |
| `q list` | Both queues, with run time / "late by" |
| `q remove <id>` | Delete a job |
| `q logs <id>` | Output of a job's runs |
| `q run` | Run one tick now |

## Settings (`src/config.js`, env overrides)
Tick 5 min (launchd), retention 3 days, retry delay 5 min, command timeout 30 min.

## Files
- `src/config.js` paths and numbers · `src/queue.js` the only file that touches SQLite · `src/when.js` time parsing · `src/runner.js` one tick · `bin/q.js` CLI
- `launchd/com.primetrace.jobqueue.plist` (RunAtLoad + StartInterval 300) · `scripts/install.sh` / `uninstall.sh`

## Risks
- launchd has a tiny PATH: commands run through a login shell (`zsh -lc`) so Homebrew/nvm tools work.
- Two ticks at once: launchd never starts a second copy of a running job; `q run` takes a lock file too.
- Laptop off: missed ticks are not replayed one by one; the next tick moves every overdue job at once.

## Tests
`node --test`: time parsing (every form, past refused, today-vs-tomorrow), push/move/pop/ack, failure → retry, purge after 3 days, crash leaves job in READY. Then a real run under launchd.

## Schedules (added 25 Oct 2026)
`schedules(id, command, cwd, every_seconds, next_at, catch_up once|all, created_at)`, `INDEX(next_at)`.
Each tick, before the move: `SELECT … WHERE next_at <= now` (only due schedules). Slots due = `floor((now − next_at) / every) + 1`.
`catch_up = once` pushes 1 job, `all` pushes one per slot; `next_at += slots × every` (stays on its slot). Schedules are never purged; `q stop`.
