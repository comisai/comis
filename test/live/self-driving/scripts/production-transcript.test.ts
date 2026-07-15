import { describe, expect, it } from "vitest";

import {
  CANONICAL_TRANSCRIPT_BEGIN,
  CANONICAL_TRANSCRIPT_END,
  MAX_CANONICAL_TRANSCRIPT_BYTES,
  TRANSCRIPT_EVENT_KINDS,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  TRANSCRIPT_SOURCE_EVENT_PREFIXES,
  buildOfflineMessagesSourcePlan,
  classifyTranscriptCompleteness,
  parseCanonicalProductionTranscript,
  type CanonicalProductionEvent,
  type CanonicalProductionTranscript,
  type TranscriptAuthoritySource,
  type TranscriptSourceKind,
} from "./production-transcript.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function makeEvent(
  seq: number,
  overrides: Partial<CanonicalProductionEvent> = {},
): CanonicalProductionEvent {
  return {
    seq,
    source: { kind: "session", id: "session-store", seq },
    kind: "session.turn.completed",
    eventId: `event-${seq}`,
    traceId: "trace-1",
    sessionId: "session-1",
    runId: "run-1",
    jobId: null,
    clockId: "boot-1",
    wallTimeMs: 1_000 + seq,
    monotonicTimeNs: String(10_000 + seq),
    causalParentEventId: seq === 1 ? null : `event-${seq - 1}`,
    actor: {
      kind: "agent",
      id: "agent-default",
      trust: "system",
      origin: "session",
    },
    replay: {
      policy: "assert",
      idempotencyKey: DIGEST_B,
      payloadDigest: DIGEST_A,
      blobDigest: null,
    },
    ...overrides,
  };
}

function transcript(events: readonly CanonicalProductionEvent[]): CanonicalProductionTranscript {
  return {
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: "capture-1",
    createdAtMs: 2_000,
    events,
  };
}

function encode(value: CanonicalProductionTranscript | Record<string, unknown>): string {
  return `${CANONICAL_TRANSCRIPT_BEGIN}\n${JSON.stringify(value)}\n${CANONICAL_TRANSCRIPT_END}\n`;
}

function representativeEvents(): CanonicalProductionEvent[] {
  return [
    makeEvent(1, {
      source: { kind: "offline_messages", id: "telegram", seq: 1 },
      kind: "channel.normalized.text_received",
      eventId: "event-native",
      runId: null,
      causalParentEventId: null,
      actor: { kind: "user", id: "user-hash", trust: "user", origin: "channel" },
      replay: { policy: "inject", idempotencyKey: DIGEST_A, payloadDigest: DIGEST_B, blobDigest: null },
    }),
    makeEvent(2, {
      source: { kind: "channel_normalized", id: "telegram", seq: 1 },
      kind: "channel.normalized.text_received",
      eventId: "event-normalized",
      runId: null,
      causalParentEventId: "event-native",
      actor: { kind: "system", id: null, trust: "system", origin: "orchestrator" },
    }),
    makeEvent(3, {
      source: { kind: "model_provider", id: "provider-main", seq: 1 },
      kind: "model.request.started",
      eventId: "event-model-request",
      causalParentEventId: "event-normalized",
    }),
    makeEvent(4, {
      source: { kind: "model_provider", id: "provider-main", seq: 2 },
      kind: "model.response.completed",
      eventId: "event-model-response",
      causalParentEventId: "event-model-request",
      replay: { policy: "stub", idempotencyKey: DIGEST_C, payloadDigest: DIGEST_A, blobDigest: null },
    }),
    makeEvent(5, {
      source: { kind: "delivery", id: "telegram-outbound", seq: 1 },
      kind: "outbound.acknowledged",
      eventId: "event-outbound-ack",
      causalParentEventId: "event-model-response",
      actor: { kind: "service", id: "telegram", trust: "system", origin: "delivery" },
    }),
  ];
}

function exactTranscriptAndAuthorities(): {
  captured: CanonicalProductionTranscript;
  authorities: TranscriptAuthoritySource[];
} {
  const eventKinds = {
    offline_messages: "channel.normalized.text_received",
    cron_store: "cron.revision.created",
    cron_execution: "cron.fire.started",
    heartbeat: "heartbeat.completed",
    proactive: "proactive.dispatched",
    system_dispatch: "system.dispatch.completed",
    session: "session.started",
    lcd: "lcd.message.appended",
    delivery: "outbound.delivered",
    memory: "memory.recall.completed",
    durable_run: "durable.run.resumed",
    state: "state.mutation.committed",
    config: "config.write.committed",
    channel_native: "channel.native.text_received",
    channel_normalized: "channel.normalized.text_received",
    orchestrator: "ingress.coalesce.flushed",
    internal_dispatch: "internal.dispatch.completed",
    subagent: "subagent.completed",
    graph: "graph.completed",
    daemon: "daemon.restart.detected",
    model_provider: "model.response.completed",
    tool_runtime: "tool.call.completed",
    mcp: "mcp.call.completed",
    web: "web.fetch.completed",
    media: "media.generation.completed",
    cache: "cache.read.hit",
    learning: "learning.outcome.recorded",
    context: "context.compacted",
    trajectory: "trajectory.append.completed",
    audit: "audit.command.blocked",
    diagnostics: "diagnostics.snapshot.created",
    background: "background.task.completed",
    runtime_artifact: "runtime.artifact.promoted",
    operator: "operator.action.completed",
    rpc: "rpc.request.completed",
    admin: "admin.action.authorized",
    deterministic_clock: "determinism.clock.consumed",
    deterministic_random: "determinism.random.consumed",
    deterministic_identifier: "determinism.identifier.consumed",
    dependency: "dependency.request.completed",
    channel_outbound: "channel.outbound.request.completed",
    filesystem: "filesystem.read.completed",
    environment: "environment.read.completed",
    external_io: "external.io.network.completed",
  } as const satisfies Record<(typeof TRANSCRIPT_EXACT_SOURCE_KINDS)[number], CanonicalProductionEvent["kind"]>;
  const events = TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind, index) =>
    makeEvent(index + 1, {
      source: { kind, id: `${kind}-source`, seq: 1 },
      kind: eventKinds[kind],
      eventId: `authority-event-${index + 1}`,
      traceId: /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(eventKinds[kind]) ? `trace-${index + 1}` : null,
      sessionId: /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(eventKinds[kind]) ? `session-${index + 1}` : null,
      runId: /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(eventKinds[kind]) ? `run-${index + 1}` : null,
      jobId: eventKinds[kind].startsWith("cron.") ? `job-${index + 1}` : null,
      causalParentEventId: index === 0 ? null : `authority-event-${index}`,
      actor: { kind: "system", id: null, trust: "system", origin: "state" },
    }),
  );
  return {
    captured: transcript(events),
    authorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => ({
      kind,
      sourceId: `${kind}-source`,
      status: "available",
      authoritativeCount: 1,
      gapReasons: [],
    })),
  };
}

function authority(
  kind: TranscriptSourceKind,
  status: TranscriptAuthoritySource["status"] = "available",
): TranscriptAuthoritySource {
  return {
    kind,
    sourceId: `${kind}-source`,
    status,
    ...(status === "available" ? { authoritativeCount: 1 } : {}),
    gapReasons: [],
  };
}

describe("canonical production transcript contract", () => {
  it("enumerates closed event kinds for every required production activity family", () => {
    for (const kind of [
      "channel.native.text_received",
      "channel.native.media_received",
      "channel.native.reply_received",
      "channel.native.edit_received",
      "channel.native.reaction_received",
      "channel.native.callback_received",
      "channel.native.location_received",
      "channel.native.webhook_received",
      "channel.normalized.text_received",
      "ingress.gate.rejected",
      "ingress.dedupe.dropped",
      "ingress.coalesce.flushed",
      "ingress.queue.dropped",
      "cron.revision.updated",
      "cron.fire.started",
      "cron.result.failed",
      "heartbeat.completed",
      "proactive.dispatched",
      "system.dispatch.completed",
      "internal.dispatch.completed",
      "subagent.completed",
      "graph.checkpointed",
      "durable.run.resumed",
      "daemon.restart.detected",
      "model.response.completed",
      "tool.call.completed",
      "mcp.call.completed",
      "web.fetch.completed",
      "media.generation.completed",
      "cache.read.hit",
      "memory.recall.completed",
      "learning.outcome.recorded",
      "context.compacted",
      "session.turn.completed",
      "lcd.message.appended",
      "outbound.retry.scheduled",
      "outbound.acknowledged",
      "outbound.failed",
      "state.mutation.committed",
    ]) {
      expect(TRANSCRIPT_EVENT_KINDS).toContain(kind);
    }
  });

  it("enumerates exact authority events for control, determinism, artifacts, and external boundaries", () => {
    expect(TRANSCRIPT_EVENT_KINDS as readonly string[]).toEqual(expect.arrayContaining([
      "config.read.completed",
      "config.write.committed",
      "config.write.rejected",
      "config.reload.completed",
      "trajectory.append.completed",
      "trajectory.offload.completed",
      "trajectory.pointer.updated",
      "trajectory.checkpoint.created",
      "audit.secret.access.granted",
      "audit.authentication.rejected",
      "audit.injection.blocked",
      "audit.capability.denied",
      "audit.command.blocked",
      "diagnostics.snapshot.created",
      "diagnostics.event.persisted",
      "diagnostics.event.dropped",
      "background.task.started",
      "background.task.completed",
      "runtime.artifact.discovered",
      "runtime.artifact.promoted",
      "runtime.artifact.rejected",
      "operator.action.requested",
      "operator.action.completed",
      "rpc.request.received",
      "rpc.request.completed",
      "admin.action.authorized",
      "admin.action.rejected",
      "determinism.clock.consumed",
      "determinism.random.consumed",
      "determinism.identifier.consumed",
      "dependency.request.started",
      "dependency.request.completed",
      "channel.outbound.request.started",
      "channel.outbound.request.completed",
      "filesystem.read.started",
      "filesystem.read.completed",
      "environment.read.started",
      "environment.read.completed",
      "external.io.network.started",
      "external.io.network.completed",
      "external.io.process.started",
      "external.io.process.completed",
    ]));

    expect(TRANSCRIPT_EXACT_SOURCE_KINDS as readonly string[]).toEqual(expect.arrayContaining([
      "operator",
      "rpc",
      "admin",
      "deterministic_clock",
      "deterministic_random",
      "deterministic_identifier",
      "dependency",
      "channel_outbound",
      "filesystem",
      "environment",
      "external_io",
    ]));
  });

  it("assigns every exact authority a real event family without state or daemon aliases", () => {
    const mappings = TRANSCRIPT_SOURCE_EVENT_PREFIXES as unknown as Readonly<
      Record<string, readonly string[]>
    >;
    const eventKinds = TRANSCRIPT_EVENT_KINDS as readonly string[];

    for (const sourceKind of TRANSCRIPT_EXACT_SOURCE_KINDS as readonly string[]) {
      const prefixes = mappings[sourceKind] ?? [];
      expect(prefixes.length, sourceKind).toBeGreaterThan(0);
      expect(
        eventKinds.some((eventKind) => prefixes.some((prefix) => eventKind.startsWith(prefix))),
        sourceKind,
      ).toBe(true);
    }

    expect(mappings.config).toEqual(["config."]);
    expect(mappings.trajectory).toEqual(["trajectory."]);
    expect(mappings.audit).toEqual(["audit."]);
    expect(mappings.diagnostics).toEqual(["diagnostics."]);
    expect(mappings.background).toEqual(["background."]);
    expect(mappings.runtime_artifact).toEqual(["runtime.artifact."]);
    expect(mappings.deterministic_clock).toEqual(["determinism.clock."]);
    expect(mappings.deterministic_random).toEqual(["determinism.random."]);
    expect(mappings.deterministic_identifier).toEqual(["determinism.identifier."]);
  });

  it("accepts representative events from each newly explicit exact authority", () => {
    const specifications = [
      ["config", "config.write.rejected", "config"],
      ["trajectory", "trajectory.pointer.updated", "trajectory"],
      ["audit", "audit.capability.denied", "audit"],
      ["diagnostics", "diagnostics.event.dropped", "diagnostics"],
      ["background", "background.task.completed", "background"],
      ["runtime_artifact", "runtime.artifact.promoted", "runtime_artifact"],
      ["operator", "operator.action.completed", "operator"],
      ["rpc", "rpc.request.completed", "rpc"],
      ["admin", "admin.action.authorized", "admin"],
      ["deterministic_clock", "determinism.clock.consumed", "determinism"],
      ["deterministic_random", "determinism.random.consumed", "determinism"],
      ["deterministic_identifier", "determinism.identifier.consumed", "determinism"],
      ["dependency", "dependency.request.completed", "dependency"],
      ["channel_outbound", "channel.outbound.request.completed", "channel_outbound"],
      ["filesystem", "filesystem.read.completed", "filesystem"],
      ["environment", "environment.read.completed", "environment"],
      ["external_io", "external.io.network.completed", "external_io"],
    ] as const;
    const events = specifications.map(([sourceKind, kind, origin], index) => {
      const event = structuredClone(makeEvent(index + 1)) as unknown as Record<string, unknown>;
      event.source = { kind: sourceKind, id: `${sourceKind}-source`, seq: 1 };
      event.kind = kind;
      event.eventId = `new-authority-event-${index + 1}`;
      event.traceId = sourceKind === "channel_outbound" ? `trace-${index + 1}` : null;
      event.sessionId = sourceKind === "channel_outbound" ? `session-${index + 1}` : null;
      event.runId = null;
      event.causalParentEventId = index === 0 ? null : `new-authority-event-${index}`;
      event.actor = {
        kind: sourceKind === "operator" || sourceKind === "admin" ? "operator" : "service",
        id: null,
        trust: sourceKind === "operator" || sourceKind === "admin" ? "admin" : "system",
        origin,
      };
      return event as unknown as CanonicalProductionEvent;
    });

    expect(parseCanonicalProductionTranscript(encode(transcript(events))).ok).toBe(true);
  });

  it("rejects cross-family assignments for each newly explicit exact authority", () => {
    const mismatches = [
      ["config", "trajectory.append.completed"],
      ["trajectory", "audit.command.blocked"],
      ["audit", "diagnostics.snapshot.created"],
      ["diagnostics", "background.task.started"],
      ["background", "runtime.artifact.discovered"],
      ["runtime_artifact", "config.reload.completed"],
      ["operator", "rpc.request.received"],
      ["rpc", "admin.action.authorized"],
      ["admin", "operator.action.requested"],
      ["deterministic_clock", "determinism.random.consumed"],
      ["deterministic_random", "determinism.identifier.consumed"],
      ["deterministic_identifier", "determinism.clock.consumed"],
      ["dependency", "channel.outbound.request.started"],
      ["channel_outbound", "dependency.request.started"],
      ["filesystem", "environment.read.started"],
      ["environment", "external.io.network.started"],
      ["external_io", "filesystem.read.started"],
    ] as const;

    for (const [sourceKind, kind] of mismatches) {
      const event = structuredClone(makeEvent(1)) as unknown as Record<string, unknown>;
      event.source = { kind: sourceKind, id: `${sourceKind}-source`, seq: 1 };
      event.kind = kind;
      event.eventId = `mismatched-${sourceKind}`;
      event.traceId = null;
      event.sessionId = null;
      event.runId = null;
      event.causalParentEventId = null;

      expect(parseCanonicalProductionTranscript(encode(transcript([
        event as unknown as CanonicalProductionEvent,
      ])))).toMatchObject({
        ok: false,
        error: { kind: "malformed_transcript", field: "events" },
      });
    }
  });

  it("parses a canonical causal ledger with global, source, clock, actor, and digest facts", () => {
    const result = parseCanonicalProductionTranscript(encode(transcript(representativeEvents())));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toHaveLength(5);
    expect(result.value.events[0]).toMatchObject({
      seq: 1,
      source: { kind: "offline_messages", id: "telegram", seq: 1 },
      replay: { policy: "inject", payloadDigest: DIGEST_B, blobDigest: null },
    });
  });

  it("rejects unknown keys or kinds, inline content, unsafe identifiers, and malformed digests", () => {
    const base = transcript(representativeEvents());
    const unknownKind = structuredClone(base) as unknown as Record<string, unknown>;
    ((unknownKind.events as Array<Record<string, unknown>>)[0] as Record<string, unknown>).kind = "channel.raw.body";
    expect(parseCanonicalProductionTranscript(encode(unknownKind)).ok).toBe(false);

    const inline = structuredClone(base) as unknown as Record<string, unknown>;
    ((inline.events as Array<Record<string, unknown>>)[0] as Record<string, unknown>).payload = {
      text: "PRIVATE_USER_PROMPT",
    };
    const inlineResult = parseCanonicalProductionTranscript(encode(inline));
    expect(inlineResult.ok).toBe(false);
    expect(JSON.stringify(inlineResult)).not.toContain("PRIVATE_USER_PROMPT");

    const unsafeId = structuredClone(base) as unknown as Record<string, unknown>;
    ((unsafeId.events as Array<Record<string, unknown>>)[0] as Record<string, unknown>).eventId = "bad id with spaces";
    expect(parseCanonicalProductionTranscript(encode(unsafeId)).ok).toBe(false);

    const badDigest = structuredClone(base) as unknown as Record<string, unknown>;
    const replay = ((badDigest.events as Array<Record<string, unknown>>)[0]?.replay) as Record<string, unknown>;
    replay.payloadDigest = "not-a-digest";
    expect(parseCanonicalProductionTranscript(encode(badDigest)).ok).toBe(false);
  });

  it("rejects sequence gaps, source gaps, invalid causal parents, duplicates, and clock regressions", () => {
    const cases = [
      representativeEvents().map((event, index) => (index === 1 ? { ...event, seq: 3 } : event)),
      representativeEvents().map((event, index) =>
        index === 3 ? { ...event, source: { ...event.source, seq: 3 } } : event,
      ),
      representativeEvents().map((event, index) =>
        index === 1 ? { ...event, causalParentEventId: "event-future" } : event,
      ),
      representativeEvents().map((event, index) =>
        index === 1 ? { ...event, eventId: "event-native" } : event,
      ),
      representativeEvents().map((event, index) =>
        index === 1 ? { ...event, monotonicTimeNs: "1" } : event,
      ),
    ];
    for (const events of cases) {
      expect(parseCanonicalProductionTranscript(encode(transcript(events))).ok).toBe(false);
    }
  });

  it("enforces applicable correlation IDs and media blob digests", () => {
    const cron = makeEvent(1, {
      source: { kind: "cron_execution", id: "cron", seq: 1 },
      kind: "cron.fire.started",
      eventId: "cron-event",
      jobId: null,
      causalParentEventId: null,
    });
    expect(parseCanonicalProductionTranscript(encode(transcript([cron]))).ok).toBe(false);

    const media = makeEvent(1, {
      source: { kind: "offline_messages", id: "telegram", seq: 1 },
      kind: "channel.native.media_received",
      eventId: "media-event",
      runId: null,
      causalParentEventId: null,
      replay: { policy: "inject", idempotencyKey: DIGEST_A, payloadDigest: DIGEST_B, blobDigest: null },
    });
    expect(parseCanonicalProductionTranscript(encode(transcript([media]))).ok).toBe(false);
  });

  it("rejects transcripts beyond the fixed byte bound", () => {
    expect(parseCanonicalProductionTranscript("x".repeat(MAX_CANONICAL_TRANSCRIPT_BYTES + 1)).ok).toBe(false);
  });

  it("rejects an event family assigned to an incompatible authority source", () => {
    const mismatched = makeEvent(1, {
      source: { kind: "offline_messages", id: "telegram", seq: 1 },
      kind: "state.mutation.committed",
      eventId: "wrong-authority-family",
      traceId: null,
      sessionId: null,
      runId: null,
      causalParentEventId: null,
    });

    expect(parseCanonicalProductionTranscript(encode(transcript([mismatched])))).toEqual({
      ok: false,
      error: {
        kind: "malformed_transcript",
        field: "events",
        message: "Transcript event kind is incompatible with its authority source",
      },
    });
  });
});

describe("historical transcript completeness", () => {
  it("grants deterministic cassette exact only when every authoritative source is gap-free", () => {
    const fixture = exactTranscriptAndAuthorities();
    const result = classifyTranscriptCompleteness(
      fixture.captured,
      fixture.authorities,
      "deterministic_cassette",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      fidelity: "deterministic_cassette_exact",
      exactEligible: true,
      authoritativeCount: fixture.authorities.length,
      transcriptCount: fixture.captured.events.length,
      gaps: [],
    });

    const withGap = fixture.authorities.map((source) =>
      source.kind === "daemon"
        ? { ...source, gapReasons: ["rotation_loss" as const] }
        : source,
    );
    const degraded = classifyTranscriptCompleteness(
      fixture.captured,
      withGap,
      "deterministic_cassette",
    );
    expect(degraded.ok).toBe(true);
    if (!degraded.ok) return;
    expect(degraded.value.fidelity).toBe("state_equivalent");
    expect(degraded.value.exactEligible).toBe(false);
    expect(degraded.value.gaps).toContainEqual(
      expect.objectContaining({ sourceKind: "daemon", reason: "declared_gap", captureGap: "rotation_loss" }),
    );
  });

  it("distinguishes historical, complete-input, state-equivalent, and live-provider fidelity", () => {
    const fixture = exactTranscriptAndAuthorities();
    const inputKinds = new Set<TranscriptSourceKind>([
      "offline_messages",
      "cron_store",
      "cron_execution",
      "heartbeat",
      "proactive",
      "system_dispatch",
    ]);
    const stateKinds = new Set<TranscriptSourceKind>([
      ...inputKinds,
      "session",
      "lcd",
      "delivery",
      "memory",
      "durable_run",
      "state",
      "config",
    ]);

    const inputOnlyAuthorities = fixture.authorities.map((source) =>
      inputKinds.has(source.kind) ? source : authority(source.kind, "missing"),
    );
    const inputOnly = classifyTranscriptCompleteness(
      fixture.captured,
      inputOnlyAuthorities,
      "deterministic_cassette",
    );
    expect(inputOnly.ok && inputOnly.value.fidelity).toBe("complete_input");

    const stateAuthorities = fixture.authorities.map((source) =>
      stateKinds.has(source.kind) ? source : authority(source.kind, "missing"),
    );
    const stateOnly = classifyTranscriptCompleteness(
      fixture.captured,
      stateAuthorities,
      "deterministic_cassette",
    );
    expect(stateOnly.ok && stateOnly.value.fidelity).toBe("state_equivalent");

    const live = classifyTranscriptCompleteness(
      fixture.captured,
      stateAuthorities,
      "live_provider",
    );
    expect(live.ok && live.value.fidelity).toBe("live_provider_semantic");

    const missingOffline = fixture.authorities.map((source) =>
      source.kind === "offline_messages" ? authority(source.kind, "missing") : source,
    );
    const historical = classifyTranscriptCompleteness(
      fixture.captured,
      missingOffline,
      "deterministic_cassette",
    );
    expect(historical.ok && historical.value.fidelity).toBe("historical_best_effort");
  });

  it("turns count mismatches and omitted required authorities into explicit gaps", () => {
    const fixture = exactTranscriptAndAuthorities();
    const mismatched = fixture.authorities.map((source) =>
      source.kind === "lcd" ? { ...source, authoritativeCount: 2 } : source,
    );
    const mismatch = classifyTranscriptCompleteness(
      fixture.captured,
      mismatched,
      "deterministic_cassette",
    );
    expect(mismatch.ok).toBe(true);
    if (!mismatch.ok) return;
    expect(mismatch.value.exactEligible).toBe(false);
    expect(mismatch.value.gaps).toContainEqual(
      expect.objectContaining({
        sourceKind: "lcd",
        reason: "count_mismatch",
        authoritativeCount: 2,
        transcriptCount: 1,
      }),
    );

    const omitted = classifyTranscriptCompleteness(
      fixture.captured,
      fixture.authorities.filter((source) => source.kind !== "cron_store"),
      "deterministic_cassette",
    );
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    expect(omitted.value.gaps).toContainEqual(
      expect.objectContaining({ sourceKind: "cron_store", reason: "required_source_omitted" }),
    );

    const finalEvent = fixture.captured.events.at(-1) as CanonicalProductionEvent;
    const unaccounted = transcript([
      ...fixture.captured.events,
      makeEvent(fixture.captured.events.length + 1, {
        source: { kind: "lcd", id: "lcd-shadow-source", seq: 1 },
        kind: "lcd.message.appended",
        eventId: "unaccounted-lcd-event",
        traceId: "trace-shadow",
        sessionId: "session-shadow",
        runId: "run-shadow",
        causalParentEventId: finalEvent.eventId,
        actor: { kind: "system", id: null, trust: "system", origin: "state" },
      }),
    ]);
    const missingAuthority = classifyTranscriptCompleteness(
      unaccounted,
      fixture.authorities,
      "deterministic_cassette",
    );
    expect(missingAuthority.ok).toBe(true);
    if (!missingAuthority.ok) return;
    expect(missingAuthority.value.exactEligible).toBe(false);
    expect(missingAuthority.value.gaps).toContainEqual(
      expect.objectContaining({
        sourceKind: "lcd",
        sourceId: "lcd-shadow-source",
        reason: "required_source_omitted",
      }),
    );
  });
});

describe("offline channel message source plan", () => {
  it("requires the offline comis messages source while forbidding body rendering", () => {
    const result = buildOfflineMessagesSourcePlan({
      host: "production.example.com",
      port: 2222,
      serviceUser: "comis",
      channel: "telegram",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        required: true,
        host: "production.example.com",
        port: 2222,
        runAsUser: "comis",
        command: [
          "comis",
          "messages",
          "--channel",
          "telegram",
          "--limit",
          "10000",
          "--format",
          "json",
        ],
        sourceKind: "offline_messages",
        stdoutDisposition: "private_blob_store_only",
        renderPolicy: "counts_digests_and_gaps_only",
      },
    });
    expect(JSON.stringify(result)).not.toContain("messageBody");
  });

  it("rejects unsafe channel or service-user values before producing a command", () => {
    expect(
      buildOfflineMessagesSourcePlan({
        host: "production.example.com",
        serviceUser: "comis",
        channel: "telegram; cat /etc/passwd",
      }).ok,
    ).toBe(false);
    expect(
      buildOfflineMessagesSourcePlan({
        host: "production.example.com",
        serviceUser: "bad user",
        channel: "telegram",
      }).ok,
    ).toBe(false);
  });
});
