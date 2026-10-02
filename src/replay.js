// src/replay.js — deterministic re-execution of a run's recorded steps,
// from a chosen stable point, with a state-adjustment applied first — so a
// FIXED strategy can be re-tested cheaply, without re-running the world.
//
// THE REPLAY STEP CONTRACT (small and honest, see docs/replay-contract.md):
//
//   A step is replayable iff its payload carries:
//     replayable: true
//     fn:         a name in the registry passed to replayRun()
//     args:       an array of recorded inputs
//     returns:    the output recorded during the original run, where
//                 returns === fn(args, state) for the state AT THAT MOMENT.
//
//   Registry functions MUST be pure: same (args, state) -> same returns.
//   No clock, no randomness, no IO, no network. Anything that touched an
//   external system (model calls, fetches, human judgement) is recorded as an
//   observe/attempt step WITHOUT replayable:true — its recorded outcome is
//   DATA replay can read, never something replay re-executes.
//
// WHAT REPLAY CAN REPRODUCE: the deterministic skeleton of the run — pure
// cell evaluations, lookups, formulas — under a modified state.
// WHAT IT CANNOT: model behaviour, latency, external side effects, and any
// step whose fn is missing from the provided registry (those are reported as
// `skipped` with a reason, never silently ignored).

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJSON, stateHash } from './canonical.js';
import { loadRun } from './run.js';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepEqual(a, b) {
  return canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
}

/** set/get dotted paths into the replay state (adjustment targets). */
function getPath(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/**
 * Replay a run deterministically.
 *
 *   runDir       the run directory (ledger is chain-verified first)
 *   opts.from    'genesis' | stablepoint seq | stablepoint label
 *                (default 'genesis'). A bare seq means "state as of the last
 *                stablepoint at or before that seq; steps after that seq".
 *   opts.adjustments
 *                array of {target:{cell_id,sheet}, before, after} — §5a shape.
 *                Applied to the re-materialized state BEFORE re-execution.
 *                `target.cell_id` is a dotted path into the state object.
 *                If `before` is non-null and the current value differs, the
 *                adjustment is NOT applied and its verdict says so honestly.
 *   opts.registry
 *                map of pure functions used by replayable steps.
 *
 * Returns a replay summary (see replayRun's `summary` doc below).
 */
export function replayRun(runDir, opts = {}) {
  const from = opts.from ?? 'genesis';
  const registry = opts.registry ?? {};
  const adjustments = opts.adjustments ?? [];

  const { steps, runId } = loadRun(runDir); // hard error on tamper, names seq

  // ---- resolve the start point ---------------------------------------------
  let startSeq = 0; // steps with seq > startSeq are (re)considered
  let state = {};
  if (from === 'genesis') {
    // genesis state: empty object — runs that need a richer genesis state
    // should take a stablepoint early and replay from it.
  } else {
    let sp = null;
    if (typeof from === 'number' && Number.isInteger(from)) {
      // last stablepoint at or before `from`
      for (const s of steps) {
        if (s.op === 'stablepoint' && s.seq <= from) sp = s;
      }
      startSeq = from;
      if (!sp && from > 0) {
        throw err('NO_STABLEPOINT_BEFORE_SEQ', `no stablepoint at or before seq ${from}`);
      }
    } else if (typeof from === 'string') {
      for (const s of steps) if (s.op === 'stablepoint' && s.payload.label === from) sp = s;
      if (!sp) throw err('NO_SUCH_STABLEPOINT', `no stablepoint labeled "${from}"`);
      startSeq = sp.seq;
    } else {
      throw err('BAD_FROM', 'opts.from must be "genesis", an integer seq, or a label');
    }
    const snapAbs = path.resolve(runDir, sp.payload.snapshot);
    if (!snapAbs.startsWith(path.resolve(runDir) + path.sep) || !fs.existsSync(snapAbs)) {
      throw err('SNAPSHOT_MISSING', `stablepoint seq ${sp.seq} snapshot missing`);
    }
    const bytes = fs.readFileSync(snapAbs);
    if (stateHash(bytes) !== sp.payload.state_hash) {
      const e = err('STABLEPOINT_HASH_MISMATCH', `stablepoint seq ${sp.seq} snapshot fails hash verify`);
      e.seq = sp.seq;
      throw e;
    }
    state = JSON.parse(bytes.toString('utf8'));
  }

  // ---- apply the state-adjustment(s) FIRST ----------------------------------
  const adjustmentVerdicts = adjustments.map((adj) => {
    const dotted = adj?.target?.cell_id;
    if (typeof dotted !== 'string' || dotted.length === 0) {
      return { target: adj?.target ?? null, applied: false, reason: 'adjustment.target.cell_id missing' };
    }
    const current = getPath(state, dotted);
    if (adj.before !== null && adj.before !== undefined) {
      if (!deepEqual(current, adj.before)) {
        return {
          target: adj.target, applied: false,
          reason: `precondition failed: state.${dotted} is ${canonicalJSON(current ?? null)}, expected before=${canonicalJSON(adj.before)}`,
        };
      }
    }
    setPath(state, dotted, structuredClone(adj.after));
    return { target: adj.target, applied: true, from_value: current ?? null, to_value: adj.after };
  });

  // ---- re-execute replayable steps after the start point --------------------
  const verdicts = [];
  const skipped = [];
  let passed = 0, failed = 0;

  for (const s of steps) {
    if (s.seq <= startSeq) continue;
    const p = s.payload;
    if (!isObj(p) || p.replayable !== true) continue; // contract: only marked steps
    if (typeof p.fn !== 'string' || !Array.isArray(p.args)) {
      skipped.push({ seq: s.seq, reason: 'marked replayable but fn/args missing' });
      continue;
    }
    const fn = registry[p.fn];
    if (typeof fn !== 'function') {
      skipped.push({ seq: s.seq, fn: p.fn, reason: `fn "${p.fn}" not in registry` });
      continue;
    }
    let actual;
    try {
      actual = fn(structuredClone(p.args), structuredClone(state));
    } catch (e) {
      actual = { __replay_threw__: String(e?.message ?? e) };
    }
    const pass = deepEqual(actual, p.returns);
    if (pass) passed++; else failed++;
    verdicts.push({ seq: s.seq, fn: p.fn, pass, expected: p.returns ?? null, actual: actual ?? null });
  }

  const summary = {
    run_id: runId,
    from: from === 'genesis' ? 'genesis' : { seq: startSeq },
    adjustments: adjustmentVerdicts,
    replayed: verdicts.length,
    passed,
    failed,
    skipped,
    state_after_adjustments: state,
    verdicts,
  };
  return summary;
}

function err(code, msg) {
  const e = new Error(`${code}: ${msg}`);
  e.code = code;
  return e;
}

/**
 * Helper used BY THE RUNNER while a run is in progress: evaluate a pure step
 * and record the shape the contract requires. Keeps the runner honest — the
 * recorded `returns` is whatever the function ACTUALLY returned at run time,
 * not what the runner hoped it would return.
 */
export function recordReplayable(fnName, args, fn, state) {
  return {
    replayable: true,
    fn: fnName,
    args: structuredClone(args ?? []),
    returns: fn(structuredClone(args ?? []), structuredClone(state ?? {})),
  };
}
