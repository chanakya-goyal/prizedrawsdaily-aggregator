# Applying the QA routine's proposals (owner, about 2 minutes a day)

Since 2026-10-21 the daily QA routine never writes to the database: its cloud permission check
denies every write, and a repo `.claude/settings.json` allow rule is not honoured there. The
routine records each change it decides on with `manager/propose.mjs` and pushes them on a
`qa-proposals/<date>` branch. You apply them from this checkout, where `.env` holds the key.

## Every day, after the routine's 20:30 IST run

```
cd ~/pdd-aggregator && git pull -q
bun manager/apply-proposals.mjs
```

That is a dry run. It lists each draw, the fields it would set and the routine's one-line reason,
and which rows it will skip. A row is skipped when it changed after the routine judged it, when
its category was set by hand, or when the patch breaks a rule (it can never set a draw live). If
the list looks right:

```
APPLY=1 bun manager/apply-proposals.mjs
```

Then retire finished comps (the routine only dry-runs this):

```
STATUS=active,draft DRY_RUN=false bun ended-sweep.mjs
```

## Other cases

- Missed a day: the dry run names older branches not applied from this machine. Apply one with
  `BRANCH=qa-proposals/<date> bun manager/apply-proposals.mjs` (then `APPLY=1`). Rows that moved
  since are skipped, so applying an old branch late is safe.
- The routine couldn't push: it pastes the lines in its report. Save them to a file and run
  `bun manager/apply-proposals.mjs that-file.jsonl`.
- Old branches can be deleted on GitHub once applied; `manager/proposals/applied.log` (local,
  git-ignored) records what this machine applied.
