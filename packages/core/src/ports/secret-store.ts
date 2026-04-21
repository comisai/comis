// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * Metadata about a stored secret (returned by list operations).
 *
 * Does not contain the secret value itself -- use `getDecrypted()` to access plaintext.
 */
export interface SecretMetadata {
  /** Secret name (unique identifier within the store) */
  name: string;
  /** Provider this secret belongs to (e.g. "openai", "anthropic") */
  provider?: string;
  /** Human-readable description of the secret's purpose */
  description?: string;
  /** Unix timestamp (ms) when this secret expires, or undefined if no expiry */
  expiresAt?: number;
  /** Unix timestamp (ms) of the most recent decryption/access */
  lastUsedAt?: number;
  /** Number of times this secret has been accessed via getDecrypted() */
  usageCount: number;
  /** Unix timestamp (ms) when the secret was first stored */
  createdAt: number;
  /** Unix timestamp (ms) when the secret was last updated */
  updatedAt: number;
}

/**
 * SecretStorePort: Hexagonal architecture boundary for encrypted secret storage.
 *
 * Every secret storage backend (SQLite + AES-256-GCM, etc.) must implement this
 * interface. The port handles encryption/decryption transparently -- callers
 * provide plaintext and receive plaintext; ciphertext never leaves the adapter.
 *
 * Design note: `getDecrypted()` returns `Result<string | undefined, Error>`
 * rather than `string | undefined` because decryption failure (wrong key,
 * corrupted data) must be distinguishable from "secret not found". A plain
 * `undefined` return would conflate these two cases.
 *
 * All operations are synchronous (eager-decrypt-at-boot pattern) to preserve
 * the existing sync SecretManager interface.
 */
export interface SecretStorePort {
  /**
   * Store or update an encrypted secret.
   *
   * @param name - Unique secret identifier
   * @param plaintext - Secret value (will be encrypted before storage)
   * @param opts - Optional metadata (provider, description, expiry)
   * @returns void on success, Error on encryption or storage failure
   */
  set(
    name: string,
    plaintext: string,
    opts?: { provider?: string; description?: string; expiresAt?: number },
  ): Result<void, Error>;

  /**
   * Retrieve and decrypt a secret by name.
   *
   * Returns `undefined` inside the Result when the secret does not exist.
   * Returns an Error when decryption fails (wrong key, corrupted data).
   *
   * @param name - Secret identifier to look up
   * @returns Decrypted plaintext, undefined if not found, or Error on failure
   */
  getDecrypted(name: string): Result<string | undefined, Error>;

  /**
   * Decrypt and return all secrets as a name-to-plaintext map.
   *
   * Used during boot to eagerly populate the in-memory SecretManager.
   *
   * @returns Map of all secret names to their decrypted values, or Error
   */
  decryptAll(): Result<Map<string, string>, Error>;

  /**
   * Check whether a secret exists (without decrypting).
   *
   * @param name - Secret identifier to check
   * @returns true if the secret exists in the store
   */
  exists(name: string): boolean;

  /**
   * List metadata for all stored secrets (without decrypting values).
   *
   * @returns Array of secret metadata, or Error on storage failure
   */
  list(): Result<SecretMetadata[], Error>;

  /**
   * Delete a secret from the store.
   *
   * @param name - Secret identifier to delete
   * @returns true if deleted, false if not found, or Error on storage failure
   */
  delete(name: string): Result<boolean, Error>;

  /**
   * Record that a secret was accessed (increments usageCount, updates lastUsedAt).
   *
   * Called by the runtime after successful secret injection into agent context.
   *
   * @param name - Secret identifier that was used
   */
  recordUsage(name: string): void;

  /**
   * Release resources (close database connections, clear caches).
   *
   * Called during graceful shutdown.
   */
  close(): void;
}
