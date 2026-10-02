// src/mine.js — the WHY-decomposition miner: turn recurring manual adjustments
// into compiled-cell proposals so future runs "hit those paths natively instead
// of needing the same manual fix" (the principal's directive).
//
// What it does (deterministic, stdlib-only, no network):
//   1. load + verify a run ledger;
//   2. collect `adjust` steps (each payload IS a §5a adjustment record);
//   3. cluster them by (target, why.hypothesis keywords):
//        - group by normalized target  "<sheet>/<cell_id>";
//        - within a target, join two adjustments when their hypotheses share a
//          significant keyword (union-find over token overlap) — so "same cell,
//          same recurring reason" clusters even if phrased differently;
//   4. for clusters of >= minClusterSize adjustments that ALL generalize,
//      emit one `compiled_cell` proposal in the §5a record shape (the wrapper
//      is an adjustment record whose compiled_cell is filled in);
//   5. append proposals to runs/<run_id>/compilations.jsonl (append-only,
//      idempotent on re-mining: an existing proposal id is never duplicated).
//
// DIRECTION OF DATA FLOW (documented for quilt-softjoints, lane 66-a):
//   runbook  ->  compilations.jsonl  ->  quilt-softjoints/src/compiler.js
//   (this file EMITS §5a-shaped records; 66-a's compiler —
//   ../quilt-softjoints/src/compiler.js, compileAdjustments(sheet, adjustments,
//   {threshold}) — CONSUMES them and owns what gets instantiated into the sheet.
//   SAME §5a schema on both sides, so EITHER side may compile; the receipts
//   record who did. Conversely, 66-a's compiler may run its own mining over our
//   adjustments.jsonl streams — no coupling, one contract.)
//   This file never mutates the ledger and never instantiates cells itself.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJSON, sha256Id } from './canonical.js';
import { loadRun, nowIso } from './run.js';

// Small English stoplist — enough to keep hypothesis keywords meaningful
// without pretending to do real NLP. Deterministic by construction.
const STOP = new Set(('a an and are as at be because but by can cannot did do does for from had has have ' +
  'how in into is it its like may might must not of on or should so than that the then there these this ' +
  'thus to too was were what when which while who why will with without would').split(' '));

const MIN_TOKEN_LEN = 4;

/** Significant keywords of a hypothesis string: lowercase words, stoplisted. */
export function hypothesisKeywords(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w.length >= MIN_TOKEN_LEN && !STOP.has(w)) out.add(w);
  }
  return [...out].sort();
}

function targetKey(rec) {
  const sheet = rec?.target?.sheet ?? '';
  const cell = rec?.target?.cell_id ?? '';
  return `${sheet}/${cell}`;
}

/** Union-find over adjustments within one target group, joined by shared keywords. */
function clusterByKeywords(records) {
  const parent = records.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(i)] = find(j); };
  const kw = records.map((r) => new Set(hypothesisKeywords(r.payload.why?.hypothesis)));
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      for (const k of kw[i]) {
        if (kw[j].has(k)) { union(i, j); break; }
      }
    }
  }
  const out = new Map();
  for (let i = 0; i < records.length; i++) {
    const root = find(i);
    if (!out.has(root)) out.set(root, []);
    out.get(root).push(records[i]);
  }
  return [...out.values()];
}

/**
 * Mine one run.
 *   opts.minClusterSize  minimum generalizable adjustments per proposal (default 2)
 *   opts.outName         output file name inside the run dir (default compilations.jsonl)
 *
 * Returns { clusters, proposals, appended }.
 */
export function mineRun(runDir, opts = {}) {
  const minClusterSize = opts.minClusterSize ?? 2;
  const outName = opts.outName ?? 'compilations.jsonl';

  const { steps, runId } = loadRun(runDir); // verify chain first
  const adjusts = steps.filter((s) => s.op === 'adjust').map((s) => s);

  // ---- group by target -----------------------------------------------------
  const byTarget = new Map();
  for (const a of adjusts) {
    const k = targetKey(a.payload);
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(a);
  }

  // ---- cluster within target, keep qualifying clusters ----------------------
  const clusters = [];
  for (const [key, recs] of byTarget) {
    for (const group of clusterByKeywords(recs)) {
      const generalizing = group.filter((a) => a.payload.generalizes === true);
      if (generalizing.length >= minClusterSize) {
        clusters.push({ target: key, adjustments: generalizing });
      }
    }
  }
  clusters.sort((a, b) => a.adjustments[0].seq - b.adjustments[0].seq); // deterministic order

  // ---- build §5a-shaped proposals -------------------------------------------
  const proposals = clusters.map((c) => buildProposal(runId, c));
  const appended = appendProposals(path.join(runDir, outName), proposals);

  return { clusters, proposals, appended };
}

function buildProposal(runId, cluster) {
  const seqs = cluster.adjustments.map((a) => a.seq);
  const kwCount = new Map();
  for (const a of cluster.adjustments) {
    for (const k of hypothesisKeywords(a.payload.why?.hypothesis)) {
      kwCount.set(k, (kwCount.get(k) ?? 0) + 1);
    }
  }
  const topKeywords = [...kwCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5).map(([k]) => k);

  // Cell-kind heuristic, honest and simple: if every member's `after` is a
  // primitive or a small flat object, the recurring fix is enumerable ->
  // lookup; anything richer (nested strategy objects, varying shapes) ->
  // formula-style fragment. Rationale string carries the evidence.
  const afters = cluster.adjustments.map((a) => a.payload.after);
  const flat = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 4);
  const kind = afters.every(flat) ? 'lookup' : 'formula';

  const id = 'cell-' + sha256Id(`${runId}|${cluster.target}|${seqs.join(',')}`).slice(7, 15);
  const first = cluster.adjustments[0].payload;
  const rows = cluster.adjustments.map((a) => ({
    at_seq: a.seq,
    when: a.payload.why.trigger,
    apply: a.payload.after,
  }));

  return {
    kind: 'adjustment',                       // §5a wrapper retained
    run_id: runId,
    at_seq: seqs[0],
    ts_utc: nowIso(),
    target: { cell_id: first.target.cell_id, sheet: first.target.sheet },
    before: null,
    after: { compiled_from: seqs, cell_kind: kind, entries: rows.length },
    why: {
      trigger: `cluster of ${seqs.length} generalizable adjustments on ${cluster.target} (seqs ${seqs.join(', ')})`,
      hypothesis: `recurring root cause: ${topKeywords.join(', ') || 'unspecified'}`,
      evidence: cluster.adjustments.map((a) => `run.jsonl seq ${a.seq}: ${a.payload.why.trigger}`),
    },
    generalizes: true,
    compiled_cell: {
      id,
      kind,
      sheet_fragment: {
        type: kind === 'lookup' ? 'lookup' : 'formula',
        rows,
        hypothesis_keywords: topKeywords,
        derived_from_adjustments: seqs,
      },
      rationale:
        `${seqs.length} runs needed the same ${kind} fix on ${cluster.target} ` +
        `(keywords: ${topKeywords.join(', ')}); compile the recurring ` +
        `${kind} so future runs use the cell natively instead of hand-adjusting`,
    },
  };
}

/** Append-only, idempotent: skip proposal ids already present in the out file. */
function appendProposals(outFile, proposals) {
  let existing = new Set();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { existing.add(JSON.parse(line)?.compiled_cell?.id); } catch { /* torn line: ignore */ }
    }
  }
  let n = 0;
  for (const p of proposals) {
    if (existing.has(p.compiled_cell.id)) continue;
    fs.appendFileSync(outFile, canonicalJSON(p) + '\n');
    existing.add(p.compiled_cell.id);
    n++;
  }
  return n;
}
