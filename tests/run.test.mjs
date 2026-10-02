// tests/run.test.mjs — L1 append/seq law, L2 hash law, L3 fail-closed,
// L4 contract shapes (§5a/§5c), L5 state-hash-over-bytes. NO network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRun, openRun, loadRun, Run } from '../src/run.js';
import { canonicalJSON, sha256Id, stateHash } from '../src/canonical.js';
import { scratch, cleanup, adj } from './helpers.mjs';

describe('L1 append/seq law', () => {
  const root = scratch('l1');

  test('seq is 1-based contiguous across appends and reopenings', () => {
    const run = createRun({ runsRoot: root, runId: 'seq-law', meta: { t: 1 } });
    run.setState({ a: 1 });
    run.stablepoint('sp-1', { note: 'first' });
    run.attempt({ what: 'try the thing' });
    const reopened = openRun(root, 'seq-law');           // verify + reload
    assert.equal(reopened.nextSeq, 4);
    reopened.observe({ outcome: 'it behaved', verdict: 'pass' });
    const reopened2 = openRun(root, 'seq-law');
    assert.deepEqual(reopened2.steps().map((s) => s.seq), [1, 2, 3, 4]);
    assert.deepEqual(reopened2.steps().map((s) => s.op),
      ['note', 'stablepoint', 'attempt', 'observe']);
  });

  test('ledger file only ever grows: reopen+append preserves the byte prefix', () => {
    const run = openRun(root, 'seq-law');
    const before = fs.readFileSync(path.join(run.dir, 'run.jsonl'));
    run.note({ text: 'grew after prefix was captured' });
    const after = fs.readFileSync(path.join(run.dir, 'run.jsonl'));
    assert.ok(after.length > before.length);
    assert.deepEqual(after.subarray(0, before.length), before, 'prefix must be byte-identical');
  });

  test('createRun refuses duplicate ids; openRun refuses unknown runs', () => {
    assert.throws(() => createRun({ runsRoot: root, runId: 'seq-law' }), /RUN_EXISTS/);
    assert.throws(() => openRun(root, 'nope'), /NO_SUCH_RUN/);
  });

  test('stale handle refuses to append (L6): a second writer is fail-closed, not a duplicate seq', () => {
    const run = createRun({ runsRoot: root, runId: 'stale', meta: {} });  // seq 1 (genesis)
    run.note({ text: 'one' });                                            // seq 2
    const fresh = openRun(root, 'stale');       // second handle on the same ledger
    fresh.note({ text: 'two (fresh handle)' });                           // seq 3
    assert.throws(() => run.note({ text: 'would duplicate seq 4' }), (e) => {
      assert.equal(e.code, 'STALE_HANDLE');
      assert.match(e.message, /STALE_HANDLE/);
      return true;
    }, 'the stale handle must refuse once the file grew under it');
    // the stale append wrote NOTHING (no duplicate seq 4); ledger still verifies
    const reopened = openRun(root, 'stale');
    assert.deepEqual(reopened.steps().map((s) => s.seq), [1, 2, 3]);
    assert.ok(reopened.steps().every((s) => s.payload.text !== 'would duplicate seq 4'));
    reopened.note({ text: 'three (after reopen)' });                      // seq 4
    assert.equal(loadRun(root + '/stale').steps.length, 4);
  });

  cleanup(root);
});

describe('L2 hash law (chain + tamper rejection)', () => {
  const root = scratch('l2');

  test('every step chains: prev = previous id; id = hash(run|seq|prev|body)', () => {
    const run = createRun({ runsRoot: root, runId: 'chain', meta: {} });
    run.setState({ v: 1 });
    run.stablepoint('cp', { note: 'x' });
    run.attempt({ what: 'w' });
    const { steps } = loadRun(run.dir);
    const genesis = sha256Id(`genesis:chain`);
    assert.equal(steps[0].prev, genesis);
    for (let i = 1; i < steps.length; i++) assert.equal(steps[i].prev, steps[i - 1].id);
  });

  test('editing any line is RUN_LEDGER_TAMPER naming that seq', () => {
    const dir = path.join(root, 'tamper-edit');
    const run = createRun({ runsRoot: root, runId: 'tamper-edit', meta: {} });
    run.setState({ v: 1 });
    run.stablepoint('cp', { note: 'x' });
    run.attempt({ what: 'w' });
    const f = path.join(dir, 'run.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const obj = JSON.parse(lines[2]);               // edit seq 3's payload
    obj.payload.what = 'REWRITTEN';
    lines[2] = JSON.stringify(obj);
    fs.writeFileSync(f, lines.join('\n'));
    try {
      loadRun(dir);
      assert.fail('tamper must throw');
    } catch (e) {
      assert.equal(e.code, 'RUN_LEDGER_TAMPER');
      assert.equal(e.seq, 3);
      assert.match(e.message, /seq 3/);
    }
  });

  test('dropping a middle line breaks the chain (nothing can be silently removed)', () => {
    const dir = path.join(root, 'tamper-drop');
    const run = createRun({ runsRoot: root, runId: 'tamper-drop', meta: {} });
    run.note({ text: 'one' });
    run.note({ text: 'two' });
    const f = path.join(dir, 'run.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(f, [lines[0], lines[2]].join('\n') + '\n'); // drop seq 2
    try {
      loadRun(dir);
      assert.fail('drop must throw');
    } catch (e) {
      assert.equal(e.code, 'RUN_LEDGER_TAMPER');
      assert.equal(e.seq, 2);
    }
  });

  cleanup(root);
});

describe('L3 fail-closed (nothing silently dropped)', () => {
  const root = scratch('l3');

  test('invalid payload becomes an error step, not a skip and not a throw', () => {
    const run = createRun({ runsRoot: root, runId: 'failclosed', meta: {} });
    const before = run.nextSeq;
    const res = run.attempt({ nope: 'payload missing what' });
    assert.equal(res.ok, false);
    assert.deepEqual(res.problems, ['payload.what must be a non-empty string (what was tried)']);
    const errStep = run.step(before);
    assert.equal(errStep.op, 'error');
    assert.equal(errStep.payload.code, 'INVALID_PAYLOAD');
    assert.equal(errStep.payload.op_requested, 'attempt');
    assert.deepEqual(errStep.payload.received, { nope: 'payload missing what' },
      'the offending payload is recorded, never dropped');
    assert.equal(run.step(before + 1), null, 'no other step was appended');
  });

  test('invalid §5a adjust records are caught field-by-field', () => {
    const run = createRun({ runsRoot: root, runId: 'adj-invalid', meta: {} });
    const res = run.adjust({ target: { cell_id: 'x' }, before: 1, after: 2,
      why: { trigger: 't', evidence: [] }, generalizes: 'yes' });
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('target.sheet')));
    assert.ok(res.problems.some((p) => p.includes('hypothesis')));
    assert.ok(res.problems.some((p) => p.includes('generalizes')));
    assert.equal(run.steps('error').length, 1);
  });

  test('unknown op records an error step AND throws (programmer error is loud)', () => {
    const run = createRun({ runsRoot: root, runId: 'unknown-op', meta: {} });
    assert.throws(() => run.append('fly', {}), /UNKNOWN_OP/);
    const errSteps = run.steps('error');
    assert.equal(errSteps.length, 1);
    assert.equal(errSteps[0].payload.op_requested, 'fly');
  });

  cleanup(root);
});

describe('L4 contract shapes (§5a / §5c exact fields)', () => {
  const root = scratch('l4');

  test('stablepoint payload carries the §5c record exactly', () => {
    const run = createRun({ runsRoot: root, runId: 'sp-shape', meta: {} });
    run.setState({ strategy: 'v1' });
    const step = run.stablepoint('drafted', { note: 'fragments drafted' });
    const p = step.payload;
    assert.deepEqual(Object.keys(p).sort(),
      ['kind', 'label', 'note', 'run_id', 'seq', 'snapshot', 'state_hash', 'ts_utc'].sort());
    assert.equal(p.kind, 'stablepoint');
    assert.equal(p.run_id, 'sp-shape');
    assert.equal(p.seq, step.seq);
    assert.match(p.state_hash, /^sha256:[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(run.dir, p.snapshot)), 'snapshot file exists');
    // §5c state_hash is over the snapshot BYTES (L5)
    const bytes = fs.readFileSync(path.join(run.dir, p.snapshot));
    assert.equal(p.state_hash, stateHash(bytes));
  });

  test('adjust payload carries the §5a record exactly, at_seq == step seq', () => {
    const run = createRun({ runsRoot: root, runId: 'adj-shape', meta: {} });
    const res = run.adjust(adj({}));
    assert.equal(res.ok, true);
    const p = res.step.payload;
    assert.deepEqual(Object.keys(p).sort(),
      ['after', 'at_seq', 'before', 'compiled_cell', 'generalizes', 'kind', 'run_id', 'target', 'ts_utc', 'why'].sort());
    assert.equal(p.kind, 'adjustment');
    assert.equal(p.at_seq, res.step.seq);
    assert.equal(p.compiled_cell, null, 'compiled_cell defaults to null; the compiler fills it');
    // the §5a stream file mirrors the record for the compiler lane
    const stream = fs.readFileSync(path.join(run.dir, 'adjustments.jsonl'), 'utf8').trim().split('\n');
    assert.equal(stream.length, 1);
    assert.deepEqual(JSON.parse(stream[0]), p);
  });

  test('receipts ride on the step they belong to and are hashed in', () => {
    const run = createRun({ runsRoot: root, runId: 'receipts', meta: {} });
    const receipt = { channel: 'deepinfra', model: 'granite-4.2-3b', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    const res = run.observe({ outcome: 'judge said executable', verdict: 'pass' }, { receipt });
    assert.deepEqual(res.step.receipt, receipt);
    // tamper with the receipt -> chain must catch it
    const f = path.join(run.dir, 'run.jsonl');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const obj = JSON.parse(lines[1]);
    obj.receipt.usage.total_tokens = 1;             // dishonest receipt
    lines[1] = JSON.stringify(obj);
    fs.writeFileSync(f, lines.join('\n'));
    assert.throws(() => loadRun(run.dir), (e) => e.code === 'RUN_LEDGER_TAMPER' && e.seq === 2);
  });

  cleanup(root);
});

describe('canonical JSON + state hashing', () => {
  test('canonicalJSON is key-order independent', () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }),
      canonicalJSON({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  test('stateHash is over exact bytes, so formatting changes move the hash', () => {
    const h1 = stateHash(Buffer.from('{"a":1}\n'));
    const h2 = stateHash(Buffer.from('{"a": 1}\n'));
    assert.notEqual(h1, h2);
  });
});
