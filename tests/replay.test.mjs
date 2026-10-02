// tests/replay.test.mjs — deterministic re-execution on a TOY step contract:
// pure registry fns, adjustment applied first, honest skips/failures. NO network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRun, loadRun } from '../src/run.js';
import { replayRun, recordReplayable } from '../src/replay.js';
import { canonicalJSON } from '../src/canonical.js';
import { scratch, cleanup } from './helpers.mjs';

// the toy step contract: two pure registry functions
const REGISTRY = {
  double: (args, state) => (state.mode === 'triple' ? args[0] * 3 : args[0] * 2),
  add: (args) => args[0] + args[1],
};

function fixture(root, runId) {
  const run = createRun({ runsRoot: root, runId, meta: {} });
  run.setState({ mode: 'double' });
  run.stablepoint('cp1', { note: 'strategy as drafted' });
  run.attempt({ what: 'eval strategy cell', ...recordReplayable('double', [21], REGISTRY.double, run.state()) });
  run.attempt({ what: 'sum check', ...recordReplayable('add', [1, 2], REGISTRY.add, run.state()) });
  run.attempt({ what: 'model judge call — recorded, NOT replayable', returns: 'judgement', replayable: false });
  run.setState({ mode: 'double', extra: 'drift after stablepoint' });
  return run;
}

describe('replay', () => {
  const root = scratch('replay');

  test('from a stablepoint: recorded pure steps re-execute deterministically', () => {
    fixture(root, 'r-basic');
    const s = replayRun(root + '/r-basic', { from: 'cp1', registry: REGISTRY });
    assert.equal(s.replayed, 2);
    assert.equal(s.passed, 2);
    assert.equal(s.failed, 0);
    assert.deepEqual(s.verdicts.map((v) => v.seq), [3, 4]);
    // non-replayable steps are invisible to the re-executor, not errors
    assert.ok(!s.verdicts.some((v) => v.seq === 5));
  });

  test('state-adjustment applied FIRST changes outcomes honestly (old returns now fail)', () => {
    fixture(root, 'r-adjust');
    const s = replayRun(root + '/r-adjust', {
      from: 'cp1', registry: REGISTRY,
      adjustments: [{ target: { cell_id: 'mode', sheet: 'strategy' }, before: 'double', after: 'triple' }],
    });
    assert.equal(s.adjustments[0].applied, true);
    assert.equal(s.failed, 1, 'the adjusted strategy no longer reproduces the old recorded output');
    assert.equal(s.verdicts[0].pass, false);
    assert.equal(s.verdicts[0].actual, 63, 're-execution used the ADJUSTED strategy');
    assert.equal(s.verdicts[1].pass, true, 'independent pure step is unaffected');
  });

  test('replay is deterministic: identical invocations -> byte-identical summaries', () => {
    fixture(root, 'r-det');
    const opts = { from: 'cp1', registry: REGISTRY,
      adjustments: [{ target: { cell_id: 'mode', sheet: 'strategy' }, before: 'double', after: 'triple' }] };
    const a = canonicalJSON(replayRun(root + '/r-det', opts));
    const b = canonicalJSON(replayRun(root + '/r-det', opts));
    assert.equal(a, b);
  });

  test('adjustment with a wrong `before` is honestly skipped, not silently forced', () => {
    fixture(root, 'r-precond');
    const s = replayRun(root + '/r-precond', {
      from: 'cp1', registry: REGISTRY,
      adjustments: [{ target: { cell_id: 'mode', sheet: 'strategy' }, before: 'WRONG', after: 'triple' }],
    });
    assert.equal(s.adjustments[0].applied, false);
    assert.match(s.adjustments[0].reason, /precondition failed/);
    assert.equal(s.passed, 2, 'unadjusted replay still reproduces history');
  });

  test('missing registry entries are reported as skipped with a reason', () => {
    fixture(root, 'r-skip');
    const s = replayRun(root + '/r-skip', { from: 'cp1', registry: { add: REGISTRY.add } });
    assert.equal(s.skipped.length, 1);
    assert.match(s.skipped[0].reason, /not in registry/);
  });

  test('replay from genesis uses empty state and replays all replayable steps', () => {
    fixture(root, 'r-genesis');
    const s = replayRun(root + '/r-genesis', { from: 'genesis', registry: REGISTRY });
    assert.equal(s.replayed, 2);
    assert.equal(s.verdicts[0].actual, 42, 'genesis state.mode undefined -> double path');
  });

  test('a tampered ledger refuses to replay (chain verify first)', () => {
    fixture(root, 'r-tamper');
    // corrupt by appending a hand-forged line
    fs.appendFileSync(root + '/r-tamper/run.jsonl', canonicalJSON({ seq: 99, ts_utc: '2026-01-01T00:00:00Z', op: 'note', payload: { text: 'forged' }, run_id: 'r-tamper', prev: 'sha256:' + '0'.repeat(64), id: 'sha256:' + '1'.repeat(64) }) + '\n');
    assert.throws(() => replayRun(root + '/r-tamper', { from: 'genesis', registry: REGISTRY }),
      (e) => e.code === 'RUN_LEDGER_TAMPER');
  });

  cleanup(root);
});
