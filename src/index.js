// src/index.js — quilt-runbook public surface.
//
// run.js    — append-only, hash-chained run ledger (§5a/§5c contract shapes)
// rewind.js — resume a run from a stable point (history never rewritten)
// mine.js   — WHY-decomposition: adjustments -> compiled_cell proposals
// replay.js — deterministic re-execution from a stable point + state adjustment
// seal.js   — signed run custody: chain sidecar + organ-checkpoint-EXACT seals

export { OPS, Run, createRun, openRun, loadRun, nowIso, stepId } from './run.js';
export { resumeFrom } from './rewind.js';
export { mineRun, hypothesisKeywords } from './mine.js';
export { replayRun, recordReplayable } from './replay.js';
export { canonicalJSON, sha256Hex, sha256Id, stateHash } from './canonical.js';
export {
  CHAIN_GENESIS,
  canonicalJson,
  entryLink, linkHash, buildChain, chainTip, verifyChainLinks,
  chainFileFor, sealFileFor, readChainSidecar, writeChainSidecar,
  stablepointsAt, sealRun, verifySeal, verifyCustody, verifyRunCustody,
} from './seal.js';
