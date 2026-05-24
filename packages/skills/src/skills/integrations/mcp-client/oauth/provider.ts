// SPDX-License-Identifier: Apache-2.0
/**
 * OAuthClientProvider adapter — the seam between the MCP SDK and Comis storage
 * (Phase 66 OAUTH-11 / 66d).
 *
 * ── Adapter, not protocol (locked decision #2) ──────────────────────────────
 * The MCP SDK ships the entire OAuth 2.1 + PKCE protocol layer (`auth()`,
 * `exchangeAuthorization`, `refreshAuthorization`, discovery, DCR). This module
 * does NOT re-implement any of it. It implements the SDK's `OAuthClientProvider`
 * interface (`@modelcontextprotocol/sdk/client/auth.js`) by delegating its
 * 18-method surface to the three landed glue modules:
 *   - tokens()/saveTokens()                         → token store (66a; <server>.json)
 *   - clientInformation()/saveClientInformation()   → token store (66a; <server>.client.json)
 *   - discoveryState()/saveDiscoveryState()         → token store (66a; <server>.meta.json)
 *   - invalidateCredentials()                       → token store deleteAll (66a; logout / OAUTH-10)
 *   - saveCodeVerifier()/codeVerifier()             → IN-MEMORY closure field (never disk)
 *   - addClientAuthentication()                     → Stripe-Account header (66-P12)
 * The 401 refresh path is owned by `connectServer` (mcp-client-connect.ts), which
 * routes through the 66c refresh-deduper with `state.callQueues` as the
 * concurrency-1 critical section. The deduper itself persists rotated tokens via
 * the same store (66-P11), so saveTokens here is the single absolute-expiresAt
 * write path for both the auth-code exchange AND refresh.
 *
 * ── ABSOLUTE expiry (OAUTH-02 / 66-P3 / T-66-20) ────────────────────────────
 * saveTokens delegates to the store, which computes
 * `expiresAt = now() + expires_in*1000` and persists ONLY the absolute epoch-ms
 * value — the adapter NEVER stores the SDK's relative `expires_in`. The store's
 * compile-time `_NoRelativeExpiry` guard makes a relative-field regression a
 * build error.
 *
 * ── code_verifier in memory only (OAUTH-12 / 66-P5 / T-66-20) ───────────────
 * The PKCE `code_verifier` lives in a closure field for the lifetime of a single
 * in-flight login and is NEVER written to disk. The 3-file token-store scheme has
 * no verifier file. A unit test greps the tmpdir to assert the verifier appears
 * in none of the persisted files; an architecture-grep asserts no `writeRegularFile`
 * / `fs.write*` call here ever takes the verifier.
 *
 * ── Stripe-Account header (OAUTH-11 / 66-P12 / T-66-21) ─────────────────────
 * When `oauthConfig.stripeAccount` is set, `addClientAuthentication` sets the
 * `Stripe-Account` header on the token request. The SDK invokes this hook for
 * BOTH the authorization-code exchange AND the refresh, so a Stripe Connect
 * connected-account context threads through every token POST (Stripe rejects a
 * refresh without it).
 *
 * ── State source-of-truth (OAUTH-08) ────────────────────────────────────────
 * The CSRF `state` parameter is generated and validated by the daemon-side
 * browser-callback (66-05) which owns the loopback server. The adapter defers to
 * the injected `getState` when present (one source of truth) and otherwise omits
 * the optional `state()` method so the SDK generates its own — there is no
 * adapter-local state generation to drift.
 *
 * SECURITY: token values and the PKCE `code_verifier` are NEVER logged at any
 * level (Pino redaction is a safety net, not a license).
 *
 * @module
 */

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  AddClientAuthentication,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { TokenStore } from "./token-store.js";
import type { RefreshDeduper } from "./refresh-deduper.js";

const SUBMODULE = "oauth-provider";
const CLIENT_NAME = "Comis";

/** Structural logger — matches the token store / discovery / deduper contract. */
interface ProviderLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug?(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Per-server OAuth hints sourced from the persisted `McpServerEntry.oauth`.
 * A structural subset of `McpServerConfig["oauth"]` — kept local so this module
 * does not depend on the manager types (avoids a cycle through mcp-client-types).
 */
export interface OAuthProviderConfig {
  /** OAUTH-03 discovery fallback authorization-server URL. */
  readonly authorizationEndpoint?: string;
  /** Requested OAuth scope (threaded into clientMetadata + DCR). */
  readonly scope?: string;
  /** OAUTH-11 / 66-P12 Stripe Connect connected-account id. */
  readonly stripeAccount?: string;
}

/** Dependencies injected into {@link createOAuthClientProvider}. */
export interface OAuthClientProviderDeps {
  /** Validated server name — the token-store filename key. */
  readonly serverName: string;
  /** Per-server OAuth hints (scope / Stripe-Account / authorization endpoint). */
  readonly oauthConfig: OAuthProviderConfig;
  /** Disk-backed token store (66a) — the absolute-expiresAt persistence core. */
  readonly tokenStore: TokenStore;
  /**
   * 401 refresh-deduper (66c). Held for parity / future provider-driven refresh
   * paths; the active 401 path is wired in connectServer with state.callQueues.
   */
  readonly deduper: RefreshDeduper;
  /**
   * Returns the active loopback `http://127.0.0.1:<port>/callback` URL during an
   * interactive login, or `undefined` outside one. The browser-callback (66-05)
   * owns the loopback server, so the redirect URL is closure-held there and
   * surfaced through this getter — keeping ONE source of truth.
   */
  readonly getRedirectUrl?: () => string | URL | undefined;
  /**
   * Returns the CSRF `state` parameter (generated + validated by the
   * browser-callback, 66-05 / OAUTH-08). When omitted, the optional `state()`
   * method is not exposed and the SDK generates its own — no adapter-local
   * state to drift.
   */
  readonly getState?: () => string | Promise<string>;
  readonly logger: ProviderLogger;
}

/**
 * Construct an {@link OAuthClientProvider} adapter for a single MCP server,
 * backed by the disk token store (66a) + refresh-deduper (66c). The
 * `code_verifier` is held in this closure (in memory) and never persisted
 * (OAUTH-12).
 *
 * ~150 LOC of delegation — the protocol is the SDK's (locked decision #2).
 */
export function createOAuthClientProvider(
  deps: OAuthClientProviderDeps,
): OAuthClientProvider {
  const { serverName, oauthConfig, tokenStore, logger } = deps;

  // The PKCE code_verifier for the in-flight login. CLOSURE-held; NEVER written
  // to disk (OAUTH-12 / 66-P5). Reset to undefined after the SDK consumes it via
  // codeVerifier(); a new login overwrites it.
  let codeVerifierHolder: string | undefined;

  /**
   * Stripe-Account threading (66-P12). Defined only when a connected-account id
   * is configured so the SDK's default client-auth applies for non-Stripe
   * providers (the SDK calls this hook INSTEAD of its default when present).
   */
  const addClientAuthentication: AddClientAuthentication | undefined =
    oauthConfig.stripeAccount !== undefined
      ? (headers: Headers): void => {
          // SECURITY: the account id is a non-secret connected-account label, not
          // a token; safe to set as a header. Never logged.
          headers.set("Stripe-Account", oauthConfig.stripeAccount as string);
        }
      : undefined;

  const adapter: OAuthClientProvider = {
    get redirectUrl(): string | URL | undefined {
      return deps.getRedirectUrl?.();
    },

    get clientMetadata(): OAuthClientMetadata {
      const redirect = deps.getRedirectUrl?.();
      // redirect_uris is required by the SDK schema; during a login it is the
      // loopback callback URL. Outside a login (e.g. a pre-flight tokens() read)
      // the SDK does not consult redirect_uris, so an empty list is acceptable.
      const redirectUris = redirect !== undefined ? [String(redirect)] : [];
      return {
        redirect_uris: redirectUris,
        client_name: CLIENT_NAME,
        ...(oauthConfig.scope !== undefined ? { scope: oauthConfig.scope } : {}),
      };
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      return tokenStore.tokens(serverName);
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      // Delegate to the store, which computes the ABSOLUTE expiresAt (OAUTH-02 /
      // 66-P3) and captures a rotated refresh_token (66-P11). The adapter NEVER
      // stores the relative expires_in itself.
      await tokenStore.saveTokens(serverName, tokens);
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      return tokenStore.clientInformation(serverName);
    },

    async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
      // The SDK persists the DCR result (always an OAuthClientInformationFull in
      // the registration flow); the store re-validates the structural minimum.
      await tokenStore.saveClientInformation(
        serverName,
        info as Parameters<TokenStore["saveClientInformation"]>[1],
      );
    },

    // The interactive browser launch is daemon/CLI-side (resolved_scope #1/#3):
    // the loopback server is already listening when auth() reaches this hook, so
    // the adapter records the URL rather than calling open(). connectServer does
    // NOT auto-launch on connect — it surfaces needs_oauth_login (T-66-22).
    redirectToAuthorization(authorizationUrl: URL): void {
      logger.debug?.(
        { submodule: SUBMODULE, serverName, authorizationHost: authorizationUrl.host },
        "OAuth authorization URL ready (operator-initiated login launches the browser)",
      );
    },

    saveCodeVerifier(verifier: string): void {
      // IN-MEMORY only (OAUTH-12 / 66-P5). No disk write path exists for this.
      codeVerifierHolder = verifier;
    },

    codeVerifier(): string {
      if (codeVerifierHolder === undefined) {
        // @allow-throw: the SDK calls codeVerifier() only after saveCodeVerifier()
        // during a single login; a missing verifier is a flow bug the SDK surfaces.
        throw new Error(
          `OAuth code_verifier requested before saveCodeVerifier for server "${serverName}"`,
        );
      }
      return codeVerifierHolder;
    },

    async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
      await tokenStore.saveDiscoveryState(serverName, state);
    },

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
      return tokenStore.discoveryState(serverName);
    },

    async invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ): Promise<void> {
      // The in-memory verifier is always dropped (it is per-login and the SDK
      // requests invalidation when the server rejects credentials).
      if (scope === "all" || scope === "verifier") {
        codeVerifierHolder = undefined;
      }
      // The 3-file store does not separate tokens/client/discovery deletes today
      // (logout clears all three — OAUTH-10). For any disk-backed scope, delete
      // the server's files; the verifier-only scope touches no disk.
      if (scope !== "verifier") {
        await tokenStore.deleteAll(serverName);
      }
    },

    // Stripe-Account threading (66-P12) — present only when configured so the
    // SDK's default client-auth applies for non-Stripe providers.
    ...(addClientAuthentication !== undefined ? { addClientAuthentication } : {}),

    // CSRF state: defer to the browser-callback's generator (OAUTH-08) when
    // injected — ONE source of truth. Omitted otherwise so the SDK self-generates.
    ...(deps.getState !== undefined ? { state: deps.getState } : {}),
  };

  return adapter;
}
