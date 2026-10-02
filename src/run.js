// src/run.js — the Run object: an append-only ledger of a play-test.
//
// A run is a directory  runs/<run_id>/  containing:
//   run.jsonl      one JSON step per line, APPEND-ONLY, hash-chained
//   state.json     the run's current mutable working state (strategy config etc.)
//   snapshots/     immutable byte-copies of state.json taken at stable points
//
// THE LAWS (each enforced below, each tested in tests/run.test.mjs):
//   L1 APPEND-ONLY: steps are only ever appended; seq is 1-based and contiguous;
//      nothing is ever rewritten or deleted (corrections are new steps).
//   L2 HASH LAW: every step carries prev (previous step's id, or
//      sha256:genesis:<run_id> for seq 1) and id = sha256 over
//      "<run_id>|<seq>|<prev>|canonicalJSON(body)". Tampering with any line is
//      detected by loadRun/openRun and is a HARD error naming the seq.
//   L3 FAIL-CLOSED: nothing is silently dropped. If a step's payload is invalid
//      the append() call does NOT throw-and-skip; it records an `error` step
//      describing the problem (and the offending payload), then returns it.
//   L4 CONTRACT SHAPES: `stablepoint` steps carry the wave-66 §5c record exactly;
//      `adjust` steps carry the wave-66 §5a record exactly (as the payload).
//      These are the interop contract with lanes 66-a / 66-e — field names are law.
//   L5 STATE HASHES ARE OVER BYTES: state_hash = sha256 of the exact state.json
//      bytes at the moment of the stable point, and the snapshot is a byte-copy.
//   L6 STALE-HANDLE GUARD: a Run handle tracks the ledger file's size; if the file
//      grew since this handle last saw it (e.g. another handle — like the one
//      resumeFrom() returns — appended), append() fails closed with STALE_HANDLE
//      instead of writing a duplicate seq. Found by the dogfood run itself.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJSON, sha256Hex, sha256Id, stateHash } from './canonical.js';

export const OPS = ['attempt', 'observe', 'stablepoint', 'adjust', 'note', 'error', 'resumed-from'];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA = /^sha256:[0-9a-f]{64}$/;

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------------------------------------------------------------------------
// validation — each returns a list of problems ([] == valid).
// fail-closed means: validate BEFORE append; invalid payloads become error steps.
// ---------------------------------------------------------------------------

const VALIDATORS = {
  attempt(p) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (!isStr(p.what)) problems.push('payload.what must be a non-empty string (what was tried)');
    return problems;
  },
  observe(p) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (!isStr(p.outcome)) problems.push('payload.outcome must be a non-empty string');
    if (p.verdict !== undefined && !['pass', 'fail', 'mixed', 'unknown'].includes(p.verdict)) {
      problems.push('payload.verdict (if present) must be pass|fail|mixed|unknown');
    }
    if (p.of_seq !== undefined && !Number.isInteger(p.of_seq)) problems.push('payload.of_seq must be an integer seq');
    return problems;
  },
  note(p) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (!isStr(p.text)) problems.push('payload.text must be a non-empty string');
    return problems;
  },
  error(p) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (!isStr(p.code)) problems.push('payload.code must be a non-empty string');
    return problems;
  },

  // §5c stable-point record — EXACT shape, field names are the interop contract.
  stablepoint(p, ctx) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (p.kind !== 'stablepoint') problems.push('payload.kind must be "stablepoint" (§5c)');
    if (p.run_id !== ctx.runId) problems.push('payload.run_id must match the run');
    if (p.seq !== ctx.seq) problems.push('payload.seq must equal the step seq');
    if (!isStr(p.ts_utc) || !ISO.test(p.ts_utc)) problems.push('payload.ts_utc must be ISO-8601 UTC');
    if (!isStr(p.label)) problems.push('payload.label must be a non-empty string');
    if (!isStr(p.state_hash) || !SHA.test(p.state_hash)) problems.push('payload.state_hash must be "sha256:<64hex>"');
    if (!isStr(p.snapshot)) problems.push('payload.snapshot must be a relative path string');
    if (!isStr(p.note)) problems.push('payload.note must be a string (why this is a stable point)');
    return problems;
  },

  // §5a adjustment record — EXACT shape, field names are the interop contract.
  adjust(p, ctx) {
    const problems = [];
    if (!isObj(p)) return ['payload must be an object'];
    if (p.kind !== 'adjustment') problems.push('payload.kind must be "adjustment" (§5a)');
    if (p.run_id !== ctx.runId) problems.push('payload.run_id must match the run');
    if (p.at_seq !== ctx.seq) problems.push('payload.at_seq must equal the step seq');
    if (!isStr(p.ts_utc) || !ISO.test(p.ts_utc)) problems.push('payload.ts_utc must be ISO-8601 UTC');
    if (!isObj(p.target)) problems.push('payload.target must be an object');
    else {
      if (!isStr(p.target.cell_id)) problems.push('payload.target.cell_id must be a non-empty string');
      if (!isStr(p.target.sheet)) problems.push('payload.target.sheet must be a non-empty string');
    }
    if (!('before' in p)) problems.push('payload.before is required (may be null)');
    if (!('after' in p)) problems.push('payload.after is required (may be null)');
    if (!isObj(p.why)) problems.push('payload.why must be an object');
    else {
      if (!isStr(p.why.trigger)) problems.push('payload.why.trigger must be a non-empty string (the symptom)');
      if (!isStr(p.why.hypothesis)) problems.push('payload.why.hypothesis must be a non-empty string (root-cause guess)');
      if (!Array.isArray(p.why.evidence)) problems.push('payload.why.evidence must be an array of refs');
    }
    if (typeof p.generalizes !== 'boolean') problems.push('payload.generalizes must be a boolean');
    if (p.compiled_cell !== null && !isObj(p.compiled_cell)) {
      problems.push('payload.compiled_cell must be null at write time (compiler fills it later) or a §5a cell object');
    }
    if (isObj(p.compiled_cell)) {
      if (!isStr(p.compiled_cell.id)) problems.push('payload.compiled_cell.id must be a non-empty string');
      if (!['formula', 'lookup', 'router', 'listener', 'softjoint'].includes(p.compiled_cell.kind)) {
        problems.push('payload.compiled_cell.kind must be formula|lookup|router|listener|softjoint');
      }
      if (!isObj(p.compiled_cell.sheet_fragment)) problems.push('payload.compiled_cell.sheet_fragment must be an object');
      if (!isStr(p.compiled_cell.rationale)) problems.push('payload.compiled_cell.rationale must be a non-empty string');
    }
    return problems;
  },
};

// ---------------------------------------------------------------------------
// ledger io
// ---------------------------------------------------------------------------

/** Step id over the canonical body. The body is everything except prev/id. */
function stepId(runId, step) {
  const body = { seq: step.seq, ts_utc: step.ts_utc, op: step.op, run_id: step.run_id };
  if ('payload' in step) body.payload = step.payload;
  if ('receipt' in step) body.receipt = step.receipt;
  return sha256Id(`${runId}|${step.seq}|${step.prev}|${canonicalJSON(body)}`);
}

/** Read + verify a run.jsonl. Returns {steps}. Throws on any tamper (names seq). */
export function loadRun(runDir) {
  const file = path.join(runDir, 'run.jsonl');
  if (!fs.existsSync(file)) return { steps: [] };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const steps = [];
  let prev = null;
  let runId = null;
  for (let i = 0; i < lines.length; i++) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch (e) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${i + 1}: line is not valid JSON (${e.message})`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = i + 1;
      throw err;
    }
    if (step.seq !== i + 1) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${i + 1}: expected contiguous seq ${i + 1}, found ${step.seq}`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = i + 1;
      throw err;
    }
    if (runId === null) runId = step.run_id;
    if (typeof step.run_id !== 'string' || step.run_id.length === 0) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${step.seq}: step has no run_id`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = step.seq;
      throw err;
    }
    if (step.run_id !== runId) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${step.seq}: run_id mismatch inside one ledger`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = step.seq;
      throw err;
    }
    const expectedPrev = prev === null ? sha256Id(`genesis:${runId}`) : prev;
    if (step.prev !== expectedPrev) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${step.seq}: prev does not chain (expected ${expectedPrev.slice(0, 19)}…, found ${String(step.prev).slice(0, 19)}…)`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = step.seq;
      throw err;
    }
    const expectId = stepId(runId, step);
    if (step.id !== expectId) {
      const err = new Error(`RUN_LEDGER_TAMPER at seq ${step.seq}: step id does not match its content (ledger line was edited)`);
      err.code = 'RUN_LEDGER_TAMPER';
      err.seq = step.seq;
      throw err;
    }
    prev = step.id;
    steps.push(step);
  }
  return { steps, runId };
}

// ---------------------------------------------------------------------------
// the Run handle
// ---------------------------------------------------------------------------

export class Run {
  constructor({ runsRoot, runId, dir, existing }) {
    this.runsRoot = runsRoot;
    this.runId = runId;
    this.dir = dir;
    this._steps = existing ? [...existing.steps] : [];
    this.resumedFrom = null; // set by resumeFrom() (src/rewind.js)
    this._fileBytes = 0;     // L6 stale-handle guard: last-seen size of run.jsonl
    try { this._fileBytes = fs.statSync(path.join(dir, 'run.jsonl')).size; } catch { /* new run */ }
  }

  /** Verified in-memory view of the ledger so far. */
  steps(op) {
    return op ? this._steps.filter((s) => s.op === op) : [...this._steps];
  }

  step(seq) {
    return this._steps.find((s) => s.seq === seq) ?? null;
  }

  get nextSeq() {
    return this._steps.length + 1;
  }

  /** Current working state (parsed state.json) or null if never set. */
  state() {
    const f = path.join(this.dir, 'state.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  /** Raw bytes of state.json (state hashes are over bytes). */
  stateBytes() {
    const f = path.join(this.dir, 'state.json');
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  }

  /**
   * Replace the working state. This is the ONLY mutable file in a run; the
   * ledger records every intentional change as an `adjust` step (§5a) so the
   * WHY of every state change is decomposed.
   */
  setState(obj) {
    if (!isObj(obj)) throw new Error('setState requires a plain object');
    const bytes = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(this.dir, 'state.json'), bytes);
    return stateHash(bytes);
  }

  /**
   * THE append primitive. Validates first (fail-closed, L3): an invalid payload
   * is recorded as an `error` step (never skipped, never thrown away) and the
   * error step is returned. Receipts ride on the step they belong to.
   *
   * opts: { receipt } — external-call receipt (channel/model/usage tokens).
   */
  append(op, payload, opts = {}) {
    if (!OPS.includes(op)) {
      // Unknown op names are a programming error, but even this is recorded
      // rather than dropped (L3), then thrown so the caller sees it.
      const rec = this._recordError('UNKNOWN_OP', op, [`op must be one of ${OPS.join('|')}`], { op_requested: String(op) });
      const err = new Error(`UNKNOWN_OP: "${op}" — recorded as error step seq ${rec.step.seq}`);
      err.step = rec.step;
      throw err;
    }

    const step = this._makeStep(op, payload, opts.receipt);
    const problems = (VALIDATORS[op] ?? (() => []))(step.payload, { runId: this.runId, seq: step.seq });

    if (problems.length > 0) {
      // L3: nothing silently dropped — the invalid payload itself gets a step.
      const rec = this._recordError('INVALID_PAYLOAD', op, problems, { received: payload });
      return { ok: false, problems, step: rec.step };
    }

    this._push(step);
    return { ok: true, step };
  }

  // ---- op sugar (all route through append, all obey L3) ---------------------

  attempt(payload, opts) { return this.append('attempt', payload, opts); }
  observe(payload, opts) { return this.append('observe', payload, opts); }
  note(payload, opts) { return this.append('note', payload, opts); }
  error(payload, opts) { return this.append('error', payload, opts); }

  /**
   * §5c stable point: hash the CURRENT state.json bytes, snapshot them
   * immutably, append the stablepoint step. Throws only on IO failure or if
   * there is no state to stabilize (an empty state is recorded as {} — use
   * setState first if the state matters).
   */
  stablepoint(label, { note = '' } = {}) {
    if (!isStr(label)) throw new Error('stablepoint requires a non-empty label');
    const bytes = this.stateBytes() ?? Buffer.from(JSON.stringify({}, null, 2) + '\n', 'utf8');
    const hash = stateHash(bytes);
    const seq = this.nextSeq;
    const snapRel = path.join('snapshots', `${String(seq).padStart(4, '0')}-${slug(label)}.json`);
    const snapAbs = path.join(this.dir, snapRel);
    fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
    // never overwrite an existing snapshot — snapshots are immutable
    if (fs.existsSync(snapAbs)) throw new Error(`SNAPSHOT_EXISTS: ${snapRel} already exists (snapshots are immutable)`);
    fs.writeFileSync(snapAbs, bytes);
    const ts = nowIso();
    const payload = {
      kind: 'stablepoint',     // §5c exact shape
      run_id: this.runId,
      seq,
      ts_utc: ts,
      label,
      state_hash: hash,
      snapshot: snapRel,
      note,
    };
    const res = this.append('stablepoint', payload);
    if (!res.ok) throw new Error(`stablepoint rejected its own record: ${res.problems.join('; ')}`);
    return res.step;
  }

  /**
   * §5a adjustment record. `rec` is the caller-supplied part:
   *   { target:{cell_id,sheet}, before, after,
   *     why:{trigger,hypothesis,evidence:[]}, generalizes, compiled_cell? }
   * kind/run_id/at_seq/ts_utc are filled here (they are runbook facts).
   * compiled_cell defaults to null — the adjustment→cell compiler fills it later.
   * Also writes the record to adjustments.jsonl (the §5a lane-facing stream,
   * append-only, one record per line) so lane 66-a's compiler can consume runs
   * without parsing the full ledger.
   */
  adjust(rec, opts = {}) {
    const seq = this.nextSeq;
    const ts = nowIso();
    const payload = {
      kind: 'adjustment',
      run_id: this.runId,
      at_seq: seq,
      ts_utc: ts,
      target: rec?.target,
      before: rec?.before,
      after: rec?.after,
      why: rec?.why,
      generalizes: rec?.generalizes,
      compiled_cell: rec?.compiled_cell ?? null,
    };
    const res = this.append('adjust', payload, opts);
    if (res.ok) {
      // §5a stream for the compiler lane. Append-only; mirrors the ledger.
      fs.appendFileSync(path.join(this.dir, 'adjustments.jsonl'), canonicalJSON(payload) + '\n');
    }
    return res;
  }

  // ---- internals ------------------------------------------------------------

  _makeStep(op, payload, receipt) {
    const seq = this._steps.length + 1;
    const prev = this._steps.length === 0 ? sha256Id(`genesis:${this.runId}`) : this._steps[this._steps.length - 1].id;
    const step = { seq, ts_utc: nowIso(), op, payload };
    if (receipt !== undefined) step.receipt = receipt;
    step.run_id = this.runId; // self-describing lines; also hashed into id
    step.prev = prev;
    step.id = stepId(this.runId, step);
    return step;
  }

  _push(step) {
    const file = path.join(this.dir, 'run.jsonl');
    // L6: the file must be exactly where THIS handle left it. If anything else
    // appended since (another handle, another process), refuse to write — a
    // duplicate seq would be ledger corruption, and corruption is never skipped.
    let cur = 0;
    try { cur = fs.statSync(file).size; } catch { /* no file yet */ }
    if (cur !== this._fileBytes) {
      const err = new Error(
        `STALE_HANDLE at would-be seq ${step.seq}: run.jsonl is ${cur} bytes but this handle last saw ` +
        `${this._fileBytes} — another handle appended (did you keep using a pre-rewind handle after ` +
        `resumeFrom(), or open the same run twice?). Nothing was written; reopen the run and continue ` +
        `from the fresh handle.`
      );
      err.code = 'STALE_HANDLE';
      err.seq = step.seq;
      throw err;
    }
    fs.appendFileSync(file, canonicalJSON(step) + '\n');
    this._fileBytes = fs.statSync(file).size;
    this._steps.push(step);
  }

  _recordError(code, opRequested, problems, extra = {}) {
    const payload = { code, op_requested: opRequested, problems, ...extra };
    const step = this._makeStep('error', payload);
    this._push(step);
    return { step };
  }
}

/** Create a brand-new run directory with a genesis step. */
export function createRun({ runsRoot, runId, meta } = {}) {
  if (!runsRoot) throw new Error('createRun requires runsRoot');
  runId = runId ?? new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').slice(0, 15) + '-' + Math.random().toString(36).slice(2, 6);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('runId must match [A-Za-z0-9._-] (it is a directory name)');
  const dir = path.join(runsRoot, runId);
  if (fs.existsSync(dir)) throw new Error(`RUN_EXISTS: ${dir}`);
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const run = new Run({ runsRoot, runId, dir, existing: null });
  run.note({ text: 'run genesis', meta: meta ?? {} });
  return run;
}

/** Open an existing run, verifying the full chain first (L2). */
export function openRun(runsRoot, runId) {
  const dir = path.join(runsRoot, runId);
  if (!fs.existsSync(path.join(dir, 'run.jsonl'))) throw new Error(`NO_SUCH_RUN: ${dir}`);
  const { steps } = loadRun(dir);
  const run = new Run({ runsRoot, runId, dir, existing: { steps } });
  return run;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'point';
}
