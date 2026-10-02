// tests/seal.test.mjs — signed run custody (lane 68-b): hash-chain sidecar,
// organ-checkpoint-EXACT seals, fail-closed verification, the rewind custody
// floor, organ interop. Port of the quilt-chrono seal pattern (67-a) onto the
// runbook ledger; formats proven against the real organ code (skip-if-absent).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createRun, openRun, loadRun } from '../src/run.js';
import { resumeFrom } from '../src/rewind.js';
import { canonicalJSON } from '../src/canonical.js';
import {
  CHAIN_GENESIS, canonicalJson, buildChain, chainTip, verifyChainLinks,
  chainFileFor, sealFileFor, readChainSidecar, writeChainSidecar,
  stablepointsAt, sealRun, verifySeal, verifyCustody, verifyRunCustody,
} from '../src/seal.js';
import { scratch, cleanup, adj } from './helpers.mjs';

const KEY = 'seal-test-key-68b';
const KEY2 = 'a different minter entirely';

/** A deterministic 9-step run: 2 stablepoints (seq 2, seq 6), §5a adjust; genesis note = seq 1. */
function seededRun(root, runId = 'seal-demo') {
  const run = createRun({ runsRoot: root, runId, meta: { target: 'seal-demo' } });
  run.setState({ strategy: { alpha: 0.05 } });                                           // setState appends NO step
  run.stablepoint('drafted', { note: 'first anchor' });                                  // seq 2
  run.attempt({ what: 'evaluated against alpha=0.05' });                                 // seq 3
  run.observe({ outcome: 'judge flagged one/two-tail conflation', verdict: 'fail' });    // seq 4
  run.adjust(adj({ target: { cell_id: 'ztable', sheet: 'catalog' } }));                  // seq 5
  run.setState({ strategy: { alpha: 0.05, tails: 'param' } });
  run.stablepoint('adjusted', { note: 'second anchor' });                                // seq 6
  run.attempt({ what: 're-ran with adjusted state' });                                   // seq 7
  run.observe({ outcome: 'passes now', verdict: 'pass' });                               // seq 8
  run.note({ text: 'session end' });                                                     // seq 9
  return run; // 9 steps
}

// ---------------------------------------------------------------------------
// the chain itself
// ---------------------------------------------------------------------------

describe('seal: the chain sidecar', () => {
  const root = scratch('seal-chain');

  test('chain build is deterministic and the link hash follows the organ receipt formula', () => {
    const run = seededRun(root, 'chain-law');
    const a = buildChain(run.steps());
    const b = buildChain(loadRun(run.dir));
    assert.equal(canonicalJson(a), canonicalJson(b)); // byte-identical, not just deepEqual

    // golden formula check, computed independently:
    // hash = sha256(canonical({seq, op, prev})), anchored at GENESIS
    const step0 = JSON.parse(canonicalJson(run.steps()[0]));
    const expected0 = crypto.createHash('sha256')
      .update(canonicalJson({ seq: 0, op: step0, prev: 'GENESIS' }), 'utf8')
      .digest('hex');
    assert.equal(a[0].hash, expected0);
    assert.equal(a[0].prev, CHAIN_GENESIS);
    assert.equal(a[1].prev, a[0].hash); // hash-linked
    assert.match(a[0].hash, /^[0-9a-f]{64}$/);
    // the runbook step rides verbatim inside the link (organ receipt shape {seq, op, prev, hash})
    assert.deepEqual(a[4].op, run.steps()[4]);
    // SEQ-BASE LAW: runbook steps are 1-based; sidecar links are organ receipts
    // and start at 0. link.seq = step.seq - 1; the step's own seq rides in op.seq.
    assert.equal(a[4].seq, 4);
    assert.equal(a[4].op.seq, 5);
    // on JSON-safe ledger steps, the organ canonicalizer and the runbook one agree
    assert.equal(canonicalJson(step0), canonicalJSON(run.steps()[0]));
  });

  test('chain tip is stable across reopenings and moves honestly on append', () => {
    const run = openRun(root, 'chain-law');
    const tip1 = chainTip(buildChain(loadRun(run.dir)));
    const tip2 = chainTip(buildChain(openRun(root, 'chain-law').steps()));
    assert.equal(tip1, tip2);
    assert.match(tip1, /^[0-9a-f]{64}$/);
    run.note({ text: 'grew after tip was captured' });
    assert.notEqual(chainTip(buildChain(loadRun(run.dir))), tip1);
  });

  test('sidecar write is append-only: byte-prefix growth; truncation refuses; broken chains never extend', () => {
    const run = seededRun(root, 'sidecar-law');
    const sidecar = chainFileFor(run.dir);
    assert.equal(sidecar, path.join(run.dir, 'run.chain.jsonl'));
    const first = sealRun(run.dir, { key: KEY });
    const before = fs.readFileSync(sidecar, 'utf8');
    assert.equal(first.appended, 9);

    // grow the ledger; the sidecar EXTENDS, never rewrites
    run.note({ text: 'one more step' });
    const second = sealRun(run.dir, { key: KEY });
    assert.equal(second.appended, 1);
    const after = fs.readFileSync(sidecar, 'utf8');
    assert.ok(after.startsWith(before), 'append-only: old sidecar bytes are a byte-prefix of the new');

    // a tampered sidecar is never "extended" — the chain check fires first, named
    const tampered = before.replace('evaluated against alpha=0.05', 'evaluated against alpha=0.5');
    fs.writeFileSync(sidecar, tampered, 'utf8');
    assert.throws(() => writeChainSidecar(sidecar, buildChain(loadRun(run.dir))), (e) => e.code === 'RECEIPT_HASH_MISMATCH');

    // truncation is a rewrite too: a shorter chain than the sidecar refuses
    fs.writeFileSync(sidecar, before, 'utf8');
    const shorter = buildChain(loadRun(run.dir).steps.slice(0, 5));
    assert.throws(() => writeChainSidecar(sidecar, shorter), (e) => e.code === 'CHAIN_REWRITE_REFUSED');
  });

  test('TAMPER DETECTION AT EVERY OFFSET: flipping any link is named, at every seq', () => {
    const run = seededRun(root, 'tamper-law');
    const sidecar = path.join(run.dir, 'run.chain.jsonl');
    sealRun(run.dir, { key: KEY, chainFile: sidecar });
    const N = 9;

    for (let i = 0; i < N; i++) {
      const lines = fs.readFileSync(sidecar, 'utf8').split('\n').filter((l) => l.length > 0);
      const forged = JSON.parse(lines[i]);
      if (forged.op.payload && typeof forged.op.payload.text === 'string') forged.op.payload.text = `__tampered__${i}`;
      else forged.op.payload.what = `__tampered__${i}`;
      lines[i] = JSON.stringify(forged);
      fs.writeFileSync(path.join(root, `t${i}.chain.jsonl`), lines.join('\n') + '\n', 'utf8');
      assert.throws(
        () => readChainSidecar(path.join(root, `t${i}.chain.jsonl`)),
        (e) => e.code === 'RECEIPT_HASH_MISMATCH' && e.message.includes(`link seq ${i}`) && e.message.includes(`runbook step ${i + 1}`),
        `tamper at offset ${i} was not detected with the named error`,
      );
    }

    // raw single-byte flip inside a ts_utc: parseable bytes, still named
    const raw = fs.readFileSync(sidecar, 'utf8');
    const m = raw.match(/"ts_utc":"([^"]+)"/);
    const flipped = raw.replace(`"ts_utc":"${m[1]}"`, `"ts_utc":"${m[1].replace(/T(\d\d):/, 'T9$1:')}"`);
    fs.writeFileSync(path.join(root, 'flip.chain.jsonl'), flipped, 'utf8');
    assert.throws(() => readChainSidecar(path.join(root, 'flip.chain.jsonl')), (e) => e.code === 'RECEIPT_HASH_MISMATCH');

    // a broken prev-link is a different named species (CHAIN_GAP)
    const lines = fs.readFileSync(sidecar, 'utf8').split('\n').filter((l) => l.length > 0);
    const link3 = JSON.parse(lines[3]);
    link3.prev = '0'.repeat(64);
    lines[3] = JSON.stringify(link3);
    fs.writeFileSync(path.join(root, 'gap.chain.jsonl'), lines.join('\n') + '\n', 'utf8');
    assert.throws(() => readChainSidecar(path.join(root, 'gap.chain.jsonl')), (e) => e.code === 'CHAIN_GAP');
  });

  cleanup(root);
});

// ---------------------------------------------------------------------------
// seal -> verify round-trips
// ---------------------------------------------------------------------------

describe('seal: organ-exact checkpoint + courtroom', () => {
  const root = scratch('seal-roundtrip');

  test('sealRun emits an organ-checkpoint-EXACT document; verifySeal round-trips it', () => {
    const run = seededRun(root, 'cp-shape');
    const { checkpoint: cp, sealedThroughSeq } = sealRun(run.dir, { key: KEY });
    assert.equal(sealedThroughSeq, 9);
    // exact shape, exact fields, nothing runbook-specific bolted on
    assert.deepEqual(Object.keys(cp).sort(), ['alg', 'hash', 'manifest', 'manifestHash', 'schema', 'schemaVersion', 'seq', 'sig']);
    assert.equal(cp.schema, 'quilt.organ.checkpoint');
    assert.equal(cp.schemaVersion, 1);
    assert.equal(cp.alg, 'HMAC-SHA256');
    assert.equal(cp.seq, 8); // link index (organ law); runbook steps 1..9 covered
    assert.equal(cp.hash, chainTip(buildChain(loadRun(run.dir))));
    // the prefix manifest: organ law shape, stablepoint anchors as value cells
    assert.deepEqual(Object.keys(cp.manifest).sort(),
      ['cells', 'edges', 'genesis', 'manifestHash', 'name', 'organId', 'receiptRange', 'schema', 'schemaVersion', 'state', 'supersedes']);
    assert.equal(cp.manifest.schema, 'quilt.organ.manifest');
    assert.equal(cp.manifest.organId, `cp-shape@${cp.manifest.organId.split('@')[1]}`);
    assert.match(cp.manifest.organId, /^cp-shape@[0-9a-f]{16}$/); // organ name defaults to the run_id
    assert.deepEqual(cp.manifest.receiptRange, { start: 0, end: 8, count: 9 });
    assert.deepEqual(cp.manifest.genesis, { seq: 0, prevHash: 'GENESIS' });
    assert.deepEqual(cp.manifest.cells.map((c) => c.id), ['stablepoint/2', 'stablepoint/6']);
    assert.equal(cp.manifest.name, 'cp-shape');
    // sig = HMAC-SHA256(key, canonical({hash, manifestHash, seq})) — recomputed independently
    const expectedSig = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8'))
      .update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
    assert.equal(cp.sig, expectedSig);
    // per-cell stateHash follows the organ value-cell law over the §5c anchor facts
    const cells = stablepointsAt(loadRun(run.dir), 8);
    for (const c of cp.manifest.cells) {
      const expect = crypto.createHash('sha256').update(canonicalJson({ kind: 'value', value: cells[c.id] }), 'utf8').digest('hex');
      assert.equal(c.stateHash, expect);
    }

    const verdict = verifySeal(cp, KEY);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.seq, 8);
    assert.equal(verdict.chainTip, cp.hash);
  });

  test('verifyRunCustody: the full courtroom from disk, incl. a mid-chain boundary', () => {
    const run = seededRun(root, 'courtroom');
    const { checkpoint: cp } = sealRun(run.dir, { key: KEY });
    const verdict = verifyRunCustody(run.dir, { key: KEY });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.sealedThroughSeq, 9);
    assert.deepEqual(verdict.cells, stablepointsAt(loadRun(run.dir), 8));
    assert.equal(verdict.steps.length, 9);

    // a sealed boundary at mid-chain works the same way (covers steps 1..5)
    const mid = sealRun(run.dir, { key: KEY, seq: 4 });
    assert.equal(mid.sealedThroughSeq, 5);
    const midVerdict = verifyCustody(mid.checkpoint, KEY, { links: mid.links, steps: loadRun(run.dir).steps });
    assert.equal(midVerdict.ok, true);
    assert.deepEqual(Object.keys(midVerdict.cells), ['stablepoint/2']);
    // ...and from disk: the run.seal.json now carries the MID seal as latest
    const diskVerdict = verifyRunCustody(run.dir, { key: KEY });
    assert.equal(diskVerdict.sealedThroughSeq, 5);
  });

  test('fail-closed zoo: wrong/missing key, no-stablepoint prefix, bad boundary, bad name, malformed docs', () => {
    const run = seededRun(root, 'zoo');
    const { checkpoint: cp, chainFile } = sealRun(run.dir, { key: KEY });

    assert.throws(() => verifySeal(cp, KEY2), (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
    assert.throws(() => verifySeal(cp, undefined), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
    assert.throws(() => sealRun(run.dir, { key: '' }), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
    assert.throws(() => verifyCustody(cp, KEY, {}), (e) => e.code === 'SEAL_NO_CHAIN_SOURCE');
    assert.throws(() => verifyRunCustody(run.dir, { key: KEY, seal: cp, chainFile: path.join(root, 'nope.chain.jsonl') }),
      (e) => e.code === 'CHAIN_SIDECAR_MISSING');

    const malformed = { ...cp, alg: 'ED25519' };
    assert.throws(() => verifySeal(malformed, KEY), (e) => e.code === 'CHECKPOINT_MALFORMED');
    const badsig = { ...cp, sig: 'zz' };
    assert.throws(() => verifySeal(badsig, KEY), (e) => e.code === 'CHECKPOINT_MALFORMED');
    const tamperedField = { ...cp, hash: 'a'.repeat(64) }; // signed field flipped
    assert.throws(() => verifySeal(tamperedField, KEY), (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');

    assert.throws(() => sealRun(run.dir, { key: KEY, seq: 99 }), (e) => e.code === 'CHECKPOINT_SEQ_OUT_OF_RANGE');
    assert.throws(() => sealRun(run.dir, { key: KEY, seq: -1 }), (e) => e.code === 'CHECKPOINT_SEQ_OUT_OF_RANGE');

    // a prefix with no stablepoint anchors nothing
    const bare = createRun({ runsRoot: root, runId: 'bare', meta: {} }); // genesis note only
    assert.throws(() => sealRun(bare.dir, { key: KEY }), (e) => e.code === 'SEAL_EMPTY_LEDGER');

    // uppercase run ids need an explicit lowercase organ name
    const up = seededRun(root, 'Sealed-UP');
    assert.throws(() => sealRun(up.dir, { key: KEY }), (e) => e.code === 'SEAL_BAD_NAME');
    const okUp = sealRun(up.dir, { key: KEY, name: 'sealed-up' });
    assert.match(okUp.checkpoint.manifest.organId, /^sealed-up@[0-9a-f]{16}$/);

    // sealRun refuses a non-run directory
    assert.throws(() => sealRun(path.join(root, 'not-a-run'), { key: KEY }), (e) => e.code === 'SEAL_BAD_INPUT');
  });

  test('custody forgery fails under the organ anchor law, not just the signature', () => {
    const run = seededRun(root, 'forgery');
    const sidecar = path.join(run.dir, 'run.chain.jsonl');
    const { checkpoint: cp } = sealRun(run.dir, { key: KEY, chainFile: sidecar });

    // tamper the UNSIGNED-but-anchored manifest → no longer re-hashes to the signed manifestHash
    const forged = JSON.parse(JSON.stringify(cp));
    forged.manifest.state.cellsSha256 = 'f'.repeat(64);
    assert.throws(() => verifyCustody(forged, KEY, { chainFile: sidecar }), (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH');

    // the self-consistent chain forgery: re-hash steps 6.. AND fix every link hash.
    // The chain verifies internally, but the SIGNED boundary no longer matches — spec §8's
    // "honest scope of the anchor": a fully re-hashed history is a fork, and the seal names it.
    const links = readChainSidecar(sidecar).links;
    const forgedOp = JSON.parse(JSON.stringify(links[5].op));
    forgedOp.payload.what = 'forged-by-hand';
    let prev = links[5].prev;
    for (let i = 5; i < links.length; i++) {
      links[i].op = i === 5 ? forgedOp : JSON.parse(JSON.stringify(links[i].op));
      links[i].prev = prev;
      links[i].hash = crypto.createHash('sha256')
        .update(canonicalJson({ seq: links[i].seq, op: links[i].op, prev: links[i].prev }), 'utf8').digest('hex');
      prev = links[i].hash;
    }
    assert.doesNotThrow(() => verifyChainLinks(links)); // internally consistent...
    assert.throws(() => verifyCustody(cp, KEY, { links }), (e) => e.code === 'CHECKPOINT_ANCHOR_MISMATCH'); // ...but not THE chain

    // a sidecar/ledger divergence is named directly: same seal, a ledger whose
    // history differs from the one the chain carries
    const diverged = JSON.parse(canonicalJson(loadRun(run.dir).steps));
    diverged[5].payload.what = 'rewritten-after-the-fact';
    assert.throws(
      () => verifyCustody(cp, KEY, { chainFile: sidecar, steps: diverged }),
      (e) => e.code === 'CHAIN_ENTRY_MISMATCH' && e.message.includes('seq 5'),
    );

    // defense in depth: a minter who skips the courtroom can be fed forged steps —
    // each chained step's own L2 id is re-verified, so a stale id inside an
    // internally-consistent chain is named (RUN_LEDGER_TAMPER, the run.js law)
    const stale = readChainSidecar(sidecar).links;
    stale[2].op.id = 'sha256:' + '0'.repeat(64);
    prev = stale[2].prev;
    for (let i = 2; i < stale.length; i++) {
      stale[i].prev = prev;
      stale[i].hash = crypto.createHash('sha256')
        .update(canonicalJson({ seq: stale[i].seq, op: stale[i].op, prev: stale[i].prev }), 'utf8').digest('hex');
      prev = stale[i].hash;
    }
    const forgedTip = prev;
    const rogueCp = {
      schema: 'quilt.organ.checkpoint', schemaVersion: 1, alg: 'HMAC-SHA256',
      seq: stale.length - 1, hash: forgedTip, manifestHash: cp.manifestHash,
    };
    rogueCp.sig = crypto.createHmac('sha256', Buffer.from(KEY, 'utf8'))
      .update(canonicalJson({ hash: rogueCp.hash, manifestHash: rogueCp.manifestHash, seq: rogueCp.seq }), 'utf8').digest('hex');
    rogueCp.manifest = cp.manifest;
    assert.throws(() => verifyCustody(rogueCp, KEY, { links: stale }),
      (e) => e.code === 'RUN_LEDGER_TAMPER' && e.message.includes('runbook step 3'));
  });

  test('post-seal appends extend honestly; the old seal still holds at its boundary; lineage is carried', () => {
    const run = seededRun(root, 'lineage');
    const first = sealRun(run.dir, { key: KEY });
    assert.equal(first.sealedThroughSeq, 9);

    run.note({ text: 'post-seal 1' });
    run.note({ text: 'post-seal 2' });
    run.note({ text: 'post-seal 3' });
    const second = sealRun(run.dir, { key: KEY });
    assert.equal(second.appended, 3);
    assert.equal(second.sealedThroughSeq, 12);
    // identity carried forward (organ law: carried, not re-minted); lineage honest
    assert.equal(second.checkpoint.manifest.organId, first.checkpoint.manifest.organId);
    assert.equal(second.checkpoint.manifest.supersedes, first.checkpoint.manifest.manifestHash);

    // the OLD seal still verifies against the EXTENDED chain at ITS boundary
    assert.equal(verifyCustody(first.checkpoint, KEY, { chainFile: first.chainFile, steps: loadRun(run.dir).steps }).ok, true);
    const extended = readChainSidecar(first.chainFile);
    assert.equal(extended.links.length, 12);
    assert.equal(verifyCustody(second.checkpoint, KEY, { links: extended.links }).ok, true);
    assert.equal(second.checkpoint.hash, extended.tipHash);
  });

  test('the anchored snapshots are re-derived: tampered/missing snapshot files are named, at their seq', () => {
    const run = seededRun(root, 'snapshots');
    sealRun(run.dir, { key: KEY });
    const snap6 = path.join(run.dir, loadRun(run.dir).steps.find((s) => s.seq === 6).payload.snapshot);
    const keep = fs.readFileSync(snap6);

    fs.appendFileSync(snap6, 'tampered\n', 'utf8');
    assert.throws(() => verifyRunCustody(run.dir, { key: KEY }),
      (e) => e.code === 'STABLEPOINT_HASH_MISMATCH' && e.message.includes('seq 6'));

    fs.writeFileSync(snap6, keep); // restore bytes
    fs.unlinkSync(snap6);          // (test-scoped dir; the repo's never-delete law is for ledgers)
    assert.throws(() => verifyRunCustody(run.dir, { key: KEY }),
      (e) => e.code === 'SNAPSHOT_MISSING' && e.message.includes('seq 6'));
  });

  cleanup(root);
});

// ---------------------------------------------------------------------------
// the rewind custody gate (L10) — the organ REWIND_PAST_CUSTODY law, mirrored
// ---------------------------------------------------------------------------

describe('seal: resumeFrom custody gate', () => {
  const root = scratch('seal-resume');

  test('a sealed run resumes ONLY at or after the custody floor; the courtroom runs first', () => {
    const run = createRun({ runsRoot: root, runId: 'floor', meta: {} }); // genesis note = seq 1
    run.setState({ s: 1 });
    run.stablepoint('mid', { note: 'mid anchor' });      // seq 2
    run.attempt({ what: 'grow the branch' });            // seq 3
    run.setState({ s: 2 });
    run.stablepoint('final', { note: 'tip anchor' });    // seq 4 = tip = boundary
    const { sealedThroughSeq } = sealRun(run.dir, { key: KEY });
    assert.equal(sealedThroughSeq, 4);

    // resuming AT the boundary stablepoint = resuming from the signed state — legal
    const stateBefore = fs.readFileSync(path.join(run.dir, 'state.json'));
    const resumed = resumeFrom(run.dir, 'final', { key: KEY });
    assert.equal(resumed.resumedFrom.seq, 4);
    assert.equal(resumed.nextSeq, 6); // 4 steps + the resumed-from marker
    assert.ok(fs.readFileSync(path.join(run.dir, 'state.json')).equals(stateBefore),
      'resuming AT the boundary re-materializes the signed state itself');

    // resuming from a stablepoint INSIDE the signed prefix refuses, naming the checkpoint
    assert.throws(() => resumeFrom(run.dir, 'mid', { key: KEY }), (e) => {
      assert.equal(e.code, 'REWIND_PAST_CUSTODY');
      assert.match(e.message, /precedes the sealed boundary/);
      assert.match(e.message, /manifestHash/);
      assert.equal(e.boundarySeq, 4);
      return true;
    });
    // the refused resume appended NOTHING (ledger still at 5 steps)
    assert.equal(loadRun(run.dir).steps.length, 5);

    // post-boundary resume: a stablepoint taken AFTER the seal is legal
    // (guarded by the hash chain only — the honest weaker tier, still verified)
    const fresh = openRun(root, 'floor');                        // seq 5 = the marker
    const postSp = fresh.stablepoint('post-seal', { note: 'after the seal' }); // seq 6
    const resealed = sealRun(run.dir, { key: KEY, seq: 3 });     // boundary BEFORE the marker+post-seal
    assert.equal(resealed.sealedThroughSeq, 4);                  // floor stays at the 'final' anchor
    const resumed2 = resumeFrom(run.dir, 'post-seal', { key: KEY });
    assert.equal(resumed2.resumedFrom.seq, postSp.seq);
  });

  test('resume custody is fail-closed: wrong key materializes NOTHING; sidecar without seal refuses', () => {
    const run = createRun({ runsRoot: root, runId: 'gate', meta: {} });
    run.setState({ s: 1 });
    run.stablepoint('only', { note: 'anchor' });         // seq 3 = tip = boundary
    sealRun(run.dir, { key: KEY });
    const stepsBefore = loadRun(run.dir).steps.length;
    const stateBefore = fs.readFileSync(path.join(run.dir, 'state.json'));

    assert.throws(() => resumeFrom(run.dir, 'only', { key: KEY2 }), (e) => e.code === 'CHECKPOINT_SIGNATURE_INVALID');
    assert.throws(() => resumeFrom(run.dir, 'only'), (e) => e.code === 'CHECKPOINT_SIGNATURE_REQUIRED');
    // NOTHING materialized: no marker, no state rewrite, no superseded snapshot
    assert.equal(loadRun(run.dir).steps.length, stepsBefore);
    assert.ok(fs.readFileSync(path.join(run.dir, 'state.json')).equals(stateBefore));
    assert.equal(fs.readdirSync(path.join(run.dir, 'snapshots')).filter((f) => f.startsWith('superseded')).length, 0);

    // sidecar without its seal document: the signature half of custody is missing
    const sidecarPath = chainFileFor(run.dir);
    assert.ok(fs.existsSync(sidecarPath));
    fs.unlinkSync(sealFileFor(run.dir));
    assert.throws(() => resumeFrom(run.dir, 'only', { key: KEY }), (e) => e.code === 'CUSTODY_SEAL_MISSING');

    // a tampered sidecar refuses the resume outright (named, from the chain law)
    sealRun(run.dir, { key: KEY }); // re-mint to restore the seal doc
    const raw = fs.readFileSync(sidecarPath, 'utf8').replace('anchor', 'anch0r');
    fs.writeFileSync(sidecarPath, raw, 'utf8');
    assert.throws(() => resumeFrom(run.dir, 'only', { key: KEY }), (e) => e.code === 'RECEIPT_HASH_MISMATCH');
  });

  test('unsealed runs resume exactly as before — the gate is additive', () => {
    const run = createRun({ runsRoot: root, runId: 'unsealed', meta: {} }); // genesis = seq 1
    run.setState({ s: 1 });
    run.stablepoint('anchor', { note: 'no seal here' });   // seq 2
    run.attempt({ what: 'drift the state' });              // seq 3
    const resumed = resumeFrom(run.dir, 'anchor'); // no opts, no seal, no sidecar
    assert.equal(resumed.resumedFrom.seq, 2);
    assert.equal(resumed.nextSeq, 5); // 3 steps + the resumed-from marker
  });

  cleanup(root);
});

// ---------------------------------------------------------------------------
// ORGAN INTEROP — the point of the port: the organ toolkit's OWN code accepts
// a runbook seal. Skips honestly when the sibling repo is not checked out.
// ---------------------------------------------------------------------------

const organUrl = new URL('../../quilt-jev-toolkit/src/organ/', import.meta.url);
const organReady = fs.existsSync(new URL('boot.mjs', organUrl)) && fs.existsSync(new URL('manifest.mjs', organUrl));
const organ = organReady
  ? { boot: await import(new URL('boot.mjs', organUrl).href), manifest: await import(new URL('manifest.mjs', organUrl).href) }
  : null;

describe('seal: ORGAN INTEROP (skip-if-absent)', () => {
  const root = scratch('seal-interop');

  test('canonical bytes are byte-identical to the organ implementation', (t) => {
    if (!organ) { t.skip('quilt-jev-toolkit sibling not present — the interop proof needs it locally'); return; }
    const nasty = { z: 1, a: { d: [2, 1, { b: null, a: 'x' }], c: true }, m: 0.5, s: 'quote"and\\slash', arr: [1, [2, [3]]] };
    assert.equal(canonicalJson(nasty), organ.manifest.canonicalJson(nasty));
    assert.throws(() => canonicalJson({ bad: undefined }), TypeError);
    assert.throws(() => canonicalJson({ bad: 123n }), TypeError);
    assert.throws(() => canonicalJson({ bad: NaN }), TypeError);
  });

  test('organ verifySignedCheckpoint accepts the runbook seal (and rejects forgeries)', (t) => {
    if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
    const run = seededRun(root, 'interop-cp');
    const { checkpoint: cp } = sealRun(run.dir, { key: KEY });
    assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY).ok, true);
    assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY2).ok, false);
    assert.equal(organ.boot.verifySignedCheckpoint(cp, KEY2).code, 'CHECKPOINT_SIGNATURE_INVALID');
  });

  test('organ verifyChain verifies the runbook sidecar; tip == sealed chainTip', (t) => {
    if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
    const run = seededRun(root, 'interop-chain');
    const { checkpoint: cp, links } = sealRun(run.dir, { key: KEY });
    const verdict = organ.manifest.verifyChain(links, { expectedStart: 0, expectedPrev: 'GENESIS' });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tipHash, cp.hash);
    // the sidecar links re-hash under the ORGAN's own receiptHash, one by one
    for (const l of links) assert.equal(organ.manifest.receiptHash(l), l.hash);
    // and the organ's own tamper naming fires on the runbook sidecar
    const broken = JSON.parse(JSON.stringify(links));
    broken[7].op.payload.what = 'forged-by-hand';
    assert.equal(organ.manifest.verifyChain(broken).code, 'RECEIPT_HASH_MISMATCH');
  });

  test('organ validateManifest accepts the seal manifest; manifestHash matches computeManifestHash', (t) => {
    if (!organ) { t.skip('quilt-jev-toolkit sibling not present'); return; }
    const run = seededRun(root, 'interop-manifest');
    const { checkpoint: cp } = sealRun(run.dir, { key: KEY, seq: 6 });
    const validation = organ.manifest.validateManifest(cp.manifest);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors ?? []));
    assert.equal(organ.manifest.computeManifestHash(cp.manifest), cp.manifestHash);
    // the manifest's state hash is the organ state law: sha256Json of the cells map
    assert.equal(cp.manifest.state.cellsSha256, organ.manifest.sha256Json(stablepointsAt(loadRun(run.dir), 6)));
  });

  cleanup(root);
});
