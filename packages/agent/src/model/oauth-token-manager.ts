// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth Token Manager: Wraps pi-ai's OAuth subsystem for Comis patterns.
 *
 * Phase 7 rewire (SPEC R6+R7):
 * - Reads + writes credentials through OAuthCredentialStorePort (no in-memory map
 *   as source of truth; refreshed credentials persist to disk and survive restart).
 * - Per-profile-ID file lock via withExecutionLock from @comis/scheduler — concurrent
 *   refresh attempts from multiple processes serialize; different profiles refresh
 *   in parallel (D-02).
 * - 30s timeout wrapper around pi-ai's getOAuthApiKey to prevent indefinite hang
 *   when auth.openai.com is unreachable (RESEARCH Q1 fix).
 * - Real-refresh detection via newCredentials.refresh !== profile.refresh (RESEARCH
 *   Q1 fix — the original !!newCredentials check was a no-op since pi-ai always
 *   returns truthy newCredentials).
 * - 9 log events per D-12 with module: "oauth-token-manager".
 * - 3 event-bus events per D-13: auth:token_rotated (extended with profileId),
 *   auth:profile_bootstrapped (NEW), auth:refresh_failed (NEW).
 * - Env-var bootstrap: empty store + valid OAUTH_<PROVIDER> env writes profile
 *   to store, decodes JWT identity, emits auth:profile_bootstrapped (R7a).
 * - Env-var conflict: stored profile + different env-var refresh → WARN once
 *   per (provider, process) with hint=env-override-ignored (R7c).
 *
 * Supported OAuth providers (via pi-ai built-in):
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 * - Google Gemini CLI (Cloud Code Assist)
 * - Google Antigravity
 * - OpenAI Codex
 *
 * @module
 */

import type { Result } from "@comis/shared";
import {
  ok,
  err,
  fromPromise,
} from "@comis/shared";
import type { SecretManager } from "@comis/core";
import {
  TypedEventBus,
  safePath,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { withExecutionLock } from "@comis/scheduler";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import {
  getOAuthProvider,
  getOAuthApiKey,
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import { watch, type FSWatcher } from "chokidar";
import {
  resolveCodexAuthIdentity,
  redactEmailForLog,
} from "./oauth-identity.js";
import { rewriteOAuthError } from "./oauth-errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Error codes returned by OAuthTokenManager operations.
 *
 * Phase 10 SC-10-4: extended with `errorKind`, `profileId`, `hint` (all
 * optional) so CLI consumers can pattern-match on `errorKind ===
 * "refresh_token_reused"` without breaking existing consumers that only
 * read `code` + `message` + `providerId`.
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
  /** Phase 10: free-form classification (e.g. "refresh_token_reused", "invalid_grant", "timeout"). */
  errorKind?: string;
  /** Phase 10: profile that failed (mirrors auth:refresh_failed event payload field). */
  profileId?: string;
  /** Phase 10: operator action recommendation; mirrors the WARN log `hint` field. */
  hint?: string;
}

/** Dependencies injected into the OAuth token manager factory. */
export interface OAuthTokenManagerDeps {
  /** SecretManager for env-var bootstrap and conflict detection. */
  secretManager: SecretManager;
  /** EventBus for emitting auth events (3 typed events: token_rotated, profile_bootstrapped, refresh_failed). */
  eventBus: TypedEventBus;
  /** Credential store for persistent refresh — REQUIRED (Phase 7). */
  credentialStore: OAuthCredentialStorePort;
  /** Logger for D-12 log events — REQUIRED (Phase 7). */
  logger: ComisLogger;
  /** Data directory for lock-file path resolution — REQUIRED (Phase 7). */
  dataDir: string;
  /** Prefix for SecretManager key names (default: "OAUTH_"). */
  keyPrefix?: string;
  /**
   * Phase 8 D-05: absolute path to auth-profiles.json. When set, the manager
   * registers a chokidar watcher on this path and invalidates its in-memory
   * cache when the file changes externally (e.g. CLI auth login). When
   * undefined (encrypted-store mode per D-08), no watcher is registered.
   */
  watchPath?: string;
  /**
   * Phase 9 D-05: getter for the agent's oauthProfiles map (Record<provider, profileId>).
   * Called fresh on every getApiKey() invocation (no caching). Fallback when callers
   * do not pass agentContext directly (e.g., env-var bootstrap path).
   *
   * The fresh-on-every-call contract is required by SPEC R2: agents_manage update
   * mutates the in-memory PerAgentConfig in place; the getter re-reads through that
   * parent reference so the resolver observes the new value without restart.
   */
  getAgentOauthProfiles?: () => Record<string, string> | undefined;
}

/** OAuth token manager interface for credential lifecycle. */
export interface OAuthTokenManager {
  /**
   * Get a valid API key for an OAuth provider. Auto-refreshes if token is
   * expired or near-expiry. Phase 9 R2: dual-surface signature with optional
   * agentContext for per-agent profile preference; the resolver chain
   * (agent-config → lastGood → first available) hard-fails on
   * configured-but-missing.
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
  /** Check if credentials for a provider exist (in cache, store, or env-var). */
  hasCredentials(providerId: string): boolean;
  /** Store credentials for a provider (e.g., after a login flow completes). */
  storeCredentials(providerId: string, creds: OAuthCredentials): void;
  /** Get the list of pi-ai built-in OAuth provider IDs. */
  getSupportedProviders(): string[];
  /**
   * Phase 8 D-05: close the file watcher and clear the debounce timer.
   * No-op when watchPath was undefined at construction. Idempotent.
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LOCK_OPTIONS = {
  staleMs: 30_000,
  updateMs: 5_000,
  // Phase 7 plan 08 — retries enable two concurrent getApiKey() callers
  // (different manager instances, same process or cross-process) to wait
  // for a sibling refresh to complete instead of immediately failing with
  // err("locked"). proper-lockfile's incremental-backoff retry helps the
  // SPEC R6 concurrent-refresh acceptance: two parallel calls → exactly 1
  // refresh request → both return the SAME access token. The retry budget
  // of 5 with 50ms..1s backoff fits well within the 30s REFRESH_TIMEOUT_MS
  // (worst case: ~5s waiting for the holder to finish a slow refresh).
  retries: { retries: 5, minTimeout: 50, maxTimeout: 1_000, factor: 2 },
};
const LOCKS_SUBDIR = ".locks";
const REFRESH_TIMEOUT_MS = 30_000;
const SCHEMA_VERSION = 1 as const;

/**
 * Convert a provider ID to an uppercase SecretManager key.
 * "github-copilot" -> "OAUTH_GITHUB_COPILOT" (with default prefix).
 */
function toSecretKey(providerId: string, prefix: string): string {
  const upper = providerId.toUpperCase().replace(/-/g, "_");
  return `${prefix}${upper}`;
}

/**
 * Sanitize a profile-ID for safe inclusion in a lock-file path.
 * One-way transformation — the canonical profile-ID stored in the credential
 * store keeps its original form. Mappings: ":" → "__", "@" → "_at_".
 */
function sanitizeProfileIdForLockPath(profileId: string): string {
  return profileId.replace(/:/g, "__").replace(/@/g, "_at_");
}

function lockSentinelPath(dataDir: string, profileId: string): string {
  // Sentinel name is "auth-refresh__<sanitized>.lock" — distinct from the
  // file adapter's "auth-profile__<sanitized>.lock" (plan 05). This separation
  // is intentional: the manager's lock guards the "refresh transaction"
  // (don't make two concurrent pi-ai requests for the same profile), while
  // the adapter's lock guards the "file-write transaction" (don't race two
  // load-mutate-atomic-write sequences). Both protect the same profile but
  // at different layers, so they MUST use different sentinel paths or
  // credentialStore.set() inside refreshUnderLock would self-deadlock under
  // proper-lockfile's default retries: 0 (Phase 7 plan 08 — discovered when
  // wiring the file adapter through the manager end-to-end for the first time).
  return safePath(
    dataDir,
    LOCKS_SUBDIR,
    "auth-refresh__" + sanitizeProfileIdForLockPath(profileId) + ".lock",
  );
}

/**
 * Parse env-var-stored OAuth credentials. Returns undefined on JSON failure
 * or missing required fields (refresh + access).
 */
function parseEnvCredentials(raw: string | undefined): OAuthCredentials | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthCredentials>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.refresh === "string" &&
      typeof parsed.access === "string"
    ) {
      return parsed as OAuthCredentials;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Race a promise against a setTimeout-based timeout. setTimeout (rather than
 * AbortSignal.timeout) is used so vi.useFakeTimers() in tests can advance the
 * timer deterministically. Returns "timeout" on timeout, else the resolved value.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });
  try {
    const winner = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      timeoutPromise,
    ]);
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Phase 10 SC-10-4: bypass pi-ai for OpenAI Codex refresh so we can parse the
// HTTP response body for clean error classification (refresh_token_reused
// detection). pi-ai 0.71's getOAuthApiKey discards the wire body in a generic
// error (Phase 7 RESEARCH §Q1 verified) — the body never reaches our wrapper.
//
// Source: ports the body of pi-ai's refreshOpenAICodexToken
// (node_modules/.pnpm/@mariozechner+pi-ai@0.71.0/.../oauth/openai-codex.js
// lines 102-134) so the response body can be parsed locally. Mirrors pi-ai
// semantics: same URL, same form-urlencoded body, same client_id.
// ---------------------------------------------------------------------------

interface LocalRefreshSuccess {
  ok: true;
  value: {
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  };
}
interface LocalRefreshFailure {
  ok: false;
  error: { error: string; errorDescription?: string; status: number };
}
type LocalRefreshOutcome = LocalRefreshSuccess | LocalRefreshFailure;

/**
 * Refresh OpenAI Codex OAuth tokens by calling auth.openai.com directly
 * (bypassing pi-ai's getOAuthApiKey wrapper). On HTTP error, parses the
 * response body so refresh_token_reused / invalid_grant can be classified
 * by `rewriteOAuthError` (Plan 10-02).
 *
 * Used ONLY when providerId === "openai-codex"; other providers continue to
 * use pi-ai's wrapper (which works correctly for them — they don't need the
 * wire-body classification).
 *
 * Never throws — wraps network errors in {ok:false} per AGENTS.md §2.1.
 */
async function refreshOpenAICodexTokenLocal(
  profile: OAuthProfile,
): Promise<LocalRefreshOutcome> {
  const tokenUrl = "https://auth.openai.com/oauth/token";
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: profile.refresh,
    // Public OpenAI Codex client_id (per pi-ai source). NOT a comis secret.
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  });
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    // Network error / DNS / TLS — surface as a synthesized 0-status failure
    // so the classifier maps it to the default "callback_timeout" path.
    return {
      ok: false,
      error: {
        error: "network_error",
        errorDescription: e instanceof Error ? e.message : String(e),
        status: 0,
      },
    };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // Defense-in-depth: body read failed → empty string.
    }
    let parsed: { error?: string; error_description?: string } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // T-10-05 mitigation: malformed body → empty parse, classifier falls
      // back to default case.
    }
    return {
      ok: false,
      error: {
        error: parsed.error ?? "unknown_error",
        errorDescription: parsed.error_description,
        status: response.status,
      },
    };
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  // Recover accountId via pi-ai's exported provider helper. The provider
  // object may NOT expose `getAccountId` (the openai-codex provider in
  // pi-ai 0.71 does not), so the optional chain falls through to undefined
  // — `mergeRefreshedCredentials` handles missing accountId.
  const provider = getOAuthProvider("openai-codex") as
    | { getAccountId?: (token: string) => string | null }
    | undefined;
  let accountId: string | undefined;
  try {
    const extracted = provider?.getAccountId?.(json.access_token);
    if (typeof extracted === "string" && extracted.length > 0) {
      accountId = extracted;
    }
  } catch {
    // Defensive — getAccountId may throw on malformed JWT; leave undefined.
  }

  return {
    ok: true,
    value: {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId,
    },
  };
}

/**
 * Map a pi-ai OAuthCredentials object into a refreshed OAuthProfile (preserves
 * existing identity metadata; only access/refresh/expires/accountId change).
 */
function mergeRefreshedCredentials(
  existing: OAuthProfile,
  refreshed: OAuthCredentials,
): OAuthProfile {
  const accountIdRaw = (refreshed as { accountId?: unknown }).accountId;
  const accountId =
    typeof accountIdRaw === "string" && accountIdRaw.length > 0
      ? accountIdRaw
      : existing.accountId;
  return {
    ...existing,
    access: refreshed.access,
    refresh: refreshed.refresh,
    expires: refreshed.expires,
    accountId,
    version: SCHEMA_VERSION,
  };
}

/**
 * Build a fresh OAuthProfile from an env-var seed (bootstrap path).
 * The identity (and therefore the canonical profileId) is derived by
 * decoding the access-token JWT. Falls back to "<provider>:env-bootstrap"
 * when the JWT cannot be decoded.
 */
function buildBootstrapProfile(
  provider: string,
  seed: OAuthCredentials,
): { profileId: string; profile: OAuthProfile; identity: string } {
  const identityResult = resolveCodexAuthIdentity({ accessToken: seed.access });
  const email = identityResult.email;
  const profileNameLike = identityResult.profileName;

  // Canonical identity for profileId: prefer email, then profileName fallback,
  // else "env-bootstrap" sentinel.
  let identityKey: string;
  if (email && email.length > 0) {
    identityKey = email;
  } else if (profileNameLike && profileNameLike.length > 0) {
    identityKey = profileNameLike;
  } else {
    identityKey = "env-bootstrap";
  }

  const profileId = `${provider}:${identityKey}`;
  const accountIdRaw = (seed as { accountId?: unknown }).accountId;
  const accountId =
    typeof accountIdRaw === "string" && accountIdRaw.length > 0 ? accountIdRaw : undefined;

  const profile: OAuthProfile = {
    provider,
    profileId,
    access: seed.access,
    refresh: seed.refresh,
    expires: seed.expires,
    accountId,
    email,
    version: SCHEMA_VERSION,
  };

  // Identity for the bootstrapped event payload — semi-redacted email when
  // present, else the profileName (id-<base64> form is already non-PII).
  const identity = email ? (redactEmailForLog(email) ?? identityKey) : identityKey;

  return { profileId, profile, identity };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OAuth token manager wrapping pi-ai's OAuth subsystem.
 *
 * Phase 7 architecture:
 *   1. Resolve candidate profileId (env-var seed JWT > stored list > env-bootstrap sentinel).
 *   2. Acquire per-profile lock via withExecutionLock.
 *   3. Inside lock: TOCTOU re-read profile, run pi-ai with 30s timeout.
 *   4. Detect real refresh by comparing newCredentials.refresh !== profile.refresh.
 *   5. If refreshed, persist via credentialStore.set, then emit auth:token_rotated.
 *   6. Release lock.
 *
 * @param deps - SecretManager, EventBus, CredentialStore, Logger, dataDir, optional keyPrefix
 */
export function createOAuthTokenManager(deps: OAuthTokenManagerDeps): OAuthTokenManager {
  const {
    secretManager,
    eventBus,
    credentialStore,
    logger,
    dataDir,
    keyPrefix = "OAUTH_",
  } = deps;

  // Hot-path read cache (Discretion item — invalidated on persisted writes).
  // Keyed by canonical profileId.
  const cache = new Map<string, OAuthProfile>();

  // De-dup sets — fire WARN/INFO once per (provider, process).
  const bootstrappedProviders = new Set<string>();
  const warnedConflictProviders = new Set<string>();

  // Phase 9 D-07: per-instance lastGood map. Records the most-recently-resolved
  // profileId per provider for this agent's OAuthTokenManager. Resets on daemon
  // restart (in-memory only per SPEC). Updated inside the per-profile-ID lock
  // (F-05) on every successful resolve (refresh OR cached-hit).
  const lastGood = new Map<string, string>();

  // Phase 9 logger de-dup: fire INFO once per (provider, configured-profile,
  // process) when the configured profile is first used. Mirrors
  // bootstrappedProviders pattern.
  const loggedConfiguredProviders = new Set<string>();

  // -------------------------------------------------------------------------
  // Phase 8 D-05/D-06/D-07: chokidar watcher on auth-profiles.json (file
  // adapter only). RESEARCH override 1 — chokidar's atomic: 100 coalesces
  // Phase 7's tmp+rename atomic-write sequence into a single change event;
  // raw fs.watch detaches across the rename on Linux ext4 (inode tracking).
  // -------------------------------------------------------------------------

  const { watchPath } = deps;
  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Snapshot of profileIds the manager has seen — used to diff against
  // store.list() after a watcher fire to emit auth:profile_added for new
  // profiles only (D-07).
  const seenProfileIds = new Set<string>();

  async function emitProfileAddedEventsAfterReload(): Promise<void> {
    const listResult = await credentialStore.list();
    if (!listResult.ok) return;
    const before = new Set(seenProfileIds);
    seenProfileIds.clear();
    for (const profile of listResult.value) {
      seenProfileIds.add(profile.profileId);
      if (!before.has(profile.profileId)) {
        // RESEARCH override 2: source: "external" always (drop discriminator).
        eventBus.emit("auth:profile_added", {
          provider: profile.provider,
          profileId: profile.profileId,
          identity:
            profile.email
              ? (redactEmailForLog(profile.email) ?? profile.profileId)
              : profile.profileId,
          source: "external",
          timestamp: Date.now(),
        });
      }
    }
  }

  function scheduleCacheInvalidation(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // D-06: invalidate the ENTIRE hot cache (file is rewritten as a whole;
      // per-profile diffing is YAGNI for a sub-1MB JSON).
      cache.clear();
      logger.debug(
        {
          filePath: watchPath,
          debouncedMs: 100,
          module: "oauth-store-watcher",
        },
        "OAuth store change detected; cache invalidated",
      );
      // D-07: emit auth:profile_added for newly-discovered profiles.
      // Best-effort — failure is logged inside the helper but not surfaced
      // (the next getApiKey call will repopulate cache from store anyway).
      void emitProfileAddedEventsAfterReload().catch((emitErr: unknown) => {
        logger.warn(
          {
            module: "oauth-store-watcher",
            hint: "profile_added_emit_failed",
            errorKind: "event_emit",
            err: emitErr,
          },
          "Failed to emit auth:profile_added after watcher fire",
        );
      });
    }, 100);
  }

  if (watchPath) {
    watcher = watch(watchPath, {
      persistent: false,           // do not keep the daemon alive on the watcher alone
      ignoreInitial: true,         // no event for the file's existence at startup
      atomic: 100,                 // coalesce tmp+rename into one change event
      awaitWriteFinish: false,
    });
    // Subscribe to change AND unlink AND add — unlink handles the logout path
    // (file deleted), change handles modify after atomic-rename swap, add
    // handles the first-write case after the file didn't exist at startup.
    watcher.on("change", scheduleCacheInvalidation);
    watcher.on("unlink", scheduleCacheInvalidation);
    watcher.on("add", scheduleCacheInvalidation);
    watcher.on("error", (watchErr: unknown) => {
      logger.warn(
        {
          module: "oauth-store-watcher",
          hint: "watcher_failed",
          errorKind: "fs_watch",
          err: watchErr,
        },
        "OAuth profile watcher errored",
      );
    });
    logger.debug(
      { module: "oauth-store-watcher", filePath: watchPath },
      "OAuth profile watcher registered",
    );
  }

  /**
   * Resolve the working profile for a provider:
   *   - Look up via list({ provider }) first (canonical stored profile).
   *   - Else use env-var seed if present (bootstrap path).
   *   - Else fallback to "<provider>:env-bootstrap" sentinel for the get() call.
   *
   * Returns the candidate profileId plus optional env seed for downstream
   * bootstrap/conflict detection.
   */
  async function resolveCandidateProfileId(
    providerId: string,
  ): Promise<{
    profileId: string;
    envSeed: OAuthCredentials | undefined;
  }> {
    const envRaw = secretManager.get(toSecretKey(providerId, keyPrefix));
    const envSeed = parseEnvCredentials(envRaw);

    // Prefer existing stored profile (list discovery).
    const listResult = await credentialStore.list({ provider: providerId });
    if (listResult.ok && listResult.value.length > 0) {
      const first = listResult.value[0];
      if (first) {
        return { profileId: first.profileId, envSeed };
      }
    }

    // No stored profile — derive candidate from env seed JWT (if valid).
    if (envSeed) {
      const { profileId: candidate } = buildBootstrapProfile(providerId, envSeed);
      return { profileId: candidate, envSeed };
    }

    // Final fallback — sentinel profileId for the get() call. If get returns
    // a profile, its actual profileId (from the returned object) supersedes.
    return { profileId: `${providerId}:env-bootstrap`, envSeed };
  }

  /**
   * Detect env-var override drift after a profile is loaded from the store.
   * When the env var refresh-token differs from the stored refresh-token,
   * WARN once per (provider, process) with operator hint.
   */
  function maybeWarnEnvConflict(
    providerId: string,
    storedProfile: OAuthProfile,
    envSeed: OAuthCredentials | undefined,
  ): void {
    if (!envSeed) return;
    if (envSeed.refresh === storedProfile.refresh) return;
    if (warnedConflictProviders.has(providerId)) return;
    warnedConflictProviders.add(providerId);
    logger.warn(
      {
        provider: providerId,
        profileId: storedProfile.profileId,
        module: "oauth-token-manager",
        hint: "env-override-ignored",
        errorKind: "config_drift",
      },
      "OAuth env var refresh token differs from stored profile; stored profile is canonical",
    );
  }

  /**
   * Bootstrap an env-var seed into the credential store on first access.
   * Writes the new profile, emits auth:profile_bootstrapped (once per provider),
   * and returns the persisted profile. Bootstrap is performed BEFORE acquiring
   * the per-profile refresh lock — the bootstrap-write is idempotent (set is
   * UPSERT) and runs at most once per (provider, process) due to the de-dup
   * tracker.
   */
  async function bootstrapFromEnv(
    providerId: string,
    envSeed: OAuthCredentials,
  ): Promise<Result<OAuthProfile, OAuthError>> {
    const { profileId, profile, identity } = buildBootstrapProfile(providerId, envSeed);

    const writeResult = await credentialStore.set(profileId, profile);
    if (!writeResult.ok) {
      logger.warn(
        {
          provider: providerId,
          profileId,
          module: "oauth-token-manager",
          hint: "store_write_failed",
          errorKind: "store_failed",
          err: writeResult.error,
        },
        "OAuth bootstrap failed: credentialStore.set rejected",
      );
      return err({
        code: "STORE_FAILED",
        message: `Failed to bootstrap OAuth profile for "${providerId}": ${writeResult.error.message}`,
        providerId,
      });
    }

    cache.set(profileId, profile);

    // De-dup the bootstrap event per (provider, process).
    if (!bootstrappedProviders.has(providerId)) {
      bootstrappedProviders.add(providerId);
      logger.info(
        {
          provider: providerId,
          profileId,
          module: "oauth-token-manager",
          identity,
        },
        "Profile bootstrapped from env",
      );
      eventBus.emit("auth:profile_bootstrapped", {
        provider: providerId,
        profileId,
        identity,
        timestamp: Date.now(),
      });
    }

    return ok(profile);
  }

  /**
   * Run the lock-protected refresh body. Re-reads profile inside the lock
   * (TOCTOU safety), calls pi-ai with a 30s timeout, detects real refresh
   * by comparing refresh-token field, persists if rotated, emits events.
   *
   * Returns the API key on success, or an OAuthError on failure.
   */
  async function refreshUnderLock(
    providerId: string,
    initialProfile: OAuthProfile,
  ): Promise<Result<string, OAuthError>> {
    const lockPath = lockSentinelPath(dataDir, initialProfile.profileId);
    const lockStart = Date.now();

    const lockResult = await withExecutionLock(
      lockPath,
      async (): Promise<Result<string, OAuthError>> => {
        const acquireMs = Date.now() - lockStart;
        logger.debug(
          {
            provider: providerId,
            profileId: initialProfile.profileId,
            module: "oauth-token-manager",
            durationMs: acquireMs,
          },
          "Lock acquired",
        );

        const heldStart = Date.now();
        try {
          // TOCTOU re-read inside lock to avoid acting on stale cache.
          const reread = await credentialStore.get(initialProfile.profileId);
          if (!reread.ok) {
            return err({
              code: "STORE_FAILED",
              message: `credentialStore.get failed inside lock: ${reread.error.message}`,
              providerId,
            });
          }
          const profile = reread.value ?? initialProfile;

          // Pi-ai requires a Record<providerId, OAuthCredentials> shape.
          const credsRecord: Record<string, OAuthCredentials> = {
            [providerId]: {
              access: profile.access,
              refresh: profile.refresh,
              expires: profile.expires,
            } as OAuthCredentials,
          };

          // Phase 10 SC-10-4: bypass pi-ai for openai-codex so we can parse
          // the wire response body for clean error classification (refresh_
          // token_reused detection). Other providers continue to use pi-ai
          // (which works correctly when the body is not needed).
          const isCodex = providerId === "openai-codex";

          // Both branches end with `apiKeyResult` populated to the pi-ai
          // success-shape. This let-binding mirrors pi-ai's untyped result
          // — `any` is the one acceptable use in this file (pi-ai's
          // getOAuthApiKey return type is genuinely untyped at the npm
          // boundary; the bypass synthesizes the same shape).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi-ai surface is untyped
          let apiKeyResult: any;

          if (isCodex) {
            // Skip the wire if the persisted access is still valid.
            // pi-ai's getOAuthApiKey performs this check internally for
            // non-codex providers; the codex bypass must mirror it or every
            // getApiKey() call would re-hit the token endpoint and break the
            // R6 "restart-survives-refresh" contract. 60s buffer keeps callers
            // from racing the actual expiry.
            const REFRESH_EXPIRY_BUFFER_MS = 60_000;
            if (typeof profile.expires === "number"
              && profile.expires > Date.now() + REFRESH_EXPIRY_BUFFER_MS
            ) {
              cache.set(profile.profileId, profile);
              // Mirror the post-refresh lastGood update so subsequent calls
              // short-circuit at tier (b) instead of re-hitting tier (c) list().
              lastGood.set(providerId, profile.profileId);
              logger.debug(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  remainingMs: profile.expires - Date.now(),
                },
                "OAuth token still valid — skipping refresh",
              );
              return ok(profile.access);
            }

            // Bypass never throws (it returns a tagged outcome on every path),
            // so feed the bare promise into `withTimeout` — no fromPromise wrap.
            const raceResult = await withTimeout(
              refreshOpenAICodexTokenLocal(profile),
              REFRESH_TIMEOUT_MS,
            );

            if (!raceResult.ok) {
              // timeout — bypass branch
              logger.warn(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  hint: "auth_endpoint_unreachable",
                  errorKind: "timeout",
                },
                "OAuth refresh timed out after 30s",
              );
              eventBus.emit("auth:refresh_failed", {
                provider: providerId,
                profileId: profile.profileId,
                errorKind: "timeout",
                hint: "auth_endpoint_unreachable",
                timestamp: Date.now(),
              });
              return err({
                code: "REFRESH_FAILED",
                message: `OAuth refresh timed out for provider "${providerId}" after ${REFRESH_TIMEOUT_MS}ms`,
                providerId,
                errorKind: "timeout",
                profileId: profile.profileId,
                hint: "auth_endpoint_unreachable",
              });
            }

            const localResult: LocalRefreshOutcome = raceResult.value;
            if (!localResult.ok) {
              // Concatenate both wire fields so the catalogue's substring
              // matchers (rewriteOAuthError) can detect specific patterns
              // regardless of which field carries them. Tests confirm:
              //   refresh_token_reused → typically in error_description
              //   invalid_grant generic → in error code
              //   unsupported_country_region_territory → in error code
              const classifyMessage =
                `${localResult.error.error} ${localResult.error.errorDescription ?? ""}`.trim();
              const classifyInput = new Error(classifyMessage);
              const rewritten = rewriteOAuthError(classifyInput);
              logger.warn(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  hint: rewritten.hint,
                  errorKind: rewritten.errorKind,
                  err: classifyInput,
                  status: localResult.error.status,
                },
                "OAuth refresh failed",
              );
              eventBus.emit("auth:refresh_failed", {
                provider: providerId,
                profileId: profile.profileId,
                errorKind: rewritten.errorKind,
                hint: rewritten.hint,
                timestamp: Date.now(),
              });
              return err({
                code: "REFRESH_FAILED",
                message: rewritten.userMessage,
                providerId,
                errorKind: rewritten.errorKind,
                profileId: profile.profileId,
                hint: rewritten.hint,
              });
            }

            // Synthesize the apiKeyResult shape pi-ai would return on success.
            // Downstream code reads `apiKeyResult.value.apiKey` and
            // `apiKeyResult.value.newCredentials.refresh`.
            const synth: OAuthCredentials = {
              access: localResult.value.access,
              refresh: localResult.value.refresh,
              expires: localResult.value.expires,
              ...(localResult.value.accountId !== undefined
                ? { accountId: localResult.value.accountId }
                : {}),
            } as OAuthCredentials;
            apiKeyResult = {
              ok: true,
              value: { apiKey: synth.access, newCredentials: synth },
            };
          } else {
            // Non-Codex: original pi-ai path UNCHANGED.
            // 30s timeout wrapper (RESEARCH Q1 fix — pi-ai has no built-in timeout).
            const piAiCall = fromPromise(getOAuthApiKey(providerId, credsRecord));
            const raceResult = await withTimeout(piAiCall, REFRESH_TIMEOUT_MS);

            if (!raceResult.ok) {
              // timeout
              logger.warn(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  hint: "auth_endpoint_unreachable",
                  errorKind: "timeout",
                },
                "OAuth refresh timed out after 30s",
              );
              eventBus.emit("auth:refresh_failed", {
                provider: providerId,
                profileId: profile.profileId,
                errorKind: "timeout",
                hint: "auth_endpoint_unreachable",
                timestamp: Date.now(),
              });
              return err({
                code: "REFRESH_FAILED",
                message: `OAuth refresh timed out for provider "${providerId}" after ${REFRESH_TIMEOUT_MS}ms`,
                providerId,
                errorKind: "timeout",
                profileId: profile.profileId,
                hint: "auth_endpoint_unreachable",
              });
            }

            apiKeyResult = raceResult.value;
            if (!apiKeyResult.ok) {
              // Classify via the shared catalogue — generic invalid_grant +
              // unsupported_region matchers still apply to non-Codex providers
              // when the original error message contains the substring.
              const rewritten = rewriteOAuthError(apiKeyResult.error);
              logger.warn(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  hint: rewritten.hint,
                  errorKind: rewritten.errorKind,
                  err: apiKeyResult.error,
                },
                "OAuth refresh failed",
              );
              eventBus.emit("auth:refresh_failed", {
                provider: providerId,
                profileId: profile.profileId,
                errorKind: rewritten.errorKind,
                hint: rewritten.hint,
                timestamp: Date.now(),
              });
              return err({
                code: "REFRESH_FAILED",
                message: rewritten.userMessage,
                providerId,
                errorKind: rewritten.errorKind,
                profileId: profile.profileId,
                hint: rewritten.hint,
              });
            }
          }

          const oauthResult = apiKeyResult.value;

          // pi-ai returns null when no credentials.
          if (!oauthResult) {
            return err({
              code: "NO_CREDENTIALS",
              message: `getOAuthApiKey returned null for provider "${providerId}"`,
              providerId,
            });
          }

          // RESEARCH Q1 fix — real refresh detection compares the refresh-token
          // value, not the always-truthy newCredentials marker.
          const refreshed = oauthResult.newCredentials.refresh !== profile.refresh;

          if (refreshed) {
            const newProfile = mergeRefreshedCredentials(profile, oauthResult.newCredentials);
            const writeResult = await credentialStore.set(profile.profileId, newProfile);
            if (!writeResult.ok) {
              logger.warn(
                {
                  provider: providerId,
                  profileId: profile.profileId,
                  module: "oauth-token-manager",
                  hint: "store_write_failed",
                  errorKind: "store_failed",
                  err: writeResult.error,
                },
                "OAuth refresh persisted-write failed",
              );
              return err({
                code: "STORE_FAILED",
                message: `Failed to persist refreshed OAuth credentials for "${providerId}": ${writeResult.error.message}`,
                providerId,
              });
            }
            cache.set(profile.profileId, newProfile);
            // pi-ai's OAuthCredentials.expires is already milliseconds since epoch
            // (RESEARCH Q1 landmine 4) — use directly, do NOT multiply by 1000.
            eventBus.emit("auth:token_rotated", {
              provider: providerId,
              profileName: toSecretKey(providerId, keyPrefix),
              profileId: profile.profileId,
              expiresAtMs: newProfile.expires,
              timestamp: Date.now(),
            });
          } else {
            // Cache the unrotated profile for the next read (no DB roundtrip needed).
            cache.set(profile.profileId, profile);
          }

          const completeStart = Date.now();
          logger.info(
            {
              provider: providerId,
              profileId: profile.profileId,
              module: "oauth-token-manager",
              durationMs: completeStart - heldStart,
              refreshed,
            },
            "OAuth refresh complete",
          );

          // Phase 9 D-07 + F-05: lastGood update inside the lock-held window.
          // Updated on every successful resolve (refresh OR cached-hit) so the
          // tier-(b) lookup in subsequent getApiKey calls (no agent-level
          // config) short-circuits to the just-resolved profile.
          const previousLastGood = lastGood.get(providerId);
          lastGood.set(providerId, profile.profileId);
          if (previousLastGood !== profile.profileId) {
            logger.debug(
              {
                provider: providerId,
                profileId: profile.profileId,
                previous: previousLastGood ?? null,
                module: "oauth-resolver",
              },
              "lastGood updated",
            );
          }

          return ok(oauthResult.apiKey);
        } finally {
          logger.debug(
            {
              provider: providerId,
              profileId: initialProfile.profileId,
              module: "oauth-token-manager",
              heldMs: Date.now() - heldStart,
            },
            "Lock released",
          );
        }
      },
      LOCK_OPTIONS,
    );

    if (!lockResult.ok) {
      const lockKind = lockResult.error;
      const hint = lockKind === "locked" ? "lock_contention" : "lock_error";
      const errorKind = lockKind === "locked" ? "lock_contention" : "lock_error";
      logger.warn(
        {
          provider: providerId,
          profileId: initialProfile.profileId,
          module: "oauth-token-manager",
          retries: 0,
          hint,
          errorKind,
        },
        lockKind === "locked"
          ? "OAuth refresh lock contention"
          : "OAuth refresh lock error",
      );
      eventBus.emit("auth:refresh_failed", {
        provider: providerId,
        profileId: initialProfile.profileId,
        errorKind,
        hint,
        timestamp: Date.now(),
      });
      return err({
        code: "REFRESH_FAILED",
        message: `OAuth refresh lock ${lockKind} for provider "${providerId}"`,
        providerId,
      });
    }

    return lockResult.value;
  }

  return {
    async getApiKey(
      providerId: string,
      agentContext?: { oauthProfiles?: Record<string, string> },
    ): Promise<Result<string, OAuthError>> {
      // Provider validation first (cheap check; avoids store I/O on bad input).
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        return err({
          code: "NO_PROVIDER",
          message: `Unknown OAuth provider "${providerId}". Not registered with pi-ai.`,
          providerId,
        });
      }

      // Phase 9 R2: resolve oauthProfiles fresh on every call (no caching).
      // Dual-surface: prefer the explicit agentContext argument; fall back to
      // the deps getter for callers without an agent context (e.g., env-var
      // bootstrap path, tests).
      const oauthProfiles =
        agentContext?.oauthProfiles ?? deps.getAgentOauthProfiles?.();
      const configured = oauthProfiles?.[providerId];

      // Tier (a) — Agent-config-named profile. Hard-fail on missing per
      // SPEC R2 acceptance a2; this is the security keystone — never silently
      // fall through to a different account when the configured one is gone.
      if (configured !== undefined) {
        const hasResult = await credentialStore.has(configured);
        if (!hasResult.ok) {
          return err({
            code: "STORE_FAILED",
            message: `credentialStore.has failed for "${configured}": ${hasResult.error.message}`,
            providerId,
          });
        }
        if (!hasResult.value) {
          logger.warn(
            {
              provider: providerId,
              configuredProfileId: configured,
              hint: "configured-profile-missing",
              errorKind: "profile_not_found",
              module: "oauth-resolver",
            },
            "Configured OAuth profile not found in store",
          );
          return err({
            code: "PROFILE_NOT_FOUND",
            message: `OAuth profile "${configured}" configured for agent but not found in store. Run "comis auth list" to see available profiles.`,
            providerId,
          });
        }

        // Once-per-(provider, configured-profile, process) INFO log when the
        // configured profile is first used.
        const dedupKey = `${providerId}::${configured}`;
        if (!loggedConfiguredProviders.has(dedupKey)) {
          loggedConfiguredProviders.add(dedupKey);
          logger.info(
            {
              provider: providerId,
              profileId: configured,
              module: "oauth-resolver",
            },
            "OAuth profile resolved via agent config",
          );
        }
        logger.debug(
          {
            provider: providerId,
            source: "agent-config",
            profileId: configured,
            module: "oauth-resolver",
          },
          "Resolved OAuth profile via chain",
        );

        // Read the full profile to feed into refreshUnderLock.
        const getResult = await credentialStore.get(configured);
        if (!getResult.ok) {
          return err({
            code: "STORE_FAILED",
            message: `credentialStore.get failed for "${configured}": ${getResult.error.message}`,
            providerId,
          });
        }
        if (!getResult.value) {
          // Race: profile existed at .has() but vanished by .get(). Treat as
          // PROFILE_NOT_FOUND with a retry hint per threat T-09-Race-store-mutation-mid-call.
          return err({
            code: "PROFILE_NOT_FOUND",
            message: `OAuth profile "${configured}" disappeared from store between has() and get(). Retry the operation.`,
            providerId,
          });
        }
        return refreshUnderLock(providerId, getResult.value);
      }

      // Tier (b) — lastGood (in-process Map; only consulted when no agent-level
      // config). Stale entries (profile deleted post-lastGood-set) cause
      // fall-through to tier (c) per threat T-09-StaleData-stale-lastGood.
      const lg = lastGood.get(providerId);
      if (lg !== undefined) {
        const hasResult = await credentialStore.has(lg);
        if (hasResult.ok && hasResult.value) {
          const getResult = await credentialStore.get(lg);
          if (getResult.ok && getResult.value) {
            logger.debug(
              {
                provider: providerId,
                source: "lastGood",
                profileId: lg,
                module: "oauth-resolver",
              },
              "Resolved OAuth profile via chain",
            );
            return refreshUnderLock(providerId, getResult.value);
          }
        }
        // Stale lastGood (profile deleted, has() failed, or get() returned
        // nothing) → fall through to tier (c).
      }

      // Tier (c) — first available from list({provider}). Returns early when
      // the store has at least one profile for this provider.
      const tierCList = await credentialStore.list({ provider: providerId });
      if (!tierCList.ok) {
        return err({
          code: "STORE_FAILED",
          message: `credentialStore.list failed for provider "${providerId}": ${tierCList.error.message}`,
          providerId,
        });
      }
      if (tierCList.value.length > 0) {
        const firstProfile = tierCList.value[0];
        if (firstProfile) {
          // Conflict detection on the picked profile — env var may diverge
          // from stored refresh (R7c silent vs WARN path).
          const envRawForC = secretManager.get(toSecretKey(providerId, keyPrefix));
          const envSeedForC = parseEnvCredentials(envRawForC);
          maybeWarnEnvConflict(providerId, firstProfile, envSeedForC);
          logger.debug(
            {
              provider: providerId,
              source: "first",
              profileId: firstProfile.profileId,
              module: "oauth-resolver",
            },
            "Resolved OAuth profile via chain",
          );
          return refreshUnderLock(providerId, firstProfile);
        }
      }

      // Phase 7 env-bootstrap fallback: tiers (a)/(b)/(c) all came up empty.
      // Discover candidate profileId + env-var seed from the legacy resolver.
      const { profileId: candidateProfileId, envSeed } =
        await resolveCandidateProfileId(providerId);

      logger.debug(
        {
          provider: providerId,
          profileId: candidateProfileId,
          source: "env-bootstrap",
          module: "oauth-resolver",
        },
        "Resolved OAuth profile via env-bootstrap fallback",
      );

      // Try to load the existing stored profile (tier (c) covered list-based
      // discovery; this catches the case where candidateProfileId resolves to
      // a sentinel that is still recoverable via direct get()).
      const storeRead = await credentialStore.get(candidateProfileId);
      if (!storeRead.ok) {
        return err({
          code: "STORE_FAILED",
          message: `credentialStore.get failed for "${candidateProfileId}": ${storeRead.error.message}`,
          providerId,
        });
      }

      let profile = storeRead.value;

      if (profile) {
        const expiresAt =
          typeof profile.expires === "number" ? profile.expires : undefined;
        const secsUntilExpiry =
          expiresAt !== undefined ? Math.floor((expiresAt - Date.now()) / 1000) : undefined;
        logger.debug(
          {
            provider: providerId,
            profileId: profile.profileId,
            module: "oauth-token-manager",
            expiresAt,
            secsUntilExpiry,
          },
          "Profile loaded from store",
        );
        // Conflict detection (R7c) — env var diverges from stored refresh.
        maybeWarnEnvConflict(providerId, profile, envSeed);
      } else {
        // Store empty for this profileId. Try in-memory cache first — it
        // covers (a) the rotated-profile-after-prior-refresh path where the
        // store mock isn't updated mid-test, and (b) the storeCredentials()
        // path used by login flows + back-compat tests.
        const cached = cache.get(candidateProfileId);
        const cachedByProvider =
          cached ?? Array.from(cache.values()).find((p) => p.provider === providerId);
        if (cachedByProvider) {
          profile = cachedByProvider;
          // Conflict detection on the cache-loaded profile too — env var may
          // have changed since storeCredentials() was called.
          maybeWarnEnvConflict(providerId, profile, envSeed);
        } else if (envSeed) {
          // Bootstrap from env-var seed when available.
          const bootstrapResult = await bootstrapFromEnv(providerId, envSeed);
          if (!bootstrapResult.ok) return bootstrapResult;
          profile = bootstrapResult.value;
        } else {
          return err({
            code: "NO_CREDENTIALS",
            message: `No OAuth credentials stored or seeded for provider "${providerId}"`,
            providerId,
          });
        }
      }

      // Acquire per-profile lock and run the refresh body.
      return refreshUnderLock(providerId, profile);
    },

    hasCredentials(providerId: string): boolean {
      // Cache-only synchronous check — sufficient for "has any candidate".
      // Async store/list checks live in getApiKey.
      const cached = Array.from(cache.values()).some((p) => p.provider === providerId);
      if (cached) return true;
      const secretKey = toSecretKey(providerId, keyPrefix);
      return secretManager.has(secretKey);
    },

    storeCredentials(providerId: string, creds: OAuthCredentials): void {
      // Best-effort cache-only store; persistent storage uses bootstrapFromEnv
      // or the lock-protected refresh path. Used by tests + future login flows.
      const { profileId, profile } = buildBootstrapProfile(providerId, creds);
      cache.set(profileId, profile);
    },

    getSupportedProviders(): string[] {
      return getOAuthProviders().map((p) => p.id);
    },

    async dispose(): Promise<void> {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
    },
  };
}
