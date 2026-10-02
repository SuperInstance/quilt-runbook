#!/usr/bin/env node
// scripts/keyscan.mjs — credential-pattern scanner for cot-quilt (incident 2026-10-01).
//
// WHY THIS EXISTS: the rolled deepseek credential leaked into a committed receipt via
// an unsanitized exception string (see SECURITY-INCIDENT.md). Fleet law now requires a
// pre-push key scan on every push of this repo.
//
// WHAT IT SCANS (default, no args):
//   1. HEAD tree          — `git grep` over the committed tree (what the public sees)
//   2. staged diff        — added lines of `git diff --cached -U0` (what is about to go)
//   3. worktree           — tracked files + untracked-but-not-ignored files (respects .gitignore)
// PATTERNS (credential classes): gsk_, sk-, ghp_, github_pat_, apikey_, moth_, cfut_
//   (length guards chosen so benign identifiers like the function name `moth_seeds`
//    do NOT match — only credential-shaped strings do.)
//
// OUTPUT DISCIPLINE: matched VALUES are NEVER printed — output is
//   `<source> <file>:<line> <class> len=<n>` plus a masked snippet where the match is
//   replaced by [<class>@len]. This scanner must never become the leak.
//
// EXIT CODE: 0 = clean OR every hit matches a suppression entry below (printed as
//   RECEIPTED-BENIGN with its justification). 1 = any un-receipted hit. 2 = usage error.
//
// ZERO-SHOT AGENT USAGE (the pre-push ritual):
//   node scripts/keyscan.mjs          # must print CLEAN or only RECEIPTED-BENIGN rows
//   # paste the summary line into your push receipt; then push with the token discipline:
//   # embed token -> push -> git ls-remote verify remote==local -> scrub URL -> unset helper
//
// Add suppressions ONLY with a written justification + pointer to SECURITY-INCIDENT.md.
// A suppression means "known, inert, receipted" — it never means "ignore the future".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// ------------------------- pattern table -------------------------
const PATTERNS = [
  { cls: 'gsk_',        re: /gsk_[A-Za-z0-9_-]{8,}/g },
  { cls: 'sk-',         re: /sk-[A-Za-z0-9_-]{20,}/g },
  { cls: 'ghp_',        re: /ghp_[A-Za-z0-9]{20,}/g },
  { cls: 'github_pat_', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { cls: 'apikey_',     re: /apikey_[A-Za-z0-9_]{8,}/g },
  { cls: 'moth_',       re: /moth_[A-Za-z0-9]{8,}/g },
  { cls: 'cfut_',       re: /cfut_[A-Za-z0-9_-]{8,}/g },
];

// --------------------- receipted-benign suppressions ---------------------
// Each entry: file (substring match), cls, reason. Keep this table SHORT and honest.
const SUPPRESSED = [
  {
    file: 'runs/20261001T195410Z-503b10b9/receipt.json',
    cls: 'sk-',
    reason: 'the inert rolled deepseek credential embedded in a sealed receipt\'s ' +
            'fallback_reason at commit 677484d (incident 2026-10-01); credential is ' +
            'DEAD (rolled by principal); file left verbatim per never-delete-data law ' +
            '— full record in SECURITY-INCIDENT.md',
  },
];

// ------------------------------ helpers ------------------------------
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (allowFail) return '';
    throw e;
  }
}

function scanText(text, sourceLabel, file) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { cls, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const val = m[0];
        hits.push({
          source: sourceLabel,
          file,
          line: i + 1,
          cls,
          len: val.length,
          snippet: line.slice(0, 160).replace(val, `[${cls}@len${val.length}]`),
        });
      }
    }
  }
  return hits;
}

function classify(hit) {
  const found = SUPPRESSED.find((s) => s.cls === hit.cls && hit.file && hit.file.includes(s.file));
  return found ? { benign: true, reason: found.reason } : { benign: false };
}

// ------------------------------ scanners ------------------------------
function scanHeadTree() {
  const args = ['grep', '-nIE'];
  for (const { re } of PATTERNS) args.push('-e', re.source);
  const out = git(args.concat(['HEAD']), { allowFail: true });
  const hits = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = line.match(/^HEAD:(.*?):(\d+):(.*)$/s);
    if (!m) continue;
    const [, file, lineno, content] = m;
    for (const { cls, re } of PATTERNS) {
      re.lastIndex = 0;
      const hit = re.exec(content);
      if (hit) {
        hits.push({
          source: 'HEAD', file, line: Number(lineno), cls, len: hit[0].length,
          snippet: content.slice(0, 160).replace(hit[0], `[${cls}@len${hit[0].length}]`),
        });
      }
    }
  }
  return hits;
}

function scanStagedDiff() {
  const out = git(['diff', '--cached', '-U0'], { allowFail: true });
  const hits = [];
  let curFile = null;
  for (const line of out.split('\n')) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { curFile = fm[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const { cls, re } of PATTERNS) {
      re.lastIndex = 0;
      const hit = re.exec(line);
      if (hit) {
        hits.push({
          source: 'staged', file: curFile, line: null, cls, len: hit[0].length,
          snippet: line.slice(0, 160).replace(hit[0], `[${cls}@len${hit[0].length}]`),
        });
      }
    }
  }
  return hits;
}

function scanWorktree() {
  const files = git(['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(path.join(REPO, f), 'utf8'); } catch { continue; }
    for (const h of scanText(text, 'worktree', f)) hits.push(h);
  }
  return hits;
}

function scanExplicitPaths(paths) {
  const hits = [];
  for (const f of paths) {
    let text;
    try { text = readFileSync(path.resolve(f), 'utf8'); } catch { continue; }
    for (const h of scanText(text, 'explicit', f)) hits.push(h);
  }
  return hits;
}

// -------------------------------- main --------------------------------
const argv = process.argv.slice(2);
let hits;
if (argv[0] === '--paths') {
  const paths = argv.slice(1);
  if (!paths.length) { console.error('usage: keyscan.mjs --paths <file>...'); process.exit(2); }
  hits = scanExplicitPaths(paths);
} else if (argv.length === 0) {
  hits = [...scanHeadTree(), ...scanStagedDiff(), ...scanWorktree()];
} else {
  console.error('usage: keyscan.mjs [--paths <file>...]'); process.exit(2);
}

// Deduplicate identical (source,file,line,cls) rows.
const seen = new Set();
const uniq = hits.filter((h) => {
  const k = `${h.source}|${h.file}|${h.line}|${h.cls}|${h.len}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

let benign = 0, bad = 0;
for (const h of uniq) {
  const c = classify(h);
  const where = `${h.file ?? '<unknown>'}${h.line ? ':' + h.line : ''}`;
  if (c.benign) {
    benign++;
    console.log(`RECEIPTED-BENIGN ${h.source} ${where} ${h.cls} len=${h.len}`);
    console.log(`  reason: ${c.reason}`);
  } else {
    bad++;
    console.log(`HIT ${h.source} ${where} ${h.cls} len=${h.len}`);
    console.log(`  snippet: ${h.snippet}`);
  }
}

console.log('---');
console.log(`keyscan summary: ${uniq.length} hit(s): ${benign} receipted-benign, ${bad} UNRECEIPTED; ` +
  `scopes=${argv[0] === '--paths' ? 'explicit' : 'HEAD+staged+worktree'} at ${new Date().toISOString()}`);
console.log(`verdict: ${bad === 0 ? 'CLEAN (all hits receipted or none found)' : 'FAIL — do not push'}`);
process.exit(bad === 0 ? 0 : 1);
