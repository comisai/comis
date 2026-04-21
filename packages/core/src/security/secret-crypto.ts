// SPDX-License-Identifier: Apache-2.0
/**
 * SecretsCrypto — AES-256-GCM encryption engine with HKDF-SHA256 key derivation.
 *
 * Pure cryptographic primitives for encrypting/decrypting secret values.
 * Has zero knowledge of storage — takes Buffers in, returns Buffers out.
 * Storage encoding (base64/hex) happens at the adapter boundary.
 *
 * Key derivation uses HKDF with a per-encryption random salt and a versioned
 * info string ("comis-secrets-v1") to allow future crypto upgrades without
 * breaking existing encrypted data.
 */

import {
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { Result } from "@comis/shared";
import { tryCatch } from "@comis/shared";

/** HKDF info string — versioned to allow future crypto upgrades. */
const HKDF_INFO = "comis-secrets-v1";

/**
 * Encrypted secret payload with all components needed for decryption.
 * All fields are independent Buffer copies (no shared memory references).
 */
export interface EncryptedSecret {
  /** AES-256-GCM ciphertext */
  readonly ciphertext: Buffer;
  /** 12-byte initialization vector (AES-GCM standard nonce size) */
  readonly iv: Buffer;
  /** 16-byte GCM authentication tag */
  readonly authTag: Buffer;
  /** 32-byte random salt for HKDF key derivation */
  readonly salt: Buffer;
}

/**
 * Synchronous encrypt/decrypt interface for secret values.
 * All operations return Result<T, Error> — never throw.
 */
export interface SecretsCrypto {
  encrypt(plaintext: string): Result<EncryptedSecret, Error>;
  decrypt(encrypted: EncryptedSecret): Result<string, Error>;
}

/**
 * Create a SecretsCrypto engine with the given master key.
 *
 * @param masterKey - Must be at least 32 bytes. Only the first 32 bytes are used.
 * @throws Error if masterKey is shorter than 32 bytes (fail-fast at creation, not per-call)
 */
export function createSecretsCrypto(masterKey: Buffer): SecretsCrypto {
  if (masterKey.length < 32) {
    throw new Error("Master key must be at least 32 bytes");
  }
  const key = Buffer.from(masterKey.subarray(0, 32));

  return {
    encrypt(plaintext: string): Result<EncryptedSecret, Error> {
      return tryCatch(() => {
        const salt = randomBytes(32);
        const derivedKey = Buffer.from(
          hkdfSync("sha256", key, salt, HKDF_INFO, 32),
        );
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
        const ciphertext = Buffer.concat([
          cipher.update(plaintext, "utf8"),
          cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();
        return { ciphertext, iv, authTag, salt };
      });
    },

    decrypt(encrypted: EncryptedSecret): Result<string, Error> {
      return tryCatch(() => {
        const derivedKey = Buffer.from(
          hkdfSync("sha256", key, encrypted.salt, HKDF_INFO, 32),
        );
        const decipher = createDecipheriv(
          "aes-256-gcm",
          derivedKey,
          encrypted.iv,
        );
        decipher.setAuthTag(encrypted.authTag);
        return Buffer.concat([
          decipher.update(encrypted.ciphertext),
          decipher.final(),
        ]).toString("utf8");
      });
    },
  };
}

/**
 * Parse a master key from a hex or base64 encoded string.
 *
 * Tries hex decoding first (64+ chars = 32+ bytes), then base64 (44+ chars = 32+ bytes).
 * Validates that the decoded result is at least 32 bytes.
 *
 * @param raw - Hex string (64+ chars) or base64 string (44+ chars)
 * @returns Buffer of at least 32 bytes
 * @throws Error if neither encoding produces >= 32 bytes
 */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();

  // Try hex first: must be even length and produce >= 32 bytes
  if (trimmed.length >= 64 && trimmed.length % 2 === 0) {
    const hexBuf = Buffer.from(trimmed, "hex");
    // Buffer.from(str, "hex") silently ignores invalid chars and may produce
    // shorter output. Verify we got the expected length.
    if (hexBuf.length >= 32 && hexBuf.length === trimmed.length / 2) {
      return hexBuf;
    }
  }

  // Try base64
  const b64Buf = Buffer.from(trimmed, "base64");
  if (b64Buf.length >= 32) {
    return b64Buf;
  }

  throw new Error(
    "Master key must be at least 32 bytes (64 hex chars or 44+ base64 chars)",
  );
}
