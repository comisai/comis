// SPDX-License-Identifier: Apache-2.0
/** Pure source/delivery/terminal scorer for bursts spanning conversation resets. */
import { filterRecordsWindow, parseJsonlRecords } from "./concurrency-oracle.mjs";
import {
  isDriveProgressText,
  normalizeWireText,
  outboundVisibleText,
} from "./drive-session-oracle.mjs";

const PROVENANCE_TYPE = "comis.inbound-message-provenance";
const TERMINAL_TYPES = new Set([
  "session.summary",
  "execution.aborted",
  "activity.turn_finalized",
  "queue.coalesced",
  "queue.steer_injected",
  "queue.followup_queued",
  "queue.overflow",
]);
const OWNERSHIP_TYPES = new Set([
  "queue.enqueued",
  "prompt.submitted",
  "queue.steer_injected",
  "queue.followup_queued",
]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const literalOccurrences = (source, term) => [...String(source).matchAll(new RegExp(
  `(?<![A-Za-z0-9_])${escapeRegex(term)}(?![A-Za-z0-9_])`,
  "giu",
))].length;

const readProvenanceIds = (sources) => {
  const ids = new Set();
  for (const source of sources) {
    for (const record of parseJsonlRecords(source)) {
      if (record?.type !== "custom" || record.customType !== PROVENANCE_TYPE) continue;
      const messages = Array.isArray(record.data?.messages) ? record.data.messages : [];
      for (const message of messages) {
        if (typeof message?.id === "string" && message.id !== "") ids.add(message.id);
      }
    }
  }
  return ids;
};

const readUsage = (records) => {
  let costUsd = 0;
  let totalTokens = 0;
  for (const record of records) {
    if (record?.type === "session.summary") {
      const cost = Number(record.data?.costUsd);
      if (Number.isFinite(cost)) costUsd += cost;
      const summaryTokens = Number(record.data?.totalTokens);
      if (Number.isFinite(summaryTokens)) totalTokens += summaryTokens;
      continue;
    }
    if (record?.type !== "model.completed") continue;
    const directTokenFields = [
      record.data?.inputTokens,
      record.data?.outputTokens,
      record.data?.cacheReadTokens,
      record.data?.cacheCreationTokens,
    ].map(Number);
    const directTotal = directTokenFields.every(Number.isFinite)
      ? directTokenFields.reduce((total, count) => total + count, 0)
      : undefined;
    const modelTokens = Number(
      record.data?.usage?.totalTokens
      ?? record.data?.totalTokens
      ?? directTotal,
    );
    if (Number.isFinite(modelTokens)) totalTokens += modelTokens;
  }
  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    totalTokens,
  };
};

/** Select base prompts plus SDK forwarding dispositions across reset boundaries. */
export function selectResetBurstTrajectoryRecords(records, { fromMs, expectedTraceCount }) {
  const windowed = filterRecordsWindow(records, { fromMs });
  const selectedTraceIds = [];
  const selected = new Set();
  for (const record of windowed) {
    if (!OWNERSHIP_TYPES.has(record?.type)) continue;
    const traceId = record?.traceId;
    if (typeof traceId !== "string" || traceId === "" || selected.has(traceId)) continue;
    selected.add(traceId);
    selectedTraceIds.push(traceId);
    if (selectedTraceIds.length >= expectedTraceCount) break;
  }
  const identities = new Set(selectedTraceIds);
  return windowed.filter((record) => identities.has(record?.traceId));
}

export function scoreResetBurst({
  injects,
  transcriptSources,
  trajectoryRecords,
  wire = [],
  expectedAnswerTerms,
  successfulResets,
}) {
  const violations = [];
  if (successfulResets !== 2) {
    violations.push({
      kind: "reset-burst-reset-count-mismatch",
      severity: "hard",
      detail: `the drive completed ${successfulResets} successful resets; expected 2`,
    });
  }

  const provenanceIds = readProvenanceIds(transcriptSources);
  const matchedProvenanceIds = injects.filter((inject) => provenanceIds.has(inject.inboundGuid));
  const ownedTraceIds = new Set();
  const terminalTraceIds = new Set();
  const forwardedTraceIds = new Set();
  for (const record of trajectoryRecords) {
    const traceId = record?.traceId;
    if (typeof traceId !== "string" || traceId === "") continue;
    ownedTraceIds.add(traceId);
    if (TERMINAL_TYPES.has(record.type)) terminalTraceIds.add(traceId);
    if (record.type === "queue.steer_injected" || record.type === "queue.followup_queued") {
      forwardedTraceIds.add(traceId);
    }
  }
  const sourceMessagesAccounted = Math.min(
    injects.length,
    matchedProvenanceIds.length + forwardedTraceIds.size,
  );
  const allSourcesAccounted = sourceMessagesAccounted === injects.length;
  const openTraceIds = [...ownedTraceIds]
    .filter((traceId) => !terminalTraceIds.has(traceId))
    .sort();
  for (const traceId of openTraceIds) {
    violations.push({
      kind: "reset-burst-trace-not-terminal",
      severity: "hard",
      traceId,
      detail: "accepted burst ownership has no terminal or forwarding disposition across the reset",
    });
  }

  const substantive = [];
  let progressOutbound = 0;
  for (const item of wire) {
    const visible = outboundVisibleText(item);
    if (!visible) continue;
    if (isDriveProgressText(visible)) {
      progressOutbound += 1;
      continue;
    }
    substantive.push(normalizeWireText(visible));
  }
  const joinedWire = substantive.join("\n");
  const termCounts = expectedAnswerTerms.map((term) => literalOccurrences(joinedWire, term));
  const unrelatedOutbound = substantive.filter(
    (text) => expectedAnswerTerms.every((term) => literalOccurrences(text, term) === 0),
  );
  if (unrelatedOutbound.length > 0) {
    violations.push({
      kind: "unexpected-reset-burst-delivery",
      severity: "hard",
      detail: `${unrelatedOutbound.length} substantive deliveries contain none of the expected reset-burst answers`,
    });
  }

  const bindings = injects.map((inject, position) => {
    const inboundSeen = allSourcesAccounted || provenanceIds.has(inject.inboundGuid);
    const answerTerm = expectedAnswerTerms[position];
    const answerCount = answerTerm === undefined ? 0 : termCounts[position];
    if (!inboundSeen) {
      violations.push({
        kind: "reset-burst-inbound-unaccounted",
        severity: "hard",
        index: inject.index,
        detail: "the accepted physical inbound is absent from both reset-segment provenance snapshots",
      });
    }
    if (answerCount === 0) {
      violations.push({
        kind: "missing-reset-burst-answer",
        severity: "hard",
        index: inject.index,
        detail: `the Telegram wire never delivered ${answerTerm ?? "the configured answer term"}`,
      });
    } else if (answerCount > 1) {
      violations.push({
        kind: "duplicate-reset-burst-answer",
        severity: "hard",
        index: inject.index,
        detail: `the Telegram wire delivered ${answerTerm} ${answerCount} times`,
      });
    }
    const answered = inboundSeen && answerCount === 1;
    return {
      index: inject.index,
      inboundGuid: inject.inboundGuid,
      status: answered ? "answered" : "unanswered",
      inboundSeen,
      answer: answered ? answerTerm : null,
      answerKey: answered ? answerTerm : null,
      progressReplies: 0,
      ambiguousWith: [],
    };
  });
  const counts = {
    injected: injects.length,
    answered: bindings.filter((binding) => binding.status === "answered").length,
    ambiguous: 0,
    unanswered: bindings.filter((binding) => binding.status !== "answered").length,
  };
  const usage = readUsage(trajectoryRecords);
  const hard = violations.filter((entry) => entry.severity === "hard");

  return {
    reset: {
      successfulResets,
      provenanceAccounted: matchedProvenanceIds.length,
      forwardedAccounted: forwardedTraceIds.size,
      sourceMessagesAccounted,
      ownedTraces: ownedTraceIds.size,
      terminalTraces: terminalTraceIds.size,
      ...usage,
    },
    attribution: {
      shape: "reset-burst",
      bindings,
      ambiguousAnswers: [],
      violations,
      counts,
    },
    wire: {
      substantiveOutbound: substantive.length - unrelatedOutbound.length,
      rawSubstantiveOutbound: substantive.length,
      unattributedOutbound: unrelatedOutbound.length,
      progressOutbound,
    },
    openTraceIds,
    verdict: {
      verdict: hard.length === 0 ? "ok" : "fail",
      shape: "reset-burst",
      counts,
      hard,
      soft: [],
    },
  };
}
