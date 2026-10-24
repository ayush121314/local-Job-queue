# local-job-queue

A local queue of shell commands for macOS. Push a command to run now or at a time; a runner pops and runs it, SQS-style: a command is deleted only after it succeeds.

```
q add "cmd"          ──push──▶  READY   ──pop──▶  runner runs it  (success → deleted)
q add 18:00 "cmd"    ──push──▶  WAITING (sorted by time)
                                   └── every 5 min: due jobs move ──▶ READY
```

- **Runner:** a launchd agent. It runs at login/boot and every 5 minutes, so jobs missed while the laptop was off run as soon as it is on.
- **Only due work is read:** WAITING is indexed on `run_at`; each tick reads `run_at <= now` and stops at the first future job.
- **Failure:** non-zero exit or timeout → back to WAITING for 5 minutes later (`attempts + 1`).
- **Purge:** anything older than 3 days is deleted from both queues, with its log.
- **Storage:** one SQLite file, `data/queue.db`.

## Install

```bash
npm install
./scripts/install.sh      # launchd agent + ~/.local/bin/q
```

## Use

```bash
q add "npm run sync" --cwd ~/code/app     # next tick (within 5 min)
q add +30m "./report.sh"                  # +30m  +2h  +1d
q add 18:00 "node send.js"                # today, or tomorrow if 18:00 has passed
q add "tomorrow 9am" "..."                # also: "mon 10:00", "28 oct 18:00"
q list
q logs <id>
q remove <id>
q run                                     # one tick now
```

Commands run with `zsh -lc` in their folder (default: where you ran `q`), with a 30-minute timeout.
Settings (env overrides) are in `src/config.js`. Plan: `docs/PLAN.md`. Tests: `npm test`.

## Uninstall

```bash
./scripts/uninstall.sh    # queue data in data/ is kept
```
