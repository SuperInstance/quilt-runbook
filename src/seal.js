// src/seal.js — SIGNED RUN CUSTODY (lane 68-b): hash-chain the run ledger in a
// sidecar and seal the chain tip with an organ-protocol checkpoint.
//
// This is the 1:1 port wave-67 queued ("the same seal pattern maps 1:1 onto
// quilt-runbook's jsonl ledger" — 67-a Stage Summary). The pattern's home is
// quilt-chrono/src/seal.js (lane 67-a); both ports build on the organ protocol
// v2 (quilt-jev-toolkit src/organ/{manifest,boot,checkpoint}.mjs,
// docs/REVERSE-ACTUALIZED-SPEC.md §8). The sealed document is BYTE-EXACTLY the
// organ v2 checkpoint — no runbook-specific fields are added (drift is how
// parallel standards start):
//
//   { schema: "quilt.organ.checkpoint", schemaVersion: 1, alg: "HMAC-SHA256",
//     seq:  <boundary — last sidecar link the seal covers (0-based)>,
//     hash: <chainTip at the boundary = the sidecar link's receipt hash>,
//     manifestHash: <sha256 of the prefix custody manifest>,
//     sig: <HMAC-SHA256(key, canonical({hash, manifestHash, seq}))>,
//     manifest: <quilt.organ.manifest/v1, content-addressed to manifestHash> }
//
// So the organ toolkit's OWN verifiers accept a run seal unmodified:
//   boot.mjs verifySignedCheckpoint(cp, key)   — structure + HMAC
//   manifest.mjs verifyChain(links)            — the sidecar IS an organ
//                                                receipt chain
//   manifest.mjs validateManifest(cp.manifest) — the prefix custody manifest
// tests/seal.test.mjs proves all of this against the real organ code when the
// sibling repo is checked out (skip-if-absent; this repo stays stdlib-only and
// dependency-free — the FORMATS match, no code is imported at runtime).
//
// THE CHAIN SIDECAR (`runs/<id>/run.chain.jsonl`): the original ledger bytes
// are never touched. One link per ledger step, appended in lockstep:
//
//   { seq, op: <the runbook step verbatim>, prev: <previous link hash>,
//     hash: sha256(canonicalJson({seq, op, prev})) }
//
// A link is EXACTLY an organ receipt (`makeReceipt` in organ manifest.mjs)
// whose op is the run step — the step's own L2 chain fields (prev/id, run.js
// law) ride INSIDE the op, so the sidecar transitively pins the ledger's own
// hash chain as well. THE SEQ-BASE CORRECTION (the one place the "1:1" claim
// needed fixing, receipted in DESIGN.md §5): runbook steps are 1-BASED (L1),
// but organ receipt chains start at seq 0 anchored at "GENESIS" — organ
// validateManifest refuses a manifest whose receiptRange.start !== 0 at seq 0,
// and boot.mjs §4d requires the anchor manifest to start at 0. So the LINK seq
// is the 0-based ledger index; the STEP's 1-based seq rides verbatim in
// op.seq. cp.seq is therefore the link index, and the runbook-facing boundary
// is sealedThroughSeq = cp.seq + 1 (the step seq the seal covers through).
//
// THE PREFIX STATE a bare run.jsonl can prove: its STABLEPOINT ANCHORS. A
// runbook run's working state lives in mutable state.json (never signed
// directly); what the LEDGER itself proves at any boundary is the set of §5c
// stablepoints at or below it, each pinning snapshot bytes by state_hash (L5).
// The manifest's "cells" are exactly those anchors:
//   { "stablepoint/<seq>": { seq, label, state_hash, snapshot } }
// with organ cell kind "value" and per-cell sha256Json({kind:'value', value}).
// A prefix with no stablepoints proves no state and refuses to seal
// (SEAL_EMPTY_LEDGER — the runbook twin of chrono's no-writes refusal).
//
// CUSTODY LAW (mirrors organ spec §8 honestly): the signature vouches for the
// PREFIX — the stablepoint anchors at or below the boundary, the boundary
// chain tip, the organ identity. Post-boundary steps are guarded by the hash
// chain only (a fully re-hashed tail is a different fork, not a detectable
// forgery — same honest scope as the organ protocol; seal again to tighten
// the window). Where the snapshot files ride along (they do, in the run dir),
// the courtroom ALSO re-derives each anchored stablepoint's state: snapshot
// bytes must re-hash to the §5c state_hash (STABLEPOINT_HASH_MISMATCH /
// SNAPSHOT_MISSING, naming the seq — rewind.js L5 law, reused verbatim).
//
// THE REWIND FLOOR (organ rewind.mjs resolveTarget, mirrored): resumeFrom()
// on a sealed run verifies custody FIRST (the courtroom before anything
// materializes), then refuses a stablepoint that PRECEDES the sealed boundary
// with REWIND_PAST_CUSTODY naming the checkpoint. Resuming AT the boundary
// step is the legal case — that is the signed state itself (the organ seed
// equivalent). Honest scope: this floor is a POLICY guard (a handed-off seal
// asserts "the state at the boundary is the vouched line"; silently forking
// the live line from inside signed history would contradict the handoff), not
// an integrity requirement — the chain catches byte tampering regardless.
// DESIGN.md §5 receipts the rejected alternative.
//
// All error codes are named. Codes whose failure species exists in the organ
// protocol use the ORGAN's code (CHECKPOINT_*, CHAIN_GAP,
// RECEIPT_HASH_MISMATCH); runbook-side operational failures use SEAL_/CHAIN_-
// prefixed codes; snapshot re-derivation reuses rewind.js's codes
// (STABLEPOINT_HASH_MISMATCH / SNAPSHOT_MISSING) because it IS the L5 law.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateHash } from './canonical.js';
import { loadRun, stepId } from './run.js';

export const CHAIN_GENESIS = 'GENESIS';
export const CHAIN_SIDECAR_MARKER = '.chain.jsonl';
export const SEAL_FILE = 'run.seal.json';

// --- canonical JSON + sha256 -------------------------------------------------
// Organ-EXACT canonicalization (law: quilt-jev-toolkit src/organ/manifest.mjs
// canonicalJson). Sorted keys, no whitespace, fail-closed on undefined /
// bigint / function / symbol / non-finite numbers. The checkpoint signature
// covers these exact bytes, so byte-equality with the organ implementation is
// load-bearing — tests/seal.test.mjs cross-verifies it.
//
// WHY NOT src/canonical.js canonicalJSON (the honest divergence): that one
// SKIPS undefined object fields and stringifies non-finite numbers as null —
// fine for ledger bodies, but NOT byte-law-identical to the organ's
// fail-closed canonicalizer at exactly the edges where silent coercion hides
// tamper. The organ's law throws where runbook's forgives, and a signature
// must never forgive. Both agree on every JSON-safe value (tested), so ledger
// hashes and custody hashes never disagree in practice.

/** Deterministic JSON: recursively sorted object keys, no whitespace.
 *  Refuses (throws) values with no stable JSON meaning. */
export function canonicalJson(value, _path = '$') {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${_path} (fail-closed; JSON has no stable meaning for undefined)`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${_path}`);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    throw new TypeError(`canonicalJson: bigint at ${_path} (fail-closed; serialize explicitly as string)`);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalJson: ${typeof value} at ${_path} is not serializable (fail-closed)`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalJson(v, `${_path}[${i}]`)).join(',') + ']';
  }
  if (value instanceof Map) {
    return canonicalJson(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])), `${_path}#map`);
  }
  if (value instanceof Set) {
    return canonicalJson([...value.values()], `${_path}#set`);
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k], `${_path}.${k}`)).join(',') + '}';
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sha256Json(value) {
  return sha256Hex(canonicalJson(value));
}

function sealError(code, msg) {
  const err = new Error(`[${code}] ${msg}`);
  err.code = code;
  return err;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function keyBytes(key) {
  return typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
}

function badKey(key) {
  return key === undefined || key === null || key === '' || (typeof key === 'object' && key.length === 0);
}

// ---------------------------------------------------------------------------
// The chain: links are organ receipts whose op is the runbook step
// ---------------------------------------------------------------------------

/** Build one link (organ `makeReceipt` law: hash covers {seq, op, prev}).
 *  `seq` is the 0-BASED ledger index; the step rides verbatim as `op`
 *  (carrying its own 1-based seq, run_id, prev, id — see header). */
export function entryLink(seq, step, prevHash) {
  const op = JSON.parse(canonicalJson(step)); // frozen-safe verbatim copy
  const core = { seq, op, prev: prevHash };
  return { seq, op, prev: prevHash, hash: sha256Json(core) };
}

/** Recompute a link's content hash from its own fields (organ receiptHash). */
export function linkHash(link) {
  return sha256Json({ seq: link.seq, op: link.op, prev: link.prev });
}

/** Pure chain build over steps (a loadRun result or a plain steps array). */
export function buildChain(steps) {
  const list = steps && Array.isArray(steps.steps) ? steps.steps : steps;
  if (!Array.isArray(list)) throw sealError('SEAL_BAD_INPUT', 'buildChain needs a steps array or a loadRun result');
  const links = [];
  let prev = CHAIN_GENESIS;
  for (let i = 0; i < list.length; i++) {
    const link = entryLink(i, list[i], prev);
    links.push(link);
    prev = link.hash;
  }
  return links;
}

/** The chain tip: last link's hash (bare sha256 hex — the organ checkpoint's
 *  `hash` field is unprefixed hex64). Empty chain has no tip. */
export function chainTip(links) {
  return links.length ? links[links.length - 1].hash : null;
}

/**
 * Verify a contiguous, hash-linked link chain (organ verifyChain law, same
 * codes: CHAIN_GAP / RECEIPT_HASH_MISMATCH). Throws named errors — fail-closed.
 * Because runbook steps are 1-based but link seqs are 0-based, messages name
 * BOTH ("at link seq 5 (runbook step 6)"). Returns { ok: true, tipHash, count }.
 */
export function verifyChainLinks(links, { expectedStart = 0, expectedPrev = CHAIN_GENESIS } = {}) {
  if (!Array.isArray(links)) throw sealError('CHAIN_GAP', 'links is not an array');
  let expected = expectedPrev;
  for (let i = 0; i < links.length; i++) {
    const r = links[i];
    if (!r || typeof r !== 'object') throw sealError('CHAIN_GAP', `link #${i} is not an object`);
    if (r.seq !== expectedStart + i) {
      throw sealError('CHAIN_GAP', `seq discontinuity at index ${i}: expected ${expectedStart + i}, got ${JSON.stringify(r.seq)}`);
    }
    if (r.prev !== expected) {
      throw sealError('CHAIN_GAP', `prev-hash break at link seq ${r.seq} (runbook step ${r.seq + 1}): expected ${expected}, got ${r.prev}`);
    }
    const recomputed = linkHash(r);
    if (recomputed !== r.hash) {
      throw sealError('RECEIPT_HASH_MISMATCH', `hash mismatch at link seq ${r.seq} (runbook step ${r.seq + 1}): recomputed ${recomputed}, carried ${r.hash} — the chained step was edited after sealing`);
    }
    expected = r.hash;
  }
  return { ok: true, tipHash: expected, count: links.length };
}

// --- sidecar + seal file paths ----------------------------------------------

/** Sidecar path for a run dir: runs/<id>/run.chain.jsonl. */
export function chainFileFor(runDir) {
  if (typeof runDir !== 'string' || runDir.length === 0) {
    throw sealError('SEAL_BAD_INPUT', 'chainFileFor needs the run directory path');
  }
  return path.join(runDir, 'run' + CHAIN_SIDECAR_MARKER);
}

/** Seal document path for a run dir: runs/<id>/run.seal.json (the LATEST
 *  anchor; superseded seals stay verifiable against the append-only sidecar). */
export function sealFileFor(runDir) {
  if (typeof runDir !== 'string' || runDir.length === 0) {
    throw sealError('SEAL_BAD_INPUT', 'sealFileFor needs the run directory path');
  }
  return path.join(runDir, SEAL_FILE);
}

/** Read + fully verify a sidecar file. Throws on any broken link. */
export function readChainSidecar(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw sealError('CHAIN_SIDECAR_MISSING', `cannot read chain sidecar ${file}: ${e.message}`);
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const links = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw sealError('CHAIN_BAD_LINK', `sidecar line ${i + 1} unparseable: ${err.message}`);
    }
  });
  const verdict = verifyChainLinks(links);
  return { links, tipHash: verdict.tipHash };
}

/**
 * Write the sidecar so it covers `links` — APPEND-ONLY by construction:
 *   - an existing sidecar must be BYTE-IDENTICAL to the corresponding prefix
 *     of what we would write (any divergence → CHAIN_REWRITE_REFUSED; we never
 *     rewrite history, fail-closed),
 *   - an existing sidecar must itself verify as a chain before we extend it,
 *   - only the missing tail is appended. The original run.jsonl is never
 *     opened for writing by this module.
 * Returns { appended, total }.
 */
export function writeChainSidecar(file, links) {
  const wanted = links.map((l) => canonicalJson(l));
  const wantedText = wanted.length ? wanted.join('\n') + '\n' : '';
  let existing = null;
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');

  if (existing !== null) {
    const existingLinks = existing.split('\n').filter((l) => l.trim().length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw sealError('CHAIN_BAD_LINK', `sidecar line ${i + 1} unparseable: ${err.message}`);
        }
      });
    verifyChainLinks(existingLinks); // never extend a broken chain
    if (!wantedText.startsWith(existing)) {
      throw sealError('CHAIN_REWRITE_REFUSED',
        `sidecar ${file} diverges from the chain the current ledger steps imply — append-only law: refusing to rewrite existing links`);
    }
    const appended = wanted.length - existingLinks.length;
    if (appended < 0) {
      throw sealError('CHAIN_REWRITE_REFUSED', `sidecar ${file} carries ${existingLinks.length} links but the ledger implies ${wanted.length} — refusing to truncate`);
    }
    if (appended > 0) fs.appendFileSync(file, wanted.slice(existingLinks.length).join('\n') + '\n', 'utf8');
    return { appended, total: wanted.length };
  }

  fs.writeFileSync(file, wantedText, { encoding: 'utf8', flag: 'wx' }); // create-only
  return { appended: wanted.length, total: wanted.length };
}

// ---------------------------------------------------------------------------
// The prefix custody state: the run's stablepoint anchors
// ---------------------------------------------------------------------------

/**
 * Fold stablepoint steps ≤ boundaryIdx into the anchored cells map — the
 * state a bare run.jsonl PROVES at that boundary (working state.json is
 * mutable; §5c stablepoints are the ledger's own pins). Deterministic; keys
 * sorted at use site. Throws CHECKPOINT_SEQ_OUT_OF_RANGE for a bad boundary.
 */
export function stablepointsAt(steps, boundaryIdx) {
  const list = steps && Array.isArray(steps.steps) ? steps.steps : steps;
  if (!Array.isArray(list)) throw sealError('SEAL_BAD_INPUT', 'stablepointsAt needs a steps array or a loadRun result');
  if (!Number.isInteger(boundaryIdx) || boundaryIdx < 0 || boundaryIdx >= list.length) {
    throw sealError('CHECKPOINT_SEQ_OUT_OF_RANGE', `boundary seq ${JSON.stringify(boundaryIdx)} outside the carried range [0, ${list.length - 1}]`);
  }
  const cells = {};
  for (let i = 0; i <= boundaryIdx; i++) {
    const s = list[i];
    if (s && s.op === 'stablepoint' && s.payload) {
      cells[`stablepoint/${s.payload.seq}`] = {
        seq: s.payload.seq,
        label: s.payload.label,
        state_hash: s.payload.state_hash,
        snapshot: s.payload.snapshot,
      };
    }
  }
  if (Object.keys(cells).length === 0) {
    throw sealError('SEAL_EMPTY_LEDGER', `the sealed prefix proves no stablepoint state at or below seq ${boundaryIdx} — a bare-ledger seal anchors §5c stablepoints only (take a stablepoint first)`);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// sealRun — mint an organ-checkpoint-EXACT custody anchor for a run ledger
// ---------------------------------------------------------------------------

/** Compact fail-closed-at-mint validation of the seal's own manifest (the
 *  closed shape sealRun builds). The organ toolkit's validateManifest is the
 *  reference law; the interop test cross-checks equivalence. */
function validateSealManifest(manifest) {
  const errors = [];
  const bad = (d) => errors.push(d);
  if (manifest.schema !== 'quilt.organ.manifest' || manifest.schemaVersion !== 1) {
    bad(`schema drift: ${manifest.schema}/${manifest.schemaVersion}`);
  }
  if (typeof manifest.organId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}@[0-9a-f]{16}$/.test(manifest.organId)) {
    bad(`organId must match name@16hex, got ${JSON.stringify(manifest.organId)}`);
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) bad('name must be a non-empty string');
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) bad('cells must be a non-empty array');
  else for (const c of manifest.cells) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) bad('cell entry missing id');
    else if (typeof c.stateHash !== 'string' || !HEX64.test(c.stateHash)) bad(`cell ${c.id} stateHash not sha256 hex`);
    else if (c.kind !== 'value') bad(`cell ${c.id}: a bare-ledger seal proves stablepoint anchors (kind "value"), got ${JSON.stringify(c.kind)}`);
  }
  if (!Array.isArray(manifest.edges)) bad('edges must be an array');
  const rr = manifest.receiptRange;
  if (!rr || !Number.isInteger(rr.start) || !Number.isInteger(rr.end) || !Number.isInteger(rr.count)
      || rr.start !== 0 || rr.end < rr.start || rr.count !== rr.end + 1) {
    bad(`receiptRange inconsistent: ${JSON.stringify(rr)}`);
  }
  if (!manifest.genesis || manifest.genesis.seq !== 0 || manifest.genesis.prevHash !== CHAIN_GENESIS) {
    bad('genesis must be {seq: 0, prevHash: "GENESIS"} for a full-prefix seal');
  }
  if (!manifest.state || !HEX64.test(manifest.state?.cellsSha256 ?? '')) bad('state.cellsSha256 must be sha256 hex');
  if (manifest.supersedes !== null && (typeof manifest.supersedes !== 'string' || !HEX64.test(manifest.supersedes))) {
    bad('supersedes must be null or a sha256 manifestHash');
  }
  if (errors.length) {
    const err = sealError('SEAL_MANIFEST_INVALID', `seal produced an invalid manifest (fail-closed): ${errors.join(' | ')}`);
    err.errors = errors;
    throw err;
  }
}

/**
 * Mint a signed custody seal for a run directory.
 *
 * The ledger is re-read and FULLY verified first (loadRun — L2 hash law):
 * a seal is never minted over an unproven ledger.
 *
 * @param runDir  the run directory (runs/<run_id>/)
 * @param opts {
 *   key         REQUIRED non-empty string|Buffer — the minter's HMAC key
 *   seq         boundary as the 0-BASED sidecar link index (default: last
 *               step — a checkpoint at the tip is legal, organ spec §8.4.6);
 *               the runbook-facing boundary is sealedThroughSeq = seq + 1
 *   chainFile   sidecar path; default chainFileFor(runDir)
 *   sealFile    seal document path; default sealFileFor(runDir); pass null
 *               to mint without writing the file (sidecar still written)
 *   name        organ name (default the run_id; must match
 *               [a-z0-9][a-z0-9._-]* — pass a lowercase name for uppercase ids)
 *   organId     carry identity forward from an earlier seal (organ law:
 *               identity is carried, not re-minted)
 *   supersedes  prior seal's manifestHash — honest lineage (defaults to the
 *               prior run.seal.json's manifestHash when one exists)
 * }
 * @returns { checkpoint, links, chainFile, sealFile, appended, sealedThroughSeq }
 *   `checkpoint` is byte-shape-EXACTLY the organ v2 signed checkpoint —
 *   no runbook-specific fields added (drift is how parallel standards start).
 */
export function sealRun(runDir, opts = {}) {
  const { key, seq = null, chainFile = null, sealFile = undefined, name = null, organId = null, supersedes = undefined } = opts;
  if (badKey(key)) {
    throw sealError('CHECKPOINT_SIGNATURE_REQUIRED', 'sealRun: signing needs a non-empty key (string or Buffer)');
  }
  const ledgerFile = path.join(runDir, 'run.jsonl');
  if (!fs.existsSync(ledgerFile)) {
    throw sealError('SEAL_BAD_INPUT', `sealRun: ${runDir} is not a run directory (run.jsonl missing)`);
  }

  // 0. never sign an unproven ledger (L2 verified, names the seq on tamper)
  const { steps, runId } = loadRun(runDir);
  if (steps.length === 0) {
    throw sealError('SEAL_EMPTY_LEDGER', 'sealRun: refusing an empty ledger (no custody = no organ — organ snapshot law)');
  }
  const boundary = seq === null ? steps.length - 1 : seq;
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= steps.length) {
    throw sealError('CHECKPOINT_SEQ_OUT_OF_RANGE', `checkpoint boundary seq ${JSON.stringify(seq)} is outside the carried range [0, ${steps.length - 1}]`);
  }
  // name is validated BEFORE any byte is written: a refused seal must not leave
  // an orphan sidecar behind (a sidecar without its seal doc reads as a broken
  // custody claim to resumeFrom's gate)
  const organName = name ?? runId;
  if (typeof organName !== 'string' || !NAME_OK.test(organName)) {
    throw sealError('SEAL_BAD_NAME', `organ name must match ${NAME_OK} (lowercase id the manifest law can carry) — run_id ${JSON.stringify(organName)} does not; pass opts.name explicitly`);
  }

  // 1. the chain (extend the sidecar honestly if one is in play)
  const links = buildChain(steps);
  const sidecarFile = chainFile ?? chainFileFor(runDir);
  const appended = writeChainSidecar(sidecarFile, links).appended;

  // 2. the prefix custody manifest — quilt.organ.manifest/v1, built to pass
  //    the organ toolkit's own validateManifest (proven by the interop test).
  const cells = stablepointsAt(steps, boundary);
  const cellIds = Object.keys(cells).sort();
  const cellsSha256 = sha256Json(cells);
  const tipHash = links[boundary].hash;
  const mintedId = `${organName}@${sha256Json({ name: organName, material: { cellsSha256, tipHash, startSeq: 0, genesisPrevHash: CHAIN_GENESIS } }).slice(0, 16)}`;

  // honest lineage: an existing seal document is superseded by the new anchor
  const sFile = sealFile === undefined ? sealFileFor(runDir) : sealFile;
  let lineage = { organId: null, supersedes: null };
  if (sFile && fs.existsSync(sFile)) {
    try {
      const prior = JSON.parse(fs.readFileSync(sFile, 'utf8'));
      lineage = { organId: prior?.manifest?.organId ?? null, supersedes: prior?.manifestHash ?? null };
    } catch { /* unreadable prior seal: lineage starts fresh; the sidecar still proves history */ }
  }

  const manifest = {
    schema: 'quilt.organ.manifest',
    schemaVersion: 1,
    organId: organId ?? lineage.organId ?? mintedId, // identity is carried, not re-minted (organ law)
    name: organName,
    cells: cellIds.map((id) => ({ id, kind: 'value', stateHash: sha256Json({ kind: 'value', value: cells[id] }) })),
    edges: [], // a bare-ledger seal proves stablepoint anchors; flow edges are a projection concern (DESIGN.md §5)
    receiptRange: { start: 0, end: boundary, count: boundary + 1 },
    genesis: { seq: 0, prevHash: CHAIN_GENESIS },
    state: { cellsSha256 },
    supersedes: (supersedes !== undefined ? supersedes : lineage.supersedes) ?? null,
  };
  validateSealManifest(manifest);
  const manifestHash = sha256Json(manifest);
  manifest.manifestHash = manifestHash;

  // 3. the signed checkpoint — organ v2 EXACT: HMAC-SHA256 over
  //    canonical({hash, manifestHash, seq}) (boot.mjs checkpointSigningPayload).
  const cp = {
    schema: 'quilt.organ.checkpoint',
    schemaVersion: 1,
    alg: 'HMAC-SHA256',
    seq: boundary,
    hash: tipHash,
    manifestHash,
  };
  cp.sig = crypto.createHmac('sha256', keyBytes(key)).update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
  cp.manifest = JSON.parse(canonicalJson(manifest));

  // 4. the seal document (the LATEST anchor). Atomic tmp+rename: a reader
  //    never sees a half-written seal. Superseded seals remain verifiable
  //    against the append-only sidecar — the document is a pointer, like
  //    state.json is the newest state.
  if (sFile) {
    const tmp = sFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, canonicalJson(cp) + '\n', 'utf8');
    fs.renameSync(tmp, sFile);
  }

  return { checkpoint: cp, links, chainFile: sidecarFile, sealFile: sFile, appended, sealedThroughSeq: boundary + 1 };
}

// ---------------------------------------------------------------------------
// verify — the courtroom, before anything resumes
// ---------------------------------------------------------------------------

/**
 * Verify a sealed checkpoint's structure + signature (organ boot.mjs
 * verifySignedCheckpoint law — same codes, same bytes):
 *   CHECKPOINT_SIGNATURE_REQUIRED / CHECKPOINT_MALFORMED /
 *   CHECKPOINT_SIGNATURE_INVALID.
 * Returns { ok: true, seq, chainTip, manifestHash }.
 */
export function verifySeal(cp, key) {
  if (badKey(key)) {
    throw sealError('CHECKPOINT_SIGNATURE_REQUIRED', 'no usable checkpoint key was provided — an HMAC signature cannot verify without it');
  }
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
    throw sealError('CHECKPOINT_MALFORMED', 'checkpoint is not an object');
  }
  if (cp.schema !== 'quilt.organ.checkpoint' || cp.schemaVersion !== 1) {
    throw sealError('CHECKPOINT_MALFORMED', `checkpoint schema ${JSON.stringify(cp.schema)}/${JSON.stringify(cp.schemaVersion)} not implemented (knows only quilt.organ.checkpoint/1)`);
  }
  if (cp.alg !== 'HMAC-SHA256') {
    throw sealError('CHECKPOINT_MALFORMED', `checkpoint alg ${JSON.stringify(cp.alg)} not implemented (knows only HMAC-SHA256; Ed25519 is the organ v3 path)`);
  }
  if (!Number.isInteger(cp.seq) || cp.seq < 0) {
    throw sealError('CHECKPOINT_MALFORMED', `checkpoint seq must be a non-negative integer, got ${JSON.stringify(cp.seq)}`);
  }
  for (const field of ['hash', 'manifestHash', 'sig']) {
    if (typeof cp[field] !== 'string' || !HEX64.test(cp[field])) {
      throw sealError('CHECKPOINT_MALFORMED', `checkpoint ${field} missing or not sha256 hex`);
    }
  }
  const expected = crypto.createHmac('sha256', keyBytes(key)).update(canonicalJson({ hash: cp.hash, manifestHash: cp.manifestHash, seq: cp.seq }), 'utf8').digest('hex');
  if (expected !== cp.sig) {
    throw sealError('CHECKPOINT_SIGNATURE_INVALID', 'HMAC does not verify under the provided key — forged signature, tampered signed fields, or wrong key');
  }
  return { ok: true, seq: cp.seq, chainTip: cp.hash, manifestHash: cp.manifestHash };
}

/**
 * Full custody verification — call BEFORE resuming from a sealed run:
 *   1. verifySeal (structure + HMAC under the verifier's key)
 *   2. the chain source verifies (every link re-hashes; CHAIN_GAP /
 *      RECEIPT_HASH_MISMATCH at the first broken offset — any tamper, any
 *      offset, named with BOTH the link seq and the runbook step seq)
 *   3. the chain tip at cp.seq IS cp.hash (CHECKPOINT_ANCHOR_MISMATCH — the
 *      signature pins this exact boundary; a re-hashed forgery chain lands
 *      here, matching organ spec §8's "honest scope of the anchor")
 *   4. the carried prefix manifest re-hashes to the SIGNED manifestHash and
 *      obeys manifest law (CHECKPOINT_ANCHOR_MISMATCH / SEAL_MANIFEST_INVALID)
 *   5. replaying the steps the chain carries reproduces the anchored
 *      stablepoint set, each chained step's own L2 id re-verifies
 *      (CHECKPOINT_SEED_MISMATCH / RUN_LEDGER_TAMPER)
 *   6. if `steps`/`runDir` given: the sidecar must describe THAT ledger
 *      step-for-step (CHAIN_ENTRY_MISMATCH), and the boundary must be
 *      within it (CHECKPOINT_SEQ_BEYOND_RECEIPTS)
 *   7. with `runDir`: every anchored stablepoint's snapshot bytes re-hash to
 *      its §5c state_hash (STABLEPOINT_HASH_MISMATCH / SNAPSHOT_MISSING,
 *      naming the seq — the L5 law applied to the whole anchored prefix)
 *
 * @param cp     the sealed checkpoint (organ v2 shape)
 * @param key    the verifier's key — same secret the minter used (HMAC)
 * @param src    { links | chainFile, steps | runDir } — at least one chain
 *               source is required; steps are the recommended second witness
 * @returns { ok, seq, chainTip, manifestHash, cells, sealedThroughSeq } —
 *          `cells` is the signature-anchored stablepoint map;
 *          `sealedThroughSeq` is the runbook-facing step-seq boundary
 *          (cp.seq + 1 — the custody floor resumeFrom enforces).
 */
export function verifyCustody(cp, key, src = {}) {
  const verdict = verifySeal(cp, key);

  const links = src.links ?? (src.chainFile ? readChainSidecar(src.chainFile).links : null);
  if (!links) {
    throw sealError('SEAL_NO_CHAIN_SOURCE', 'verifyCustody needs a chain source (links or chainFile) — a signature alone proves nothing');
  }
  verifyChainLinks(links);

  if (cp.seq >= links.length) {
    throw sealError('CHECKPOINT_SEQ_BEYOND_RECEIPTS', `checkpoint anchors seq ${cp.seq}, beyond the carried chain (last link seq ${links.length - 1})`);
  }
  if (links[cp.seq].hash !== cp.hash) {
    throw sealError('CHECKPOINT_ANCHOR_MISMATCH', `checkpoint pins chainTip ${cp.hash} at seq ${cp.seq}, but the verified chain carries ${links[cp.seq].hash} — wrong chain, wrong boundary, or a re-hashed forgery`);
  }

  // the anchor manifest: content-addressed to the SIGNED manifestHash
  const anchor = cp.manifest;
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    throw sealError('CHECKPOINT_ANCHOR_MISMATCH', 'signed checkpoint carries no prefix manifest — the sealed state cannot be anchored');
  }
  const carried = { ...anchor };
  const carriedHash = carried.manifestHash;
  delete carried.manifestHash;
  if (carriedHash !== cp.manifestHash || sha256Json(carried) !== cp.manifestHash) {
    throw sealError('CHECKPOINT_ANCHOR_MISMATCH', `checkpoint prefix manifest does not re-hash to the signed manifestHash ${cp.manifestHash} — swapped or tampered anchor`);
  }
  validateSealManifest(carried);

  // replay the prefix from the chain itself: the stablepoint anchors, each
  // chained step's own L2 id re-verified (the op claims to BE a runbook step)
  const cells = {};
  for (let i = 0; i <= cp.seq; i++) {
    const s = links[i].op;
    if (!s || typeof s !== 'object' || s.run_id === undefined) {
      throw sealError('CHAIN_ENTRY_MISMATCH', `sidecar link at seq ${i} does not carry a runbook step — the chain was not built from a run ledger`);
    }
    if (s.id !== stepId(s.run_id, s)) {
      const err = sealError('RUN_LEDGER_TAMPER', `chained step at link seq ${i} (runbook step ${s.seq}) has an id that does not match its content — the chain describes a step that was never in a valid ledger`);
      err.seq = s.seq;
      throw err;
    }
    if (s.op === 'stablepoint' && s.payload) {
      cells[`stablepoint/${s.payload.seq}`] = {
        seq: s.payload.seq,
        label: s.payload.label,
        state_hash: s.payload.state_hash,
        snapshot: s.payload.snapshot,
      };
    }
  }
  const cellsSha256 = sha256Json(cells);
  if (cellsSha256 !== anchor.state.cellsSha256) {
    throw sealError('CHECKPOINT_SEED_MISMATCH', `replay of the chain's steps produces stablepoint anchors ${cellsSha256}, the signature-anchored prefix state claims ${anchor.state.cellsSha256}`);
  }
  for (const c of anchor.cells) {
    if (!cells[c.id] || sha256Json({ kind: 'value', value: cells[c.id] }) !== c.stateHash) {
      throw sealError('CHECKPOINT_SEED_MISMATCH', `cell ${c.id}: replayed anchors do not match the anchored stateHash — seed tamper`);
    }
  }

  // second witness: the sidecar must describe the caller's ledger exactly
  const steps = src.steps ?? (src.runDir ? loadRun(src.runDir).steps : null);
  if (steps) {
    if (cp.seq >= steps.length) {
      throw sealError('CHECKPOINT_SEQ_BEYOND_RECEIPTS', `checkpoint anchors seq ${cp.seq}, beyond the carried ledger (last step seq ${steps.length})`);
    }
    for (let i = 0; i <= cp.seq; i++) {
      if (canonicalJson(links[i].op) !== canonicalJson(steps[i])) {
        throw sealError('CHAIN_ENTRY_MISMATCH', `sidecar link at seq ${i} (runbook step ${i + 1}) no longer describes the ledger step it was built from — the chain and the ledger have diverged`);
      }
    }
  }

  // third witness (the runbook-specific one): the anchored snapshots, re-derived
  if (src.runDir) {
    for (let i = 0; i <= cp.seq; i++) {
      const s = links[i].op;
      if (s.op !== 'stablepoint') continue;
      const snapRel = s.payload.snapshot;
      const snapAbs = path.resolve(src.runDir, snapRel);
      if (!snapAbs.startsWith(path.resolve(src.runDir) + path.sep)) {
        const err = sealError('SNAPSHOT_MISSING', `stablepoint seq ${s.payload.seq} snapshot path escapes the run dir: ${snapRel}`);
        err.seq = s.payload.seq;
        throw err;
      }
      if (!fs.existsSync(snapAbs)) {
        const err = sealError('SNAPSHOT_MISSING', `anchored stablepoint seq ${s.payload.seq} (label "${s.payload.label}") snapshot file missing: ${snapRel} — the sealed prefix cannot be re-derived from this run dir`);
        err.seq = s.payload.seq;
        throw err;
      }
      const actual = stateHash(fs.readFileSync(snapAbs));
      if (actual !== s.payload.state_hash) {
        const err = sealError('STABLEPOINT_HASH_MISMATCH',
          `anchored stablepoint seq ${s.payload.seq} (label "${s.payload.label}"): recorded ${s.payload.state_hash} but snapshot bytes hash to ${actual} — ` +
          `the snapshot was corrupted or swapped after the seal (L5 law, applied to the signed prefix)`);
        err.seq = s.payload.seq;
        throw err;
      }
    }
  }

  return { ...verdict, cells, sealedThroughSeq: cp.seq + 1 };
}

/**
 * Convenience courtroom for a run directory: reads the LATEST seal document
 * (run.seal.json — or `opts.seal`), the sidecar, and the ledger from disk and
 * runs the full custody verification including snapshot re-derivation.
 * This is what resumeFrom() calls before anything materializes.
 * Returns { ok, seq, chainTip, manifestHash, cells, sealedThroughSeq, steps, runId }.
 */
export function verifyRunCustody(runDir, opts = {}) {
  const sFile = opts.sealFile ?? sealFileFor(runDir);
  let cp = opts.seal ?? null;
  if (!cp) {
    if (!fs.existsSync(sFile)) {
      throw sealError('CUSTODY_SEAL_MISSING', `no seal document at ${sFile} — a run with a chain sidecar must carry its seal (re-mint with sealRun)`);
    }
    try {
      cp = JSON.parse(fs.readFileSync(sFile, 'utf8'));
    } catch (e) {
      throw sealError('CHECKPOINT_MALFORMED', `seal document ${sFile} is not valid JSON: ${e.message}`);
    }
  }
  const { steps, runId } = loadRun(runDir); // L2 verified first, names the seq
  const verdict = verifyCustody(cp, opts.key, {
    chainFile: opts.chainFile ?? chainFileFor(runDir),
    steps,
    runDir,
  });
  return { ...verdict, steps, runId };
}
