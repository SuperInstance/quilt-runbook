// src/canonical.js — the two primitives every runbook law is built on:
//   canonicalJSON: stable, key-sorted JSON so hashes are reproducible across
//                  processes/machines (no reliance on object insertion order).
//   sha256Hex / stateHash: content addressing for ledger steps and state files.
//
// Stdlib only. No IO here — pure functions, trivially testable.

import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // undefined fields do not exist in canonical form
    parts.push(JSON.stringify(k) + ':' + canonicalJSON(v));
  }
  return '{' + parts.join(',') + '}';
}

export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Content address form used everywhere in this package: "sha256:<hex>". */
export function sha256Id(str) {
  return 'sha256:' + sha256Hex(str);
}

/** Hash of a state file's EXACT bytes (what was written, not what was meant). */
export function stateHash(bytes) {
  return sha256Id(typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
}
