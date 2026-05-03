// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth callback route for the Comis gateway (Phase 11 SC11-2/SC11-3/SC11-4).
 *
 * Mounted at `GET /callback/:provider` via `app.route("/oauth", subApp)`. The
 * handler validates code+state, looks up the state in the in-memory pending-
 * flow map, verifies path-vs-flow provider match, deletes the entry BEFORE
 * the token exchange (one-time-use invariant), exchanges the code at
 * auth.openai.com/oauth/token, resolves identity via Phase 7's
 * resolveCodexAuthIdentity, persists via OAuthCredentialStorePort.set, emits
 * auth:profile_bootstrapped, and returns a static "Login Successful" HTML
 * page (200) on success or a "Login Failed" HTML page (400/500) on failure.
 *
 * HTTP method is GET, NOT POST (RESEARCH §Pitfall 5 — OAuth servers always
 * redirect with GET). Logging discipline (CLAUDE.md): module: "oauth-callback"
 * on every line; NEVER log code/state/verifier/access/refresh values.
 *
 * @module
 */

import { Hono } from "hono";
import type {
  OAuthCredentialStorePort,
  OAuthProfile,
  TypedEventBus,
} from "@comis/core";
import {
  resolveCodexAuthIdentity,
  rewriteOAuthError,
  redactEmailForLog,
} from "@comis/agent";
import type { GatewayLogger } from "../server/hono-server.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 5-minute pending-flow expiry (SC11-4). Exported for test parity. */
export const PENDING_FLOW_TIMEOUT_MS = 5 * 60_000;

/** OpenAI Codex token endpoint — same as oauth-token-manager.ts:301. */
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Public OpenAI Codex client_id (NOT a comis secret — per pi-ai source). */
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Redirect URI matches pi-ai device-callback convention (RESEARCH §Pattern 3). */
const OPENAI_CODEX_DEVICE_CALLBACK_URL =
  "https://auth.openai.com/deviceauth/callback";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Pending-flow entry stored in the in-memory map keyed by `state`.
 * Created by insertPendingFlow at flow-initiation time; consumed by the
 * /callback/:provider handler on a successful state-match.
 */
export interface PendingFlow {
  /** PKCE code_verifier generated at flow initiation. */
  verifier: string;
  /** "openai-codex" — used for path-vs-flow provider validation. */
  provider: string;
  /** Date.now() at insertion time. */
  createdAt: number;
  /**
   * Cleanup timer reference. The handler clearTimeout(timer) on consume;
   * the auto-expiry path (PENDING_FLOW_TIMEOUT_MS) deletes the entry.
   */
  timer: ReturnType<typeof setTimeout>;
}

/** Dependencies for createOAuthCallbackRoute. */
export interface OAuthCallbackDeps {
  readonly credentialStore: OAuthCredentialStorePort;
  readonly eventBus: TypedEventBus;
  readonly logger: GatewayLogger;
  /** State -> PendingFlow map; mutated by handler + insertPendingFlow. */
  readonly pendingFlows: Map<string, PendingFlow>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oauthSuccessHtml(message: string): string {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><title>Login Successful</title>',
    "<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;padding:2em;text-align:center;color:#222}h1{color:#0a7d2c}</style>",
    "</head><body><h1>Login Successful</h1>",
    `<p>${escapeHtml(message)}</p>`,
    "<p>You can close this window.</p>",
    "</body></html>",
  ].join("");
}

function oauthErrorHtml(message: string): string {
  return [
    "<!DOCTYPE html>",
    '<html><head><meta charset="utf-8"><title>Login Failed</title>',
    "<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8em auto;padding:2em;text-align:center;color:#222}h1{color:#b00020}</style>",
    "</head><body><h1>Login Failed</h1>",
    `<p>${escapeHtml(message)}</p>`,
    "</body></html>",
  ].join("");
}

/**
 * Exchange an authorization_code at OpenAI's /oauth/token endpoint.
 *
 * Mirrors refreshOpenAICodexTokenLocal (oauth-token-manager.ts:298-385) but
 * uses grant_type=authorization_code with code + code_verifier. Throws on
 * non-OK status; the public boundary catches and routes through
 * rewriteOAuthError.
 */
async function exchangeAuthorizationCode(params: {
  code: string;
  verifier: string;
}): Promise<{ access: string; refresh: string; expires: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
    client_id: OPENAI_CODEX_CLIENT_ID,
    code_verifier: params.verifier,
  });

  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      /* defensive — body read may fail */
    }
    // Surface the wire error verbatim so rewriteOAuthError can detect
    // invalid_grant / unsupported_country_region_territory substrings.
    throw new Error(
      `OAuth token exchange failed: HTTP ${response.status} ${bodyText}`,
    );
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

// ---------------------------------------------------------------------------
// Public boundary
// ---------------------------------------------------------------------------

/**
 * Seed the pending-flow map with a new state -> PendingFlow entry, scheduling
 * a 5-minute auto-delete cleanup timer (SC11-4).
 *
 * The caller is responsible for generating `state` via crypto.randomBytes(16)
 * (see RESEARCH §Pitfall 4 — never hand-roll a PRNG).
 */
export function insertPendingFlow(
  map: Map<string, PendingFlow>,
  state: string,
  flow: Omit<PendingFlow, "timer">,
  logger: GatewayLogger,
): void {
  const timer = setTimeout(() => {
    map.delete(state);
    logger.debug(
      { provider: flow.provider, module: "oauth-callback" },
      "Pending OAuth flow expired",
    );
  }, PENDING_FLOW_TIMEOUT_MS);
  map.set(state, { ...flow, timer });
}

/**
 * Create the OAuth callback Hono sub-app.
 *
 * Mount via:
 *   const app = new Hono();
 *   app.route("/oauth", createOAuthCallbackRoute(deps));
 * Resulting URL: GET /oauth/callback/:provider
 */
export function createOAuthCallbackRoute(deps: OAuthCallbackDeps): Hono {
  const app = new Hono();

  app.get("/callback/:provider", async (c) => {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!state || !code) {
      return c.html(oauthErrorHtml("Missing code or state parameter"), 400);
    }

    const flow = deps.pendingFlows.get(state);
    if (!flow) {
      // No log — stale browser tab is a benign user error (debug-level
      // logging acceptable but not required by tests; keep silent here).
      return c.html(oauthErrorHtml("Invalid or expired state"), 400);
    }

    if (flow.provider !== provider) {
      // Preserve the entry — the legitimate provider's callback may still
      // arrive. RESEARCH §Pattern 3.
      return c.html(oauthErrorHtml("Provider mismatch"), 400);
    }

    // One-time-use: cancel the timer + remove the entry BEFORE the
    // exchange so even a failed exchange does not leave a reusable state.
    clearTimeout(flow.timer);
    deps.pendingFlows.delete(state);

    try {
      const tokens = await exchangeAuthorizationCode({
        code,
        verifier: flow.verifier,
      });

      const identity = resolveCodexAuthIdentity({
        accessToken: tokens.access,
      });
      const identityKey = identity.email ?? identity.profileName;
      if (!identityKey) {
        // Treat as identity_decode_failed; rewriteOAuthError will route
        // the substring "Failed to extract accountId" to the right code.
        throw new Error(
          "Failed to extract accountId — identity decode failed",
        );
      }

      const profileId = `${provider}:${identityKey}`;
      const profile: OAuthProfile = {
        provider,
        profileId,
        access: tokens.access,
        refresh: tokens.refresh,
        expires: tokens.expires,
        email: identity.email,
        displayName: identity.profileName,
        version: 1,
      };

      const writeResult = await deps.credentialStore.set(profileId, profile);
      if (!writeResult.ok) {
        throw new Error(
          `Failed to persist OAuth profile: ${writeResult.error.message}`,
        );
      }

      const identityForEvent =
        redactEmailForLog(identity.email) ??
        identity.profileName ??
        identityKey;

      deps.eventBus.emit("auth:profile_bootstrapped", {
        provider,
        profileId,
        identity: identityForEvent,
        timestamp: Date.now(),
      });

      deps.logger.info(
        {
          provider,
          profileId,
          identity: identityForEvent,
          module: "oauth-callback",
        },
        "Gateway OAuth callback success",
      );

      return c.html(
        oauthSuccessHtml(
          "Login successful — you can close this window and return to Comis.",
        ),
      );
    } catch (caught) {
      const rewritten = rewriteOAuthError(caught);
      deps.logger.warn(
        {
          provider,
          errorKind: rewritten.errorKind,
          hint: rewritten.hint,
          module: "oauth-callback",
        },
        "OAuth callback exchange failed",
      );
      return c.html(oauthErrorHtml(rewritten.userMessage), 500);
    }
  });

  return app;
}
