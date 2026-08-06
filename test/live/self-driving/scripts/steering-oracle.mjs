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

function supersededGoalToolCalls({
  transcriptSource,
  fromMs,
  throughMs,
  terms,
}) {
  const normalizedTerms = [...new Set(
    terms
      .map((term) => String(term).trim().toLowerCase())
      .filter(Boolean),
  )];
  if (normalizedTerms.length === 0) return [];
  const calls = [];
  for (const record of parseJsonlRecords(transcriptSource)) {
    if (record?.type !== "message" || record.message?.role !== "assistant") continue;
    const atMs = typeof record.timestamp === "string"
      ? Date.parse(record.timestamp)
      : Number(record.timestamp);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > throughMs) continue;
    const content = Array.isArray(record.message.content) ? record.message.content : [];
    for (const part of content) {
      if (part?.type !== "toolCall") continue;
      const serializedArgs = JSON.stringify(part.arguments ?? {}).toLowerCase();
      const matchedTerms = normalizedTerms.filter((term) => serializedArgs.includes(term));
      if (matchedTerms.length === 0) continue;
      calls.push({
        atMs,
        toolName: typeof part.name === "string" ? part.name : "unknown",
        matchedTerms,
      });
    }
  }
  return calls;
}

function scoreSupersededGoalToolCalls({
  transcriptSource,
  trajectoryRecords,
  followSentAtMs,
  supersededGoalTerms,
}) {
  const terminalAtMs = trajectoryRecords
    .filter((record) => record?.type === "session.summary")
    .map(recordTimeMs)
    .filter((atMs) => atMs !== null)
    .reduce((latest, atMs) => Math.max(latest, atMs), Number.NEGATIVE_INFINITY);
  if (
    typeof followSentAtMs !== "number"
    || !Number.isFinite(terminalAtMs)
  ) {
    return [];
  }
  return supersededGoalToolCalls({
    transcriptSource,
    fromMs: followSentAtMs,
    throughMs: terminalAtMs,
    terms: supersededGoalTerms,
  });
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
  supersededGoalTerms = [],
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
  const forbiddenToolCalls = scoreSupersededGoalToolCalls({
    transcriptSource,
    trajectoryRecords,
    followSentAtMs,
    supersededGoalTerms,
  });
  if (forbiddenToolCalls.length > 0) {
    customViolations.push(hardViolation(
      "superseded-goal-tool-call",
      `${forbiddenToolCalls.length} tool call(s) advanced the superseded goal after the steering boundary`,
    ));
  }
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
    const scopedDispatches = trajectoryRecords.filter(
      (record) => record?.type === "delivery.dispatched",
    ).length;
    if (disposition === "steer_injected" && scopedDispatches !== 1) {
      attribution.violations.push(hardViolation(
        "unexpected-steering-delivery",
        "an injected steer must produce one scoped delivery dispatch; "
          + `observed ${scopedDispatches}`,
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
      supersededGoalToolCalls: forbiddenToolCalls,
    },
    verdict: burstVerdict({
      attribution,
      wire: wireReport,
      overlap,
      expectOverlap: false,
    }),
  };
}

/** Score bare `steer` mode: abort the old trace and deliver only its replacement. */
export function scoreCommandSteeringBurst({
  injects,
  transcriptSource,
  trajectoryRecords,
  wire,
  supersededGoalTerms = [],
}) {
  const customViolations = [];
  if (injects.length !== 2) {
    customViolations.push(hardViolation(
      "invalid-steering-shape",
      `command steering requires exactly two accepted injects; observed ${injects.length}`,
    ));
  }
  const baseInject = injects[0];
  const followInject = injects[1];
  const followSentAtMs = followInject?.sentAtMs;
  const forbiddenToolCalls = scoreSupersededGoalToolCalls({
    transcriptSource,
    trajectoryRecords,
    followSentAtMs,
    supersededGoalTerms,
  });
  if (forbiddenToolCalls.length > 0) {
    customViolations.push(hardViolation(
      "superseded-goal-tool-call",
      `${forbiddenToolCalls.length} tool call(s) advanced the superseded goal after the steering boundary`,
    ));
  }
  const replacementEnqueue = trajectoryRecords.find((record) => (
    record?.type === "queue.enqueued"
    && record?.data?.mode === "steer"
    && typeof followSentAtMs === "number"
    && recordTimeMs(record) >= followSentAtMs
  ));
  const replacementTraceId = replacementEnqueue?.traceId ?? null;
  const baseTraceId = trajectoryRecords.find((record) => (
    record?.type === "prompt.submitted"
    && record?.traceId !== replacementTraceId
    && (
      typeof followSentAtMs !== "number"
      || (recordTimeMs(record) ?? Number.POSITIVE_INFINITY) < followSentAtMs
    )
  ))?.traceId ?? null;

  if (replacementTraceId === null) {
    customViolations.push(hardViolation(
      "missing-command-steer-replacement",
      "no steer-mode queue enqueue was recorded for the follow-up",
    ));
  }
  if (baseTraceId === null) {
    customViolations.push(hardViolation(
      "missing-command-steer-base",
      "the original execution trace could not be resolved before the follow-up",
    ));
  }

  const baseRecords = baseTraceId === null
    ? []
    : trajectoryRecords.filter((record) => record?.traceId === baseTraceId);
  const replacementRecords = replacementTraceId === null
    ? []
    : trajectoryRecords.filter((record) => record?.traceId === replacementTraceId);
  const modelAbort = baseRecords.some(
    (record) => record?.type === "model.completed" && record?.data?.stopReason === "aborted",
  );
  const finalizedAbort = baseRecords.some(
    (record) => record?.type === "activity.turn_finalized"
      && record?.data?.outcome === "aborted",
  );
  const abortProven = modelAbort && finalizedAbort;
  if (!abortProven) {
    customViolations.push(hardViolation(
      "missing-command-steer-abort",
      "the original trace lacks both an aborted model completion and aborted finalization",
    ));
  }
  const baseDispatches = baseRecords.filter(
    (record) => record?.type === "delivery.dispatched",
  ).length;
  if (baseDispatches !== 0) {
    customViolations.push(hardViolation(
      "abandoned-command-steer-delivered",
      `the superseded trace dispatched ${baseDispatches} delivery record(s)`,
    ));
  }
  const coalesced = replacementRecords.some(
    (record) => record?.type === "queue.coalesced"
      && Number(record?.data?.messageCount) >= 1,
  );
  if (!coalesced) {
    customViolations.push(hardViolation(
      "missing-command-steer-coalesce",
      "the replacement trace has no queue.coalesced event for the pending follow-up",
    ));
  }
  if (!replacementRecords.some((record) => record?.type === "session.summary")) {
    customViolations.push(hardViolation(
      "command-steer-replacement-not-terminal",
      "the replacement trace has no session.summary terminal record",
    ));
  }
  const replacementDispatches = replacementRecords.filter(
    (record) => record?.type === "delivery.dispatched",
  ).length;
  if (replacementDispatches !== 1) {
    customViolations.push(hardViolation(
      "unexpected-command-steer-delivery",
      "the replacement trace must dispatch exactly once; "
        + `observed ${replacementDispatches}`,
    ));
  }

  const followAttribution = attributeBurst({
    injects: followInject === undefined ? [] : [followInject],
    transcriptSource,
  });
  const baseSeen = typeof baseInject?.inboundGuid === "string"
    && transcriptSource.includes(baseInject.inboundGuid);
  if (!baseSeen) {
    customViolations.push(hardViolation(
      "inbound-never-ingested",
      "the superseded base inbound never appeared in the selected transcript",
    ));
  }
  const baseBinding = {
    index: baseInject?.index ?? 0,
    inboundGuid: baseInject?.inboundGuid ?? "",
    status: abortProven && baseSeen ? "aborted" : "unanswered",
    inboundSeen: baseSeen,
    answer: null,
    answerKey: null,
    progressReplies: 0,
    ambiguousWith: [],
  };
  const attribution = {
    ...followAttribution,
    shape: "command-steering",
    bindings: [baseBinding, ...followAttribution.bindings],
    violations: [...followAttribution.violations, ...customViolations],
    counts: {
      injected: injects.length,
      answered: followAttribution.counts.answered + (
        baseBinding.status === "aborted" ? 1 : 0
      ),
      ambiguous: followAttribution.counts.ambiguous,
      unanswered: followAttribution.counts.unanswered + (
        baseBinding.status === "aborted" ? 0 : 1
      ),
    },
  };
  const wireReport = wireReconciliation({ wire, bindings: followAttribution.bindings });
  const overlap = overlapReport(trajectoryRecords);
  return {
    attribution,
    wire: wireReport,
    overlap,
    openTraceIds: openTrajectoryTraceIds(trajectoryRecords),
    steering: {
      disposition: "abort_and_restart",
      baseTraceId,
      replacementTraceId,
      baseDispatches,
      replacementDispatches,
      supersededGoalToolCalls: forbiddenToolCalls,
    },
    verdict: burstVerdict({
      attribution,
      wire: wireReport,
      overlap,
      expectOverlap: false,
    }),
  };
}
