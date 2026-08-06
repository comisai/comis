#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// burst-verify.mjs — settle a burst, then score it against ground truth: which reply belongs to
// which inbound, whether any reply was lost or delivered twice, and whether the turns ACTUALLY
// overlapped. Reads a manifest written by `burst-inject.mjs`.
//
// The verdicts are deliberately three, not two:
//   ok         every inbound bound to its own reply, no duplicates, overlap proven
//   ambiguous  replies landed but the transcript cannot attribute them (interleaved). NOT a pass —
//              reach for a stronger key (a group/forum thread id) or record a documented finding.
//   fail       a reply was lost, a reply was delivered twice, the wrong transcript was read, or
//              nothing overlapped (a serialized run scored as concurrency is the false pass this
//              whole tool exists to prevent).
//
// Usage:
//   node burst-verify.mjs <manifest.json> [options]
//     --settle-ms <n>      quiet period with no new evidence before scoring (default 20000)
//     --max-ms <n>         hard ceiling on settling (default 300000)
//     --no-expect-overlap  for a steering/sequential row, where one trace is the correct shape
//     --data <path>        override the manifest's data dir
//     --format json|text   default text (json prints the full report)
//
// Exit: 0 ok · 1 fail · 2 usage/rig error · 4 ambiguous · 5 never settled inside --max-ms
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { rig } from './_rig.mjs';
import {
  attributeBurst,
  burstVerdict,
  filterRecordsWindow,
  openTrajectoryTraceIds,
  overlapReport,
  parseJsonlRecords,
  shouldSettleBurstEvidence,
  wireReconciliation,
} from './concurrency-oracle.mjs';

const argv = process.argv.slice(2);
const positional = [];
const flags = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token === '--no-expect-overlap') { flags.set('no-expect-overlap', true); continue; }
  if (token.startsWith('--')) { flags.set(token.slice(2), argv[index + 1]); index += 1; continue; }
  positional.push(token);
}
const manifestPath = positional[0];
if (!manifestPath) {
  console.error('burst-verify.mjs: usage: burst-verify.mjs <manifest.json> [--settle-ms n] [--max-ms n] [--no-expect-overlap] [--data path] [--format json|text]');
  process.exit(2);
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`burst-verify.mjs: cannot read manifest ${manifestPath}: ${error?.message || error}`);
  process.exit(2);
}
const settleMs = Number(flags.get('settle-ms') ?? 20_000);
const maxMs = Number(flags.get('max-ms') ?? 300_000);
if (!Number.isFinite(settleMs) || !Number.isFinite(maxMs)) {
  console.error('burst-verify.mjs: --settle-ms and --max-ms must be numeric');
  process.exit(2);
}
const dataDir = flags.get('data') || manifest.dataDir || rig.dataDir;
const format = flags.get('format') || 'text';
const expectOverlap = flags.get('no-expect-overlap') !== true;
const injects = (manifest.injects ?? []).filter((inject) => inject.ok && inject.inboundGuid);
if (injects.length === 0) {
  console.error('burst-verify.mjs: the manifest carries no accepted injects — nothing to verify');
  process.exit(2);
}

// Name the missing rig, not the exception (see burst-inject.mjs).
let emu;
try {
  emu = JSON.parse(readFileSync(rig.emuWiringPath, 'utf8'));
} catch (error) {
  console.error(
    `burst-verify.mjs: cannot read the emulator wiring at ${rig.emuWiringPath} `
    + `(${error?.message || error}) — wire the emulator first (deploy-emu.sh / wire-emu.mjs) `
    + 'and confirm RIG_MODE/DATA point at the intended rig',
  );
  process.exit(2);
}
const base = emu.apiRoot;

/** Every session transcript under this data root, newest first. */
const transcriptFiles = () => {
  const files = [];
  const visit = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) { visit(path); continue; }
      if (
        entry.name.endsWith('.jsonl')
        && !entry.name.endsWith('.trajectory.jsonl')
        && !entry.name.endsWith('_session-metadata.jsonl')
      ) files.push(path);
    }
  };
  visit(`${dataDir}/workspace/sessions`);
  return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
};

/**
 * The transcript holding the most of this burst's inbounds.
 *
 * Selecting the newest file instead would follow a sub-agent transcript or another
 * conversation and score this row against someone else's turns.
 */
const resolveTranscript = () => {
  let best = null;
  for (const path of transcriptFiles()) {
    let source;
    try { source = readFileSync(path, 'utf8'); } catch { continue; }
    const hits = injects.filter((inject) => source.includes(inject.inboundGuid)).length;
    if (hits === 0) continue;
    if (best === null || hits > best.hits) best = { path, source, hits };
    if (best.hits === injects.length) break;
  }
  return best;
};

/**
 * The trajectory co-located with that transcript, resolved through its POINTER.
 *
 * A hand-built `<dataDir>/sessions/<id>` path does not exist, and a rig whose dataDir relocates
 * trajectories keeps only the pointer beside the transcript.
 */
const resolveTrajectory = (transcriptPath) => {
  const pointerPath = `${transcriptPath}.trajectory-path.json`;
  try {
    const runtimeFile = JSON.parse(readFileSync(pointerPath, 'utf8')).runtimeFile;
    if (typeof runtimeFile === 'string' && runtimeFile !== '') return runtimeFile;
  } catch { /* no pointer — fall through to the co-located legacy name */ }
  const legacy = `${transcriptPath}.trajectory.jsonl`;
  try { statSync(legacy); return legacy; } catch { return null; }
};

const readWire = async () => {
  try {
    const response = await fetch(
      `${base}/control/chats/${manifest.chatId}/outbound`
      + `?afterMessageId=${manifest.wireAfterMessageId ?? 0}&waitMs=1`,
    );
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
};

const gatewayReachable = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${rig.gwPort}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const evidence = async () => {
  const transcript = resolveTranscript();
  const [wire, daemonReachable] = await Promise.all([readWire(), gatewayReachable()]);
  const trajectoryPath = transcript ? resolveTrajectory(transcript.path) : null;
  let trajectoryRecords = [];
  if (trajectoryPath) {
    try {
      trajectoryRecords = filterRecordsWindow(
        parseJsonlRecords(readFileSync(trajectoryPath, 'utf8')),
        { fromMs: manifest.startedAtMs },
      );
    } catch { /* mid-write or absent — retried on the next poll */ }
  }
  return { transcript, wire, daemonReachable, trajectoryPath, trajectoryRecords };
};

const score = (state) => {
  const attribution = attributeBurst({
    injects,
    transcriptSource: state.transcript?.source ?? '',
  });
  const wire = wireReconciliation({ wire: state.wire, bindings: attribution.bindings });
  const overlap = overlapReport(state.trajectoryRecords);
  const openTraceIds = openTrajectoryTraceIds(state.trajectoryRecords);
  return {
    attribution,
    wire,
    overlap,
    openTraceIds,
    verdict: burstVerdict({ attribution, wire, overlap, expectOverlap }),
  };
};

// Settle on EVIDENCE growth, never on a fixed sleep: a turn ending is not the work ending, and a
// fixed sleep turns a slow pass into a false negative and a fast failure into a false pass.
const startedAtMs = Date.now();
let state = await evidence();
let scored = score(state);
let fingerprint = '';
let quietSinceMs = Date.now();
let settled = false;
while (Date.now() - startedAtMs < maxMs) {
  const resolvedAll = scored.attribution.counts.unanswered === 0
    && scored.attribution.counts.ambiguous === 0;
  const next = `${state.transcript?.source.length ?? 0}:${state.wire.length}:${state.trajectoryRecords.length}:${state.daemonReachable ? 'up' : 'down'}`;
  if (next !== fingerprint) { fingerprint = next; quietSinceMs = Date.now(); }
  const evidenceQuiet = Date.now() - quietSinceMs >= settleMs;
  if (shouldSettleBurstEvidence({
    resolvedAll,
    evidenceQuiet,
    openTraceCount: scored.openTraceIds.length,
    gatewayReachable: state.daemonReachable,
  })) { settled = true; break; }
  await new Promise((resolve) => { setTimeout(resolve, 2000); });
  state = await evidence();
  scored = score(state);
}

const report = {
  label: manifest.label ?? null,
  chatId: manifest.chatId,
  settled,
  settleMs,
  elapsedMs: Date.now() - startedAtMs,
  transcript: state.transcript?.path ?? null,
  inboundsFoundInTranscript: state.transcript?.hits ?? 0,
  trajectory: state.trajectoryPath,
  expectOverlap,
  gatewayReachable: state.daemonReachable,
  openTraceIds: scored.openTraceIds,
  ...scored.verdict,
  bindings: scored.attribution.bindings,
  ambiguousAnswers: scored.attribution.ambiguousAnswers,
  wire: {
    substantiveOutbound: scored.wire.substantiveOutbound,
    progressOutbound: scored.wire.progressOutbound,
  },
  overlapDetail: {
    traces: scored.overlap.traces,
    overlappingPairs: scored.overlap.overlappingPairs,
  },
};

if (format === 'json') {
  console.log(JSON.stringify(report, null, 1));
} else {
  const { counts, overlap } = scored.verdict;
  console.log(`verdict           ${scored.verdict.verdict.toUpperCase()}${settled ? '' : ' (NEVER SETTLED)'}`);
  console.log(`row               ${report.label ?? '(unlabelled)'}  chat ${report.chatId}`);
  console.log(`shape             ${scored.verdict.shape}`);
  console.log(`inbounds          ${counts.injected} injected · ${counts.answered} answered · ${counts.ambiguous} ambiguous · ${counts.unanswered} unanswered`);
  console.log(`wire              ${report.wire.substantiveOutbound} substantive · ${report.wire.progressOutbound} progress`);
  console.log(`overlap           ${overlap.overlapped ? 'PROVEN' : 'NONE'} · maxConcurrent ${overlap.maxConcurrent} · traces ${overlap.traces}`);
  console.log(`transcript        ${report.transcript ?? '(none matched)'} (${report.inboundsFoundInTranscript}/${counts.injected} inbounds)`);
  console.log(`trajectory        ${report.trajectory ?? '(none resolved)'}`);
  for (const binding of scored.attribution.bindings) {
    const detail = binding.status === 'answered'
      ? binding.answer
      : binding.status === 'ambiguous'
        ? `ambiguous with [${binding.ambiguousWith.join(', ')}]`
        : binding.inboundSeen ? 'NO REPLY' : 'NEVER INGESTED';
    console.log(`  inbound ${binding.index}      ${binding.status.padEnd(10)} ${detail}`);
  }
  for (const violation of [...scored.verdict.hard, ...scored.verdict.soft]) {
    console.log(`  ${violation.severity === 'hard' ? 'HARD' : 'soft'}  ${violation.kind}: ${violation.detail}`);
  }
}

if (!settled) process.exit(5);
process.exit(scored.verdict.verdict === 'ok' ? 0 : scored.verdict.verdict === 'ambiguous' ? 4 : 1);
