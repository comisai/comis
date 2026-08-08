// Content-free, deterministic verdicts over one live conversation's durable evidence.
// The caller supplies already-read records; this module never reaches the daemon or prints
// message bodies, callback capabilities, tool payloads, or sensitive canaries.

const BACKGROUND_TERMINALS = new Set([
  "background_task.completed",
  "background_task.failed",
  "background_task.cancelled",
  "background_task.reentered",
]);

function violation(code, detail) {
  return { code, severity: "hard", detail };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordData(record) {
  return record?.data !== null && typeof record?.data === "object" ? record.data : {};
}

function recordKey(record, field, fallbackPrefix) {
  const value = recordData(record)[field];
  if (typeof value === "string" && value.length > 0) return value;
  const traceId = typeof record?.traceId === "string" ? record.traceId : "unknown-trace";
  const name = typeof recordData(record).toolName === "string"
    ? recordData(record).toolName
    : "unknown";
  return `${fallbackPrefix}:${traceId}:${name}`;
}

function wireMessageId(record) {
  const value = record?.messageId ?? record?.raw?.message_id;
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function wireText(record) {
  const values = [record?.text, record?.caption, record?.raw?.text, record?.raw?.caption];
  return values.filter((value) => typeof value === "string").join("\n");
}

function inlineButtons(record) {
  const markup = record?.replyMarkup ?? record?.reply_markup ?? record?.raw?.reply_markup;
  const rows = markup?.inline_keyboard ?? markup?.inlineKeyboard;
  if (!Array.isArray(rows)) return [];
  return rows.flat().filter((button) => button !== null && typeof button === "object");
}

function approvalControlViolations(wireRecords) {
  const actionable = new Set();
  const latest = new Map();
  for (const record of wireRecords) {
    const messageId = wireMessageId(record);
    if (messageId === undefined) continue;
    latest.set(messageId, record);
    if (inlineButtons(record).length > 0) actionable.add(messageId);
  }
  const unresolved = [...actionable].filter((messageId) => {
    const record = latest.get(messageId);
    return record?.method !== "deleteMessage" && inlineButtons(record).length > 0;
  });
  return unresolved.length === 0
    ? []
    : [violation(
      "approval_controls_still_actionable",
      `${unresolved.length} approval message(s) retain inline controls in their final wire state`,
    )];
}

function temporalAndApprovalViolations(trajectoryRecords) {
  const invalidTimestampCount = trajectoryRecords.filter(
    (record) => typeof record?.ts !== "string" || !Number.isFinite(Date.parse(record.ts)),
  ).length;
  const violations = invalidTimestampCount === 0
    ? []
    : [violation(
      "trajectory_timestamp_invalid",
      `${invalidTimestampCount} trajectory record(s) have invalid timestamps`,
    )];

  const ordered = trajectoryRecords.map((record, index) => ({ record, index })).sort((a, b) => {
    const aMs = typeof a.record?.ts === "string" ? Date.parse(a.record.ts) : Number.NaN;
    const bMs = typeof b.record?.ts === "string" ? Date.parse(b.record.ts) : Number.NaN;
    if (!Number.isFinite(aMs) || !Number.isFinite(bMs) || aMs === bMs) return a.index - b.index;
    return aMs - bMs;
  });
  const openByTrace = new Map();
  const requested = new Set();
  const resolved = new Set();
  let unmatchedResolutions = 0;
  let promotedDuringApproval = 0;

  for (const { record } of ordered) {
    const traceId = typeof record?.traceId === "string" ? record.traceId : "unknown-trace";
    const data = recordData(record);
    if (record?.type === "approval.requested") {
      const requestId = typeof data.requestId === "string"
        ? data.requestId
        : `missing-request:${traceId}:${requested.size}`;
      requested.add(requestId);
      const open = openByTrace.get(traceId) ?? new Set();
      open.add(requestId);
      openByTrace.set(traceId, open);
      continue;
    }
    if (record?.type === "approval.resolved") {
      const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
      if (requestId === undefined || !requested.has(requestId) || resolved.has(requestId)) {
        unmatchedResolutions += 1;
        continue;
      }
      resolved.add(requestId);
      openByTrace.get(traceId)?.delete(requestId);
      continue;
    }
    if (record?.type === "background_task.promoted" && (openByTrace.get(traceId)?.size ?? 0) > 0) {
      promotedDuringApproval += 1;
    }
  }

  if (unmatchedResolutions > 0) {
    violations.push(violation(
      "approval_resolution_unmatched",
      `${unmatchedResolutions} approval resolution(s) have no unique matching request`,
    ));
  }
  return {
    violations,
    promotedDuringApproval,
    unresolvedRequests: [...requested].filter((requestId) => !resolved.has(requestId)).length,
    approvalRequests: requested.size,
    approvalResolutions: resolved.size,
  };
}

function lifecycleViolations(trajectoryRecords) {
  const calls = new Set();
  const terminals = new Set();
  const promoted = new Set();
  const backgroundTerminals = new Set();
  let failedToolResults = 0;
  const failedToolNames = [];

  for (const record of trajectoryRecords) {
    if (record?.type === "tool.call") {
      calls.add(recordKey(record, "toolCallId", "tool"));
    } else if (record?.type === "tool.result" || record?.type === "tool.timeout") {
      terminals.add(recordKey(record, "toolCallId", "tool"));
      if (recordData(record).success === false || record?.type === "tool.timeout") {
        failedToolResults += 1;
        failedToolNames.push(
          typeof recordData(record).toolName === "string"
            ? recordData(record).toolName
            : "unknown-tool",
        );
      }
    } else if (record?.type === "background_task.promoted") {
      promoted.add(recordKey(record, "taskId", "background"));
    } else if (BACKGROUND_TERMINALS.has(record?.type)) {
      backgroundTerminals.add(recordKey(record, "taskId", "background"));
    }
  }

  const unmatchedCalls = [...calls].filter((key) => !terminals.has(key)).length;
  const unmatchedBackground = [...promoted].filter((key) => !backgroundTerminals.has(key)).length;
  const violations = [];
  if (unmatchedCalls > 0) {
    violations.push(violation(
      "tool_call_unmatched",
      `${unmatchedCalls} tool call(s) have no terminal result or timeout`,
    ));
  }
  if (unmatchedBackground > 0) {
    violations.push(violation(
      "background_task_unmatched",
      `${unmatchedBackground} promoted background task(s) have no terminal lifecycle record`,
    ));
  }
  return { violations, failedToolResults, failedToolNames };
}

function localeViolations(wireRecords, contract) {
  if (typeof contract.expectedLocale !== "string" || contract.expectedLocale.length === 0) return [];
  const forbidden = Array.isArray(contract.forbiddenSurfaceTexts)
    ? contract.forbiddenSurfaceTexts.filter((text) => typeof text === "string" && text.length > 0)
    : [];
  if (forbidden.length === 0) {
    return [violation(
      "locale_contract_empty",
      `locale ${contract.expectedLocale} has no forbidden fallback surfaces to verify`,
    )];
  }
  const visible = wireRecords.map(wireText);
  const matches = forbidden.filter((text) => visible.some((surface) => surface.includes(text)));
  return matches.length === 0
    ? []
    : [violation(
      "locale_fallback_visible",
      `${matches.length} forbidden fallback surface(s) are visible for locale ${contract.expectedLocale}`,
    )];
}

function secretViolations(records, sensitiveCanaries) {
  const canaries = Array.isArray(sensitiveCanaries)
    ? sensitiveCanaries.filter((value) => typeof value === "string" && value.length > 0)
    : [];
  if (canaries.length === 0) return [];
  const serialized = records.map((record) => JSON.stringify(record));
  let matches = 0;
  for (const canary of canaries) {
    if (serialized.some((record) => record.includes(canary))) matches += 1;
  }
  return matches === 0
    ? []
    : [violation(
      "secret_canary_persisted",
      `${matches} sensitive canary value(s) were found in conversation evidence`,
    )];
}

function normalizedSet(entitySets, name) {
  const values = entitySets?.[name];
  return Array.isArray(values) ? new Set(values.map(String)) : undefined;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function setCovers(set, universe) {
  return [...universe].every((value) => set.has(value));
}

function isPartition(whole, parts) {
  const union = new Set();
  for (const part of parts) {
    for (const value of part) {
      if (union.has(value)) return false;
      union.add(value);
    }
  }
  return setsEqual(whole, union);
}

function groundingViolations(grounding) {
  if (grounding === undefined) return { violations: [], assertionCount: 0 };
  const entitySets = grounding?.entitySets;
  const assertions = Array.isArray(grounding?.assertions) ? grounding.assertions : [];
  const violations = [];

  for (const assertion of assertions) {
    if (assertion?.kind === "set_covers") {
      const set = normalizedSet(entitySets, assertion.set);
      const universe = normalizedSet(entitySets, assertion.universe);
      if (set === undefined || universe === undefined || typeof assertion.claimed !== "boolean") {
        violations.push(violation(
          "grounding_assertion_invalid",
          `grounding assertion ${String(assertion.id)} references unavailable entity sets`,
        ));
        continue;
      }
      const actual = setCovers(set, universe);
      if (actual !== assertion.claimed) {
        violations.push(violation(
          "grounding_set_coverage_false",
          `grounding assertion ${String(assertion.id)} contradicts row-level entity coverage`,
        ));
      }
      continue;
    }
    if (assertion?.kind === "sets_equal") {
      const left = normalizedSet(entitySets, assertion.left);
      const right = normalizedSet(entitySets, assertion.right);
      if (left === undefined || right === undefined || typeof assertion.claimed !== "boolean") {
        violations.push(violation(
          "grounding_assertion_invalid",
          `grounding assertion ${String(assertion.id)} references unavailable entity sets`,
        ));
        continue;
      }
      const actual = setsEqual(left, right);
      if (actual !== assertion.claimed) {
        violations.push(violation(
          "grounding_set_equality_false",
          `grounding assertion ${String(assertion.id)} contradicts row-level entity equality`,
        ));
      }
      continue;
    }
    if (assertion?.kind === "partition") {
      const whole = normalizedSet(entitySets, assertion.whole);
      const parts = Array.isArray(assertion.parts)
        ? assertion.parts.map((name) => normalizedSet(entitySets, name))
        : [];
      if (whole === undefined || parts.some((part) => part === undefined)
        || !isPartition(whole, parts)) {
        violations.push(violation(
          "grounding_partition_invalid",
          `grounding assertion ${String(assertion.id)} is not an exclusive complete partition`,
        ));
      }
      continue;
    }
    violations.push(violation(
      "grounding_assertion_invalid",
      `grounding assertion ${String(assertion?.id)} has an unsupported or incomplete shape`,
    ));
  }
  return { violations, assertionCount: assertions.length };
}

function usageMetrics(trajectoryRecords, incidentReport) {
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const record of trajectoryRecords) {
    if (record?.type !== "model.completed") continue;
    modelCalls += 1;
    const data = recordData(record);
    inputTokens += finiteNumber(data.promptTokens ?? data.inputTokens);
    outputTokens += finiteNumber(data.completionTokens ?? data.outputTokens);
  }
  const costValue = incidentReport?.cost?.costUsd;
  return {
    modelCalls,
    inputTokens,
    outputTokens,
    costUsd: typeof costValue === "number" && Number.isFinite(costValue) ? costValue : undefined,
  };
}

function budgetViolations(metrics, budgets) {
  if (budgets === undefined) return [];
  const violations = [];
  if (typeof budgets.maxModelCalls === "number" && metrics.modelCalls > budgets.maxModelCalls) {
    violations.push(violation(
      "model_call_budget_exceeded",
      `model call count ${metrics.modelCalls} exceeds budget ${budgets.maxModelCalls}`,
    ));
  }
  if (typeof budgets.maxInputTokens === "number" && metrics.inputTokens > budgets.maxInputTokens) {
    violations.push(violation(
      "input_token_budget_exceeded",
      `input token count ${metrics.inputTokens} exceeds budget ${budgets.maxInputTokens}`,
    ));
  }
  if (typeof budgets.maxCostUsd === "number") {
    if (metrics.costUsd === undefined) {
      violations.push(violation(
        "cost_metric_unavailable",
        "a cost budget was requested but the incident report carries no finite cost metric",
      ));
    } else if (metrics.costUsd > budgets.maxCostUsd) {
      violations.push(violation(
        "cost_budget_exceeded",
        `cost ${metrics.costUsd} USD exceeds budget ${budgets.maxCostUsd} USD`,
      ));
    }
  }
  return violations;
}

function countsByName(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

function incidentViolations(incidentReport, failedToolResults, failedToolNames) {
  if (incidentReport === undefined || incidentReport === null) {
    return [violation(
      "incident_report_unavailable",
      "the observability incident report was not available for reconciliation",
    )];
  }
  const reportedFailures = Array.isArray(incidentReport.failures)
    ? incidentReport.failures.length
    : 0;
  const reportedNames = Array.isArray(incidentReport.failures)
    ? incidentReport.failures
      .map((failure) => failure?.toolName)
      .filter((name) => typeof name === "string")
    : [];
  const expectedByName = countsByName(failedToolNames);
  const reportedByName = countsByName(reportedNames);
  const namedFailureMissing = [...expectedByName].some(
    ([name, count]) => (reportedByName.get(name) ?? 0) < count,
  );
  return reportedFailures < failedToolResults || namedFailureMissing
    ? [violation(
      "incident_report_omits_tool_failure",
      `incident report exposes ${reportedFailures} of ${failedToolResults} failed tool result(s)`,
    )]
    : [];
}

export function auditConversationEvidence(input) {
  const trajectoryRecords = Array.isArray(input?.trajectoryRecords) ? input.trajectoryRecords : [];
  const wireRecords = Array.isArray(input?.wireRecords) ? input.wireRecords : [];
  const sessionRecords = Array.isArray(input?.sessionRecords) ? input.sessionRecords : [];
  const contract = input?.contract !== null && typeof input?.contract === "object"
    ? input.contract
    : {};
  const temporal = temporalAndApprovalViolations(trajectoryRecords);
  const lifecycle = lifecycleViolations(trajectoryRecords);
  const grounding = groundingViolations(contract.grounding);
  const usage = usageMetrics(trajectoryRecords, input?.incidentReport);
  const violations = [
    ...temporal.violations,
    ...approvalControlViolations(wireRecords),
  ];
  if (temporal.promotedDuringApproval > 0) {
    violations.push(violation(
      "background_promoted_during_approval",
      `${temporal.promotedDuringApproval} background promotion(s) occurred while correlated approval was open`,
    ));
  }
  if (temporal.unresolvedRequests > 0) {
    violations.push(violation(
      "approval_request_unmatched",
      `${temporal.unresolvedRequests} approval request(s) have no resolution`,
    ));
  }
  violations.push(
    ...lifecycle.violations,
    ...localeViolations(wireRecords, contract),
    ...secretViolations(
      [...trajectoryRecords, ...wireRecords, ...sessionRecords],
      contract.sensitiveCanaries,
    ),
    ...grounding.violations,
    ...budgetViolations(usage, contract.budgets),
  );
  if (trajectoryRecords.length === 0) {
    violations.push(violation(
      "trajectory_evidence_empty",
      "no trajectory records were available; an empty oracle cannot pass",
    ));
  }
  if (wireRecords.length === 0) {
    violations.push(violation(
      "wire_evidence_empty",
      "no wire records were available; user-visible behavior is unverified",
    ));
  }
  if (sessionRecords.length === 0) {
    violations.push(violation(
      "session_evidence_empty",
      "no session records were available; persisted conversation evidence is unverified",
    ));
  }
  violations.push(...incidentViolations(
    input?.incidentReport,
    lifecycle.failedToolResults,
    lifecycle.failedToolNames,
  ));

  return {
    schemaVersion: 1,
    verdict: violations.length === 0 ? "pass" : "fail",
    metrics: {
      approvalRequests: temporal.approvalRequests,
      approvalResolutions: temporal.approvalResolutions,
      modelCalls: usage.modelCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      groundedAssertions: grounding.assertionCount,
    },
    violations,
  };
}
