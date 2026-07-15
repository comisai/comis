// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CASSETTE_KINDS } from "./production-bundle.js";
import {
  TRANSCRIPT_EVENT_KINDS,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
} from "./production-transcript.js";
import {
  MAX_PRODUCTION_ACTIVITY_BLOB_BYTES,
  PRODUCTION_ACTIVITY_CASSETTE_KINDS,
  PRODUCTION_ACTIVITY_EVENT_SOURCES,
  PRODUCTION_ACTIVITY_KINDS,
  PRODUCTION_ACTIVITY_LEDGER_BEGIN,
  PRODUCTION_ACTIVITY_LEDGER_END,
  PRODUCTION_ACTIVITY_SOURCE_KINDS,
  commitProductionActivityValue,
  createProductionActivityLedger,
  mintProductionActivityId,
  parseProductionActivityLedger,
  serializeProductionActivityLedger,
  type ProductionActivityArtifact,
  type ProductionActivityCassette,
  type ProductionActivityCommitmentPurpose,
  type ProductionActivityLedger,
  type ProductionActivityLedgerDraft,
  type ProductionActivityLedgerEntryDraft,
  type ProductionActivityLedgerKeys,
  type ProductionActivitySourceAuthority,
} from "./production-activity-ledger.js";
import type {
  TranscriptActorKind,
  TranscriptEventKind,
  TranscriptOrigin,
  TranscriptReplayPolicy,
} from "./production-transcript.js";

const SEAL_KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const COMMITMENT_KEY = Buffer.from("abcdef0123456789abcdef0123456789", "utf8");
const KEYS: ProductionActivityLedgerKeys = {
  sealKey: SEAL_KEY,
  commitmentKey: COMMITMENT_KEY,
};

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let idSeed = 1;
function opaqueId(seed = idSeed++): string {
  const minted = mintProductionActivityId(Buffer.alloc(16, seed));
  expect(minted.ok).toBe(true);
  return minted.ok ? minted.value : (undefined as never);
}

function commitment(
  purpose: ProductionActivityCommitmentPurpose,
  value: string,
): string {
  const committed = commitProductionActivityValue(
    purpose,
    Buffer.from(value, "utf8"),
    COMMITMENT_KEY,
  );
  expect(committed.ok).toBe(true);
  return committed.ok ? committed.value : (undefined as never);
}

function artifact(label: string, withBlob = true): ProductionActivityArtifact {
  return {
    contentCommitmentSha256: commitment("payload", label),
    vaultBlob: withBlob
      ? {
          digestSha256: digest(`vault:${label}`),
          plaintextBytes: 64,
          ciphertextBytes: 64,
        }
      : null,
  };
}

interface FixtureContext {
  readonly draft: ProductionActivityLedgerDraft;
  readonly entries: readonly ProductionActivityLedgerEntryDraft[];
}

function makeFixture(): FixtureContext {
  idSeed = 1;
  const sourceIds = new Map(
    TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => [kind, commitment("source", `source:${kind}`)] as const),
  );
  const epochIds = new Map(
    TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => [kind, opaqueId()] as const),
  );
  const trace = commitment("context", "trace-a");
  const session = commitment("context", "session-a");
  const run = commitment("context", "run-a");
  const eventIds = Array.from({ length: 6 }, () => opaqueId());
  const cassetteIds = [opaqueId(), opaqueId()] as const;

  const specifications = [
    {
      kind: "channel.native.text_received",
      sourceKind: "channel_native",
      actorKind: "user",
      actorOrigin: "channel",
      actorTrust: "user",
      parents: [],
      policy: "inject",
      cassetteId: cassetteIds[0],
      cassetteRole: "request",
      runId: null,
    },
    {
      kind: "ingress.gate.admitted",
      sourceKind: "orchestrator",
      actorKind: "service",
      actorOrigin: "orchestrator",
      actorTrust: "system",
      parents: [eventIds[0]!],
      policy: "assert",
      cassetteId: cassetteIds[0],
      cassetteRole: "terminal",
      runId: null,
    },
    {
      kind: "model.request.started",
      sourceKind: "model_provider",
      actorKind: "service",
      actorOrigin: "model",
      actorTrust: "system",
      parents: [eventIds[1]!],
      policy: "stub",
      cassetteId: cassetteIds[1],
      cassetteRole: "request",
      runId: run,
    },
    {
      kind: "model.response.completed",
      sourceKind: "model_provider",
      actorKind: "provider",
      actorOrigin: "model",
      actorTrust: "external",
      parents: [eventIds[2]!],
      policy: "assert",
      cassetteId: cassetteIds[1],
      cassetteRole: "terminal",
      runId: run,
    },
    {
      kind: "daemon.shutdown.started",
      sourceKind: "daemon",
      actorKind: "service",
      actorOrigin: "daemon",
      actorTrust: "system",
      parents: [eventIds[3]!],
      policy: "observe",
      cassetteId: null,
      cassetteRole: null,
      runId: null,
    },
    {
      kind: "daemon.shutdown.completed",
      sourceKind: "daemon",
      actorKind: "service",
      actorOrigin: "daemon",
      actorTrust: "system",
      parents: [eventIds[4]!],
      policy: "observe",
      cassetteId: null,
      cassetteRole: null,
      runId: null,
    },
  ] as const;

  const sourceCounters = new Map<string, number>();
  const entries: ProductionActivityLedgerEntryDraft[] = specifications.map((spec, index) => {
    const sourceSequence = (sourceCounters.get(spec.sourceKind) ?? 0) + 1;
    sourceCounters.set(spec.sourceKind, sourceSequence);
    return {
      sequence: index + 1,
      entryId: eventIds[index]!,
      eventIdentityCommitmentSha256: commitment("event", `event:${index + 1}`),
      source: {
        kind: spec.sourceKind,
        sourceIdCommitmentSha256: sourceIds.get(spec.sourceKind)!,
        epochId: epochIds.get(spec.sourceKind)!,
        sequence: sourceSequence,
      },
      kind: spec.kind,
      timing: {
        wallTimeMs: 1_000 + index,
        monotonicTimeNs: String(10_000 + index),
        clockId: opaqueId(),
      },
      causality: {
        parentEntryIds: spec.parents,
        traceCommitmentSha256: index >= 4 ? null : trace,
        sessionCommitmentSha256: index >= 4 ? null : session,
        runCommitmentSha256: spec.runId,
        jobCommitmentSha256: null,
      },
      actor: {
        kind: spec.actorKind,
        identityCommitmentSha256: commitment("actor", `actor:${index}`),
        trust: spec.actorTrust,
        origin: spec.actorOrigin,
      },
      payload: artifact(`event-payload:${index + 1}`),
      replay: {
        policy: spec.policy,
        cassetteId: spec.cassetteId,
        cassetteRole: spec.cassetteRole,
      },
    };
  });

  const sourceAuthorities: ProductionActivitySourceAuthority[] =
    TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => {
      const matching = entries.filter((entry) => entry.source.kind === kind);
      return {
        kind,
        sourceIdCommitmentSha256: sourceIds.get(kind)!,
        status: "complete",
        gap: null,
        attestationCommitmentSha256: commitment("attestation", `authority:${kind}`),
        epochs: matching.length === 0
          ? []
          : [{
              ordinal: 1,
              epochId: epochIds.get(kind)!,
              startWatermark: 0,
              endWatermark: matching.length,
              observedCount: matching.length,
              lossCount: 0,
              firstLedgerSequence: matching.at(0)!.sequence,
              lastLedgerSequence: matching.at(-1)!.sequence,
              monotonicStartNs: matching.at(0)!.timing.monotonicTimeNs,
              monotonicEndNs: matching.at(-1)!.timing.monotonicTimeNs,
            }],
      };
    });

  const cassettePairs = [
    ["channel", entries[0]!, entries[1]!],
    ["model", entries[2]!, entries[3]!],
  ] as const;
  const cassettes: ProductionActivityCassette[] = cassettePairs.map(
    ([kind, request, terminal], index) => ({
      cassetteId: cassetteIds[index]!,
      kind,
      ordinal: 1,
      requestEntryId: request.entryId,
      terminalEntryId: terminal.entryId,
      requestPayloadCommitmentSha256: request.payload.contentCommitmentSha256,
      responsePayloadCommitmentSha256: terminal.payload.contentCommitmentSha256,
      requestBlobDigestSha256: request.payload.vaultBlob!.digestSha256,
      responseBlobDigestSha256: terminal.payload.vaultBlob!.digestSha256,
      outcome: "success",
      latencyMs: terminal.timing.wallTimeMs - request.timing.wallTimeMs,
    }),
  );

  return {
    entries,
    draft: {
      captureId: opaqueId(),
      captureWindow: {
        startedWallTimeMs: 900,
        endedWallTimeMs: 1_100,
        initialCheckpointManifestDigestSha256: digest("checkpoint"),
        finalObservationDigestSha256: digest("observation"),
      },
      identity: {
        sourceMachineCommitmentSha256: commitment("identity", "machine"),
        buildCommitmentSha256: commitment("identity", "build"),
        configCommitmentSha256: commitment("identity", "config"),
        runtimeCommitmentSha256: commitment("identity", "runtime"),
        observerCommitmentSha256: commitment("identity", "observer"),
      },
      determinism: {
        clockSequence: artifact("clock-sequence"),
        randomSequence: artifact("random-sequence"),
        identifierSequence: artifact("identifier-sequence"),
      },
      sourceAuthorities,
      entries,
      cassettes,
    },
  };
}

function mutableDraft(): DeepMutable<ProductionActivityLedgerDraft> {
  return structuredClone(makeFixture().draft) as DeepMutable<ProductionActivityLedgerDraft>;
}

function mutableLedger(): DeepMutable<ProductionActivityLedger> {
  const result = createProductionActivityLedger(makeFixture().draft, KEYS);
  expect(result.ok).toBe(true);
  return structuredClone(result.ok ? result.value : (undefined as never)) as DeepMutable<ProductionActivityLedger>;
}

function singleEntryDraft(input: {
  readonly sourceKind: ProductionActivityLedgerEntryDraft["source"]["kind"];
  readonly eventKind: TranscriptEventKind;
  readonly origin: TranscriptOrigin;
  readonly actorKind?: TranscriptActorKind;
  readonly policy?: TranscriptReplayPolicy;
}): DeepMutable<ProductionActivityLedgerDraft> {
  const draft = mutableDraft();
  const authority = draft.sourceAuthorities.find(
    (candidate) => candidate.kind === input.sourceKind,
  )!;
  for (const candidate of draft.sourceAuthorities) candidate.epochs = [];
  const epochId = opaqueId();
  const entryId = opaqueId();
  draft.entries = [{
    sequence: 1,
    entryId,
    eventIdentityCommitmentSha256: commitment("event", `single:${input.eventKind}`),
    source: {
      kind: input.sourceKind,
      sourceIdCommitmentSha256: authority.sourceIdCommitmentSha256,
      epochId,
      sequence: 1,
    },
    kind: input.eventKind,
    timing: {
      wallTimeMs: 1_000,
      monotonicTimeNs: "10000",
      clockId: opaqueId(),
    },
    causality: {
      parentEntryIds: [],
      traceCommitmentSha256: null,
      sessionCommitmentSha256: null,
      runCommitmentSha256: null,
      jobCommitmentSha256: null,
    },
    actor: {
      kind: input.actorKind ?? "service",
      identityCommitmentSha256: commitment("actor", `single:${input.origin}`),
      trust: input.actorKind === "operator" ? "admin" : "system",
      origin: input.origin,
    },
    payload: artifact(`single:${input.eventKind}`),
    replay: {
      policy: input.policy ?? "observe",
      cassetteId: null,
      cassetteRole: null,
    },
  }];
  draft.cassettes = [];
  authority.epochs = [{
    ordinal: 1,
    epochId,
    startWatermark: 0,
    endWatermark: 1,
    observedCount: 1,
    lossCount: 0,
    firstLedgerSequence: 1,
    lastLedgerSequence: 1,
    monotonicStartNs: "10000",
    monotonicEndNs: "10000",
  }];
  return draft;
}

function cassetteLifecycleDraft(input: {
  readonly sourceKind: ProductionActivityLedgerEntryDraft["source"]["kind"];
  readonly requestKind: TranscriptEventKind;
  readonly terminalKind: TranscriptEventKind;
  readonly origin: TranscriptOrigin;
  readonly cassetteKind: ProductionActivityCassette["kind"];
  readonly withContext?: boolean;
}): DeepMutable<ProductionActivityLedgerDraft> {
  const draft = singleEntryDraft({
    sourceKind: input.sourceKind,
    eventKind: input.requestKind,
    origin: input.origin,
    policy: "stub",
  });
  const request = draft.entries[0]!;
  const cassetteId = opaqueId();
  const terminalId = opaqueId();
  const context = input.withContext ? commitment("context", `context:${input.sourceKind}`) : null;
  request.causality.traceCommitmentSha256 = context;
  request.causality.sessionCommitmentSha256 = context;
  request.replay = { policy: "stub", cassetteId, cassetteRole: "request" };
  const terminal = structuredClone(request);
  terminal.sequence = 2;
  terminal.entryId = terminalId;
  terminal.eventIdentityCommitmentSha256 = commitment("event", `terminal:${input.terminalKind}`);
  terminal.source.sequence = 2;
  terminal.kind = input.terminalKind;
  terminal.timing.wallTimeMs = 1_001;
  terminal.timing.monotonicTimeNs = "10001";
  terminal.causality.parentEntryIds = [request.entryId];
  terminal.payload = artifact(`terminal:${input.terminalKind}`);
  terminal.replay = { policy: "assert", cassetteId, cassetteRole: "terminal" };
  draft.entries = [request, terminal];
  const authority = draft.sourceAuthorities.find(
    (candidate) => candidate.kind === input.sourceKind,
  )!;
  const epoch = authority.epochs[0]!;
  epoch.endWatermark = 2;
  epoch.observedCount = 2;
  epoch.lastLedgerSequence = 2;
  epoch.monotonicEndNs = "10001";
  draft.cassettes = [{
    cassetteId,
    kind: input.cassetteKind,
    ordinal: 1,
    requestEntryId: request.entryId,
    terminalEntryId: terminal.entryId,
    requestPayloadCommitmentSha256: request.payload.contentCommitmentSha256,
    responsePayloadCommitmentSha256: terminal.payload.contentCommitmentSha256,
    requestBlobDigestSha256: request.payload.vaultBlob!.digestSha256,
    responseBlobDigestSha256: terminal.payload.vaultBlob!.digestSha256,
    outcome: "success",
    latencyMs: 1,
  }];
  return draft;
}

function envelope(value: unknown, canonical = false): string {
  const payload = canonical ? JSON.stringify(value) : JSON.stringify(value, null, 0);
  return `${PRODUCTION_ACTIVITY_LEDGER_BEGIN}\n${payload}\n${PRODUCTION_ACTIVITY_LEDGER_END}\n`;
}

describe("prospective production activity ledger", () => {
  it("derives exhaustive activity and authority mappings from replay contracts", () => {
    expect(PRODUCTION_ACTIVITY_KINDS).toEqual(TRANSCRIPT_EVENT_KINDS);
    expect(PRODUCTION_ACTIVITY_SOURCE_KINDS).toEqual(TRANSCRIPT_EXACT_SOURCE_KINDS);
    expect(PRODUCTION_ACTIVITY_CASSETTE_KINDS).toEqual(CASSETTE_KINDS);
    expect(Object.keys(PRODUCTION_ACTIVITY_EVENT_SOURCES)).toEqual(TRANSCRIPT_EVENT_KINDS);
    for (const kind of TRANSCRIPT_EVENT_KINDS) {
      expect(PRODUCTION_ACTIVITY_EVENT_SOURCES[kind].length).toBeGreaterThan(0);
      if (kind.startsWith("channel.normalized.")) {
        expect(PRODUCTION_ACTIVITY_EVENT_SOURCES[kind]).toEqual([
          "offline_messages",
          "channel_normalized",
        ]);
      } else {
        expect(PRODUCTION_ACTIVITY_EVENT_SOURCES[kind]).toHaveLength(1);
      }
    }
    expect(PRODUCTION_ACTIVITY_SOURCE_KINDS).toEqual(expect.arrayContaining([
      "heartbeat",
      "subagent",
      "graph",
      "mcp",
      "web",
      "media",
      "orchestrator",
      "delivery",
      "state",
      "config",
      "daemon",
    ]));
    expect(PRODUCTION_ACTIVITY_EVENT_SOURCES["ingress.queue.enqueued"]).toContain("orchestrator");
    expect(PRODUCTION_ACTIVITY_EVENT_SOURCES["outbound.retry.scheduled"]).toContain("delivery");
    expect(PRODUCTION_ACTIVITY_EVENT_SOURCES["daemon.shutdown.completed"]).toContain("daemon");
  });

  it("maps explicit authority families without cross-authority aliases", () => {
    const owners = {
      "config.write.rejected": "config",
      "trajectory.pointer.updated": "trajectory",
      "audit.capability.denied": "audit",
      "diagnostics.event.dropped": "diagnostics",
      "background.task.completed": "background",
      "runtime.artifact.promoted": "runtime_artifact",
      "operator.action.completed": "operator",
      "rpc.request.completed": "rpc",
      "admin.action.authorized": "admin",
      "determinism.clock.consumed": "deterministic_clock",
      "determinism.random.consumed": "deterministic_random",
      "determinism.identifier.consumed": "deterministic_identifier",
      "dependency.request.completed": "dependency",
      "channel.outbound.request.completed": "channel_outbound",
      "filesystem.read.completed": "filesystem",
      "environment.read.completed": "environment",
      "external.io.network.completed": "external_io",
    } as const;

    for (const [eventKind, sourceKind] of Object.entries(owners)) {
      expect(PRODUCTION_ACTIVITY_EVENT_SOURCES[eventKind as TranscriptEventKind]).toEqual([
        sourceKind,
      ]);
    }
  });

  it("accepts owned control, evidence, and deterministic entries with closed actor origins", () => {
    const specifications = [
      ["config", "config.write.rejected", "config"],
      ["trajectory", "trajectory.pointer.updated", "trajectory"],
      ["audit", "audit.capability.denied", "audit"],
      ["diagnostics", "diagnostics.event.dropped", "diagnostics"],
      ["background", "background.timer.scheduled", "background"],
      ["runtime_artifact", "runtime.artifact.discovered", "runtime_artifact"],
      ["operator", "operator.action.requested", "operator", "operator", "inject"],
      ["rpc", "rpc.request.received", "rpc", "operator"],
      ["admin", "admin.action.authorized", "admin", "operator"],
      ["deterministic_clock", "determinism.clock.consumed", "determinism"],
      ["deterministic_random", "determinism.random.consumed", "determinism"],
      ["deterministic_identifier", "determinism.identifier.consumed", "determinism"],
      ["filesystem", "filesystem.write.completed", "filesystem"],
    ] as const;

    for (const [sourceKind, eventKind, origin, actorKind, policy] of specifications) {
      expect(createProductionActivityLedger(singleEntryDraft({
        sourceKind,
        eventKind,
        origin,
        ...(actorKind === undefined ? {} : { actorKind }),
        ...(policy === undefined ? {} : { policy }),
      }), KEYS).ok, `${sourceKind}:${eventKind}`).toBe(true);
    }
  });

  it("rejects representative events attributed to a different exact authority", () => {
    const mismatches = [
      ["config.write.committed", "trajectory"],
      ["trajectory.append.completed", "audit"],
      ["audit.command.blocked", "diagnostics"],
      ["diagnostics.snapshot.created", "background"],
      ["background.task.started", "runtime_artifact"],
      ["runtime.artifact.discovered", "operator"],
      ["operator.action.requested", "rpc"],
      ["rpc.request.received", "admin"],
      ["admin.action.authorized", "operator"],
      ["determinism.clock.consumed", "deterministic_random"],
      ["dependency.request.started", "channel_outbound"],
      ["channel.outbound.request.started", "dependency"],
      ["filesystem.read.started", "environment"],
      ["environment.read.started", "external_io"],
      ["external.io.network.started", "filesystem"],
    ] as const;

    for (const [eventKind, sourceKind] of mismatches) {
      const draft = mutableDraft();
      draft.entries[0]!.kind = eventKind;
      draft.entries[0]!.source.kind = sourceKind;
      expect(createProductionActivityLedger(draft, KEYS)).toMatchObject({
        ok: false,
        error: { kind: "invalid_ledger", field: "entries" },
      });
    }
  });

  it("accepts dependency and channel outbound request-terminal cassettes", () => {
    for (const input of [
      {
        sourceKind: "dependency",
        requestKind: "dependency.request.started",
        terminalKind: "dependency.request.completed",
        origin: "dependency",
        cassetteKind: "external_io",
      },
      {
        sourceKind: "channel_outbound",
        requestKind: "channel.outbound.request.started",
        terminalKind: "channel.outbound.request.completed",
        origin: "channel_outbound",
        cassetteKind: "channel",
        withContext: true,
      },
    ] as const) {
      expect(createProductionActivityLedger(cassetteLifecycleDraft(input), KEYS).ok).toBe(true);
    }
  });

  it("authenticates only a bounded capture assertion after canonical round trip", () => {
    const created = createProductionActivityLedger(makeFixture().draft, KEYS);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.captureAssertion).toEqual({
      classification: "bounded_capture",
      replayReady: false,
      blockers: [{ kind: "authenticated_bundle_reconciliation_required" }],
    });
    expect(created.value).not.toHaveProperty("replayAssessment");
    expect(created.value).not.toHaveProperty("exactEligible");

    const serialized = serializeProductionActivityLedger(created.value);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const parsed = parseProductionActivityLedger(serialized.value, KEYS);
    expect(parsed).toEqual(created);
  });

  it("returns safe errors for malformed keys and domain-separates key identities", () => {
    expect(() => createProductionActivityLedger(makeFixture().draft, null as unknown as ProductionActivityLedgerKeys)).not.toThrow();
    expect(createProductionActivityLedger(makeFixture().draft, null as unknown as ProductionActivityLedgerKeys)).toMatchObject({
      ok: false,
      error: { kind: "invalid_key" },
    });
    const ledger = mutableLedger();
    expect(ledger.seal.keyIdSha256).not.toBe(digest(SEAL_KEY.toString("utf8")));
    expect(ledger.commitmentKeyIdSha256).not.toBe(digest(COMMITMENT_KEY.toString("utf8")));
  });

  it("requires both authentication keys when loading a bounded ledger", () => {
    const ledger = mutableLedger();
    const serialized = serializeProductionActivityLedger(ledger);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseProductionActivityLedger(serialized.value, {
      sealKey: SEAL_KEY,
      commitmentKey: Buffer.alloc(32, 9),
    })).toMatchObject({ ok: false, error: { kind: "invalid_authentication" } });
    expect(parseProductionActivityLedger(serialized.value, {
      sealKey: Buffer.alloc(32, 8),
      commitmentKey: COMMITMENT_KEY,
    })).toMatchObject({ ok: false, error: { kind: "invalid_authentication" } });
  });

  it("uses opaque recorder identifiers and keyed commitments without raw identities", () => {
    const minted = mintProductionActivityId(Buffer.alloc(16, 7));
    expect(minted).toMatchObject({ ok: true, value: expect.stringMatching(/^rec_[A-Za-z0-9_-]{22}$/u) });
    const serialized = serializeProductionActivityLedger(mutableLedger());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value).not.toContain("machine");
    expect(serialized.value).not.toContain("trace-a");
    expect(serialized.value).not.toContain(SEAL_KEY.toString("utf8"));
    expect(serialized.value).not.toContain(COMMITMENT_KEY.toString("utf8"));
  });

  it.each([
    ["duplicate entry identifiers", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[1]!.entryId = draft.entries[0]!.entryId; }, "order"],
    ["cross-namespace identifiers", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.cassettes[0]!.cassetteId = draft.entries[0]!.entryId; }, "order"],
    ["global sequence gaps", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[1]!.sequence = 99; }, "order"],
    ["missing causal parents", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[1]!.causality.parentEntryIds = [opaqueId(250)]; }, "causality"],
    ["monotonic epoch regressions", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[3]!.timing.monotonicTimeNs = "1"; }, "sourceAuthorities"],
  ])("rejects %s before ledger authentication", (_label, mutate, field) => {
    const draft = mutableDraft();
    mutate(draft);
    expect(createProductionActivityLedger(draft, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field },
    });
  });

  it("requires every exact source authority with reconciled epochs and loss counters", () => {
    const omitted = mutableDraft();
    omitted.sourceAuthorities = omitted.sourceAuthorities.slice(1);
    expect(createProductionActivityLedger(omitted, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "sourceAuthorities" },
    });

    const lossy = mutableDraft();
    const authority = lossy.sourceAuthorities.find((candidate) => candidate.kind === "channel_native")!;
    authority.status = "gap";
    authority.gap = "dropped_events";
    authority.epochs[0]!.endWatermark += 1;
    authority.epochs[0]!.lossCount = 1;
    const result = createProductionActivityLedger(lossy, KEYS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureAssertion.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source_loss", sourceKind: "channel_native", lossCount: 1 }),
      ]));
    }
  });

  it("shares per-kind bundle cassette ordinals and enforces event bijection", () => {
    const valid = mutableDraft();
    expect(valid.cassettes.map(({ kind, ordinal }) => ({ kind, ordinal }))).toEqual([
      { kind: "channel", ordinal: 1 },
      { kind: "model", ordinal: 1 },
    ]);
    expect(createProductionActivityLedger(valid, KEYS).ok).toBe(true);

    const invalid = mutableDraft();
    invalid.cassettes[1]!.ordinal = 2;
    expect(createProductionActivityLedger(invalid, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "cassettes" },
    });
  });

  it.each([
    ["request digest", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.cassettes[0]!.requestPayloadCommitmentSha256 = commitment("payload", "wrong"); }],
    ["terminal outcome", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.cassettes[0]!.outcome = "error"; }],
    ["lifecycle latency", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.cassettes[0]!.latencyMs += 1; }],
    ["terminal linkage", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.cassettes[0]!.terminalEntryId = draft.entries[3]!.entryId; }],
  ])("rejects cassette %s mismatches against its lifecycle", (_label, mutate) => {
    const draft = mutableDraft();
    mutate(draft);
    expect(createProductionActivityLedger(draft, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "cassettes" },
    });
  });

  it("marks missing injectable-root cassettes as bounded capture blockers", () => {
    const draft = mutableDraft();
    const request = draft.entries[0]!;
    const terminal = draft.entries[1]!;
    request.replay.cassetteId = null;
    request.replay.cassetteRole = null;
    terminal.replay.cassetteId = null;
    terminal.replay.cassetteRole = null;
    draft.cassettes = draft.cassettes.filter((cassette) => cassette.kind !== "channel");
    const result = createProductionActivityLedger(draft, KEYS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.captureAssertion.blockers).toEqual(expect.arrayContaining([
        { kind: "cassette_missing", requestEntryId: request.entryId, cassetteKind: "channel" },
        { kind: "cassette_terminal_missing", terminalEntryId: terminal.entryId, cassetteKind: "channel" },
      ]));
      expect(result.value.captureAssertion.replayReady).toBe(false);
    }
  });

  it.each([
    ["channel actor", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[0]!.actor.kind = "service"; }, "entries"],
    ["request trace", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[2]!.causality.traceCommitmentSha256 = null; }, "entries"],
    ["model run", (draft: DeepMutable<ProductionActivityLedgerDraft>) => { draft.entries[2]!.causality.runCommitmentSha256 = null; }, "entries"],
  ])("rejects invalid %s invariants", (_label, mutate, field) => {
    const draft = mutableDraft();
    mutate(draft);
    expect(createProductionActivityLedger(draft, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field },
    });
  });

  it("rejects sparse or over-bounded parents and encrypted blob metadata", () => {
    const sparse = mutableDraft();
    sparse.entries[1]!.causality.parentEntryIds = new Array(2) as string[];
    expect(createProductionActivityLedger(sparse, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "entries" },
    });

    const parents = mutableDraft();
    parents.entries[1]!.causality.parentEntryIds = Array.from({ length: 33 }, (_, index) => opaqueId(100 + index));
    expect(createProductionActivityLedger(parents, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "entries" },
    });

    const blob = mutableDraft();
    blob.entries[0]!.payload.vaultBlob!.plaintextBytes = MAX_PRODUCTION_ACTIVITY_BLOB_BYTES + 1;
    expect(createProductionActivityLedger(blob, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "entries" },
    });
  });

  it("rejects unknown fields and noncanonical otherwise valid envelopes", () => {
    const ledger = mutableLedger() as DeepMutable<ProductionActivityLedger> & { plaintext?: string };
    ledger.plaintext = "not admitted";
    expect(parseProductionActivityLedger(envelope(ledger), KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_ledger", field: "ledger" },
    });

    const valid = mutableLedger();
    const pretty = `${PRODUCTION_ACTIVITY_LEDGER_BEGIN}\n${JSON.stringify(valid, null, 2)}\n${PRODUCTION_ACTIVITY_LEDGER_END}\n`;
    expect(parseProductionActivityLedger(pretty, KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_envelope" },
    });
    expect(parseProductionActivityLedger(envelope(valid), KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_envelope" },
    });
  });

  it("rejects altered hash chains and authentication tags", () => {
    const chain = mutableLedger();
    chain.entries[1]!.previousEntryHashSha256 = digest("wrong-chain");
    expect(parseProductionActivityLedger(envelope(chain, true), KEYS)).toMatchObject({
      ok: false,
      error: { kind: "broken_hash_chain", sequence: 2 },
    });

    const seal = mutableLedger();
    seal.seal.authenticationTagSha256 = digest("wrong-tag");
    expect(parseProductionActivityLedger(envelope(seal, true), KEYS)).toMatchObject({
      ok: false,
      error: { kind: "invalid_authentication" },
    });
  });
});
