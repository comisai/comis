import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCTION_VAULT_ENVELOPE_BYTES,
  PRODUCTION_VAULT_BLOB_BEGIN,
  PRODUCTION_VAULT_BLOB_END,
  buildProductionVaultStoragePlan,
  decryptProductionVaultBlob,
  encryptProductionVaultBlob,
  parseProductionVaultBlobEnvelope,
  productionVaultKeyIdSha256,
  type EncryptedProductionVaultBlob,
} from "./production-vault.js";

const VAULT_KEY = Buffer.alloc(32, 17);
const PRIVATE_BODY = Buffer.from("PRIVATE_USER_PROMPT\nPRIVATE_TOKEN_VALUE", "utf8");

function keyId(key: Uint8Array): string {
  const result = productionVaultKeyIdSha256(key);
  if (!result.ok) throw new Error("test vault key fixture is invalid");
  return result.value;
}

function mutateEnvelope(
  artifact: EncryptedProductionVaultBlob,
  mutate: (value: Record<string, unknown>) => void,
): EncryptedProductionVaultBlob {
  const lines = artifact.envelope.trimEnd().split("\n");
  const value = JSON.parse(lines[1] as string) as Record<string, unknown>;
  mutate(value);
  return {
    envelope: `${PRODUCTION_VAULT_BLOB_BEGIN}\n${JSON.stringify(value)}\n${PRODUCTION_VAULT_BLOB_END}\n`,
    ciphertext: artifact.ciphertext,
  };
}

describe("production replay encrypted vault", () => {
  it("encrypts a content-addressed blob with detached authenticated metadata", () => {
    const encrypted = encryptProductionVaultBlob("canonical_transcript", PRIVATE_BODY, VAULT_KEY);

    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;
    expect(encrypted.value.envelope).not.toContain("PRIVATE_USER_PROMPT");
    expect(encrypted.value.envelope).not.toContain("PRIVATE_TOKEN_VALUE");
    expect(encrypted.value.ciphertext).not.toEqual(PRIVATE_BODY);

    const parsed = parseProductionVaultBlobEnvelope(encrypted.value.envelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      format: "aes-256-gcm-detached-v1",
      kind: "canonical_transcript",
      plaintextBytes: PRIVATE_BODY.byteLength,
      plaintextDigestSha256: createHash("sha256").update(PRIVATE_BODY).digest("hex"),
      encryptionKeyIdSha256: keyId(VAULT_KEY),
    });

    const decrypted = decryptProductionVaultBlob(encrypted.value, VAULT_KEY);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) return;
    expect(decrypted.value.plaintext).toEqual(PRIVATE_BODY);
    expect(decrypted.value.kind).toBe("canonical_transcript");
  });

  it("rejects every authenticated component mutation and a wrong key without reflecting content", () => {
    const encrypted = encryptProductionVaultBlob("cassette_request", PRIVATE_BODY, VAULT_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    const corruptCiphertext = {
      ...encrypted.value,
      ciphertext: Buffer.from(encrypted.value.ciphertext),
    };
    corruptCiphertext.ciphertext[0] ^= 1;
    const corruptNonce = mutateEnvelope(encrypted.value, (value) => {
      value.nonceBase64 = Buffer.alloc(12, 4).toString("base64");
    });
    const corruptTag = mutateEnvelope(encrypted.value, (value) => {
      value.authenticationTagBase64 = Buffer.alloc(16, 5).toString("base64");
    });
    const corruptDigest = mutateEnvelope(encrypted.value, (value) => {
      value.plaintextDigestSha256 = "f".repeat(64);
    });

    const results = [
      decryptProductionVaultBlob(corruptCiphertext, VAULT_KEY),
      decryptProductionVaultBlob(corruptNonce, VAULT_KEY),
      decryptProductionVaultBlob(corruptTag, VAULT_KEY),
      decryptProductionVaultBlob(corruptDigest, VAULT_KEY),
      decryptProductionVaultBlob(encrypted.value, Buffer.alloc(32, 18)),
    ];

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { kind: "authentication_failed" } });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_USER_PROMPT");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN_VALUE");
    }
  });

  it("accepts only an exact canonical bounded envelope and a 32-byte caller key", () => {
    expect(encryptProductionVaultBlob("state_archive", Buffer.from("x"), Buffer.alloc(31)).ok).toBe(
      false,
    );
    expect(encryptProductionVaultBlob("state_archive", Buffer.from("x"), Buffer.alloc(33)).ok).toBe(
      false,
    );
    expect(productionVaultKeyIdSha256(Buffer.alloc(31)).ok).toBe(false);
    expect(
      parseProductionVaultBlobEnvelope("x".repeat(MAX_PRODUCTION_VAULT_ENVELOPE_BYTES + 1)).ok,
    ).toBe(false);

    const encrypted = encryptProductionVaultBlob("state_archive", Buffer.from("x"), VAULT_KEY);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;
    const unknownField = mutateEnvelope(encrypted.value, (value) => {
      value.inlineBody = "PRIVATE_USER_PROMPT";
    });
    const result = parseProductionVaultBlobEnvelope(unknownField.envelope);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_USER_PROMPT");
    expect(parseProductionVaultBlobEnvelope(encrypted.value.envelope.replace("\n", "\r\n")).ok).toBe(
      false,
    );

    const lines = encrypted.value.envelope.trimEnd().split("\n");
    const original = JSON.parse(lines[1] as string) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(
      parseProductionVaultBlobEnvelope(
        `${PRODUCTION_VAULT_BLOB_BEGIN}\n${JSON.stringify(reordered)}\n${PRODUCTION_VAULT_BLOB_END}\n`,
      ).ok,
    ).toBe(false);
  });

  it("plans a root-owned atomic directory promotion with private files", () => {
    const digest = "a".repeat(64);
    const planned = buildProductionVaultStoragePlan(
      "/var/lib/comis-replay-vault",
      digest,
      "capture-20260715-a",
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toMatchObject({
      requiredEffectiveUid: 0,
      root: { path: "/var/lib/comis-replay-vault", ownerUid: 0, mode: 0o700 },
      stagingDirectory: { ownerUid: 0, mode: 0o700 },
      finalDirectory: {
        path: `/var/lib/comis-replay-vault/${digest}`,
        ownerUid: 0,
        mode: 0o700,
      },
      files: [
        { name: "envelope", mode: 0o600, create: "exclusive_nofollow" },
        { name: "ciphertext", mode: 0o600, create: "exclusive_nofollow" },
      ],
      commit: [
        "write_files",
        "fsync_files",
        "fsync_staging_directory",
        "rename_staging_directory",
        "fsync_root_directory",
      ],
    });
    expect(buildProductionVaultStoragePlan("relative", digest, "capture-a").ok).toBe(false);
    expect(buildProductionVaultStoragePlan("/", digest, "capture-a").ok).toBe(false);
    expect(buildProductionVaultStoragePlan("/safe/../escape", digest, "capture-a").ok).toBe(false);
    expect(buildProductionVaultStoragePlan("/safe", digest, "../escape").ok).toBe(false);
  });
});
