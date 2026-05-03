// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Persisted OAuth profile shape.
 *
 * Maps to pi-ai's OAuthCredentials plus comis-managed metadata
 * (provider, profileId, identity claims). The expires field is
 * milliseconds since epoch (matches pi-ai per RESEARCH Q1 landmine 4 —
 * the JWT exp claim is seconds, but pi-ai stores ms).
 */
export interface OAuthProfile {
  /** OAuth provider id (e.g. "openai-codex", "anthropic"). */
  provider: string;
  /** Canonical profile identifier in the form "<provider>:<identity>". */
  profileId: string;
  /** OAuth access token (JWT for OpenAI Codex). NEVER log this value. */
  access: string;
  /** OAuth refresh token. NEVER log this value. */
  refresh: string;
  /** Access-token expiry in ms since epoch. */
  expires: number;
  /** Provider-specific account identifier (e.g. Codex chatgpt_account_id). */
  accountId?: string;
  /** Identity email (when JWT decode produced one). */
  email?: string;
  /** Human-friendly display name (when available). */
  displayName?: string;
  /** Schema version. Currently always 1. Hard-fail on mismatch (D-07). */
  version: 1;
}

/**
 * OAuthCredentialStorePort: Hexagonal architecture boundary for mutable
 * OAuth credential persistence.
 *
 * Distinct from SecretStorePort (which is read-only). Every storage
 * backend (file-based, encrypted SQLite) implements this interface.
 *
 * All operations are asynchronous and return Result<T, Error> for
 * explicit error handling — never throw at the public boundary.
 */
export interface OAuthCredentialStorePort {
  get(profileId: string): Promise<Result<OAuthProfile | undefined, Error>>;
  set(profileId: string, profile: OAuthProfile): Promise<Result<void, Error>>;
  delete(profileId: string): Promise<Result<boolean, Error>>;
  list(filter?: { provider?: string }): Promise<Result<OAuthProfile[], Error>>;
  has(profileId: string): Promise<Result<boolean, Error>>;
}

/**
 * Profile-ID format regex: <provider>:<identity>.
 * Provider must start with letter; alphanumeric + hyphen only.
 * Identity is non-empty and may contain @, ., etc.
 */
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]*:.+$/i;

/**
 * Validate a profile-ID string against the <provider>:<identity> shape.
 * Returns parsed parts on success; an Error describing the violation otherwise.
 * Defense-in-depth: also rejects identities containing path-traversal or
 * control characters (newline, null, slash, backslash, ..).
 */
export function validateProfileId(
  id: string,
): Result<{ provider: string; identity: string }, Error> {
  if (typeof id !== "string" || id.length === 0) {
    return err(new Error("Invalid profile ID: empty or non-string"));
  }
  if (!PROFILE_ID_RE.test(id)) {
    return err(new Error('Invalid profile ID "' + id + '": expected "<provider>:<identity>"'));
  }
  const colonIdx = id.indexOf(":");
  const provider = id.slice(0, colonIdx);
  const identity = id.slice(colonIdx + 1);
  if (!provider) return err(new Error('Invalid profile ID "' + id + '": empty provider'));
  if (!identity) return err(new Error('Invalid profile ID "' + id + '": empty identity'));
  if (
    identity.includes("\0") ||
    identity.includes("\n") ||
    identity.includes("\r") ||
    identity.includes("..") ||
    identity.includes("/") ||
    identity.includes("\\")
  ) {
    return err(new Error('Invalid profile ID "' + id + '": identity contains forbidden characters'));
  }
  return ok({ provider, identity });
}
