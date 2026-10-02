// tests/rewind.test.mjs — resumeFrom correctness, non-rewrite of history,
// hash verification as HARD error, drift preservation. NO network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRun, loadRun } from '../src/run.js';
import { resumeFrom } from '../src/rewind.js';
import { stateHash } from '../src/canonical.js';
import { scratch, cleanup, adj } from './helpers.mjs';

function fixture(root, runId) {
  const run = createRun({ runsRoot: root, runId, meta: {} });
  run.setState({ cells: { ztable: { tails: 'two' } }, round: 1 });
  run.stablepoint('drafted', { note: 'fragments drafted' });
  run.setState({ cells: { ztable: { tails: 'two' }, dtable: { priority: 'index' } }, round: 2 });
  run.adjust(adj({ target: { cell_id: 'dtable', sheet: 'catalog' } }));
  run.observe({ outcome: 'judge flagged ambiguity', verdict: 'fail' });
  run.setState({ cells: { dtable: { priority: 'explicit' } }, round: 3 });
  return run;
}

describe('resumeFrom', () => {
  const root = scratch('rew');

  test('by seq: state re-materialized, marker appended, run_id preserved', () => {
    const run = fixture(root, 'rew-seq');
    const history = loadRun(run.dir).steps;
    const resumed = resumeFrom(run.dir, 2);           // the 'drafted' stablepoint
    assert.equal(resumed.runId, 'rew-seq', 'same run continues');
    assert.deepEqual(resumed.state(), { cells: { ztable: { tails: 'two' } }, round: 1 });
    const marker = resumed.step(history.length + 1);
    assert.equal(marker.op, 'resumed-from');
    assert.equal(marker.payload.from_seq, 2);
    assert.equal(marker.payload.from_label, 'drafted');
    assert.equal(marker.payload.state_hash, history[1].payload.state_hash);
    assert.equal(resumed.resumedFrom.seq, 2);
  });

  test('by label works; last matching label wins', () => {
    const run = fixture(root, 'rew-label');
    const r = resumeFrom(run.dir, 'drafted');
    assert.deepEqual(r.state(), { cells: { ztable: { tails: 'two' } }, round: 1 });
  });

  test('history is never rewritten: pre-resume bytes are a byte-exact prefix', () => {
    const run = fixture(root, 'rew-prefix');
    const f = path.join(run.dir, 'run.jsonl');
    const before = fs.readFileSync(f);
    const nHistory = loadRun(run.dir).steps.length;
    const resumed = resumeFrom(run.dir, 'drafted');
    resumed.attempt({ what: 're-run after rewind with adjusted state' });
    const after = fs.readFileSync(f);
    assert.deepEqual(after.subarray(0, before.length), before);
    const { steps } = loadRun(run.dir);
    assert.equal(steps.length, nHistory + 2);         // marker + the new attempt
    assert.equal(steps[nHistory].op, 'resumed-from');
    // old branch steps 1..n still exactly what they were
    const oldSteps = loadRun(run.dir).steps.slice(0, nHistory);
    assert.deepEqual(oldSteps.map((s) => s.op), ['note', 'stablepoint', 'adjust', 'observe']);
  });

  test('drift past the snapshot is preserved (never delete data)', () => {
    const run = fixture(root, 'rew-drift');
    const driftedBytes = fs.readFileSync(path.join(run.dir, 'state.json'));
    const resumed = resumeFrom(run.dir, 'drafted');
    const marker = resumed.steps('resumed-from')[0];
    assert.ok(marker.payload.superseded_snapshot, 'drift was snapshotted');
    const saved = fs.readFileSync(path.join(run.dir, marker.payload.superseded_snapshot));
    assert.equal(stateHash(saved), stateHash(driftedBytes));
    // and the working state is the stable point's state, not the drift
    assert.equal(resumed.state().round, 1);
  });

  test('corrupted snapshot is a HARD error naming the stablepoint seq', () => {
    const run = fixture(root, 'rew-corrupt');
    const sp = run.steps('stablepoint')[0];
    const snapFile = path.join(run.dir, sp.payload.snapshot);
    fs.writeFileSync(snapFile, JSON.stringify({ cells: { ztable: { tails: 'TAMPERED' } } }));
    try {
      resumeFrom(run.dir, sp.seq);
      assert.fail('hash mismatch must throw');
    } catch (e) {
      assert.equal(e.code, 'STABLEPOINT_HASH_MISMATCH');
      assert.equal(e.seq, sp.seq);
      assert.match(e.message, /seq 2/);
    }
    // and nothing was appended on the failed resume (fail-closed)
    const { steps } = loadRun(run.dir);
    assert.ok(!steps.some((s) => s.op === 'resumed-from'));
  });

  test('missing snapshot / wrong ref kinds fail with named codes', () => {
    const run = fixture(root, 'rew-missing');
    const sp = run.steps('stablepoint')[0];
    fs.rmSync(path.join(run.dir, sp.payload.snapshot));
    assert.throws(() => resumeFrom(run.dir, sp.seq), (e) => e.code === 'SNAPSHOT_MISSING');
    assert.throws(() => resumeFrom(run.dir, 999), (e) => e.code === 'NO_SUCH_STABLEPOINT');
    assert.throws(() => resumeFrom(run.dir, 3), (e) => e.code === 'NO_SUCH_STABLEPOINT'); // seq 3 is an adjust, not a stablepoint
    assert.throws(() => resumeFrom(run.dir, 'nope'), (e) => e.code === 'NO_SUCH_STABLEPOINT');
  });

  test('resume continues seqs contiguously and the whole ledger still verifies', () => {
    const run = fixture(root, 'rew-continue');
    const n = loadRun(run.dir).steps.length;
    const resumed = resumeFrom(run.dir, 'drafted');
    resumed.setState({ cells: { ztable: { tails: 'param' } }, round: 1 });
    resumed.adjust(adj({ target: { cell_id: 'ztable', sheet: 'catalog' },
      before: { tails: 'two' }, after: { tails: 'param' },
      why: { trigger: 'rewind+adjust re-test', hypothesis: 'tails should be a parameter', evidence: ['obs'] },
      generalizes: true }));
    const { steps } = loadRun(run.dir);               // full chain verify
    assert.equal(steps.length, n + 2);                // marker + adjust (setState is not a step)
    assert.deepEqual(steps.map((s) => s.seq), Array.from({ length: steps.length }, (_, i) => i + 1));
    const lastOp = steps[steps.length - 1].op;
    assert.equal(lastOp, 'adjust');
  });

  cleanup(root);
});
