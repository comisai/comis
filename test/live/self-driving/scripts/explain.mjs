// explain.mjs — offline IncidentReport read for ONE session (the obs ground-truth oracle).
//
// Runs `assembleIncidentReportFromSources` off the DEPLOYED dist and prints the diagnostic fields, so you
// stop hand-writing `node -e 'assembleIncidentReportFromSources(...)'` one-liners — and stop hitting the
// three traps that cost cycles:
//   1. .mjs-vs-.cjs   — the dist index is CJS; a `.mjs` + `require` throws (ESM loader).
//   2. quote-escaping — the deep `ssh → su - comis -c "node -e '…'"` nesting mangles the session key.
//   3. run-as-root    — HOME=/root → the reader SILENTLY returns 0 records → a clean-looking empty report
//                       = a FALSE "explain blind" (the obs-fix detour). The ROOT-HOME GUARD below kills it.
//
// Usage (on the box; runs fine as root OR comis):
//   node explain.mjs <sessionKey> [summary|full] [--json | --learning | --failures | --budget]
//   default (no flag) prints the curated diagnostic set: coverage, outcome, cost, likelyRootCause,
//   perRootBudget?, failures[] (with classifiedFailureBy + matchedRule + transportOk), and the learning block.
import { createRequire } from 'node:module';

// Operator-oracle robustness: skip the DEV-only response.parse (IS_DEV gate) so explain ALWAYS returns the
// assembled report for diagnosis instead of throwing on a strict-validation edge. (The report is the
// diagnosis; a schema nit is a separate test concern — IncidentReportSchema.parse runs in the unit tests.)
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const SRC = process.env.COMIS_SRC || '/root/comis-src';
const require = createRequire(SRC + '/packages/daemon/package.json');

// ROOT-HOME GUARD (mirrors db.mjs): the daemon runs as `comis` (data dir /home/comis/.comis). Invoked as
// root (HOME=/root) WITHOUT an explicit override, the reader would read /root/.comis → 0 records. Resolve
// to the comis data dir + warn.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const dataDir =
  process.env.COMIS_DATA_DIR || (runningAsRoot ? '/home/comis/.comis' : (process.env.HOME || '/home/comis') + '/.comis');
if (runningAsRoot && !process.env.COMIS_DATA_DIR) {
  console.error(
    "[explain.mjs] running as root → using /home/comis/.comis (NOT /root/.comis — that reads 0 records, a false 'explain blind'); set COMIS_DATA_DIR to override",
  );
}

const [sessionKey, ...rest] = process.argv.slice(2);
if (!sessionKey) {
  console.error('usage: explain.mjs <sessionKey> [summary|full] [--json|--learning|--failures|--budget]');
  process.exit(2);
}
const depth = rest.find((x) => x === 'summary' || x === 'full') || 'full';
const flags = new Set(rest.filter((x) => x.startsWith('--')));
const narrowed = flags.has('--learning') || flags.has('--failures') || flags.has('--budget');

const { assembleIncidentReportFromSources, makeRealReader } = require(SRC + '/packages/daemon/dist/index.js');

assembleIncidentReportFromSources(makeRealReader(dataDir), dataDir, { sessionKey, depth })
  .then((r) => {
    if (flags.has('--json')) {
      console.log(JSON.stringify(r, null, 1));
      return;
    }
    const out = {
      coverageRecords: r.coverage && r.coverage.trajectory ? r.coverage.trajectory.records : undefined,
      outcome: r.outcome,
      costUsd: r.cost ? r.cost.costUsd : undefined,
      likelyRootCause: r.likelyRootCause,
      ...(r.perRootBudget ? { perRootBudget: r.perRootBudget } : {}),
    };
    if (!narrowed || flags.has('--failures')) {
      out.failures = (r.failures || []).map((f) => ({
        tool: f.toolName,
        by: f.classifiedFailureBy,
        rule: f.matchedRule,
        transportOk: f.transportOk,
        kind: f.errorKind,
      }));
    }
    if (!narrowed || flags.has('--learning')) {
      out.learning = r.learning;
    }
    console.log(JSON.stringify(out, null, 1));
  })
  .catch((e) => {
    console.error('[explain.mjs] assemble failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
