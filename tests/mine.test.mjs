// tests/mine.test.mjs — WHY-decomposition clustering on synthetic runs:
// >=2 generalizable adjustments -> 1 compiled cell proposal, §5a shape out.
// NO network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRun } from '../src/run.js';
import { mineRun, hypothesisKeywords } from '../src/mine.js';
import { scratch, cleanup, adj } from './helpers.mjs';

function buildRun(root, runId, adjustments) {
  const run = createRun({ runsRoot: root, runId, meta: {} });
  run.setState({ cells: {} });
  for (const a of adjustments) run.adjust(adj(a));
  return run;
}

describe('mining: cluster by (target, hypothesis keywords)', () => {
  const root = scratch('mine');

  test('2 generalizable adjustments on one target sharing keywords -> exactly 1 proposal', () => {
    const run = buildRun(root, 'm-basic', [
      { target: { cell_id: 'ztable', sheet: 'catalog' }, before: { tails: 'two' }, after: { tails: 'param' },
        why: { trigger: 'judge flagged one-tail two-tail conflation', hypothesis: 'tails must be a parameter not a hardcoded value', evidence: ['s1'] },
        generalizes: true },
      { target: { cell_id: 'ztable', sheet: 'catalog' }, before: 0.95, after: { alpha: 0.05 },
        why: { trigger: 'alpha was hardcoded inline', hypothesis: 'hardcoded value should have been the tails parameter again', evidence: ['s2'] },
        generalizes: true },
    ]);
    const res = mineRun(run.dir);
    assert.equal(res.proposals.length, 1);
    const p = res.proposals[0];
    // §5a shape out
    assert.deepEqual(Object.keys(p).sort(),
      ['after', 'at_seq', 'before', 'compiled_cell', 'generalizes', 'kind', 'run_id', 'target', 'ts_utc', 'why'].sort());
    assert.equal(p.kind, 'adjustment');
    assert.equal(p.target.cell_id, 'ztable');
    assert.equal(p.compiled_cell.kind, 'lookup');
    assert.ok(p.compiled_cell.id.startsWith('cell-'));
    assert.deepEqual(p.compiled_cell.sheet_fragment.derived_from_adjustments, [2, 3]);
    // written to compilations.jsonl, one §5a record per line
    const lines = fs.readFileSync(path.join(run.dir, 'compilations.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).compiled_cell.id, p.compiled_cell.id);
  });

  test('keyword join works across different phrasings of the same reason', () => {
    const run = buildRun(root, 'm-kw', [
      { target: { cell_id: 'dtable', sheet: 'catalog' }, before: null, after: { priority: 'index' },
        why: { trigger: 'ambiguous overlapping rules', hypothesis: 'decision tables need explicit rule priority ordering', evidence: [] },
        generalizes: true },
      { target: { cell_id: 'dtable', sheet: 'catalog' }, before: null, after: { priority: 'explicit' },
        why: { trigger: 'same cell misfired again', hypothesis: 'rules without priority ordering stay ambiguous forever', evidence: [] },
        generalizes: true },
    ]);
    const res = mineRun(run.dir);
    assert.equal(res.proposals.length, 1, 'shared keywords "rules/priority/ordering" must cluster');
  });

  test('generalizes=false never compiles; lonely adjustments never compile', () => {
    const run = buildRun(root, 'm-guard', [
      { target: { cell_id: 'a', sheet: 's' }, generalizes: false,
        why: { trigger: 't', hypothesis: 'one-off transcription slip here', evidence: [] } },
      { target: { cell_id: 'a', sheet: 's' }, generalizes: false,
        why: { trigger: 't', hypothesis: 'one-off transcription slip again', evidence: [] } },
      { target: { cell_id: 'b', sheet: 's' }, generalizes: true,
        why: { trigger: 't', hypothesis: 'single occurrence of unshared cause', evidence: [] } },
    ]);
    const res = mineRun(run.dir);
    assert.equal(res.proposals.length, 0, 'nothing qualifies');
    assert.equal(res.clusters.length, 0);
  });

  test('same keywords on different targets do NOT cluster (target is part of the key)', () => {
    const run = buildRun(root, 'm-targets', [
      { target: { cell_id: 'x', sheet: 's' },
        why: { trigger: 't', hypothesis: 'explicit priority ordering missing', evidence: [] }, generalizes: true },
      { target: { cell_id: 'y', sheet: 's' },
        why: { trigger: 't', hypothesis: 'explicit priority ordering missing', evidence: [] }, generalizes: true },
    ]);
    const res = mineRun(run.dir);
    assert.equal(res.proposals.length, 0);
  });

  test('re-mining is idempotent (append-only, no duplicate ids)', () => {
    const run = buildRun(root, 'm-idem', [
      { target: { cell_id: 'z', sheet: 's' }, why: { trigger: 't1', hypothesis: 'tails parameter pattern', evidence: [] }, generalizes: true },
      { target: { cell_id: 'z', sheet: 's' }, why: { trigger: 't2', hypothesis: 'tails parameter pattern again', evidence: [] }, generalizes: true },
    ]);
    const r1 = mineRun(run.dir);
    assert.equal(r1.appended, 1);
    const f = path.join(run.dir, 'compilations.jsonl');
    const before = fs.readFileSync(f);
    const r2 = mineRun(run.dir);
    assert.equal(r2.appended, 0, 'existing proposal id is not duplicated');
    assert.deepEqual(fs.readFileSync(f), before);
  });

  test('proposal ids are deterministic (same content -> same id)', () => {
    const a = buildRun(root, 'm-det-a', [
      { target: { cell_id: 'w', sheet: 's' }, why: { trigger: 't1', hypothesis: 'shared keyword pattern', evidence: [] }, generalizes: true },
      { target: { cell_id: 'w', sheet: 's' }, why: { trigger: 't2', hypothesis: 'shared keyword pattern again', evidence: [] }, generalizes: true },
    ]);
    const b = buildRun(root, 'm-det-b', [
      { target: { cell_id: 'w', sheet: 's' }, why: { trigger: 't1', hypothesis: 'shared keyword pattern', evidence: [] }, generalizes: true },
      { target: { cell_id: 'w', sheet: 's' }, why: { trigger: 't2', hypothesis: 'shared keyword pattern again', evidence: [] }, generalizes: true },
    ]);
    const pa = mineRun(a.dir).proposals[0];
    const pb = mineRun(b.dir).proposals[0];
    assert.notEqual(pa.compiled_cell.id, pb.compiled_cell.id,
      'ids include run_id — cross-run identical lessons compile to distinct cell instances');
    assert.equal(pa.compiled_cell.sheet_fragment.rows.length, 2);
  });

  test('hypothesisKeywords drops stopwords and short tokens', () => {
    const kw = hypothesisKeywords('The tails must be a parameter, not a hard-coded value of the day');
    assert.ok(kw.includes('tails') && kw.includes('parameter'), 'significant words kept');
    assert.ok(!kw.includes('the') && !kw.includes('must'), 'stoplisted words dropped');
    assert.ok(!kw.includes('day') && !kw.includes('of'), 'short tokens dropped');
  });

  cleanup(root);
});
