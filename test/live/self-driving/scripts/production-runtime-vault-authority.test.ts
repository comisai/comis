import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RuntimeArtifactAttestation } from "./production-runtime.js";
import type { RuntimeTreeAttestation } from "./production-runtime-tree.js";
import {
  createProductionRuntimeVaultRecoveryReceipt,
  parseAndVerifyProductionRuntimeVaultRecoveryReceipt,
  serializeProductionRuntimeVaultRecoveryReceipt,
  type ProductionRuntimeVaultRecoveryReceiptInput,
} from "./production-runtime-vault-authority.js";

const AUTHORITY_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const sourceRuntimeArtifact: RuntimeArtifactAttestation = {
  digestSha256: "a".repeat(64),
  entryCount: 84_161,
  bytes: 3_269_438_185,
  packageRoot: "/opt/source/node_modules/comisai",
  version: "1.0.53",
  osId: "ubuntu",
  osVersion: "24.04",
  architecture: "x86_64",
  kernelRelease: "6.8.0-71-generic",
  libcKind: "glibc",
  libcVersion: "2.39",
  nodeVersion: "22.17.1",
  nodeAbi: "127",
  timezone: "Asia/Jerusalem",
  tzdataSha256: "b".repeat(64),
  launcherKind: "systemd",
  applicationLauncherSha256: "c".repeat(64),
  confinementKind: "source",
  confinementSha256: "none",
  browserStatus: "available",
  browserSha256: "d".repeat(64),
  mediaStatus: "available",
  mediaSha256: "e".repeat(64),
  nativeToolsStatus: "available",
  nativeToolsSha256: "f".repeat(64),
};

const targetRuntimeArtifact: RuntimeArtifactAttestation = {
  ...sourceRuntimeArtifact,
  digestSha256: "1".repeat(64),
  entryCount: 84_170,
  bytes: 3_269_453_213,
  packageRoot: "/opt/target/node_modules/comisai",
  version: "1.1.0",
  kernelRelease: "6.8.0-72-generic",
  nodeAbi: "128",
  timezone: "Etc/UTC",
  confinementKind: "target_quarantine",
  confinementSha256: "2".repeat(64),
};

const runtimeTreeAttestation: RuntimeTreeAttestation = {
  digestSha256: "3".repeat(64),
  entryCount: 91_456,
  bytes: sourceRuntimeArtifact.bytes,
  root: sourceRuntimeArtifact.packageRoot,
  version: sourceRuntimeArtifact.version,
};

const input: ProductionRuntimeVaultRecoveryReceiptInput = {
  schemaVersion: 1,
  runId: "runtime-vault-a1",
  attemptId: "4".repeat(32),
  sourceMachineIdSha256: "5".repeat(64),
  targetMachineIdSha256: "6".repeat(64),
  sourceRuntimeArtifact,
  targetRuntimeArtifact,
  runtimeTreeAttestation,
  maximumArchiveBytes:
    runtimeTreeAttestation.bytes +
    runtimeTreeAttestation.entryCount * 16_384 +
    128 * 1024 * 1024,
  payloadPath: `/opt/comis-replay/runtimes/sha256/${runtimeTreeAttestation.digestSha256}/payload`,
  sourceService: "comis-source.service",
  sourceDataDir: "/srv/source/.comis",
  targetService: "comis-target.service",
  targetDataDir: "/srv/target/.comis",
  targetPackageRoot: targetRuntimeArtifact.packageRoot,
  targetControlDir: `/var/lib/comis-self-driving/runtime-vault/capture-runtime-vault-a1-${"4".repeat(32)}`,
  targetIncomingRoot: `/opt/comis-replay/runtimes/sha256/.incoming-runtime-vault-a1-${"4".repeat(32)}-${runtimeTreeAttestation.digestSha256}`,
  targetTransactionDir: `/var/lib/comis-self-driving/runtime-vault/transactions/runtime-vault-a1-${"4".repeat(32)}`,
  sourceToolchainRecoveryDigestSha256: "7".repeat(64),
  targetToolchainRecoveryDigestSha256: "8".repeat(64),
  sourceServiceRecoveryDigestSha256: "9".repeat(64),
  targetServiceRecoveryDigestSha256: "0".repeat(64),
  createdAtMs: 1_752_560_123_456,
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported test JSON value");
}

function sha256(...values: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest("hex");
}

describe("production runtime vault recovery receipt authority", () => {
  it("creates and verifies a canonical receipt that binds every recovery authority fact", () => {
    const created = createProductionRuntimeVaultRecoveryReceipt(input, AUTHORITY_KEY);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const receipt = created.value;
    const { seal, ...unsigned } = receipt;
    const canonicalUnsigned = canonicalJson(unsigned);
    expect(receipt).toMatchObject({
      schema: "comis-runtime-vault-recovery-receipt",
      ...input,
      seal: {
        algorithm: "hmac-sha256",
        canonicalization: "comis-json-c14n-v1",
      },
    });
    expect(seal.authorityKeyIdSha256).toBe(
      sha256("comis-runtime-vault-recovery-authority-key-v1\0", AUTHORITY_KEY),
    );
    expect(seal.authorityDigestSha256).toBe(
      sha256("comis-runtime-vault-recovery-authority-v1\0", canonicalUnsigned),
    );
    expect(seal.authenticationTagSha256).toBe(
      createHmac("sha256", AUTHORITY_KEY)
        .update("comis-runtime-vault-recovery-receipt-hmac-v1\0")
        .update(canonicalUnsigned)
        .digest("hex"),
    );

    const serialized = serializeProductionRuntimeVaultRecoveryReceipt(receipt);
    expect(serialized).toBe(`${canonicalJson(receipt)}\n`);
    expect(serialized).not.toContain(Buffer.from(AUTHORITY_KEY).toString("hex"));
    expect(serialized).not.toContain(Buffer.from(AUTHORITY_KEY).toString("base64"));

    const verified = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
      serialized,
      AUTHORITY_KEY,
    );
    expect(verified).toEqual({ ok: true, value: receipt });
  });

  it("rejects tampering across nested attestations, paths, digests, and timestamps", () => {
    const created = createProductionRuntimeVaultRecoveryReceipt(input, AUTHORITY_KEY);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        value.createdAtMs = input.createdAtMs + 1;
      },
      (value) => {
        value.payloadPath = "/opt/comis-replay/runtimes/sha256/decoy/payload";
      },
      (value) => {
        value.targetToolchainRecoveryDigestSha256 = "a".repeat(64);
      },
      (value) => {
        value.sourceService = "different-source.service";
      },
      (value) => {
        const artifact = value.sourceRuntimeArtifact as Record<string, unknown>;
        artifact.nodeAbi = "128";
      },
      (value) => {
        const tree = value.runtimeTreeAttestation as Record<string, unknown>;
        tree.entryCount = runtimeTreeAttestation.entryCount + 1;
      },
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(created.value) as unknown as Record<string, unknown>;
      mutate(candidate);
      const verified = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
        `${canonicalJson(candidate)}\n`,
        AUTHORITY_KEY,
      );
      expect(verified.ok).toBe(false);
    }
  });

  it("rejects short or wrong keys without placing key material in errors", () => {
    const shortKey = new Uint8Array(31).fill(0xab);
    const rejected = createProductionRuntimeVaultRecoveryReceipt(input, shortKey);
    expect(rejected).toMatchObject({
      ok: false,
      error: { kind: "invalid_authority_key" },
    });
    expect(JSON.stringify(rejected)).not.toContain(Buffer.from(shortKey).toString("hex"));

    const created = createProductionRuntimeVaultRecoveryReceipt(input, AUTHORITY_KEY);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const wrongKey = new Uint8Array(32).fill(0xcd);
    const verified = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
      serializeProductionRuntimeVaultRecoveryReceipt(created.value),
      wrongKey,
    );
    expect(verified).toMatchObject({
      ok: false,
      error: { kind: "authentication_failed" },
    });
    expect(JSON.stringify(verified)).not.toContain(Buffer.from(wrongKey).toString("hex"));
  });

  it("rejects malformed authority facts before sealing", () => {
    const invalidInputs = [
      { ...input, schemaVersion: 2 },
      { ...input, attemptId: "not-random-hex" },
      { ...input, targetMachineIdSha256: input.sourceMachineIdSha256 },
      { ...input, maximumArchiveBytes: runtimeTreeAttestation.bytes - 1 },
      { ...input, maximumArchiveBytes: input.maximumArchiveBytes + 1 },
      { ...input, targetPackageRoot: "/opt/decoy/node_modules/comisai" },
      { ...input, sourceDataDir: "relative/source" },
      { ...input, targetControlDir: "/var/lib/comis-self-driving/runtime-vault/other" },
      { ...input, targetIncomingRoot: "/opt/comis-replay/runtimes/sha256/.incoming-decoy" },
      { ...input, targetTransactionDir: "/var/lib/comis-self-driving/runtime-vault/transactions/decoy" },
      { ...input, createdAtMs: -1 },
      { ...input, unknown: true },
    ];

    for (const candidate of invalidInputs) {
      const created = createProductionRuntimeVaultRecoveryReceipt(
        candidate as unknown as ProductionRuntimeVaultRecoveryReceiptInput,
        AUTHORITY_KEY,
      );
      expect(created.ok).toBe(false);
    }
  });

  it("rejects duplicate, unknown, non-canonical, and oversized JSON before authentication", () => {
    const created = createProductionRuntimeVaultRecoveryReceipt(input, AUTHORITY_KEY);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const canonical = serializeProductionRuntimeVaultRecoveryReceipt(created.value);
    const duplicate = canonical.replace(
      '"attemptId":',
      `"attemptId":"${input.attemptId}","attemptId":`,
    );
    const unknown = JSON.parse(canonical) as Record<string, unknown>;
    unknown.unexpected = true;

    for (const candidate of [
      duplicate,
      `${canonicalJson(unknown)}\n`,
      ` ${canonical}`,
      canonical.slice(0, -1),
      `${" ".repeat(65_537)}\n`,
    ]) {
      const verified = parseAndVerifyProductionRuntimeVaultRecoveryReceipt(
        candidate,
        AUTHORITY_KEY,
      );
      expect(verified.ok).toBe(false);
    }
  });
});
