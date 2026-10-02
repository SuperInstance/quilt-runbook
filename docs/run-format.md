# Run format spec (v0) — the ledger and its contract shapes

## Directory layout

```
runs/<run_id>/
  run.jsonl            THE ledger. One JSON step per line. Append-only, hash-chained.
  adjustments.jsonl    §5a adjustment records only (mirror of adjust steps; for the
                       66-a compiler lane — zero parsing risk, no chain fields needed).
  compilations.jsonl   §5a-shaped compiled_cell proposals emitted by mine.js (append-only,
                       idempotent: proposal ids are never duplicated).
  state.json           the ONLY mutable file (working state). Rewinds overwrite it
                       AFTER preserving drift (see below).
  snapshots/           immutable byte-copies of state.json at stable points:
                       0003-<label-slug>.json, superseded-at-NNNN.json
```

## The step record (one line of run.jsonl)

```json
{
  "seq": 3,                       // 1-based, contiguous, never reused
  "ts_utc": "2026-10-02T04:12:00Z",
  "op": "attempt",                // attempt|observe|stablepoint|adjust|note|error|resumed-from
  "payload": { ...op-specific... },
  "receipt": { ...optional... },  // external-call receipt (channel, model, usage tokens)
  "run_id": "20261002T0412-ab12",
  "prev": "sha256:<64hex>",       // previous step's id; seq 1 uses sha256:genesis:<run_id> id
  "id": "sha256:<64hex>"          // sha256 over "run_id|seq|prev|canonicalJSON(body)"
}                                 // body = {seq, ts_utc, op, run_id, payload?, receipt?}
```

Tamper law: any edit to any line breaks `id` or `prev` → `loadRun` throws
`RUN_LEDGER_TAMPER` naming the seq. Corrections are NEW steps (L1).

## Op payloads

- `attempt` `{what, input?, expectation?}` — something was tried.
- `observe` `{outcome, of_seq?, verdict?('pass'|'fail'|'mixed'|'unknown'), detail?}` — a
  judgement of an attempt. Receipts for external judges ride here.
- `note` `{text, meta?}`.
- `error` `{code, op_requested?, problems?, received?}` — fail-closed recording (L3).
- `resumed-from` `{from_seq, from_label, state_hash, snapshot, superseded_snapshot?, note}`
  — the rewind marker; everything after it is the new branch. History is never rewritten.
- `stablepoint` — §5c EXACT:
  `{kind:'stablepoint', run_id, seq, ts_utc, label, state_hash, snapshot, note}`
  where `state_hash = sha256:<hex of the exact state.json bytes>` and `snapshot` is a
  relative path into `snapshots/` (byte-copy, immutable).
- `adjust` — §5a EXACT (the payload IS the record):
  `{kind:'adjustment', run_id, at_seq, ts_utc, target:{cell_id, sheet}, before, after,
    why:{trigger, hypothesis, evidence:[...]}, generalizes, compiled_cell}`
  `compiled_cell` is `null` at write time (the compiler fills it later);
  `generalizes:false` means one-off — the miner never compiles it.

## Branch semantics

The ledger is physically linear; branches are logical. `resumeFrom` appends
`resumed-from`; readers scan for the LAST `resumed-from` marker to find the live branch;
earlier markers delimit older branches. Nothing is deleted, so the full decision
history (including failed branches) stays mineable.

## Fail-closed recording

`append()` validates BEFORE writing. Invalid payloads do not throw-and-skip: an `error`
step is recorded with `{code:'INVALID_PAYLOAD', op_requested, problems[], received}`
(preserving the offending payload), and the call returns `{ok:false, problems, step}`.
Unknown op names also record an error step and THEN throw (programmer errors should be
loud but never silent drops).
