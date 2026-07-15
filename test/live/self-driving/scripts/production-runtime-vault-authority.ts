// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  RUNTIME_FACTS_BEGIN,
  RUNTIME_FACTS_END,
  parseRuntimeArtifactFacts,
  type RuntimeArtifactAttestation,
} from "./production-runtime.js";
import {
  RUNTIME_TREE_FACTS_BEGIN,
  RUNTIME_TREE_FACTS_END,
  parseRuntimeTreeFacts,
  type RuntimeTreeAttestation,
} from "./production-runtime-tree.js";

const RECEIPT_SCHEMA = "comis-runtime-vault-recovery-receipt";
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_CANONICALIZATION = "comis-json-c14n-v1";
const RECEIPT_ALGORITHM = "hmac-sha256";
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SERVICE_BYTES = 256;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024 * 1024;
const STREAM_ENTRY_OVERHEAD_BYTES = 16 * 1024;
const STREAM_FIXED_OVERHEAD_BYTES = 128 * 1024 * 1024;
const MAX_CREATED_AT_MS = 8_640_000_000_000_000;
const MIN_AUTHORITY_KEY_BYTES = 32;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ATTEMPT_ID_RE = /^[a-f0-9]{32}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SERVICE_RE = /^[A-Za-z0-9_.@:-]+$/u;
const AUTHORITY_KEY_ID_DOMAIN = "comis-runtime-vault-recovery-authority-key-v1\0";
const AUTHORITY_DIGEST_DOMAIN = "comis-runtime-vault-recovery-authority-v1\0";
const AUTHENTICATION_TAG_DOMAIN = "comis-runtime-vault-recovery-receipt-hmac-v1\0";

const INPUT_KEYS = [
  "schemaVersion",
  "runId",
  "attemptId",
  "sourceMachineIdSha256",
  "targetMachineIdSha256",
  "sourceRuntimeArtifact",
  "targetRuntimeArtifact",
  "runtimeTreeAttestation",
  "maximumArchiveBytes",
  "payloadPath",
  "sourceService",
  "sourceDataDir",
  "targetService",
  "targetDataDir",
  "targetPackageRoot",
  "targetControlDir",
  "targetIncomingRoot",
  "targetTransactionDir",
  "sourceToolchainRecoveryDigestSha256",
  "targetToolchainRecoveryDigestSha256",
  "sourceServiceRecoveryDigestSha256",
  "targetServiceRecoveryDigestSha256",
  "createdAtMs",
] as const;

const UNSIGNED_KEYS = ["schema", ...INPUT_KEYS] as const;
const RECEIPT_KEYS = [...UNSIGNED_KEYS, "seal"] as const;
const SEAL_KEYS = [
  "algorithm",
  "canonicalization",
  "authorityKeyIdSha256",
  "authorityDigestSha256",
  "authenticationTagSha256",
] as const;

const RUNTIME_ARTIFACT_KEYS = [
  "digestSha256",
  "entryCount",
  "bytes",
  "packageRoot",
  "version",
  "osId",
  "osVersion",
  "architecture",
  "kernelRelease",
  "libcKind",
  "libcVersion",
  "nodeVersion",
  "nodeAbi",
  "timezone",
  "tzdataSha256",
  "launcherKind",
  "applicationLauncherSha256",
  "confinementKind",
  "confinementSha256",
  "browserStatus",
  "browserSha256",
  "mediaStatus",
  "mediaSha256",
  "nativeToolsStatus",
  "nativeToolsSha256",
] as const;

const RUNTIME_TREE_KEYS = ["digestSha256", "entryCount", "bytes", "root", "version"] as const;

export interface ProductionRuntimeVaultRecoveryReceiptInput {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly sourceMachineIdSha256: string;
  readonly targetMachineIdSha256: string;
  readonly sourceRuntimeArtifact: RuntimeArtifactAttestation;
  readonly targetRuntimeArtifact: RuntimeArtifactAttestation;
  readonly runtimeTreeAttestation: RuntimeTreeAttestation;
  readonly maximumArchiveBytes: number;
  readonly payloadPath: string;
  readonly sourceService: string;
  readonly sourceDataDir: string;
  readonly targetService: string;
  readonly targetDataDir: string;
  readonly targetPackageRoot: string;
  readonly targetControlDir: string;
  readonly targetIncomingRoot: string;
  readonly targetTransactionDir: string;
  readonly sourceToolchainRecoveryDigestSha256: string;
  readonly targetToolchainRecoveryDigestSha256: string;
  readonly sourceServiceRecoveryDigestSha256: string;
  readonly targetServiceRecoveryDigestSha256: string;
  readonly createdAtMs: number;
}

export interface ProductionRuntimeVaultRecoveryReceiptSeal {
  readonly algorithm: "hmac-sha256";
  readonly canonicalization: "comis-json-c14n-v1";
  readonly authorityKeyIdSha256: string;
  readonly authorityDigestSha256: string;
  readonly authenticationTagSha256: string;
}

export interface ProductionRuntimeVaultRecoveryReceipt
  extends ProductionRuntimeVaultRecoveryReceiptInput {
  readonly schema: "comis-runtime-vault-recovery-receipt";
  readonly seal: ProductionRuntimeVaultRecoveryReceiptSeal;
}

export type ProductionRuntimeVaultRecoveryReceiptError =
  | {
      readonly kind: "invalid_authority_key";
      readonly field: "authorityKey";
      readonly message: string;
    }
  | {
      readonly kind: "invalid_request";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "malformed_receipt";
      readonly field: string;
      readonly message: string;
    }
  | {
      readonly kind: "authentication_failed";
      readonly field: "seal";
      readonly message: string;
    };

type UnsignedReceipt = Omit<ProductionRuntimeVaultRecoveryReceipt, "seal">;

function invalid(
  kind: "invalid_request" | "malformed_receipt",
  field: string,
  message: string,
): Result<never, ProductionRuntimeVaultRecoveryReceiptError> {
  return err({ kind, field, message });
}

function invalidAuthorityKey(): Result<never, ProductionRuntimeVaultRecoveryReceiptError> {
  return err({
    kind: "invalid_authority_key",
    field: "authorityKey",
    message: "Recovery receipt authority key must contain at least 32 bytes",
  });
}

function authenticationFailed(): Result<never, ProductionRuntimeVaultRecoveryReceiptError> {
  return err({
    kind: "authentication_failed",
    field: "seal",
    message: "Recovery receipt authority verification failed",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

function sha256(domain: string, value: string | Uint8Array): string {
  return createHash("sha256").update(domain).update(value).digest("hex");
}

function authorityKeyId(key: Uint8Array): string {
  return sha256(AUTHORITY_KEY_ID_DOMAIN, key);
}

function authorityDigest(canonicalUnsigned: string): string {
  return sha256(AUTHORITY_DIGEST_DOMAIN, canonicalUnsigned);
}

function authenticationTag(canonicalUnsigned: string, key: Uint8Array): string {
  return createHmac("sha256", key)
    .update(AUTHENTICATION_TAG_DOMAIN)
    .update(canonicalUnsigned)
    .digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateAuthorityKey(
  key: Uint8Array,
): Result<Uint8Array, ProductionRuntimeVaultRecoveryReceiptError> {
  if (!(key instanceof Uint8Array) || key.byteLength < MIN_AUTHORITY_KEY_BYTES) {
    return invalidAuthorityKey();
  }
  return ok(key);
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "/" ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.endsWith("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function runtimeArtifactEnvelope(value: RuntimeArtifactAttestation): string {
  return [
    RUNTIME_FACTS_BEGIN,
    `digestSha256=${value.digestSha256}`,
    `entryCount=${value.entryCount}`,
    `bytes=${value.bytes}`,
    `packageRoot=${value.packageRoot}`,
    `version=${value.version}`,
    `osId=${value.osId}`,
    `osVersion=${value.osVersion}`,
    `architecture=${value.architecture}`,
    `kernelRelease=${value.kernelRelease}`,
    `libcKind=${value.libcKind}`,
    `libcVersion=${value.libcVersion}`,
    `nodeVersion=${value.nodeVersion}`,
    `nodeAbi=${value.nodeAbi}`,
    `timezone=${value.timezone}`,
    `tzdataSha256=${value.tzdataSha256}`,
    `launcherKind=${value.launcherKind}`,
    `applicationLauncherSha256=${value.applicationLauncherSha256}`,
    `confinementKind=${value.confinementKind}`,
    `confinementSha256=${value.confinementSha256}`,
    `browserStatus=${value.browserStatus}`,
    `browserSha256=${value.browserSha256}`,
    `mediaStatus=${value.mediaStatus}`,
    `mediaSha256=${value.mediaSha256}`,
    `nativeToolsStatus=${value.nativeToolsStatus}`,
    `nativeToolsSha256=${value.nativeToolsSha256}`,
    RUNTIME_FACTS_END,
    "",
  ].join("\n");
}

function validateRuntimeArtifact(
  value: unknown,
  field: "sourceRuntimeArtifact" | "targetRuntimeArtifact",
  expectedConfinement: "source" | "target_quarantine",
  errorKind: "invalid_request" | "malformed_receipt",
): Result<RuntimeArtifactAttestation, ProductionRuntimeVaultRecoveryReceiptError> {
  if (!isRecord(value) || !hasExactKeys(value, RUNTIME_ARTIFACT_KEYS)) {
    return invalid(errorKind, field, `${field} must contain the complete runtime artifact shape`);
  }
  const parsed = parseRuntimeArtifactFacts(
    runtimeArtifactEnvelope(value as unknown as RuntimeArtifactAttestation),
  );
  if (!parsed.ok || !isCanonicalAbsolutePath(parsed.value.packageRoot)) {
    return invalid(errorKind, field, `${field} is not a valid bounded runtime artifact`);
  }
  if (parsed.value.confinementKind !== expectedConfinement) {
    return invalid(errorKind, field, `${field} has the wrong confinement authority`);
  }
  return ok(parsed.value);
}

function runtimeTreeEnvelope(value: RuntimeTreeAttestation): string {
  return [
    RUNTIME_TREE_FACTS_BEGIN,
    `digestSha256=${value.digestSha256}`,
    `entryCount=${value.entryCount}`,
    `bytes=${value.bytes}`,
    `root=${value.root}`,
    `version=${value.version}`,
    RUNTIME_TREE_FACTS_END,
    "",
  ].join("\n");
}

function validateRuntimeTree(
  value: unknown,
  errorKind: "invalid_request" | "malformed_receipt",
): Result<RuntimeTreeAttestation, ProductionRuntimeVaultRecoveryReceiptError> {
  if (!isRecord(value) || !hasExactKeys(value, RUNTIME_TREE_KEYS)) {
    return invalid(
      errorKind,
      "runtimeTreeAttestation",
      "runtimeTreeAttestation must contain the complete runtime tree shape",
    );
  }
  const parsed = parseRuntimeTreeFacts(
    runtimeTreeEnvelope(value as unknown as RuntimeTreeAttestation),
  );
  if (!parsed.ok) {
    return invalid(
      errorKind,
      "runtimeTreeAttestation",
      "runtimeTreeAttestation is not a valid bounded runtime tree attestation",
    );
  }
  return ok(parsed.value);
}

function validateRequiredDigest(
  value: unknown,
  field:
    | "sourceToolchainRecoveryDigestSha256"
    | "targetToolchainRecoveryDigestSha256"
    | "sourceServiceRecoveryDigestSha256"
    | "targetServiceRecoveryDigestSha256",
  errorKind: "invalid_request" | "malformed_receipt",
): Result<string, ProductionRuntimeVaultRecoveryReceiptError> {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    return invalid(errorKind, field, `${field} must be a lowercase SHA-256 digest`);
  }
  return ok(value);
}

function validateService(
  value: unknown,
  field: "sourceService" | "targetService",
  errorKind: "invalid_request" | "malformed_receipt",
): Result<string, ProductionRuntimeVaultRecoveryReceiptError> {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SERVICE_BYTES ||
    !SERVICE_RE.test(value)
  ) {
    return invalid(errorKind, field, `${field} is not a bounded service name`);
  }
  return ok(value);
}

function validateUnsigned(
  raw: unknown,
  errorKind: "invalid_request" | "malformed_receipt",
): Result<UnsignedReceipt, ProductionRuntimeVaultRecoveryReceiptError> {
  if (!isRecord(raw) || !hasExactKeys(raw, UNSIGNED_KEYS)) {
    return invalid(errorKind, "shape", "Recovery receipt has unknown, missing, or duplicate fields");
  }
  if (raw.schema !== RECEIPT_SCHEMA) {
    return invalid(errorKind, "schema", "Recovery receipt schema is not recognized");
  }
  if (raw.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return invalid(errorKind, "schemaVersion", "Recovery receipt schemaVersion is not supported");
  }
  if (typeof raw.runId !== "string" || !SAFE_RUN_ID_RE.test(raw.runId)) {
    return invalid(errorKind, "runId", "runId is not a bounded runtime-vault identifier");
  }
  if (typeof raw.attemptId !== "string" || !ATTEMPT_ID_RE.test(raw.attemptId)) {
    return invalid(errorKind, "attemptId", "attemptId must be 32 lowercase hexadecimal bytes");
  }
  if (
    typeof raw.sourceMachineIdSha256 !== "string" ||
    !SHA256_RE.test(raw.sourceMachineIdSha256) ||
    typeof raw.targetMachineIdSha256 !== "string" ||
    !SHA256_RE.test(raw.targetMachineIdSha256) ||
    raw.sourceMachineIdSha256 === raw.targetMachineIdSha256
  ) {
    return invalid(
      errorKind,
      "machineIdSha256",
      "Source and target must have distinct lowercase SHA-256 machine identities",
    );
  }

  const sourceRuntimeArtifact = validateRuntimeArtifact(
    raw.sourceRuntimeArtifact,
    "sourceRuntimeArtifact",
    "source",
    errorKind,
  );
  if (!sourceRuntimeArtifact.ok) return sourceRuntimeArtifact;
  const targetRuntimeArtifact = validateRuntimeArtifact(
    raw.targetRuntimeArtifact,
    "targetRuntimeArtifact",
    "target_quarantine",
    errorKind,
  );
  if (!targetRuntimeArtifact.ok) return targetRuntimeArtifact;
  const runtimeTreeAttestation = validateRuntimeTree(raw.runtimeTreeAttestation, errorKind);
  if (!runtimeTreeAttestation.ok) return runtimeTreeAttestation;

  if (
    runtimeTreeAttestation.value.root !== sourceRuntimeArtifact.value.packageRoot ||
    runtimeTreeAttestation.value.version !== sourceRuntimeArtifact.value.version ||
    runtimeTreeAttestation.value.bytes !== sourceRuntimeArtifact.value.bytes
  ) {
    return invalid(
      errorKind,
      "runtimeTreeAttestation",
      "Runtime tree authority does not reconcile with the source runtime artifact",
    );
  }
  const expectedMaximumArchiveBytes =
    runtimeTreeAttestation.value.bytes +
    runtimeTreeAttestation.value.entryCount * STREAM_ENTRY_OVERHEAD_BYTES +
    STREAM_FIXED_OVERHEAD_BYTES;
  if (
    !Number.isSafeInteger(expectedMaximumArchiveBytes) ||
    typeof raw.maximumArchiveBytes !== "number" ||
    !Number.isSafeInteger(raw.maximumArchiveBytes) ||
    raw.maximumArchiveBytes !== expectedMaximumArchiveBytes ||
    raw.maximumArchiveBytes > MAX_ARCHIVE_BYTES
  ) {
    return invalid(
      errorKind,
      "maximumArchiveBytes",
      "maximumArchiveBytes does not equal the exact bounded runtime archive layout",
    );
  }

  const expectedPayloadPath = `/opt/comis-replay/runtimes/sha256/${runtimeTreeAttestation.value.digestSha256}/payload`;
  if (!isCanonicalAbsolutePath(raw.payloadPath) || raw.payloadPath !== expectedPayloadPath) {
    return invalid(
      errorKind,
      "payloadPath",
      "payloadPath does not name the attested content-addressed runtime payload",
    );
  }
  const sourceService = validateService(raw.sourceService, "sourceService", errorKind);
  if (!sourceService.ok) return sourceService;
  const targetService = validateService(raw.targetService, "targetService", errorKind);
  if (!targetService.ok) return targetService;
  if (!isCanonicalAbsolutePath(raw.sourceDataDir)) {
    return invalid(errorKind, "sourceDataDir", "sourceDataDir is not a canonical absolute path");
  }
  if (!isCanonicalAbsolutePath(raw.targetDataDir)) {
    return invalid(errorKind, "targetDataDir", "targetDataDir is not a canonical absolute path");
  }
  if (
    !isCanonicalAbsolutePath(raw.targetPackageRoot) ||
    raw.targetPackageRoot !== targetRuntimeArtifact.value.packageRoot
  ) {
    return invalid(
      errorKind,
      "targetPackageRoot",
      "targetPackageRoot does not match the target runtime artifact",
    );
  }
  const coordinationRoot = "/var/lib/comis-self-driving/runtime-vault";
  const expectedTargetControlDir =
    `${coordinationRoot}/capture-${raw.runId}-${raw.attemptId}`;
  const expectedTargetIncomingRoot =
    `/opt/comis-replay/runtimes/sha256/.incoming-${raw.runId}-${raw.attemptId}-${runtimeTreeAttestation.value.digestSha256}`;
  const expectedTargetTransactionDir =
    `${coordinationRoot}/transactions/${raw.runId}-${raw.attemptId}`;
  for (const [field, value, expected] of [
    ["targetControlDir", raw.targetControlDir, expectedTargetControlDir],
    ["targetIncomingRoot", raw.targetIncomingRoot, expectedTargetIncomingRoot],
    ["targetTransactionDir", raw.targetTransactionDir, expectedTargetTransactionDir],
  ] as const) {
    if (!isCanonicalAbsolutePath(value) || value !== expected) {
      return invalid(
        errorKind,
        field,
        `${field} does not match the authenticated runtime-vault transaction`,
      );
    }
  }

  const sourceToolchainRecoveryDigestSha256 = validateRequiredDigest(
    raw.sourceToolchainRecoveryDigestSha256,
    "sourceToolchainRecoveryDigestSha256",
    errorKind,
  );
  if (!sourceToolchainRecoveryDigestSha256.ok) {
    return sourceToolchainRecoveryDigestSha256;
  }
  const targetToolchainRecoveryDigestSha256 = validateRequiredDigest(
    raw.targetToolchainRecoveryDigestSha256,
    "targetToolchainRecoveryDigestSha256",
    errorKind,
  );
  if (!targetToolchainRecoveryDigestSha256.ok) {
    return targetToolchainRecoveryDigestSha256;
  }
  const sourceServiceRecoveryDigestSha256 = validateRequiredDigest(
    raw.sourceServiceRecoveryDigestSha256,
    "sourceServiceRecoveryDigestSha256",
    errorKind,
  );
  if (!sourceServiceRecoveryDigestSha256.ok) {
    return sourceServiceRecoveryDigestSha256;
  }
  const targetServiceRecoveryDigestSha256 = validateRequiredDigest(
    raw.targetServiceRecoveryDigestSha256,
    "targetServiceRecoveryDigestSha256",
    errorKind,
  );
  if (!targetServiceRecoveryDigestSha256.ok) {
    return targetServiceRecoveryDigestSha256;
  }
  if (
    typeof raw.createdAtMs !== "number" ||
    !Number.isSafeInteger(raw.createdAtMs) ||
    raw.createdAtMs < 0 ||
    raw.createdAtMs > MAX_CREATED_AT_MS
  ) {
    return invalid(errorKind, "createdAtMs", "createdAtMs is not a bounded epoch timestamp");
  }

  return ok({
    schema: RECEIPT_SCHEMA,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    runId: raw.runId,
    attemptId: raw.attemptId,
    sourceMachineIdSha256: raw.sourceMachineIdSha256,
    targetMachineIdSha256: raw.targetMachineIdSha256,
    sourceRuntimeArtifact: sourceRuntimeArtifact.value,
    targetRuntimeArtifact: targetRuntimeArtifact.value,
    runtimeTreeAttestation: runtimeTreeAttestation.value,
    maximumArchiveBytes: raw.maximumArchiveBytes,
    payloadPath: raw.payloadPath,
    sourceService: sourceService.value,
    sourceDataDir: raw.sourceDataDir,
    targetService: targetService.value,
    targetDataDir: raw.targetDataDir,
    targetPackageRoot: raw.targetPackageRoot,
    targetControlDir: expectedTargetControlDir,
    targetIncomingRoot: expectedTargetIncomingRoot,
    targetTransactionDir: expectedTargetTransactionDir,
    sourceToolchainRecoveryDigestSha256:
      sourceToolchainRecoveryDigestSha256.value,
    targetToolchainRecoveryDigestSha256:
      targetToolchainRecoveryDigestSha256.value,
    sourceServiceRecoveryDigestSha256: sourceServiceRecoveryDigestSha256.value,
    targetServiceRecoveryDigestSha256: targetServiceRecoveryDigestSha256.value,
    createdAtMs: raw.createdAtMs,
  });
}

function validateSeal(
  raw: unknown,
): Result<ProductionRuntimeVaultRecoveryReceiptSeal, ProductionRuntimeVaultRecoveryReceiptError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, SEAL_KEYS) ||
    raw.algorithm !== RECEIPT_ALGORITHM ||
    raw.canonicalization !== RECEIPT_CANONICALIZATION ||
    typeof raw.authorityKeyIdSha256 !== "string" ||
    !SHA256_RE.test(raw.authorityKeyIdSha256) ||
    typeof raw.authorityDigestSha256 !== "string" ||
    !SHA256_RE.test(raw.authorityDigestSha256) ||
    typeof raw.authenticationTagSha256 !== "string" ||
    !SHA256_RE.test(raw.authenticationTagSha256)
  ) {
    return invalid("malformed_receipt", "seal", "Recovery receipt seal is malformed");
  }
  return ok({
    algorithm: RECEIPT_ALGORITHM,
    canonicalization: RECEIPT_CANONICALIZATION,
    authorityKeyIdSha256: raw.authorityKeyIdSha256,
    authorityDigestSha256: raw.authorityDigestSha256,
    authenticationTagSha256: raw.authenticationTagSha256,
  });
}

export function createProductionRuntimeVaultRecoveryReceipt(
  input: ProductionRuntimeVaultRecoveryReceiptInput,
  authorityKey: Uint8Array,
): Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultRecoveryReceiptError> {
  const validKey = validateAuthorityKey(authorityKey);
  if (!validKey.ok) return validKey;
  if (!isRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
    return invalid("invalid_request", "shape", "Recovery receipt input has unknown or missing fields");
  }
  const validated = validateUnsigned({ schema: RECEIPT_SCHEMA, ...input }, "invalid_request");
  if (!validated.ok) return validated;
  const canonicalUnsigned = canonicalJson(validated.value);
  return ok({
    ...validated.value,
    seal: {
      algorithm: RECEIPT_ALGORITHM,
      canonicalization: RECEIPT_CANONICALIZATION,
      authorityKeyIdSha256: authorityKeyId(validKey.value),
      authorityDigestSha256: authorityDigest(canonicalUnsigned),
      authenticationTagSha256: authenticationTag(canonicalUnsigned, validKey.value),
    },
  });
}

export function serializeProductionRuntimeVaultRecoveryReceipt(
  receipt: ProductionRuntimeVaultRecoveryReceipt,
): string {
  return `${canonicalJson(receipt)}\n`;
}

export function parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
  raw: string,
  authorityKey: Uint8Array,
): Result<ProductionRuntimeVaultRecoveryReceipt, ProductionRuntimeVaultRecoveryReceiptError> {
  const validKey = validateAuthorityKey(authorityKey);
  if (!validKey.ok) return validKey;
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_BYTES ||
    !raw.endsWith("\n") ||
    raw.slice(0, -1).includes("\n") ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return invalid("malformed_receipt", "envelope", "Recovery receipt envelope is not canonical");
  }
  const decoded = tryCatch(() => JSON.parse(raw.slice(0, -1)) as unknown);
  if (
    !decoded.ok ||
    !isRecord(decoded.value) ||
    !hasExactKeys(decoded.value, RECEIPT_KEYS) ||
    serializeProductionRuntimeVaultRecoveryReceipt(
      decoded.value as unknown as ProductionRuntimeVaultRecoveryReceipt,
    ) !== raw
  ) {
    return invalid(
      "malformed_receipt",
      "receipt",
      "Recovery receipt JSON is not the strict canonical encoding",
    );
  }

  const { seal: rawSeal, ...rawUnsigned } = decoded.value;
  const unsigned = validateUnsigned(rawUnsigned, "malformed_receipt");
  if (!unsigned.ok) return unsigned;
  const seal = validateSeal(rawSeal);
  if (!seal.ok) return seal;
  const canonicalUnsigned = canonicalJson(unsigned.value);
  const keyIdMatches = equalDigest(
    seal.value.authorityKeyIdSha256,
    authorityKeyId(validKey.value),
  );
  const authorityDigestMatches = equalDigest(
    seal.value.authorityDigestSha256,
    authorityDigest(canonicalUnsigned),
  );
  const authenticationTagMatches = equalDigest(
    seal.value.authenticationTagSha256,
    authenticationTag(canonicalUnsigned, validKey.value),
  );
  if (!keyIdMatches || !authorityDigestMatches || !authenticationTagMatches) {
    return authenticationFailed();
  }
  return ok({ ...unsigned.value, seal: seal.value });
}
