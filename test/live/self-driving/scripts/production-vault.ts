// SPDX-License-Identifier: Apache-2.0
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import {
  REPLAY_BUNDLE_BLOB_KINDS,
  type ReplayBundleBlobKind,
} from "./production-bundle.js";

export const PRODUCTION_VAULT_BLOB_BEGIN = "COMIS_PRODUCTION_VAULT_BLOB_V1_BEGIN";
export const PRODUCTION_VAULT_BLOB_END = "COMIS_PRODUCTION_VAULT_BLOB_V1_END";
export const MAX_PRODUCTION_VAULT_ENVELOPE_BYTES = 4096;

export interface ProductionVaultBlobEnvelope {
  readonly schema: "comis-production-vault-blob";
  readonly schemaVersion: 1;
  readonly format: "aes-256-gcm-detached-v1";
  readonly kind: ReplayBundleBlobKind;
  readonly plaintextDigestSha256: string;
  readonly plaintextBytes: number;
  readonly encryptionKeyIdSha256: string;
  readonly nonceBase64: string;
  readonly authenticationTagBase64: string;
}

export interface EncryptedProductionVaultBlob {
  /** Strict, bounded metadata. Ciphertext is deliberately not embedded in this envelope. */
  readonly envelope: string;
  readonly ciphertext: Uint8Array;
}

export interface DecryptedProductionVaultBlob {
  readonly kind: ReplayBundleBlobKind;
  readonly digestSha256: string;
  readonly bytes: number;
  readonly plaintext: Uint8Array;
}

export interface ProductionVaultStoragePath {
  readonly path: string;
  readonly ownerUid: 0;
  readonly mode: 0o700;
}

export interface ProductionVaultStorageFile {
  readonly name: "envelope" | "ciphertext";
  readonly path: string;
  readonly mode: 0o600;
  readonly create: "exclusive_nofollow";
}

export interface ProductionVaultStoragePlan {
  readonly requiredEffectiveUid: 0;
  readonly root: ProductionVaultStoragePath;
  readonly stagingDirectory: ProductionVaultStoragePath;
  readonly finalDirectory: ProductionVaultStoragePath;
  readonly files: readonly [ProductionVaultStorageFile, ProductionVaultStorageFile];
  readonly commit: readonly [
    "write_files",
    "fsync_files",
    "fsync_staging_directory",
    "rename_staging_directory",
    "fsync_root_directory",
  ];
}

export type ProductionVaultError =
  | {
      readonly kind: "invalid_key";
      readonly message: "Production vault key must contain exactly 32 bytes";
    }
  | {
      readonly kind: "invalid_blob";
      readonly field: "envelope" | "ciphertext" | "kind" | "plaintext";
      readonly message: string;
    }
  | {
      readonly kind: "authentication_failed";
      readonly message: "Production vault blob authentication failed";
    }
  | {
      readonly kind: "invalid_storage_plan";
      readonly field: "root" | "digest" | "transactionId";
      readonly message: string;
    };

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_TRANSACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const BLOB_KIND_VALUES = new Set<string>(REPLAY_BUNDLE_BLOB_KINDS);
const ENVELOPE_KEYS = [
  "schema",
  "schemaVersion",
  "format",
  "kind",
  "plaintextDigestSha256",
  "plaintextBytes",
  "encryptionKeyIdSha256",
  "nonceBase64",
  "authenticationTagBase64",
] as const;

function invalidKey(): Result<never, ProductionVaultError> {
  return err({
    kind: "invalid_key",
    message: "Production vault key must contain exactly 32 bytes",
  });
}

function invalidBlob(
  field: "envelope" | "ciphertext" | "kind" | "plaintext",
  message: string,
): Result<never, ProductionVaultError> {
  return err({ kind: "invalid_blob", field, message });
}

function authenticationFailed(): Result<never, ProductionVaultError> {
  return err({
    kind: "authentication_failed",
    message: "Production vault blob authentication failed",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function validKey(key: Uint8Array): key is Uint8Array {
  return key instanceof Uint8Array && key.byteLength === 32;
}

function equalHexDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeFixedBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== "string") return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) return null;
  return decoded;
}

function aadForEnvelope(
  envelope: Omit<ProductionVaultBlobEnvelope, "authenticationTagBase64">,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: envelope.schema,
      schemaVersion: envelope.schemaVersion,
      format: envelope.format,
      kind: envelope.kind,
      plaintextDigestSha256: envelope.plaintextDigestSha256,
      plaintextBytes: envelope.plaintextBytes,
      encryptionKeyIdSha256: envelope.encryptionKeyIdSha256,
      nonceBase64: envelope.nonceBase64,
    }),
    "utf8",
  );
}

function formatEnvelope(envelope: ProductionVaultBlobEnvelope): string {
  return `${PRODUCTION_VAULT_BLOB_BEGIN}\n${JSON.stringify(envelope)}\n${PRODUCTION_VAULT_BLOB_END}\n`;
}

export function productionVaultKeyIdSha256(
  key: Uint8Array,
): Result<string, ProductionVaultError> {
  if (!validKey(key)) return invalidKey();
  return ok(
    createHash("sha256")
      .update("comis-production-replay-vault-key-v1\0")
      .update(key)
      .digest("hex"),
  );
}

export function parseProductionVaultBlobEnvelope(
  raw: string,
): Result<ProductionVaultBlobEnvelope, ProductionVaultError> {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_PRODUCTION_VAULT_ENVELOPE_BYTES ||
    raw.includes("\r") ||
    raw.includes("\0")
  ) {
    return invalidBlob("envelope", "Production vault blob envelope is invalid");
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines.at(0) !== PRODUCTION_VAULT_BLOB_BEGIN ||
    lines.at(2) !== PRODUCTION_VAULT_BLOB_END
  ) {
    return invalidBlob("envelope", "Production vault blob envelope is invalid");
  }
  const decoded = tryCatch(() => JSON.parse(lines.at(1) as string) as unknown);
  if (!decoded.ok || !isRecord(decoded.value) || !hasExactKeys(decoded.value, ENVELOPE_KEYS)) {
    return invalidBlob("envelope", "Production vault blob envelope is invalid");
  }
  const value = decoded.value;
  if (
    value.schema !== "comis-production-vault-blob" ||
    value.schemaVersion !== 1 ||
    value.format !== "aes-256-gcm-detached-v1" ||
    typeof value.kind !== "string" ||
    !BLOB_KIND_VALUES.has(value.kind) ||
    typeof value.plaintextDigestSha256 !== "string" ||
    !SHA256_RE.test(value.plaintextDigestSha256) ||
    typeof value.plaintextBytes !== "number" ||
    !Number.isSafeInteger(value.plaintextBytes) ||
    value.plaintextBytes < 0 ||
    typeof value.encryptionKeyIdSha256 !== "string" ||
    !SHA256_RE.test(value.encryptionKeyIdSha256) ||
    decodeFixedBase64(value.nonceBase64, AES_GCM_NONCE_BYTES) === null ||
    decodeFixedBase64(value.authenticationTagBase64, AES_GCM_TAG_BYTES) === null
  ) {
    return invalidBlob("envelope", "Production vault blob envelope is invalid");
  }
  const envelope: ProductionVaultBlobEnvelope = {
    schema: "comis-production-vault-blob",
    schemaVersion: 1,
    format: "aes-256-gcm-detached-v1",
    kind: value.kind as ReplayBundleBlobKind,
    plaintextDigestSha256: value.plaintextDigestSha256,
    plaintextBytes: value.plaintextBytes,
    encryptionKeyIdSha256: value.encryptionKeyIdSha256,
    nonceBase64: value.nonceBase64 as string,
    authenticationTagBase64: value.authenticationTagBase64 as string,
  };
  if (lines.at(1) !== JSON.stringify(envelope)) {
    return invalidBlob("envelope", "Production vault blob envelope is not canonical");
  }
  return ok(envelope);
}

export function encryptProductionVaultBlob(
  kind: ReplayBundleBlobKind,
  plaintext: Uint8Array,
  key: Uint8Array,
): Result<EncryptedProductionVaultBlob, ProductionVaultError> {
  if (!validKey(key)) return invalidKey();
  if (!BLOB_KIND_VALUES.has(kind)) {
    return invalidBlob("kind", "Production vault blob kind is invalid");
  }
  if (!(plaintext instanceof Uint8Array)) {
    return invalidBlob("plaintext", "Production vault plaintext is invalid");
  }
  const keyId = productionVaultKeyIdSha256(key);
  if (!keyId.ok) return keyId;
  const attempted = tryCatch(() => {
    const nonce = randomBytes(AES_GCM_NONCE_BYTES);
    const header = {
      schema: "comis-production-vault-blob",
      schemaVersion: 1,
      format: "aes-256-gcm-detached-v1",
      kind,
      plaintextDigestSha256: sha256(plaintext),
      plaintextBytes: plaintext.byteLength,
      encryptionKeyIdSha256: keyId.value,
      nonceBase64: nonce.toString("base64"),
    } as const;
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(aadForEnvelope(header), { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: ProductionVaultBlobEnvelope = {
      ...header,
      authenticationTagBase64: cipher.getAuthTag().toString("base64"),
    };
    return { envelope: formatEnvelope(envelope), ciphertext };
  });
  if (!attempted.ok) return authenticationFailed();
  return ok(attempted.value);
}

export function decryptProductionVaultBlob(
  artifact: EncryptedProductionVaultBlob,
  key: Uint8Array,
): Result<DecryptedProductionVaultBlob, ProductionVaultError> {
  if (!validKey(key)) return invalidKey();
  if (!isRecord(artifact) || typeof artifact.envelope !== "string") {
    return invalidBlob("envelope", "Production vault blob artifact is invalid");
  }
  if (!(artifact.ciphertext instanceof Uint8Array)) {
    return invalidBlob("ciphertext", "Production vault ciphertext is invalid");
  }
  const parsed = parseProductionVaultBlobEnvelope(artifact.envelope);
  if (!parsed.ok) return parsed;
  const envelope = parsed.value;
  const keyId = productionVaultKeyIdSha256(key);
  if (!keyId.ok) return keyId;
  if (
    artifact.ciphertext.byteLength !== envelope.plaintextBytes ||
    !equalHexDigest(envelope.encryptionKeyIdSha256, keyId.value)
  ) {
    return authenticationFailed();
  }
  const nonce = decodeFixedBase64(envelope.nonceBase64, AES_GCM_NONCE_BYTES) as Buffer;
  const tag = decodeFixedBase64(envelope.authenticationTagBase64, AES_GCM_TAG_BYTES) as Buffer;
  const { authenticationTagBase64: _authenticationTagBase64, ...header } = envelope;
  const attempted = tryCatch(() => {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    decipher.setAAD(aadForEnvelope(header), { plaintextLength: envelope.plaintextBytes });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(artifact.ciphertext), decipher.final()]);
  });
  if (!attempted.ok) return authenticationFailed();
  const plaintextDigestSha256 = sha256(attempted.value);
  if (!equalHexDigest(envelope.plaintextDigestSha256, plaintextDigestSha256)) {
    return authenticationFailed();
  }
  return ok({
    kind: envelope.kind,
    digestSha256: plaintextDigestSha256,
    bytes: attempted.value.byteLength,
    plaintext: attempted.value,
  });
}

export function buildProductionVaultStoragePlan(
  root: string,
  digestSha256: string,
  transactionId: string,
): Result<ProductionVaultStoragePlan, ProductionVaultError> {
  if (
    !isAbsolute(root) ||
    root === "/" ||
    normalize(root) !== root ||
    /[\0\r\n]/u.test(root)
  ) {
    return err({
      kind: "invalid_storage_plan",
      field: "root",
      message: "Production vault storage root is unsafe",
    });
  }
  if (!SHA256_RE.test(digestSha256)) {
    return err({
      kind: "invalid_storage_plan",
      field: "digest",
      message: "Production vault storage digest is invalid",
    });
  }
  if (!SAFE_TRANSACTION_ID_RE.test(transactionId)) {
    return err({
      kind: "invalid_storage_plan",
      field: "transactionId",
      message: "Production vault storage transaction identifier is invalid",
    });
  }
  const stagingDirectory = resolve(root, `.${digestSha256}.${transactionId}.tmp`);
  const finalDirectory = resolve(root, digestSha256);
  return ok({
    requiredEffectiveUid: 0,
    root: { path: root, ownerUid: 0, mode: 0o700 },
    stagingDirectory: { path: stagingDirectory, ownerUid: 0, mode: 0o700 },
    finalDirectory: { path: finalDirectory, ownerUid: 0, mode: 0o700 },
    files: [
      {
        name: "envelope",
        path: resolve(stagingDirectory, "envelope"),
        mode: 0o600,
        create: "exclusive_nofollow",
      },
      {
        name: "ciphertext",
        path: resolve(stagingDirectory, "ciphertext"),
        mode: 0o600,
        create: "exclusive_nofollow",
      },
    ],
    commit: [
      "write_files",
      "fsync_files",
      "fsync_staging_directory",
      "rename_staging_directory",
      "fsync_root_directory",
    ],
  });
}
