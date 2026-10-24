# local-job-queue

A local queue of shell commands for macOS. Push a command to run now or at a time; a runner pops and runs it, SQS-style: a job is deleted only when its command acks it with `q ack`.

```
q every 10m "cmd" ── each due slot pushes ──┐
q add "cmd"          ──push──▶  READY   ◀──┘  ──pop──▶  runner runs it  (success → deleted)
q add 18:00 "cmd"    ──push──▶  WAITING (sorted by time)
                                   └── every 5 min: due jobs move ──▶ READY
```

- **Runner:** a launchd agent. It runs at login/boot and every 5 minutes, so jobs missed while the laptop was off run as soon as it is on.
- **Only due work is read:** WAITING is indexed on `run_at`; each tick reads `run_at <= now` and stops at the first future job.
- **Ack (like SQS DeleteMessage):** every job's command must run `q ack` when its work is done. The runner gives it `$JOBQ_JOB_ID` and `$JOBQ_ATTEMPT` (1 on the first try), and `q` is always on its PATH. Acked → deleted. Not acked when its process has ended (whatever the exit code) → back to WAITING for 5 minutes later (`attempts + 1`).
- **Fire and forget, no time limit:** the runner starts each command in the background and moves on, so jobs run in parallel and may take as long as they need.
- **Failure is reported by the job itself:** each command runs inside a wrapper whose last line is `q finished $JOBQ_JOB_ID`. When the command ends, however it ends, a job that never acked goes straight back to WAITING. A laptop restart kills jobs before they can report, so any job started before the last boot (`sysctl kern.boottime`) is retried on the next tick.
- **Heartbeat for crashes and kills:** while a command runs, its wrapper beats every 3 minutes (overwriting one number in the job's row, so the database does not grow). A started, un-acked job with no beat for 10 minutes of awake time is retried. Time asleep never counts: the 10 minutes run from the later of the last beat and the last wake (`kern.waketime`).
- **Schedules:** `q every` pushes its command into READY every interval. Slots missed while the laptop was off: `--catchup once` (default) pushes once, `--catchup all` pushes once per missed slot; the next push stays on its slot.
- **Purge:** anything older than 3 days is deleted from both queues, with its log.
- **Storage:** one SQLite file, `data/queue.db`.

## Install

```bash
npm install
./scripts/install.sh      # launchd agent + ~/.local/bin/q
```

## Use

```bash
q add "npm run sync && q ack" --cwd ~/code/app   # next tick (within 5 min); acks only if sync succeeds
q add +30m "./report.sh"                  # +30m  +2h  +1d
q add 18:00 "node send.js"                # today, or tomorrow if 18:00 has passed
q add "tomorrow 9am" "..."                # also: "mon 10:00", "28 oct 18:00"
q every 30m "./scan.sh"                   # push into the queue every 30m / 2h / 1d
q every 1d "./daily.sh" --at 9am          # first push at 9am, then daily
q every 1h "./sync.sh" --catchup all      # laptop off 6h → 6 pushes (default once → 1)
q stop S<id>                              # stop a schedule
q ack                                     # inside a job's command: mark it done
q list
q logs <id>
q remove <id>
q run                                     # one tick now
```

Commands run with `zsh -lc` in their folder (default: where you ran `q`), in the background, with no time limit.
Settings (env overrides) are in `src/config.js`. Plan: `docs/PLAN.md`. Tests: `npm test`.

## Uninstall

```bash
./scripts/uninstall.sh    # queue data in data/ is kept
```

Using it from another repo, end to end: [RUNNER.md](RUNNER.md).
