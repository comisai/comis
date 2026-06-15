// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth Token Manager — public TYPE contracts.
 *
 * Types-only module: the heavyweight runtime implementation
 * (`createOAuthTokenManager`) stays in `@comis/agent` because it carries
 * deep runtime deps (`chokidar` for file-watcher, `@earendil-works/pi-ai`
 * for OAuth provider operations) that are out of scope for `@comis/core`.
 * Only the daemon constructs OAuthTokenManager; CLI consumers only
 * reference the `OAuthError` interface for pattern-matching on
 * refresh-failure causes (`err.errorKind === "refresh_token_reused"`
 * in cli/src/commands/auth.ts).
 *
 * Both `OAuthCredentials` and `OAuthTokenManager` interfaces preserve the
 * agent-side shape verbatim — the agent's implementation file imports
 * pi-ai's `OAuthCredentials` directly. To avoid pulling pi-ai into core's
 * dependency tree the structural `OAuthCredentials` alias here matches
 * pi-ai 0.71's exported type byte-for-byte; structural assignability
 * keeps the agent's daemon-side wiring intact.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import type { SecretManager } from "../security/secret-manager.js";
import type { TypedEventBus } from "../event-bus/bus.js";
import type { ComisLogger } from "../logging/log-fields.js";
import type { OAuthCredentialStorePort } from "../ports/oauth-credential-store.js";
import type { FileLockPort } from "../ports/file-lock.js";

/**
 * Pi-ai's `OAuthCredentials` shape, mirrored structurally so that core does
 * not depend on `@earendil-works/pi-ai`. Pi-ai 0.71 exports the type as:
 *   export type OAuthCredentials = {
 *     refresh: string;
 *     access: string;
 *     expires: number;
 *     [key: string]: unknown;
 *   };
 * TypeScript structural compatibility means an `OAuthCredentials` from pi-ai
 * is assignable to this alias and vice versa. Daemon-side `OAuthTokenManager`
 * implementations keep importing the pi-ai type directly; the agent-side
 * `OAuthTokenManager` interface relies on structural conformance.
 */
export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

/**
 * Error codes returned by OAuthTokenManager operations.
 *
 * Extended with `errorKind`, `profileId`, `hint` (all optional) so CLI
 * consumers can pattern-match on `errorKind === "refresh_token_reused"`
 * without breaking existing consumers that only read `code` + `message` +
 * `providerId`.
 */
export interface OAuthError {
  code:
    | "NO_PROVIDER"
    | "NO_CREDENTIALS"
    | "REFRESH_FAILED"
    | "STORE_FAILED"
    | "PROFILE_NOT_FOUND";
  message: string;
  providerId: string;
  /** Free-form classification (e.g. "refresh_token_reused", "invalid_grant", "timeout"). */
  errorKind?: string;
  /** Profile that failed (mirrors auth:refresh_failed event payload field). */
  profileId?: string;
  /** Operator action recommendation; mirrors the WARN log `hint` field. */
  hint?: string;
}

/** Dependencies injected into the OAuth token manager factory. */
export interface OAuthTokenManagerDeps {
  /** SecretManager for env-var bootstrap and conflict detection. */
  secretManager: SecretManager;
  /** EventBus for emitting auth events (3 typed events: token_rotated, profile_bootstrapped, refresh_failed). */
  eventBus: TypedEventBus;
  /** Credential store for persistent refresh — REQUIRED. */
  credentialStore: OAuthCredentialStorePort;
  /** Logger for log events — REQUIRED. */
  logger: ComisLogger;
  /** Data directory for lock-file path resolution — REQUIRED. */
  dataDir: string;
  /**
   * Cross-process filesystem mutex for per-profile refresh serialization.
   * Injected by the composition root (`@comis/core`'s `createFileLock()` in
   * production). Stateless port — sharing one instance across token managers
   * is safe.
   */
  fileLock: FileLockPort;
  /** Prefix for SecretManager key names (default: "OAUTH_"). */
  keyPrefix?: string;
  /**
   * Absolute path to auth-profiles.json. When set, the manager registers a
   * chokidar watcher on this path and invalidates its in-memory cache when
   * the file changes externally (e.g. CLI auth login). When undefined
   * (encrypted-store mode), no watcher is registered.
   */
  watchPath?: string;
  /**
   * Getter for the agent's oauthProfiles map (Record<provider, profileId>).
   * Called fresh on every getApiKey() invocation (no caching). Fallback when callers
   * do not pass agentContext directly (e.g., env-var bootstrap path).
   *
   * The fresh-on-every-call contract is required: agents_manage update mutates
   * the in-memory PerAgentConfig in place; the getter re-reads through that
   * parent reference so the resolver observes the new value without restart.
   */
  getAgentOauthProfiles?: () => Record<string, string> | undefined;
}

/** OAuth token manager interface for credential lifecycle. */
export interface OAuthTokenManager {
  /**
   * Get a valid API key for an OAuth provider. Auto-refreshes if token is
   * expired or near-expiry. Dual-surface signature with optional agentContext
   * for per-agent profile preference; the resolver chain (agent-config →
   * lastGood → first available) hard-fails on configured-but-missing.
   *
   * @param providerId - OAuth provider id (e.g., "openai-codex")
   * @param agentContext - Optional agent context for per-agent profile preference.
   *   When set, agentContext.oauthProfiles[providerId] is consulted as the
   *   primary resolver source. Falls back to deps.getAgentOauthProfiles?.()
   *   when not provided.
   */
  getApiKey(
    providerId: string,
    agentContext?: { oauthProfiles?: Record<string, string> },
  ): Promise<Result<string, OAuthError>>;
  /**
   * Synchronous best-effort check: the in-memory cache + env-var
   * (SecretManager) ONLY. Does NOT consult the async persisted credential
   * store — so in encrypted-store mode it UNDER-REPORTS a logged-in OAuth
   * profile until the cache warms (the first {@link getApiKey}). For a
   * store-aware answer (e.g. a boot-time availability probe) use
   * {@link hasStoredCredentials}.
   */
  hasCredentials(providerId: string): boolean;
  /**
   * Store-aware availability check: the in-memory cache, the env-var
   * (SecretManager), OR the persisted credential store. The async companion to
   * {@link hasCredentials} — use this where the cache may be cold (e.g. the
   * image-provider boot probe in encrypted-store mode), so a logged-in OAuth
   * profile persisted by `comis auth login` counts as available immediately at
   * boot rather than only after the first completion warms the cache. Never
   * throws (a store error resolves to `false`).
   */
  hasStoredCredentials(providerId: string): Promise<boolean>;
  /** Store credentials for a provider (e.g., after a login flow completes). */
  storeCredentials(providerId: string, creds: OAuthCredentials): void;
  /** Get the list of pi-ai built-in OAuth provider IDs. */
  getSupportedProviders(): string[];
  /**
   * Close the file watcher and clear the debounce timer.
   * No-op when watchPath was undefined at construction. Idempotent.
   */
  dispose(): Promise<void>;
}
