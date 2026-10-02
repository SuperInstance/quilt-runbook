// src/rewind.js — resume a run from a stable point without rewriting history.
//
// The principal's directive, operationalized: "runs can be rewound to stable
// point and states adjusted along the way".  A rewind here is NOT a deletion:
//
//   * the ledger (run.jsonl) is append-only and is never touched;
//   * resumeFrom() re-materializes the state as of the chosen stable point
//     (verifying the §5c state_hash over the snapshot bytes — a mismatch is a
//      HARD error naming the seq), then appends a `resumed-from` marker step;
//   * the caller keeps using the SAME run handle/run_id; everything after the
//     marker is the new branch. The old branch remains readable forever, so
//     the WHY of the rewind is always reconstructible.
//
// Honesty details:
//   * if state.json had drifted past the last snapshot, the drifted bytes are
//     preserved as snapshots/superseded-at-<marker_seq>.json (never delete data).
//   * snapshots are read from inside the run dir only; path escapes are rejected.
//   * CUSTODY GATE (L10, lane 68-b): a run sealed by src/seal.js (run.seal.json
//     + run.chain.jsonl sidecar) is verified through the FULL custody courtroom
//     BEFORE anything materializes; and the sealed boundary is the custody
//     floor — resuming from a stablepoint that PRECEDES it refuses with
//     REWIND_PAST_CUSTODY naming the checkpoint (the organ rewind.mjs
//     resolveTarget law, mirrored: rewind below the custody floor is refused).
//     Resuming AT the boundary step is the legal case — that is the signed
//     state itself. Pass the verifier key as opts.key (an HMAC seal cannot
//     verify without it — fail-closed, CHECKPOINT_SIGNATURE_REQUIRED).

import fs from 'node:fs';
import path from 'node:path';
import { stateHash } from './canonical.js';
import { loadRun, Run } from './run.js';
import { verifyRunCustody, sealFileFor, chainFileFor } from './seal.js';

function isStr(v) { return typeof v === 'string' && v.length > 0; }

/**
 * resumeFrom(runDir, seqOrLabel) -> Run (continuing the same run_id).
 *
 *   seqOrLabel: number — the seq of a `stablepoint` step
 *               string — the label of a stable point (LAST match wins; labels
 *                        are developer-facing names, the seq is the hard ref)
 *
 * resumeFrom(runDir, seqOrLabel, opts)
 *   opts: { key } — the custody verifier key; REQUIRED (fail-closed) when the
 *          run carries a seal (run.seal.json)
 *
 * Throws (HARD, before anything is appended) on:
 *   NO_SUCH_RUN / RUN_LEDGER_TAMPER (chain verify fails, names the seq)
 *   CUSTODY_SEAL_MISSING     — a chain sidecar exists but its seal doc is gone
 *   CHECKPOINT_* / CHAIN_* / SEAL_* — the custody courtroom threw (src/seal.js:
 *                              wrong/missing key, tampered sidecar, forged
 *                              anchor, snapshot drift under the seal)
 *   REWIND_PAST_CUSTODY     — the requested stablepoint PRECEDES the sealed
 *                              boundary (organ rewind law, mirrored; names the
 *                              checkpoint boundary + manifestHash)
 *   NO_SUCH_STABLEPOINT  — ref matches nothing, or matches a non-stablepoint step
 *   SNAPSHOT_MISSING     — the §5c snapshot file is gone
 *   STABLEPOINT_HASH_MISMATCH — snapshot bytes no longer hash to state_hash
 *                               (names the stable point's seq — never resume on
 *                                a corrupted snapshot)
 */
export function resumeFrom(runDir, seqOrLabel, opts = {}) {
  const { steps, runId } = loadRun(runDir); // hard error on tamper, names seq
  if (steps.length === 0) throw noSuch('NO_SUCH_RUN', 'run.jsonl has no steps', null);

  // -- custody gate FIRST (L10): the courtroom before anything moves ---------
  // A sealed run must prove custody before a resume touches state. An unsealed
  // run (no seal doc, no sidecar) resumes exactly as before — the gate is
  // additive and only exists where custody was claimed.
  let custody = null;
  if (fs.existsSync(sealFileFor(runDir))) {
    custody = verifyRunCustody(runDir, { key: opts.key }); // throws organ codes
  } else if (fs.existsSync(chainFileFor(runDir))) {
    // a sidecar without its seal document: the signature half of custody is
    // missing — either deleted (suspicious) or a crashed mint (re-run sealRun)
    throw noSuch('CUSTODY_SEAL_MISSING',
      `run ${runId} carries a chain sidecar but no run.seal.json — the signature half of custody is missing; re-mint with sealRun() or restore the seal document`, null);
  }

  // -- find the stable point ------------------------------------------------
  let sp = null;
  if (typeof seqOrLabel === 'number' && Number.isInteger(seqOrLabel)) {
    const s = steps.find((x) => x.seq === seqOrLabel);
    if (!s) throw noSuch('NO_SUCH_STABLEPOINT', `no step has seq ${seqOrLabel}`, null);
    if (s.op !== 'stablepoint') {
      throw noSuch('NO_SUCH_STABLEPOINT', `seq ${seqOrLabel} is op "${s.op}", not a stablepoint`, seqOrLabel);
    }
    sp = s;
  } else if (isStr(seqOrLabel)) {
    for (const s of steps) {
      if (s.op === 'stablepoint' && s.payload.label === seqOrLabel) sp = s; // last match
    }
    if (!sp) throw noSuch('NO_SUCH_STABLEPOINT', `no stablepoint labeled "${seqOrLabel}"`, null);
  } else {
    throw noSuch('NO_SUCH_STABLEPOINT', 'ref must be an integer seq or a label string', null);
  }

  // -- the custody floor (organ rewind.mjs resolveTarget, mirrored) ----------
  // resolveTarget refuses toSeq < court.genesisSeq with REWIND_PAST_CUSTODY
  // "naming the checkpoint"; here the floor is the sealed boundary STEP seq:
  // resuming from inside signed history would fork the live line below the
  // anchor the keyholder vouched for. Resuming AT the boundary is the legal
  // case — the signed state itself (the organ seed equivalent).
  if (custody && sp.seq < custody.sealedThroughSeq) {
    const err = noSuch('REWIND_PAST_CUSTODY',
      `stablepoint seq ${sp.seq} (label "${sp.payload.label}") precedes the sealed boundary ` +
      `(steps 1..${custody.sealedThroughSeq} are signed custody, checkpoint manifestHash ` +
      `${custody.manifestHash}) — the sealed prefix is the custody floor: resume at the ` +
      `boundary stablepoint or after, or mint a superseding seal to re-open the run's line`, sp.seq);
    err.manifestHash = custody.manifestHash;
    err.boundarySeq = custody.sealedThroughSeq;
    throw err;
  }

  // -- verify the snapshot against the recorded §5c hash ---------------------
  const snapRel = sp.payload.snapshot;
  const snapAbs = path.resolve(runDir, snapRel);
  if (!snapAbs.startsWith(path.resolve(runDir) + path.sep)) {
    throw noSuch('SNAPSHOT_MISSING', `snapshot path escapes the run dir: ${snapRel}`, sp.seq);
  }
  if (!fs.existsSync(snapAbs)) {
    throw noSuch('SNAPSHOT_MISSING', `stablepoint seq ${sp.seq} snapshot file missing: ${snapRel}`, sp.seq);
  }
  const bytes = fs.readFileSync(snapAbs);
  const actual = stateHash(bytes);
  if (actual !== sp.payload.state_hash) {
    const err = new Error(
      `STABLEPOINT_HASH_MISMATCH at seq ${sp.seq} (label "${sp.payload.label}"): ` +
      `recorded ${sp.payload.state_hash} but snapshot bytes hash to ${actual} — ` +
      `the snapshot was corrupted or swapped after the stable point was taken`
    );
    err.code = 'STABLEPOINT_HASH_MISMATCH';
    err.seq = sp.seq;
    throw err;
  }

  // -- continue the same run: append the resumed-from marker ------------------
  // (openRun-style reload: everything verified, nextSeq = steps.length + 1)
  const resumed = openVerified(runDir, steps, runId);

  // preserve any drift between the last snapshot and now (never delete data)
  const stateFile = path.join(runDir, 'state.json');
  let superseded = null;
  if (fs.existsSync(stateFile)) {
    const currentBytes = fs.readFileSync(stateFile);
    if (currentBytes.toString('utf8') !== bytes.toString('utf8')) {
      const markerSeq = resumed.nextSeq;
      superseded = path.join('snapshots', `superseded-at-${String(markerSeq).padStart(4, '0')}.json`);
      fs.writeFileSync(path.join(runDir, superseded), currentBytes);
    }
  }

  // re-materialize state as of the stable point (byte-exact)
  fs.writeFileSync(stateFile, bytes);

  const payload = {
    from_seq: sp.seq,
    from_label: sp.payload.label,
    state_hash: sp.payload.state_hash,
    snapshot: snapRel,
    note: `run resumed from stable point "${sp.payload.label}" (seq ${sp.seq}); ` +
          `history untouched, this marker starts the new branch`,
  };
  if (superseded) payload.superseded_snapshot = superseded;
  const res = resumed.append('resumed-from', payload);
  if (!res.ok) throw new Error(`resumed-from marker rejected: ${res.problems.join('; ')}`);
  resumed.resumedFrom = { seq: sp.seq, label: sp.payload.label, state_hash: sp.payload.state_hash };
  return resumed;
}

function noSuch(code, msg, seq) {
  const err = new Error(`${code}: ${msg}`);
  err.code = code;
  if (seq !== null) err.seq = seq;
  return err;
}

/** Build a Run handle over an already-verified steps array (no re-verify). */
function openVerified(runDir, steps, runId) {
  // run.js does not import rewind.js, so this static import is acyclic:
  // the dependency is one-way (rewind -> run).
  const runsRoot = path.dirname(runDir);
  return new Run({ runsRoot, runId, dir: runDir, existing: { steps } });
}
