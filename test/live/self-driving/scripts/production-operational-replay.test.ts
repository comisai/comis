// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from "node:crypto";

import { ok } from "@comis/shared";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  formatProductionReplayBundleManifest,
  parseProductionReplayBundleManifest,
  sealProductionReplayBundleManifest,
  type ProductionReplayBundleManifest,
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
  buildOperationalReplayProcessPlan,
  digestOperationalReplayCassetteSet,
  runOperationalProductionReplay,
  verifyOperationalReplayResultSeal,
  type OperationalReplayControllerRequest,
  type OperationalReplayProcessPlan,
  type OperationalReplayResult,
  type OperationalReplayWorkerPort,
} from "./production-operational-replay.js";
import {
  type ProductionReplayDeterminismPort,
  type ProductionReplayEnginePorts,
  type ProductionReplayTrigger,
} from "./production-replay-engine.js";
import {
  CANONICAL_TRANSCRIPT_BEGIN,
  CANONICAL_TRANSCRIPT_END,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
  parseCanonicalProductionTranscript,
  type CanonicalProductionEvent,
  type CanonicalProductionTranscript,
} from "./production-transcript.js";

type ExactTranscriptSourceKind = (typeof TRANSCRIPT_EXACT_SOURCE_KINDS)[number];

const BUNDLE_SEAL_KEY = Buffer.alloc(32, 41);
const RESULT_SEAL_KEY = Buffer.alloc(32, 42);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeDigest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function formatTranscript(transcript: CanonicalProductionTranscript): Uint8Array {
  return Buffer.from(
    `${CANONICAL_TRANSCRIPT_BEGIN}\n${JSON.stringify(transcript)}\n${CANONICAL_TRANSCRIPT_END}\n`,
    "utf8",
  );
}

function sequenceArtifact(kind: "clock" | "random" | "identifier"): Uint8Array {
  const records =
    kind === "clock"
      ? [{ ordinal: 1, valueMs: 1_752_560_000_000 }]
      : kind === "random"
        ? [
            {
              ordinal: 1,
              valueBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
            },
          ]
        : [{ ordinal: 1, value: "generated-id-1" }];
  return jsonBytes({
    schema: "comis-production-replay-sequence",
    schemaVersion: 1,
    kind,
    records,
  });
}

function cassetteArtifact(
  direction: "request" | "response",
  payload: Uint8Array,
): Uint8Array {
  return jsonBytes(
    direction === "request"
      ? {
          schema: "comis-production-replay-cassette",
          schemaVersion: 1,
          direction,
          cassetteId: "channel-1",
          kind: "channel",
          ordinal: 1,
          payloadBase64: Buffer.from(payload).toString("base64"),
        }
      : {
          schema: "comis-production-replay-cassette",
          schemaVersion: 1,
          direction,
          cassetteId: "channel-1",
          kind: "channel",
          ordinal: 1,
          outcome: "success",
          latencyMs: 7,
          payloadBase64: Buffer.from("recorded-reply", "utf8").toString("base64"),
        },
  );
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

function eventKindForSource(
  source: ExactTranscriptSourceKind,
): CanonicalProductionEvent["kind"] {
  switch (source) {
    case "offline_messages":
      return "channel.normalized.text_received";
    case "channel_native":
      return "channel.native.text_received";
    case "channel_normalized":
      return "channel.normalized.text_received";
    case "orchestrator":
      return "ingress.gate.admitted";
    case "cron_store":
      return "cron.revision.created";
    case "cron_execution":
      return "cron.fire.started";
    case "heartbeat":
      return "heartbeat.requested";
    case "proactive":
      return "proactive.triggered";
    case "system_dispatch":
      return "system.dispatch.enqueued";
    case "internal_dispatch":
      return "internal.dispatch.enqueued";
    case "subagent":
      return "subagent.started";
    case "graph":
      return "graph.started";
    case "durable_run":
      return "durable.run.created";
    case "daemon":
      return "daemon.restart.detected";
    case "model_provider":
      return "model.request.started";
    case "tool_runtime":
      return "tool.call.started";
    case "mcp":
      return "mcp.call.started";
    case "web":
      return "web.fetch.started";
    case "media":
      return "media.resolve.started";
    case "cache":
      return "cache.read.hit";
    case "memory":
      return "memory.recall.started";
    case "learning":
      return "learning.observation.recorded";
    case "context":
      return "context.assembled";
    case "session":
      return "session.started";
    case "lcd":
      return "lcd.message.appended";
    case "delivery":
      return "outbound.attempt.started";
    case "state":
      return "state.mutation.committed";
    case "config":
      return "config.read.completed";
    case "audit":
      return "audit.command.allowed";
    case "trajectory":
      return "trajectory.checkpoint.created";
    case "diagnostics":
      return "diagnostics.snapshot.created";
    case "background":
      return "background.task.completed";
    case "runtime_artifact":
      return "runtime.artifact.verified";
    case "operator":
      return "operator.action.completed";
    case "rpc":
      return "rpc.request.completed";
    case "admin":
      return "admin.action.completed";
    case "deterministic_clock":
      return "determinism.clock.consumed";
    case "deterministic_random":
      return "determinism.random.consumed";
    case "deterministic_identifier":
      return "determinism.identifier.consumed";
    case "dependency":
      return "dependency.request.completed";
    case "channel_outbound":
      return "channel.outbound.request.completed";
    case "filesystem":
      return "filesystem.read.completed";
    case "environment":
      return "environment.read.completed";
    case "external_io":
      return "external.io.network.completed";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function makeEvent(
  seq: number,
  sourceKind: ExactTranscriptSourceKind,
  triggerPayloadDigestSha256: string,
  triggerBlobDigestSha256: string,
): CanonicalProductionEvent {
  const kind = eventKindForSource(sourceKind);
  const root = seq === 1;
  const needsContext = /^(?:channel\.|ingress\.|heartbeat\.|proactive\.|system\.dispatch\.|internal\.dispatch\.|subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.|lcd\.|outbound\.)/u.test(
    kind,
  );
  const needsRun = /^(?:subagent\.|graph\.|model\.|tool\.|mcp\.|web\.|media\.|cache\.|memory\.|learning\.|context\.|session\.turn\.|lcd\.|outbound\.)/u.test(
    kind,
  );
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
    replay: {
      policy: root ? "inject" : seq % 2 === 0 ? "assert" : "observe",
      idempotencyKey: sha256(`idempotency-${seq}`),
      payloadDigest: root ? triggerPayloadDigestSha256 : sha256(`payload-${seq}`),
      blobDigest: root ? triggerBlobDigestSha256 : null,
    },
  };
}

interface StoredArtifact {
  readonly kind: ReplayBundleBlobKind;
  readonly digestSha256: string;
  readonly bytes: number;
  readonly plaintext: Uint8Array;
}

interface OperationalFixture {
  readonly manifest: ProductionReplayBundleManifest;
  readonly request: OperationalReplayControllerRequest;
  readonly transcript: CanonicalProductionTranscript;
  readonly triggerPayload: Uint8Array;
  readonly outputs: readonly ReplayObservedRecord[];
  readonly state: readonly ReplayObservedRecord[];
  readonly artifacts: ReadonlyMap<string, StoredArtifact>;
}

function makeFixture(): OperationalFixture {
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
  const runtimeArchive = addArtifact("runtime_archive", Buffer.from("runtime"));
  const stateArchive = addArtifact("state_archive", Buffer.from("state"));
  const snapshotManifest = addArtifact(
    "snapshot_manifest",
    Buffer.from("snapshot-manifest"),
  );
  const sourceEvidence = addArtifact("source_evidence", Buffer.from("source"));
  const targetEvidence = addArtifact("target_evidence", Buffer.from("target"));
  const triggerPayload = Buffer.from("normalized channel text fixture", "utf8");
  const cassetteRequest = addArtifact(
    "cassette_request",
    cassetteArtifact("request", triggerPayload),
  );
  const cassetteResponse = addArtifact(
    "cassette_response",
    cassetteArtifact("response", Buffer.alloc(0)),
  );
  const orderedSources = [
    "channel_native",
    ...TRANSCRIPT_EXACT_SOURCE_KINDS.filter((kind) => kind !== "channel_native"),
  ] as const satisfies readonly ExactTranscriptSourceKind[];
  const events = orderedSources.map((sourceKind, index) =>
    makeEvent(index + 1, sourceKind, sha256(triggerPayload), cassetteRequest),
  );
  const transcript: CanonicalProductionTranscript = {
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId: "operational-episode-1",
    createdAtMs: 1_752_559_999_000,
    events,
  };
  const parsedTranscript = parseCanonicalProductionTranscript(
    new TextDecoder().decode(formatTranscript(transcript)),
  );
  if (!parsedTranscript.ok) {
    throw new Error(`test transcript invalid: ${parsedTranscript.error.message}`);
  }
  const transcriptDigest = addArtifact(
    "canonical_transcript",
    formatTranscript(transcript),
  );
  const sequenceDigests = new Map(
    DETERMINISTIC_SEQUENCE_KINDS.map(
      (kind) =>
        [kind, addArtifact(`${kind}_sequence`, sequenceArtifact(kind))] as const,
    ),
  );
  const outputs: readonly ReplayObservedRecord[] = [
    {
      surface: "wire",
      recordId: "record-only:reply-1",
      valueDigest: sha256("recorded-reply"),
      causalEventId: events.at(-1)?.eventId ?? null,
    },
  ];
  const state: readonly ReplayObservedRecord[] = [
    {
      surface: "sqlite",
      recordId: "session:normalized-text-1",
      valueDigest: sha256("normalized channel text fixture"),
      causalEventId: events.at(-1)?.eventId ?? null,
    },
  ];
  const expectedOutputs = addArtifact(
    "expected_outputs",
    observedArtifact("expected_outputs", outputs),
  );
  const expectedState = addArtifact(
    "expected_state",
    observedArtifact("expected_state", state),
  );
  const windowStartAtMs = events[0]!.wallTimeMs;
  const windowEndAtMs = events.at(-1)!.wallTimeMs;
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
      startWatermark: { sequence: 10, ledgerDigestSha256: fakeDigest(100 + index) },
      endWatermark: { sequence: 11, ledgerDigestSha256: fakeDigest(200 + index) },
      authoritativeCount: 1,
      transcriptCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(300 + index),
      gapReason: null,
    })),
    deterministicInputs: DETERMINISTIC_SEQUENCE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 20, ledgerDigestSha256: fakeDigest(400 + index) },
      endWatermark: { sequence: 21, ledgerDigestSha256: fakeDigest(410 + index) },
      authoritativeCount: 1,
      capturedCount: 1,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(420 + index),
      gapReason: null,
    })),
    cassetteAuthorities: CASSETTE_KINDS.map((kind, index) => ({
      kind,
      status: "covered" as const,
      startWatermark: { sequence: 30, ledgerDigestSha256: fakeDigest(500 + index) },
      endWatermark: {
        sequence: kind === "channel" ? 31 : 30,
        ledgerDigestSha256: fakeDigest(510 + index),
      },
      authoritativeCount: kind === "channel" ? 1 : 0,
      cassetteCount: kind === "channel" ? 1 : 0,
      contiguous: true,
      coverageAttestationDigestSha256: fakeDigest(520 + index),
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
      finalStateDigestSha256: stateDigest(state),
      finalStateRecordCount: state.length,
      oracleObservationDigestSha256: fakeDigest(27),
    },
    replayInput: {
      target: "deterministic_cassette",
      classification: "deterministic_cassette_exact",
      exactEligible: true,
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
  const episodeDigest = addArtifact(
    "capture_episode",
    Buffer.from(episodeEnvelope.value, "utf8"),
  );
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
      contentDigestSha256: sha256(episodeEnvelope.value),
      episodeId: transcript.captureId,
      captureMode: "prospective_window",
      windowStartAtMs,
      windowEndAtMs,
      initialCheckpointSnapshotManifestDigestSha256: snapshotManifest,
      inputSetDigestSha256: episode.replayInput.inputSetDigestSha256,
      target: "deterministic_cassette",
      classification: "deterministic_cassette_exact",
      exactEligible: true,
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
        recordCount: 1,
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
          requestBlobDigestSha256: cassetteRequest,
          responseBlobDigestSha256: cassetteResponse,
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
      finalStateDigestSha256: stateDigest(state),
    },
    fidelity: {
      classification: "deterministic_cassette_exact",
      target: "deterministic_cassette",
      exactEligible: true,
      gaps: [],
    },
  };
  const sealed = sealProductionReplayBundleManifest(unsigned, BUNDLE_SEAL_KEY);
  if (!sealed.ok) throw new Error(`test bundle invalid: ${sealed.error.message}`);
  const manifest = sealed.value;
  return {
    manifest,
    request: {
      runId: "operational-run-1",
      baselinePath: "/var/lib/comis-self-driving/baselines/episode-1",
      workspaceRoot: "/var/lib/comis-self-driving/runs",
      workspacePrecondition: "must_be_absent",
      runTimeoutMs: 5_000,
      cleanupTimeoutMs: 100,
      sealedBundleEnvelope: formatProductionReplayBundleManifest(manifest),
      sourceMachineIdSha256: manifest.attestations.source.machineIdSha256,
      targetMachineIdSha256: manifest.attestations.target.machineIdSha256,
      expectedManifestDigestSha256: manifest.seal.manifestDigestSha256,
      expectedBuildDigestSha256: manifest.attestations.runtime.target.digestSha256,
      expectedBaselineDigestSha256:
        manifest.attestations.state.target.treeDigestSha256,
      expectedTranscriptBlobDigestSha256: manifest.transcript.blobDigestSha256,
      expectedCassetteSetDigestSha256: digestOperationalReplayCassetteSet(
        manifest.determinism,
      ),
      maxEventLagMs: 500,
      portCallTimeoutMs: 100,
      quiescenceTimeoutMs: 100,
    },
    transcript,
    triggerPayload,
    outputs,
    state,
    artifacts,
  };
}

interface WorkerHarness {
  readonly worker: OperationalReplayWorkerPort;
  readonly open: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly triggers: ProductionReplayTrigger[];
}

function processPlanInput(
  request: OperationalReplayControllerRequest,
): Parameters<typeof buildOperationalReplayProcessPlan>[0] {
  return {
    runId: request.runId,
    baselinePath: request.baselinePath,
    workspaceRoot: request.workspaceRoot,
    workspacePrecondition: request.workspacePrecondition,
    expectedBuildDigestSha256: request.expectedBuildDigestSha256,
    runTimeoutMs: request.runTimeoutMs,
    cleanupTimeoutMs: request.cleanupTimeoutMs,
  };
}

interface WorkerOptions {
  readonly hardOraclePassed?: boolean;
  readonly lateEvent?: CanonicalProductionEvent;
}

function makeWorker(
  fixture: OperationalFixture,
  options: WorkerOptions = {},
): WorkerHarness {
  const triggers: ProductionReplayTrigger[] = [];
  const eventQueue: CanonicalProductionEvent[] = [];
  let determinism: ProductionReplayDeterminismPort | null = null;
  const replayPorts: Omit<ProductionReplayEnginePorts, "bundleAuthority"> = {
    artifacts: {
      resolve: ({ digestSha256 }) => {
        const artifact = fixture.artifacts.get(digestSha256);
        if (artifact === undefined) throw new Error("test artifact missing");
        return ok({
          authentication: "verified",
          kind: artifact.kind,
          digestSha256: artifact.digestSha256,
          bytes: artifact.bytes,
          plaintext: Uint8Array.from(artifact.plaintext),
        });
      },
    },
    checkpoint: {
      attest: () =>
        ok({
          authentication: "verified",
          kind: "prospective_pre_window",
          manifestDigestSha256: fixture.manifest.seal.manifestDigestSha256,
          runtimeDigestSha256:
            fixture.manifest.attestations.runtime.target.digestSha256,
          stateDigestSha256:
            fixture.manifest.attestations.state.target.treeDigestSha256,
          completedAtMs: fixture.transcript.events[0]!.wallTimeMs - 1,
        }),
    },
    driver: {
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
        eventQueue.push(
          ...fixture.transcript.events.map((event) => structuredClone(event)),
        );
        if (options.lateEvent !== undefined) {
          eventQueue.push(structuredClone(options.lateEvent));
        }
        return ok(undefined);
      },
      finish: () => ok(undefined),
      stop: () => ok(undefined),
    },
    observer: {
      start: () => ok(undefined),
      nextEvent: () => ok(eventQueue.shift() ?? null),
      finish: () =>
        ok({
          outputs: structuredClone(fixture.outputs),
          state: structuredClone(fixture.state),
        }),
      stop: () => ok(undefined),
    },
    hardOracle: {
      evaluate: () =>
        ok({
          oracleSetDigestSha256: fakeDigest(29),
          checks: [
            {
              oracleIdSha256: sha256("record-only-outbound"),
              passed: options.hardOraclePassed ?? true,
              evidenceDigestSha256: sha256("record-only-outbound-evidence"),
            },
          ],
        }),
    },
  };
  const open = vi.fn(
    ({ processPlan, manifest }: { processPlan: OperationalReplayProcessPlan; manifest: ProductionReplayBundleManifest }) =>
      ok({
        attestation: {
          provenance: "injectable_worker_report" as const,
          workerKind: "injectable_contract" as const,
          machineIdSha256: manifest.attestations.target.machineIdSha256,
          manifestDigestSha256: manifest.seal.manifestDigestSha256,
          buildDigestSha256: manifest.attestations.runtime.target.digestSha256,
          baselineDigestBeforeSha256:
            manifest.attestations.state.target.treeDigestSha256,
          sourceTranscriptBlobDigestSha256: manifest.transcript.blobDigestSha256,
          cassetteSetDigestSha256: digestOperationalReplayCassetteSet(
            manifest.determinism,
          ),
          processPlanDigestSha256: processPlan.digestSha256,
          baselinePath: processPlan.baselinePath,
          writableClonePath: processPlan.writableClonePath,
          writableCloneInitialDigestSha256:
            manifest.attestations.state.target.treeDigestSha256,
          cloneIsolation: "independent_or_reflink_cow" as const,
          workspaceCreatedFresh: true,
          preexistingWorkspaceDetected: false,
          baselineImmutable: true,
          writableClone: true,
          processStarted: false,
          normalServiceTouched: false,
          network: "closed" as const,
          providers: "cassette_only" as const,
          channels: "injected_only" as const,
          scheduler: "transcript_only" as const,
          outbound: "record_only" as const,
        },
        replayPorts,
      }),
  );
  const stop = vi.fn(
    ({ processPlanDigestSha256 }: { processPlanDigestSha256: string }) =>
      ok({
        provenance: "injectable_worker_report" as const,
        processPlanDigestSha256,
        processTerminated: true,
        unitCollected: true,
        writableCloneDetached: true,
        normalServiceTouched: false,
      }),
  );
  const worker: OperationalReplayWorkerPort = {
    open,
    awaitQuiescence: (input) =>
      ok({
        provenance: "injectable_worker_report",
        machineIdSha256: fixture.manifest.attestations.target.machineIdSha256,
        processPlanDigestSha256: input.processPlanDigestSha256,
        baselineDigestAfterSha256:
          fixture.manifest.attestations.state.target.treeDigestSha256,
        actualTranscriptDigestSha256: input.actualTranscriptDigestSha256,
        reproductionOutcomeDigestSha256:
          input.reproductionOutcomeDigestSha256,
        quiescent: true,
        processExited: true,
        normalServiceTouched: false,
        prohibitedBoundaryAttemptCount: 0,
        outboundAttemptCount: 1,
        recordedOutboundCount: 1,
        liveOutboundCount: 0,
      }),
    stop,
  };
  return { worker, open, stop, triggers };
}

function bundleAuthority(manifest: ProductionReplayBundleManifest) {
  return {
    verify: (sealedBundleEnvelope: string) => {
      const parsed = parseProductionReplayBundleManifest(
        sealedBundleEnvelope,
        BUNDLE_SEAL_KEY,
      );
      if (!parsed.ok) throw new Error("test bundle authentication failed");
      return ok({
        authentication: "verified" as const,
        authorityKeyIdSha256: manifest.seal.keyIdSha256,
        manifest,
      });
    },
  };
}

describe("isolated production replay worker controller", () => {
  it("makes injectable-worker exactness structurally false", () => {
    expectTypeOf<OperationalReplayResult["exact"]>().toEqualTypeOf<false>();
  });

  it("builds a one-shot process plan that cannot start the normal Comis service", () => {
    const fixture = makeFixture();
    const result = buildOperationalReplayProcessPlan(
      processPlanInput(fixture.request),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      mode: "isolated_one_shot",
      executionReadiness: "non_executable_until_concrete_adapter",
      requiredNodeExecutable: "/usr/bin/node",
      requiredRuntimeEntryPoint: `/opt/comis-replay/runtimes/${fixture.request.expectedBuildDigestSha256}/node_modules/@comis/replay/dist/one-shot-worker.js`,
      network: "closed",
      providers: "cassette_only",
      channels: "injected_only",
      scheduler: "transcript_only",
      outbound: "record_only",
      normalServicePolicy: "never_touch",
      workspacePrecondition: "must_be_absent",
    });
    expect(result.value.sandboxDirectives).toContain("PrivateNetwork=yes");
    expect(result.value.sandboxDirectives).toContain("IPAddressDeny=any");
    expect(result.value.sandboxDirectives).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(result.value.sandboxDirectives).toContain("User=comis-replay");
    expect(result.value.sandboxDirectives).toContain("Group=comis-replay");
    expect(result.value.sandboxDirectives).toContain("UMask=0077");
    expect(result.value.sandboxDirectives).toContain("MemoryMax=2147483648");
    expect(result.value.sandboxDirectives).toContain("TasksMax=128");
    expect(result.value.sandboxDirectives).toContain("CPUQuota=200%");
    expect(result.value.sandboxDirectives).toContain("LimitNOFILE=1024");
    expect(result.value.sandboxDirectives).toContain("LimitFSIZE=67108864");
    expect(result.value.sandboxDirectives).toContain("StandardOutput=null");
    expect(result.value.sandboxDirectives).toContain("StandardError=null");
    expect(result.value.sandboxDirectives).toContain(
      "InaccessiblePaths=/run/comis /run/dbus/system_bus_socket /run/systemd/private",
    );
    expect(result.value).not.toHaveProperty("argv");
    expect(result.value).not.toHaveProperty("supervisorExecutable");
    expect(JSON.stringify(result.value)).not.toMatch(/comis\.service|systemctl|--wait/u);
    expect(result.value.writableClonePath).not.toBe(result.value.baselinePath);
  });

  it("rejects roots, specifier metacharacters, overlaps, and pre-existing workspace claims", () => {
    const fixture = makeFixture();
    const valid = processPlanInput(fixture.request);
    const invalidInputs = [
      { ...valid, baselinePath: "/" },
      { ...valid, baselinePath: "/var/lib/%n/baseline" },
      {
        ...valid,
        workspaceRoot: `${fixture.request.baselinePath}/runs`,
      },
      {
        ...valid,
        workspacePrecondition: "preexisting",
      },
      {
        ...valid,
        runtimeEntryPoint:
          "/tmp/decoy/node_modules/@comis/replay/dist/one-shot-worker.js",
      },
    ];

    for (const input of invalidInputs) {
      expect(
        buildOperationalReplayProcessPlan(
          input as unknown as Parameters<
            typeof buildOperationalReplayProcessPlan
          >[0],
        ).ok,
      ).toBe(false);
    }
  });

  it("keeps an injectable echo replay inexact when every generic comparison matches", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: harness.worker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      schema: "comis-operational-replay-result",
      schemaVersion: 1,
      status: "not_exact",
      exact: false,
      exactBlockers: ["generic_contract_is_not_operational_attestation"],
      sourceMachineIdSha256: fixture.manifest.attestations.source.machineIdSha256,
      targetMachineIdSha256: fixture.manifest.attestations.target.machineIdSha256,
      buildDigestSha256: fixture.manifest.attestations.runtime.target.digestSha256,
      baselineDigestBeforeSha256:
        fixture.manifest.attestations.state.target.treeDigestSha256,
      baselineDigestAfterSha256:
        fixture.manifest.attestations.state.target.treeDigestSha256,
      sourceTranscriptBlobDigestSha256:
        fixture.manifest.transcript.blobDigestSha256,
      cassetteSetDigestSha256: fixture.request.expectedCassetteSetDigestSha256,
      reproduction: {
        status: "matched",
        fidelity: "deterministic_cassette_exact",
      },
      desiredCorrectness: { status: "passed" },
      cleanup: {
        processTerminated: true,
        unitCollected: true,
        writableCloneDetached: true,
        normalServiceTouched: false,
      },
    });
    expect(
      fixture.transcript.events.some(
        ({ kind }) => kind === "channel.normalized.text_received",
      ),
    ).toBe(true);
    expect(harness.triggers).toHaveLength(1);
    expect(new TextDecoder().decode(harness.triggers[0]!.payload)).toBe(
      "normalized channel text fixture",
    );
    expect(harness.stop).toHaveBeenCalledTimes(1);
    const { seal, ...unsigned } = result.value;
    expect(seal.payloadDigestSha256).toBe(sha256(canonicalJson(unsigned)));
    expect(seal.authenticationTagSha256).toBe(
      createHmac("sha256", RESULT_SEAL_KEY)
        .update(canonicalJson(unsigned))
        .digest("hex"),
    );
    expect(verifyOperationalReplayResultSeal(result.value, RESULT_SEAL_KEY)).toBe(
      true,
    );
    expect(
      verifyOperationalReplayResultSeal(
        { ...result.value, exact: true },
        RESULT_SEAL_KEY,
      ),
    ).toBe(false);
  });

  it("refuses authenticated evidence when any cassette authority is incomplete", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);
    const incompleteManifest = structuredClone(fixture.manifest);
    const channelAuthority = incompleteManifest.determinism.cassetteAuthorities.find(
      ({ kind }) => kind === "channel",
    );
    if (channelAuthority === undefined) throw new Error("test cassette authority missing");
    Object.assign(channelAuthority, {
      status: "missing",
      authoritativeCount: null,
      cassetteCount: 0,
      gapReason: "external_call_not_recorded",
    });
    const request = {
      ...fixture.request,
      sealedBundleEnvelope: formatProductionReplayBundleManifest(incompleteManifest),
      expectedCassetteSetDigestSha256: digestOperationalReplayCassetteSet(
        incompleteManifest.determinism,
      ),
    };

    const result = await runOperationalProductionReplay(
      request,
      {
        bundleAuthority: {
          verify: () =>
            ok({
              authentication: "verified",
              authorityKeyIdSha256: incompleteManifest.seal.keyIdSha256,
              manifest: incompleteManifest,
            }),
        },
        worker: harness.worker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "prerequisite_blocked",
        blockers: ["cassette_evidence_incomplete"],
      },
    });
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("attempts bounded cleanup when worker startup does not return", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);
    const hangingWorker: OperationalReplayWorkerPort = {
      ...harness.worker,
      open: () => new Promise(() => undefined),
    };

    const result = await runOperationalProductionReplay(
      { ...fixture.request, portCallTimeoutMs: 10 },
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: hangingWorker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "worker_timeout", phase: "open" },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.stop).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "timed_out" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("cannot claim exactness when the worker reports a live outbound attempt", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);
    const unsafeWorker: OperationalReplayWorkerPort = {
      ...harness.worker,
      awaitQuiescence: async (input, context) => {
        const completed = await harness.worker.awaitQuiescence(input, context);
        if (!completed.ok) return completed;
        return ok({ ...completed.value, liveOutboundCount: 1 });
      },
    };

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: unsafeWorker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "not_exact",
        exact: false,
        exactBlockers: [
          "generic_contract_is_not_operational_attestation",
          "outbound_not_record_only",
        ],
      },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a writable clone that could share mutable inodes with the baseline", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);
    const unsafeWorker: OperationalReplayWorkerPort = {
      ...harness.worker,
      open: async (input, context) => {
        const opened = await harness.worker.open(input, context);
        if (!opened.ok) return opened;
        return ok({
          ...opened.value,
          attestation: {
            ...opened.value.attestation,
            cloneIsolation: "hardlinked",
          },
        } as unknown as typeof opened.value);
      },
    };

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: unsafeWorker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "worker_attestation_invalid", phase: "open" },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps reproduction fidelity separate from a failing desired-correctness oracle", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture, { hardOraclePassed: false });

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: harness.worker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "not_exact",
        exact: false,
        exactBlockers: ["generic_contract_is_not_operational_attestation"],
        reproduction: { status: "matched" },
        desiredCorrectness: { status: "failed", failedCheckCount: 1 },
      },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a no-op injectable worker without producing an exact result", async () => {
    const fixture = makeFixture();
    const harness = makeWorker(fixture);
    const noOpWorker: OperationalReplayWorkerPort = {
      ...harness.worker,
      open: async (input, context) => {
        const opened = await harness.worker.open(input, context);
        if (!opened.ok) return opened;
        return ok({
          ...opened.value,
          replayPorts: {
            ...opened.value.replayPorts,
            driver: {
              ...opened.value.replayPorts.driver,
              injectTrigger: () => ok(undefined),
            },
          },
        });
      },
    };

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: noOpWorker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "replay_engine_failed", engineErrorKind: "divergence" },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects an event observed after the transcript boundary and still cleans up", async () => {
    const fixture = makeFixture();
    const prior = fixture.transcript.events.at(-1)!;
    const harness = makeWorker(fixture, {
      lateEvent: {
        ...structuredClone(prior),
        seq: prior.seq + 1,
        source: { ...prior.source, seq: prior.source.seq + 1 },
        eventId: "late-event",
        wallTimeMs: prior.wallTimeMs + 1,
        monotonicTimeNs: String(BigInt(prior.monotonicTimeNs) + 1n),
        causalParentEventId: prior.eventId,
      },
    });

    const result = await runOperationalProductionReplay(
      fixture.request,
      {
        bundleAuthority: bundleAuthority(fixture.manifest),
        worker: harness.worker,
      },
      RESULT_SEAL_KEY,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "replay_engine_failed", engineErrorKind: "divergence" },
    });
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });
});
