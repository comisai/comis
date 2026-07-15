// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  formatProductionReplayBundleManifest,
  sealProductionReplayBundleManifest,
  type ProductionReplayBundleUnsignedManifest,
  type ReplayBundleBlob,
  type ReplayBundleBlobKind,
} from "./production-bundle.js";
import { type ReplayObservedRecord } from "./production-diff.js";
import {
  formatProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";
import {
  replayProductionTranscript,
  type ProductionReplayArtifactResolverPort,
  type ProductionReplayCheckpointPort,
  type ProductionReplayDeterminismPort,
  type ProductionReplayDriverPort,
  type ProductionReplayEnginePorts,
  type ProductionReplayEngineRequest,
  type ProductionReplayHardOraclePort,
  type ProductionReplayObserverPort,
  type ProductionReplayTrigger,
} from "./production-replay-engine.js";
import {
  CANONICAL_TRANSCRIPT_BEGIN,
  CANONICAL_TRANSCRIPT_END,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  parseCanonicalProductionTranscript,
  type CanonicalProductionEvent,
  type CanonicalProductionTranscript,
  type TranscriptSourceKind,
} from "./production-transcript.js";

const SEAL_KEY = Buffer.alloc(32, 23);
const MAX_EVENT_LAG_MS = 500;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeDigest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sequenceArtifact(kind: "clock" | "random" | "identifier"): Uint8Array {
  const records =
    kind === "clock"
      ? [{ ordinal: 1, valueMs: 1_752_560_000_000 }]
      : kind === "random"
        ? [{ ordinal: 1, valueBase64: Buffer.from([1, 2, 3, 4]).toString("base64") }]
        : [{ ordinal: 1, value: "generated-id-1" }];
  return jsonBytes({
    schema: "comis-production-replay-sequence",
    schemaVersion: 1,
    kind,
    records,
  });
}

function cassetteRequestArtifact(payload: Uint8Array): Uint8Array {
  return jsonBytes({
    schema: "comis-production-replay-cassette",
    schemaVersion: 1,
    direction: "request",
    cassetteId: "channel-1",
    kind: "channel",
    ordinal: 1,
    payloadBase64: Buffer.from(payload).toString("base64"),
  });
}

function cassetteResponseArtifact(): Uint8Array {
  return jsonBytes({
    schema: "comis-production-replay-cassette",
    schemaVersion: 1,
    direction: "response",
    cassetteId: "channel-1",
    kind: "channel",
    ordinal: 1,
    outcome: "success",
    latencyMs: 7,
    payloadBase64: Buffer.from("recorded-channel-response", "utf8").toString("base64"),
  });
}

function observedArtifact(
  kind: "expected_outputs" | "expected_state",
  records: readonly ReplayObservedRecord[],
): Uint8Array {
  return jsonBytes({
    schema: "comis-production-replay-observed-records",
    schemaVersion: 1,
    kind,
    records,
  });
}

function formatTranscript(transcript: CanonicalProductionTranscript): Uint8Array {
  return Buffer.from(
    `${CANONICAL_TRANSCRIPT_BEGIN}\n${JSON.stringify(transcript)}\n${CANONICAL_TRANSCRIPT_END}\n`,
    "utf8",
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stateDigest(records: readonly ReplayObservedRecord[]): string {
  const sorted = [...records].sort((left, right) =>
    `${left.surface}\0${left.recordId}`.localeCompare(
      `${right.surface}\0${right.recordId}`,
      "en",
    ),
  );
  return sha256(JSON.stringify(canonicalize(sorted)));
}

interface FixtureOptions {
  readonly target?: "deterministic_cassette" | "live_provider";
  readonly sequenceCountMismatch?: boolean;
  readonly duplicateExpectedState?: boolean;
}

interface StoredArtifact {
  readonly kind: ReplayBundleBlobKind;
  readonly digestSha256: string;
  readonly bytes: number;
  readonly plaintext: Uint8Array;
}

interface ReplayFixture {
  readonly request: ProductionReplayEngineRequest;
  readonly manifestDigestSha256: string;
  readonly transcript: CanonicalProductionTranscript;
  readonly triggerPayload: Uint8Array;
  readonly outputs: readonly ReplayObservedRecord[];
  readonly state: readonly ReplayObservedRecord[];
  readonly artifacts: ReadonlyMap<string, StoredArtifact>;
}

function event(
  seq: number,
  sourceKind: TranscriptSourceKind,
  kind: CanonicalProductionEvent["kind"],
  replay: CanonicalProductionEvent["replay"],
): CanonicalProductionEvent {
  const root = seq === 1;
  const needsContext = /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(kind);
  const needsRun = /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(kind);
  return {
    seq,
    source: { kind: sourceKind, id: `${sourceKind}-source`, seq: 1 },
    kind,
    eventId: `event-${seq}`,
    traceId: needsContext ? "trace-a" : null,
    sessionId: needsContext ? "session-a" : null,
    runId: needsRun ? "run-a" : null,
    jobId: kind.startsWith("cron.") ? "job-a" : null,
    clockId: "clock-a",
    wallTimeMs: 1_752_560_000_000 + seq * 10,
    monotonicTimeNs: String(seq),
    causalParentEventId: root ? null : `event-${seq - 1}`,
    actor: {
      kind: root ? "user" : "service",
      id: root ? "user_a" : "daemon",
      trust: root ? "user" : "system",
      origin: root ? "channel" : "state",
    },
    replay,
  };
}

function eventKindForSource(source: TranscriptSourceKind): CanonicalProductionEvent["kind"] {
  switch (source) {
    case "offline_messages": return "channel.normalized.text_received";
    case "channel_native": return "channel.native.text_received";
    case "channel_normalized": return "channel.normalized.text_received";
    case "orchestrator": return "ingress.gate.admitted";
    case "cron_store": return "cron.revision.created";
    case "cron_execution": return "cron.fire.started";
    case "heartbeat": return "heartbeat.requested";
    case "proactive": return "proactive.triggered";
    case "system_dispatch": return "system.dispatch.enqueued";
    case "internal_dispatch": return "internal.dispatch.enqueued";
    case "subagent": return "subagent.started";
    case "graph": return "graph.started";
    case "durable_run": return "durable.run.created";
    case "daemon": return "daemon.restart.detected";
    case "model_provider": return "model.request.started";
    case "tool_runtime": return "tool.call.started";
    case "mcp": return "mcp.call.started";
    case "web": return "web.fetch.started";
    case "media": return "media.resolve.started";
    case "cache": return "cache.read.hit";
    case "memory": return "memory.recall.started";
    case "learning": return "learning.observation.recorded";
    case "context": return "context.assembled";
    case "session": return "session.started";
    case "lcd": return "lcd.message.appended";
    case "delivery": return "outbound.attempt.started";
    case "state": return "state.mutation.committed";
    case "config": return "state.mutation.committed";
    case "trajectory": return "graph.checkpointed";
    case "audit": return "state.mutation.committed";
    case "diagnostics": return "daemon.recovery.completed";
    case "background": return "subagent.completed";
    case "runtime_artifact": return "daemon.shutdown.completed";
    case "replay": return "daemon.recovery.completed";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function makeFixture(options: FixtureOptions = {}): ReplayFixture {
  const blobs: ReplayBundleBlob[] = [];
  const artifacts = new Map<string, StoredArtifact>();
  const addArtifact = (kind: ReplayBundleBlobKind, plaintext: Uint8Array): string => {
    const digestSha256 = sha256(plaintext);
    const stored = {
      kind,
      digestSha256,
      bytes: plaintext.byteLength,
      plaintext: Uint8Array.from(plaintext),
    } as const;
    blobs.push({ kind, digestSha256, bytes: plaintext.byteLength });
    artifacts.set(digestSha256, stored);
    return digestSha256;
  };

  const runtimeArchive = addArtifact("runtime_archive", Buffer.from("runtime-archive"));
  const stateArchive = addArtifact("state_archive", Buffer.from("state-archive"));
  const snapshotManifest = addArtifact("snapshot_manifest", Buffer.from("snapshot-manifest"));
  const sourceEvidence = addArtifact("source_evidence", Buffer.from("source-evidence"));
  const targetEvidence = addArtifact("target_evidence", Buffer.from("target-evidence"));
  const triggerPayload = Buffer.from("private-channel-trigger", "utf8");
  const requestDigest = addArtifact("cassette_request", cassetteRequestArtifact(triggerPayload));
  const responseDigest = addArtifact("cassette_response", cassetteResponseArtifact());

  const orderedSources = [
    "channel_native",
    ...TRANSCRIPT_EXACT_SOURCE_KINDS.filter((kind) => kind !== "channel_native"),
  ] as const satisfies readonly TranscriptSourceKind[];
  const events = orderedSources.map((sourceKind, index) =>
    event(index + 1, sourceKind, eventKindForSource(sourceKind), {
      policy: index === 0 ? "inject" : index % 2 === 0 ? "assert" : "observe",
      idempotencyKey: sha256(`idempotency-${index + 1}`),
      payloadDigest: index === 0 ? sha256(triggerPayload) : sha256(`payload-${index + 1}`),
      blobDigest: index === 0 ? requestDigest : null,
    }),
  );
  const transcript: CanonicalProductionTranscript = {
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: "episode-prospective",
    createdAtMs: 1_752_559_999_000,
    events,
  };
  const transcriptProbe = parseCanonicalProductionTranscript(
    new TextDecoder().decode(formatTranscript(transcript)),
  );
  if (!transcriptProbe.ok) {
    throw new Error(`test transcript invalid: ${transcriptProbe.error.field}:${transcriptProbe.error.message}`);
  }
  const transcriptDigest = addArtifact("canonical_transcript", formatTranscript(transcript));
  const sequenceDigests = new Map(
    DETERMINISTIC_SEQUENCE_KINDS.map((kind) => [
      kind,
      addArtifact(`${kind}_sequence`, sequenceArtifact(kind)),
    ] as const),
  );

  const outputs: readonly ReplayObservedRecord[] = [
    {
      surface: "wire",
      recordId: "channel:delivery-1",
      valueDigest: sha256("delivered-output"),
      causalEventId: events.at(-1)?.eventId ?? null,
    },
  ];
  const stateRecord: ReplayObservedRecord = {
    surface: "sqlite",
    recordId: "memory:1",
    valueDigest: sha256("final-memory"),
    causalEventId: events.at(-1)?.eventId ?? null,
  };
  const state: readonly ReplayObservedRecord[] = options.duplicateExpectedState
    ? [stateRecord, { ...stateRecord }]
    : [stateRecord];
  const expectedOutputs = addArtifact(
    "expected_outputs",
    observedArtifact("expected_outputs", outputs),
  );
  const expectedState = addArtifact(
    "expected_state",
    observedArtifact("expected_state", state),
  );
  const target = options.target ?? "deterministic_cassette";
  const expectedStateDigest = stateDigest(state);
  const windowStartAtMs = Math.min(...events.map(({ wallTimeMs }) => wallTimeMs));
  const windowEndAtMs = Math.max(...events.map(({ wallTimeMs }) => wallTimeMs));
  const episode: ProductionCaptureEpisode = {
    schema: "comis-production-capture-episode",
    schemaVersion: 1,
    episodeId: transcript.captureId,
    captureMode: "prospective_window",
    window: {
      startAtMs: windowStartAtMs,
      endAtMs: windowEndAtMs,
      startBoundaryDigestSha256: fakeDigest(20),
      endBoundaryDigestSha256: fakeDigest(21),
      boundaryLedgerDigestSha256: fakeDigest(22),
      captureControllerIdentityDigestSha256: fakeDigest(23),
    },
    initialCheckpoint: {
      status: "captured",
      phase: "pre_window",
      capturedAtMs: windowStartAtMs - 1,
      quiescence: "verified",
      quiescenceAttestationDigestSha256: fakeDigest(24),
      snapshotManifestDigestSha256: snapshotManifest,
      stateTreeDigestSha256: fakeDigest(2),
      entryCount: 10,
      bytes: 2_000,
    },
    sourceAuthorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind, index) => ({
      kind,
      sourceIdDigestSha256: sha256(`${kind}-source`),
      status: "covered" as const,
      startWatermark: { sequence: 10, ledgerDigestSha256: fakeDigest(200 + index) },
      endWatermark: { sequence: 11, ledgerDigestSha256: fakeDigest(300 + index) },
      authoritativeCount: 1,
      transcriptCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(400 + index),
      gapReason: null,
    })),
    deterministicInputs: DETERMINISTIC_SEQUENCE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 20, ledgerDigestSha256: fakeDigest(500 + index) },
      endWatermark: {
        sequence: options.sequenceCountMismatch && kind === "random" ? 22 : 21,
        ledgerDigestSha256: fakeDigest(510 + index),
      },
      authoritativeCount: options.sequenceCountMismatch && kind === "random" ? 2 : 1,
      capturedCount: options.sequenceCountMismatch && kind === "random" ? 2 : 1,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(520 + index),
      gapReason: null,
    })),
    cassetteAuthorities: CASSETTE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 30, ledgerDigestSha256: fakeDigest(600 + index) },
      endWatermark: {
        sequence: kind === "channel" ? 31 : 30,
        ledgerDigestSha256: fakeDigest(610 + index),
      },
      authoritativeCount: kind === "channel" ? 1 : 0,
      cassetteCount: kind === "channel" ? 1 : 0,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(620 + index),
      gapReason: null,
    })),
    finalObservation: {
      status: "captured",
      phase: "post_window",
      observedAtMs: windowEndAtMs + 1,
      observerMode: "independent",
      observerIdentityDigestSha256: fakeDigest(25),
      observationAttestationDigestSha256: fakeDigest(26),
      outputIndexDigestSha256: expectedOutputs,
      outputCount: outputs.length,
      finalStateDigestSha256: expectedStateDigest,
      finalStateRecordCount: state.length,
      oracleObservationDigestSha256: fakeDigest(27),
    },
    replayInput: {
      target,
      classification:
        target === "deterministic_cassette"
          ? "deterministic_cassette_exact"
          : "live_provider_semantic",
      exactEligible: target === "deterministic_cassette",
      inputSetDigestSha256: fakeDigest(28),
      gaps: [],
    },
    correctness: {
      oracleSetDigestSha256: fakeDigest(29),
      oracleCount: 1,
      production: { observationDigestSha256: fakeDigest(27), verdict: "fail" },
      desired: { observationDigestSha256: fakeDigest(30), verdict: "pass" },
    },
  };
  const episodeEnvelope = formatProductionCaptureEpisode(episode);
  if (!episodeEnvelope.ok) {
    throw new Error(`test episode invalid: ${episodeEnvelope.error.field}`);
  }
  const episodeDigest = addArtifact("capture_episode", Buffer.from(episodeEnvelope.value));
  const runtimeIdentity = {
    digestSha256: fakeDigest(1),
    entryCount: 10,
    bytes: 1_000,
    version: "1.0.53",
  } as const;
  const stateIdentity = {
    treeDigestSha256: fakeDigest(2),
    entryCount: 10,
    bytes: 2_000,
  } as const;
  const unsigned: ProductionReplayBundleUnsignedManifest = {
    schema: "comis-production-replay-bundle",
    schemaVersion: 1,
    bundleId: transcript.captureId,
    createdAtMs: windowEndAtMs + 1_000,
    attestations: {
      source: {
        role: "production_source",
        machineIdSha256: fakeDigest(3),
        profileDigestSha256: fakeDigest(4),
        evidenceBlobDigestSha256: sourceEvidence,
      },
      target: {
        role: "replay_target",
        machineIdSha256: fakeDigest(5),
        profileDigestSha256: fakeDigest(6),
        evidenceBlobDigestSha256: targetEvidence,
      },
      runtime: {
        archiveBlobDigestSha256: runtimeArchive,
        source: runtimeIdentity,
        target: { ...runtimeIdentity },
        exact: true,
      },
      state: {
        snapshotManifestBlobDigestSha256: snapshotManifest,
        archiveBlobDigestSha256: stateArchive,
        captureMode: "offline",
        source: stateIdentity,
        target: { ...stateIdentity },
        exact: true,
      },
    },
    vault: {
      format: "aes-256-gcm-detached-v1",
      encryptionKeyIdSha256: fakeDigest(7),
      blobs,
    },
    episode: {
      blobDigestSha256: episodeDigest,
      episodeId: transcript.captureId,
      captureMode: "prospective_window",
      windowStartAtMs,
      windowEndAtMs,
      initialCheckpointSnapshotManifestDigestSha256: snapshotManifest,
      inputSetDigestSha256: episode.replayInput.inputSetDigestSha256,
      target,
      classification: episode.replayInput.classification,
      exactEligible: episode.replayInput.exactEligible,
    },
    transcript: {
      blobDigestSha256: transcriptDigest,
      captureId: transcript.captureId,
      eventCount: events.length,
      authorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => ({
        kind,
        sourceId: `${kind}-source`,
        status: "available",
        authoritativeCount: 1,
        transcriptCount: 1,
        gapReasons: [],
      })),
    },
    determinism: {
      sequences: DETERMINISTIC_SEQUENCE_KINDS.map((kind) => ({
        kind,
        status: "captured",
        recordCount: options.sequenceCountMismatch && kind === "random" ? 2 : 1,
        blobDigestSha256: sequenceDigests.get(kind) as string,
        gapReason: null,
      })),
      cassetteAuthorities: CASSETTE_KINDS.map((kind) => ({
        kind,
        status: "captured",
        authoritativeCount: kind === "channel" ? 1 : 0,
        cassetteCount: kind === "channel" ? 1 : 0,
        gapReason: null,
      })),
      cassettes: [
        {
          cassetteId: "channel-1",
          kind: "channel",
          ordinal: 1,
          requestBlobDigestSha256: requestDigest,
          responseBlobDigestSha256: responseDigest,
          outcome: "success",
          latencyMs: 7,
        },
      ],
    },
    expected: {
      outputCount: outputs.length,
      outputBlobDigestSha256: expectedOutputs,
      finalStateRecordCount: state.length,
      finalStateBlobDigestSha256: expectedState,
      finalStateDigestSha256: expectedStateDigest,
    },
    fidelity:
      target === "deterministic_cassette"
        ? {
            classification: "deterministic_cassette_exact",
            target,
            exactEligible: true,
            gaps: [],
          }
        : {
            classification: "live_provider_semantic",
            target,
            exactEligible: false,
            gaps: [
              { kind: "live_provider_nondeterminism", componentId: null, sourceKind: null },
            ],
          },
  };
  const sealed = sealProductionReplayBundleManifest(unsigned, SEAL_KEY);
  if (!sealed.ok) throw new Error(`test replay bundle did not seal: ${JSON.stringify(sealed.error)}`);
  return {
    request: {
      sealedBundleEnvelope: formatProductionReplayBundleManifest(sealed.value),
      sealKey: SEAL_KEY,
      maxEventLagMs: MAX_EVENT_LAG_MS,
    },
    manifestDigestSha256: sealed.value.seal.manifestDigestSha256,
    transcript,
    triggerPayload,
    outputs,
    state,
    artifacts,
  };
}

interface PortOptions {
  readonly checkpointKind?: "prospective_pre_window" | "historical_snapshot";
  readonly driver?: (
    determinismCalls: string[],
    triggers: ProductionReplayTrigger[],
  ) => ProductionReplayDriverPort;
  readonly observedEvents?: readonly CanonicalProductionEvent[];
  readonly observedOutputs?: readonly ReplayObservedRecord[];
  readonly observedState?: readonly ReplayObservedRecord[];
  readonly hardOraclePassed?: boolean;
}

function consumingDriver(
  calls: string[],
  triggers: ProductionReplayTrigger[],
): ProductionReplayDriverPort {
  let determinism: ProductionReplayDeterminismPort | null = null;
  return {
    start: (input) => {
      determinism = input.determinism;
      calls.push("start");
      input.determinism.nextClock();
      input.determinism.nextRandom(4);
      input.determinism.nextIdentifier();
      return ok(undefined);
    },
    injectTrigger: (trigger) => {
      triggers.push(trigger);
      calls.push("inject");
      determinism?.consumeCassette("channel", trigger.payload);
      return ok(undefined);
    },
    finish: () => {
      calls.push("finish");
      return ok(undefined);
    },
  };
}

function makePorts(
  fixture: ReplayFixture,
  options: PortOptions = {},
): {
  readonly ports: ProductionReplayEnginePorts;
  readonly driverCalls: string[];
  readonly triggers: ProductionReplayTrigger[];
  readonly deadlines: number[];
  readonly resolver: ProductionReplayArtifactResolverPort;
} {
  const driverCalls: string[] = [];
  const triggers: ProductionReplayTrigger[] = [];
  const deadlines: number[] = [];
  const resolver: ProductionReplayArtifactResolverPort = {
    resolve: vi.fn(({ digestSha256 }) => {
      const artifact = fixture.artifacts.get(digestSha256);
      if (artifact === undefined) throw new Error("test artifact missing");
      return ok({
        authentication: "verified" as const,
        kind: artifact.kind,
        digestSha256: artifact.digestSha256,
        bytes: artifact.bytes,
        plaintext: Uint8Array.from(artifact.plaintext),
      });
    }),
  };
  const checkpoint: ProductionReplayCheckpointPort = {
    attest: () =>
      ok({
        authentication: "verified",
        kind: options.checkpointKind ?? "prospective_pre_window",
        manifestDigestSha256: fixture.manifestDigestSha256,
        runtimeDigestSha256: fakeDigest(1),
        stateDigestSha256: fakeDigest(2),
        completedAtMs: fixture.transcript.events[0]!.wallTimeMs - 1,
      }),
  };
  const eventQueue = [...(options.observedEvents ?? fixture.transcript.events)].map((entry) =>
    structuredClone(entry),
  );
  const observer: ProductionReplayObserverPort = {
    start: () => ok(undefined),
    nextEvent: ({ deadlineWallTimeMs }) => {
      deadlines.push(deadlineWallTimeMs);
      return ok(eventQueue.shift() ?? null);
    },
    finish: () =>
      ok({
        outputs: structuredClone(options.observedOutputs ?? fixture.outputs),
        state: structuredClone(options.observedState ?? fixture.state),
      }),
  };
  const hardOracle: ProductionReplayHardOraclePort = {
    evaluate: () =>
      ok({
        checks: [
          {
            oracleIdSha256: sha256("delivery-hard-oracle"),
            passed: options.hardOraclePassed ?? true,
            evidenceDigestSha256: sha256("delivery-hard-oracle-evidence"),
          },
        ],
      }),
  };
  const driverFactory = options.driver ?? consumingDriver;
  return {
    ports: {
      artifacts: resolver,
      checkpoint,
      driver: driverFactory(driverCalls, triggers),
      observer,
      hardOracle,
    },
    driverCalls,
    triggers,
    deadlines,
    resolver,
  };
}

describe("independent production replay engine contract", () => {
  it("injects only a causal-root input and independently observes the full exact transcript", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      engineKind: "generic_contract",
      status: "accepted",
      fidelityMatched: true,
      correctness: "passed",
      exact: true,
      injectedTriggerCount: 1,
      expectedEventCount: fixture.transcript.events.length,
      observedEventCount: fixture.transcript.events.length,
      hardOracleCheckCount: 1,
      hardOracleFailedCount: 0,
    });
    expect(result.value.expectedStateDigestSha256).toBe(
      stateDigest(fixture.state),
    );
    expect(result.value.actualStateDigestSha256).toBe(
      stateDigest(fixture.state),
    );
    expect(harness.driverCalls).toEqual(["start", "inject", "finish"]);
    expect(harness.triggers).toHaveLength(1);
    expect(harness.triggers[0]).toMatchObject({
      kind: "channel.native.text_received",
      sourceKind: "channel_native",
      payloadDigestSha256: sha256(fixture.triggerPayload),
    });
    expect(Object.keys(harness.triggers[0] as unknown as Record<string, unknown>)).not.toContain(
      "event",
    );
    expect(Object.keys(harness.triggers[0] as unknown as Record<string, unknown>)).not.toContain(
      "eventId",
    );
    expect(harness.deadlines).toHaveLength(fixture.transcript.events.length + 1);
    expect(harness.deadlines[0]).toBe(
      fixture.transcript.events[0]!.wallTimeMs + MAX_EVENT_LAG_MS,
    );
    expect(harness.resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "capture_episode" }),
    );
  });

  it("cannot match when a no-op driver and independent observer produce no activity", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, {
      observedEvents: [],
      observedOutputs: [],
      observedState: [],
      driver: () => ({
        start: () => ok(undefined),
        injectTrigger: () => ok(undefined),
        finish: () => ok(undefined),
      }),
    });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "divergence",
        phase: "event_missing",
        expectedEventSeq: 1,
        observedEventCount: 0,
      },
    });
  });

  it("never dispatches assert or observe events to the target driver", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result.ok).toBe(true);
    expect(harness.triggers).toHaveLength(1);
    expect(harness.triggers.map(({ kind }) => kind)).toEqual(["channel.native.text_received"]);
  });

  it("fails when a captured cassette is not consumed by the target", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, {
      driver: (calls) => ({
        start: ({ determinism }) => {
          calls.push("start");
          determinism.nextClock();
          determinism.nextRandom(4);
          determinism.nextIdentifier();
          return ok(undefined);
        },
        injectTrigger: () => ok(undefined),
        finish: () => ok(undefined),
      }),
    });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "determinism_violation", use: "under", component: "cassette" },
    });
  });

  it("fails even when a target swallows a cassette over-call error", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, {
      driver: (calls, triggers) => {
        let determinism: ProductionReplayDeterminismPort | null = null;
        return {
          start: (input) => {
            determinism = input.determinism;
            input.determinism.nextClock();
            input.determinism.nextRandom(4);
            input.determinism.nextIdentifier();
            return ok(undefined);
          },
          injectTrigger: (trigger) => {
            triggers.push(trigger);
            determinism?.consumeCassette("channel", trigger.payload);
            determinism?.consumeCassette("channel", trigger.payload);
            return ok(undefined);
          },
          finish: () => {
            calls.push("finish");
            return ok(undefined);
          },
        };
      },
    });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "determinism_violation", use: "over", component: "cassette" },
    });
  });

  it("rejects a deterministic sequence whose parsed count disagrees with its sealed manifest", async () => {
    const fixture = makeFixture({ sequenceCountMismatch: true });
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "artifact_invalid", artifact: "random_sequence" },
    });
    expect(harness.driverCalls).toEqual([]);
  });

  it("rejects duplicate records in the sealed expected-state artifact before driving replay", async () => {
    const fixture = makeFixture({ duplicateExpectedState: true });
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "artifact_invalid", artifact: "expected_state" },
    });
    expect(harness.driverCalls).toEqual([]);
  });

  it("compares independently parsed expected records with observer records", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, { observedOutputs: [] });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "divergence", phase: "observed_records" },
    });
  });

  it("refuses an exact claim without an authenticated prospective pre-window checkpoint", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, { checkpointKind: "historical_snapshot" });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "checkpoint_ineligible" },
    });
    expect(harness.driverCalls).toEqual([]);
  });

  it("never reports exact when the sealed target uses live providers", async () => {
    const fixture = makeFixture({ target: "live_provider" });
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelityMatched).toBe(true);
    expect(result.value.exact).toBe(false);
  });

  it("separates a production correctness failure from a matching fidelity oracle", async () => {
    const fixture = makeFixture();
    const harness = makePorts(fixture, { hardOraclePassed: false });

    const result = await replayProductionTranscript(fixture.request, harness.ports);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      status: "correctness_failed",
      fidelityMatched: true,
      correctness: "failed",
      exact: true,
      hardOracleCheckCount: 1,
      hardOracleFailedCount: 1,
    });
  });

  it("does not expose private trigger or provider failure content in errors", async () => {
    const fixture = makeFixture();
    const privateText = Buffer.from("PRIVATE_USER_PROMPT", "utf8");
    const artifacts: ProductionReplayArtifactResolverPort = {
      resolve: () => Promise.reject(new Error(privateText.toString("utf8"))),
    };
    const harness = makePorts(fixture);

    const result = await replayProductionTranscript(fixture.request, {
      ...harness.ports,
      artifacts,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateText.toString("utf8"));
  });
});
