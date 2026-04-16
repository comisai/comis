import type { Result } from "@comis/shared";
import type { CredentialMapping } from "../domain/credential-mapping.js";

/**
 * CredentialMappingPort: Hexagonal architecture boundary for credential
 * mapping persistence.
 *
 * Every storage backend (SQLite, etc.) must implement this interface.
 * The port provides CRUD operations for credential mappings that bind
 * encrypted secrets to injection strategies.
 *
 * All operations are synchronous and return Result<T, Error> for explicit
 * error handling (same pattern as SecretStorePort).
 */
export interface CredentialMappingPort {
  /**
   * Store or update a credential mapping.
   *
   * Uses upsert semantics: if a mapping with the same `id` exists, it
   * is replaced entirely.
   *
   * @param mapping - The credential mapping to store
   * @returns void on success, Error on storage failure
   */
  set(mapping: CredentialMapping): Result<void, Error>;

  /**
   * Retrieve a credential mapping by its unique identifier.
   *
   * @param id - Mapping identifier to look up
   * @returns The mapping if found, undefined if not found, or Error on failure
   */
  get(id: string): Result<CredentialMapping | undefined, Error>;

  /**
   * List all credential mappings in the store.
   *
   * @returns Array of all mappings, or Error on failure
   */
  listAll(): Result<CredentialMapping[], Error>;

  /**
   * List credential mappings bound to a specific secret.
   *
   * @param secretName - Secret name to filter by
   * @returns Array of mappings referencing the given secret, or Error on failure
   */
  listBySecret(secretName: string): Result<CredentialMapping[], Error>;

  /**
   * List credential mappings restricted to a specific tool.
   *
   * Only returns mappings with a non-null `toolName` matching the given value.
   *
   * @param toolName - Tool name to filter by
   * @returns Array of mappings for the given tool, or Error on failure
   */
  listByTool(toolName: string): Result<CredentialMapping[], Error>;

  /**
   * Delete a credential mapping by its unique identifier.
   *
   * @param id - Mapping identifier to delete
   * @returns true if deleted, false if not found, or Error on failure
   */
  delete(id: string): Result<boolean, Error>;
}
