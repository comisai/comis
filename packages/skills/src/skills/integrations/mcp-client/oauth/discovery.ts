// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth 2.1 metadata discovery — the cold-load pre-flight that resolves an MCP
 * server's authorization-server endpoints (Phase 66 OAUTH-03 / 66b).
 *
 * ── Delegation, not hand-rolling (locked decision #2) ───────────────────────
 * Comis NEVER fetches the well-known endpoints itself. The MCP SDK ships the
 * RFC 8414 (authorization-server metadata) + RFC 9728 (protected-resource
 * metadata) + OIDC discovery, schema-validated, with 404→fallback handling:
 *   - `discoverOAuthServerInfo(serverUrl, { fetchFn })` probes RFC 9728 on the
 *     resource server, derives the authorization-server URL (or falls back to
 *     the server URL itself when 9728 is absent — it swallows the 9728 404), then
 *     fetches RFC 8414 / OIDC metadata from that URL. It returns
 *     `authorizationServerMetadata: undefined` (NOT a throw) when 8414+OIDC all
 *     404. This single call covers the first TWO cascade stages (8414 direct, and
 *     8414-via-9728-advertised-auth-server).
 *   - `discoverAuthorizationServerMetadata(url, { fetchFn })` is the explicit
 *     RFC-8414→OIDC fetch used for the THIRD stage (a user-provided authorization
 *     endpoint). It is the non-deprecated form (NOT `discoverOAuthMetadata`).
 * This module adds only the three things the SDK deliberately leaves to the app:
 *   1. the explicit pre-flight ordering (so connect fails fast with a useful
 *      message rather than deep inside the `auth()` orchestrator),
 *   2. the fail-closed actionable error naming every endpoint attempted (66-P9),
 *   3. disk persistence of the resolved metadata to `<server>.meta.json` via the
 *      token store, so subsequent connects skip re-discovery (warm load).
 *
 * ── Cascade (OAUTH-03 / 66-P9) ──────────────────────────────────────────────
 *   warm-load: tokenStore.discoveryState(server) present → return it (no fetch).
 *   stage 1+2: discoverOAuthServerInfo (RFC 8414 direct, else RFC 9728→8414).
 *   stage 3:   user-provided oauth.authorizationEndpoint → discoverAuthorizationServerMetadata.
 *   fail:      throw Error(errorKind:"config") naming the RFC 8414 URL, the RFC
 *              9728 URL, and the user-provided endpoint (value or "unset").
 * A stage is "usable" iff the resolved authorization-server metadata carries a
 * `token_endpoint` — without it no token exchange/refresh is possible, so a
 * partial doc is treated as a miss and the cascade continues.
 *
 * ── Redirect-safe fetch (T-66-08 / SAFETY-07) ───────────────────────────────
 * The caller injects `fetchFn` (default `createRedirectPolicyFetch`). All SDK
 * discovery requests inherit the Phase-63 cross-origin Authorization stripping:
 * a malicious well-known redirect to another host cannot leak credentials.
 *
 * SECURITY: discovery handles metadata only — no tokens or secrets pass through
 * here. Endpoint URLs are logged; token values never are (none are present).
 *
 * @module
 */

import {
  discoverOAuthServerInfo,
  discoverAuthorizationServerMetadata,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { TokenStore } from "./token-store.js";

/** Structural logger — matches the token store's contract. */
interface DiscoveryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/** Inputs to {@link resolveDiscovery}. */
export interface ResolveDiscoveryArgs {
  /** Validated server name (token-store filename key). */
  readonly serverName: string;
  /** The MCP resource server URL (the `url` from the server config). */
  readonly serverUrl: string | URL;
  /**
   * Optional user-configured authorization-server URL
   * (`oauth.authorizationEndpoint`). The last cascade stage before fail-closed.
   */
  readonly userAuthorizationEndpoint?: string | URL;
  /** Disk-backed discovery-state persistence (`<server>.meta.json`). */
  readonly tokenStore: Pick<TokenStore, "discoveryState" | "saveDiscoveryState">;
  /**
   * Redirect-safe fetch threaded into every SDK discovery request (T-66-08).
   * Defaults to `createRedirectPolicyFetch({ maxRedirections: 20 })`.
   */
  readonly fetchFn?: FetchLike;
  readonly logger: DiscoveryLogger;
}

const MAX_REDIRECTIONS = 20;
const SUBMODULE = "oauth-discovery";

/** RFC 8414 well-known path (root-path form, per SDK `buildDiscoveryUrls`). */
const RFC_8414_PATH = "/.well-known/oauth-authorization-server";
/** RFC 9728 well-known path. */
const RFC_9728_PATH = "/.well-known/oauth-protected-resource";

/**
 * Resolve OAuth authorization-server metadata for `serverUrl` with the
 * 8414→9728→user-provided→fail cascade, persisting the result to
 * `<server>.meta.json`. Returns the persisted {@link OAuthDiscoveryState}.
 *
 * @throws An `Error` with `errorKind: "config"` naming all three attempted
 *   endpoints when every discovery path fails (66-P9).
 */
export async function resolveDiscovery(
  args: ResolveDiscoveryArgs,
): Promise<OAuthDiscoveryState> {
  const { serverName, serverUrl, userAuthorizationEndpoint, tokenStore, logger } = args;
  // Lazy default: avoid a top-level import-time dependency on the redirect policy
  // factory; callers in production always pass one, tests may rely on the default.
  const fetchFn = args.fetchFn ?? (await defaultFetchFn());

  // ── Warm load ─────────────────────────────────────────────────────────────
  // A prior connect already persisted the metadata — return it, no network.
  const cached = await tokenStore.discoveryState(serverName);
  if (cached && hasUsableMetadata(cached.authorizationServerMetadata)) {
    logger.debug?.(
      { submodule: SUBMODULE, serverName },
      "OAuth discovery served from persisted <server>.meta.json (warm load)",
    );
    return cached;
  }

  // ── Cold-load stage 1+2: RFC 8414, else RFC 9728→8414 ──────────────────────
  // discoverOAuthServerInfo swallows the 9728 404 (falls back to the server URL
  // as the authorization server) and returns undefined metadata on 8414+OIDC
  // 404 — it does not throw for the well-known cascade, so a usable result here
  // covers both the direct-8414 and the 9728-advertised-auth-server paths.
  const serverInfo = await discoverOAuthServerInfo(serverUrl, { fetchFn });
  if (hasUsableMetadata(serverInfo.authorizationServerMetadata)) {
    const state: OAuthDiscoveryState = { ...serverInfo };
    await tokenStore.saveDiscoveryState(serverName, state);
    logger.info(
      {
        submodule: SUBMODULE,
        serverName,
        authorizationServerUrl: serverInfo.authorizationServerUrl,
      },
      "OAuth discovery resolved via RFC 8414/9728 and persisted",
    );
    return state;
  }

  // ── Cold-load stage 3: user-provided oauth.authorizationEndpoint ────────────
  if (userAuthorizationEndpoint !== undefined) {
    const metadata = await discoverAuthorizationServerMetadata(userAuthorizationEndpoint, {
      fetchFn,
    });
    if (hasUsableMetadata(metadata)) {
      const state: OAuthDiscoveryState = {
        authorizationServerUrl: String(userAuthorizationEndpoint),
        authorizationServerMetadata: metadata,
        // No RFC 9728 resource metadata in the user-provided path.
      };
      await tokenStore.saveDiscoveryState(serverName, state);
      logger.info(
        {
          submodule: SUBMODULE,
          serverName,
          authorizationServerUrl: state.authorizationServerUrl,
        },
        "OAuth discovery resolved via user-provided oauth.authorizationEndpoint and persisted",
      );
      return state;
    }
  }

  // ── Fail-closed (66-P9 / T-66-09) ──────────────────────────────────────────
  // No silent fall-through to a wrong endpoint. Name every endpoint attempted so
  // the operator can see exactly which discovery paths were tried.
  throw makeDiscoveryFailedError(serverName, serverUrl, userAuthorizationEndpoint);
}

/**
 * A discovery result is usable only when it carries a `token_endpoint` — without
 * it no authorization-code exchange or refresh is possible, so a metadata doc
 * lacking it is treated as a cascade miss (not a partial success).
 */
function hasUsableMetadata(
  metadata: AuthorizationServerMetadata | undefined,
): metadata is AuthorizationServerMetadata {
  return metadata !== undefined && typeof metadata.token_endpoint === "string";
}

/**
 * Build the fail-closed `Error` naming all three attempted endpoints (66-P9).
 * Carries `errorKind: "config"` (the failure is a misconfigured / non-conformant
 * provider, not an internal fault).
 */
function makeDiscoveryFailedError(
  serverName: string,
  serverUrl: string | URL,
  userAuthorizationEndpoint: string | URL | undefined,
): Error & { errorKind: "config" } {
  const origin = originOf(serverUrl);
  const url8414 = `${origin}${RFC_8414_PATH}`;
  const url9728 = `${origin}${RFC_9728_PATH}`;
  const userValue =
    userAuthorizationEndpoint !== undefined ? String(userAuthorizationEndpoint) : "unset";
  const message =
    `OAuth discovery failed for ${serverName}: ` +
    `tried RFC 8414 ${url8414}, ` +
    `RFC 9728 ${url9728}, ` +
    `user-provided oauth.authorizationEndpoint (${userValue}). ` +
    `Configure oauth.authorizationEndpoint or verify the server publishes OAuth metadata.`;
  return Object.assign(new Error(message), { errorKind: "config" as const });
}

/** Origin (scheme+host+port) of a URL-ish input; falls back to the raw string. */
function originOf(serverUrl: string | URL): string {
  try {
    return new URL(String(serverUrl)).origin;
  } catch {
    return String(serverUrl);
  }
}

/**
 * Lazily construct the default redirect-safe fetch. Imported on demand so this
 * module has no import-time coupling to the redirect-policy factory (and tests
 * that always inject `fetchFn` never load it).
 */
async function defaultFetchFn(): Promise<FetchLike> {
  const { createRedirectPolicyFetch } = await import("../mcp-client-redirect-policy.js");
  return createRedirectPolicyFetch({ maxRedirections: MAX_REDIRECTIONS });
}
