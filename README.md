# quilt-runbook

Append-only play-test runbooks for the quilt. A run leaves **real logs** that can be
**rewound to stable points**, records the **WHY of every adjustment**, and **mines**
recurring adjustments into **compiled cells** — so future runs hit those paths natively
and **stop needing adjustments over time**.

This operationalizes the principal's wave-66 directive:

> play-testers … actually work through the tools leaving records of all that they
> attempted and the processes run as real logs that can be rewound to stable point and
> states adjusted along the way and decomposing why adjustments were made to build new
> cells so runs don't need adjustments over time.

Node.js ESM, **stdlib only**, no dependencies. Consumed-by / consumes:
lane 66-a's adjustment→cell compiler (via the §5a contract), lane 66-d's catalog work
(the dogfood run in `runs/` is a catalog→cell-fragments feeder).

## The loop (what "runs stop needing adjustments" means mechanically)

```
                      ┌────────────────────────────────────────────────┐
                      v                                                |
  ┌─────────┐   ┌──────────────┐   ┌─────────┐   ┌────────────────┐     |
  │ attempt ├─> │   observe    ├─> │ adjust  ├──>│ stablepoint    │     |
  │ (try)   │   │ (judgement)  │   │ (§5a:   │   │ (§5c: hash +   │     |
  └─────────┘   └──────────────┘   │ target, │   │  snapshot)     │     |
       │            │              │ before, │   └───────┬────────┘     |
       │            │              │ after,  │           │              |
       │            │              │ WHY{    │           |  REWIND:     |
       │            │              │ trigger,│           v  resumeFrom() |
       │            │              │ hypo,   │   ┌────────────────┐     |
       │            │              │ evid)   ├──>│    rewind to   │─────┘
       │            │              └─────────┘   │ stable point,  │
       │            │                            │ adjust state,  │
       │            │                            │ re-run branch  │
       │            │                            └────────────────┘
       │            v
       │     ┌──────────────┐   cluster by (target, hypothesis keywords)
       │     │   run.jsonl  ├──────────────────────────────┐
       │     │ (append-only,│                              v
       │     │  hash-chained)│                   ┌──────────────────┐
       │     └──────────────┘                   │ mine.js →        │
       │                                        │ compiled_cell    │
       │                                        │ proposals (§5a)  │
       │                                        └────────┬─────────┘
       │                                                 v
       │                              ┌────────────────────────────────────┐
       └──────────────────────────────┤ next run USES the compiled cell    │
                 runs keep getting     │ natively — no manual adjustment    │
                 cheaper to run        └────────────────────────────────────┘
```

Every play-test run is a ledger: append-only, hash-chained, fail-closed. Nothing is
silently dropped — an invalid payload becomes an `error` step. History is never
rewritten: a rewind **appends** a `resumed-from` marker and continues the same `run_id`
on a new branch. The WHY of each adjustment is a first-class record (§5a), and the miner
clusters recurring WHYs into compiled-cell proposals.

## Quickstart

```js
import { createRun, resumeFrom, mineRun, replayRun } from './src/index.js';

// 1. a run is a directory runs/<run_id>/ with an append-only run.jsonl ledger
const run = createRun({ runsRoot: './runs', runId: 'demo-1', meta: { target: 'demo' } });

// 2. the working state is the only mutable file; snapshots are immutable
run.setState({ cells: { ztable: { tails: 'two' } } });

// 3. play-test: attempt -> observe -> adjust -> stablepoint
run.stablepoint('drafted', { note: 'fragments drafted' });          // §5c record
run.attempt({ what: 'evaluated ztable against alpha=0.05' });
run.observe({ outcome: 'judge flagged one-tail/two-tail conflation', verdict: 'fail' });
run.adjust({                                                        // §5a record
  target: { cell_id: 'ztable', sheet: 'catalog' },
  before: { tails: 'two' }, after: { tails: 'param' },
  why: { trigger: 'judge flagged conflation',
         hypothesis: 'tails must be a parameter, not a value',
         evidence: ['run.jsonl seq 3'] },
  generalizes: true,                                                // false = one-off, never compiled
});

// 4. rewind to the stable point (history untouched; marker step appended) and continue
const resumed = resumeFrom('./runs/demo-1', 'drafted');   // by label or by seq
resumed.setState({ cells: { ztable: { tails: 'param' } } });         // adjust state
resumed.attempt({ what: 're-ran with adjusted state' });

// 5. mine recurring WHYs into compiled-cell proposals (runs/<id>/compilations.jsonl)
mineRun('./runs/demo-1');

// 6. cheap re-test: deterministic replay from a stable point + a state adjustment
replayRun('./runs/demo-1', {
  from: 'drafted',
  registry: { evalZtable: (args, state) => /* pure fn */ 0 },
  adjustments: [{ target: { cell_id: 'cells.ztable.tails', sheet: 'catalog' },
                  before: 'two', after: 'param' }],
});
```

CLI-free by design: import the four modules (see `docs/run-format.md` for the ledger
format, `docs/replay-contract.md` for the replay step contract).

## Laws (each enforced in code, each has a test)

| # | law | where |
|---|-----|-------|
| L1 | Append-only ledger; seq contiguous; history is a byte-prefix that only grows | `run.js`, `tests/run.test.mjs` |
| L2 | Hash chain: `id = sha256(run_id|seq|prev|body)`; tamper = HARD error naming the seq | `run.js loadRun` |
| L3 | Fail-closed: invalid payloads are recorded as `error` steps, never skipped | `run.js append` |
| L4 | §5a/§5c contract shapes exact — field names are interop law (lanes 66-a/66-e) | `run.js` validators |
| L5 | Stable-point `state_hash` is over the snapshot BYTES; mismatch = HARD error naming the seq | `rewind.js` |
| L6 | Stale handle refuses to append (`STALE_HANDLE`) — a second writer fails closed instead of duplicating a seq | `run.js _push` |
| L7 | Rewind never rewrites: `resumed-from` marker appends; drift is preserved, not destroyed | `rewind.js` |
| L8 | Only generalizing, recurring adjustments compile (≥2 per cluster) | `mine.js` |
| L9 | Replay re-executes only pure, marked steps; everything else is honestly `skipped` | `replay.js` |

## Tests

```
npm test        # node --test, zero network, ~300ms
```

36 tests: append/seq/hash law, fail-closed recording, stale-handle rejection, §5a/§5c shape
validation, stablepoint verify + tamper rejection, resumeFrom correctness + non-rewrite of
history, drift preservation, miner clustering + idempotence, replay determinism + honest skips.

## Dogfood

`scripts/dogfood-catalog.mjs` is a REAL play-test run over the principal's
spreadsheet-types catalog (quilt-lookup, 1027 entries / 103 families): it ideates
catalog families as executable lookup cells, formalizes cell fragments, judges them
with typesafe jev-latest (3 receipted calls), hits real failures, adjusts with honest
WHY records, takes stablepoints, rewinds, re-runs, and mines the run into compiled-cell
proposals. The committed `runs/` directory IS that run's ledger — read
`runs/dogfood-catalog-66c/run.jsonl` as the executable demo of this package.

## Files

```
src/run.js       Run object: append-only hash-chained ledger, §5a/§5c ops, fail-closed
src/rewind.js    resumeFrom(runDir, seq|label): verify + re-materialize + marker step
src/mine.js      WHY-decomposition miner -> compilations.jsonl (§5a records)
src/replay.js    deterministic re-execution from a stable point + state adjustments
src/canonical.js canonicalJSON / sha256 primitives
docs/            run format spec + replay contract + design notes
scripts/         keyscan (pre-push law) + the dogfood play-test driver
runs/            committed real runs (the dogfood demo)
```
