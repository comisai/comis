import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CASSETTE_KINDS,
  DETERMINISTIC_SEQUENCE_KINDS,
  type ProductionReplayBundleUnsignedManifest,
  type ReplayBundleBlob,
  type ReplayBundleBlobKind,
} from "./production-bundle.js";
import {
  assembleProductionReplayBundle,
  deriveProductionSnapshotStateIdentity,
  type ProductionReplayBundleAssemblyRequest,
} from "./production-bundle-assembler.js";
import {
  formatProductionCaptureEpisode,
  type ProductionCaptureEpisode,
} from "./production-episode.js";
import {
  EVIDENCE_FACTS_BEGIN,
  EVIDENCE_FACTS_END,
  PRODUCTION_EVIDENCE_IDS,
} from "./production-evidence.js";
import type { ProductionSnapshotManifest } from "./production-snapshot.js";
import {
  CANONICAL_TRANSCRIPT_BEGIN,
  CANONICAL_TRANSCRIPT_END,
  TRANSCRIPT_EXACT_SOURCE_KINDS,
} from "./production-transcript.js";
import {
  encryptProductionVaultBlob,
  productionVaultKeyIdSha256,
  type EncryptedProductionVaultBlob,
} from "./production-vault.js";

const VAULT_KEY = Buffer.alloc(32, 31);
const SEAL_KEY = Buffer.alloc(32, 32);
const SOURCE_MACHINE = "a".repeat(64);
const TARGET_MACHINE = "b".repeat(64);
const FILE_DIGEST = "c".repeat(64);

type Mutable<T> = T extends Uint8Array
  ? Uint8Array
  : T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function vaultKeyId(): string {
  const result = productionVaultKeyIdSha256(VAULT_KEY);
  if (!result.ok) throw new Error("test vault key fixture is invalid");
  return result.value;
}

function evidence(observedAtMs: number, memoryBytes = 1): string {
  const report = {
    schema: "comis-production-evidence",
    schemaVersion: 1,
    consistency: "live_non_atomic",
    observedAtMs,
    items: PRODUCTION_EVIDENCE_IDS.map((id) => ({
      id,
      configured: "configured",
      availability: "available",
      readability: "readable",
      contentDigestSha256: "d".repeat(64),
      bytes: id === "memory_database" ? memoryBytes : 1,
    })),
  };
  return `${EVIDENCE_FACTS_BEGIN}\n${JSON.stringify(report)}\n${EVIDENCE_FACTS_END}\n`;
}

function snapshot(): ProductionSnapshotManifest {
  return {
    schemaVersion: 1,
    runId: "capture-20260715-a",
    sourceMachineIdSha256: SOURCE_MACHINE,
    service: "comis",
    captureMode: "offline",
    captureStartedAtMs: 1_752_560_000_000,
    captureCompletedAtMs: 1_752_560_004_000,
    freezeDurationMs: 0,
    entries: [
      { path: "data", type: "directory", mode: "0700", size: 4096 },
      { path: "system", type: "directory", mode: "0700", size: 4096 },
      { path: "system/etc", type: "directory", mode: "0755", size: 4096 },
      { path: "system/etc/comis", type: "directory", mode: "0755", size: 4096 },
      {
        path: "system/etc/comis/env",
        type: "file",
        mode: "0640",
        size: 72,
        sha256: FILE_DIGEST,
      },
    ],
    exclusions: [],
  };
}

function transcript(captureId = "capture-20260715-a"): string {
  return `${CANONICAL_TRANSCRIPT_BEGIN}\n${JSON.stringify({
    schema: "comis-canonical-production-transcript",
    schemaVersion: 1,
    captureId,
    createdAtMs: 1_752_560_000_000,
    events: [],
  })}\n${CANONICAL_TRANSCRIPT_END}\n`;
}

function captureEpisode(
  snapshotManifestDigestSha256: string,
  stateIdentity: {
    readonly treeDigestSha256: string;
    readonly entryCount: number;
    readonly bytes: number;
  },
  episodeId = "capture-20260715-a",
  captureMode: "prospective_window" | "historical_final_state_only" = "prospective_window",
): string {
  const covered = (index: number) => ({
    status: "covered" as const,
    startWatermark: {
      sequence: 10,
      ledgerDigestSha256: digest(`start-${index}`),
    },
    endWatermark: {
      sequence: 10,
      ledgerDigestSha256: digest(`end-${index}`),
    },
    authoritativeCount: 0,
    contiguous: true,
    coverageAttestationDigestSha256: digest(`coverage-${index}`),
    gapReason: null,
  });
  const episode: ProductionCaptureEpisode = {
    schema: "comis-production-capture-episode",
    schemaVersion: 1,
    episodeId,
    captureMode,
    window: {
      startAtMs: 1_752_560_005_000,
      endAtMs: 1_752_560_006_000,
      startBoundaryDigestSha256: digest("window-start"),
      endBoundaryDigestSha256: digest("window-end"),
      boundaryLedgerDigestSha256: digest("window-ledger"),
      captureControllerIdentityDigestSha256: digest("capture-controller"),
    },
    initialCheckpoint:
      captureMode === "prospective_window"
        ? {
            status: "captured",
            phase: "pre_window",
            capturedAtMs: 1_752_560_004_000,
            quiescence: "verified",
            quiescenceAttestationDigestSha256: digest("quiescence"),
            snapshotManifestDigestSha256,
            stateTreeDigestSha256: stateIdentity.treeDigestSha256,
            entryCount: stateIdentity.entryCount,
            bytes: stateIdentity.bytes,
          }
        : {
            status: "missing",
            phase: "pre_window",
            capturedAtMs: null,
            quiescence: "unverified",
            quiescenceAttestationDigestSha256: null,
            snapshotManifestDigestSha256: null,
            stateTreeDigestSha256: null,
            entryCount: null,
            bytes: null,
          },
    sourceAuthorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind, index) => ({
      kind,
      sourceIdDigestSha256: digest(`${kind}-source`),
      ...covered(index),
      transcriptCount: 0,
    })),
    deterministicInputs: DETERMINISTIC_SEQUENCE_KINDS.map((kind, index) => ({
      kind,
      ...covered(100 + index),
      capturedCount: 0,
    })),
    cassetteAuthorities: CASSETTE_KINDS.map((kind, index) => ({
      kind,
      ...covered(200 + index),
      cassetteCount: 0,
    })),
    finalObservation: {
      status: "captured",
      phase: "post_window",
      observedAtMs: 1_752_560_006_500,
      observerMode: "independent",
      observerIdentityDigestSha256: digest("independent-observer"),
      observationAttestationDigestSha256: digest("final-attestation"),
      outputIndexDigestSha256: digest("[]"),
      outputCount: 0,
      finalStateDigestSha256: digest("{}"),
      finalStateRecordCount: 0,
      oracleObservationDigestSha256: digest("production-observation"),
    },
    replayInput: {
      target: "deterministic_cassette",
      classification:
        captureMode === "prospective_window"
          ? "deterministic_cassette_exact"
          : "historical_best_effort",
      exactEligible: captureMode === "prospective_window",
      inputSetDigestSha256: digest("input-set"),
      gaps:
        captureMode === "prospective_window"
          ? []
          : [
              {
                kind: "historical_final_state_only",
                sourceKind: null,
                deterministicInputKind: null,
                cassetteKind: null,
              },
              {
                kind: "initial_checkpoint_missing",
                sourceKind: null,
                deterministicInputKind: null,
                cassetteKind: null,
              },
            ],
    },
    correctness: {
      oracleSetDigestSha256: digest("oracle-set"),
      oracleCount: 1,
      production: {
        observationDigestSha256: digest("production-observation"),
        verdict: "fail",
      },
      desired: {
        observationDigestSha256: digest("desired-observation"),
        verdict: "pass",
      },
    },
  };
  const formatted = formatProductionCaptureEpisode(episode);
  if (!formatted.ok) throw new Error("test episode fixture is invalid");
  return formatted.value;
}

function encrypt(kind: ReplayBundleBlobKind, plaintext: string | Uint8Array): EncryptedProductionVaultBlob {
  const result = encryptProductionVaultBlob(
    kind,
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext,
    VAULT_KEY,
  );
  if (!result.ok) throw new Error("test vault fixture encryption failed");
  return result.value;
}

function facts(artifact: EncryptedProductionVaultBlob, kind: ReplayBundleBlobKind): ReplayBundleBlob {
  const lines = artifact.envelope.trimEnd().split("\n");
  const envelope = JSON.parse(lines[1] as string) as {
    plaintextDigestSha256: string;
    plaintextBytes: number;
  };
  return { digestSha256: envelope.plaintextDigestSha256, bytes: envelope.plaintextBytes, kind };
}

function makeRequest(): ProductionReplayBundleAssemblyRequest {
  const stateEntries = snapshot().entries;
  const stateBytes = stateEntries.reduce((total, entry) => total + entry.size, 0);
  const stateIdentity = {
    treeDigestSha256: digest(
      JSON.stringify(
        [...stateEntries]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((entry) => ({
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256 ?? null,
            linkTarget: entry.linkTarget ?? null,
          })),
      ),
    ),
    entryCount: stateEntries.length,
    bytes: stateBytes,
  } as const;
  const snapshotArtifact = encrypt("snapshot_manifest", JSON.stringify(snapshot()));
  const snapshotFacts = facts(snapshotArtifact, "snapshot_manifest");
  const artifacts = [
    encrypt("runtime_archive", Buffer.from([1, 2, 3])),
    encrypt("state_archive", Buffer.from([4, 5, 6])),
    snapshotArtifact,
    encrypt("source_evidence", evidence(1_752_560_005_000)),
    encrypt("target_evidence", evidence(1_752_560_006_000)),
    encrypt(
      "capture_episode",
      captureEpisode(snapshotFacts.digestSha256, stateIdentity),
    ),
    encrypt("canonical_transcript", transcript()),
    ...DETERMINISTIC_SEQUENCE_KINDS.map((kind) =>
      encrypt(`${kind}_sequence`, JSON.stringify([{ kind }])),
    ),
    encrypt("expected_outputs", "[]"),
    encrypt("expected_state", "{}"),
  ];
  const kinds = [
    "runtime_archive",
    "state_archive",
    "snapshot_manifest",
    "source_evidence",
    "target_evidence",
    "capture_episode",
    "canonical_transcript",
    "clock_sequence",
    "random_sequence",
    "identifier_sequence",
    "expected_outputs",
    "expected_state",
  ] as const satisfies readonly ReplayBundleBlobKind[];
  const blobs = artifacts.map((artifact, index) =>
    facts(artifact, kinds.at(index) as ReplayBundleBlobKind),
  );
  const byKind = new Map(blobs.map((blob) => [blob.kind, blob] as const));
  const blob = (kind: ReplayBundleBlobKind): ReplayBundleBlob => {
    const value = byKind.get(kind);
    if (value === undefined) throw new Error("test bundle fixture is incomplete");
    return value;
  };
  const runtimeIdentity = {
    digestSha256: "d".repeat(64),
    entryCount: 1,
    bytes: 3,
    version: "1.0.53",
  } as const;

  const unsignedManifest: ProductionReplayBundleUnsignedManifest = {
    schema: "comis-production-replay-bundle",
    schemaVersion: 1,
    bundleId: "capture-20260715-a",
    createdAtMs: 1_752_560_007_000,
    attestations: {
      source: {
        role: "production_source",
        machineIdSha256: SOURCE_MACHINE,
        profileDigestSha256: "e".repeat(64),
        evidenceBlobDigestSha256: blob("source_evidence").digestSha256,
      },
      target: {
        role: "replay_target",
        machineIdSha256: TARGET_MACHINE,
        profileDigestSha256: "f".repeat(64),
        evidenceBlobDigestSha256: blob("target_evidence").digestSha256,
      },
      runtime: {
        archiveBlobDigestSha256: blob("runtime_archive").digestSha256,
        source: runtimeIdentity,
        target: { ...runtimeIdentity },
        exact: true,
      },
      state: {
        snapshotManifestBlobDigestSha256: blob("snapshot_manifest").digestSha256,
        archiveBlobDigestSha256: blob("state_archive").digestSha256,
        captureMode: "offline",
        source: stateIdentity,
        target: { ...stateIdentity },
        exact: true,
      },
    },
    vault: {
      format: "aes-256-gcm-detached-v1",
      encryptionKeyIdSha256: vaultKeyId(),
      blobs,
    },
    episode: {
      blobDigestSha256: blob("capture_episode").digestSha256,
      episodeId: "capture-20260715-a",
      captureMode: "prospective_window",
      windowStartAtMs: 1_752_560_005_000,
      windowEndAtMs: 1_752_560_006_000,
      initialCheckpointSnapshotManifestDigestSha256:
        blob("snapshot_manifest").digestSha256,
      inputSetDigestSha256: digest("input-set"),
      target: "deterministic_cassette",
      classification: "deterministic_cassette_exact",
      exactEligible: true,
    },
    transcript: {
      blobDigestSha256: blob("canonical_transcript").digestSha256,
      captureId: "capture-20260715-a",
      eventCount: 0,
      authorities: TRANSCRIPT_EXACT_SOURCE_KINDS.map((kind) => ({
        kind,
        sourceId: `${kind}-source`,
        status: "available" as const,
        authoritativeCount: 0,
        transcriptCount: 0,
        gapReasons: [],
      })),
    },
    determinism: {
      sequences: DETERMINISTIC_SEQUENCE_KINDS.map((kind) => ({
        kind,
        status: "captured",
        recordCount: 0,
        blobDigestSha256: blob(`${kind}_sequence`).digestSha256,
        gapReason: null,
      })),
      cassetteAuthorities: CASSETTE_KINDS.map((kind) => ({
        kind,
        status: "captured",
        authoritativeCount: 0,
        cassetteCount: 0,
        gapReason: null,
      })),
      cassettes: [],
    },
    expected: {
      outputCount: 0,
      outputBlobDigestSha256: blob("expected_outputs").digestSha256,
      finalStateRecordCount: 0,
      finalStateBlobDigestSha256: blob("expected_state").digestSha256,
      finalStateDigestSha256: digest("{}"),
    },
    fidelity: {
      classification: "state_equivalent",
      target: "deterministic_cassette",
      exactEligible: false,
      gaps: [
        { kind: "capture_consistency_gap", componentId: null, sourceKind: null },
      ],
    },
  };
  return { unsignedManifest, encryptedBlobs: artifacts, vaultKey: VAULT_KEY, sealKey: SEAL_KEY };
}

function mutableRequest(): Mutable<ProductionReplayBundleAssemblyRequest> {
  return structuredClone(makeRequest()) as unknown as Mutable<ProductionReplayBundleAssemblyRequest>;
}

describe("production replay bundle assembler", () => {
  it("decrypts and cross-validates every private artifact before sealing the manifest", () => {
    const result = assembleProductionReplayBundle(makeRequest());
    const derivedState = deriveProductionSnapshotStateIdentity(snapshot().entries);

    expect(result.ok).toBe(true);
    expect(derivedState.ok).toBe(true);
    if (!result.ok) return;
    if (!derivedState.ok) return;
    expect(result.value.manifest.seal.algorithm).toBe("hmac-sha256");
    expect(result.value.artifacts).toHaveLength(12);
    expect(result.value.transcript).toEqual({ captureId: "capture-20260715-a", eventCount: 0 });
    expect(result.value.episode).toEqual({
      episodeId: "capture-20260715-a",
      captureMode: "prospective_window",
      windowStartAtMs: 1_752_560_005_000,
      windowEndAtMs: 1_752_560_006_000,
      inputSetDigestSha256: digest("input-set"),
      classification: "deterministic_cassette_exact",
      exactEligible: true,
    });
    expect(result.value.snapshot).toMatchObject({
      runId: "capture-20260715-a",
      captureMode: "offline",
      entryCount: 5,
      treeDigestSha256: derivedState.value.treeDigestSha256,
    });
    expect(result.value.evidence).toEqual({
      consistency: "live_non_atomic",
      sourceObservedAtMs: 1_752_560_005_000,
      targetObservedAtMs: 1_752_560_006_000,
      itemCount: PRODUCTION_EVIDENCE_IDS.length,
      gapCount: 0,
    });
    expect(JSON.stringify(result.value)).not.toContain("SECRETS_MASTER_KEY");
  });

  it("seals historical final-state capture only as ineligible best effort", () => {
    const request = mutableRequest();
    const oldBlob = request.unsignedManifest.vault.blobs.find(
      ({ kind }) => kind === "capture_episode",
    );
    if (oldBlob === undefined) throw new Error("test capture episode fixture is incomplete");
    const artifactIndex = request.encryptedBlobs.findIndex((artifact) =>
      artifact.envelope.includes(oldBlob.digestSha256),
    );
    if (artifactIndex < 0) throw new Error("test capture episode artifact is incomplete");
    const state = deriveProductionSnapshotStateIdentity(snapshot().entries);
    if (!state.ok) throw new Error("test state fixture is invalid");
    const replacement = encrypt(
      "capture_episode",
      captureEpisode(
        request.unsignedManifest.attestations.state.snapshotManifestBlobDigestSha256,
        state.value,
        "capture-20260715-a",
        "historical_final_state_only",
      ),
    );
    const replacementFacts = facts(replacement, "capture_episode");
    request.encryptedBlobs.splice(artifactIndex, 1, replacement);
    oldBlob.digestSha256 = replacementFacts.digestSha256;
    oldBlob.bytes = replacementFacts.bytes;
    request.unsignedManifest.episode = {
      ...request.unsignedManifest.episode,
      blobDigestSha256: replacementFacts.digestSha256,
      captureMode: "historical_final_state_only",
      initialCheckpointSnapshotManifestDigestSha256: null,
      classification: "historical_best_effort",
      exactEligible: false,
    };
    request.unsignedManifest.fidelity = {
      ...request.unsignedManifest.fidelity,
      classification: "historical_best_effort",
      exactEligible: false,
    };

    const result = assembleProductionReplayBundle(request);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.episode).toMatchObject({
      captureMode: "historical_final_state_only",
      classification: "historical_best_effort",
      exactEligible: false,
    });
    expect(result.value.manifest.fidelity).toMatchObject({
      classification: "historical_best_effort",
      exactEligible: false,
    });
  });

  it("rejects missing orphaned and duplicate encrypted blobs", () => {
    const missing = mutableRequest();
    missing.encryptedBlobs.pop();
    expect(assembleProductionReplayBundle(missing)).toMatchObject({
      ok: false,
      error: { kind: "vault_inventory_mismatch" },
    });

    const orphan = mutableRequest();
    orphan.encryptedBlobs.push(encrypt("cassette_request", "orphan-private-body"));
    expect(assembleProductionReplayBundle(orphan)).toMatchObject({
      ok: false,
      error: { kind: "vault_inventory_mismatch" },
    });

    const duplicate = mutableRequest();
    duplicate.encryptedBlobs.push(duplicate.encryptedBlobs[0] as EncryptedProductionVaultBlob);
    expect(assembleProductionReplayBundle(duplicate)).toMatchObject({
      ok: false,
      error: { kind: "vault_inventory_mismatch" },
    });
  });

  it("rejects a wrong key corruption and manifest metadata mismatch without rendering bodies", () => {
    const wrongKey = mutableRequest();
    wrongKey.vaultKey = Buffer.alloc(32, 33);
    const wrongKeyResult = assembleProductionReplayBundle(wrongKey);
    expect(wrongKeyResult).toMatchObject({
      ok: false,
      error: { kind: "vault_authentication_failed" },
    });

    const corrupt = mutableRequest();
    const corruptArtifact = corrupt.encryptedBlobs[0] as EncryptedProductionVaultBlob;
    corruptArtifact.ciphertext[0] ^= 1;
    const corruptResult = assembleProductionReplayBundle(corrupt);
    expect(corruptResult).toMatchObject({
      ok: false,
      error: { kind: "vault_authentication_failed" },
    });

    const wrongKind = mutableRequest();
    wrongKind.unsignedManifest.vault.blobs[0]!.kind = "state_archive";
    const wrongKindResult = assembleProductionReplayBundle(wrongKind);
    expect(wrongKindResult).toMatchObject({
      ok: false,
      error: { kind: "vault_inventory_mismatch" },
    });
    for (const result of [wrongKeyResult, corruptResult, wrongKindResult]) {
      expect(JSON.stringify(result)).not.toContain("orphan-private-body");
    }
  });

  it.each([
    ["canonical_transcript", "not-a-transcript"],
    ["snapshot_manifest", "not-a-snapshot"],
    ["source_evidence", "not-evidence"],
    ["target_evidence", "not-evidence"],
    ["capture_episode", "not-an-episode"],
  ] as const)("rejects an invalid %s authority artifact", (kind, body) => {
    const request = mutableRequest();
    const oldBlob = request.unsignedManifest.vault.blobs.find((blob) => blob.kind === kind);
    if (oldBlob === undefined) throw new Error("test bundle fixture is incomplete");
    const oldDigest = oldBlob.digestSha256;
    const index = request.encryptedBlobs.findIndex((artifact) =>
      artifact.envelope.includes(oldDigest),
    );
    if (index < 0) throw new Error("test bundle artifact is incomplete");
    const replacement = encrypt(kind, body);
    request.encryptedBlobs.splice(index, 1, replacement);
    const replacementFacts = facts(replacement, kind);
    oldBlob.digestSha256 = replacementFacts.digestSha256;
    oldBlob.bytes = replacementFacts.bytes;
    const references = request.unsignedManifest;
    if (kind === "canonical_transcript") references.transcript.blobDigestSha256 = replacementFacts.digestSha256;
    if (kind === "snapshot_manifest") {
      references.attestations.state.snapshotManifestBlobDigestSha256 = replacementFacts.digestSha256;
    }
    if (kind === "source_evidence") {
      references.attestations.source.evidenceBlobDigestSha256 = replacementFacts.digestSha256;
    }
    if (kind === "target_evidence") {
      references.attestations.target.evidenceBlobDigestSha256 = replacementFacts.digestSha256;
    }
    if (kind === "capture_episode") {
      references.episode.blobDigestSha256 = replacementFacts.digestSha256;
    }

    const result = assembleProductionReplayBundle(request);

    expect(result).toMatchObject({ ok: false, error: { kind: "authority_artifact_invalid" } });
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it("reconciles transcript snapshot and vault facts instead of trusting manifest claims", () => {
    const badCapture = mutableRequest();
    badCapture.unsignedManifest.transcript.captureId = "different-capture";
    expect(assembleProductionReplayBundle(badCapture)).toMatchObject({
      ok: false,
      error: { kind: "artifact_reconciliation_failed" },
    });

    const badMachine = mutableRequest();
    badMachine.unsignedManifest.attestations.source.machineIdSha256 = "9".repeat(64);
    expect(assembleProductionReplayBundle(badMachine)).toMatchObject({
      ok: false,
      error: { kind: "artifact_reconciliation_failed" },
    });

    const badStateCount = mutableRequest();
    badStateCount.unsignedManifest.attestations.state.source.entryCount += 1;
    badStateCount.unsignedManifest.attestations.state.target.entryCount += 1;
    expect(assembleProductionReplayBundle(badStateCount)).toMatchObject({
      ok: false,
      error: { kind: "artifact_reconciliation_failed" },
    });
  });

  it("rejects an authenticated episode whose bounded capture facts do not match", () => {
    const request = mutableRequest();
    const oldBlob = request.unsignedManifest.vault.blobs.find(
      ({ kind }) => kind === "capture_episode",
    );
    if (oldBlob === undefined) throw new Error("test capture episode fixture is incomplete");
    const artifactIndex = request.encryptedBlobs.findIndex((artifact) =>
      artifact.envelope.includes(oldBlob.digestSha256),
    );
    if (artifactIndex < 0) throw new Error("test capture episode artifact is incomplete");
    const state = deriveProductionSnapshotStateIdentity(snapshot().entries);
    if (!state.ok) throw new Error("test state fixture is invalid");
    const replacement = encrypt(
      "capture_episode",
      captureEpisode(
        request.unsignedManifest.attestations.state.snapshotManifestBlobDigestSha256,
        state.value,
        "different-episode",
      ),
    );
    const replacementFacts = facts(replacement, "capture_episode");
    request.encryptedBlobs.splice(artifactIndex, 1, replacement);
    oldBlob.digestSha256 = replacementFacts.digestSha256;
    oldBlob.bytes = replacementFacts.bytes;
    request.unsignedManifest.episode.blobDigestSha256 = replacementFacts.digestSha256;

    expect(assembleProductionReplayBundle(request)).toEqual({
      ok: false,
      error: {
        kind: "artifact_reconciliation_failed",
        field: "episode",
        message: "Production authority facts do not reconcile with the bundle manifest",
      },
    });
  });

  it("rejects ciphertext tampering of the bound capture episode", () => {
    const request = mutableRequest();
    const episodeDigest = request.unsignedManifest.episode.blobDigestSha256;
    const artifact = request.encryptedBlobs.find((candidate) =>
      candidate.envelope.includes(episodeDigest),
    );
    if (artifact === undefined) throw new Error("test capture episode artifact is incomplete");
    artifact.ciphertext[0] ^= 1;

    expect(assembleProductionReplayBundle(request)).toMatchObject({
      ok: false,
      error: { kind: "vault_authentication_failed" },
    });
  });

  it("rejects source and target evidence whose independently parsed facts diverge", () => {
    const request = mutableRequest();
    const oldBlob = request.unsignedManifest.vault.blobs.find(
      ({ kind }) => kind === "target_evidence",
    );
    if (oldBlob === undefined) throw new Error("test target evidence fixture is incomplete");
    const oldDigest = oldBlob.digestSha256;
    const artifactIndex = request.encryptedBlobs.findIndex((artifact) =>
      artifact.envelope.includes(oldDigest),
    );
    if (artifactIndex < 0) throw new Error("test target evidence artifact is incomplete");
    const replacement = encrypt("target_evidence", evidence(1_752_560_006_000, 2));
    const replacementFacts = facts(replacement, "target_evidence");
    request.encryptedBlobs.splice(artifactIndex, 1, replacement);
    oldBlob.digestSha256 = replacementFacts.digestSha256;
    oldBlob.bytes = replacementFacts.bytes;
    request.unsignedManifest.attestations.target.evidenceBlobDigestSha256 =
      replacementFacts.digestSha256;

    expect(assembleProductionReplayBundle(request)).toEqual({
      ok: false,
      error: {
        kind: "artifact_reconciliation_failed",
        field: "evidence",
        message: "Production authority facts do not reconcile with the bundle manifest",
      },
    });
  });

  it("requires live non-atomic evidence to remain an explicit fidelity gap", () => {
    const request = mutableRequest();
    request.unsignedManifest.fidelity.gaps = request.unsignedManifest.fidelity.gaps.filter(
      ({ kind }) => kind !== "capture_consistency_gap",
    );

    expect(assembleProductionReplayBundle(request)).toEqual({
      ok: false,
      error: {
        kind: "artifact_reconciliation_failed",
        field: "evidence",
        message: "Production authority facts do not reconcile with the bundle manifest",
      },
    });
  });

  it("rejects an exact fidelity overclaim only after all encrypted blobs authenticate", () => {
    const overclaim = mutableRequest();
    overclaim.unsignedManifest.fidelity = {
      classification: "deterministic_cassette_exact",
      target: "deterministic_cassette",
      exactEligible: true,
      gaps: [],
    };
    expect(assembleProductionReplayBundle(overclaim)).toMatchObject({
      ok: false,
      error: { kind: "artifact_reconciliation_failed", field: "evidence" },
    });

    const corruptOverclaim = mutableRequest();
    corruptOverclaim.unsignedManifest.fidelity = overclaim.unsignedManifest.fidelity;
    const finalArtifact = corruptOverclaim.encryptedBlobs.at(-1) as EncryptedProductionVaultBlob;
    finalArtifact.ciphertext[0] ^= 1;
    expect(assembleProductionReplayBundle(corruptOverclaim)).toMatchObject({
      ok: false,
      error: { kind: "vault_authentication_failed" },
    });
  });

  it("returns a content-free Result for malformed runtime input instead of throwing", () => {
    const encrypted = encrypt("state_archive", "private-state-body");
    const malformed = {
      unsignedManifest: { vault: null, privateBody: "PRIVATE_USER_PROMPT" },
      encryptedBlobs: [encrypted],
      vaultKey: VAULT_KEY,
      sealKey: SEAL_KEY,
    } as unknown as ProductionReplayBundleAssemblyRequest;

    const invoke = () => assembleProductionReplayBundle(malformed);

    expect(invoke).not.toThrow();
    const result = invoke();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_USER_PROMPT");
  });
});
