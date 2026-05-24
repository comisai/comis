// SPDX-License-Identifier: Apache-2.0
/**
 * Deduped-refresh fetch wrapper — the production 401 path for an
 * `auth:"oauth"` MCP server (Phase 66 OAUTH-05 + the rotation-persistence half
 * of OAUTH-11). Composes ON TOP of the redirect-policy fetch (66-SAFETY-07);
 * the redirect policy stays unchanged and runs INSIDE this wrapper for the
 * initial request + the retry, so cross-host header scrub still applies.
 *
 * ── Why this exists (CR-01) ─────────────────────────────────────────────────
 * `createOAuthClientProvider` accepts a `RefreshDeduper` in its deps but never
 * calls `dedupedRefresh`. The MCP SDK's own `OAuthClientProvider`-aware
 * transport routes a 401 through its internal `auth()` → `refreshAuthorization`
 * call, which BYPASSES the deduper. With N concurrent in-flight tool calls
 * against an expired access token that is the 66-P4 thundering herd:
 *   - N concurrent 401s fire N concurrent refresh POSTs.
 *   - A provider that rotates refresh_token (Notion / 66-P11) invalidates the
 *     N-1 losers, collapsing the token chain into a lockout.
 *   - Even on a non-rotating provider, the token endpoint sees N requests
 *     where 1 suffices (rate-limit risk).
 *
 * This wrapper intercepts the 401 BEFORE the SDK sees it:
 *   1. Read the bearer from the outgoing request's Authorization header — that
 *      IS the EXPIRED access token (the deduper's dedup key).
 *   2. Load the refresh_token + client information + discovery state from the
 *      token store. If any are missing → return the 401 verbatim (the SDK
 *      surfaces `needs_oauth_login` via UnauthorizedError; we cannot refresh
 *      without these inputs).
 *   3. Call `deduper.dedupedRefresh({...})`. The deduper's critical section is
 *      `state.callQueues[serverName]` (the same concurrency-1 PQueue that
 *      serializes tool calls), so N concurrent 401s for the same access token
 *      coalesce into ONE refresh POST and ALL waiters resolve to the same
 *      shared future (OAUTH-05).
 *   4. The deduper's `doRefresh` persists the rotated tokens via
 *     `tokenStore.saveTokens` (66-P11) so the next refresh reads the new
 *      refresh_token off disk and Notion is not locked out.
 *   5. Re-issue the original request with `Authorization: Bearer <new>` and
 *      return that response to the SDK.
 *
 * ── No retry loop (defense-in-depth) ────────────────────────────────────────
 * One refresh + one retry. If the retry STILL returns 401, the wrapper
 * returns it verbatim; the SDK surfaces UnauthorizedError and connectServer
 * tags `needs_oauth_login`. A persistent 401 after a fresh access token is a
 * provider-side issue (revoked tokens, scope mismatch) — re-driving the
 * deduper would just thrash the token endpoint.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * Tokens and Authorization header values are NEVER logged — only the server
 * name, the dedup decision, and the resulting status. Header capture for the
 * retry uses a defensive copy.
 *
 * @module
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { RefreshDeduper } from "./refresh-deduper.js";
import type { TokenStore } from "./token-store.js";

const SUBMODULE = "oauth-deduped-fetch";
const BEARER_PREFIX = "Bearer ";

/** Structural logger — matches the token store / deduper contract. */
interface DedupedFetchLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Per-server inputs for {@link createDedupedRefreshFetch}. */
export interface DedupedRefreshFetchDeps {
  /** Validated server name (token-store key; logged). */
  readonly serverName: string;
  /** Disk-backed token store — read refresh_token/client_info/discovery; persist rotated tokens. */
  readonly tokenStore: TokenStore;
  /** The 401 refresh-deduper (66c) — the shared-future critical section. */
  readonly deduper: RefreshDeduper;
  /** Inner fetch (e.g. {@link createRedirectPolicyFetch}). Required. */
  readonly innerFetch: FetchLike;
  /**
   * Optional `addClientAuthentication` hook (66-P12 Stripe-Account header).
   * Forwarded to `deduper.dedupedRefresh` verbatim — the deduper threads it
   * onto the refresh POST so connected-account providers (Stripe) still work
   * when the rotation happens via the 401 path.
   */
  readonly addClientAuthentication?: (
    headers: Headers,
    params: URLSearchParams,
    url: string | URL,
    metadata?: import("@modelcontextprotocol/sdk/shared/auth.js").AuthorizationServerMetadata,
  ) => void | Promise<void>;
  readonly logger: DedupedFetchLogger;
}

/**
 * Read the bearer from a `RequestInit.headers` value. Returns the access-token
 * portion (without the `Bearer ` prefix), or `undefined` if no Authorization
 * header is present, the scheme is not Bearer, or the value is empty.
 *
 * Accepts Headers | Record<string, string> | array-of-tuples. NEVER logs.
 */
function extractBearer(headersInit: HeadersInit | undefined): string | undefined {
  if (headersInit === undefined) return undefined;
  const headers = new Headers(headersInit);
  const auth = headers.get("authorization") ?? headers.get("Authorization");
  if (auth === null) return undefined;
  if (!auth.startsWith(BEARER_PREFIX)) return undefined;
  const token = auth.slice(BEARER_PREFIX.length).trim();
  return token === "" ? undefined : token;
}

/**
 * Build a fresh `RequestInit` with `Authorization: Bearer <newToken>` replacing
 * any existing Authorization header. All other headers + the body / method /
 * signal pass through unchanged. Defensive header copy so the caller's init is
 * not mutated.
 */
function withRefreshedBearer(
  init: RequestInit | undefined,
  newAccessToken: string,
): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  headers.set("Authorization", `${BEARER_PREFIX}${newAccessToken}`);
  return { ...(init ?? {}), headers };
}

/**
 * Wrap an inner `FetchLike` (typically the redirect-policy fetch) so any 401
 * response triggers a deduped refresh via {@link RefreshDeduper.dedupedRefresh},
 * followed by ONE retry with the rotated bearer. Returns the inner fetch's
 * response verbatim on non-401 status, when no Authorization header is present,
 * when the token store lacks the inputs to refresh, or when the retry still
 * returns 401 (which surfaces `needs_oauth_login` upstream).
 */
export function createDedupedRefreshFetch(deps: DedupedRefreshFetchDeps): FetchLike {
  const { serverName, tokenStore, deduper, innerFetch, addClientAuthentication, logger } = deps;
  return async (input, init) => {
    const response = await innerFetch(input, init);
    if (response.status !== 401) {
      return response;
    }

    // 401 path — try to dedup-refresh. Read the expired access token from the
    // OUTGOING Authorization header (NOT the response): that header is the
    // dedup key. The SDK transport always sets it (the SDK reads tokens()
    // before each request); if the SDK omitted it, we have no key to dedup
    // against and surface the 401 verbatim.
    const expiredAccessToken = extractBearer(init?.headers);
    if (expiredAccessToken === undefined) {
      logger.debug?.(
        { submodule: SUBMODULE, serverName, status: 401 },
        "401 without an outgoing Bearer — cannot dedup-refresh; surfacing",
      );
      return response;
    }

    const [storedTokens, clientInfo, discovery] = await Promise.all([
      tokenStore.tokens(serverName),
      tokenStore.clientInformation(serverName),
      tokenStore.discoveryState(serverName),
    ]);
    const refreshToken = storedTokens?.refresh_token;
    if (
      refreshToken === undefined ||
      clientInfo === undefined ||
      discovery === undefined
    ) {
      // Missing inputs — surface the 401 verbatim. The SDK's auth() would also
      // fail to refresh here (no refresh_token / no discovery); we let
      // connectServer surface needs_oauth_login from the resulting
      // UnauthorizedError.
      logger.debug?.(
        {
          submodule: SUBMODULE,
          serverName,
          status: 401,
          hasRefreshToken: refreshToken !== undefined,
          hasClientInfo: clientInfo !== undefined,
          hasDiscovery: discovery !== undefined,
        },
        "401 path: missing refresh inputs — surfacing 401 for needs_oauth_login",
      );
      return response;
    }

    // CRITICAL: the body has been consumed by `innerFetch`. Cancel it now so
    // the socket can be released before the retry; the SDK does not read 401
    // bodies anyway (it inspects status + WWW-Authenticate).
    await response.body?.cancel().catch(() => undefined);

    // Drive the deduped refresh (66-P4 thundering herd → 1 refresh POST). The
    // deduper persists rotated tokens via tokenStore.saveTokens (66-P11) so a
    // subsequent connect/refresh reads the new refresh_token off disk.
    let refreshed;
    try {
      refreshed = await deduper.dedupedRefresh({
        serverName,
        authServerUrl: discovery.authorizationServerUrl,
        accessToken: expiredAccessToken,
        refreshToken,
        clientInformation: clientInfo,
        ...(addClientAuthentication !== undefined ? { addClientAuthentication } : {}),
      });
    } catch (err) {
      // Refresh itself failed (provider rejected the refresh_token, or 5xx).
      // Surface the original 401 — the SDK reads status + WWW-Authenticate;
      // connectServer surfaces needs_oauth_login from the resulting
      // UnauthorizedError. Log via WARN (the deduper already logged its own
      // failure WARN with the err detail).
      logger.warn(
        {
          submodule: SUBMODULE,
          serverName,
          hint: "OAuth refresh on 401 failed — operator must re-login via `comis mcp login <server>`",
          errorKind: "auth" as const,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "OAuth deduped refresh failed; surfacing 401",
      );
      return response;
    }

    const newAccessToken = refreshed.tokens.access_token;
    if (!newAccessToken) {
      // Provider returned a refresh response without an access_token (spec
      // violation). Surface the 401 — re-trying with an empty bearer would
      // 401 again and could loop.
      logger.warn(
        {
          submodule: SUBMODULE,
          serverName,
          hint: "OAuth refresh returned no access_token — provider spec violation; re-login required",
          errorKind: "auth" as const,
        },
        "OAuth deduped refresh returned no access_token; surfacing 401",
      );
      return response;
    }

    // One retry with the rotated bearer. We intentionally do NOT recurse on a
    // second 401 — a fresh access token that still 401s indicates a provider-
    // side issue (revoked, scope mismatch) the deduper cannot fix. Return that
    // 401 verbatim so the SDK surfaces UnauthorizedError and connectServer
    // tags needs_oauth_login.
    logger.debug?.(
      { submodule: SUBMODULE, serverName },
      "401 path: retrying original request with refreshed bearer",
    );
    return innerFetch(input, withRefreshedBearer(init, newAccessToken));
  };
}
