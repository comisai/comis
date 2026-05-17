// SPDX-License-Identifier: Apache-2.0
// Type-only port surface for OAuth credential persistence.
// PROFILE_ID_RE + validateProfileId live in ../security/profile-id.ts.
import type { Result } from "@comis/shared";

/**
 * Persisted OAuth profile shape.
 *
 * Maps to pi-ai's OAuthCredentials plus comis-managed metadata
 * (provider, profileId, identity claims). The expires field is
 * milliseconds since epoch (matches pi-ai — the JWT exp claim is
 * seconds, but pi-ai stores ms).
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
  /** Schema version. Currently always 1. Hard-fail on mismatch. */
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
