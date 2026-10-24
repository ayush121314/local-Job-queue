# Using the job queue from any repo

How to make any repo on this Mac run work through the queue: one-off, at a time, or on a schedule. Read this once before wiring a repo in.

## 1. What you get

```
q every 10m "cmd"  ── each due slot pushes ──┐
q add "cmd"        ──────── push ───────────▶ READY ──pop──▶ runner runs "cmd"
q add 18:00 "cmd"  ──push──▶ WAITING ──(when due)──▶ READY      │
                                                                ├─ cmd ran `q ack` → job deleted
                                                                └─ no ack          → retry in 5 min
```

- The **runner** is a launchd agent. It starts at login/boot and then runs every 5 minutes. Each run:
  1. purges anything older than 3 days;
  2. fires due schedules;
  3. moves due WAITING jobs to READY;
  4. checks jobs it started earlier: still running → left alone; ended without `q ack` → retried in 5 min;
  5. starts every new READY job **in the background and moves on** (fire and forget).
- Work missed while the laptop was off runs on the first tick after it is back on.

## 2. Check it is installed

```bash
q --help                                                      # prints the usage
launchctl print gui/$(id -u)/com.primetrace.jobqueue | grep -E "state|run interval"
```

If `q` is not found, install it from `~/Downloads/WORK/job-queue`:
```bash
npm install && ./scripts/install.sh
```

## 3. The contract your command must follow

| Rule | What it means for your repo |
|---|---|
| **Ack, or it runs again** | A job is deleted **only** when its command runs `q ack`. The exit code does not count. Put `q ack` at the moment the work is truly finished. |
| **Runs in a login shell** | `zsh -lc "<command>"`, so Homebrew, nvm, `node`, `npm`, `aws` and `claude` work as in your terminal. `q` and the runner's `node` are always on PATH. |
| **Folder** | The command runs in `--cwd` (default: the folder you ran `q add` / `q every` from). Pass `--cwd` explicitly from scripts. |
| **`$JOBQ_JOB_ID`** | Set for every run; `q ack` reads it. Use it in your logs too. |
| **No time limit** | A job may run for an hour or a day. As long as its process is alive, the queue leaves it alone. |
| **Parallel** | Every ready job is started at once, in the background. Ten due jobs = ten processes at the same time; if your jobs must not overlap, make the command itself wait (e.g. a lock file). |
| **Failure = process ended without ack** | When the process has exited (any exit code) or died with the laptop and never ran `q ack`, the job is retried 5 minutes later. |
| **At least once** | If the laptop dies after your work but before `q ack`, the job runs again. Make commands safe to repeat: check "already done?" first. |
| **3-day purge** | A job that never acks is retried every 5 minutes until it is 3 days old, then deleted. |

## 4. Where to put `q ack`

**Shell one-liner.** `&&` means it acks only if the work succeeded:
```bash
q add "npm run sync && q ack" --cwd ~/Downloads/WORK/my-repo
```

**Inside a Node script.** Ack when the work is done:
```js
import { execFileSync } from 'node:child_process'

await doTheWork()
execFileSync('q', ['ack'])            // only reached if doTheWork() did not throw
```

**Python:**
```python
import subprocess
do_the_work()
subprocess.run(["q", "ack"], check=True)
```

Do **not** ack at the start of the work. If the work then fails, the job is gone and never retried.

## 5. The three ways to use it

**Run once, now** (within 5 min):
```bash
q add "node scripts/backfill.js && q ack" --cwd ~/Downloads/WORK/my-repo
```

**Run once, at a time.** Every `q add` prints when the job will run, so check it:
```bash
q add "+2h"            "node report.js && q ack" --cwd ~/Downloads/WORK/my-repo
q add 18:00            "..."     # today, or tomorrow if 18:00 has passed
q add "tomorrow 9am"   "..."
q add "mon 10:00"      "..."
q add "28 oct 18:00"   "..."     # a past time is refused
```

**Run on a schedule:**
```bash
q every 10m "node scan.js && q ack" --cwd ~/Downloads/WORK/my-repo
q every 1d  "node daily.js && q ack" --cwd ~/Downloads/WORK/my-repo --at 9am
q every 1h  "node sync.js && q ack" --cwd ~/Downloads/WORK/my-repo --catchup all
```
- The interval must be 5m or more.
- `--catchup once` (default): after the laptop was off, push once.
- `--catchup all`: push once per missed slot.

## 6. Producer → consumer: a scan job that queues one job per item

This is the pattern for "every few minutes, find new work and queue each piece", for example new answer sheets to check.

```bash
# once, from the repo:
q every 10m "node scripts/scan-new.js && q ack" --cwd ~/Downloads/WORK/my-repo
```

```js
// scripts/scan-new.js — the producer
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const SEEN = '.queue-seen.json'                       // in the repo; gitignore it
const seen = new Set(existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : [])

const items = await findNewItems()                    // your own query: prod DB, API, folder…
for (const item of items) {
  if (seen.has(item.id)) continue                     // never queue the same item twice
  execFileSync('q', ['add', `node scripts/process-one.js ${item.id} && q ack`,
                     '--cwd', process.cwd()])
  seen.add(item.id)
}
writeFileSync(SEEN, JSON.stringify([...seen]))
```

```js
// scripts/process-one.js — the consumer, one item per job
const id = process.argv[2]
if (await alreadyDone(id)) process.exit(0)            // safe to repeat (at-least-once)
await processItem(id)                                 // throws on failure → no ack → retried in 5 min
```

The `&& q ack` in the queued command acks only when `process-one.js` exits 0.

## 7. Watch and debug

```bash
q list                 # schedules (S…), RUNNING / READY / WAITING jobs, with "late by" / tries
q logs <id>            # every attempt: start time, stdout + stderr, exit code
q run                  # run one tick now instead of waiting for the next 5 minutes
q remove <id>          # delete a job
q stop S<id>           # stop a schedule
tail -f ~/Downloads/WORK/job-queue/logs/runner.log           # one line per tick that did something
cat ~/Downloads/WORK/job-queue/logs/launchd.err.log          # the runner itself crashing
```

| You see | Cause | Fix |
|---|---|---|
| `--- exit 0` in the log, job keeps retrying | Command never ran `q ack` | Add `&& q ack` or ack in code |
| `exit 127` / `command not found` | Tool not on the login-shell PATH | Use the full path, or add it in `~/.zprofile` |
| `q list` shows RUNNING for hours | The command is still running (or stuck) | `q logs <id>`; kill the process if stuck, it is retried |
| Job ran twice | Laptop died after the work, before the ack | Make it safe to repeat (check "already done?") |
| Nothing runs | Runner not loaded | `./scripts/install.sh`, then `launchctl print …` |

## 8. Checklist before adding a repo

- [ ] The command works when you run it by hand in that folder.
- [ ] It runs `q ack` only after the work succeeded.
- [ ] Running it twice does no harm.
- [ ] It is fine running at the same time as other jobs.
- [ ] `--cwd` points at the repo.
- [ ] `q add` / `q every` printed the time you expected.
- [ ] After the first run, the job is gone from `q list` (it acked).
