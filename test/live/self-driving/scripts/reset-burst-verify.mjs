#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/** Settle and score two burst manifests separated by a conversation reset. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { rig } from "./_rig.mjs";
import {
  isBurstTranscriptFile,
  parseJsonlRecords,
} from "./concurrency-oracle.mjs";
import {
  scoreResetBurst,
  selectResetBurstTrajectoryRecords,
} from "./reset-burst-oracle.mjs";

const argv = process.argv.slice(2);
const positional = [];
const flags = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token.startsWith("--")) {
    flags.set(token.slice(2), argv[index + 1]);
    index += 1;
    continue;
  }
  positional.push(token);
}
const [firstManifestPath, secondManifestPath, priorTranscriptPath] = positional;
if (!firstManifestPath || !secondManifestPath || !priorTranscriptPath) {
  console.error("reset-burst-verify.mjs: usage: reset-burst-verify.mjs <first-manifest> <second-manifest> <pre-reset-transcript> --expected-answer-terms <csv> [--settle-ms n] [--max-ms n] [--format json|text]");
  process.exit(2);
}

let firstManifest;
let secondManifest;
let priorTranscriptSource;
try {
  firstManifest = JSON.parse(readFileSync(firstManifestPath, "utf8"));
  secondManifest = JSON.parse(readFileSync(secondManifestPath, "utf8"));
  priorTranscriptSource = readFileSync(priorTranscriptPath, "utf8");
} catch (error) {
  console.error(`reset-burst-verify.mjs: cannot read evidence: ${error?.message || error}`);
  process.exit(2);
}
const firstInjects = (firstManifest.injects ?? []).filter((entry) => entry.ok && entry.inboundGuid);
const secondInjects = (secondManifest.injects ?? []).filter((entry) => entry.ok && entry.inboundGuid);
const injects = [...firstInjects, ...secondInjects].map((entry, index) => ({ ...entry, index }));
const expectedAnswerTerms = String(flags.get("expected-answer-terms") ?? "")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
if (injects.length === 0 || expectedAnswerTerms.length !== injects.length) {
  console.error(`reset-burst-verify.mjs: expected ${injects.length} comma-separated answer terms`);
  process.exit(2);
}
if (firstManifest.chatId !== secondManifest.chatId) {
  console.error("reset-burst-verify.mjs: both manifests must target the same chat");
  process.exit(2);
}
const dataDir = firstManifest.dataDir || rig.dataDir;
const settleMs = Number(flags.get("settle-ms") ?? 20_000);
const maxMs = Number(flags.get("max-ms") ?? 300_000);
const format = flags.get("format") ?? "text";

let emu;
try {
  emu = JSON.parse(readFileSync(rig.emuWiringPath, "utf8"));
} catch (error) {
  console.error(`reset-burst-verify.mjs: emulator wiring unavailable: ${error?.message || error}`);
  process.exit(2);
}

const transcriptFiles = () => {
  const files = [];
  const visit = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (isBurstTranscriptFile(entry.name)) files.push(path);
    }
  };
  visit(`${dataDir}/workspace/sessions`);
  return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
};

const resolveCurrentTranscript = () => {
  let best = null;
  for (const path of transcriptFiles()) {
    let source;
    try { source = readFileSync(path, "utf8"); } catch { continue; }
    const hits = secondInjects.filter((inject) => source.includes(inject.inboundGuid)).length;
    if (hits === 0) continue;
    if (best === null || hits > best.hits) best = { path, source, hits };
  }
  return best;
};

const resolveTrajectory = (transcriptPath) => {
  try {
    const pointer = JSON.parse(readFileSync(`${transcriptPath}.trajectory-path.json`, "utf8"));
    if (typeof pointer.runtimeFile === "string" && pointer.runtimeFile !== "") {
      return pointer.runtimeFile;
    }
  } catch { /* retry while the new session materializes */ }
  return null;
};

const readWire = async () => {
  try {
    const response = await fetch(
      `${emu.apiRoot}/control/chats/${firstManifest.chatId}/outbound`
      + `?afterMessageId=${firstManifest.wireAfterMessageId ?? 0}&waitMs=1`,
    );
    const body = await response.json();
    return Array.isArray(body) ? body : [];
  } catch { return []; }
};

const gatewayReachable = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${rig.gwPort}/health`, {
      signal: AbortSignal.timeout(1_000),
    })).ok;
  } catch { return false; }
};

const evidence = async () => {
  const current = resolveCurrentTranscript();
  const trajectoryPath = current ? resolveTrajectory(current.path) : null;
  let trajectoryRecords = [];
  if (trajectoryPath) {
    try {
      trajectoryRecords = selectResetBurstTrajectoryRecords(
        parseJsonlRecords(readFileSync(trajectoryPath, "utf8")),
        { fromMs: firstManifest.startedAtMs, expectedTraceCount: injects.length },
      );
    } catch { /* a mid-write tail is retried */ }
  }
  const [wire, daemonReachable] = await Promise.all([readWire(), gatewayReachable()]);
  const scored = scoreResetBurst({
    injects,
    transcriptSources: [priorTranscriptSource, current?.source ?? ""],
    trajectoryRecords,
    wire,
    expectedAnswerTerms,
    successfulResets: 2,
  });
  return { current, trajectoryPath, trajectoryRecords, wire, daemonReachable, scored };
};

const startedAtMs = Date.now();
let state = await evidence();
let fingerprint = "";
let quietSinceMs = Date.now();
let settled = false;
while (Date.now() - startedAtMs < maxMs) {
  const next = `${state.current?.source.length ?? 0}:${state.wire.length}:${state.trajectoryRecords.length}:${state.daemonReachable}`;
  if (next !== fingerprint) {
    fingerprint = next;
    quietSinceMs = Date.now();
  }
  const allAnswered = state.scored.verdict.counts.unanswered === 0;
  if ((allAnswered && state.scored.openTraceIds.length === 0)
    || (Date.now() - quietSinceMs >= settleMs && state.scored.openTraceIds.length === 0)
    || !state.daemonReachable) {
    settled = true;
    break;
  }
  await new Promise((resolve) => { setTimeout(resolve, 2_000); });
  state = await evidence();
}

const report = {
  label: `${firstManifest.label}+${secondManifest.label}`,
  chatId: firstManifest.chatId,
  settled,
  elapsedMs: Date.now() - startedAtMs,
  transcript: state.current?.path ?? null,
  priorTranscript: priorTranscriptPath,
  trajectory: state.trajectoryPath,
  gatewayReachable: state.daemonReachable,
  openTraceIds: state.scored.openTraceIds,
  reset: state.scored.reset,
  ...state.scored.verdict,
  bindings: state.scored.attribution.bindings,
  wire: state.scored.wire,
};
if (format === "json") console.log(JSON.stringify(report, null, 1));
else {
  console.log(`verdict           ${report.verdict.toUpperCase()}${settled ? "" : " (NEVER SETTLED)"}`);
  console.log(`inbounds          ${report.counts.answered}/${report.counts.injected} answered`);
  console.log(`resets            ${report.reset.successfulResets} · provenance ${report.reset.provenanceAccounted}/${report.counts.injected}`);
  console.log(`traces            ${report.reset.terminalTraces}/${report.reset.ownedTraces} terminal · ${report.openTraceIds.length} open`);
  console.log(`wire              ${report.wire.substantiveOutbound} matched · ${report.wire.unattributedOutbound} unrelated`);
  console.log(`usage             ${report.reset.totalTokens} tokens · $${report.reset.costUsd.toFixed(6)}`);
  for (const violation of [...report.hard, ...report.soft]) {
    console.log(`  ${violation.severity === "hard" ? "HARD" : "soft"}  ${violation.kind}: ${violation.detail}`);
  }
}
if (!settled) process.exit(5);
process.exit(report.verdict === "ok" ? 0 : 1);
