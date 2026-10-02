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
  run.chain.jsonl      (sealed runs) custody sidecar: one organ-receipt link per
                       ledger step, append-only. Written by src/seal.js only.
  run.seal.json        (sealed runs) the LATEST signed custody anchor — a
                       quilt.organ.checkpoint. Pointer, like state.json is the
                       newest state; superseded seals stay verifiable against
                       the append-only sidecar.
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

## Signed custody (sealed runs)

`src/seal.js` (lane 68-b) gives a run dir DURABLE SIGNED CUSTODY in the organ
protocol's own format — the 1:1 port of quilt-chrono's seal (67-a). Three files
change nothing about the ledger itself:

- `run.chain.jsonl` — one link per step, `{seq, op: <the step verbatim>, prev, hash}`
  with `hash = sha256(canonical({seq, op, prev}))` anchored at `GENESIS`. A link IS
  an organ receipt, so quilt-jev-toolkit's `verifyChain`/`receiptHash` verify the
  sidecar unmodified. SEQ-BASE LAW: runbook steps are 1-based; link seqs are the
  0-based ledger index (organ receipt chains start at 0 — organ manifest law), so
  `link.seq = step.seq - 1` and the step's own seq rides verbatim inside `op`.
- `run.seal.json` — the organ v2 signed checkpoint, EXACTLY:
  `{schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256", seq,
  hash: <chainTip at seq>, manifestHash, sig, manifest}` with
  `sig = HMAC-SHA256(key, canonical({hash, manifestHash, seq}))`. `seq` is the
  0-based boundary; the runbook-facing boundary is `sealedThroughSeq = seq + 1`.
  The manifest's "cells" are the run's §5c stablepoint anchors
  (`stablepoint/<seq>` → `{seq, label, state_hash, snapshot}`) — the state a bare
  ledger PROVES. A prefix with no stablepoints refuses to seal.
- the courtroom — `verifyRunCustody(runDir, {key})`: chain re-hash → boundary
  anchor → manifest re-hash to the SIGNED manifestHash → chained-step L2 id
  re-verification → ledger witness → snapshot re-derivation (every anchored
  stablepoint's bytes must re-hash to its §5c state_hash, `STABLEPOINT_HASH_MISMATCH`
  naming the seq).

**The custody floor (rewind law).** `resumeFrom` on a sealed run verifies custody
FIRST (the courtroom before anything materializes), then refuses a stablepoint that
PRECEDES the sealed boundary with `REWIND_PAST_CUSTODY` naming the checkpoint (the
organ `rewind.mjs` `resolveTarget` law, mirrored). Resuming AT the boundary
stablepoint is the legal case — the signed state itself. To re-open the run's line
below the current floor, mint a superseding seal at or before the target stablepoint
(`sealRun(dir, {key, seq})` — lineage recorded via `supersedes`, identity carried via
`organId`). Unsealed runs resume exactly as before; the gate is additive.

## Fail-closed recording

`append()` validates BEFORE writing. Invalid payloads do not throw-and-skip: an `error`
step is recorded with `{code:'INVALID_PAYLOAD', op_requested, problems[], received}`
(preserving the offending payload), and the call returns `{ok:false, problems, step}`.
Unknown op names also record an error step and THEN throw (programmer errors should be
loud but never silent drops).
