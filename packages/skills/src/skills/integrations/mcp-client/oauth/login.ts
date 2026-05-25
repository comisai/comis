// SPDX-License-Identifier: Apache-2.0
/**
 * Interactive OAuth login orchestrator.
 *
 * The server-side half of `mcp.oauth_login`. Owns the SDK `auth()` runtime call
 * + the loopback browser-callback + the disk token store so the daemon RPC
 * handler (`mcp-oauth-handlers.ts`) never imports the MCP SDK or `open`
 * directly (the daemon depends on `@comis/skills`, not the SDK).
 *
 * ── The flow ────────────────────────────────────────────────────────────────
 * The daemon may run on a remote host with no display, so the browser launch is
 * CLI-side. This orchestrator coordinates the server-side steps and RETURNS the
 * authorization URL for the CLI to open:
 *
 *   1. Build the token store + refresh-deduper + the `OAuthClientProvider`
 *      adapter. The provider's `redirectUrl` + `state` are sourced from
 *      closures this orchestrator owns (ONE source of truth).
 *   2. Pre-flight discovery, cold-load only — surfaces the actionable
 *      cascade-fail error before any browser step.
 *   3. Bind the loopback callback server (`runBrowserCallback`) with a NO-OP
 *      `openUrl` to learn the kernel-assigned port + headless decision.
 *      The orchestrator opens the browser itself AFTER the SDK produces the URL,
 *      so the callback module's URL/open coupling does not force the order.
 *   4. Drive the SDK `auth()` orchestrator (first call, no code). It runs DCR +
 *      builds the authorization URL via `startAuthorization` against the
 *      provider's loopback `redirectUrl`, then calls the provider's
 *      `redirectToAuthorization(url)` — captured here into a closure.
 *   5. Headless host → return `headless_hint` + `portForwardHint` + `authUrl`
 *      (the operator forwards the port + opens the URL). Non-headless → call the
 *      injected `openUrl(authUrl)` (the CLI's `open`), still returning `authUrl`.
 *   6. Await the callback code (`waitForCode()`), then `auth({ authorizationCode })`
 *      (second call) → `'AUTHORIZED'` → the provider's `saveTokens` persists the
 *      ABSOLUTE-expiresAt tokens. Return `authorized`.
 *
 * ── No throw escapes ────────────────────────────────────────────────────────
 * Every failure (discovery cascade fail, callback timeout / CSRF, exchange
 * error) is caught and returned as `{ status: "failed" }` with an `errorKind`
 * WARN — the caller surfaces it as an RPC response, never an exception. The
 * callback server is always closed (success / headless-return / failure) so no
 * loopback port lingers.
 *
 * SECURITY: tokens, the PKCE `code_verifier`, the CSRF `state`, and the
 * authorization `code` are NEVER logged at any level (Pino redaction is a safety
 * net, not a license). The authorization URL carries the `state` param, so it is
 * returned to the caller but never logged here.
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
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createTokenStore, type TokenStore } from "./token-store.js";
import { createRefreshDeduper, type RefreshResult } from "./refresh-deduper.js";
import { createOAuthClientProvider } from "./provider.js";
import { resolveDiscovery } from "./discovery.js";
import { runBrowserCallback, type BrowserCallbackHandle } from "./browser-callback.js";
import { createRedirectPolicyFetch } from "../mcp-client-redirect-policy.js";

const SUBMODULE = "oauth-login";
const MAX_REDIRECTIONS = 20;

/** Structural logger — matches the token store / discovery / deduper contract. */
export interface OAuthLoginLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Per-server OAuth hints (a structural subset of `McpServerConfig["oauth"]`).
 * Kept local so this module does not depend on the manager types.
 */
export interface OAuthLoginConfig {
  /** Discovery-cascade fallback authorization-server URL. */
  readonly authorizationEndpoint?: string;
  /** Requested OAuth scope (threaded into clientMetadata + DCR + auth()). */
  readonly scope?: string;
  /** Stripe Connect connected-account id. */
  readonly stripeAccount?: string;
}

/** The login orchestration result returned to the RPC handler. */
export interface OAuthLoginResult {
  /**
   * `authorized` — code exchanged + tokens persisted (the caller reconnects).
   * `headless_hint` — no local browser daemon-side; forward the port + open the
   * URL (`authUrl`) yourself. `failed` — discovery / callback / exchange failed.
   */
  readonly status: "authorized" | "headless_hint" | "failed";
  /** Present on `headless_hint`: `ssh -L <port>:localhost:<port> <vps>`. */
  readonly portForwardHint?: string;
  /**
   * The authorization URL for the CLI to open. Present on
   * `headless_hint` and on the non-headless path (where the daemon already called
   * the injected `openUrl`, the CLI may still surface it).
   */
  readonly authUrl?: string;
}

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
    redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
      capturedAuthUrl = authorizationUrl.toString();
      return baseRedirect(authorizationUrl);
    },
  };

  let handle: BrowserCallbackHandle | undefined;
  try {
    // Pre-flight discovery — cold-load only. Surfaces the actionable
    // cascade-fail error before binding the callback server.
    const existingDiscovery = await tokenStore.discoveryState(serverName);
    if (!existingDiscovery) {
      await discover({
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

    // Drive the SDK auth() orchestrator (first pass, no code). It runs DCR +
    // builds the authorization URL via startAuthorization against redirectUrl,
    // then calls wrappedProvider.redirectToAuthorization(url) (captured above).
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

    // Headless host: do NOT open a browser that isn't there. Return the
    // port-forward hint + the URL for the operator. The callback server stays
    // up (the operator forwards the port + completes the redirect) — the caller's
    // CLI awaits, but the daemon RPC returns the hint immediately and the server
    // is closed here since this RPC does not block for the headless flow.
    if (handle.headless) {
      logger.info(
        { submodule: SUBMODULE, serverName, headless: true },
        "OAuth login: headless host — returning port-forward hint (no daemon browser)",
      );
      handle.close();
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
    // No throw escapes — discovery cascade fail / callback timeout /
    // CSRF drop / exchange error all return failed. NEVER log token/verifier/code.
    //
    // Pass `err` as the OBJECT (Error or fallback wrapper), not its `.message`
    // string. The Pino serializer reads the canonical `err` field and emits
    // `type`/`message`/`stack` plus any custom properties together — logging
    // `err.message` here would discard the stack trace and any attached error
    // metadata (e.g. an `errorKind` on a discovery-cascade error). Mirrors
    // refresh-deduper.ts:274 which already logs `{ ..., err }`.
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
    // Always release the loopback port — idempotent close.
    handle?.close();
  }
}
