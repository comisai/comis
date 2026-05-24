// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth connect seam (Phase 66 OAUTH-11 / 66d).
 *
 * Extracted from mcp-client-connect.ts to keep that leaf under the 500-line
 * per-subdirectory cap (the same split rationale as mcp-client-prlimit-probe.ts).
 * connectServer calls {@link prepareOAuthProvider} before building the transport,
 * and tags an UnauthorizedError via {@link tagNeedsOAuthLogin} so the connect
 * path surfaces a `needs_oauth_login` signal rather than auto-launching a browser
 * (resolved_scope #3 / T-66-22).
 *
 * State-first: prepareOAuthProvider takes `state` first (it reads the live
 * per-server callQueue for the deduper critical section + the shared
 * inflightRefreshes map).
 *
 * @module
 */

import PQueue from "p-queue";

import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpServerConfig,
  McpOAuthDeps,
} from "./mcp-client-types.js";
import { createOAuthClientProvider } from "./oauth/provider.js";
import { createRefreshDeduper } from "./oauth/refresh-deduper.js";
import { createDedupedRefreshFetch } from "./oauth/deduped-fetch.js";
import { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";

const MAX_REDIRECTIONS = 20;

/**
 * The `needs_oauth_login` tag. An `auth:"oauth"` server that connects WITHOUT a
 * valid token throws the SDK `UnauthorizedError` from `client.connect`; rather
 * than auto-launching a browser daemon-side (resolved_scope #3 / T-66-22), the
 * connect path returns a tagged `Result.err`. The daemon RPC layer reads the tag
 * to tell the operator to run `comis mcp login <server>` (the explicit,
 * operator-initiated `oauth_login` RPC owns the loopback server + browser dance).
 *
 * The tag is a marker property on the Error (matches the codebase's
 * `Object.assign(new Error, { errorKind })` pattern) so the existing
 * `Result<McpConnection, Error>` signature is unchanged.
 */
export const NEEDS_OAUTH_LOGIN = "needs_oauth_login" as const;
export type NeedsOAuthLoginError = Error & { readonly code: typeof NEEDS_OAUTH_LOGIN };

/** Tag an Error as `needs_oauth_login` (carries an operator-actionable message). */
export function tagNeedsOAuthLogin(serverName: string): NeedsOAuthLoginError {
  const e = new Error(
    `MCP server "${serverName}" requires OAuth login. ` +
      `Run \`comis mcp login ${serverName}\` to authenticate (no browser was launched).`,
  );
  return Object.assign(e, { code: NEEDS_OAUTH_LOGIN });
}

/** Type guard: did connect surface a `needs_oauth_login` signal (vs a generic failure)? */
export function isNeedsOAuthLoginError(error: unknown): error is NeedsOAuthLoginError {
  return (
    error instanceof Error && (error as { code?: unknown }).code === NEEDS_OAUTH_LOGIN
  );
}

/**
 * Build the OAuthClientProvider adapter for an `auth:"oauth"` server and run the
 * 66b discovery pre-flight (cold-load only). Returns a SHALLOW COPY of `config`
 * carrying the provider on the runtime-only `oauthProvider` field so the pure
 * `createTransport` attaches it.
 *
 * NO browser is launched here. Discovery failure throws an actionable
 * `errorKind:"config"` error (66-P9), surfaced by the caller as a normal connect
 * failure.
 */
export async function prepareOAuthProvider(
  state: McpClientManagerState,
  oauthDeps: McpOAuthDeps,
  config: McpServerConfig,
  logger: McpClientManagerDeps["logger"],
): Promise<McpServerConfig> {
  const tokenStore = oauthDeps.createTokenStore();
  // The deduper shares the manager's inflightRefreshes map + the per-server call
  // queue as the concurrency-1 critical section (66-04 left this wiring to 66d):
  // a 401 storm for one server coalesces into a single refresh POST (66-P4). The
  // call queue is created at connect, but the deduper only touches it on a
  // refresh, by which point the connection — and its queue — exist. The critical
  // section binds a LATE lookup of the live per-server callQueue
  // (state.callQueues) rather than a snapshot; a fresh cc-1 queue is the fallback
  // for the transient pre-connect window. The wrapper also normalises PQueue's
  // `Promise<T | Promise<T>>` return to the deduper's `Promise<T>` contract.
  const fallbackQueue = new PQueue({ concurrency: 1 });
  const criticalSection = {
    add<T>(fn: () => Promise<T> | T): Promise<T> {
      const live = state.callQueues.get(config.name) ?? fallbackQueue;
      return live.add(fn) as Promise<T>;
    },
  };
  const deduper = createRefreshDeduper({
    inflightRefreshes: state.inflightRefreshes,
    queue: criticalSection,
    tokenStore,
    logger,
  });

  const provider = createOAuthClientProvider({
    serverName: config.name,
    oauthConfig: config.oauth ?? {},
    tokenStore,
    deduper,
    logger,
  });

  // Pre-flight discovery (OAUTH-03): only when nothing is persisted. resolveDiscovery
  // is itself a warm-load short-circuit, but checking here avoids constructing the
  // redirect-fetch + a network attempt on the warm path and keeps the "discovery
  // runs once on cold load" contract observable.
  const existingDiscovery = await tokenStore.discoveryState(config.name);
  if (!existingDiscovery && config.url !== undefined) {
    await oauthDeps.resolveDiscovery({
      serverName: config.name,
      serverUrl: config.url,
      ...(config.oauth?.authorizationEndpoint !== undefined
        ? { userAuthorizationEndpoint: config.oauth.authorizationEndpoint }
        : {}),
      tokenStore,
      logger,
    });
  }

  // CR-01: build the deduped-refresh fetch wrapper for this server. The SDK
  // transport routes a 401 through its internal `auth()` → `refreshAuthorization`
  // path which BYPASSES the deduper, so this wrapper composes ON TOP of the
  // redirect-policy fetch and intercepts 401 responses BEFORE the SDK sees them.
  // The shared-future deduper (already constructed above with state.callQueues
  // as its critical section) coalesces N concurrent 401s into ONE refresh POST
  // (66-P4) and persists the rotated tokens via tokenStore.saveTokens (66-P11).
  // The hook for the Stripe-Account header on refresh is sourced from the same
  // adapter provider so connected-account auth threads through the 401 path
  // too (66-P12).
  const innerFetch = createRedirectPolicyFetch({ maxRedirections: MAX_REDIRECTIONS });
  const oauthFetch = createDedupedRefreshFetch({
    serverName: config.name,
    tokenStore,
    deduper,
    innerFetch,
    ...(provider.addClientAuthentication !== undefined
      ? { addClientAuthentication: provider.addClientAuthentication }
      : {}),
    logger,
  });

  return { ...config, oauthProvider: provider, oauthFetch };
}
