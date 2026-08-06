// SPDX-License-Identifier: Apache-2.0
/**
 * Pure scorer for collect-mode bursts.
 *
 * Collect deliberately turns N physical messages into two model turns: one
 * immediate turn plus one coalesced follow-up. Per-message correctness therefore
 * comes from durable inbound provenance plus answer-token accounting on the
 * Telegram wire, while queue trajectory events prove that the configured mode
 * performed the merge instead of silently dropping work.
 */
import {
  openTrajectoryTraceIds,
  overlapReport,
  parseJsonlRecords,
} from "./concurrency-oracle.mjs";
import {
  isDriveProgressText,
  normalizeWireText,
  outboundVisibleText,
} from "./drive-session-oracle.mjs";

const PROVENANCE_TYPE = "comis.inbound-message-provenance";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const literalOccurrences = (source, term) => {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegex(term)}(?![A-Za-z0-9_])`,
    "gu",
  );
  return [...String(source).matchAll(pattern)].length;
};

const provenanceIds = (transcriptSource) => {
  const ids = new Set();
  for (const record of parseJsonlRecords(transcriptSource)) {
    if (record?.type !== "custom" || record.customType !== PROVENANCE_TYPE) continue;
    const messages = Array.isArray(record.data?.messages) ? record.data.messages : [];
    for (const message of messages) {
      if (typeof message?.id === "string" && message.id !== "") ids.add(message.id);
    }
  }
  return ids;
};

/** Score one N-message burst driven under queue.defaultMode=collect. */
export function scoreCollectBurst({
  injects,
  transcriptSource,
  trajectoryRecords,
  wire = [],
  expectedAnswerTerms,
}) {
  const violations = [];
  const sourceIds = provenanceIds(transcriptSource);
  const enqueued = trajectoryRecords.filter((record) => record?.type === "queue.enqueued");
  const coalesced = trajectoryRecords.filter((record) => record?.type === "queue.coalesced");
  const completedTraceIds = new Set(
    trajectoryRecords
      .filter((record) => record?.type === "session.summary")
      .map((record) => record.traceId)
      .filter((traceId) => typeof traceId === "string" && traceId !== ""),
  );
  const coalescedMessages = coalesced.reduce((total, record) => {
    const count = Number(record?.data?.messageCount);
    return total + (Number.isInteger(count) && count > 0 ? count : 0);
  }, 0);

  // Queue admission happens before a fresh session has a trajectory recorder.
  // In that layout none of the enqueue events can be persisted, while durable
  // provenance plus the two prompt/terminal traces still account for every
  // source message. A partial enqueue set is never trustworthy and must fail.
  if (enqueued.length > 0 && enqueued.length !== injects.length) {
    violations.push({
      kind: "collect-enqueue-accounting-mismatch",
      severity: "hard",
      detail: `the trajectory contains ${enqueued.length} collect enqueues for ${injects.length} accepted inbounds`,
    });
  }
  if (enqueued.some((record) => record?.data?.mode !== "collect")) {
    violations.push({
      kind: "collect-mode-not-observed",
      severity: "hard",
      detail: "one or more accepted queue entries were not recorded in collect mode",
    });
  }
  if (coalesced.length === 0) {
    violations.push({
      kind: "missing-collect-coalescing",
      severity: "hard",
      detail: "the burst completed without a queue.coalesced trajectory event",
    });
  } else if (coalescedMessages !== Math.max(0, injects.length - 1)) {
    violations.push({
      kind: "collect-coalesced-count-mismatch",
      severity: "hard",
      detail: `queue.coalesced accounted for ${coalescedMessages} messages; expected ${Math.max(0, injects.length - 1)}`,
    });
  }
  if (completedTraceIds.size !== 2) {
    violations.push({
      kind: "collect-turn-count-mismatch",
      severity: "hard",
      detail: `collect produced ${completedTraceIds.size} terminal model turns; expected one direct plus one coalesced turn`,
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
      kind: "unexpected-collect-delivery",
      severity: "hard",
      detail: `${unrelatedOutbound.length} substantive wire deliveries contained none of the expected answer terms`,
    });
  }

  const bindings = injects.map((inject, position) => {
    const inboundSeen = sourceIds.has(inject.inboundGuid);
    const answerTerm = expectedAnswerTerms[position];
    const answerCount = answerTerm === undefined ? 0 : termCounts[position];
    if (!inboundSeen) {
      violations.push({
        kind: "collect-inbound-unaccounted",
        severity: "hard",
        index: inject.index,
        detail: "the accepted physical inbound is absent from durable provenance",
      });
    }
    if (answerCount === 0) {
      violations.push({
        kind: "missing-collect-answer",
        severity: "hard",
        index: inject.index,
        detail: `the collect wire never delivered ${answerTerm ?? "the configured answer term"}`,
      });
    } else if (answerCount > 1) {
      violations.push({
        kind: "duplicate-collect-answer",
        severity: "hard",
        index: inject.index,
        detail: `the collect wire delivered ${answerTerm} ${answerCount} times`,
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
  const hard = violations.filter((entry) => entry.severity === "hard");
  const overlap = overlapReport(trajectoryRecords);
  const terminalCollectShape = completedTraceIds.size >= 2;

  return {
    collect: {
      enqueued: enqueued.length,
      executedTurns: completedTraceIds.size,
      coalescedEvents: coalesced.length,
      coalescedMessages,
      provenanceAccounted: injects.filter((inject) => sourceIds.has(inject.inboundGuid)).length,
    },
    attribution: {
      shape: "collect",
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
      violations: violations.filter((entry) => [
        "missing-collect-answer",
        "duplicate-collect-answer",
        "unexpected-collect-delivery",
      ].includes(entry.kind)),
    },
    overlap,
    openTraceIds: terminalCollectShape ? [] : openTrajectoryTraceIds(trajectoryRecords),
    verdict: {
      verdict: hard.length === 0 ? "ok" : "fail",
      shape: "collect",
      counts,
      overlap: {
        overlapped: overlap.overlapped,
        maxConcurrent: overlap.maxConcurrent,
        traces: overlap.traces.length,
      },
      hard,
      soft: [],
    },
  };
}
