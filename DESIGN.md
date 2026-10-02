# DESIGN.md — quilt-runbook

## Problem

The principal's directive asks for play-test runs that (a) leave real logs of everything
attempted, (b) can be rewound to stable points with state adjusted along the way,
(c) decompose WHY each adjustment was made, and (d) compile those WHYs into new cells so
runs stop needing adjustments. Nothing in the fleet so far captures (c)+(d): cot-quilt's
`runs/` records receipts; the organ protocol (quilt-jev-toolkit) rewinds *organs*; but
the *practice* of play-testing — attempt, fail, adjust, rewind, re-run — has no ledger
and no learning loop. This package is that practice, made mechanical.

## Ideation: three architectures considered

### Alternative A — git-branches-as-runs
Model each play-test as a git branch; stable points = commits; rewind = `git checkout`;
adjustments = commits with WHY in the message; mining = scanning commit messages.
- **For:** free diffing, free history, free remote backup; rewind semantics battle-tested.
- **Against:** the ledger becomes prose. Commit messages are unstructured — the WHY is
  not machine-readable, so the compiler lane cannot consume it without fragile parsing.
  Seq/hash law = git's object model, but the contract shapes (§5a/§5c) would be embedded
  in free text, weakening the interop guarantee. Branch-per-run multiplies repos/refs;
  `runs/` inside an already-busy repo is ref churn. Fail-closed recording (L3) has no
  git analogue: git cannot record an invalid commit *as* a commit that says "I am
  invalid". Finally, every write needs a git process spawn — the ledger should be as
  cheap as `appendFileSync`.
- **Verdict:** rejected as the core; git remains fine for *storing* the ledger (it is
  just a file) but must not be the ledger *model*.

### Alternative B — mutable state machine log (event sourcing with rewrites)
Model the run as a state machine; each adjustment is a transition; rewind = rolling the
machine back and *replacing* the future transitions with new ones.
- **For:** the "current state" is always exactly defined; no superseded-branch clutter.
- **Against:** rewriting the future is exactly what the principal said NOT to do — the
  record of what was attempted (including the failed branch) is the institutional
  memory. A rewound-and-replaced log destroys the evidence the miner needs ("why was the
  first strategy adjusted? because this branch failed like that"). It also breaks
  receipt chains: any hash chain over rewritten events must be recomputed, so a receipt
  captured mid-branch becomes unverifiable.
- **Verdict:** rejected — violates append-only honesty (L1/L7).

### Alternative C (CHOSEN) — append-only ledger + stable points + compensating branches
One hash-chained jsonl per run; the only mutable file is `state.json`; a stable point is
a §5c record (hash of the exact state bytes + immutable snapshot); a rewind appends a
`resumed-from` marker and the new branch continues in the same ledger.
- **For:**
  - History is the receipt: failed branches remain first-class evidence for the miner
    (the WHY of an adjustment cites the failing branch's seqs).
  - Hash chain over jsonl is the same shape as the fleet's qmr1 receipt chain and the
    organ protocol's chain — one mental model across repos.
  - Compensating steps, not rewrites: the `resumed-from` marker + the superseded-state
    snapshot are the *compensations* that keep the ledger truthful while the working
    state moves. (Same double-entry instinct as organ rewind: you never delete; you
    append a record that explains the change.)
  - The WHY is structured data (§5a) the moment it is written — the compiler lane reads
    `adjustments.jsonl` with zero parsing risk.
- **Against / costs:** the ledger grows monotonically (accepted: jsonl gzips well and
  runs are human-scale); "current branch" is implicit (a marker scan, see
  `docs/run-format.md`); two copies of the state exist (working + snapshots) and drift
  between them must be preserved on rewind (law L7, tested).
- **Verdict:** chosen.

### Rejected micro-alternatives
- *SQLite/LevelDB for the ledger* — stdlib-only law; jsonl is greppable by every other
  lane agent without bindings.
- *Hash the state tree instead of files* — over-engineering for one `state.json`.
- *Put compiled cells inline in the ledger* — no: compilation is the MINER's output and
  the 66-a compiler's decision; the run only guarantees the §5a records are there.

## Why append-only + compensating steps (the honest argument)

An append-only ledger with compensation models how real play-testing memory works:
you cannot un-observe a failure; you can only record that you later corrected for it.
Mechanically, three compensations carry the whole design:

1. **`resumed-from` marker** — the ledger itself never branches physically; the marker
   is the compensation that says "everything after here supersedes the tail, but the
   tail stays readable".
2. **superseded-state snapshot** — when a rewind would clobber drifted state, the drift
   is snapshotted first (never delete data), then the stable-point state is restored.
3. **`error` steps for invalid payloads** — fail-closed recording: even a mistake in
   *writing the log* becomes part of the log, with the offending payload preserved.

This is the same instinct as the organ protocol's rewind (credits are revoked by an
append-only receipt, not deleted) and qmr1's receipt chain (corrections are new
receipts). Wave-66 is converging on one law: **the ledger is sacred; corrections are
appends.**

## Composition with the rest of the wave

- **Organ protocol (quilt-jev-toolkit) rewind — `quilt-jev-toolkit/src/organ/rewind.mjs`
  (read, cited, deliberately NOT reimplemented):** the organ rewind family
  (`stateAt` / `rewind` / `transact`) rewinds *executable organ state* under signed
  custody. Its append-only discipline is the same law this package follows, expressed
  differently: an organ rewind does NOT erase superseded host credits — it APPENDS a
  compensating `organ.rewind` receipt that revokes them and carries
  `{creditSeq, creditHash, organSeq, debitHash}` pointers as evidence; the organ's own
  ledger truncates (with custody floor `REWIND_PAST_CUSTODY`), while a runbook ledger
  never truncates at all — our `resumed-from` marker is the pure-append analogue of the
  organ's compensating receipt, and our `superseded-at-NNNN.json` snapshot plays the
  receipt's evidence-pointer role for working state. Composition: when a run drives an
  organ, the runbook stable point's `state_hash` can BE the organ checkpoint hash; the
  runbook adds the WHY records (trigger/hypothesis/evidence) the organ deliberately does
  not carry, and the organ adds signed custody the runbook deliberately does not fake.
- **cot-quilt `runs/`:** cot-quilt's run directories are receipt archives for a finished
  pipeline. The runbook's runs are *live* ledgers — same jsonl aesthetic, but
  interactive, rewindable, and mined. A cot-quilt run can be imported as a read-only
  runbook run (receipt steps) to retro-mine its adjustments.
- **quilt-softjoints' adjustment→cell compiler — `../quilt-softjoints/src/compiler.js`
  (lane 66-a, read, cited):** `compileAdjustments(sheet, adjustments, {threshold:2})`
  consumes §5a adjustment records and emits compiled cells when a pattern repeats.
  SAME schema on both sides (brief §5a is the interop contract), so EITHER side may
  compile; the receipts record who did. Direction as implemented here:
  `src/mine.js` EMITS §5a-shaped proposals to `runs/<run_id>/compilations.jsonl`
  (append-only, idempotent by proposal id); 66-a's compiler CONSUMES them and owns
  instantiation into the sheet (`auto-<cell>-<hash>` lookup/formula guard cells).
  66-a's compiler may equally mine our `adjustments.jsonl` stream directly — one
  contract, no coupling.
- **Lane 66-d (catalog):** the dogfood run in `runs/` is a catalog→cell-fragments
  feeder: which spreadsheet-type families became executable fragments, which failed,
  and the compiled cells that already exist for them.

## The mining heuristic (honest limits)

Clustering is deterministic and small: exact-target grouping + union-find over
hypothesis keyword overlap (stoplisted tokens, len≥4). This is NOT semantics — two
adjustments phrased with disjoint vocabularies won't cluster, and a shared keyword is
not proof of a shared cause. The guards: ≥2 members, all `generalizes:true`, and every
proposal carries its full evidence trail (member seqs + triggers) so the compiler lane
can reject a bad cluster cheaply. Future cell: a soft-joint judge (§5b) that scores
cluster coherence — the ledger already contains the receipts it would need.

## What replay deliberately cannot do

Replay re-executes only steps whose payloads mark them `replayable` with a PURE registry
fn (see `docs/replay-contract.md`). Model calls, wall-clock timings, and external side
effects are never re-executed; their recorded outcomes are data. This keeps the "cheap
re-test of a fixed strategy" honest: if the adjusted strategy changes a *judged*
outcome, the judge must be re-asked (budgeted), not simulated.

## Scale / cost notes

- Ledger write = one `appendFileSync` + one sha256. A 10k-step run costs ~10MB.
- `loadRun` verifies the whole chain (O(n) sha256 of small lines) — fine for runs;
  a chain-cached O(tail) verify like organ boot is parked until runs get big.
- External model usage is a caller decision; the runbook only demands the receipt
  rides on the step (pricing-first, same law as the lode systemone client).

## Dogfood findings (run `runs/dogfood-catalog-66c/` — the run IS the evidence)

A real play-test over quilt-lookup's parsed spreadsheet-types catalog (1027 entries /
103 families), driven entirely through `src/index.js`. 54 steps, 13 attempts, 17
observes, 3 stablepoints (`drafted` / `adjusted` / `replayed-and-fixed`), 5 §5a
adjustments, 1 rewind+resume, 1 fail-closed error step, 1 compiled-cell proposal.
3 typesafe jev-latest judge calls (5,973 in / 1,178 out tokens, receipted). What the
run TAUGHT us (all recorded in-ledger, nothing retro-fitted):

1. **The pure evaluator caught 4 real formalization defects in 10 drafted fragments**
   (seqs 10, 14, 24, 26): a hardcoded 2-set inclusion–exclusion identity that ignores
   set C (hardcoded *arity*), an annuity cell with hardcoded *timing convention* (331 vs
   364.1), a z-table conflating cumulative vs two-tail *intent* (0.975 served where
   0.05 was meant), and a monte-carlo fragment that is a *sampler, not a table* — the
   evaluator refused it structurally (`not_deterministic`).
2. **The rewind re-run caught a SECOND defect the first pass missed** (seq 44): fixing
   the annuity's timing convention still failed the monthly-contribution /
   semiannual-compounding example — hardcoded *compounding frequency*, the SAME
   root-cause class as the timing defect. That recurrence is exactly the miner's
   signal: seqs 31 + 45 clustered into compiled cell `cell-c8c1c5f6` (kind=formula,
   "parameterize the convention") — the one adjustment this run will never need again.
3. **Not everything should compile.** The monte-carlo fragment's honest verdict is a
   §5b soft joint (nondeterministic sampler with a closed-form fallback), tombstoned
   into `state.softjoints` with its eval left fail-by-design: replay must REPRODUCE the
   failure, not hide it. `generalizes:true` was kept and the judge's dissent
   (`one_off`, seq 52) was recorded, never rewritten — append-only all the way down.
4. **Fail-closed recording works in the wild**: seq 28 is a real `error` step — an
   adjust record missing `generalizes` was refused by the §5a validator and recorded
   (with the offending payload) instead of skipped or thrown away.
5. **Two handles on one ledger is a corruption hazard — the guard is law (L6).** A
   rewind returns a NEW handle while the old one stays alive; if the stale one appends,
   a duplicate seq would corrupt the chain. `_push` therefore fails closed with
   `STALE_HANDLE` (found while building the dogfood, per the `run.js` header; tested in
   `tests/run.test.mjs`), and the run itself operated under that discipline — seq 38:
   "the pre-rewind handle is stale by law L6 and refuses to append".
6. **Judges advise, ledgers decide.** The ideation judge disagreed with the lane's
   plan on 5 of 13 entries (e.g. markov-chain-table as softjoint vs formula); the
   disagreements were recorded (seq 4/5) and the plan stood. Judge confidence is data,
   not authority — the ledger is the institution.

Net effect on "runs stop needing adjustments": the catalog→cell recipe the run
discovered (draft → pure-evaluator gate → parameterize-or-tombstone → replay from
`drafted` with §5a records re-applied → mine) is itself compiled into
`scripts/dogfood-catalog.mjs`; the next catalog run starts from the fixed cells.
