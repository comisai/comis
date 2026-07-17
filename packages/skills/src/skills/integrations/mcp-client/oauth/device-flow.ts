// SPDX-License-Identifier: Apache-2.0
// @allow-throw: internal helpers (requestDeviceAuthorization, ensureClientRegistration) throw at their own function boundaries; the public runDeviceFlow boundary catches and translates to OAuthLoginResult. Mirrors oauth-device-code.ts:2 precedent. NEVER logs device_code at any level.
/**
 * RFC 8628 OAuth device-authorization grant for headless / VPS deployments.
 *
 * Companion to login.ts: device-flow runs when the daemon's host cannot reach
 * 127.0.0.1:<port>/callback (VPS deployment). Returns synchronously with
 * `device_code_pending` + verification fields so the agent surfaces them via
 * the `message` tool; the polling loop runs in a background task. On
 * AUTHORIZED the onAuthorized hook fires manager.connect (Fix 8) →
 * notifyOperatorChannel (Fix 9), unchanged from the PKCE path.
 *
 * Discovery cascade:
 *   1. oauthConfig.deviceAuthorizationEndpoint operator override (PRIORITY —
 *      required: Higgsfield's fnf-device-auth.higgsfield.ai returns 404 on
 *      every probed RFC 8414 / OIDC well-known path, 2026-05-28).
 *   2. discoveryState.authorizationServerMetadata.device_authorization_endpoint
 *      (loose-passthrough — SDK metadata schema is `z.core.$loose`).
 *   3. fail-closed `errorKind: "config"` naming the operator escape hatch.
 *
 * The public boundary NEVER throws: discovery failure, terminal codes
 * (access_denied, expired_token), and deadline overrun return
 * `{ status: "failed" }` with a WARN log. Internal helpers may throw; the
 * outer try/catch translates.
 *
 * Sanctioned-root system-time: `systemNowMs` / `systemSleep` from `@comis/core`
 * — no bare Date.now() / setTimeout. Tests inject `nowMs` / `sleep` seams.
 *
 * SECURITY: `device_code` is bearer-equivalent for the polling round-trip and
 * is closure-only — NEVER logged at any level. The
 * cross-origin `createRedirectPolicyFetch` strips Authorization on redirect
 * (reused from PKCE path).
 *
 * @module
 */

import { registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { systemNowMs, systemSleep } from "@comis/core";

import type { TokenStore } from "./token-store.js";
import type { OAuthLoginConfig, OAuthLoginLogger, OAuthLoginResult } from "./oauth-types.js";
import { createRedirectPolicyFetch } from "../mcp-client-redirect-policy.js";

const SUBMODULE = "oauth-device-flow";
const MAX_REDIRECTIONS = 20;
/** RFC 8628 §3.5 — `slow_down` MUST add EXACTLY 5 seconds (spec verbatim). */
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** Defensive floor when provider returns `interval <= 0` (spec-violating). */
const MIN_POLL_MS = 1_000;
/** RFC 8628 §3.5 default polling interval when `interval` omitted. */
const DEFAULT_POLL_MS = 5_000;
/** RFC 8628 §3.4 grant-type literal (NOT the deprecated pre-RFC value). */
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Re-exports OAuthLoginLogger as DeviceFlowLogger alias for symmetry with login.ts. */
export type DeviceFlowLogger = OAuthLoginLogger;

/** Per-server OAuth hints extended with the RFC 8628 operator escape hatch. */
export interface DeviceFlowOAuthConfig extends OAuthLoginConfig {
  /**
   * Cascade fallback for RFC 8628 device-authorization: operator-supplied
   * device-authorization endpoint URL used when the resolved authorization-
   * server metadata does not surface `device_authorization_endpoint`. Wins
   * over the auto-resolved endpoint when both are present.
   */
  readonly deviceAuthorizationEndpoint?: string;
}

/** Injected dependencies for {@link runDeviceFlow} (all side effects DI'd). */
export interface RunDeviceFlowDeps {
  /** Validated server name — token-store filename key + reconnect target. */
  readonly serverName: string;
  /** MCP resource-server URL (the `url` from the server config). */
  readonly serverUrl: string;
  /** Per-server OAuth hints (scope / Stripe-Account / authorization endpoint / device endpoint). */
  readonly oauthConfig: DeviceFlowOAuthConfig;
  /** Disk-backed token store. */
  readonly tokenStore: TokenStore;
  /** Pre-resolved discovery state (plan 02's runOauthLogin pipes this through). */
  readonly discoveryState: OAuthDiscoveryState;
  /** Redirect-safe fetch. Defaults to createRedirectPolicyFetch({maxRedirections: 20}). */
  readonly fetchFn?: FetchLike;
  /** Structural logger contract (matches OAuthLoginLogger). */
  readonly logger: DeviceFlowLogger;
  /**
   * Fired after the background polling task persists tokens. Wired by
   * mcp-oauth-handlers.ts (plan 02) to mcpClientManager.connect. NEVER fires
   * on a failed exchange. Hook errors are caught and logged so a reconnect
   * failure does NOT corrupt the persisted token file.
   */
  readonly onAuthorized?: (serverName: string) => Promise<void> | void;
  /** Test seam — defaults to systemNowMs (sanctioned-root). */
  readonly nowMs?: () => number;
  /** Test seam — defaults to systemSleep (sanctioned-root). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Internal device-authorization response shape (parsed from RFC 8628 §3.2). */
interface DeviceAuthorizationResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly intervalMs: number;
}

/**
 * Run one RFC 8628 device-authorization grant. Returns synchronously with
 * `device_code_pending` + verification fields; the polling loop runs in a
 * background task. NEVER throws — failures return `{ status: "failed" }`.
 */
export async function runDeviceFlow(deps: RunDeviceFlowDeps): Promise<OAuthLoginResult> {
  const { serverName, oauthConfig, tokenStore, discoveryState, logger } = deps;
  const fetchFn = deps.fetchFn ?? createRedirectPolicyFetch({ maxRedirections: MAX_REDIRECTIONS });
  const nowMs = deps.nowMs ?? systemNowMs;
  const sleep = deps.sleep ?? systemSleep;

  try {
    // 1. Resolve the device-authorization endpoint via the two-stage cascade.
    //    Operator override wins. Fail-closed
    //    with errorKind:"config" if neither stage yields a value — the
    //    operator's actionable next step is to set
    //    oauth.deviceAuthorizationEndpoint in ~/.comis/config.yaml.
    const deviceAuthEndpoint = resolveDeviceAuthEndpoint({ oauthConfig, discoveryState });
    if (deviceAuthEndpoint === undefined) {
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "config" as const,
          hint: "Set oauth.deviceAuthorizationEndpoint in ~/.comis/config.yaml, or use a provider that publishes RFC 8414 metadata with device_authorization_endpoint" },
        "Device-flow discovery failed: no device_authorization_endpoint resolved",
      );
      return { status: "failed" };
    }

    // 2. DCR — shares <server>.client.json with the PKCE path. This may need
    //    to split into a separate registration if Higgsfield's device-auth
    //    server returns `unauthorized_client`.
    const clientInfo = await ensureClientRegistration({
      serverName,
      discoveryState,
      tokenStore,
      fetchFn,
      oauthConfig,
    });

    // 3. Device-authorization POST (RFC 8628 §3.1).
    const deviceAuth = await requestDeviceAuthorization({
      fetchFn,
      deviceAuthorizationEndpoint: deviceAuthEndpoint,
      clientId: clientInfo.client_id,
      ...(oauthConfig.scope !== undefined ? { scope: oauthConfig.scope } : {}),
    });
    logger.info(
      { submodule: SUBMODULE, serverName, expiresIn: deviceAuth.expiresIn, intervalMs: deviceAuth.intervalMs },
      "Device authorization granted; awaiting operator authorization",
    );

    // 4. Resolve the token endpoint from the pre-resolved discovery state.
    //    Without it no poll is possible — fail-closed.
    const tokenEndpoint = extractTokenEndpoint(discoveryState);
    if (tokenEndpoint === undefined) {
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "config" as const,
          hint: "discoveryState.authorizationServerMetadata.token_endpoint is missing — the discovery cascade must surface a token endpoint before runDeviceFlow can poll" },
        "Device-flow setup failed: no token_endpoint resolved",
      );
      return { status: "failed" };
    }

    // 5. Spawn background polling task (Fix 6 mirror). The synchronous
    //    return carries `device_code_pending` +
    //    verification fields so the agent can deliver them BEFORE polling
    //    completes. All failures inside the IIFE are caught + WARN-logged.
    const deadlineMs = nowMs() + deviceAuth.expiresIn * 1000;
    const deviceCode = deviceAuth.deviceCode; // Captured in closure ONLY — never logged.
    const clientId = clientInfo.client_id;
    void (async () => {
      try {
        const pollResult = await pollDeviceCode({
          fetchFn, tokenEndpoint, deviceCode, clientId,
          initialIntervalMs: deviceAuth.intervalMs, deadlineMs, nowMs, sleep, logger, serverName,
        });
        // pollDeviceCode already emitted its own WARN with errorKind+hint
        // describing the terminal cause; no double-log here.
        if (pollResult.status !== "authorized") return;
        await tokenStore.saveTokens(serverName, pollResult.tokens);
        logger.info({ submodule: SUBMODULE, serverName }, "Device-flow authorized: tokens persisted");
        if (deps.onAuthorized !== undefined) {
          try {
            await deps.onAuthorized(serverName);
          } catch (hookErr) {
            logger.warn(
              { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
                err: hookErr instanceof Error ? hookErr : new Error(String(hookErr)),
                hint: "OAuth tokens persisted but onAuthorized (typically mcpClientManager.connect) threw; retry mcp.reconnect" },
              "Device-flow background: onAuthorized hook failed",
            );
          }
        }
      } catch (bgErr) {
        logger.warn(
          { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
            err: bgErr instanceof Error ? bgErr : new Error(String(bgErr)),
            hint: "Device-flow background task threw; check token endpoint reachability and retry mcp_login" },
          "Device-flow background: completion failed",
        );
      }
    })();

    // Sync return: device_code_pending lives in OAuthLoginResult.status
    // (the union was widened to add it). The 3 new optional fields land here;
    // the agent surfaces verificationUri + userCode to the operator via the
    // `message` tool. The background polling task (above) drives saveTokens
    // + onAuthorized on success — that path returns nothing (fire-and-forget).
    return {
      status: "device_code_pending" as const,
      verificationUri: deviceAuth.verificationUri,
      userCode: deviceAuth.userCode,
      expiresIn: deviceAuth.expiresIn,
    };
  } catch (err) {
    // No throw escapes — log the Error OBJECT so the Pino serializer can
    // emit type/message/stack/custom-fields together (matches login.ts:438).
    logger.warn(
      { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
        err: err instanceof Error ? err : new Error(String(err)),
        hint: "Device-flow initialization failed; retry mcp_login" },
      "Device-flow failed",
    );
    return { status: "failed" };
  }
}

// ── Internal helpers (file-level @allow-throw covers these) ───────────────

/**
 * Two-stage discovery cascade for the device-authorization endpoint. Operator
 * override (oauth.deviceAuthorizationEndpoint) wins over the loose-passthrough
 * `device_authorization_endpoint` field on the resolved authorization-server
 * metadata. Returns `undefined` when neither stage yields a value (caller
 * fails-closed with `errorKind: "config"`).
 */
function resolveDeviceAuthEndpoint(args: {
  oauthConfig: { readonly deviceAuthorizationEndpoint?: string };
  discoveryState: OAuthDiscoveryState;
}): string | undefined {
  if (args.oauthConfig.deviceAuthorizationEndpoint !== undefined) {
    return args.oauthConfig.deviceAuthorizationEndpoint;
  }
  const meta = args.discoveryState.authorizationServerMetadata as
    | Record<string, unknown>
    | undefined;
  const auto = meta?.["device_authorization_endpoint"];
  return typeof auto === "string" ? auto : undefined;
}

/** Extract `token_endpoint` from discoveryState. Returns `undefined` if absent. */
function extractTokenEndpoint(discoveryState: OAuthDiscoveryState): string | undefined {
  const meta = discoveryState.authorizationServerMetadata as
    | Record<string, unknown>
    | undefined;
  const t = meta?.["token_endpoint"];
  return typeof t === "string" ? t : undefined;
}

/**
 * Return cached client information when present; otherwise register a new
 * client via RFC 7591 DCR with `grant_types: ["urn:...:device_code"]` and
 * persist via `tokenStore.saveClientInformation`. Throws on registration
 * failure (caught at the public boundary).
 */
async function ensureClientRegistration(args: {
  serverName: string;
  discoveryState: OAuthDiscoveryState;
  tokenStore: TokenStore;
  fetchFn: FetchLike;
  oauthConfig: OAuthLoginConfig;
}): Promise<OAuthClientInformationFull> {
  const cached = await args.tokenStore.clientInformation(args.serverName);
  if (cached !== undefined) return cached;
  const metadata: OAuthClientMetadata = {
    client_name: "comis-mcp-client",
    grant_types: [DEVICE_CODE_GRANT_TYPE],
    token_endpoint_auth_method: "none",
    redirect_uris: [],
    ...(args.oauthConfig.scope !== undefined ? { scope: args.oauthConfig.scope } : {}),
  } as OAuthClientMetadata;
  const registered = await registerClient(args.discoveryState.authorizationServerUrl, {
    clientMetadata: metadata,
    fetchFn: args.fetchFn,
  });
  await args.tokenStore.saveClientInformation(args.serverName, registered);
  return registered;
}

/**
 * Send the RFC 8628 §3.1 device-authorization POST and parse the §3.2
 * response. Throws when the response is not 200 OK or required fields are
 * missing (caught at the public boundary).
 */
async function requestDeviceAuthorization(args: {
  fetchFn: FetchLike;
  deviceAuthorizationEndpoint: string;
  clientId: string;
  scope?: string;
}): Promise<DeviceAuthorizationResponse> {
  const params: Record<string, string> = { client_id: args.clientId };
  if (args.scope !== undefined) params.scope = args.scope;
  const body = new URLSearchParams(params).toString();
  const response = await args.fetchFn(args.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `device-authorization request failed: HTTP ${response.status}`,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  const expiresIn = Number(json.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("device-authorization response missing or invalid expires_in");
  }
  // RFC 8628 §3.5: `interval` MISSING → default to 5 seconds (DEFAULT_POLL_MS).
  // `interval` PRESENT but <= 0 (spec-violating) → clamp UP to MIN_POLL_MS so
  // the polling loop never busy-loops. Tests pin both behaviors separately.
  const intervalProvided = typeof json.interval === "number" && Number.isFinite(json.interval);
  const intervalMs = intervalProvided
    ? Math.max(MIN_POLL_MS, (json.interval as number) * 1000)
    : DEFAULT_POLL_MS;
  const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
  const userCode = typeof json.user_code === "string" ? json.user_code : "";
  const verificationUri =
    typeof json.verification_uri === "string" ? json.verification_uri : "";
  if (deviceCode === "" || userCode === "" || verificationUri === "") {
    throw new Error(
      "device-authorization response missing required fields (device_code, user_code, or verification_uri)",
    );
  }
  const verificationUriComplete =
    typeof json.verification_uri_complete === "string"
      ? json.verification_uri_complete
      : undefined;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(verificationUriComplete !== undefined ? { verificationUriComplete } : {}),
    expiresIn,
    intervalMs,
  };
}

/**
 * RFC 8628 §3.5 polling loop. Switches on HTTP status BEFORE inspecting the
 * body so a Cloudflare-style 502 with HTML body cannot reach the terminal
 * branch. Returns synchronously without
 * throwing — terminal codes + deadline overrun return `{status: "failed"}`.
 */
async function pollDeviceCode(args: {
  fetchFn: FetchLike;
  tokenEndpoint: string;
  deviceCode: string;
  clientId: string;
  initialIntervalMs: number;
  deadlineMs: number;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  logger: DeviceFlowLogger;
  serverName: string;
}): Promise<{ status: "authorized"; tokens: OAuthTokens } | { status: "failed" }> {
  let intervalMs = args.initialIntervalMs;
  const { serverName, logger } = args;
  while (args.nowMs() < args.deadlineMs) {
    await args.sleep(intervalMs);
    let response: Response;
    try {
      response = (await args.fetchFn(args.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          device_code: args.deviceCode,
          client_id: args.clientId,
        }).toString(),
      })) as Response;
    } catch (netErr) {
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "dependency" as const,
          err: netErr instanceof Error ? netErr : new Error(String(netErr)),
          hint: "Token endpoint network error; continuing per RFC 8628 §3.5" },
        "Device-flow poll: network error",
      );
      continue;
    }
    if (response.ok) {
      const tokens = (await response.json()) as OAuthTokens;
      return { status: "authorized", tokens };
    }
    if (response.status >= 500) {
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "dependency" as const,
          httpStatus: response.status,
          hint: "Token endpoint returned 5xx; continuing per RFC 8628 §3.5" },
        "Device-flow poll: provider 5xx",
      );
      continue;
    }
    // RFC 8628 §3.5: HTTP 400 with JSON {error, error_description?}. Malformed
    // body is treated as unknown provider error and continues polling.
    let errBody: { error?: string } = {};
    try { errBody = (await response.json()) as { error?: string }; } catch { /* swallow */ }
    switch (errBody.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += SLOW_DOWN_INCREMENT_MS;
        logger.info(
          { submodule: SUBMODULE, serverName, intervalMs },
          "Device-flow poll: slow_down adjustment applied per RFC 8628 §3.5",
        );
        continue;
      case "access_denied":
        logger.warn(
          { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
            hint: "Operator denied authorization at the verification URL; retry mcp_login if intended" },
          "Device-flow poll: access_denied (terminal)",
        );
        return { status: "failed" };
      case "expired_token":
        logger.warn(
          { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
            hint: "device_code expired before operator authorized; retry mcp_login" },
          "Device-flow poll: expired_token (terminal)",
        );
        return { status: "failed" };
      default:
        logger.warn(
          { submodule: SUBMODULE, serverName, errorKind: "dependency" as const,
            providerErrorPresent: typeof errBody.error === "string" && errBody.error.length > 0,
            hint: "Provider returned unexpected error code; continuing per RFC 8628 §3.5 best-effort" },
          "Device-flow poll: unexpected provider error",
        );
        continue;
    }
  }
  // Deadline reached.
  logger.warn(
    { submodule: SUBMODULE, serverName, errorKind: "auth" as const,
      hint: "No operator action within expires_in window; retry mcp_login" },
    "Device-flow poll: deadline elapsed without authorization",
  );
  return { status: "failed" };
}
