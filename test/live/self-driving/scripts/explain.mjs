// explain.mjs — offline IncidentReport read for ONE session/run (the obs ground-truth oracle).
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
//   node explain.mjs <sessionKey|traceId|rootRunId> [summary|full] [--json | --learning | --failures | --budget]
//   default (no flag) prints the curated diagnostic set: coverage, outcome, cost, likelyRootCause,
//   perRootBudget?, failures[] (with classifiedFailureBy + matchedRule + transportOk), and the learning block.
// Operator-oracle robustness: skip the DEV-only response.parse (IS_DEV gate) so explain ALWAYS returns the
// assembled report for diagnosis instead of throwing on a strict-validation edge. (The report is the
// diagnosis; a schema nit is a separate test concern — IncidentReportSchema.parse runs in the unit tests.)
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Code root (daemon dist) + data dir via _rig.mjs. rig.dataDir derives from the SERVICE USER's home
// (never process HOME), which retires the old root-HOME trap: an `ssh root@vps 'node explain.mjs …'`
// used to read /root/.comis → 0 records → a false "explain blind".
import { rig, comisDist } from './_rig.mjs';
import { paramsForExplainRef } from './explain-ref.mjs';
const dataDir = rig.dataDir;

const [ref, ...rest] = process.argv.slice(2);
if (!ref) {
  console.error(
    'usage: explain.mjs <sessionKey|traceId|rootRunId> [summary|full] [--json|--learning|--failures|--budget]',
  );
  process.exit(2);
}
const depth = rest.find((x) => x === 'summary' || x === 'full') || 'full';
const flags = new Set(rest.filter((x) => x.startsWith('--')));
const narrowed = flags.has('--learning') || flags.has('--failures') || flags.has('--budget');

// dynamic import() loads the CJS dist under both layouts; the default-spread covers CJS exports
// the ESM named-export lexer misses.
const daemonDist = await import(comisDist('daemon', 'dist/index.js'));
const { assembleIncidentReportFromSources, makeRealReader } = { ...daemonDist.default, ...daemonDist };

assembleIncidentReportFromSources(makeRealReader(dataDir), dataDir, paramsForExplainRef(ref, depth))
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
