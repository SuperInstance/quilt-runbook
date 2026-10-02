# Replay step contract (v0) — small, honest, deterministic

## What replay is for

After a play-test run, you want to re-test a FIXED strategy (the state, adjusted)
against the run's deterministic skeleton — cheaply, without re-running model calls or
network fetches. `replayRun(runDir, {from, adjustments, registry})` does exactly that
and nothing more.

## The step contract

A recorded step is replayable iff its payload carries:

```json
{
  "replayable": true,
  "fn": "registryName",
  "args": [ ...recorded inputs... ],
  "returns": <the output recorded during the original run>
}
```

with the invariant: `returns === registry[fn](args, state)` for the state AT THAT
MOMENT of the original run. Helper: `recordReplayable(fnName, args, fn, state)` builds
this payload from a live evaluation so the recorded `returns` is what actually
happened, not what was hoped.

## Registry rules

- Registry functions MUST be pure: same `(args, state)` → same `returns`.
  No clock, no randomness, no IO, no network, no globals.
- Replay passes deep CLONES of `args` and `state`; mutating them changes nothing
  outside the step (and is bad style anyway).

## Replay algorithm

1. `loadRun` (chain-verified; tamper = hard error naming the seq).
2. Resolve `from` (`'genesis'` | stablepoint seq | stablepoint label). Stablepoint
   snapshots are hash-verified (mismatch = hard error naming the seq).
3. Apply `adjustments` (§5a shape `{target:{cell_id,sheet}, before, after}`) to the
   re-materialized state FIRST. `target.cell_id` is a dotted path into the state.
   A wrong `before` precondition → the adjustment is NOT applied; the summary records
   `applied:false` with the reason. Nothing is forced silently.
4. Re-execute every marked-replayable step with `seq > from`, in seq order:
   `actual = registry[fn](args, state)`, verdict `pass` iff
   `canonicalJSON(actual) === canonicalJSON(returns)`.

## What replay CAN reproduce

- pure cell evaluations: lookups, formulas, routers driven by recorded args + state;
- the effect of a state adjustment on those evaluations (the cheap re-test);
- full determinism: identical invocations produce byte-identical summaries.

## What replay CANNOT reproduce (and says so)

- model/network calls: steps that touched an external system are recorded WITHOUT
  `replayable:true`; their recorded outcomes are data, never re-executed. If the
  adjusted strategy changes a judged outcome, the judge must be re-asked (budgeted),
  not simulated.
- wall-clock timings, latencies, external side effects.
- steps whose `fn` is missing from the provided registry: reported in the summary as
  `skipped` with a reason — never silently ignored.
