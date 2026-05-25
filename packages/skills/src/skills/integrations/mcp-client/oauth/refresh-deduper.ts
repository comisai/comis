// SPDX-License-Identifier: Apache-2.0
/**
 * 401 refresh-deduper — the concurrency-control + persist-after-refresh core for
 * MCP OAuth token refresh. Deduplicates concurrent refresh requests and persists
 * rotated tokens to prevent thundering-herd token invalidation.
 *
 * ── Why (thundering herd) ────────────────────────────────────────────────────
 * When an access token expires, EVERY in-flight tool call against that server
 * gets a 401 at roughly the same moment. Naively each 401 fires its own
 * `refresh_token` POST: N calls → N refreshes. That hammers the provider's
 * /token endpoint (rate-limit) and — worse — with a provider that ROTATES the
 * refresh_token (Notion) the N concurrent refreshes invalidate each
 * other's tokens, collapsing the whole chain into a lockout.
 *
 * The fix is a shared future: a `Map<accessToken, Promise<RefreshResult>>` whose
 * check+set runs SYNCHRONOUSLY inside a concurrency-1 p-queue critical section.
 * The first 401 for a given access token creates the promise and stores it; the
 * other N-1 callers find the entry and await the SAME promise. 100 concurrent
 * 401s for one expired token therefore produce exactly ONE refresh POST
 * The map check+set MUST NOT `await` between `has()` and
 * `set()` — any suspension there reopens the race the queue closes.
 *
 * ── Straggler cache (5s) ────────────────────────────────────────────────────
 * A successful refresh result is kept in the map for `cacheTtlMs` (default 5s)
 * after it resolves, so a 401 that arrives slightly AFTER the winning refresh
 * completes (a straggler whose request was already in flight with the old
 * bearer) reuses the fresh token instead of firing a redundant refresh. The TTL
 * is CLOCK-DRIVEN: each `dedupedRefresh` first evicts a cached entry whose
 * `resolvedAt + cacheTtlMs <= now()`, so the behaviour is deterministic under an
 * injected clock (tests pin `now`). A background `systemSetTimeout` proactively
 * evicts too, so an idle deduper does not retain a stale token map entry.
 *
 * ── Rotation persistence ────────────────────────────────────────────────────
 * The deduper does NOT hand-roll the POST — the SDK `refreshAuthorization` does
 * the refresh and "Preserves original refresh token if a new one is not
 * returned". So `result.refresh_token` is the ROTATED token when the provider
 * rotates (Notion) and the original otherwise. Persisting `saveTokens(server,
 * result)` after EVERY refresh therefore captures rotation unconditionally — the
 * next refresh reads the new token off disk and the dead old token is never
 * re-presented (which Notion 400-rejects → lockout).
 *
 * ── Failure eviction ────────────────────────────────────────────────────────
 * A poisoned shared future (a rejected refresh cached forever) would block every
 * future refresh for that token. So a refresh that REJECTS deletes its inflight
 * entry IMMEDIATELY (before rethrowing) — a subsequent attempt creates a fresh
 * promise and retries. Only a SUCCESSFUL refresh is retained for the straggler
 * window.
 *
 * SECURITY: access/refresh token values are NEVER logged at any level — only the
 * server name, the dedup decision (cache hit / coalesced / fresh), and waiter
 * counts. Pino redaction is a safety net, not a license.
 *
 * @module
 */

import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
  AuthorizationServerMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { systemNowMs, systemSetTimeout, systemClearTimeout, type SystemTimeoutHandle } from "@comis/core";

import type { TokenStore } from "./token-store.js";

/**
 * The shared-future payload. A thin wrapper around the SDK `OAuthTokens` so the
 * map value type is explicit and future fields (e.g. a refreshed-at stamp) have
 * a home without changing every call site.
 */
export interface RefreshResult {
  /** The tokens returned by the SDK refresh (rotated refresh_token included when the provider rotates). */
  readonly tokens: OAuthTokens;
}

/**
 * The refresh primitive. Defaults to the SDK `refreshAuthorization`; injectable
 * so tests can drive a counting wrapper. The signature mirrors the subset of the
 * SDK call the deduper threads through.
 */
export type RefreshFn = (
  authorizationServerUrl: string | URL,
  opts: {
    metadata?: AuthorizationServerMetadata;
    clientInformation: OAuthClientInformationMixed;
    refreshToken: string;
    resource?: URL;
    addClientAuthentication?: (
      headers: Headers,
      params: URLSearchParams,
      url: string | URL,
      metadata?: AuthorizationServerMetadata,
    ) => void | Promise<void>;
    fetchFn?: FetchLike;
  },
) => Promise<OAuthTokens>;

/** Structural logger — matches the token store / discovery contract. */
interface RefreshDeduperLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** A queue exposing the p-queue `add` critical-section primitive (PQueue-compatible). */
interface CriticalSectionQueue {
  add<T>(fn: () => Promise<T> | T): Promise<T>;
}

/** Dependencies injected into {@link createRefreshDeduper}. */
export interface RefreshDeduperDeps {
  /**
   * The shared-future map (lives on `McpClientManagerState.inflightRefreshes`,
   * NOT module scope). Keyed by the EXPIRED access token; value is the in-flight
   * (or recently-resolved, within the cache TTL) refresh promise.
   */
  readonly inflightRefreshes: Map<string, Promise<RefreshResult>>;
  /**
   * A concurrency-1 critical section. The map check+set runs inside
   * `queue.add(...)` so it is atomic across concurrent callers. Reuse the
   * per-server PQueue (the existing callQueues serialization model) or a
   * dedicated cc-1 queue.
   */
  readonly queue: CriticalSectionQueue;
  /** Disk-backed token persistence — `saveTokens` captures a rotated refresh_token. */
  readonly tokenStore: Pick<TokenStore, "saveTokens">;
  /** The refresh primitive. Defaults to the SDK `refreshAuthorization`. */
  readonly refreshFn?: RefreshFn;
  /** Injectable clock (epoch ms). Defaults to {@link systemNowMs}. */
  readonly now?: () => number;
  /** Straggler-cache TTL in ms. Defaults to 5000 (5s). */
  readonly cacheTtlMs?: number;
  /**
   * Redirect-safe fetch threaded into the SDK refresh request.
   * Defaults to `createRedirectPolicyFetch({ maxRedirections: 20 })`, loaded
   * lazily so there is no import-time coupling.
   */
  readonly fetchFn?: FetchLike;
  readonly logger: RefreshDeduperLogger;
}

/** Inputs to a single {@link RefreshDeduper.dedupedRefresh} call. */
export interface DedupedRefreshArgs {
  /** Validated server name (token-store key for the persist). */
  readonly serverName: string;
  /** Authorization-server base URL (from discovery; passed to the SDK refresh). */
  readonly authServerUrl: string | URL;
  /** The EXPIRED access token — the dedup key. */
  readonly accessToken: string;
  /** The refresh_token to exchange. */
  readonly refreshToken: string;
  /** Resolved authorization-server metadata (optional; the SDK can self-discover). */
  readonly metadata?: AuthorizationServerMetadata;
  /** Client information (DCR result) — required by the SDK to select a client-auth method. */
  readonly clientInformation: OAuthClientInformationMixed;
  /** RFC 8707 resource indicator (optional). */
  readonly resource?: URL;
  /**
   * Provider-specific client-auth hook (e.g. Stripe-Account header on refresh,
   * e.g. Stripe-Account header on refresh). Forwarded verbatim to the SDK refresh — the deduper is agnostic.
   */
  readonly addClientAuthentication?: (
    headers: Headers,
    params: URLSearchParams,
    url: string | URL,
    metadata?: AuthorizationServerMetadata,
  ) => void | Promise<void>;
}

/** The refresh-deduper surface. */
export interface RefreshDeduper {
  /**
   * Refresh the given access token, deduping concurrent calls for the SAME
   * access token into a single underlying refresh. Resolves to the shared
   * {@link RefreshResult}; the rotated tokens are persisted via the token store
   * before this resolves.
   */
  dedupedRefresh(args: DedupedRefreshArgs): Promise<RefreshResult>;
}

const DEFAULT_CACHE_TTL_MS = 5000;
const MAX_REDIRECTIONS = 20;
const SUBMODULE = "oauth-refresh-deduper";

/**
 * Construct the 401 refresh-deduper. The dedup state (`inflightRefreshes`) is
 * injected (it lives on the manager), so a deduper instance is a thin behavioural
 * wrapper — the manager owns the lifetime of the map.
 */
export function createRefreshDeduper(deps: RefreshDeduperDeps): RefreshDeduper {
  const { inflightRefreshes, queue, tokenStore, logger } = deps;
  const now = deps.now ?? systemNowMs;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const refreshFn = deps.refreshFn ?? refreshAuthorization;

  // TTL bookkeeping for the straggler cache, kept SEPARATE from the shared
  // `inflightRefreshes` map (whose value type is fixed to `Promise<RefreshResult>`
  // by McpClientManagerState). `resolvedAt` stamps when a refresh resolved;
  // `evictionTimers` holds the proactive-eviction handle so an idle deduper does
  // not retain a stale entry. Both are keyed by the same access token.
  const resolvedAt = new Map<string, number>();
  const evictionTimers = new Map<string, SystemTimeoutHandle>();

  let cachedFetchFn: FetchLike | undefined = deps.fetchFn;

  /** Lazily resolve the redirect-safe fetch (no import-time coupling). */
  async function getFetchFn(): Promise<FetchLike> {
    if (cachedFetchFn === undefined) {
      const { createRedirectPolicyFetch } = await import("../mcp-client-redirect-policy.js");
      cachedFetchFn = createRedirectPolicyFetch({ maxRedirections: MAX_REDIRECTIONS });
    }
    return cachedFetchFn;
  }

  /** Drop an entry from BOTH the shared map and the TTL bookkeeping; clear any timer. */
  function evict(accessToken: string): void {
    inflightRefreshes.delete(accessToken);
    resolvedAt.delete(accessToken);
    const timer = evictionTimers.get(accessToken);
    if (timer !== undefined) {
      systemClearTimeout(timer);
      evictionTimers.delete(accessToken);
    }
  }

  /**
   * The actual refresh: SDK call → persist (captures rotation) → resolve. On
   * rejection the inflight entry is evicted immediately (no poisoned future,
   * Evict immediately so the entry is not poisoned) before the error propagates to all waiters.
   */
  async function doRefresh(args: DedupedRefreshArgs): Promise<RefreshResult> {
    const { serverName, authServerUrl, accessToken } = args;
    try {
      const fetchFn = await getFetchFn();
      const tokens = await refreshFn(authServerUrl, {
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
        clientInformation: args.clientInformation,
        refreshToken: args.refreshToken,
        ...(args.resource !== undefined ? { resource: args.resource } : {}),
        ...(args.addClientAuthentication !== undefined
          ? { addClientAuthentication: args.addClientAuthentication }
          : {}),
        fetchFn,
      });

      // Persist UNCONDITIONALLY so a rotated refresh_token reaches disk.
      // The SDK preserves the original refresh_token when the provider does not
      // rotate, so this is correct in both cases.
      await tokenStore.saveTokens(serverName, tokens);

      // Retain the resolved result for the straggler window. Stamp the resolve
      // time and arm proactive eviction; a lazy check in dedupedRefresh also
      // evicts on access (clock-driven, deterministic under an injected clock).
      resolvedAt.set(accessToken, now());
      const timer = systemSetTimeout(() => evict(accessToken), cacheTtlMs);
      evictionTimers.set(accessToken, timer);

      logger.info(
        { submodule: SUBMODULE, serverName, rotated: tokens.refresh_token !== args.refreshToken },
        "OAuth token refreshed and persisted",
      );
      return { tokens };
    } catch (err) {
      // No poisoned shared future: drop the entry so a retry can fire.
      evict(accessToken);
      logger.warn(
        // A refresh failure is an external-dependency error (the provider's
        // /token endpoint rejected the refresh — could be a rate limit, a
        // rotated-out refresh_token, or a transient 5xx). The closed errorKind
        // union maps this to "dependency".
        { submodule: SUBMODULE, serverName, errorKind: "dependency" as const, err },
        "OAuth token refresh failed; inflight entry evicted (retryable)",
      );
      // @allow-throw: the caller (the 401 handler) must observe the failure to
      // decide between retry and surfacing needs_oauth_login.
      throw err;
    }
  }

  return {
    async dedupedRefresh(args: DedupedRefreshArgs): Promise<RefreshResult> {
      const { accessToken, serverName } = args;
      // The critical section: the has()/get()/set() below run SYNCHRONOUSLY
      // (no await) inside a concurrency-1 queue, so concurrent callers for the
      // same access token observe a single shared promise. Do not introduce an
      // await between the cache check and the set().
      const promise = await queue.add<Promise<RefreshResult>>(() => {
        const existing = inflightRefreshes.get(accessToken);
        if (existing !== undefined) {
          // Either still in flight, or a resolved entry inside the straggler
          // window. Evict-on-access if the cache TTL has elapsed (clock-driven),
          // otherwise reuse the shared future.
          const stamp = resolvedAt.get(accessToken);
          const expired = stamp !== undefined && stamp + cacheTtlMs <= now();
          if (!expired) {
            logger.debug?.(
              { submodule: SUBMODULE, serverName },
              stamp === undefined ? "coalesced into in-flight refresh" : "served from straggler cache",
            );
            return existing;
          }
          evict(accessToken);
        }
        // First caller (or post-TTL): create + store the shared future BEFORE
        // returning it, all within this synchronous critical-section body.
        const p = doRefresh(args);
        inflightRefreshes.set(accessToken, p);
        return p;
      });
      return promise;
    },
  };
}
