// SPDX-License-Identifier: Apache-2.0
/** Pure ground-truth scoring for SDK steer+followup live drives. */
import {
  attributeBurst,
  burstVerdict,
  filterRecordsWindow,
  openTrajectoryTraceIds,
  overlapReport,
  parseJsonlRecords,
  recordTimeMs,
  replyPreview,
  wireReconciliation,
} from "./concurrency-oracle.mjs";
import {
  isDriveProgressText,
  normalizeWireText,
  outboundVisibleText,
  transcriptMessageText,
} from "./drive-session-oracle.mjs";

const SDK_DISPOSITION_TYPES = new Set([
  "queue.steer_injected",
  "queue.followup_queued",
]);

/**
 * Select the original execution trace and the exact follow-up disposition trace.
 *
 * A successful SDK steer bypasses CommandQueue, so the follow-up trace has no
 * `queue.enqueued`. Selecting only enqueue-owned traces erases the very event
 * that proves the follow-up was accepted.
 */
export function selectSdkSteeringTrajectoryRecords(
  records,
  { fromMs, followSentAtMs },
) {
  const windowed = filterRecordsWindow(records, { fromMs });
  const baseTraceId = windowed.find((record) => record?.type === "queue.enqueued")?.traceId;
  const dispositionTraceId = windowed.find((record) => (
    recordTimeMs(record) >= followSentAtMs
    && SDK_DISPOSITION_TYPES.has(record?.type)
  ))?.traceId;
  const selected = new Set(
    [baseTraceId, dispositionTraceId]
      .filter((traceId) => typeof traceId === "string" && traceId !== ""),
  );
  return windowed.filter((record) => selected.has(record?.traceId));
}

function hardViolation(kind, detail) {
  return { kind, severity: "hard", detail };
}

/** Bind the terminal assistant response that the channel actually selected. */
function attributeInjectedSteeringReply({
  baseInject,
  transcriptSource,
  trajectoryRecords,
  wire,
}) {
  const violations = [];
  const terminalAtMs = trajectoryRecords
    .filter((record) => record?.type === "session.summary")
    .map(recordTimeMs)
    .filter((atMs) => atMs !== null)
    .reduce((latest, atMs) => Math.max(latest, atMs), Number.NEGATIVE_INFINITY);
  const wireKeys = new Set(
    wire
      .map(outboundVisibleText)
      .filter((text) => text && !isDriveProgressText(text))
      .map(normalizeWireText),
  );
  let inboundSeen = false;
  const candidates = [];
  for (const record of parseJsonlRecords(transcriptSource)) {
    if (record?.type !== "message") continue;
    const recordAtMs = typeof record.timestamp === "string"
      ? Date.parse(record.timestamp)
      : null;
    if (
      Number.isFinite(terminalAtMs)
      && recordAtMs !== null
      && Number.isFinite(recordAtMs)
      && recordAtMs > terminalAtMs
    ) {
      continue;
    }
    if (record.message?.role === "user") {
      if (
        typeof baseInject?.inboundGuid === "string"
        && transcriptMessageText(record.message).includes(baseInject.inboundGuid)
      ) {
        inboundSeen = true;
        candidates.length = 0;
      }
      continue;
    }
    if (!inboundSeen || record.message?.role !== "assistant") continue;
    const text = transcriptMessageText(record.message).trim();
    if (!text || isDriveProgressText(text)) continue;
    candidates.push({ text, answerKey: normalizeWireText(text) });
  }
  const matching = candidates.filter((candidate) => wireKeys.has(candidate.answerKey));
  const selected = matching.at(-1) ?? candidates.at(-1) ?? null;
  if (!inboundSeen) {
    violations.push(hardViolation(
      "inbound-never-ingested",
      "the base inbound never appeared in the selected transcript",
    ));
  } else if (selected === null) {
    violations.push(hardViolation(
      "lost-reply",
      "the base inbound reached the transcript but no terminal assistant response followed",
    ));
  }
  const binding = {
    index: baseInject?.index ?? 0,
    inboundGuid: baseInject?.inboundGuid ?? "",
    status: selected === null ? "unanswered" : "answered",
    inboundSeen,
    answer: selected === null ? null : replyPreview(selected.text),
    answerKey: selected?.answerKey ?? null,
    progressReplies: 0,
    ambiguousWith: [],
  };
  return {
    shape: "serialized",
    bindings: [binding],
    ambiguousAnswers: [],
    violations,
    counts: {
      injected: 1,
      answered: selected === null ? 0 : 1,
      ambiguous: 0,
      unanswered: selected === null ? 1 : 0,
    },
  };
}

/**
 * Score one two-message SDK steering drive.
 *
 * An injected steer is not a second normal transcript turn: the SDK folds it
 * into the live run and the runtime emits `queue.steer_injected` on the second
 * ingress trace. The final combined answer therefore binds to the base turn,
 * while the typed disposition event accounts for the follow-up.
 */
export function scoreSdkSteeringBurst({
  injects,
  transcriptSource,
  trajectoryRecords,
  wire,
}) {
  const customViolations = [];
  if (injects.length !== 2) {
    customViolations.push(hardViolation(
      "invalid-steering-shape",
      `SDK steering requires exactly two accepted injects; observed ${injects.length}`,
    ));
  }
  const baseInject = injects[0];
  const followInject = injects[1];
  const followSentAtMs = followInject?.sentAtMs;
  const postFollowRecords = typeof followSentAtMs === "number"
    ? trajectoryRecords.filter((record) => {
        const atMs = recordTimeMs(record);
        return atMs !== null && atMs >= followSentAtMs;
      })
    : [];
  const injectedEvents = postFollowRecords.filter(
    (record) => record?.type === "queue.steer_injected",
  );
  const queuedEvents = postFollowRecords.filter(
    (record) => record?.type === "queue.followup_queued",
  );
  let disposition = "missing";
  if (injectedEvents.length === 1 && queuedEvents.length === 0) {
    disposition = "steer_injected";
  } else if (queuedEvents.length === 1 && injectedEvents.length === 0) {
    disposition = "followup_queued";
  } else if (injectedEvents.length === 0 && queuedEvents.length === 0) {
    customViolations.push(hardViolation(
      "missing-steering-disposition",
      "the accepted follow-up has no queue.steer_injected or queue.followup_queued event",
    ));
  } else {
    disposition = "conflict";
    customViolations.push(hardViolation(
      "conflicting-steering-disposition",
      `the follow-up produced ${injectedEvents.length} steer and ${queuedEvents.length} follow-up events`,
    ));
  }

  if (!postFollowRecords.some((record) => record?.type === "session.summary")) {
    customViolations.push(hardViolation(
      "steered-turn-not-terminal",
      "no session.summary landed after the follow-up disposition",
    ));
  }

  const baseAttribution = disposition === "steer_injected"
    ? attributeInjectedSteeringReply({
        baseInject,
        transcriptSource,
        trajectoryRecords,
        wire,
      })
    : attributeBurst({
        injects: baseInject === undefined ? [] : [baseInject],
        transcriptSource,
      });
  let attribution;
  let wireReport;
  if (disposition === "followup_queued") {
    attribution = attributeBurst({ injects, transcriptSource });
    attribution.violations.push(...customViolations);
    wireReport = wireReconciliation({ wire, bindings: attribution.bindings });
  } else {
    const followBinding = {
      index: followInject?.index ?? 1,
      inboundGuid: followInject?.inboundGuid ?? "",
      status: disposition === "steer_injected" ? "steered" : "unanswered",
      inboundSeen: false,
      answer: null,
      answerKey: null,
      progressReplies: 0,
      ambiguousWith: [],
    };
    attribution = {
      ...baseAttribution,
      shape: "sdk-steering",
      bindings: [...baseAttribution.bindings, followBinding],
      violations: [...baseAttribution.violations, ...customViolations],
      counts: {
        injected: injects.length,
        answered:
          baseAttribution.counts.answered + (disposition === "steer_injected" ? 1 : 0),
        ambiguous: baseAttribution.counts.ambiguous,
        unanswered: disposition === "steer_injected"
          ? baseAttribution.counts.unanswered
          : baseAttribution.counts.unanswered + 1,
      },
    };
    wireReport = wireReconciliation({ wire, bindings: baseAttribution.bindings });
    if (disposition === "steer_injected" && wireReport.rawSubstantiveOutbound !== 1) {
      attribution.violations.push(hardViolation(
        "unexpected-steering-delivery",
        "an injected steer must produce one combined substantive delivery; "
          + `observed ${wireReport.rawSubstantiveOutbound}`,
      ));
    }
  }

  // The follow-up ingress trace is a zero-duration disposition marker, not a
  // second model execution. Including it reports "overlap=true" with
  // maxConcurrent=1, a self-contradictory metric. SDK steering remains one
  // execution whose live input changed in flight.
  const baseTraceId = trajectoryRecords.find(
    (record) => record?.type === "queue.enqueued",
  )?.traceId;
  const executionRecords = baseTraceId === undefined
    ? trajectoryRecords
    : trajectoryRecords.filter((record) => record?.traceId === baseTraceId);
  const overlap = overlapReport(executionRecords);
  return {
    attribution,
    wire: wireReport,
    overlap,
    openTraceIds: openTrajectoryTraceIds(trajectoryRecords),
    steering: {
      disposition,
      injectedEvents: injectedEvents.length,
      queuedEvents: queuedEvents.length,
      traceId: injectedEvents[0]?.traceId ?? queuedEvents[0]?.traceId ?? null,
    },
    verdict: burstVerdict({
      attribution,
      wire: wireReport,
      overlap,
      expectOverlap: false,
    }),
  };
}
