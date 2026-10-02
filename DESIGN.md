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
  (Update, lane 68-b: the custody half of that sentence is now closed from OUR side
  too — `src/seal.js` mints organ-EXACT signed checkpoints over the run chain; see §5.)
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

## §5. Signed run custody — the seal (lane 68-b)

The wave-67 hand-off claimed: "the same seal pattern maps 1:1 onto quilt-runbook's
jsonl ledger" (67-a Stage Summary). The claim was verified against the actual code
before being believed, per house law — and it is TRUE at the two layers that matter
and needed TWO CORRECTIONS at the layers where the substrates differ. The pattern's
home is `quilt-chrono/src/seal.js` (67-a); both build on organ protocol v2
(`quilt-jev-toolkit/src/organ/{manifest,boot,checkpoint}.mjs`, spec §8).

**What carried over 1:1 (verified, not assumed):**
- The sidecar link IS an organ receipt: `{seq, op: <entry verbatim>, prev, hash}`,
  `hash = sha256(canonicalJson({seq, op, prev}))`, anchored at `GENESIS` — so the
  organ toolkit's `verifyChain`/`receiptHash` verify a runbook sidecar unmodified
  (proven in-suite against the real sibling code).
- The seal document is BYTE-EXACTLY a `quilt.organ.checkpoint` v1:
  `sig = HMAC-SHA256(key, canonical({hash, manifestHash, seq}))` — the
  `checkpointSigningPayload` bytes of organ `boot.mjs`. No runbook-specific fields
  (drift is how parallel standards start). The organ's own `verifySignedCheckpoint`
  and `validateManifest` accept run seals and reject forgeries (tested).
- The append-only sidecar discipline: byte-prefix check, `CHAIN_REWRITE_REFUSED`,
  never extend a broken chain, create-only first write, the ledger file never
  opened for writing.
- Tamper detection at EVERY offset (tested link-by-link, plus raw-byte flips and
  prev-breaks), the anchor law for self-consistent re-hashed forgeries
  (`CHECKPOINT_ANCHOR_MISMATCH`), and post-seal growth with old seals still holding
  at their boundaries.

**Correction 1 — the seq base (forced by organ law, named the SEQ-BASE LAW).**
Runbook steps are 1-BASED (L1); organ receipt chains start at seq 0 anchored at
`GENESIS`, and organ `validateManifest` refuses a manifest whose
`receiptRange.start !== 0` at seq 0 (`boot.mjs` §4d likewise pins the anchor's
start to 0). So the sidecar link's `seq` is the 0-based LEDGER INDEX and the
step's own 1-based seq rides verbatim inside `op`: `link.seq = step.seq - 1`,
`cp.seq` is the link index, and the runbook-facing boundary is
`sealedThroughSeq = cp.seq + 1`. The alternative (1-based links) would force
`genesis.prevHash` to be a hex hash at seq 1 — a DIFFERENT manifest dialect, i.e.
exactly the drift this lane exists to avoid.

**Correction 2 — the anchored state model.** Chrono folds WRITES from its entries
(cells are what a chrono ledger proves). A runbook ledger's steps are
attempts/observes/adjusts — no cell writes to fold. What a bare run.jsonl PROVES
at any boundary is its §5c stablepoint ANCHORS: each stablepoint step pins snapshot
bytes by `state_hash` (L5). So the seal manifest's cells are the anchored
stablepoints (`stablepoint/<seq>` → `{seq, label, state_hash, snapshot}`, kind
`value`), and the courtroom's runbook-specific witness is SNAPSHOT RE-DERIVATION:
every anchored stablepoint's snapshot bytes must re-hash to its §5c `state_hash`
(`STABLEPOINT_HASH_MISMATCH`/`SNAPSHOT_MISSING`, naming the seq — rewind's own L5
codes, applied to the signed prefix). A prefix with no stablepoints anchors nothing
and refuses to seal (`SEAL_EMPTY_LEDGER`). The chained step's own L2 `id` is
re-verified inside the courtroom (via `run.js stepId`, now exported — one hash
formula, one place), so even a minter who skips the loadRun courtroom cannot sign
steps that were never in a valid ledger.

**The custody floor (the rewind law, mirrored).** Organ `rewind.mjs`
`resolveTarget` refuses `toSeq < court.genesisSeq` with `REWIND_PAST_CUSTODY`,
"naming the checkpoint" — rewind below the custody floor is impossible. The
runbook mirror: `resumeFrom` on a sealed run (a) runs the FULL courtroom BEFORE
anything materializes (custody gate first, then stablepoint lookup), and (b)
refuses a stablepoint whose seq PRECEDES the sealed boundary (`sp.seq <
sealedThroughSeq`) with `REWIND_PAST_CUSTODY` carrying `boundarySeq` and
`manifestHash`. Resuming AT the boundary stablepoint is the legal case — that is
the signed state itself (the organ seed equivalent). Honest scope: the floor is a
POLICY guard, not an integrity requirement — the chain catches byte tampering
either way; what the floor protects is the SEMANTICS of a hand-off (the seal
asserts "the state at the boundary is the vouched line"; silently forking the live
line from inside signed history would contradict the finality the recipient relies
on). The escape hatch is an explicit, receipted act: mint a superseding seal at an
earlier boundary (`sealRun(dir, {key, seq})` — `supersedes` lineage and `organId`
carry are automatic) and resume at THAT anchor. This was proven on the real
committed dogfood ledger (54 steps, 3 stablepoints) in a temp copy: tip seal →
pre-floor resume refused → superseding seal at the `replayed-and-fixed` boundary →
resume succeeds. `runs/` itself stays unsealed: sealing is for live/handed-off
runs, and a committed seal with a committed key would be custody theater.

**Alternatives considered (the ideation pass for this slice):**

- **In-band chaining** (append `prev`/`hash` columns to the step records
  themselves): rejected — it rewrites the sealed step schema (§5a/§5c are
  interop contract shapes, L4), breaks byte-compatibility with every existing
  ledger, and makes the ledger unusable without the hasher. The sidecar keeps the
  original bytes sovereign (same verdict as chrono 67-a, re-derived here).
- **A runbook-native seal format** (own document carrying `run_id`/`at_seq`):
  rejected — a parallel standard where a shared one exists. The organ checkpoint
  shape fits once the seq base and the cell model are corrected; interop with the
  fleet's custody layer is the point of the exercise.
- **Runtime cross-repo import of the organ code** (`import
  '../quilt-jev-toolkit/src/organ/boot.mjs'`): rejected — breaks stdlib-only
  standalone use and couples repos at runtime. The formats match, no code is
  imported; equivalence is a TEST (skip-if-absent interop suite) instead of a
  claim — the 67-a design law, consumed here.
- **Allow pre-boundary resumes** (the snapshots inside the signed prefix ARE
  signature-anchored, so custody there is STRONGER than post-boundary): seriously
  considered — rejected. The hand-off seal is a finality assertion, not just a
  tamper flag; an in-place fork below the anchor would make the recipient's
  provenance claim quietly false. The superseding-seal re-open keeps every such
  fork signed and lineage-recorded. Honest cost, receipted: the classic mid-run
  rewind on a sealed run needs one re-seal first (cheap, automatic lineage).
- **`canonicalJSON` from `src/canonical.js` for signature bytes**: rejected — it
  forgives (skips undefined object fields, stringifies `NaN` as `null`) where the
  organ canonicalizer throws, and a signature must never forgive. Both agree on
  every JSON-safe value (tested), so ledger hashes and custody hashes never
  disagree in practice; the organ-exact `canonicalJson` lives in `seal.js` with
  the divergence documented in its header.

**Parked (honest scope):** partial-custody hand-off (carry only the sealed prefix
+ seed + checkpoint — the organ `carvePartialCustody` analog for giant runs);
custody for the derived streams (`adjustments.jsonl`, `compilations.jsonl` — they
mirror ledger steps and inherit their integrity transitively); Ed25519 (organ v3:
"who vouches" instead of "keyholder vouches", zero format drift); O(tail) chain
booting from the sealed anchor. All format-compatible with what shipped.
