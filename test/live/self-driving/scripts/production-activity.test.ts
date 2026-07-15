// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_EVIDENCE_IDS,
  type ProductionEvidenceId,
  type ProductionEvidenceItem,
  type ProductionEvidenceReport,
} from "./production-evidence.js";
import {
  PRODUCTION_ACTIVITY_SOURCE_AUTHORITY,
  buildTargetLocalActivityBlobVaultPlan,
  buildTargetLocalActivityBlobVaultScript,
  compileProductionActivity,
  parseTargetLocalActivityBlobVaultSummary,
  type NormalizedProductionActivityRecord,
  type ProductionActivityCompileInput,
  type ProductionActivitySourceBatch,
} from "./production-activity.js";
import type {
  TranscriptEventKind,
  TranscriptSourceKind,
} from "./production-transcript.js";
import { TRANSCRIPT_SOURCE_KINDS } from "./production-transcript.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function evidenceItem(id: ProductionEvidenceId): ProductionEvidenceItem {
  if (id === "heartbeat_runs") {
    return {
      id,
      configured: "unknown",
      availability: "unsupported",
      readability: "not_applicable",
      gapReason: "requires_runtime_api",
    };
  }
  if (id === "system_event_queue" || id === "active_graphs" || id === "active_subagents") {
    return {
      id,
      configured: "unknown",
      availability: "unsupported",
      readability: "not_applicable",
      gapReason: "not_durable",
    };
  }
  return {
    id,
    configured: "unknown",
    availability: "missing",
    readability: "not_applicable",
    gapReason: "artifact_missing",
  };
}

function makeEvidence(overrides: Partial<Record<ProductionEvidenceId, ProductionEvidenceItem>> = {}): ProductionEvidenceReport {
  const overrideMap = new Map<ProductionEvidenceId, ProductionEvidenceItem>(
    Object.entries(overrides) as Array<[ProductionEvidenceId, ProductionEvidenceItem]>,
  );
  return {
    schema: "comis-production-evidence",
    schemaVersion: 1,
    consistency: "live_non_atomic",
    observedAtMs: 1_000,
    items: PRODUCTION_EVIDENCE_IDS.map((id) => overrideMap.get(id) ?? evidenceItem(id)),
  };
}

function makeRecord(
  sourceKind: TranscriptSourceKind,
  eventKind: TranscriptEventKind,
  recordId: string,
  wallTimeMs: number,
  overrides: Partial<NormalizedProductionActivityRecord> = {},
): NormalizedProductionActivityRecord {
  const needsConversation = !eventKind.startsWith("cron.") && !eventKind.startsWith("state.");
  const needsRun = /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(eventKind);
  return {
    recordId,
    sourceSeq: 1,
    eventKind,
    wallTimeMs,
    monotonicTimeNs: String(wallTimeMs * 1_000_000),
    clockId: `clock-${sourceKind}`,
    traceId: needsConversation ? `trace-${recordId}` : null,
    sessionId: needsConversation ? `session-${recordId}` : null,
    runId: needsRun ? `run-${recordId}` : null,
    jobId: eventKind.startsWith("cron.") ? `job-${recordId}` : null,
    causalParent: null,
    actor: {
      kind: sourceKind === "offline_messages" ? "user" : "service",
      id: sourceKind === "offline_messages" ? "user-a" : null,
      trust: sourceKind === "offline_messages" ? "user" : "system",
      origin: sourceKind === "offline_messages" ? "channel" : "orchestrator",
    },
    replay: {
      policy: sourceKind === "offline_messages" ? "inject" : "assert",
      payloadDigest: digest(`payload:${recordId}`),
      blobDigest: sourceKind === "offline_messages" ? digest(`blob:${recordId}`) : null,
    },
    ...overrides,
  };
}

function availableBatch(
  kind: TranscriptSourceKind,
  sourceId: string,
  records: readonly NormalizedProductionActivityRecord[],
  gapReasons: ProductionActivitySourceBatch["gapReasons"] = [],
): ProductionActivitySourceBatch {
  return { kind, sourceId, status: "available", gapReasons, records };
}

function makeInput(sources: readonly ProductionActivitySourceBatch[]): ProductionActivityCompileInput {
  return {
    captureId: "capture-a",
    createdAtMs: 2_000,
    target: "deterministic_cassette",
    evidence: makeEvidence(),
    sources,
  };
}

describe("production historical activity compiler", () => {
  it("declares one historical authority policy for every closed transcript source", () => {
    expect(Object.keys(PRODUCTION_ACTIVITY_SOURCE_AUTHORITY)).toEqual(TRANSCRIPT_SOURCE_KINDS);
  });

  it("compiles every persisted activity family into one causal digest-only transcript", () => {
    const cases = [
      ["offline_messages", "channel.normalized.text_received", "user-input"],
      ["channel_native", "channel.native.callback_received", "native-callback"],
      ["cron_store", "cron.revision.created", "cron-revision"],
      ["cron_execution", "cron.fire.completed", "cron-fire"],
      ["heartbeat", "heartbeat.completed", "heartbeat-run"],
      ["proactive", "proactive.dispatched", "proactive-run"],
      ["system_dispatch", "system.dispatch.completed", "system-run"],
      ["internal_dispatch", "internal.dispatch.completed", "internal-run"],
      ["session", "session.started", "session-start"],
      ["lcd", "lcd.message.appended", "lcd-message"],
      ["graph", "graph.started", "graph-start"],
      ["subagent", "subagent.started", "subagent-start"],
      ["model_provider", "model.request.started", "model-start"],
      ["tool_runtime", "tool.call.started", "tool-start"],
      ["delivery", "outbound.delivered", "delivery-end"],
      ["state", "state.mutation.committed", "state-change"],
    ] as const satisfies readonly (readonly [TranscriptSourceKind, TranscriptEventKind, string])[];

    const sources = cases.map(([kind, eventKind, recordId], index) =>
      availableBatch(kind, kind, [
        makeRecord(kind, eventKind, recordId, 100 + index, {
          sourceSeq: 1,
          ...(kind === "graph" || kind === "subagent"
            ? { runId: `run-${recordId}`, traceId: `trace-${recordId}`, sessionId: `session-${recordId}` }
            : {}),
        }),
      ]),
    );

    const result = compileProductionActivity(makeInput([...sources].reverse()));

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.transcript.events.map(({ kind }) => kind)).toEqual(cases.map(([, kind]) => kind));
    expect(result.value.transcript.events.map(({ seq }) => seq)).toEqual(
      Array.from({ length: cases.length }, (_, index) => index + 1),
    );
    expect(JSON.stringify(result.value.transcript)).not.toContain("PRIVATE_USER_PROMPT");
    expect(result.value.transcript.events[0]?.replay.blobDigest).toBe(digest("blob:user-input"));
    expect(result.value.completeness.fidelity).toBe("historical_best_effort");
    expect(result.value.completeness.exactEligible).toBe(false);
  });

  it("topologically orders causal parents before children across independent authority sources", () => {
    const parent = makeRecord("offline_messages", "channel.normalized.text_received", "parent", 300);
    const child = makeRecord("session", "session.started", "child", 100, {
      causalParent: { sourceKind: "offline_messages", sourceId: "telegram", recordId: "parent" },
    });

    const result = compileProductionActivity(
      makeInput([
        availableBatch("session", "sessions", [child]),
        availableBatch("offline_messages", "telegram", [parent]),
      ]),
    );

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.transcript.events.map(({ kind }) => kind)).toEqual([
      "channel.normalized.text_received",
      "session.started",
    ]);
    expect(result.value.transcript.events[1]?.causalParentEventId).toBe(
      result.value.transcript.events[0]?.eventId,
    );
  });

  it("deduplicates identical retained records and assigns contiguous output source sequences", () => {
    const first = makeRecord("trajectory", "trajectory.append.started", "same-entry", 100, {
      sourceSeq: 1,
      runId: "run-a",
      traceId: "trace-a",
      sessionId: "session-a",
    });

    const result = compileProductionActivity(
      makeInput([availableBatch("trajectory", "trajectory-a", [first, { ...first }])]),
    );

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.duplicateCount).toBe(1);
    expect(result.value.transcript.events).toHaveLength(1);
    expect(result.value.transcript.events[0]?.source.seq).toBe(1);
    expect(
      result.value.authorities.find(
        ({ kind, sourceId }) => kind === "trajectory" && sourceId === "trajectory-a",
      )?.authoritativeCount,
    ).toBe(1);
  });

  it("deduplicates semantically identical records independent of JSON property order", () => {
    const record = makeRecord("state", "state.mutation.committed", "same-state", 100);
    const reordered = Object.fromEntries(
      Object.entries(record).reverse(),
    ) as unknown as NormalizedProductionActivityRecord;
    const result = compileProductionActivity(
      makeInput([availableBatch("state", "sqlite", [record, reordered])]),
    );

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.duplicateCount).toBe(1);
    expect(result.value.transcript.events).toHaveLength(1);
  });

  it("produces byte-identical canonical output for shuffled source and record order", () => {
    const a = makeRecord("state", "state.mutation.committed", "state-a", 100, { sourceSeq: 1 });
    const b = makeRecord("state", "state.mutation.requested", "state-b", 200, { sourceSeq: 2 });
    const first = compileProductionActivity(makeInput([availableBatch("state", "sqlite", [a, b])]));
    const second = compileProductionActivity(makeInput([availableBatch("state", "sqlite", [b, a])]));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: { transcript: { events: [{ source: { seq: 1 } }, { source: { seq: 2 } }] } },
    });
  });

  it("rejects an undeclared missing range in an authoritative source sequence", () => {
    const first = makeRecord("state", "state.mutation.requested", "state-a", 100, { sourceSeq: 1 });
    const third = makeRecord("state", "state.mutation.committed", "state-c", 102, { sourceSeq: 3 });

    expect(
      compileProductionActivity(makeInput([availableBatch("state", "sqlite", [first, third])])),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "records",
        message: "Authoritative source sequence has an undeclared retention gap",
      },
    });
  });

  it("rejects different authority records that claim the same source sequence", () => {
    const first = makeRecord("state", "state.mutation.requested", "state-a", 100, { sourceSeq: 1 });
    const collision = makeRecord("state", "state.mutation.committed", "state-b", 101, { sourceSeq: 1 });

    expect(
      compileProductionActivity(makeInput([availableBatch("state", "sqlite", [first, collision])])),
    ).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "records",
        message: "Authoritative source sequence is assigned to multiple records",
      },
    });
  });

  it("rejects conflicting records that reuse one authoritative identity", () => {
    const first = makeRecord("state", "state.mutation.requested", "collision", 100);
    const conflicting = { ...first, wallTimeMs: 101 };
    const result = compileProductionActivity(
      makeInput([availableBatch("state", "sqlite", [first, conflicting])]),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "records",
        message: "Authoritative record identity has conflicting representations",
      },
    });
  });

  it("rejects inline content fields and malformed digest references at the compiler boundary", () => {
    const record = makeRecord("offline_messages", "channel.normalized.text_received", "message-a", 100);
    const withInlineBody = { ...record, text: "PRIVATE_USER_PROMPT" };
    const inlineResult = compileProductionActivity(
      makeInput([
        availableBatch("offline_messages", "telegram", [
          withInlineBody as unknown as NormalizedProductionActivityRecord,
        ]),
      ]),
    );
    const invalidDigestResult = compileProductionActivity(
      makeInput([
        availableBatch("offline_messages", "telegram", [
          { ...record, replay: { ...record.replay, blobDigest: "not-a-digest" } },
        ]),
      ]),
    );

    expect(inlineResult.ok).toBe(false);
    expect(invalidDigestResult.ok).toBe(false);
    if (inlineResult.ok === false) expect(inlineResult.error.field).toBe("records");
    if (invalidDigestResult.ok === false) expect(invalidDigestResult.error.field).toBe("records");
  });

  it("rejects an event family assigned to the wrong persisted authority source", () => {
    const mismatched = makeRecord("offline_messages", "state.mutation.committed", "wrong-source", 100);
    const result = compileProductionActivity(
      makeInput([availableBatch("offline_messages", "telegram", [mismatched])]),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "records",
        message: "Normalized event kind is incompatible with its authoritative source",
      },
    });
  });

  it("requires every offline user prompt to reference a private content blob", () => {
    const withoutBlob = makeRecord(
      "offline_messages",
      "channel.normalized.text_received",
      "message-without-blob",
      100,
      { replay: { policy: "inject", payloadDigest: digest("metadata"), blobDigest: null } },
    );
    const result = compileProductionActivity(
      makeInput([availableBatch("offline_messages", "telegram", [withoutBlob])]),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "records",
        message: "Offline channel message is missing its private blob digest",
      },
    });
  });

  it("rejects a missing causal authority instead of silently detaching the child", () => {
    const child = makeRecord("session", "session.started", "child", 100, {
      causalParent: { sourceKind: "offline_messages", sourceId: "telegram", recordId: "missing" },
    });
    const result = compileProductionActivity(makeInput([availableBatch("session", "sessions", [child])]));

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toEqual({
        kind: "invalid_activity",
        field: "causality",
        message: "Causal parent is absent from normalized authority records",
      });
    }
  });

  it("forces every currently non-durable runtime authority to remain inexact", () => {
    const heartbeat = makeRecord("heartbeat", "heartbeat.completed", "heartbeat-a", 100);
    const dispatch = makeRecord("system_dispatch", "system.dispatch.completed", "dispatch-a", 101);
    const graph = makeRecord("graph", "graph.completed", "graph-a", 102, {
      traceId: "trace-graph-a",
      sessionId: "session-graph-a",
      runId: "run-graph-a",
    });
    const subagent = makeRecord("subagent", "subagent.completed", "subagent-a", 103, {
      traceId: "trace-subagent-a",
      sessionId: "session-subagent-a",
      runId: "run-subagent-a",
    });
    const result = compileProductionActivity(
      makeInput([
        availableBatch("heartbeat", "heartbeat", [heartbeat]),
        availableBatch("system_dispatch", "system-events", [dispatch]),
        availableBatch("graph", "graphs", [graph]),
        availableBatch("subagent", "subagents", [subagent]),
      ]),
    );

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.authorities.find(({ kind }) => kind === "heartbeat")?.gapReasons).toContain(
      "non_durable",
    );
    expect(
      result.value.authorities.find(({ kind }) => kind === "system_dispatch")?.gapReasons,
    ).toContain("non_durable");
    expect(result.value.authorities.find(({ kind }) => kind === "graph")?.gapReasons).toContain(
      "non_durable",
    );
    expect(result.value.authorities.find(({ kind }) => kind === "subagent")?.gapReasons).toContain(
      "non_durable",
    );
    expect(result.value.completeness.exactEligible).toBe(false);
  });

  it("derives explicit missing and unsupported authorities from the production evidence inventory", () => {
    const result = compileProductionActivity(makeInput([]));

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.authorities.find(({ kind }) => kind === "heartbeat")).toMatchObject({
      sourceId: "capture",
      status: "unsupported",
      gapReasons: ["non_durable"],
    });
    expect(result.value.authorities.find(({ kind }) => kind === "cron_store")).toMatchObject({
      sourceId: "capture",
      status: "missing",
      gapReasons: ["missing_artifact"],
    });
  });

  it("preserves mixed available and missing artifact gaps for an omitted extractor", () => {
    const evidence = makeEvidence({
      cache_traces: {
        id: "cache_traces",
        configured: "configured",
        availability: "available",
        readability: "readable",
        contentDigestSha256: digest("cache-traces"),
        records: 12,
      },
    });
    const result = compileProductionActivity({ ...makeInput([]), evidence });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.authorities.find(({ kind }) => kind === "cache")).toMatchObject({
      status: "unsupported",
      gapReasons: ["missing_artifact", "unsupported_source"],
    });
  });

  it("builds a target-local private vault invocation without interpolating operator input into code", () => {
    const result = buildTargetLocalActivityBlobVaultPlan({
      host: "comis-test2",
      port: 2222,
      service: "comis",
      serviceUser: "comis",
      dataDir: "/home/comis/.comis",
      replayRuntimeRoot: "/run/comis-replay",
      captureId: "capture-a",
      expectedMachineIdSha256: digest("machine"),
      channel: "telegram",
    });

    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.value.invocation).toMatchObject({
      host: "comis-test2",
      port: 2222,
      label: "extract-private-activity-vault",
      stdoutLimitBytes: 32_768,
    });
    expect(result.value.invocation.args).toEqual([
      "sudo",
      "--non-interactive",
      "--",
      "bash",
      "-s",
      "--",
      digest("machine"),
      "comis",
      "comis",
      "/home/comis/.comis",
      "/run/comis-replay",
      "capture-a",
      "telegram",
    ]);
    expect(result.value.invocation.stdin).not.toContain("comis-test2");
    expect(result.value.invocation.stdin).toContain("--include-internal");
    expect(result.value.invocation.stdin).toContain('"json-report"');
    expect(result.value.invocation.stdin).toContain("0o600");
    expect(result.value.invocation.stdin).toContain("0o700");
    expect(result.value.invocation.stdin).toContain("vault_stage");
    expect(result.value.invocation.stdin).toContain("trap cleanup EXIT");
    expect(result.value.invocation.stdin).toContain("mv -- \"$vault_stage\" \"$vault_dir\"");
    expect(result.value.invocation.stdin).toContain("id -gn \"$service_user\"");
    expect(result.value.invocation.stdin).toContain("systemctl is-active \"$unit\"");
    expect(result.value.invocation.stdin).toContain("[ -L \"$data_dir\" ]");
    expect(result.value.invocation.stdin).toContain("COMIS_ACTIVITY_COMIS_BIN");
    expect(result.value.invocation.stdin).toContain(".npm-global/bin/comis");
    expect(result.value.invocation.stdin).toContain("install -d -o root -g root -m 0700 \"$runtime_root\"");
    expect(result.value.invocation.stdin).toContain("recordId");
    expect(result.value.invocation.stdin).toContain("offline message routing metadata is invalid");
    expect(result.value.invocation.stdin).toContain("gapReasons");
    expect(result.value.invocation.stdin).toContain("coverage.filesUnreadable");
    expect(result.value.invocation.stdin).toContain("coverage.fileCapReached");
    expect(result.value.invocation.stdin).toContain("unreadable_artifact");
    expect(result.value.invocation.stdin).not.toContain(
      'messages.length === 10000\n    ? ["partial_retention", "count_unknown"]\n    : ["count_unknown"]',
    );
    expect(result.value.invocation.stdin).toContain("offline-messages.private.jsonl");
    expect(result.value.invocation.stdin).toContain("privateIndexDigestSha256");
    expect(result.value.stdoutDisposition).toBe("counts_digests_and_gaps_only");
    expect(result.value.rawContentDisposition).toBe("target_private_files_only");
    expect(result.value.vaultDir).toBe("/run/comis-replay/activity-vault/capture-a");
  });

  it("rejects unsafe vault roots and shell-shaped identifiers before constructing an invocation", () => {
    const base = {
      host: "comis-test2",
      service: "comis",
      serviceUser: "comis",
      dataDir: "/home/comis/.comis",
      replayRuntimeRoot: "/run/comis-replay",
      captureId: "capture-a",
      expectedMachineIdSha256: digest("machine"),
      channel: "telegram",
    } as const;

    expect(
      buildTargetLocalActivityBlobVaultPlan({ ...base, replayRuntimeRoot: "relative/root" }),
    ).toMatchObject({ ok: false, error: { field: "replayRuntimeRoot" } });
    expect(
      buildTargetLocalActivityBlobVaultPlan({ ...base, replayRuntimeRoot: "/etc/comis-replay" }),
    ).toMatchObject({ ok: false, error: { field: "replayRuntimeRoot" } });
    expect(
      buildTargetLocalActivityBlobVaultPlan({ ...base, serviceUser: "comis;id" }),
    ).toMatchObject({ ok: false, error: { field: "serviceUser" } });
    expect(
      buildTargetLocalActivityBlobVaultPlan({ ...base, captureId: "capture/../../root" }),
    ).toMatchObject({ ok: false, error: { field: "captureId" } });
  });

  it("keeps the generated target-local extraction program valid bash", () => {
    const syntax = spawnSync("bash", ["-n"], {
      input: buildTargetLocalActivityBlobVaultScript(),
      encoding: "utf8",
    });

    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe("");
  });

  it("accepts only a strict vault summary whose gaps match authoritative coverage", () => {
    const coverage = {
      filesScanned: 8,
      fileCapReached: false,
      filesUnreadable: 0,
      userRecordsSeen: 4,
      unparsedUserRecords: 0,
      recordCappedFiles: 0,
      internalExcluded: 0,
      truncated: false,
    };
    const summary = {
      schema: "comis-private-activity-vault-summary",
      schemaVersion: 1,
      recordCount: 4,
      uniqueBlobCount: 3,
      contentBytes: 120,
      indexDigestSha256: digest("public-index"),
      privateIndexDigestSha256: digest("private-index"),
      coverage,
      gapReasons: [],
    };

    const parsed = parseTargetLocalActivityBlobVaultSummary(`${JSON.stringify(summary)}\n`);
    expect(parsed).toEqual({ ok: true, value: summary });

    const hiddenGap = parseTargetLocalActivityBlobVaultSummary(
      JSON.stringify({
        ...summary,
        coverage: { ...coverage, filesUnreadable: 1 },
      }),
    );
    expect(hiddenGap).toMatchObject({ ok: false, error: { kind: "malformed_vault_summary" } });

    const extension = parseTargetLocalActivityBlobVaultSummary(
      JSON.stringify({ ...summary, privateBody: "must-not-cross-stdout" }),
    );
    expect(extension).toMatchObject({ ok: false, error: { kind: "malformed_vault_summary" } });
  });

  it("rejects cyclic activity input before attempting transcript classification", () => {
    const first = makeRecord("state", "state.mutation.requested", "first", 100, {
      causalParent: { sourceKind: "state", sourceId: "sqlite", recordId: "second" },
    });
    const second = makeRecord("state", "state.mutation.committed", "second", 101, {
      sourceSeq: 2,
      causalParent: { sourceKind: "state", sourceId: "sqlite", recordId: "first" },
    });
    const result = compileProductionActivity(
      makeInput([availableBatch("state", "sqlite", [first, second])]),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid_activity",
        field: "causality",
        message: "Normalized authority records contain a causal cycle",
      },
    });
  });
});
