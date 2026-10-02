// tests/helpers.mjs — shared fixtures for the quilt-runbook test battery.
// NO NETWORK anywhere: every test is stdlib + local disk only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fresh scratch dir per test file, inside the repo (never /tmp, fleet law). */
export function scratch(name) {
  const dir = path.join(HERE, '.tmp', name + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 7));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Standard valid §5a adjustment record body (caller may override fields). */
export function adj(over = {}) {
  return {
    target: over.target ?? { cell_id: 'cell-1', sheet: 's1' },
    before: over.before ?? null,
    after: over.after ?? { fix: true },
    why: over.why ?? { trigger: 'symptom', hypothesis: 'root cause guess here', evidence: ['e1'] },
    generalizes: over.generalizes ?? true,
    ...(over.compiled_cell !== undefined ? { compiled_cell: over.compiled_cell } : {}),
  };
}
