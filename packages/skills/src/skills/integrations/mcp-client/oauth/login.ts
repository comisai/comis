// SPDX-License-Identifier: Apache-2.0
/**
 * Interactive OAuth login orchestrator.
 *
 * Server-side half of `mcp.oauth_login`. Owns the SDK `auth()` runtime call +
 * the loopback browser-callback + the disk token store so the daemon RPC
 * handler (`mcp-oauth-handlers.ts`) never imports the MCP SDK or `open`
 * directly (the daemon depends on `@comis/skills`, not the SDK).
 *
 * Flow: (1) build token store + provider, (2) pre-flight discovery (cold
 * load — surfaces cascade-fail before any browser step), (3) bind loopback
 * with NO-OP `openUrl` to learn port + headless decision, (4) DEVAUTH-02
 * selection branch: dispatch RFC 8628 device-flow when operator forces it
 * or headless ∧ device-code-advertised, (5) PKCE: drive SDK `auth()` first
 * pass → capture authorization URL → headless returns `headless_hint` +
 * `authUrl` (background task awaits redirect + exchanges code) OR
 * non-headless opens URL CLI-side + awaits code → second `auth()` pass →
 * `AUTHORIZED` → `saveTokens` persists ABSOLUTE-expiresAt tokens.
 *
 * No throw escapes: discovery cascade fail, callback timeout / CSRF,
 * exchange error all return `{ status: "failed" }` with WARN + `errorKind`.
 * Callback server is always closed (success / headless-handoff / failure)
 * so no loopback port lingers.
 *
 * SECURITY: tokens, the PKCE `code_verifier`, the CSRF `state`, the
 * authorization `code`, and the device-flow `device_code` are NEVER logged
 * (Pino redaction is a safety net, not a license). The authorization URL
 * carries `state` — returned to the caller but never logged. The device-flow
 * `verificationUri` + `userCode` are non-secret per RFC 8628 §6.1.
 *
 * @module
 */

import PQueue from "p-queue";
import { randomBytes } from "node:crypto";

import type {
  OAuthClientProvider,
  AuthResult,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createTokenStore, type TokenStore } from "./token-store.js";
import { createRefreshDeduper, type RefreshResult } from "./refresh-deduper.js";
import { createOAuthClientProvider } from "./provider.js";
import { resolveDiscovery } from "./discovery.js";
import { runBrowserCallback, type BrowserCallbackHandle } from "./browser-callback.js";
import { runDeviceFlow as defaultRunDeviceFlow } from "./device-flow.js";
import { createRedirectPolicyFetch } from "../mcp-client-redirect-policy.js";

// Re-export the shared OAuth types from oauth-types.js (split out of this
// file to break the source-level cycle introduced by login.ts ↔ device-flow.ts
// when login.ts gained a value import of runDeviceFlow in plan 09-02).
export type {
  OAuthLoginConfig,
  OAuthLoginLogger,
  OAuthLoginResult,
} from "./oauth-types.js";
import type {
  OAuthLoginConfig,
  OAuthLoginLogger,
  OAuthLoginResult,
} from "./oauth-types.js";

const SUBMODULE = "oauth-login";
const MAX_REDIRECTIONS = 20;

/** Injected dependencies for {@link runOauthLogin} (all side effects are DI'd). */
export interface RunOauthLoginDeps {
  /** Validated server name — the token-store filename key + reconnect target. */
  readonly serverName: string;
  /** The MCP resource-server URL (the `url` from the server config). */
  readonly serverUrl: string;
  /** Per-server OAuth hints (scope / Stripe-Account / authorization endpoint). */
  readonly oauthConfig: OAuthLoginConfig;
  /**
   * Token store factory. Defaults to a `~/.comis/mcp-tokens/` disk store. Tests
   * inject a tmpdir-backed store so the exchanged tokens land in a temp dir.
   */
  readonly createTokenStore?: () => TokenStore;
  /**
   * Browser-launch side effect (the CLI's `open`). Called with the
   * authorization URL on a non-headless host; NEVER called when headless.
   * `open` is not a skills dep — this is always injected.
   */
  readonly openUrl: (url: string) => void;
  /** The SDK `auth()` orchestrator. Defaults to the real SDK fn; tests inject a fake. */
  readonly auth?: typeof sdkAuth;
  /** The loopback callback runner. Defaults to the real one; tests inject a fake. */
  readonly runBrowserCallback?: typeof runBrowserCallback;
  /** DEVAUTH-02: device-flow orchestrator (RFC 8628). Defaults to the real
   *  `runDeviceFlow` from `./device-flow.js`; tests inject a fake. */
  readonly runDeviceFlow?: typeof defaultRunDeviceFlow;
  /** Discovery resolver. Defaults to the real cascade; tests inject a fake. */
  readonly resolveDiscovery?: typeof resolveDiscovery;
  /** Redirect-safe fetch threaded into the SDK auth()/discovery requests. */
  readonly fetchFn?: FetchLike;
  /** Env block for headless detection. Defaults to `process.env` (browser-callback). */
  readonly env?: NodeJS.ProcessEnv;
  /** stdout TTY flag for headless detection. Defaults to `process.stdout.isTTY`. */
  readonly isTTY?: boolean;
  /** Filesystem probe for headless detection. Defaults to `node:fs` `existsSync`. */
  readonly existsSync?: (path: string) => boolean;
  /** Callback timeout in ms. Defaults to the browser-callback's 300s. */
  readonly timeoutMs?: number;
  /**
   * Fired after the headless background task completes the second-pass code
   * exchange and persists tokens. Wired by `mcp-oauth-handlers.ts` to
   * `mcpClientManager.reconnect(serverName)` so the live connection upgrades
   * to the new bearer without an additional RPC round-trip. NEVER invoked on
   * the non-headless path (the caller of `runOauthLogin` already awaits
   * `authorized` synchronously and triggers the reconnect itself). NEVER
   * invoked on a failed exchange. Errors thrown by this hook are caught and
   * logged so a reconnect failure does NOT corrupt the persisted token file.
   */
  readonly onAuthorized?: (serverName: string) => Promise<void> | void;
  readonly logger: OAuthLoginLogger;
}

/**
 * Run one interactive OAuth login for an `auth:"oauth"` MCP server, server-side.
 * Returns a {@link OAuthLoginResult}; NEVER throws. On `authorized`
 * the tokens are already persisted — the caller should reconnect the server.
 */
export async function runOauthLogin(
  deps: RunOauthLoginDeps,
): Promise<OAuthLoginResult> {
  const {
    serverName,
    serverUrl,
    oauthConfig,
    openUrl,
    logger,
  } = deps;
  const authFn = deps.auth ?? sdkAuth;
  const runCallback = deps.runBrowserCallback ?? runBrowserCallback;
  const discover = deps.resolveDiscovery ?? resolveDiscovery;
  const fetchFn = deps.fetchFn ?? createRedirectPolicyFetch({ maxRedirections: MAX_REDIRECTIONS });
  const tokenStore = (deps.createTokenStore ?? (() => createTokenStore({ logger })))();

  // CSRF state — generated here, validated by the callback server,
  // surfaced to the provider via the getState closure. NEVER logged.
  const state = randomBytes(32).toString("hex");

  // The loopback redirect URL becomes known only after the callback server binds.
  // The provider reads it (and the state) through these closures — ONE source of
  // truth shared between the provider's auth() flow and the callback server.
  let redirectUrl: string | undefined;

  // The authorization URL the SDK builds (via startAuthorization) and hands to
  // the provider's redirectToAuthorization. Captured here; opened by the CLI.
  let capturedAuthUrl: string | undefined;

  // The deduper shares a fresh concurrency-1 queue (a standalone login is not in
  // the manager's per-server call path). It is held for parity with the connect
  // path's provider construction; the login flow itself does not 401-refresh.
  const queue = new PQueue({ concurrency: 1 });
  const deduper = createRefreshDeduper({
    inflightRefreshes: new Map<string, Promise<RefreshResult>>(),
    queue: { add: <T>(fn: () => Promise<T> | T): Promise<T> => queue.add(fn) as Promise<T> },
    tokenStore,
    logger,
  });

  const provider: OAuthClientProvider = createOAuthClientProvider({
    serverName,
    oauthConfig,
    tokenStore,
    deduper,
    getRedirectUrl: () => redirectUrl,
    getState: () => state,
    // The adapter's redirectToAuthorization only logs; the SDK's auth() also
    // invokes it, but we wrap below to capture the URL. Pass the same logger.
    logger,
  });

  // The SDK calls provider.redirectToAuthorization(url) on the first auth() pass.
  // Wrap it to capture the URL without altering the adapter's no-launch contract.
  const baseRedirect = provider.redirectToAuthorization.bind(provider);
  const wrappedProvider: OAuthClientProvider = {
    ...provider,
    get redirectUrl(): string | URL | undefined {
      return redirectUrl;
    },
    // CRITICAL: live getter. The spread above evaluates provider.clientMetadata
    // ONCE at spread time (when redirectUrl is undefined) and freezes
    // `{ redirect_uris: [] }` — Higgsfield then 400s DCR with invalid_redirect_uri
    // (RFC 7591). Re-reading on each access pulls the live loopback URL after
    // runBrowserCallback binds (daemon.1.log:865, 2026-05-28).
    get clientMetadata(): OAuthClientMetadata {
      return provider.clientMetadata;
    },
    redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
      capturedAuthUrl = authorizationUrl.toString();
      return baseRedirect(authorizationUrl);
    },
  };

  let handle: BrowserCallbackHandle | undefined;
  // When the headless branch spawns a background task, that task owns the
  // handle's lifecycle (it closes it in its own finally). The outer finally
  // below must skip its close in that case, otherwise the loopback dies
  // before the operator's redirect arrives. See login.test.ts Fix 6 tests.
  let keepHandleOpen = false;
  try {
    // Pre-flight discovery — cold-load only. Surfaces the actionable
    // cascade-fail error before binding the callback server. Capture the
    // resolved state so DEVAUTH-02 below can inspect it (advertised device-
    // flow grant types) and runDeviceFlow can receive it as pre-resolved.
    let discoveryState =
      (await tokenStore.discoveryState(serverName)) ?? undefined;
    if (discoveryState === undefined) {
      discoveryState = await discover({
        serverName,
        serverUrl,
        ...(oauthConfig.authorizationEndpoint !== undefined
          ? { userAuthorizationEndpoint: oauthConfig.authorizationEndpoint }
          : {}),
        tokenStore,
        fetchFn,
        logger,
      });
    }

    // Bind the loopback callback server with a NO-OP openUrl: we only need the
    // port + headless decision now; the real browser open happens AFTER the SDK
    // produces the URL (the callback module opens on listen, so we defer it).
    handle = await runCallback({
      serverName,
      // The SDK builds the real URL; this placeholder is never opened (no-op openUrl).
      authorizationUrl: "",
      state,
      // The verifier lives in the provider's in-memory holder. This field
      // documents memory-only ownership at the callback boundary; the callback
      // never writes or logs it. The SDK sets the real verifier via the
      // provider during auth(); a placeholder is correct here.
      codeVerifier: "",
      openUrl: () => undefined,
      logger,
      ...(deps.env !== undefined ? { env: deps.env } : {}),
      ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
      ...(deps.existsSync !== undefined ? { existsSync: deps.existsSync } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
    redirectUrl = handle.redirectUri;

    // ── DEVAUTH-02: Selection heuristic ─────────────────────────────────
    // Operator override beats heuristic in both directions; heuristic
    // prefers RFC 8628 device-flow when headless ∧ device-code advertised.
    // Falls through to PKCE+loopback by default (existing Fix 6 path).
    const meta = (discoveryState as { authorizationServerMetadata?: Record<string, unknown> } | undefined)
      ?.authorizationServerMetadata;
    const advertisesDeviceFlow =
      typeof meta?.["device_authorization_endpoint"] === "string" ||
      (Array.isArray(meta?.["grant_types_supported"]) &&
        (meta!["grant_types_supported"] as readonly unknown[]).includes(
          "urn:ietf:params:oauth:grant-type:device_code",
        ));
    const operatorFlow = oauthConfig.flow;
    const dispatchDeviceFlow =
      operatorFlow === "device_code" ||
      (operatorFlow !== "auth_code" && handle.headless && advertisesDeviceFlow);
    if (dispatchDeviceFlow) {
      // Device-flow needs no loopback callback — release the port now.
      handle.close();
      keepHandleOpen = false;
      logger.info(
        {
          submodule: SUBMODULE,
          serverName,
          dispatchReason: operatorFlow === "device_code" ? "operator-override" : "headless-advertised",
        },
        "OAuth login: dispatching RFC 8628 device-flow",
      );
      const dispatchRunDeviceFlow = deps.runDeviceFlow ?? defaultRunDeviceFlow;
      return await dispatchRunDeviceFlow({
        serverName,
        serverUrl,
        oauthConfig,
        tokenStore,
        discoveryState: discoveryState as never,
        fetchFn,
        logger,
        ...(deps.onAuthorized !== undefined ? { onAuthorized: deps.onAuthorized } : {}),
      });
    }

    // SDK auth() first pass: DCR + startAuthorization → wrappedProvider's
    // redirectToAuthorization captures the URL into capturedAuthUrl.
    const first: AuthResult = await authFn(wrappedProvider, {
      serverUrl,
      ...(oauthConfig.scope !== undefined ? { scope: oauthConfig.scope } : {}),
      fetchFn,
    });

    if (first !== "REDIRECT" || capturedAuthUrl === undefined) {
      // 'AUTHORIZED' on the first pass means valid tokens already exist (no login
      // needed). Treat as authorized; close the (unused) callback server.
      handle.close();
      if (first === "AUTHORIZED") {
        logger.info(
          { submodule: SUBMODULE, serverName },
          "OAuth login: valid credentials already present — no browser needed",
        );
        return { status: "authorized" };
      }
      // No URL captured on a REDIRECT is a flow bug — fail closed.
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "config" as const },
        "OAuth login: SDK returned REDIRECT without an authorization URL",
      );
      return { status: "failed" };
    }

    const authUrl = capturedAuthUrl;

    // Fix 6 (2026-05-28): Headless host — RPC returns immediately with
    // headless_hint + authUrl; loopback STAYS UP so the operator's eventual
    // redirect can be delivered. Background task handles second-pass exchange
    // (code → tokens → saveTokens → onAuthorized) and closes the handle in
    // its own finally. Pre-fix close() ran before return → dead socket against
    // Higgsfield (daemon.1.log:865).
    if (handle.headless) {
      logger.info(
        { submodule: SUBMODULE, serverName, headless: true },
        "OAuth login: headless host — loopback stays open; background task awaits redirect",
      );
      keepHandleOpen = true;
      // void discards the returned Promise; all failures caught + logged
      // inside the IIFE so nothing escapes as an unhandledRejection.
      const headlessHandle = handle;
      void (async () => {
        try {
          const code = await headlessHandle.waitForCode();
          const second: AuthResult = await authFn(wrappedProvider, {
            serverUrl,
            authorizationCode: code,
            ...(oauthConfig.scope !== undefined ? { scope: oauthConfig.scope } : {}),
            fetchFn,
          });
          if (second !== "AUTHORIZED") {
            logger.warn(
              { submodule: SUBMODULE, serverName, errorKind: "auth" as const },
              "OAuth login (headless background): code exchange did not authorize",
            );
            return;
          }
          logger.info(
            { submodule: SUBMODULE, serverName },
            "OAuth login (headless background): authorized — tokens persisted",
          );
          if (deps.onAuthorized !== undefined) {
            try {
              await deps.onAuthorized(serverName);
            } catch (hookErr) {
              // Tokens are persisted; only the reconnect side-effect failed.
              // Surface a WARN so the operator sees it but do not roll back
              // the saved tokens.
              logger.warn(
                {
                  submodule: SUBMODULE,
                  serverName,
                  err: hookErr instanceof Error ? hookErr : new Error(String(hookErr)),
                  errorKind: "auth" as const,
                  hint: "OAuth tokens persisted but onAuthorized hook (typically mcpClientManager.reconnect) threw; retry mcp.reconnect",
                },
                "OAuth login (headless background): onAuthorized hook failed",
              );
            }
          }
        } catch (bgErr) {
          // waitForCode timeout / CSRF drop / second-pass exchange failure.
          // NEVER log token/verifier/code.
          logger.warn(
            {
              submodule: SUBMODULE,
              serverName,
              err: bgErr instanceof Error ? bgErr : new Error(String(bgErr)),
              errorKind: "auth" as const,
            },
            "OAuth login (headless background): completion failed",
          );
        } finally {
          headlessHandle.close();
        }
      })();
      return {
        status: "headless_hint",
        ...(handle.portForwardHint !== undefined
          ? { portForwardHint: handle.portForwardHint }
          : {}),
        authUrl,
      };
    }

    // Non-headless: open the browser CLI-side via the injected openUrl, then await
    // the callback code. NEVER log the URL (it carries the state param).
    logger.info(
      { submodule: SUBMODULE, serverName, headless: false },
      "OAuth login: opening authorization URL (CLI-side) and awaiting callback",
    );
    openUrl(authUrl);

    const code = await handle.waitForCode();

    // Second auth() pass with the authorization code → exchange → AUTHORIZED.
    // The provider's saveTokens persists the ABSOLUTE-expiresAt tokens.
    const second: AuthResult = await authFn(wrappedProvider, {
      serverUrl,
      authorizationCode: code,
      ...(oauthConfig.scope !== undefined ? { scope: oauthConfig.scope } : {}),
      fetchFn,
    });

    if (second !== "AUTHORIZED") {
      logger.warn(
        { submodule: SUBMODULE, serverName, errorKind: "auth" as const },
        "OAuth login: code exchange did not authorize",
      );
      return { status: "failed", authUrl };
    }

    logger.info(
      { submodule: SUBMODULE, serverName },
      "OAuth login: authorized — tokens persisted",
    );
    return { status: "authorized", authUrl };
  } catch (err) {
    // No throw escapes — all failures return failed. Pass `err` as the OBJECT
    // (Error or wrapper), NOT its `.message` — the Pino serializer reads the
    // canonical `err` field and emits type/message/stack + custom properties;
    // err.message would drop the stack. Mirrors refresh-deduper.ts:274.
    // NEVER log token/verifier/code/device_code.
    logger.warn(
      {
        submodule: SUBMODULE,
        serverName,
        err: err instanceof Error ? err : new Error(String(err)),
        errorKind: "auth" as const,
      },
      "OAuth login failed",
    );
    return {
      status: "failed",
      ...(capturedAuthUrl !== undefined ? { authUrl: capturedAuthUrl } : {}),
    };
  } finally {
    // Release the loopback port — UNLESS the headless branch handed the
    // handle off to a background task that owns its lifecycle (Fix 6). The
    // background task's own finally closes the handle when the redirect
    // arrives, the callback times out, or the exchange fails.
    if (!keepHandleOpen) handle?.close();
  }
}
