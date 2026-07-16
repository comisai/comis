// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";

import type { Result } from "@comis/shared";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import * as liveCopyFoundation from "./production-live-copy-authorization.js";
import {
  PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS,
  PRODUCTION_LIVE_COPY_DURABLE_LIFECYCLE,
  PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT,
  PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS,
  PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS,
  PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS,
  PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS,
  PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES,
  PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS,
  PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS,
  assessProductionLiveCopyReadiness,
  parseProductionLiveCopyBlueprint,
  parseProductionLiveCopyLifecycleHistory,
  validateProductionLiveCopyLifecycleHistory,
  type ProductionLiveCopyArtifactKind,
  type ProductionLiveCopyArtifactReferenceKind,
  type ProductionLiveCopyBlueprint,
  type ProductionLiveCopyCleanupAttestation,
  type ProductionLiveCopyDurableStage,
  type ProductionLiveCopyLifecycleArtifact,
  type ProductionLiveCopyLifecycleHistoryError,
  type ProductionLiveCopyReadinessError,
  type ProductionLiveCopyReceiptKind,
  type ProductionLiveCopySensitiveSubject,
  type ProductionLiveCopySensitiveSubjectKind,
} from "./production-live-copy-authorization.js";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function canonicalLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function signature(label: string): string {
  return Buffer.concat([
    createHash("sha256").update(`${label}:left`).digest(),
    createHash("sha256").update(`${label}:right`).digest(),
  ]).toString("base64");
}

const TEST_ARTIFACT_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    `302e020100300506032b657004220420${"11".repeat(32)}`,
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const TEST_ARTIFACT_PUBLIC_KEY = createPublicKey(TEST_ARTIFACT_PRIVATE_KEY);

const AUTHORIZATION_ROLES = [
  "operator",
  "controller",
  "source",
  "target",
  "destruction",
] as const;
type AuthorizationRole = (typeof AUTHORIZATION_ROLES)[number];

function deterministicEd25519PrivateKey(seedByte: string) {
  return createPrivateKey({
    key: Buffer.from(
      `302e020100300506032b657004220420${seedByte.repeat(32)}`,
      "hex",
    ),
    format: "der",
    type: "pkcs8",
  });
}

const TEST_AUTHORIZATION_PRIVATE_KEYS = Object.freeze({
  operator: deterministicEd25519PrivateKey("11"),
  controller: deterministicEd25519PrivateKey("22"),
  source: deterministicEd25519PrivateKey("33"),
  target: deterministicEd25519PrivateKey("44"),
  destruction: deterministicEd25519PrivateKey("55"),
});

const TEST_AUTHORIZATION_PUBLIC_KEY_DER_BASE64 = Object.freeze(
  Object.fromEntries(AUTHORIZATION_ROLES.map((role) => [
    role,
    createPublicKey(TEST_AUTHORIZATION_PRIVATE_KEYS[role]).export({
      format: "der",
      type: "spki",
    }).toString("base64"),
  ])) as Readonly<Record<AuthorizationRole, string>>,
);

const AUTHORIZATION_KEY_MATERIAL_DOMAIN =
  "comis-production-live-copy-ed25519-public-key-v1";
const AUTHORIZATION_ROLE_KEY_ID_DOMAIN =
  "comis-production-live-copy-authorization-key-id-v1";

function authorizationKeyMaterialFingerprint(publicKeyDerBase64: string): string {
  return createHash("sha256")
    .update(AUTHORIZATION_KEY_MATERIAL_DOMAIN)
    .update("\0")
    .update(Buffer.from(publicKeyDerBase64, "base64"))
    .digest("hex");
}

function authorizationRoleKeyId(
  role: AuthorizationRole,
  publicKeyDerBase64: string,
): string {
  return sha256(
    `${AUTHORIZATION_ROLE_KEY_ID_DOMAIN}\0${role}\0${authorizationKeyMaterialFingerprint(publicKeyDerBase64)}`,
  );
}

const AUTHORIZATION_ROLE_KEY_FIELDS = Object.freeze({
  operator: Object.freeze({
    keyId: "operatorSigningKeyIdSha256",
    publicKey: "operatorSigningPublicKeyDerBase64",
  }),
  controller: Object.freeze({
    keyId: "controllerSigningKeyIdSha256",
    publicKey: "controllerSigningPublicKeyDerBase64",
  }),
  source: Object.freeze({
    keyId: "sourceSigningKeyIdSha256",
    publicKey: "sourceSigningPublicKeyDerBase64",
  }),
  target: Object.freeze({
    keyId: "targetSigningKeyIdSha256",
    publicKey: "targetSigningPublicKeyDerBase64",
  }),
  destruction: Object.freeze({
    keyId: "destructionSigningKeyIdSha256",
    publicKey: "destructionSigningPublicKeyDerBase64",
  }),
});

function addAuthorizationRoleKeyMaterials(value: Record<string, unknown>): void {
  for (const role of AUTHORIZATION_ROLES) {
    const publicKeyDerBase64 = TEST_AUTHORIZATION_PUBLIC_KEY_DER_BASE64[role];
    const fields = AUTHORIZATION_ROLE_KEY_FIELDS[role];
    value[fields.publicKey] = publicKeyDerBase64;
    value[fields.keyId] = authorizationRoleKeyId(role, publicKeyDerBase64);
  }
}

function signArtifactPayload(
  payloadDigestSha256: string,
  role: AuthorizationRole = "operator",
): string {
  return signEd25519(
    null,
    Buffer.from(payloadDigestSha256, "hex"),
    TEST_AUTHORIZATION_PRIVATE_KEYS[role],
  ).toString("base64");
}

function nonCanonicalSignatureAlias(payloadDigestSha256: string): string {
  const canonical = signArtifactPayload(payloadDigestSha256);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const finalDataIndex = canonical.length - 3;
  const canonicalValue = alphabet.indexOf(canonical.at(finalDataIndex) ?? "");
  const alias = alphabet.at((canonicalValue & 0x30) | 1);
  if (canonicalValue < 0 || alias === undefined) {
    throw new Error("Real Ed25519 signature fixture must have canonical base64 padding");
  }
  return canonical.slice(0, finalDataIndex) + alias + canonical.slice(finalDataIndex + 1);
}

function endpoint(role: "production" | "test", label: string) {
  return {
    role,
    machineIdentityDigestSha256: sha256(`${label}:machine`),
    endpointAttestationDigestSha256: sha256(`${label}:attestation`),
    serviceCommitmentSha256: sha256(`${label}:service`),
    dataDirCommitmentSha256: sha256(`${label}:data-dir`),
    endpointAttestationGenerationSha256: sha256(`${label}:generation`),
    recipientKeyPossessionAttestationDigestSha256:
      role === "test" ? "" : null,
    recipientKeyPossessionSignedPayloadDigestSha256: role === "test" ? "" : null,
    recipientKeyPossessionSignerKeyIdSha256:
      role === "test" ? sha256(`${label}:recipient-possession-signing-key`) : null,
    recipientKeyPossessionAuthenticationKind:
      role === "test" ? "ed25519_signature" as const : null,
    recipientKeyPossessionSignatureBase64:
      role === "test" ? signature(`${label}:recipient-possession`) : null,
    immutableMachineTrustRootStoreIdentitySha256: sha256(
      `${label}:machine-trust-root-store`,
    ),
    immutableMachineTrustRootHeadDigestSha256: sha256(
      `${label}:machine-trust-root-head`,
    ),
  };
}

function refreshIssuanceAuthentication(value: Record<string, unknown>): void {
  const payload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.issuanceTime}\0${String(value.trustedTimeAuthorityStoreIdentitySha256)}\0${String(value.trustedTimeAuthorityStoreHeadDigestSha256)}\0${String(value.trustedTimeSigningKeyIdSha256)}\0${String(value.runId)}\0${String(value.attemptId)}\0${String(value.issuedAtUnixMs)}`,
  );
  value.issuanceTimeSignedPayloadDigestSha256 = payload;
  value.issuanceTimeReceiptDigestSha256 = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0issuance_time\0${payload}\0${String(value.trustedTimeSigningKeyIdSha256)}\0${String(value.issuanceTimeSignatureBase64)}`,
  );
}

function refreshRecipientPossession(value: Record<string, unknown>): void {
  const target = value.target as Record<string, unknown>;
  const payload = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.recipientPossession}\0${String(value.encryptionRecipientKeyIdSha256)}\0${String(target.machineIdentityDigestSha256)}\0${String(target.endpointAttestationDigestSha256)}\0${String(target.endpointAttestationGenerationSha256)}\0${String(target.recipientKeyPossessionSignerKeyIdSha256)}`,
  );
  target.recipientKeyPossessionSignedPayloadDigestSha256 = payload;
  target.recipientKeyPossessionAttestationDigestSha256 = sha256(
    `${PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope}\0recipient_possession\0${payload}\0${String(target.recipientKeyPossessionSignerKeyIdSha256)}\0${String(target.recipientKeyPossessionSignatureBase64)}`,
  );
}

function blueprint(): ProductionLiveCopyBlueprint {
  const value = {
    schema: "comis-production-live-copy-blueprint" as const,
    schemaVersion: 1 as const,
    runId: "run-live-copy-1",
    attemptId: "0123456789abcdef0123456789abcdef",
    challengeNonceBase64: Buffer.alloc(32, 7).toString("base64"),
    source: endpoint("production", "source"),
    target: endpoint("test", "target"),
    operatorTrustRootStoreIdentitySha256: sha256("operator-trust-root-store"),
    operatorTrustRootHeadDigestSha256: sha256("operator-trust-root-head"),
    controllerTrustRootStoreIdentitySha256: sha256("controller-trust-root-store"),
    controllerTrustRootHeadDigestSha256: sha256("controller-trust-root-head"),
    targetAuthorityStoreIdentitySha256: sha256("target-authority-store"),
    targetAuthorityStoreHeadDigestSha256: sha256("target-authority-head"),
    sourceAuthorityStoreIdentitySha256: sha256("source-authority-store"),
    sourceAuthorityStoreHeadDigestSha256: sha256("source-authority-head"),
    sequenceAuthorityStoreIdentitySha256: sha256("sequence-authority-store"),
    sequenceAuthorityStoreHeadDigestSha256: sha256("sequence-authority-head"),
    trustedTimeAuthorityStoreIdentitySha256: sha256("trusted-time-authority-store"),
    trustedTimeAuthorityStoreHeadDigestSha256: sha256("trusted-time-authority-head"),
    trustedTimeSigningKeyIdSha256: sha256("trusted-time-signing-key"),
    artifactUseRegistryStoreIdentitySha256: sha256("artifact-use-registry-store"),
    artifactUseRegistryStoreHeadDigestSha256: sha256("artifact-use-registry-head"),
    artifactUseRegistrySigningKeyIdSha256: sha256("artifact-use-registry-signing-key"),
    sourceStoppedGenerationSha256: sha256("source-stopped-generation"),
    sourceStopLeaseIdentitySha256: sha256("source-stop-lease"),
    sourceStopLeaseDeadlineUnixMs: 40_000,
    targetQuarantineGenerationSha256: sha256("target-quarantine-generation"),
    targetQuarantineLeaseIdentitySha256: sha256("target-quarantine-lease"),
    targetQuarantineLeaseDeadlineUnixMs: 70_000,
    encryptionRecipientKeyIdSha256: sha256("encryption-recipient"),
    operatorSigningKeyIdSha256: "",
    controllerSigningKeyIdSha256: "",
    sourceSigningKeyIdSha256: "",
    targetSigningKeyIdSha256: "",
    destructionSigningKeyIdSha256: "",
    stagingNamespaceDigestSha256: sha256("staging-namespace"),
    issuedAtUnixMs: 10_000,
    issuanceTimeSignedPayloadDigestSha256: "",
    issuanceTimeAuthenticationKind: "ed25519_signature" as const,
    issuanceTimeSignatureBase64: signature("issuance-time"),
    issuanceTimeReceiptDigestSha256: "",
    captureAuthorizationDeadlineUnixMs: 50_000,
    transferAuthorizationDeadlineUnixMs: 80_000,
    retentionPolicy: {
      destructionDeadlineUnixMs: 120_000,
      destructionRequired: true as const,
      destructionAuthorityStoreIdentitySha256: sha256("destruction-authority-store"),
      destructionAuthorityStoreHeadDigestSha256: sha256("destruction-authority-head"),
    },
    maximumCaptureAuthorizationLeaseMs: 40_000,
    maximumTransferAuthorizationLeaseMs: 70_000,
    maximumSourceStopLeaseMs: 30_000,
    maximumTargetQuarantineLeaseMs: 60_000,
    captureMode: "offline" as const,
    scope: "offline_full_state_and_source_secrets" as const,
    operationalStatus: "schema_only" as const,
    exactExecutionEligible: false as const,
  };
  addAuthorizationRoleKeyMaterials(value as unknown as Record<string, unknown>);
  refreshRecipientPossession(value as unknown as Record<string, unknown>);
  refreshIssuanceAuthentication(value as unknown as Record<string, unknown>);
  return value as ProductionLiveCopyBlueprint;
}

function mutateBlueprint(
  base: ProductionLiveCopyBlueprint,
): Record<string, unknown> {
  return structuredClone(base) as unknown as Record<string, unknown>;
}

function pathValue(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

function setPath(value: Record<string, unknown>, path: string, replacement: unknown): void {
  const parts = path.split(".");
  const final = parts.pop();
  if (final === undefined) return;
  let current: object = value;
  for (const part of parts) {
    const next = Reflect.get(current, part);
    if (typeof next !== "object" || next === null) throw new Error("fixture path is invalid");
    current = next;
  }
  Reflect.set(current, final, replacement);
}

const SUCCESS_STAGES = [
  "target_challenge_issue",
  "operator_grant_record",
  "controller_grant_record",
  "target_challenge_consume",
  "target_capture_authorize_and_begin",
  "source_capture_consume_under_stop_lease",
  "source_manifest_attest",
  "source_bind_exact_manifest_state_tree_ciphertext_and_staging",
  "target_transfer_authorize_and_begin",
  "target_receive_encrypted_staging",
  "target_verify_source_manifest_attestation",
  "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding",
  "target_restore_verified_state_to_quarantine",
  "target_promote_restored_state",
  "target_finalize",
  "target_destroy_and_attest",
] as const satisfies readonly ProductionLiveCopyDurableStage[];

const DIGESTS = Object.freeze({
  captureWorkspace: sha256("source-capture-workspace"),
  sourceManifest: sha256("source-snapshot-manifest"),
  sourceEncryptedStaging: sha256("source-encrypted-staging"),
  targetEncryptedStaging: sha256("target-encrypted-staging"),
  quarantinePlaintext: sha256("quarantine-plaintext"),
  promotedPlaintext: sha256("promoted-plaintext"),
});

function sensitiveSubject(
  kind: ProductionLiveCopySensitiveSubjectKind,
): ProductionLiveCopySensitiveSubject {
  switch (kind) {
    case "source_capture_workspace":
      return {
        kind,
        digestSha256: DIGESTS.captureWorkspace,
        ownerRole: "source",
        createdByStage: "source_capture_consume_under_stop_lease",
      };
    case "source_snapshot_manifest":
      return {
        kind,
        digestSha256: DIGESTS.sourceManifest,
        ownerRole: "source",
        createdByStage: "source_manifest_attest",
      };
    case "source_encrypted_staging":
      return {
        kind,
        digestSha256: DIGESTS.sourceEncryptedStaging,
        ownerRole: "source",
        createdByStage: "source_bind_exact_manifest_state_tree_ciphertext_and_staging",
      };
    case "target_encrypted_staging":
      return {
        kind,
        digestSha256: DIGESTS.targetEncryptedStaging,
        ownerRole: "target",
        createdByStage: "target_receive_encrypted_staging",
      };
    case "quarantine_plaintext":
      return {
        kind,
        digestSha256: DIGESTS.quarantinePlaintext,
        ownerRole: "target",
        createdByStage: "target_restore_verified_state_to_quarantine",
      };
    case "promoted_plaintext":
      return {
        kind,
        digestSha256: DIGESTS.promotedPlaintext,
        ownerRole: "target",
        createdByStage: "target_promote_restored_state",
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function sortedSubjects(
  subjects: readonly ProductionLiveCopySensitiveSubject[],
): ProductionLiveCopySensitiveSubject[] {
  return [...subjects].sort((left, right) => {
    const leftKey = left.kind + ":" + left.digestSha256;
    const rightKey = right.kind + ":" + right.digestSha256;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function inventoryDigest(
  subjects: readonly ProductionLiveCopySensitiveSubject[],
): string {
  return sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.cleanupInventory +
      "\0" + canonicalJson(subjects),
  );
}

function fixtureArtifactSigner(
  stage: ProductionLiveCopyDurableStage,
  value: ProductionLiveCopyBlueprint,
): readonly [
  "operator" | "controller" | "source" | "target" | "destruction",
  string,
] {
  if (stage === "operator_grant_record") {
    return ["operator", value.operatorSigningKeyIdSha256];
  }
  if (stage === "controller_grant_record") {
    return ["controller", value.controllerSigningKeyIdSha256];
  }
  if (
    stage === "source_capture_consume_under_stop_lease" ||
    stage === "source_capture_resume_same_staging" ||
    stage === "source_manifest_attest" ||
    stage === "source_bind_exact_manifest_state_tree_ciphertext_and_staging"
  ) {
    return ["source", value.sourceSigningKeyIdSha256];
  }
  return stage === "target_destroy_and_attest"
    ? ["destruction", value.destructionSigningKeyIdSha256]
    : ["target", value.targetSigningKeyIdSha256];
}

interface FixtureArtifactState {
  operatorGrant: string | null;
  controllerGrant: string | null;
  captureAuthorization: string | null;
  sourceCaptureStaging: string | null;
  sourceAttestation: string | null;
  sourceBinding: string | null;
  transferAuthorization: string | null;
  encryptedStagingReceipt: string | null;
  sourceManifestVerification: string | null;
  targetAttestation: string | null;
  quarantineRestore: string | null;
  promotion: string | null;
  finalization: string | null;
  abort: string | null;
  recoverySequence: number;
  lastRecoveryArtifactDigest: string | null;
  lastKind: ProductionLiveCopyArtifactKind | null;
  lastDigest: string | null;
  subjects: ProductionLiveCopySensitiveSubject[];
}

function emptyFixtureArtifactState(): FixtureArtifactState {
  return {
    operatorGrant: null,
    controllerGrant: null,
    captureAuthorization: null,
    sourceCaptureStaging: null,
    sourceAttestation: null,
    sourceBinding: null,
    transferAuthorization: null,
    encryptedStagingReceipt: null,
    sourceManifestVerification: null,
    targetAttestation: null,
    quarantineRestore: null,
    promotion: null,
    finalization: null,
    abort: null,
    recoverySequence: 0,
    lastRecoveryArtifactDigest: null,
    lastKind: null,
    lastDigest: null,
    subjects: [],
  };
}

function cleanupAttestation(
  subject: ProductionLiveCopySensitiveSubject,
  cleanupInventoryDigestSha256: string,
  value: ProductionLiveCopyBlueprint,
  sequence: number,
): ProductionLiveCopyCleanupAttestation {
  const action = subject.kind === "promoted_plaintext"
    ? "promoted_plaintext_rolled_back"
    : subject.ownerRole === "source"
      ? "source_subject_destroyed"
      : "target_subject_destroyed";
  const signerKeyIdSha256 = subject.ownerRole === "source"
    ? value.sourceSigningKeyIdSha256
    : value.targetSigningKeyIdSha256;
  const signedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.cleanupAttestation +
      "\0" + value.runId +
      "\0" + value.attemptId +
      "\0" + cleanupInventoryDigestSha256 +
      "\0" + subject.kind +
      "\0" + subject.digestSha256 +
      "\0" + action +
      "\0" + subject.ownerRole +
      "\0" + signerKeyIdSha256,
  );
  const signatureBase64 = signature(
    "cleanup:" + value.attemptId + ":" + sequence + ":" + subject.kind,
  );
  const attestationDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
      "\0cleanup_attestation\0" + signedPayloadDigestSha256 +
      "\0" + signerKeyIdSha256 +
      "\0" + signatureBase64,
  );
  return {
    schema: "comis-production-live-copy-cleanup-attestation",
    schemaVersion: 1,
    action,
    subjectKind: subject.kind,
    subjectDigestSha256: subject.digestSha256,
    authorityRole: subject.ownerRole,
    signerKeyIdSha256,
    authenticationKind: "ed25519_signature",
    signedPayloadDigestSha256,
    signatureBase64,
    attestationDigestSha256,
  };
}

interface ArtifactDescriptor {
  readonly kind: ProductionLiveCopyArtifactKind;
  readonly subjectKind: ProductionLiveCopyArtifactReferenceKind;
  readonly subjectDigestSha256: string | null;
  readonly predecessorArtifactKind: ProductionLiveCopyArtifactReferenceKind;
  readonly predecessorArtifactDigestSha256: string | null;
  readonly recoverySequence: number | null;
  readonly recoveryGenerationSha256: string | null;
  readonly previousRecoveryArtifactDigestSha256: string | null;
  readonly createdSensitiveSubjects: readonly ProductionLiveCopySensitiveSubject[];
  readonly cleanupSubjects: readonly ProductionLiveCopySensitiveSubject[];
  readonly cleanupAttestations: readonly ProductionLiveCopyCleanupAttestation[];
}

function authenticatedArtifact(
  stage: ProductionLiveCopyDurableStage,
  _sequence: number,
  descriptor: ArtifactDescriptor,
  value: ProductionLiveCopyBlueprint,
): ProductionLiveCopyLifecycleArtifact {
  const [signerRole, signerKeyIdSha256] = fixtureArtifactSigner(stage, value);
  const cleanupInventoryDigestSha256 =
    stage === "target_abort" || stage === "target_destroy_and_attest"
      ? inventoryDigest(descriptor.cleanupSubjects)
      : null;
  const body = {
    schema: "comis-production-live-copy-stage-artifact",
    schemaVersion: 1,
    runId: value.runId,
    attemptId: value.attemptId,
    stage,
    kind: descriptor.kind,
    subjectKind: descriptor.subjectKind,
    subjectDigestSha256: descriptor.subjectDigestSha256,
    predecessorArtifactKind: descriptor.predecessorArtifactKind,
    predecessorArtifactDigestSha256: descriptor.predecessorArtifactDigestSha256,
    recoverySequence: descriptor.recoverySequence,
    recoveryGenerationSha256: descriptor.recoveryGenerationSha256,
    previousRecoveryArtifactDigestSha256:
      descriptor.previousRecoveryArtifactDigestSha256,
    createdSensitiveSubjects: descriptor.createdSensitiveSubjects,
    cleanupSubjects: descriptor.cleanupSubjects,
    cleanupInventoryDigestSha256,
    cleanupAttestations: descriptor.cleanupAttestations,
    authenticationKind: "ed25519_signature",
    signerRole,
    signerKeyIdSha256,
  } as const;
  const signedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactPayload +
      "\0" + canonicalJson(body),
  );
  const signatureBase64 = signArtifactPayload(signedPayloadDigestSha256, signerRole);
  return {
    ...body,
    digestSha256: sha256(
      PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifact +
        "\0" + signedPayloadDigestSha256 +
        "\0" + signatureBase64,
    ),
    signedPayloadDigestSha256,
    signatureBase64,
  };
}

function reauthenticateArtifact(
  stage: ProductionLiveCopyDurableStage,
  sequence: number,
  value: ProductionLiveCopyBlueprint,
  artifact: ProductionLiveCopyLifecycleArtifact,
  overrides: Partial<ArtifactDescriptor>,
): ProductionLiveCopyLifecycleArtifact {
  return authenticatedArtifact(
    stage,
    sequence,
    {
      kind: artifact.kind,
      subjectKind: artifact.subjectKind,
      subjectDigestSha256: artifact.subjectDigestSha256,
      predecessorArtifactKind: artifact.predecessorArtifactKind,
      predecessorArtifactDigestSha256: artifact.predecessorArtifactDigestSha256,
      recoverySequence: artifact.recoverySequence,
      recoveryGenerationSha256: artifact.recoveryGenerationSha256,
      previousRecoveryArtifactDigestSha256:
        artifact.previousRecoveryArtifactDigestSha256,
      createdSensitiveSubjects: artifact.createdSensitiveSubjects,
      cleanupSubjects: artifact.cleanupSubjects,
      cleanupAttestations: artifact.cleanupAttestations,
      ...overrides,
    },
    value,
  );
}

function artifactForStage(
  stage: ProductionLiveCopyDurableStage,
  challengeDigestSha256: string,
  sequence: number,
  value: ProductionLiveCopyBlueprint,
  state: FixtureArtifactState,
): ProductionLiveCopyLifecycleArtifact {
  const missing = sha256("fixture-missing-predecessor");
  const currentSubjects = sortedSubjects(state.subjects);
  let createdSensitiveSubjects: ProductionLiveCopySensitiveSubject[] = [];
  let recoverySequence: number | null = null;
  let recoveryGenerationSha256: string | null = null;
  let previousRecoveryArtifactDigestSha256: string | null = null;
  let descriptor: Omit<
    ArtifactDescriptor,
    | "recoverySequence"
    | "recoveryGenerationSha256"
    | "previousRecoveryArtifactDigestSha256"
    | "createdSensitiveSubjects"
    | "cleanupSubjects"
    | "cleanupAttestations"
  >;
  switch (stage) {
    case "target_challenge_issue":
      descriptor = {
        kind: "challenge",
        subjectKind: "challenge_nonce",
        subjectDigestSha256: challengeDigestSha256,
        predecessorArtifactKind: "none",
        predecessorArtifactDigestSha256: null,
      };
      break;
    case "target_challenge_expire":
      descriptor = {
        kind: "challenge_expiry",
        subjectKind: "challenge_nonce",
        subjectDigestSha256: challengeDigestSha256,
        predecessorArtifactKind: state.lastKind ?? "challenge",
        predecessorArtifactDigestSha256: state.lastDigest ?? missing,
      };
      break;
    case "operator_grant_record":
      descriptor = {
        kind: "operator_grant",
        subjectKind: "challenge_nonce",
        subjectDigestSha256: challengeDigestSha256,
        predecessorArtifactKind: "challenge",
        predecessorArtifactDigestSha256: state.lastDigest ?? missing,
      };
      break;
    case "controller_grant_record":
      descriptor = {
        kind: "controller_grant",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind: "operator_grant",
        predecessorArtifactDigestSha256: state.operatorGrant ?? missing,
      };
      break;
    case "target_challenge_consume":
      descriptor = {
        kind: "challenge_consumption",
        subjectKind: "challenge_nonce",
        subjectDigestSha256: challengeDigestSha256,
        predecessorArtifactKind: "controller_grant",
        predecessorArtifactDigestSha256: state.controllerGrant ?? missing,
      };
      break;
    case "target_capture_authorize_and_begin":
      descriptor = {
        kind: "capture_authorization",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind: "challenge_consumption",
        predecessorArtifactDigestSha256: state.lastDigest ?? missing,
      };
      break;
    case "source_capture_consume_under_stop_lease": {
      const subject = sensitiveSubject("source_capture_workspace");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "source_capture_staging",
        subjectKind: subject.kind,
        subjectDigestSha256: subject.digestSha256,
        predecessorArtifactKind: "capture_authorization",
        predecessorArtifactDigestSha256: state.captureAuthorization ?? missing,
      };
      break;
    }
    case "source_capture_resume_same_staging":
      recoverySequence = state.recoverySequence + 1;
      recoveryGenerationSha256 = sha256(
        `source-recovery-generation:${value.attemptId}:${recoverySequence}`,
      );
      previousRecoveryArtifactDigestSha256 = state.lastRecoveryArtifactDigest;
      descriptor = {
        kind: "recovery_contract",
        subjectKind: "source_capture_staging",
        subjectDigestSha256: state.sourceCaptureStaging ?? missing,
        predecessorArtifactKind: "capture_authorization",
        predecessorArtifactDigestSha256: state.captureAuthorization ?? missing,
      };
      break;
    case "source_manifest_attest": {
      const subject = sensitiveSubject("source_snapshot_manifest");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "source_attestation",
        subjectKind: subject.kind,
        subjectDigestSha256: subject.digestSha256,
        predecessorArtifactKind: "source_capture_staging",
        predecessorArtifactDigestSha256: state.sourceCaptureStaging ?? missing,
      };
      break;
    }
    case "source_bind_exact_manifest_state_tree_ciphertext_and_staging": {
      const subject = sensitiveSubject("source_encrypted_staging");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "source_binding",
        subjectKind: subject.kind,
        subjectDigestSha256: subject.digestSha256,
        predecessorArtifactKind: "source_attestation",
        predecessorArtifactDigestSha256: state.sourceAttestation ?? missing,
      };
      break;
    }
    case "target_transfer_authorize_and_begin":
      descriptor = {
        kind: "transfer_authorization",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind: "source_binding",
        predecessorArtifactDigestSha256: state.sourceBinding ?? missing,
      };
      break;
    case "target_receive_encrypted_staging": {
      const subject = sensitiveSubject("target_encrypted_staging");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "encrypted_staging_receipt",
        subjectKind: "source_encrypted_staging",
        subjectDigestSha256: DIGESTS.sourceEncryptedStaging,
        predecessorArtifactKind: "transfer_authorization",
        predecessorArtifactDigestSha256: state.transferAuthorization ?? missing,
      };
      break;
    }
    case "target_verify_source_manifest_attestation":
      descriptor = {
        kind: "source_manifest_verification",
        subjectKind: "source_attestation",
        subjectDigestSha256: state.sourceAttestation ?? missing,
        predecessorArtifactKind: "encrypted_staging_receipt",
        predecessorArtifactDigestSha256: state.encryptedStagingReceipt ?? missing,
      };
      break;
    case "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding":
      descriptor = {
        kind: "target_attestation",
        subjectKind: "source_binding",
        subjectDigestSha256: state.sourceBinding ?? missing,
        predecessorArtifactKind: "source_manifest_verification",
        predecessorArtifactDigestSha256: state.sourceManifestVerification ?? missing,
      };
      break;
    case "target_restore_verified_state_to_quarantine": {
      const subject = sensitiveSubject("quarantine_plaintext");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "quarantine_restore",
        subjectKind: "target_encrypted_staging",
        subjectDigestSha256: DIGESTS.targetEncryptedStaging,
        predecessorArtifactKind: "target_attestation",
        predecessorArtifactDigestSha256: state.targetAttestation ?? missing,
      };
      break;
    }
    case "target_promote_restored_state": {
      const subject = sensitiveSubject("promoted_plaintext");
      createdSensitiveSubjects = [subject];
      descriptor = {
        kind: "promotion",
        subjectKind: "quarantine_plaintext",
        subjectDigestSha256: DIGESTS.quarantinePlaintext,
        predecessorArtifactKind: "quarantine_restore",
        predecessorArtifactDigestSha256: state.quarantineRestore ?? missing,
      };
      break;
    }
    case "target_finalize":
      descriptor = {
        kind: "finalization",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind: "promotion",
        predecessorArtifactDigestSha256: state.promotion ?? missing,
      };
      break;
    case "target_abort":
      descriptor = {
        kind: "abort",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind: state.lastKind ?? "challenge",
        predecessorArtifactDigestSha256: state.lastDigest ?? missing,
      };
      break;
    case "target_destroy_and_attest":
      descriptor = {
        kind: "destruction_attestation",
        subjectKind: "none",
        subjectDigestSha256: null,
        predecessorArtifactKind:
          state.finalization === null ? "abort" : "finalization",
        predecessorArtifactDigestSha256:
          state.finalization ?? state.abort ?? missing,
      };
      break;
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
  const subjectsAfterCreation = sortedSubjects([
    ...currentSubjects,
    ...createdSensitiveSubjects,
  ]);
  const cleanupSubjects =
    stage === "target_abort" || stage === "target_destroy_and_attest"
      ? currentSubjects
      : [];
  const cleanupInventoryDigestSha256 = inventoryDigest(cleanupSubjects);
  const cleanupAttestations = stage === "target_destroy_and_attest"
    ? cleanupSubjects.map((subject) =>
        cleanupAttestation(
          subject,
          cleanupInventoryDigestSha256,
          value,
          sequence,
        ))
    : [];
  const result = authenticatedArtifact(
    stage,
    sequence,
    {
      ...descriptor,
      recoverySequence,
      recoveryGenerationSha256,
      previousRecoveryArtifactDigestSha256,
      createdSensitiveSubjects,
      cleanupSubjects,
      cleanupAttestations,
    },
    value,
  );
  if (stage === "operator_grant_record") state.operatorGrant = result.digestSha256;
  if (stage === "controller_grant_record") state.controllerGrant = result.digestSha256;
  if (stage === "target_capture_authorize_and_begin") {
    state.captureAuthorization = result.digestSha256;
  }
  if (stage === "source_capture_consume_under_stop_lease") {
    state.sourceCaptureStaging = result.digestSha256;
  }
  if (stage === "source_capture_resume_same_staging") {
    if (recoverySequence === null) {
      throw new Error("Recovery fixture must assign its sequence before signing");
    }
    state.recoverySequence = recoverySequence;
    state.lastRecoveryArtifactDigest = result.digestSha256;
  }
  if (stage === "source_manifest_attest") state.sourceAttestation = result.digestSha256;
  if (stage === "source_bind_exact_manifest_state_tree_ciphertext_and_staging") {
    state.sourceBinding = result.digestSha256;
  }
  if (stage === "target_transfer_authorize_and_begin") {
    state.transferAuthorization = result.digestSha256;
  }
  if (stage === "target_receive_encrypted_staging") {
    state.encryptedStagingReceipt = result.digestSha256;
  }
  if (stage === "target_verify_source_manifest_attestation") {
    state.sourceManifestVerification = result.digestSha256;
  }
  if (stage === "target_verify_exact_manifest_state_tree_ciphertext_and_staging_binding") {
    state.targetAttestation = result.digestSha256;
  }
  if (stage === "target_restore_verified_state_to_quarantine") {
    state.quarantineRestore = result.digestSha256;
  }
  if (stage === "target_promote_restored_state") state.promotion = result.digestSha256;
  if (stage === "target_finalize") state.finalization = result.digestSha256;
  if (stage === "target_abort") state.abort = result.digestSha256;
  state.subjects = subjectsAfterCreation;
  state.lastKind = result.kind;
  state.lastDigest = result.digestSha256;
  return result;
}
function receiptKind(stage: ProductionLiveCopyDurableStage): ProductionLiveCopyReceiptKind {
  if (
    stage === "target_challenge_issue" ||
    stage === "target_challenge_expire" ||
    stage === "target_challenge_consume"
  ) return "challenge";
  if (stage === "source_capture_resume_same_staging") return "recovery";
  if (stage === "target_receive_encrypted_staging") return "receive";
  if (stage === "target_restore_verified_state_to_quarantine") return "restore";
  if (stage === "target_promote_restored_state") return "promotion";
  if (stage === "target_abort") return "abort";
  if (stage === "target_finalize") return "finalize";
  if (stage === "target_destroy_and_attest") return "destruction";
  return "authorization";
}

function receiptAuthority(
  stage: ProductionLiveCopyDurableStage,
  value: ProductionLiveCopyBlueprint,
): readonly [string, string] {
  if (stage === "operator_grant_record") {
    return [value.operatorTrustRootStoreIdentitySha256, value.operatorTrustRootHeadDigestSha256];
  }
  if (stage === "controller_grant_record") {
    return [value.controllerTrustRootStoreIdentitySha256, value.controllerTrustRootHeadDigestSha256];
  }
  if (
    stage === "source_capture_consume_under_stop_lease" ||
    stage === "source_capture_resume_same_staging" ||
    stage === "source_manifest_attest" ||
    stage === "source_bind_exact_manifest_state_tree_ciphertext_and_staging"
  ) {
    return [value.sourceAuthorityStoreIdentitySha256, value.sourceAuthorityStoreHeadDigestSha256];
  }
  if (stage === "target_destroy_and_attest") {
    return [
      value.retentionPolicy.destructionAuthorityStoreIdentitySha256,
      value.retentionPolicy.destructionAuthorityStoreHeadDigestSha256,
    ];
  }
  return [value.targetAuthorityStoreIdentitySha256, value.targetAuthorityStoreHeadDigestSha256];
}

function stageReceipt(
  stage: ProductionLiveCopyDurableStage,
  sequence: number,
  value: ProductionLiveCopyBlueprint,
  previousEventDigestSha256: string,
  eventArtifact: ProductionLiveCopyLifecycleArtifact,
  observedAtUnixMs: number,
): Record<string, unknown> {
  const [authorityStoreIdentitySha256, authorityStoreHeadDigestSha256] =
    receiptAuthority(stage, value);
  const [signerRole, signerKeyIdSha256] = fixtureArtifactSigner(stage, value);
  const sequenceHeadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.receiptHead +
      "\0" + value.runId +
      "\0" + value.attemptId +
      "\0" + sequence +
      "\0" + stage +
      "\0" + previousEventDigestSha256 +
      "\0" + eventArtifact.kind +
      "\0" + eventArtifact.digestSha256 +
      "\0" + eventArtifact.subjectKind +
      "\0" + (eventArtifact.subjectDigestSha256 ?? "") +
      "\0" + eventArtifact.predecessorArtifactKind +
      "\0" + (eventArtifact.predecessorArtifactDigestSha256 ?? ""),
  );
  const trustedTimeSignedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.observedTime +
      "\0" + value.trustedTimeAuthorityStoreIdentitySha256 +
      "\0" + value.trustedTimeAuthorityStoreHeadDigestSha256 +
      "\0" + value.trustedTimeSigningKeyIdSha256 +
      "\0" + sequenceHeadDigestSha256 +
      "\0" + observedAtUnixMs,
  );
  const trustedTimeSignatureBase64 = signature(
    "event-time:" + value.attemptId + ":" + sequence,
  );
  const trustedTimeReceiptDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
      "\0observed_time\0" + trustedTimeSignedPayloadDigestSha256 +
      "\0" + value.trustedTimeSigningKeyIdSha256 +
      "\0" + trustedTimeSignatureBase64,
  );
  const body = {
    schema: "comis-production-live-copy-stage-receipt",
    schemaVersion: 1,
    kind: receiptKind(stage),
    runId: value.runId,
    attemptId: value.attemptId,
    stage,
    sequence,
    authorityStoreIdentitySha256,
    authorityStoreHeadDigestSha256,
    sequenceAuthorityStoreIdentitySha256: value.sequenceAuthorityStoreIdentitySha256,
    sequenceAuthorityStoreHeadDigestSha256: value.sequenceAuthorityStoreHeadDigestSha256,
    sequencePredecessorDigestSha256: previousEventDigestSha256,
    sequenceHeadDigestSha256,
    sourceStoppedGenerationSha256: value.sourceStoppedGenerationSha256,
    sourceStopLeaseIdentitySha256: value.sourceStopLeaseIdentitySha256,
    sourceStopLeaseDeadlineUnixMs: value.sourceStopLeaseDeadlineUnixMs,
    targetQuarantineGenerationSha256: value.targetQuarantineGenerationSha256,
    targetQuarantineLeaseIdentitySha256: value.targetQuarantineLeaseIdentitySha256,
    targetQuarantineLeaseDeadlineUnixMs: value.targetQuarantineLeaseDeadlineUnixMs,
    encryptionRecipientKeyIdSha256: value.encryptionRecipientKeyIdSha256,
    targetRecipientKeyPossessionAttestationDigestSha256:
      value.target.recipientKeyPossessionAttestationDigestSha256,
    targetRecipientKeyPossessionSignedPayloadDigestSha256:
      value.target.recipientKeyPossessionSignedPayloadDigestSha256,
    targetRecipientKeyPossessionSignerKeyIdSha256:
      value.target.recipientKeyPossessionSignerKeyIdSha256,
    artifactKind: eventArtifact.kind,
    artifactDigestSha256: eventArtifact.digestSha256,
    subjectKind: eventArtifact.subjectKind,
    subjectDigestSha256: eventArtifact.subjectDigestSha256,
    predecessorArtifactKind: eventArtifact.predecessorArtifactKind,
    predecessorArtifactDigestSha256: eventArtifact.predecessorArtifactDigestSha256,
    observedAtUnixMs,
    trustedTimeAuthorityStoreIdentitySha256: value.trustedTimeAuthorityStoreIdentitySha256,
    trustedTimeAuthorityStoreHeadDigestSha256: value.trustedTimeAuthorityStoreHeadDigestSha256,
    trustedTimeReceiptDigestSha256,
    trustedTimeAuthenticationKind: "ed25519_signature",
    trustedTimeSignerKeyIdSha256: value.trustedTimeSigningKeyIdSha256,
    trustedTimeSignedPayloadDigestSha256,
    trustedTimeSignatureBase64,
    authenticationKind: "ed25519_signature",
    signerRole,
    signerKeyIdSha256,
  };
  const signedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.receipt +
      "\0" + canonicalJson(body),
  );
  const signatureBase64 = signature(
    "receipt:" + value.attemptId + ":" + sequence + ":" + stage,
  );
  return {
    ...body,
    signedPayloadDigestSha256,
    signatureBase64,
    receiptDigestSha256: sha256(
      PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
        "\0stage_receipt\0" + signedPayloadDigestSha256 +
        "\0" + signerKeyIdSha256 +
        "\0" + signatureBase64,
    ),
  };
}

function reauthenticateReceipt(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const {
    signedPayloadDigestSha256: _signedPayloadDigestSha256,
    receiptDigestSha256: _receiptDigestSha256,
    signatureBase64,
    ...body
  } = value;
  const signedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.receipt +
      "\0" + canonicalJson(body),
  );
  return {
    ...body,
    signedPayloadDigestSha256,
    signatureBase64,
    receiptDigestSha256: sha256(
      PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
        "\0stage_receipt\0" + signedPayloadDigestSha256 +
        "\0" + String(body.signerKeyIdSha256) +
        "\0" + String(signatureBase64),
    ),
  };
}

interface HistoryOptions {
  readonly historyStatus?: "in_progress" | "complete";
  readonly trustedAsOfUnixMs?: number;
  readonly observedAtOverride?: (
    stage: ProductionLiveCopyDurableStage,
    sequence: number,
    defaultValue: number,
  ) => number;
  readonly artifactOverride?: (
    stage: ProductionLiveCopyDurableStage,
    sequence: number,
    defaultValue: ProductionLiveCopyLifecycleArtifact,
  ) => ProductionLiveCopyLifecycleArtifact;
  readonly receiptOverride?: (
    stage: ProductionLiveCopyDurableStage,
    sequence: number,
    defaultValue: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly eventOverride?: (
    stage: ProductionLiveCopyDurableStage,
    sequence: number,
  ) => Readonly<Record<string, unknown>>;
  readonly trustedAsOfSignatureOverride?: (
    signedPayloadDigestSha256: string,
  ) => string;
  readonly registrySignatureOverride?: (
    signedPayloadDigestSha256: string,
  ) => string;
  readonly topOverride?: Readonly<Record<string, unknown>>;
}

function globalReplayKey(
  value: ProductionLiveCopyBlueprint,
  challengeDigestSha256: string,
): string {
  return sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.globalReplay +
      "\0" + challengeDigestSha256 +
      "\0" + value.sourceStoppedGenerationSha256 +
      "\0" + value.sourceStopLeaseIdentitySha256 +
      "\0" + value.targetQuarantineGenerationSha256 +
      "\0" + value.targetQuarantineLeaseIdentitySha256 +
      "\0" + value.encryptionRecipientKeyIdSha256 +
      "\0" + value.stagingNamespaceDigestSha256,
  );
}

function fixtureArtifactUseEntries(
  value: ProductionLiveCopyBlueprint,
  challengeDigestSha256: string,
  events: readonly {
    readonly artifact: ProductionLiveCopyLifecycleArtifact;
    readonly receipt: Readonly<Record<string, unknown>>;
    readonly eventDigestSha256: string;
  }[],
  auditTimeReceiptDigestSha256: string,
): Array<{ readonly identityClass: string; readonly digestSha256: string }> {
  const entries: Array<{ identityClass: string; digestSha256: string }> = [
    { identityClass: "attestation", digestSha256: value.source.endpointAttestationDigestSha256 },
    { identityClass: "attestation", digestSha256: value.target.endpointAttestationDigestSha256 },
    {
      identityClass: "attestation",
      digestSha256: value.target.recipientKeyPossessionAttestationDigestSha256,
    },
    { identityClass: "receipt", digestSha256: value.issuanceTimeReceiptDigestSha256 },
    { identityClass: "receipt", digestSha256: auditTimeReceiptDigestSha256 },
    { identityClass: "artifact", digestSha256: challengeDigestSha256 },
    { identityClass: "artifact", digestSha256: value.stagingNamespaceDigestSha256 },
    { identityClass: "artifact", digestSha256: value.source.dataDirCommitmentSha256 },
    { identityClass: "artifact", digestSha256: value.target.dataDirCommitmentSha256 },
    { identityClass: "authority_generation", digestSha256: value.sourceStoppedGenerationSha256 },
    { identityClass: "authority_generation", digestSha256: value.sourceStopLeaseIdentitySha256 },
    { identityClass: "authority_generation", digestSha256: value.targetQuarantineGenerationSha256 },
    { identityClass: "authority_generation", digestSha256: value.targetQuarantineLeaseIdentitySha256 },
    { identityClass: "authority_generation", digestSha256: value.encryptionRecipientKeyIdSha256 },
  ];
  for (const event of events) {
    entries.push(
      { identityClass: "artifact", digestSha256: event.artifact.digestSha256 },
      { identityClass: "receipt", digestSha256: String(event.receipt.receiptDigestSha256) },
      {
        identityClass: "receipt",
        digestSha256: String(event.receipt.trustedTimeReceiptDigestSha256),
      },
      { identityClass: "event", digestSha256: event.eventDigestSha256 },
    );
    if (event.artifact.recoveryGenerationSha256 !== null) {
      entries.push({
        identityClass: "authority_generation",
        digestSha256: event.artifact.recoveryGenerationSha256,
      });
    }
    if (
      event.artifact.kind === "operator_grant" ||
      event.artifact.kind === "controller_grant" ||
      event.artifact.kind === "source_attestation" ||
      event.artifact.kind === "source_manifest_verification" ||
      event.artifact.kind === "target_attestation"
    ) {
      entries.push({
        identityClass: "attestation",
        digestSha256: event.artifact.digestSha256,
      });
    }
    if (event.artifact.kind === "finalization") {
      entries.push({
        identityClass: "finalization",
        digestSha256: event.artifact.digestSha256,
      });
    }
    if (event.artifact.kind === "destruction_attestation") {
      entries.push({
        identityClass: "destruction",
        digestSha256: event.artifact.digestSha256,
      });
    }
    for (const subject of event.artifact.createdSensitiveSubjects) {
      entries.push({
        identityClass: "sensitive_subject",
        digestSha256: subject.digestSha256,
      });
      if (
        subject.kind === "source_encrypted_staging" ||
        subject.kind === "target_encrypted_staging"
      ) {
        entries.push({ identityClass: "ciphertext", digestSha256: subject.digestSha256 });
      }
    }
    for (const attestation of event.artifact.cleanupAttestations) {
      entries.push(
        { identityClass: "attestation", digestSha256: attestation.attestationDigestSha256 },
        { identityClass: "destruction", digestSha256: attestation.attestationDigestSha256 },
      );
    }
  }
  return entries.sort((left, right) => {
    const leftKey = left.identityClass + ":" + left.digestSha256;
    const rightKey = right.identityClass + ":" + right.digestSha256;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function historyArtifact(
  stages: readonly ProductionLiveCopyDurableStage[],
  options: HistoryOptions = {},
  blueprintValue: ProductionLiveCopyBlueprint = blueprint(),
): { readonly blueprintArtifact: string; readonly historyArtifact: string } {
  const blueprintArtifact = canonicalLine(blueprintValue);
  const blueprintDigestSha256 = sha256(blueprintArtifact);
  const challengeDigestSha256 = sha256(
    Buffer.from(blueprintValue.challengeNonceBase64, "base64"),
  );
  const sequencePredecessorDigestSha256 =
    blueprintValue.sequenceAuthorityStoreHeadDigestSha256;
  let previousEventDigestSha256 = sequencePredecessorDigestSha256;
  let previousObservedAtUnixMs = blueprintValue.issuedAtUnixMs;
  const fixtureState = emptyFixtureArtifactState();
  const events = stages.map((stage, index) => {
    const sequence = index + 1;
    const defaultObservedAt =
      stage === "target_challenge_expire"
        ? blueprintValue.captureAuthorizationDeadlineUnixMs
        : Math.max(blueprintValue.issuedAtUnixMs + sequence, previousObservedAtUnixMs);
    const observedAtUnixMs = options.observedAtOverride?.(
      stage,
      sequence,
      defaultObservedAt,
    ) ?? defaultObservedAt;
    let eventArtifact = artifactForStage(
      stage,
      challengeDigestSha256,
      sequence,
      blueprintValue,
      fixtureState,
    );
    eventArtifact = options.artifactOverride?.(stage, sequence, eventArtifact) ?? eventArtifact;
    let receipt = stageReceipt(
      stage,
      sequence,
      blueprintValue,
      previousEventDigestSha256,
      eventArtifact,
      observedAtUnixMs,
    );
    receipt = options.receiptOverride?.(stage, sequence, receipt) ?? receipt;
    const eventBody = {
      sequence,
      stage,
      blueprintDigestSha256,
      runId: blueprintValue.runId,
      attemptId: blueprintValue.attemptId,
      challengeDigestSha256,
      stagingNamespaceDigestSha256: blueprintValue.stagingNamespaceDigestSha256,
      artifact: eventArtifact,
      receipt,
      previousEventDigestSha256,
      ...options.eventOverride?.(stage, sequence),
    };
    const eventDigestSha256 = sha256(
      PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.event +
        "\0" + canonicalJson(eventBody),
    );
    previousEventDigestSha256 = eventDigestSha256;
    previousObservedAtUnixMs = observedAtUnixMs;
    return { ...eventBody, eventDigestSha256 };
  });
  const sequenceHeadDigestSha256 = previousEventDigestSha256;
  const replayKey = globalReplayKey(blueprintValue, challengeDigestSha256);
  const sequenceNoForkProofDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.noFork +
      "\0" + blueprintDigestSha256 +
      "\0" + replayKey +
      "\0" + sequencePredecessorDigestSha256 +
      "\0" + sequenceHeadDigestSha256 +
      "\0" + events.length,
  );
  const trustedAsOfUnixMs = options.trustedAsOfUnixMs ?? previousObservedAtUnixMs;
  const trustedAsOfSignedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.auditTime +
      "\0" + blueprintValue.trustedTimeAuthorityStoreIdentitySha256 +
      "\0" + blueprintValue.trustedTimeAuthorityStoreHeadDigestSha256 +
      "\0" + blueprintValue.trustedTimeSigningKeyIdSha256 +
      "\0" + sequenceHeadDigestSha256 +
      "\0" + trustedAsOfUnixMs,
  );
  const trustedAsOfSignatureBase64 = options.trustedAsOfSignatureOverride?.(
    trustedAsOfSignedPayloadDigestSha256,
  ) ?? signature(
    "audit-time:" + blueprintValue.attemptId + ":" + sequenceHeadDigestSha256,
  );
  const trustedAsOfTimeReceiptDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
      "\0audit_time\0" + trustedAsOfSignedPayloadDigestSha256 +
      "\0" + blueprintValue.trustedTimeSigningKeyIdSha256 +
      "\0" + trustedAsOfSignatureBase64,
  );
  const terminalStage = stages.at(-1);
  const cleanupOutstanding =
    fixtureState.subjects.length > 0 &&
    terminalStage !== "target_destroy_and_attest";
  const destructionObservedAt = terminalStage === "target_destroy_and_attest"
    ? previousObservedAtUnixMs
    : null;
  const retentionAuditStatus =
    destructionObservedAt !== null &&
      destructionObservedAt >= blueprintValue.retentionPolicy.destructionDeadlineUnixMs
      ? "late_cleanup_recorded"
      : cleanupOutstanding &&
          trustedAsOfUnixMs >= blueprintValue.retentionPolicy.destructionDeadlineUnixMs
        ? "overdue_cleanup_required"
        : "within_policy";
  const registryEntries = fixtureArtifactUseEntries(
    blueprintValue,
    challengeDigestSha256,
    events,
    trustedAsOfTimeReceiptDigestSha256,
  );
  const entrySetDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseSet +
      "\0" + canonicalJson(registryEntries),
  );
  const registryBody = {
    schema: "comis-production-live-copy-artifact-use-registry-claim",
    schemaVersion: 1,
    storeIdentitySha256: blueprintValue.artifactUseRegistryStoreIdentitySha256,
    predecessorHeadDigestSha256:
      blueprintValue.artifactUseRegistryStoreHeadDigestSha256,
    entries: registryEntries,
    entrySetDigestSha256,
    authenticationKind: "ed25519_signature",
    signerKeyIdSha256: blueprintValue.artifactUseRegistrySigningKeyIdSha256,
  } as const;
  const registrySignedPayloadDigestSha256 = sha256(
    PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseRegistryHead +
      "\0payload\0" + sequenceHeadDigestSha256 +
      "\0" + canonicalJson(registryBody),
  );
  const registrySignatureBase64 = options.registrySignatureOverride?.(
    registrySignedPayloadDigestSha256,
  ) ?? signature(
    "registry:" + blueprintValue.attemptId + ":" + sequenceHeadDigestSha256,
  );
  const externalArtifactUseRegistry = {
    ...registryBody,
    claimedHeadDigestSha256: sha256(
      PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifactUseRegistryHead +
        "\0head\0" + blueprintValue.artifactUseRegistryStoreHeadDigestSha256 +
        "\0" + entrySetDigestSha256 +
        "\0" + sequenceHeadDigestSha256 +
        "\0" + registrySignedPayloadDigestSha256 +
        "\0" + registrySignatureBase64,
    ),
    signedPayloadDigestSha256: registrySignedPayloadDigestSha256,
    signatureBase64: registrySignatureBase64,
  };
  const structurallyClosed =
    terminalStage === "target_challenge_expire" ||
    terminalStage === "target_destroy_and_attest" ||
    (terminalStage === "target_abort" && fixtureState.subjects.length === 0);
  const historyValue = {
    schema: "comis-production-live-copy-lifecycle-history",
    schemaVersion: 1,
    blueprintDigestSha256,
    runId: blueprintValue.runId,
    attemptId: blueprintValue.attemptId,
    challengeDigestSha256,
    sourceEndpointAttestationDigestSha256:
      blueprintValue.source.endpointAttestationDigestSha256,
    targetEndpointAttestationDigestSha256:
      blueprintValue.target.endpointAttestationDigestSha256,
    stagingNamespaceDigestSha256: blueprintValue.stagingNamespaceDigestSha256,
    globalReplayKeySha256: replayKey,
    sequencePredecessorDigestSha256,
    sequenceHeadDigestSha256,
    sequenceNoForkProofDigestSha256,
    trustedAsOfUnixMs,
    trustedAsOfSignedPayloadDigestSha256,
    trustedAsOfAuthenticationKind: "ed25519_signature",
    trustedAsOfSignerKeyIdSha256: blueprintValue.trustedTimeSigningKeyIdSha256,
    trustedAsOfSignatureBase64,
    trustedAsOfTimeReceiptDigestSha256,
    retentionAuditStatus,
    retentionPolicyBreached: retentionAuditStatus !== "within_policy",
    externalArtifactUseRegistry,
    historyStatus:
      options.historyStatus ?? (structurallyClosed ? "complete" : "in_progress"),
    events,
    ...options.topOverride,
  };
  return {
    blueprintArtifact,
    historyArtifact: canonicalLine(historyValue),
  };
}

interface SignatureSurfaceCase {
  readonly name: string;
  readonly field: string;
  readonly inspect: () => { readonly ok: boolean };
}

const NON_CANONICAL_SIGNATURE_SURFACES: readonly SignatureSurfaceCase[] = [
  {
    name: "blueprint issuance time",
    field: "issuanceTimeSignatureBase64",
    inspect: () => {
      const candidate = mutateBlueprint(blueprint());
      candidate.issuanceTimeSignatureBase64 = nonCanonicalSignatureAlias(
        String(candidate.issuanceTimeSignedPayloadDigestSha256),
      );
      refreshIssuanceAuthentication(candidate);
      return parseProductionLiveCopyBlueprint(canonicalLine(candidate));
    },
  },
  {
    name: "target recipient possession",
    field: "target.recipientKeyPossession",
    inspect: () => {
      const candidate = mutateBlueprint(blueprint());
      const target = candidate.target as Record<string, unknown>;
      target.recipientKeyPossessionSignatureBase64 = nonCanonicalSignatureAlias(
        String(target.recipientKeyPossessionSignedPayloadDigestSha256),
      );
      refreshRecipientPossession(candidate);
      return parseProductionLiveCopyBlueprint(canonicalLine(candidate));
    },
  },
  {
    name: "stage artifact",
    field: "events.0.artifact.signatureBase64",
    inspect: () => {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        artifactOverride: (stage, _sequence, artifact) => {
          if (stage !== "target_challenge_issue") return artifact;
          const signatureBase64 = nonCanonicalSignatureAlias(
            artifact.signedPayloadDigestSha256,
          );
          return {
            ...artifact,
            signatureBase64,
            digestSha256: sha256(
              PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.artifact +
                "\0" + artifact.signedPayloadDigestSha256 +
                "\0" + signatureBase64,
            ),
          };
        },
      });
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
  {
    name: "cleanup attestation",
    field: "events.15.artifact.cleanupAttestations.0.signatureBase64",
    inspect: () => {
      const value = blueprint();
      const artifacts = historyArtifact(
        SUCCESS_STAGES,
        {
          artifactOverride: (stage, sequence, artifact) => {
            if (stage !== "target_destroy_and_attest") return artifact;
            const first = artifact.cleanupAttestations[0];
            if (first === undefined) {
              throw new Error("Destruction fixture must include cleanup attestations");
            }
            const signatureBase64 = nonCanonicalSignatureAlias(
              first.signedPayloadDigestSha256,
            );
            const modified = {
              ...first,
              signatureBase64,
              attestationDigestSha256: sha256(
                PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
                  "\0cleanup_attestation\0" + first.signedPayloadDigestSha256 +
                  "\0" + first.signerKeyIdSha256 +
                  "\0" + signatureBase64,
              ),
            };
            return reauthenticateArtifact(stage, sequence, value, artifact, {
              cleanupAttestations: [modified, ...artifact.cleanupAttestations.slice(1)],
            });
          },
        },
        value,
      );
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
  {
    name: "stage receipt",
    field: "events.0.receipt.signatureBase64",
    inspect: () => {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        receiptOverride: (stage, _sequence, receipt) =>
          stage === "target_challenge_issue"
            ? reauthenticateReceipt({
                ...receipt,
                signatureBase64: nonCanonicalSignatureAlias(
                  String(receipt.signedPayloadDigestSha256),
                ),
              })
            : receipt,
      });
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
  {
    name: "stage trusted time receipt",
    field: "events.0.receipt.trustedTimeSignatureBase64",
    inspect: () => {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        receiptOverride: (stage, _sequence, receipt) => {
          if (stage !== "target_challenge_issue") return receipt;
          const trustedTimeSignatureBase64 = nonCanonicalSignatureAlias(
            String(receipt.trustedTimeSignedPayloadDigestSha256),
          );
          return reauthenticateReceipt({
            ...receipt,
            trustedTimeSignatureBase64,
            trustedTimeReceiptDigestSha256: sha256(
              PRODUCTION_LIVE_COPY_LIFECYCLE_HASH_DOMAINS.authenticatedEnvelope +
                "\0observed_time\0" +
                String(receipt.trustedTimeSignedPayloadDigestSha256) +
                "\0" + String(receipt.trustedTimeSignerKeyIdSha256) +
                "\0" + trustedTimeSignatureBase64,
            ),
          });
        },
      });
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
  {
    name: "external registry claim",
    field: "externalArtifactUseRegistry.signatureBase64",
    inspect: () => {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        registrySignatureOverride: nonCanonicalSignatureAlias,
      });
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
  {
    name: "trusted audit time",
    field: "trustedAsOfSignatureBase64",
    inspect: () => {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        trustedAsOfSignatureOverride: nonCanonicalSignatureAlias,
      });
      return parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
    },
  },
];

describe("production live-copy canonical fail-closed authority foundation", () => {
  it("accepts only a canonical trusted-time blueprint artifact", () => {
    const artifactText = canonicalLine(blueprint());
    const parsed = parseProductionLiveCopyBlueprint(artifactText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      operationalStatus: "schema_only",
      exactExecutionEligible: false,
      issuedAtUnixMs: 10_000,
    });
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.source)).toBe(true);
    expect(Object.isFrozen(parsed.value.retentionPolicy)).toBe(true);
    expect(
      parseProductionLiveCopyBlueprint(`${JSON.stringify(blueprint(), null, 2)}\n`),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_blueprint", field: "canonical" },
    });
    expect(parseProductionLiveCopyBlueprint(Buffer.from(artifactText))).toMatchObject({
      ok: false,
      error: { kind: "invalid_blueprint", field: "boundary" },
    });
  });

  it("uses real Ed25519 bytes for the noncanonical signature fixtures", () => {
    const payloadDigestSha256 = sha256("real-signature-canonicality");
    const canonical = signArtifactPayload(payloadDigestSha256);
    const alias = nonCanonicalSignatureAlias(payloadDigestSha256);
    expect(alias).not.toBe(canonical);
    expect(Buffer.from(alias, "base64")).toEqual(Buffer.from(canonical, "base64"));
    expect(
      verifyEd25519(
        null,
        Buffer.from(payloadDigestSha256, "hex"),
        TEST_ARTIFACT_PUBLIC_KEY,
        Buffer.from(alias, "base64"),
      ),
    ).toBe(true);
  });

  it.each(NON_CANONICAL_SIGNATURE_SURFACES)(
    "rejects a noncanonical real signature at $name",
    ({ field, inspect }) => {
      expect(inspect()).toMatchObject({ ok: false, error: { field } });
    },
  );

  it("rejects object accessor and proxy boundaries without invoking traps", () => {
    let accessorReads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "schema", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "comis-production-live-copy-blueprint";
      },
    });
    const effect = vi.fn();
    Object.defineProperty(accessor, "effect", { enumerable: false, get: effect });
    let proxyTrapCalls = 0;
    const proxy = new Proxy(blueprint(), {
      get() {
        proxyTrapCalls += 1;
        throw new Error("get trap");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("ownKeys trap");
      },
    });
    for (const hostile of [accessor, proxy]) {
      expect(parseProductionLiveCopyBlueprint(hostile)).toMatchObject({
        ok: false,
        error: { kind: "invalid_blueprint", field: "boundary" },
      });
      expect(assessProductionLiveCopyReadiness(hostile)).toMatchObject({
        ok: false,
        error: { kind: "invalid_blueprint", field: "boundary" },
      });
    }
    expect({ accessorReads, proxyTrapCalls }).toEqual({ accessorReads: 0, proxyTrapCalls: 0 });
    expect(effect).not.toHaveBeenCalled();
  });

  it("enforces trusted issuance and bounded authorization stop and quarantine leases", () => {
    const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
      ["forged issued time", (value) => Reflect.set(value, "issuedAtUnixMs", 9_999)],
      [
        "capture lease",
        (value) => Reflect.set(value, "captureAuthorizationDeadlineUnixMs", 50_001),
      ],
      ["source stop lease", (value) => Reflect.set(value, "sourceStopLeaseDeadlineUnixMs", 40_001)],
      [
        "target quarantine lease",
        (value) => Reflect.set(value, "targetQuarantineLeaseDeadlineUnixMs", 70_001),
      ],
    ];
    for (const [name, mutate] of cases) {
      const candidate = mutateBlueprint(blueprint());
      mutate(candidate);
      expect(parseProductionLiveCopyBlueprint(canonicalLine(candidate)), name).toMatchObject({
        ok: false,
        error: { kind: "invalid_blueprint" },
      });
    }
    const badReceipt = mutateBlueprint(blueprint());
    badReceipt.issuanceTimeReceiptDigestSha256 = sha256("self-asserted-time");
    expect(parseProductionLiveCopyBlueprint(canonicalLine(badReceipt))).toMatchObject({
      ok: false,
      error: { field: "issuanceTimeReceiptDigestSha256" },
    });
  });

  it("enforces every cross-role identity and key pair as disjoint", () => {
    expect(PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS).toEqual(
      expect.arrayContaining([
        "source.machineIdentityDigestSha256",
        "target.machineIdentityDigestSha256",
        "source.endpointAttestationDigestSha256",
        "target.endpointAttestationDigestSha256",
        "sourceStoppedGenerationSha256",
        "sourceStopLeaseIdentitySha256",
        "targetQuarantineGenerationSha256",
        "targetQuarantineLeaseIdentitySha256",
        "encryptionRecipientKeyIdSha256",
      ]),
    );
    const base = blueprint();
    for (let left = 0; left < PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS.length; left += 1) {
      for (let right = left + 1; right < PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS.length; right += 1) {
        const leftPath = PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS.at(left);
        const rightPath = PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS.at(right);
        if (leftPath === undefined || rightPath === undefined) {
          throw new Error("Role-disjointness matrix indices must resolve to declared paths");
        }
        const candidate = mutateBlueprint(base);
        setPath(candidate, rightPath, pathValue(candidate, leftPath));
        refreshIssuanceAuthentication(candidate);
        expect(
          parseProductionLiveCopyBlueprint(canonicalLine(candidate)),
          `${leftPath} must differ from ${rightPath}`,
        ).toMatchObject({
          ok: false,
          error: { kind: "invalid_blueprint" },
        });
      }
    }
  });

  it("rejects shared Ed25519 key material behind role-separated key identifiers", () => {
    const distinct = mutateBlueprint(blueprint());
    addAuthorizationRoleKeyMaterials(distinct);
    const parsedDistinct = parseProductionLiveCopyBlueprint(canonicalLine(distinct));
    expect(parsedDistinct).toMatchObject({ ok: true });
    if (!parsedDistinct.ok) return;

    const advertisedKeyIds = AUTHORIZATION_ROLES.map((role) =>
      pathValue(distinct, AUTHORIZATION_ROLE_KEY_FIELDS[role].keyId),
    );
    expect(new Set(advertisedKeyIds).size).toBe(AUTHORIZATION_ROLES.length);

    for (let left = 0; left < AUTHORIZATION_ROLES.length; left += 1) {
      for (let right = left + 1; right < AUTHORIZATION_ROLES.length; right += 1) {
        const leftRole = AUTHORIZATION_ROLES[left];
        const rightRole = AUTHORIZATION_ROLES[right];
        if (leftRole === undefined || rightRole === undefined) {
          throw new Error("Authorization role matrix indices must resolve");
        }
        const aliased = structuredClone(distinct);
        const sharedDer = String(pathValue(
          aliased,
          AUTHORIZATION_ROLE_KEY_FIELDS[leftRole].publicKey,
        ));
        setPath(
          aliased,
          AUTHORIZATION_ROLE_KEY_FIELDS[rightRole].publicKey,
          sharedDer,
        );
        setPath(
          aliased,
          AUTHORIZATION_ROLE_KEY_FIELDS[rightRole].keyId,
          authorizationRoleKeyId(rightRole, sharedDer),
        );
        expect(
          pathValue(aliased, AUTHORIZATION_ROLE_KEY_FIELDS[leftRole].keyId),
        ).not.toBe(
          pathValue(aliased, AUTHORIZATION_ROLE_KEY_FIELDS[rightRole].keyId),
        );
        expect(
          parseProductionLiveCopyBlueprint(canonicalLine(aliased)),
          `${leftRole} and ${rightRole} must not resolve to one key`,
        ).toMatchObject({
          ok: false,
          error: {
            kind: "invalid_blueprint",
            field: "authorizationRoleKeyMaterialDisjointness",
          },
        });
      }
    }

    const nonCanonical = structuredClone(distinct);
    const canonicalDer = TEST_AUTHORIZATION_PUBLIC_KEY_DER_BASE64.operator;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const finalDataIndex = canonicalDer.length - 2;
    const canonicalValue = alphabet.indexOf(canonicalDer.at(finalDataIndex) ?? "");
    const aliasedValue = alphabet.at((canonicalValue & 0x3c) | 1);
    if (canonicalValue < 0 || aliasedValue === undefined) {
      throw new Error("Ed25519 SPKI fixture must have canonical Base64 padding");
    }
    const nonCanonicalDer = canonicalDer.slice(0, finalDataIndex) +
      aliasedValue + canonicalDer.slice(finalDataIndex + 1);
    expect(Buffer.from(nonCanonicalDer, "base64")).toEqual(
      Buffer.from(canonicalDer, "base64"),
    );
    nonCanonical.operatorSigningPublicKeyDerBase64 = nonCanonicalDer;
    nonCanonical.operatorSigningKeyIdSha256 = authorizationRoleKeyId(
      "operator",
      nonCanonicalDer,
    );
    expect(parseProductionLiveCopyBlueprint(canonicalLine(nonCanonical))).toMatchObject({
      ok: false,
      error: {
        kind: "invalid_blueprint",
        field: "operatorSigningPublicKeyDerBase64",
      },
    });

    const nonKeyDer = structuredClone(distinct);
    const boundedNonKeyDer = Buffer.alloc(44, 0x5a).toString("base64");
    nonKeyDer.operatorSigningPublicKeyDerBase64 = boundedNonKeyDer;
    nonKeyDer.operatorSigningKeyIdSha256 = authorizationRoleKeyId(
      "operator",
      boundedNonKeyDer,
    );
    expect(parseProductionLiveCopyBlueprint(canonicalLine(nonKeyDer))).toMatchObject({
      ok: false,
      error: {
        kind: "invalid_blueprint",
        field: "operatorSigningPublicKeyDerBase64",
      },
    });
  });

  it("binds controller grant to operator grant and target attestation to key possession", () => {
    expect(PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS.controllerGrant).toContain(
      "operatorGrantDigestSha256",
    );
    expect(PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS.targetAttestation).toEqual(
      expect.arrayContaining([
        "encryptionRecipientKeyIdSha256",
        "targetRecipientKeyPossessionAttestationDigestSha256",
      ]),
    );
    for (const fields of Object.values(PRODUCTION_LIVE_COPY_REQUIRED_BINDING_SCHEMAS)) {
      expect(new Set(fields).size).toBe(fields.length);
      expect(fields).toContain("targetRecipientKeyPossessionSignerKeyIdSha256");
    }
    const candidate = mutateBlueprint(blueprint());
    const target = candidate.target as Record<string, unknown>;
    target.recipientKeyPossessionAttestationDigestSha256 = null;
    expect(parseProductionLiveCopyBlueprint(canonicalLine(candidate))).toMatchObject({
      ok: false,
      error: { field: "target.recipientKeyPossession" },
    });
  });

  it("exports complete closed receipt and authority contracts", () => {
    const artifactSchemas = Reflect.get(
      liveCopyFoundation,
      "PRODUCTION_LIVE_COPY_REQUIRED_ARTIFACT_SCHEMAS",
    ) as Record<string, { fields: readonly string[]; signerRole: string }> | undefined;
    expect(artifactSchemas).toBeDefined();
    expect(Object.keys(artifactSchemas ?? {})).toHaveLength(
      PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES.length,
    );
    for (const schema of Object.values(artifactSchemas ?? {})) {
      expect(schema.fields).toEqual(expect.arrayContaining([
        "runId",
        "attemptId",
        "stage",
        "kind",
        "recoverySequence",
        "recoveryGenerationSha256",
        "previousRecoveryArtifactDigestSha256",
        "createdSensitiveSubjects",
        "cleanupSubjects",
        "authenticationKind",
        "signerRole",
        "signerKeyIdSha256",
        "signedPayloadDigestSha256",
        "signatureBase64",
      ]));
      expect(schema.signerRole).toMatch(/^(controller|destruction|operator|source|target)$/u);
    }
    expect(Object.keys(PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS).sort()).toEqual([
      "abort",
      "authorization",
      "challenge",
      "destruction",
      "finalize",
      "promotion",
      "receive",
      "recovery",
      "restore",
    ]);
    for (const fields of Object.values(PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS)) {
      expect(fields).toEqual(
        expect.arrayContaining([
          "runId",
          "attemptId",
          "stage",
          "sequence",
          "authorityStoreIdentitySha256",
          "sequenceAuthorityStoreHeadDigestSha256",
          "sequencePredecessorDigestSha256",
          "sequenceHeadDigestSha256",
          "sourceStoppedGenerationSha256",
          "sourceStopLeaseIdentitySha256",
          "targetQuarantineGenerationSha256",
          "targetQuarantineLeaseIdentitySha256",
          "targetRecipientKeyPossessionSignerKeyIdSha256",
          "artifactKind",
          "artifactDigestSha256",
          "trustedTimeReceiptDigestSha256",
          "authenticationKind",
          "signerRole",
          "signerKeyIdSha256",
          "signedPayloadDigestSha256",
          "signatureBase64",
          "trustedTimeAuthenticationKind",
          "trustedTimeSignerKeyIdSha256",
          "trustedTimeSignedPayloadDigestSha256",
          "trustedTimeSignatureBase64",
        ]),
      );
      expect(Object.isFrozen(fields)).toBe(true);
    }
    const expectedAuthorityPins = [
      "source.immutableMachineTrustRootStoreIdentitySha256",
      "source.immutableMachineTrustRootHeadDigestSha256",
      "target.immutableMachineTrustRootStoreIdentitySha256",
      "target.immutableMachineTrustRootHeadDigestSha256",
      "operatorTrustRootStoreIdentitySha256",
      "operatorTrustRootHeadDigestSha256",
      "controllerTrustRootStoreIdentitySha256",
      "controllerTrustRootHeadDigestSha256",
      "targetAuthorityStoreIdentitySha256",
      "targetAuthorityStoreHeadDigestSha256",
      "sourceAuthorityStoreIdentitySha256",
      "sourceAuthorityStoreHeadDigestSha256",
      "sequenceAuthorityStoreIdentitySha256",
      "sequenceAuthorityStoreHeadDigestSha256",
      "trustedTimeAuthorityStoreIdentitySha256",
      "trustedTimeAuthorityStoreHeadDigestSha256",
      "trustedTimeSigningKeyIdSha256",
      "artifactUseRegistryStoreIdentitySha256",
      "artifactUseRegistryStoreHeadDigestSha256",
      "artifactUseRegistrySigningKeyIdSha256",
      "retentionPolicy.destructionAuthorityStoreIdentitySha256",
      "retentionPolicy.destructionAuthorityStoreHeadDigestSha256",
    ] as const;
    expect(PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS).toEqual(
      expectedAuthorityPins,
    );
    expect(new Set(PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS)).toEqual(
      new Set(expectedAuthorityPins),
    );
    expect(PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS).toHaveLength(
      expectedAuthorityPins.length,
    );
    expect(Object.isFrozen(PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS)).toBe(true);
    const registryAuthorityPins = [
      "artifactUseRegistryStoreIdentitySha256",
      "artifactUseRegistryStoreHeadDigestSha256",
      "artifactUseRegistrySigningKeyIdSha256",
    ] as const;
    expect(new Set(PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS).size).toBe(
      PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS.length,
    );
    expect(
      PRODUCTION_LIVE_COPY_REQUIRED_AUTHORITY_PIN_PATHS.filter((path) =>
        path.startsWith("artifactUseRegistry"),
      ),
    ).toEqual(registryAuthorityPins);
    expect(
      PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT.authorityPinPaths,
    ).toBe(PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS);
    expect(PRODUCTION_LIVE_COPY_ARTIFACT_USE_REGISTRY_AUTHORITY_PIN_PATHS).toEqual(
      registryAuthorityPins,
    );
    const expectedPossessionAuthorityContract = {
      receiptSignerKeyIdField: "targetRecipientKeyPossessionSignerKeyIdSha256",
      blueprintSignerKeyIdPath: "target.recipientKeyPossessionSignerKeyIdSha256",
      authorityStoreIdentityPinPath:
        "target.immutableMachineTrustRootStoreIdentitySha256",
      authorityStoreHeadDigestPinPath:
        "target.immutableMachineTrustRootHeadDigestSha256",
      authorizationRule:
        "require_signer_membership_at_exact_pinned_target_machine_trust_root_head",
    } as const;
    const possessionAuthorityContract = Reflect.get(
      liveCopyFoundation,
      "PRODUCTION_LIVE_COPY_TARGET_RECIPIENT_POSSESSION_AUTHORITY_CONTRACT",
    ) as typeof expectedPossessionAuthorityContract | undefined;
    expect(possessionAuthorityContract).toEqual(expectedPossessionAuthorityContract);
    expect(Object.isFrozen(possessionAuthorityContract)).toBe(true);
    expect(expectedAuthorityPins).toContain(
      possessionAuthorityContract?.authorityStoreIdentityPinPath,
    );
    expect(expectedAuthorityPins).toContain(
      possessionAuthorityContract?.authorityStoreHeadDigestPinPath,
    );
    const signerRootMapping = new Set([
      [
        possessionAuthorityContract?.blueprintSignerKeyIdPath,
        possessionAuthorityContract?.authorityStoreIdentityPinPath,
        possessionAuthorityContract?.authorityStoreHeadDigestPinPath,
      ].join("\0"),
    ]);
    expect(signerRootMapping).toEqual(
      new Set([
        [
          "target.recipientKeyPossessionSignerKeyIdSha256",
          "target.immutableMachineTrustRootStoreIdentitySha256",
          "target.immutableMachineTrustRootHeadDigestSha256",
        ].join("\0"),
      ]),
    );
  });

  it("keeps readiness compile-time never until time and replay authorities exist", () => {
    const artifactText = canonicalLine(blueprint());
    expectTypeOf(
      assessProductionLiveCopyReadiness(artifactText),
    ).toEqualTypeOf<Result<never, ProductionLiveCopyReadinessError>>();
    expect(assessProductionLiveCopyReadiness(artifactText)).toMatchObject({
      ok: false,
      error: {
        kind: "operationally_ineligible",
        exactExecutionEligible: false,
        blockers: PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS,
        requiredDurableStages: PRODUCTION_LIVE_COPY_REQUIRED_DURABLE_STAGES,
        durableLifecycle: PRODUCTION_LIVE_COPY_DURABLE_LIFECYCLE,
        requiredReceiptSchemas: PRODUCTION_LIVE_COPY_REQUIRED_RECEIPT_SCHEMAS,
        requiredRoleDisjointPaths: PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS,
        globalReplayPreventionContract:
          PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT,
      },
    });
    expect(PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS).toEqual(
      expect.arrayContaining([
        "trusted_time_signature_verification_authority_not_implemented",
        "global_durable_replay_prevention_authority_not_implemented",
        "external_monotonic_artifact_use_registry_not_implemented",
        "artifact_signature_verification_authority_not_implemented",
        "receipt_signature_verification_authority_not_implemented",
        "target_recipient_key_possession_signature_verification_not_implemented",
      ]),
    );
  });

  it("parses uninterrupted resumed aborted and partial-grant expiry histories", () => {
    const paths = [
      { stages: SUCCESS_STAGES, expected: { claimedState: "destroyed" } },
      {
        stages: [
          ...SUCCESS_STAGES.slice(0, 6),
          "source_capture_resume_same_staging",
          ...SUCCESS_STAGES.slice(6),
        ] as const,
        expected: { claimedState: "destroyed" },
      },
      {
        stages: [
          ...SUCCESS_STAGES.slice(0, 10),
          "target_abort",
          "target_destroy_and_attest",
        ] as const,
        expected: { claimedState: "destroyed" },
      },
      {
        stages: ["target_challenge_issue", "target_challenge_expire"] as const,
        expected: { claimedState: "challenge_expired" },
      },
      {
        stages: [
          "target_challenge_issue",
          "operator_grant_record",
          "target_challenge_expire",
        ] as const,
        expected: { claimedState: "challenge_expired" },
      },
      {
        stages: [
          "target_challenge_issue",
          "operator_grant_record",
          "controller_grant_record",
          "target_challenge_expire",
        ] as const,
        expected: { claimedState: "challenge_expired" },
      },
    ];
    for (const path of paths) {
      const artifacts = historyArtifact(path.stages);
      const inspected = parseProductionLiveCopyLifecycleHistory(
        artifacts.historyArtifact,
        artifacts.blueprintArtifact,
      );
      if (!inspected.ok) {
        throw new Error(`Expected structural history inspection: ${JSON.stringify(inspected.error)}`);
      }
      expect(
        inspected,
      ).toMatchObject({
        ok: true,
        value: {
          ...path.expected,
          structurallyClosed: true,
          structuralStatus: "unverified_external_authorities",
          exactExecutionEligible: false,
        },
      });
      const decoded = JSON.parse(artifacts.historyArtifact) as Record<string, unknown>;
      expect(decoded).not.toHaveProperty("sourceAttestationDigestSha256");
      expect(decoded).not.toHaveProperty("targetAttestationDigestSha256");
      expect(decoded).not.toHaveProperty("retainedArtifactDigestSha256");
    }
  });

  it("chains repeated source capture recovery with deterministic Ed25519 signatures", () => {
    const artifacts = historyArtifact([
      ...SUCCESS_STAGES.slice(0, 6),
      "source_capture_resume_same_staging",
      "source_capture_resume_same_staging",
      ...SUCCESS_STAGES.slice(6),
    ]);
    const inspected = parseProductionLiveCopyLifecycleHistory(
      artifacts.historyArtifact,
      artifacts.blueprintArtifact,
    );
    expect(inspected).toMatchObject({
      ok: true,
      value: { claimedState: "destroyed", structurallyClosed: true },
    });

    const decoded = JSON.parse(artifacts.historyArtifact) as {
      externalArtifactUseRegistry: {
        entries: Array<{ identityClass: string; digestSha256: string }>;
      };
      events: Array<{
        stage: ProductionLiveCopyDurableStage;
        artifact: Record<string, unknown>;
      }>;
    };
    const recoveries = decoded.events
      .filter(({ stage }) => stage === "source_capture_resume_same_staging")
      .map(({ artifact }) => artifact);
    expect(recoveries).toHaveLength(2);
    expect(recoveries.map(({ recoverySequence }) => recoverySequence)).toEqual([1, 2]);
    expect(recoveries[0]?.previousRecoveryArtifactDigestSha256).toBeNull();
    expect(recoveries[1]?.previousRecoveryArtifactDigestSha256).toBe(
      recoveries[0]?.digestSha256,
    );
    expect(recoveries[0]?.recoveryGenerationSha256).not.toBe(
      recoveries[1]?.recoveryGenerationSha256,
    );
    for (const recovery of recoveries) {
      expect(decoded.externalArtifactUseRegistry.entries).toContainEqual({
        identityClass: "authority_generation",
        digestSha256: recovery.recoveryGenerationSha256,
      });
    }
    for (const recovery of recoveries) {
      const payload = String(recovery.signedPayloadDigestSha256);
      const encodedSignature = String(recovery.signatureBase64);
      expect(
        verifyEd25519(
          null,
          Buffer.from(payload, "hex"),
          createPublicKey(TEST_AUTHORIZATION_PRIVATE_KEYS.source),
          Buffer.from(encodedSignature, "base64"),
        ),
      ).toBe(true);
      expect(signArtifactPayload(payload, "source")).toBe(encodedSignature);
    }
  });

  it("rejects a recovery generation that aliases any static disjoint identity", () => {
    const value = blueprint();
    for (const path of PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS) {
      const staticIdentifier = pathValue(
        value as unknown as Record<string, unknown>,
        path,
      );
      if (typeof staticIdentifier !== "string") {
        throw new Error("Every declared role-disjoint path must resolve to a digest");
      }
      const artifacts = historyArtifact(
        [
          ...SUCCESS_STAGES.slice(0, 6),
          "source_capture_resume_same_staging",
          ...SUCCESS_STAGES.slice(6),
        ],
        {
          artifactOverride: (stage, sequence, defaultValue) =>
            stage === "source_capture_resume_same_staging"
              ? reauthenticateArtifact(stage, sequence, value, defaultValue, {
                  recoveryGenerationSha256: staticIdentifier,
                })
              : defaultValue,
        },
        value,
      );
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
        path,
      ).toMatchObject({
        ok: false,
        error: {
          kind: "lifecycle_binding_mismatch",
          field: "artifact.recoveryGenerationSha256",
        },
      });
    }
  });

  it("rejects recovery generations colliding with every lifecycle identity namespace", () => {
    const value = blueprint();
    const stages = [
      ...SUCCESS_STAGES.slice(0, 6),
      "source_capture_resume_same_staging",
      ...SUCCESS_STAGES.slice(6),
    ] as const;
    const baseline = historyArtifact(stages, {}, value);
    const decoded = JSON.parse(baseline.historyArtifact) as {
      readonly challengeDigestSha256: string;
      readonly events: readonly {
        readonly stage: ProductionLiveCopyDurableStage;
        readonly eventDigestSha256: string;
        readonly artifact: ProductionLiveCopyLifecycleArtifact;
        readonly receipt: Readonly<Record<string, unknown>>;
      }[];
    };
    const recoveryIndex = decoded.events.findIndex(
      ({ stage }) => stage === "source_capture_resume_same_staging",
    );
    const priorEvents = decoded.events.slice(0, recoveryIndex);
    const aliases = [
      {
        namespace: "artifact",
        field: "challengeDigestSha256",
        digest: decoded.challengeDigestSha256,
      },
      ...priorEvents.map(({ artifact }, index) => ({
        namespace: "artifact",
        field: `events.${index}.artifact.digestSha256`,
        digest: artifact.digestSha256,
      })),
      ...priorEvents.map(({ eventDigestSha256 }, index) => ({
        namespace: "event",
        field: `events.${index}.eventDigestSha256`,
        digest: eventDigestSha256,
      })),
      {
        namespace: "receipt",
        field: "blueprint.issuanceTimeReceiptDigestSha256",
        digest: value.issuanceTimeReceiptDigestSha256,
      },
      ...priorEvents.flatMap(({ receipt }, index) => [
        {
          namespace: "receipt",
          field: `events.${index}.receipt.receiptDigestSha256`,
          digest: String(receipt.receiptDigestSha256),
        },
        {
          namespace: "receipt",
          field: `events.${index}.receipt.trustedTimeReceiptDigestSha256`,
          digest: String(receipt.trustedTimeReceiptDigestSha256),
        },
        {
          namespace: "receipt",
          field: `events.${index}.receipt.sequenceHeadDigestSha256`,
          digest: String(receipt.sequenceHeadDigestSha256),
        },
      ]),
      ...Object.entries(DIGESTS).map(([name, digest]) => ({
        namespace: "sensitive_subject",
        field: `sensitiveSubjects.${name}`,
        digest,
      })),
    ] as const;
    expect(new Set(aliases.map(({ namespace }) => namespace))).toEqual(
      new Set(["artifact", "event", "receipt", "sensitive_subject"]),
    );
    expect(aliases).toHaveLength(1 + 6 + 6 + 1 + (6 * 3) + 6);

    for (const alias of aliases) {
      const hostile = historyArtifact(
        stages,
        {
          artifactOverride: (stage, sequence, defaultValue) =>
            stage === "source_capture_resume_same_staging"
              ? reauthenticateArtifact(stage, sequence, value, defaultValue, {
                  recoveryGenerationSha256: alias.digest,
                })
              : defaultValue,
        },
        value,
      );
      expect(
        parseProductionLiveCopyLifecycleHistory(
          hostile.historyArtifact,
          hostile.blueprintArtifact,
        ),
        alias.field,
      ).toMatchObject({
        ok: false,
        error: {
          kind: "lifecycle_binding_mismatch",
          field: "artifact.recoveryGenerationSha256",
        },
      });
    }
  });

  it("rejects substituted repeated recovery sequence generation and predecessor bindings", () => {
    const value = blueprint();
    const stages = [
      ...SUCCESS_STAGES.slice(0, 6),
      "source_capture_resume_same_staging",
      "source_capture_resume_same_staging",
      ...SUCCESS_STAGES.slice(6),
    ] as const;
    const hostileCases: Array<{
      readonly field: string;
      readonly override: (
        first: ProductionLiveCopyLifecycleArtifact,
      ) => Partial<ArtifactDescriptor>;
    }> = [
      {
        field: "artifact.recoverySequence",
        override: () => ({ recoverySequence: 1 }),
      },
      {
        field: "artifact.recoveryGenerationSha256",
        override: (first) => ({
          recoveryGenerationSha256: first.recoveryGenerationSha256,
        }),
      },
      {
        field: "artifact.previousRecoveryArtifactDigestSha256",
        override: () => ({
          previousRecoveryArtifactDigestSha256: sha256("substituted-recovery"),
        }),
      },
    ];
    for (const candidate of hostileCases) {
      let firstRecovery: ProductionLiveCopyLifecycleArtifact | null = null;
      let recoveryOrdinal = 0;
      const artifacts = historyArtifact(
        stages,
        {
          artifactOverride: (stage, sequence, defaultValue) => {
            if (stage !== "source_capture_resume_same_staging") return defaultValue;
            recoveryOrdinal += 1;
            if (recoveryOrdinal === 1) {
              firstRecovery = defaultValue;
              return defaultValue;
            }
            if (firstRecovery === null) {
              throw new Error("First recovery artifact must precede the second recovery");
            }
            return reauthenticateArtifact(
              stage,
              sequence,
              value,
              defaultValue,
              candidate.override(firstRecovery),
            );
          },
        },
        value,
      );
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
        candidate.field,
      ).toMatchObject({
        ok: false,
        error: { kind: "lifecycle_binding_mismatch", field: candidate.field },
      });
    }

    const premature = historyArtifact(
      SUCCESS_STAGES,
      {
        artifactOverride: (stage, sequence, defaultValue) =>
          stage === "target_challenge_issue"
            ? reauthenticateArtifact(stage, sequence, value, defaultValue, {
                recoverySequence: 1,
                recoveryGenerationSha256: sha256("premature-recovery-generation"),
              })
            : defaultValue,
      },
      value,
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        premature.historyArtifact,
        premature.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_lifecycle_history", field: "events.0.artifact" },
    });
  });

  it("lets crash recovery terminate an abort before any retained ciphertext exists", () => {
    const earlyAbort = historyArtifact(
      [
        "target_challenge_issue",
        "operator_grant_record",
        "controller_grant_record",
        "target_challenge_consume",
        "target_abort",
      ],
      { historyStatus: "complete" },
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        earlyAbort.historyArtifact,
        earlyAbort.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        claimedState: "aborted",
        structurallyClosed: true,
        cleanupOutstanding: false,
      },
    });

    const retainedAbort = historyArtifact(
      [...SUCCESS_STAGES.slice(0, 8), "target_abort"],
      { historyStatus: "complete" },
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        retainedAbort.historyArtifact,
        retainedAbort.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_lifecycle_history", field: "historyStatus" },
    });
  });

  it("requires exact authenticated cleanup inventory after capture manifest restore and promotion", () => {
    for (const stages of [
      [...SUCCESS_STAGES.slice(0, 6), "target_abort"],
      [...SUCCESS_STAGES.slice(0, 7), "target_abort"],
    ] as const) {
      const incomplete = historyArtifact(stages, { historyStatus: "complete" });
      expect(
        parseProductionLiveCopyLifecycleHistory(
          incomplete.historyArtifact,
          incomplete.blueprintArtifact,
        ),
      ).toMatchObject({
        ok: false,
        error: { kind: "invalid_lifecycle_history", field: "historyStatus" },
      });
    }

    for (const stages of [
      [...SUCCESS_STAGES.slice(0, 13), "target_abort", "target_destroy_and_attest"],
      [...SUCCESS_STAGES.slice(0, 14), "target_abort", "target_destroy_and_attest"],
    ] as const) {
      const cleanup = historyArtifact(stages);
      const decoded = JSON.parse(cleanup.historyArtifact) as {
        events: Array<{
          stage: ProductionLiveCopyDurableStage;
          artifact: Record<string, unknown>;
        }>;
      };
      const abort = decoded.events.find(({ stage }) => stage === "target_abort")?.artifact;
      const destruction = decoded.events.find(
        ({ stage }) => stage === "target_destroy_and_attest",
      )?.artifact;
      expect(abort).toMatchObject({
        cleanupInventoryDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(destruction).toMatchObject({
        cleanupAttestations: expect.arrayContaining([
          expect.objectContaining({ subjectKind: "source_capture_workspace" }),
          expect.objectContaining({ subjectKind: "source_snapshot_manifest" }),
          expect.objectContaining({ subjectKind: "source_encrypted_staging" }),
          expect.objectContaining({ subjectKind: "target_encrypted_staging" }),
          expect.objectContaining({ subjectKind: "quarantine_plaintext" }),
        ]),
      });
      if (stages.length === 16) {
        expect(destruction).toMatchObject({
          cleanupAttestations: expect.arrayContaining([
            expect.objectContaining({
              action: "promoted_plaintext_rolled_back",
              subjectKind: "promoted_plaintext",
            }),
          ]),
        });
      }
    }

    for (const stages of [
      [...SUCCESS_STAGES.slice(0, 6), "target_abort", "target_destroy_and_attest"],
      [...SUCCESS_STAGES.slice(0, 7), "target_abort", "target_destroy_and_attest"],
    ] as const) {
      const sourceCleanup = historyArtifact(stages);
      expect(
        parseProductionLiveCopyLifecycleHistory(
          sourceCleanup.historyArtifact,
          sourceCleanup.blueprintArtifact,
        ),
      ).toMatchObject({
        ok: true,
        value: { claimedState: "destroyed", cleanupOutstanding: false },
      });
    }

    const value = blueprint();
    const omittedAbortSubject = historyArtifact(
      [...SUCCESS_STAGES.slice(0, 14), "target_abort"],
      {
        artifactOverride: (stage, sequence, defaultValue) =>
          stage === "target_abort"
            ? authenticatedArtifact(
                stage,
                sequence,
                {
                  kind: defaultValue.kind,
                  subjectKind: defaultValue.subjectKind,
                  subjectDigestSha256: defaultValue.subjectDigestSha256,
                  predecessorArtifactKind: defaultValue.predecessorArtifactKind,
                  predecessorArtifactDigestSha256:
                    defaultValue.predecessorArtifactDigestSha256,
                  recoverySequence: defaultValue.recoverySequence,
                  recoveryGenerationSha256: defaultValue.recoveryGenerationSha256,
                  previousRecoveryArtifactDigestSha256:
                    defaultValue.previousRecoveryArtifactDigestSha256,
                  createdSensitiveSubjects: defaultValue.createdSensitiveSubjects,
                  cleanupSubjects: defaultValue.cleanupSubjects.slice(1),
                  cleanupAttestations: [],
                },
                value,
              )
            : defaultValue,
      },
      value,
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        omittedAbortSubject.historyArtifact,
        omittedAbortSubject.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "lifecycle_binding_mismatch", field: "artifact.cleanupSubjects" },
    });

    const omittedDestructionAttestation = historyArtifact(
      SUCCESS_STAGES,
      {
        artifactOverride: (stage, sequence, defaultValue) =>
          stage === "target_destroy_and_attest"
            ? authenticatedArtifact(
                stage,
                sequence,
                {
                  kind: defaultValue.kind,
                  subjectKind: defaultValue.subjectKind,
                  subjectDigestSha256: defaultValue.subjectDigestSha256,
                  predecessorArtifactKind: defaultValue.predecessorArtifactKind,
                  predecessorArtifactDigestSha256:
                    defaultValue.predecessorArtifactDigestSha256,
                  recoverySequence: defaultValue.recoverySequence,
                  recoveryGenerationSha256: defaultValue.recoveryGenerationSha256,
                  previousRecoveryArtifactDigestSha256:
                    defaultValue.previousRecoveryArtifactDigestSha256,
                  createdSensitiveSubjects: defaultValue.createdSensitiveSubjects,
                  cleanupSubjects: defaultValue.cleanupSubjects,
                  cleanupAttestations: defaultValue.cleanupAttestations.slice(1),
                },
                value,
              )
            : defaultValue,
      },
      value,
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        omittedDestructionAttestation.historyArtifact,
        omittedDestructionAttestation.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "lifecycle_binding_mismatch",
        field: "artifact.cleanupAttestations",
      },
    });
  });

  it("bounds retention and records trusted overdue and late-cleanup audit state", () => {
    for (const deadline of [86_410_001, Number.MAX_SAFE_INTEGER]) {
      const unbounded = mutateBlueprint(blueprint());
      const retention = unbounded.retentionPolicy as Record<string, unknown>;
      retention.destructionDeadlineUnixMs = deadline;
      expect(parseProductionLiveCopyBlueprint(canonicalLine(unbounded))).toMatchObject({
        ok: false,
        error: {
          kind: "invalid_blueprint",
          field: "retentionPolicy.destructionDeadlineUnixMs",
        },
      });
    }

    const overdue = historyArtifact(
      [...SUCCESS_STAGES.slice(0, 6), "target_abort"],
      {
        historyStatus: "in_progress",
        trustedAsOfUnixMs: 120_000,
      },
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        overdue.historyArtifact,
        overdue.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        claimedState: "aborted",
        retentionAuditStatus: "overdue_cleanup_required",
        retentionPolicyBreached: true,
        cleanupOutstanding: true,
        exactExecutionEligible: false,
      },
    });

    const lateCleanup = historyArtifact(SUCCESS_STAGES, {
      observedAtOverride: (stage, _sequence, defaultValue) =>
        stage === "target_destroy_and_attest" ? 120_000 : defaultValue,
      trustedAsOfUnixMs: 120_000,
    });
    expect(
      parseProductionLiveCopyLifecycleHistory(
        lateCleanup.historyArtifact,
        lateCleanup.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        claimedState: "destroyed",
        retentionAuditStatus: "late_cleanup_recorded",
        retentionPolicyBreached: true,
        cleanupOutstanding: false,
        exactExecutionEligible: false,
      },
    });
  });

  it("treats artifact receipt time and possession authentication as unverified structure", () => {
    const artifacts = historyArtifact(SUCCESS_STAGES);
    const decoded = JSON.parse(artifacts.historyArtifact) as {
      events: Array<{
        artifact: Record<string, unknown>;
        receipt: Record<string, unknown>;
      }>;
    };
    for (const event of decoded.events) {
      expect(event.artifact).toMatchObject({
        authenticationKind: "ed25519_signature",
        signerRole: expect.stringMatching(/^(controller|destruction|operator|source|target)$/u),
        signerKeyIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        signedPayloadDigestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        signatureBase64: expect.any(String),
      });
      expect(event.receipt).toMatchObject({
        authenticationKind: "ed25519_signature",
        signerKeyIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        signatureBase64: expect.any(String),
        trustedTimeAuthenticationKind: "ed25519_signature",
        trustedTimeSignerKeyIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        trustedTimeSignatureBase64: expect.any(String),
      });
    }
    const inspected = parseProductionLiveCopyLifecycleHistory(
      artifacts.historyArtifact,
      artifacts.blueprintArtifact,
    );
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        claimedState: "destroyed",
        structuralStatus: "unverified_external_authorities",
        exactExecutionEligible: false,
      },
    });
    if (inspected.ok) {
      expect(inspected.value).not.toHaveProperty("terminal");
      expect(inspected.value).not.toHaveProperty("outcome");
    }
  });

  it("models an external monotonic artifact-use registry for reuse forks and rollback", () => {
    expect(PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT).toMatchObject({
      mode: "external_atomic_artifact_registry_compare_append",
      reusePolicy: "deny_every_identity_forever_across_histories_and_attempts",
      requiredInvariants: expect.arrayContaining([
        "no_cross_attempt_artifact_reuse",
        "no_sibling_head_forks",
        "no_entry_deletion_or_rollback",
      ]),
      identityClasses: expect.arrayContaining([
        "artifact",
        "ciphertext",
        "receipt",
        "attestation",
        "finalization",
        "destruction",
      ]),
    });

    const firstBlueprint = blueprint();
    const secondBlueprint = mutateBlueprint(firstBlueprint);
    secondBlueprint.attemptId = "fedcba9876543210fedcba9876543210";
    refreshIssuanceAuthentication(secondBlueprint);
    const histories = [
      historyArtifact(SUCCESS_STAGES, {}, firstBlueprint),
      historyArtifact(
        SUCCESS_STAGES,
        {},
        secondBlueprint as unknown as ProductionLiveCopyBlueprint,
      ),
    ];
    const registrySubjectSets: Array<Set<string>> = [];
    for (const history of histories) {
      const inspected = parseProductionLiveCopyLifecycleHistory(
        history.historyArtifact,
        history.blueprintArtifact,
      );
      expect(inspected).toMatchObject({
        ok: true,
        value: {
          structuralStatus: "unverified_external_authorities",
          externalArtifactUseRegistry: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                identityClass: "sensitive_subject",
                digestSha256: DIGESTS.sourceManifest,
              }),
              expect.objectContaining({
                identityClass: "ciphertext",
                digestSha256: DIGESTS.sourceEncryptedStaging,
              }),
              expect.objectContaining({
                identityClass: "ciphertext",
                digestSha256: DIGESTS.targetEncryptedStaging,
              }),
              expect.objectContaining({ identityClass: "finalization" }),
              expect.objectContaining({ identityClass: "destruction" }),
            ]),
          },
        },
      });
      if (inspected.ok) {
        registrySubjectSets.push(new Set(
          inspected.value.externalArtifactUseRegistry.entries
            .filter(({ identityClass }) => identityClass === "sensitive_subject")
            .map(({ digestSha256 }) => digestSha256),
        ));
      }
      expect(
        validateProductionLiveCopyLifecycleHistory(
          history.historyArtifact,
          history.blueprintArtifact,
        ),
      ).toMatchObject({
        ok: false,
        error: { kind: "global_replay_prevention_required" },
      });
    }
    expect(
      [...(registrySubjectSets[0] ?? [])].every((digest) =>
        registrySubjectSets[1]?.has(digest),
      ),
    ).toBe(true);

    const firstDecoded = JSON.parse(histories[0]?.historyArtifact ?? "") as {
      events: Array<{ artifact: ProductionLiveCopyLifecycleArtifact }>;
    };
    const reusedCrossAttemptArtifact = historyArtifact(
      SUCCESS_STAGES,
      {
        artifactOverride: (stage, _sequence, defaultValue) =>
          stage === "operator_grant_record"
            ? (firstDecoded.events[1]?.artifact ?? defaultValue)
            : defaultValue,
      },
      secondBlueprint as unknown as ProductionLiveCopyBlueprint,
    );
    expect(
      parseProductionLiveCopyLifecycleHistory(
        reusedCrossAttemptArtifact.historyArtifact,
        reusedCrossAttemptArtifact.blueprintArtifact,
      ),
    ).toMatchObject({ ok: false });

    const shortened = historyArtifact(SUCCESS_STAGES.slice(0, -1), {
      historyStatus: "in_progress",
    });
    expect(
      validateProductionLiveCopyLifecycleHistory(
        shortened.historyArtifact,
        shortened.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "global_replay_prevention_required" },
    });
  });

  it("rejects duplicate same-class identities before registry claim comparison", () => {
    const candidate = mutateBlueprint(blueprint());
    const source = candidate.source as Record<string, unknown>;
    source.dataDirCommitmentSha256 = sha256(
      Buffer.from(String(candidate.challengeNonceBase64), "base64"),
    );
    const parsedBlueprint = parseProductionLiveCopyBlueprint(canonicalLine(candidate));
    if (!parsedBlueprint.ok) {
      throw new Error(`Expected duplicate-registry fixture blueprint: ${JSON.stringify(parsedBlueprint.error)}`);
    }
    const artifacts = historyArtifact(SUCCESS_STAGES, {}, parsedBlueprint.value);
    const inspected = parseProductionLiveCopyLifecycleHistory(
      artifacts.historyArtifact,
      artifacts.blueprintArtifact,
    );
    if (inspected.ok) {
      throw new Error("Duplicate same-class artifact-use identities must fail closed");
    }
    const typedError: ProductionLiveCopyLifecycleHistoryError = inspected.error;
    expect(typedError).toMatchObject({
      kind: "lifecycle_binding_mismatch",
      field: "externalArtifactUseRegistry.entries",
    });
  });

  it("rejects staging data-dir aliases and stale recipient possession after key replacement", () => {
    for (const path of [
      "source.dataDirCommitmentSha256",
      "target.dataDirCommitmentSha256",
      "source.serviceCommitmentSha256",
      "target.serviceCommitmentSha256",
      "stagingNamespaceDigestSha256",
    ]) {
      expect(PRODUCTION_LIVE_COPY_REQUIRED_ROLE_DISJOINT_PATHS).toContain(path);
    }
    const aliased = mutateBlueprint(blueprint());
    aliased.stagingNamespaceDigestSha256 = pathValue(
      aliased,
      "target.dataDirCommitmentSha256",
    );
    expect(parseProductionLiveCopyBlueprint(canonicalLine(aliased))).toMatchObject({
      ok: false,
      error: { kind: "invalid_blueprint", field: "roleDisjointness" },
    });

    const stalePossession = mutateBlueprint(blueprint());
    stalePossession.encryptionRecipientKeyIdSha256 = sha256("replacement-recipient-key");
    expect(parseProductionLiveCopyBlueprint(canonicalLine(stalePossession))).toMatchObject({
      ok: false,
      error: { kind: "invalid_blueprint", field: "target.recipientKeyPossession" },
    });
  });

  it("rejects illegal grant capture transfer restore and terminal transitions", () => {
    const hostilePaths: readonly (readonly ProductionLiveCopyDurableStage[])[] = [
      ["target_challenge_issue", "controller_grant_record"],
      ["target_challenge_issue", "operator_grant_record", "target_challenge_consume"],
      [
        "target_challenge_issue",
        "operator_grant_record",
        "controller_grant_record",
        "target_challenge_consume",
        "target_challenge_consume",
      ],
      [...SUCCESS_STAGES.slice(0, 6), "target_transfer_authorize_and_begin"],
      [...SUCCESS_STAGES.slice(0, 10), "target_restore_verified_state_to_quarantine"],
      [...SUCCESS_STAGES, "target_promote_restored_state"],
    ];
    for (const stages of hostilePaths) {
      const artifacts = historyArtifact(stages, { historyStatus: "in_progress" });
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it("treats every authorization and isolation deadline as exclusive", () => {
    const cases: readonly {
      stages: readonly ProductionLiveCopyDurableStage[];
      stage: ProductionLiveCopyDurableStage;
      deadline: (value: ProductionLiveCopyBlueprint) => number;
    }[] = [
      {
        stages: SUCCESS_STAGES.slice(0, 4),
        stage: "target_challenge_consume",
        deadline: (value) => value.captureAuthorizationDeadlineUnixMs,
      },
      {
        stages: SUCCESS_STAGES.slice(0, 6),
        stage: "source_capture_consume_under_stop_lease",
        deadline: (value) => value.sourceStopLeaseDeadlineUnixMs,
      },
      {
        stages: SUCCESS_STAGES.slice(0, 13),
        stage: "target_restore_verified_state_to_quarantine",
        deadline: (value) => value.targetQuarantineLeaseDeadlineUnixMs,
      },
    ];
    for (const candidate of cases) {
      const value = blueprint();
      const artifacts = historyArtifact(
        candidate.stages,
        {
          historyStatus: "in_progress",
          observedAtOverride: (stage, _sequence, defaultValue) =>
            stage === candidate.stage ? candidate.deadline(value) : defaultValue,
        },
        value,
      );
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
      ).toMatchObject({
        ok: false,
        error: { kind: "invalid_lifecycle_history" },
      });
    }
    const expiry = historyArtifact([
      "target_challenge_issue",
      "operator_grant_record",
      "target_challenge_expire",
    ]);
    expect(
      parseProductionLiveCopyLifecycleHistory(
        expiry.historyArtifact,
        expiry.blueprintArtifact,
      ),
    ).toMatchObject({ ok: true, value: { claimedState: "challenge_expired" } });
  });

  it("binds controller receive restoration promotion and destruction to created artifacts", () => {
    const artifacts = historyArtifact(SUCCESS_STAGES);
    const decoded = JSON.parse(artifacts.historyArtifact) as {
      events: Array<{
        stage: ProductionLiveCopyDurableStage;
        artifact: ProductionLiveCopyLifecycleArtifact;
      }>;
    };
    const operatorGrant = decoded.events.find(
      ({ stage }) => stage === "operator_grant_record",
    )?.artifact;
    expect(
      decoded.events.find(({ stage }) => stage === "controller_grant_record")?.artifact,
    ).toMatchObject({
      kind: "controller_grant",
      predecessorArtifactKind: "operator_grant",
      predecessorArtifactDigestSha256: operatorGrant?.digestSha256,
    });
    expect(
      decoded.events.find(({ stage }) => stage === "target_receive_encrypted_staging")
        ?.artifact,
    ).toMatchObject({
      kind: "encrypted_staging_receipt",
      subjectKind: "source_encrypted_staging",
      subjectDigestSha256: DIGESTS.sourceEncryptedStaging,
    });
    expect(
      decoded.events.find(({ stage }) => stage === "target_destroy_and_attest")
        ?.artifact,
    ).toMatchObject({
      kind: "destruction_attestation",
      subjectKind: "none",
      predecessorArtifactKind: "finalization",
      cleanupAttestations: expect.arrayContaining([
        expect.objectContaining({ subjectKind: "source_capture_workspace" }),
        expect.objectContaining({ subjectKind: "promoted_plaintext" }),
      ]),
    });

    for (const [stage, mutate] of [
      [
        "controller_grant_record",
        (value: ProductionLiveCopyLifecycleArtifact) => ({
          ...value,
          predecessorArtifactDigestSha256: sha256("other-operator-grant"),
        }),
      ],
      [
        "target_receive_encrypted_staging",
        (value: ProductionLiveCopyLifecycleArtifact) => ({
          ...value,
          subjectDigestSha256: sha256("other-ciphertext"),
        }),
      ],
      [
        "target_destroy_and_attest",
        (value: ProductionLiveCopyLifecycleArtifact) => ({
          ...value,
          cleanupAttestations: value.cleanupAttestations.slice(1),
        }),
      ],
    ] as const) {
      const hostile = historyArtifact(SUCCESS_STAGES, {
        artifactOverride: (candidate, _sequence, defaultValue) =>
          candidate === stage ? mutate(defaultValue) : defaultValue,
      });
      expect(
        parseProductionLiveCopyLifecycleHistory(
          hostile.historyArtifact,
          hostile.blueprintArtifact,
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects substituted receipt authority time key lease and sequence bindings", () => {
    const canonicalBlueprint = blueprint();
    const canonical = historyArtifact(SUCCESS_STAGES, {}, canonicalBlueprint);
    const canonicalHistory = JSON.parse(canonical.historyArtifact) as {
      events: Array<{ receipt: Record<string, unknown> }>;
    };
    expect(canonicalHistory.events[0]?.receipt.sequenceAuthorityStoreHeadDigestSha256).toBe(
      canonicalBlueprint.sequenceAuthorityStoreHeadDigestSha256,
    );
    for (const field of [
      "kind",
      "authorityStoreIdentitySha256",
      "sequenceAuthorityStoreHeadDigestSha256",
      "sequencePredecessorDigestSha256",
      "sequenceHeadDigestSha256",
      "sourceStopLeaseIdentitySha256",
      "targetQuarantineLeaseIdentitySha256",
      "encryptionRecipientKeyIdSha256",
      "targetRecipientKeyPossessionAttestationDigestSha256",
      "trustedTimeAuthorityStoreIdentitySha256",
      "trustedTimeReceiptDigestSha256",
    ] as const) {
      const artifacts = historyArtifact(SUCCESS_STAGES, {
        receiptOverride: (stage, _sequence, defaultValue) =>
          stage === "target_receive_encrypted_staging"
            ? { ...defaultValue, [field]: field === "kind" ? "challenge" : sha256(`wrong:${field}`) }
            : defaultValue,
      });
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
        field,
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects replay rollback forks duplicate receipts and noncanonical history", () => {
    const options: readonly HistoryOptions[] = [
      {
        eventOverride: (_stage, sequence) =>
          sequence === 4 ? { attemptId: "fedcba9876543210fedcba9876543210" } : {},
      },
      {
        eventOverride: (_stage, sequence) =>
          sequence === 4 ? { challengeDigestSha256: sha256("other-challenge") } : {},
      },
      { eventOverride: (_stage, sequence) => (sequence === 2 ? { sequence: 1 } : {}) },
      {
        eventOverride: (_stage, sequence) =>
          sequence === 2 ? { previousEventDigestSha256: sha256("other-predecessor") } : {},
      },
      {
        receiptOverride: (_stage, sequence, defaultValue) =>
          sequence === 2
            ? { ...defaultValue, receiptDigestSha256: sha256("replayed-receipt") }
            : defaultValue,
      },
      { topOverride: { sequenceHeadDigestSha256: sha256("rolled-back-head") } },
      { topOverride: { sequenceNoForkProofDigestSha256: sha256("forked-proof") } },
    ];
    for (const option of options) {
      const artifacts = historyArtifact(SUCCESS_STAGES, option);
      expect(
        parseProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
      ).toMatchObject({ ok: false });
    }
    const canonical = historyArtifact(SUCCESS_STAGES);
    const decoded = JSON.parse(canonical.historyArtifact) as unknown;
    expect(
      parseProductionLiveCopyLifecycleHistory(
        `${JSON.stringify(decoded, null, 2)}\n`,
        canonical.blueprintArtifact,
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_lifecycle_history", field: "canonical" },
    });
  });

  it("requires external global replay prevention across histories and attempts", () => {
    const firstBlueprint = blueprint();
    const secondBlueprint = mutateBlueprint(firstBlueprint);
    secondBlueprint.attemptId = "fedcba9876543210fedcba9876543210";
    refreshIssuanceAuthentication(secondBlueprint);
    const first = historyArtifact(SUCCESS_STAGES, {}, firstBlueprint);
    const second = historyArtifact(
      SUCCESS_STAGES,
      {},
      secondBlueprint as unknown as ProductionLiveCopyBlueprint,
    );
    const firstParsed = parseProductionLiveCopyLifecycleHistory(
      first.historyArtifact,
      first.blueprintArtifact,
    );
    const secondParsed = parseProductionLiveCopyLifecycleHistory(
      second.historyArtifact,
      second.blueprintArtifact,
    );
    expect(firstParsed.ok).toBe(true);
    expect(secondParsed.ok).toBe(true);
    if (!firstParsed.ok || !secondParsed.ok) return;
    expect(secondParsed.value.globalReplayKeySha256).toBe(
      firstParsed.value.globalReplayKeySha256,
    );

    expectTypeOf(
      validateProductionLiveCopyLifecycleHistory(
        first.historyArtifact,
        first.blueprintArtifact,
      ),
    ).toEqualTypeOf<Result<never, ProductionLiveCopyLifecycleHistoryError>>();
    for (const artifacts of [first, second]) {
      expect(
        validateProductionLiveCopyLifecycleHistory(
          artifacts.historyArtifact,
          artifacts.blueprintArtifact,
        ),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "global_replay_prevention_required",
          exactExecutionEligible: false,
          unverifiedAuthorityBlockers: PRODUCTION_LIVE_COPY_REQUIRED_BLOCKERS,
          globalReplayKeySha256: firstParsed.value.globalReplayKeySha256,
          contract: PRODUCTION_LIVE_COPY_GLOBAL_REPLAY_PREVENTION_CONTRACT,
        },
      });
    }
  });

  it("never authorizes deterministic single-byte blueprint and history mutation fuzz cases", () => {
    const value = blueprint();
    const blueprintArtifact = canonicalLine(value);
    const history = historyArtifact(SUCCESS_STAGES, {}, value);
    let state = 0x5eed_c0de;
    let lastMutation = "";
    const mutate = (input: string): string => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const index = state % (input.length - 1);
      const current = input.at(index);
      const replacements = ["0", "A", "f", "{", "]"];
      const replacement = replacements.find((candidate) => candidate !== current) ?? "X";
      lastMutation = `${index}:${current ?? "<missing>"}->${replacement}`;
      return `${input.slice(0, index)}${replacement}${input.slice(index + 1)}`;
    };
    for (let index = 0; index < 128; index += 1) {
      const mutatedBlueprint = mutate(blueprintArtifact);
      const parsedBlueprint = parseProductionLiveCopyBlueprint(mutatedBlueprint);
      if (parsedBlueprint.ok) {
        expect(
          assessProductionLiveCopyReadiness(mutatedBlueprint),
          `blueprint:${index}:${lastMutation}`,
        ).toMatchObject({
          ok: false,
          error: { kind: "operationally_ineligible", exactExecutionEligible: false },
        });
      }
      const mutatedHistory = mutate(history.historyArtifact);
      const inspected = parseProductionLiveCopyLifecycleHistory(
        mutatedHistory,
        history.blueprintArtifact,
      );
      if (inspected.ok) {
        expect(inspected.value, `history:${index}:${lastMutation}`).toMatchObject({
          structuralStatus: "unverified_external_authorities",
          exactExecutionEligible: false,
        });
        expect(
          validateProductionLiveCopyLifecycleHistory(
            mutatedHistory,
            history.blueprintArtifact,
          ),
        ).toMatchObject({ ok: false });
      }
    }
  });

  it("rejects hostile lifecycle boundaries without invoking traps", () => {
    const artifacts = historyArtifact(SUCCESS_STAGES);
    let trapCalls = 0;
    const proxy = new Proxy({}, {
      get() {
        trapCalls += 1;
        throw new Error("history get trap");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("history ownKeys trap");
      },
    });
    expect(
      parseProductionLiveCopyLifecycleHistory(proxy, artifacts.blueprintArtifact),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_lifecycle_history", field: "boundary" },
    });
    expect(
      parseProductionLiveCopyLifecycleHistory(artifacts.historyArtifact, proxy),
    ).toMatchObject({
      ok: false,
      error: { kind: "invalid_blueprint", field: "boundary" },
    });
    expect(trapCalls).toBe(0);
  });

  it("exports parsing and fail-closed assessment only", () => {
    const callableExports = Object.entries(liveCopyFoundation)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(callableExports).toEqual([
      "assessProductionLiveCopyReadiness",
      "parseProductionLiveCopyBlueprint",
      "parseProductionLiveCopyLifecycleHistory",
      "validateProductionLiveCopyLifecycleHistory",
    ]);
    expect(
      callableExports.some((name) =>
        /authorize|begin|capture|consume|effect|grant|issue|seal|serialize|sign|transfer/iu.test(
          name.replace("ProductionLiveCopy", ""),
        ),
      ),
    ).toBe(false);
  });
});
