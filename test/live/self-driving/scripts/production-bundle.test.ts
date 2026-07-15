import { describe, expect, it } from "vitest";

import { TRANSCRIPT_EXACT_SOURCE_KINDS } from "./production-transcript.js";
import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  MAX_PRODUCTION_REPLAY_BUNDLE_BYTES,
  PRODUCTION_REPLAY_BUNDLE_BEGIN,
  PRODUCTION_REPLAY_BUNDLE_END,
  formatProductionReplayBundleManifest,
  parseProductionReplayBundleManifest,
  sealProductionReplayBundleManifest,
  type ProductionReplayBundleManifest,
  type ProductionReplayBundleUnsignedManifest,
  type ReplayBundleBlob,
  type ReplayCassette,
} from "./production-bundle.js";

const SEAL_KEY = Buffer.alloc(32, 7);

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function makeUnsignedBundle(): ProductionReplayBundleUnsignedManifest {
  let nextDigest = 100;
  const blobs: ReplayBundleBlob[] = [];
  const addBlob = (kind: ReplayBundleBlob["kind"]): string => {
    const digestSha256 = digest(nextDigest);
    nextDigest += 1;
    blobs.push({ digestSha256, bytes: 128 + nextDigest, kind });
    return digestSha256;
  };

  const runtimeArchive = addBlob("runtime_archive");
  const stateArchive = addBlob("state_archive");
  const snapshotManifest = addBlob("snapshot_manifest");
  const sourceEvidence = addBlob("source_evidence");
  const targetEvidence = addBlob("target_evidence");
  const captureEpisode = addBlob("capture_episode");
  const transcriptBlob = addBlob("canonical_transcript");
  const sequenceBlobs = new Map(
    DETERMINISTIC_SEQUENCE_KINDS.map((kind) => [kind, addBlob(`${kind}_sequence`)] as const),
  );
  const cassettes: ReplayCassette[] = CASSETTE_KINDS.map((kind) => ({
    cassetteId: `${kind}-1`,
    kind,
    ordinal: 1,
    requestBlobDigestSha256: addBlob("cassette_request"),
    responseBlobDigestSha256: addBlob("cassette_response"),
    outcome: "success",
    latencyMs: 25,
  }));
  const expectedOutputs = addBlob("expected_outputs");
  const expectedState = addBlob("expected_state");

  const runtimeIdentity = {
    digestSha256: digest(1),
    entryCount: 9_000,
    bytes: 3_000_000_000,
    version: "1.0.53",
  } as const;
  const stateIdentity = {
    treeDigestSha256: digest(2),
    entryCount: 2_100,
    bytes: 301_000_000,
  } as const;

  return {
    schema: "comis-production-replay-bundle",
    schemaVersion: 1,
    bundleId: "capture-20260715-a",
    createdAtMs: 1_752_560_000_000,
    attestations: {
      source: {
        role: "production_source",
        machineIdSha256: digest(3),
        profileDigestSha256: digest(4),
        evidenceBlobDigestSha256: sourceEvidence,
      },
      target: {
        role: "replay_target",
        machineIdSha256: digest(5),
        profileDigestSha256: digest(6),
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
      encryptionKeyIdSha256: digest(7),
      blobs,
    },
    episode: {
      blobDigestSha256: captureEpisode,
      episodeId: "capture-20260715-a",
      captureMode: "prospective_window",
      windowStartAtMs: 1_752_559_999_000,
      windowEndAtMs: 1_752_560_000_000,
      initialCheckpointSnapshotManifestDigestSha256: snapshotManifest,
      inputSetDigestSha256: digest(9),
      target: "deterministic_cassette",
      classification: "deterministic_cassette_exact",
      exactEligible: true,
    },
    transcript: {
      blobDigestSha256: transcriptBlob,
      captureId: "capture-20260715-a",
      eventCount: TRANSCRIPT_EXACT_SOURCE_KINDS.length,
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
        recordCount: 2,
        blobDigestSha256: sequenceBlobs.get(kind) as string,
        gapReason: null,
      })),
      cassetteAuthorities: CASSETTE_KINDS.map((kind) => ({
        kind,
        status: "captured",
        authoritativeCount: 1,
        cassetteCount: 1,
        gapReason: null,
      })),
      cassettes,
    },
    expected: {
      outputCount: 12,
      outputBlobDigestSha256: expectedOutputs,
      finalStateRecordCount: 2_100,
      finalStateBlobDigestSha256: expectedState,
      finalStateDigestSha256: digest(8),
    },
    fidelity: {
      classification: "deterministic_cassette_exact",
      target: "deterministic_cassette",
      exactEligible: true,
      gaps: [],
    },
  };
}

function makeMutableBundle(): Mutable<ProductionReplayBundleUnsignedManifest> {
  return structuredClone(makeUnsignedBundle()) as Mutable<ProductionReplayBundleUnsignedManifest>;
}

function sealAndFormat(
  unsigned: ProductionReplayBundleUnsignedManifest,
): ProductionReplayBundleManifest {
  const sealed = sealProductionReplayBundleManifest(unsigned, SEAL_KEY);
  expect(sealed.ok).toBe(true);
  if (!sealed.ok) throw new Error("test fixture did not seal");
  return sealed.value;
}

describe("production replay bundle contract", () => {
  it("seals and parses an exact hash-addressed replay bundle without inline content", () => {
    const sealed = sealAndFormat(makeUnsignedBundle());
    const raw = formatProductionReplayBundleManifest(sealed);
    const parsed = parseProductionReplayBundleManifest(raw, SEAL_KEY);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.fidelity).toEqual({
      classification: "deterministic_cassette_exact",
      target: "deterministic_cassette",
      exactEligible: true,
      gaps: [],
    });
    expect(parsed.value.determinism.cassettes).toHaveLength(CASSETTE_KINDS.length);
    expect(raw).not.toContain("promptBody");
    expect(raw).not.toContain("secretValue");
    expect(raw.split("\n")).toEqual([
      PRODUCTION_REPLAY_BUNDLE_BEGIN,
      expect.any(String),
      PRODUCTION_REPLAY_BUNDLE_END,
      "",
    ]);
  });

  it("rejects unknown content-bearing fields without reflecting their values", () => {
    const unsafe = structuredClone(makeUnsignedBundle()) as unknown as Record<string, unknown>;
    const transcript = unsafe.transcript as Record<string, unknown>;
    transcript.promptBody = "PRIVATE_USER_PROMPT";

    const result = sealProductionReplayBundleManifest(
      unsafe as unknown as ProductionReplayBundleUnsignedManifest,
      SEAL_KEY,
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_USER_PROMPT");
  });

  it("detects manifest mutation and rejects a different seal key", () => {
    const raw = formatProductionReplayBundleManifest(sealAndFormat(makeUnsignedBundle()));
    const mutated = raw.replace('"outputCount":12', '"outputCount":13');

    expect(parseProductionReplayBundleManifest(mutated, SEAL_KEY)).toMatchObject({
      ok: false,
      error: { kind: "invalid_seal" },
    });
    expect(parseProductionReplayBundleManifest(raw, Buffer.alloc(32, 8))).toMatchObject({
      ok: false,
      error: { kind: "invalid_seal" },
    });
  });

  it("rejects runtime or restored-state exactness claims that do not match attestations", () => {
    const runtimeMismatch = makeMutableBundle();
    runtimeMismatch.attestations.runtime.target.digestSha256 = digest(900);
    expect(sealProductionReplayBundleManifest(runtimeMismatch, SEAL_KEY).ok).toBe(false);

    const stateMismatch = makeMutableBundle();
    stateMismatch.attestations.state.target.treeDigestSha256 = digest(901);
    expect(sealProductionReplayBundleManifest(stateMismatch, SEAL_KEY).ok).toBe(false);
  });

  it("rejects an exact fidelity claim when a transcript authority is missing", () => {
    const incomplete = makeMutableBundle();
    incomplete.transcript.authorities = incomplete.transcript.authorities.filter(
      ({ kind }) => kind !== "offline_messages",
    );
    incomplete.transcript.eventCount -= 1;

    const result = sealProductionReplayBundleManifest(incomplete, SEAL_KEY);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid_manifest", field: "fidelity" },
    });
  });

  it("does not let a directly sealed manifest bypass prospective episode eligibility", () => {
    const bounded = makeMutableBundle();
    bounded.episode.classification = "prospective_bounded";
    bounded.episode.exactEligible = false;
    expect(sealProductionReplayBundleManifest(bounded, SEAL_KEY)).toMatchObject({
      ok: false,
      error: { kind: "invalid_manifest", field: "fidelity" },
    });

    const historical = makeMutableBundle();
    historical.episode.captureMode = "historical_final_state_only";
    historical.episode.initialCheckpointSnapshotManifestDigestSha256 = null;
    historical.episode.classification = "historical_best_effort";
    historical.episode.exactEligible = false;

    expect(sealProductionReplayBundleManifest(historical, SEAL_KEY)).toMatchObject({
      ok: false,
      error: { kind: "invalid_manifest", field: "fidelity" },
    });

    const selfAsserted = makeMutableBundle();
    selfAsserted.episode.captureMode = "historical_final_state_only";
    selfAsserted.episode.initialCheckpointSnapshotManifestDigestSha256 = null;
    expect(sealProductionReplayBundleManifest(selfAsserted, SEAL_KEY)).toMatchObject({
      ok: false,
      error: { kind: "invalid_manifest", field: "episode" },
    });
  });

  it("accepts historical best effort only when authority loss is declared as a fidelity gap", () => {
    const historical = makeMutableBundle();
    const offline = historical.transcript.authorities.find(
      ({ kind }) => kind === "offline_messages",
    );
    if (offline === undefined) throw new Error("offline fixture authority is missing");
    offline.status = "missing";
    offline.authoritativeCount = null;
    offline.transcriptCount = 0;
    offline.gapReasons = ["missing_artifact"];
    historical.transcript.eventCount -= 1;
    historical.fidelity = {
      classification: "historical_best_effort",
      target: "deterministic_cassette",
      exactEligible: false,
      gaps: [
        {
          kind: "source_authority_gap",
          componentId: "offline_messages-source",
          sourceKind: "offline_messages",
        },
      ],
    };
    historical.episode.captureMode = "historical_final_state_only";
    historical.episode.initialCheckpointSnapshotManifestDigestSha256 = null;
    historical.episode.classification = "historical_best_effort";
    historical.episode.exactEligible = false;

    const sealed = sealProductionReplayBundleManifest(historical, SEAL_KEY);

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    const parsed = parseProductionReplayBundleManifest(
      formatProductionReplayBundleManifest(sealed.value),
      SEAL_KEY,
    );
    expect(parsed.ok && parsed.value.fidelity.classification).toBe("historical_best_effort");
  });

  it("rejects a generic gap that does not identify the incomplete authority", () => {
    const historical = makeMutableBundle();
    const offline = historical.transcript.authorities.find(
      ({ kind }) => kind === "offline_messages",
    );
    if (offline === undefined) throw new Error("offline fixture authority is missing");
    offline.status = "missing";
    offline.authoritativeCount = null;
    offline.transcriptCount = 0;
    offline.gapReasons = ["missing_artifact"];
    historical.transcript.eventCount -= 1;
    historical.fidelity = {
      classification: "historical_best_effort",
      target: "deterministic_cassette",
      exactEligible: false,
      gaps: [
        {
          kind: "source_authority_gap",
          componentId: "unrelated-source",
          sourceKind: "daemon",
        },
      ],
    };
    historical.episode.captureMode = "historical_final_state_only";
    historical.episode.initialCheckpointSnapshotManifestDigestSha256 = null;
    historical.episode.classification = "historical_best_effort";
    historical.episode.exactEligible = false;

    expect(sealProductionReplayBundleManifest(historical, SEAL_KEY).ok).toBe(false);
  });

  it("requires every deterministic sequence and cassette source to reconcile with its authority", () => {
    const missingSequence = makeMutableBundle();
    missingSequence.determinism.sequences[0] = {
      kind: "clock",
      status: "missing",
      recordCount: 0,
      blobDigestSha256: null,
      gapReason: "non_durable",
    };
    expect(sealProductionReplayBundleManifest(missingSequence, SEAL_KEY).ok).toBe(false);

    const badCassetteCount = makeMutableBundle();
    badCassetteCount.determinism.cassetteAuthorities[0].authoritativeCount = 2;
    expect(sealProductionReplayBundleManifest(badCassetteCount, SEAL_KEY).ok).toBe(false);

    const badOrdinal = makeMutableBundle();
    badOrdinal.determinism.cassettes[0].ordinal = 2;
    expect(sealProductionReplayBundleManifest(badOrdinal, SEAL_KEY).ok).toBe(false);
  });

  it("rejects missing, duplicate, or unreferenced encrypted blobs", () => {
    const missing = makeMutableBundle();
    missing.vault.blobs = missing.vault.blobs.filter(
      ({ digestSha256 }) => digestSha256 !== missing.expected.outputBlobDigestSha256,
    );
    expect(sealProductionReplayBundleManifest(missing, SEAL_KEY).ok).toBe(false);

    const duplicate = makeMutableBundle();
    duplicate.vault.blobs.push({ ...duplicate.vault.blobs[0] });
    expect(sealProductionReplayBundleManifest(duplicate, SEAL_KEY).ok).toBe(false);

    const orphan = makeMutableBundle();
    orphan.vault.blobs.push({
      digestSha256: digest(999),
      bytes: 64,
      kind: "cassette_response",
    });
    expect(sealProductionReplayBundleManifest(orphan, SEAL_KEY).ok).toBe(false);
  });

  it("rejects malformed envelopes, oversized input, and weak seal keys", () => {
    const sealed = sealAndFormat(makeUnsignedBundle());
    expect(
      parseProductionReplayBundleManifest(JSON.stringify(sealed), SEAL_KEY).ok,
    ).toBe(false);
    expect(
      parseProductionReplayBundleManifest(
        "x".repeat(MAX_PRODUCTION_REPLAY_BUNDLE_BYTES + 1),
        SEAL_KEY,
      ).ok,
    ).toBe(false);
    expect(sealProductionReplayBundleManifest(makeUnsignedBundle(), Buffer.alloc(16)).ok).toBe(
      false,
    );
  });

  it("classifies a complete live-provider replay as semantic and never exact", () => {
    const live = makeMutableBundle();
    live.fidelity = {
      classification: "live_provider_semantic",
      target: "live_provider",
      exactEligible: false,
      gaps: [
        {
          kind: "live_provider_nondeterminism",
          componentId: "model_provider",
          sourceKind: "model_provider",
        },
      ],
    };
    live.episode.target = "live_provider";
    live.episode.classification = "live_provider_semantic";
    live.episode.exactEligible = false;

    const sealed = sealProductionReplayBundleManifest(live, SEAL_KEY);

    expect(sealed.ok).toBe(true);
  });
});
