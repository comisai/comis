// SPDX-License-Identifier: Apache-2.0
/**
 * Mock OAuth server fixture for integration tests.
 *
 * In-process HTTP server that emulates OpenAI Codex's `POST /oauth/token`
 * endpoint so tests can exercise `OAuthTokenManager` refresh flows without
 * reaching `https://auth.openai.com`.
 *
 * Usage:
 *   const mock = createMockOAuthServer();
 *   const { baseUrl } = await mock.start();
 *   // Redirect pi-ai's fetch to baseUrl via `vi.spyOn(global, "fetch")` —
 *   // this fixture does NOT patch globalThis.fetch itself; the test owns
 *   // that indirection so different tests can intercept (or not) as needed.
 *   ...
 *   await mock.stop();
 *
 * Default response (when `setNextResponse` not called) matches the OpenAI
 * Codex token-endpoint contract:
 *   { access_token: <RS256 JWT>, refresh_token: <hex>, expires_in: 3600 }
 *
 * Security posture (T-MOCK-EXPOSED-PORT): binds to 127.0.0.1 only — never
 * 0.0.0.0 — so the mock is unreachable from the LAN. Kernel allocates the
 * port via `server.listen(0)` to avoid port-collision races.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

export interface MockOAuthServer {
  /** Listen on 127.0.0.1 with a kernel-allocated port. Returns the bound URL. */
  start(): Promise<{ port: number; baseUrl: string }>;
  /** Stop the server and release the port. Safe to call when not started. */
  stop(): Promise<void>;
  /** Total request count, optionally filtered by grant_type. Returns 0 for unseen types. */
  getRequestCount(grantType?: string): number;
  /** Captured inbound LLM requests. Returns array in arrival order. */
  getLlmRequests(): ReadonlyArray<{ authorization: string; accountId: string; body: string }>;
  /** Configure the next single response (status defaults to 200). Consumed once. */
  setNextResponse(opts: { status?: number; body: object }): void;
  /** Configure how many 403 responses the device-code poll emits before success. Default: 2. */
  setDeviceCodePollsUntilSuccess(count: number): void;
  /**
   * Phase 66 (66-P11 Notion): when true, every `POST /token`
   * grant_type=refresh_token issues a DIFFERENT refresh_token AND invalidates
   * the presented one — re-presenting a rotated token is rejected 400. Default:
   * false (refresh_token is stable, mirroring providers that do not rotate).
   */
  setRotateRefreshToken(rotate: boolean): void;
  /**
   * Phase 66 (OAUTH-05): count of `POST /token` grant_type=refresh_token
   * requests since the last reset(). Separate from the legacy
   * getRequestCount() so the OAUTH-05 dedup stress test (100 concurrent → 1
   * refresh) is unambiguous. NOT incremented by the legacy /oauth/token route.
   */
  getRefreshCount(): number;
  /**
   * Phase 66 (66-P12 Stripe): per-request capture of `POST /token` traffic in
   * arrival order — grant_type + the inbound `Stripe-Account` header (empty
   * string when absent). Cleared by reset().
   */
  getTokenRequests(): ReadonlyArray<{ grantType: string; stripeAccount: string }>;
  /** Reset counters and any queued response. Call between tests. */
  reset(): void;
}

/**
 * Build a realistic-shape JWT for the default token response. The signature is
 * a literal placeholder — tests do NOT verify signatures. Payload defaults match
 * a plausible OpenAI Codex access token (1h expiry, profile email, account id).
 *
 * Per-call nonce (`jti`): two issuances within the same event-loop turn both
 * have the same `exp` second, which would otherwise yield IDENTICAL JWTs. The
 * full-cycle integration roundtrip (test/integration/mcp-oauth-roundtrip.test.ts)
 * asserts that an access token CHANGES across a refresh, so each issuance must
 * be unique. The `jti` is RFC 7519 standard (JWT ID) and ignored by all the
 * existing tests' assertions, so this is backward-compatible.
 */
function makeRealisticJwt(payloadOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const defaultPayload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/profile": { email: "user_a@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
    jti: randomBytes(16).toString("hex"),
    ...payloadOverrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(defaultPayload)).toString("base64url");
  return `${header}.${payloadB64}.fake-signature`;
}

export function createMockOAuthServer(): MockOAuthServer {
  let server: Server | undefined;
  const requestCounts = new Map<string, number>();
  // Per-request capture log for the /codex/responses LLM route.
  // Each entry records the inbound Authorization + chatgpt-account-id headers
  // plus the raw request body, in arrival order. Cleared by reset().
  const llmRequests: Array<{ authorization: string; accountId: string; body: string }> = [];
  let nextResponse: { status: number; body: object } | undefined;
  // Device-code polling state. deviceCodePollCount counts how many
  // POSTs to /api/accounts/deviceauth/token have arrived since the last reset();
  // deviceCodePollsUntilSuccess controls how many 403 responses the handler
  // emits before flipping to 200 with the authorization_code + code_verifier.
  // Default of 2 means polls 1 and 2 are 403; poll 3 is 200.
  let deviceCodePollCount = 0;
  let deviceCodePollsUntilSuccess = 2;

  // Phase 66 OAuth 2.1 surface state (POST /token + discovery/DCR/authorize).
  // Kept SEPARATE from the legacy /oauth/token requestCounts so the two routes
  // never cross-contaminate each other's counters (the legacy Codex tests count
  // /oauth/token via getRequestCount; the new flow counts /token via
  // getRefreshCount + getTokenRequests).
  let refreshCount = 0;
  let rotateRefreshToken = false;
  // Per-request capture for /token: grant_type + Stripe-Account header.
  const tokenRequests: Array<{ grantType: string; stripeAccount: string }> = [];
  // When rotation is enabled, refresh_tokens issued so far that have since been
  // rotated OUT (re-presenting one is a 400 — the Notion lockout scenario).
  const rotatedOutRefreshTokens = new Set<string>();
  // The set of refresh_tokens currently considered VALID under rotation. Seeded
  // lazily: any token presented while not in rotatedOutRefreshTokens is honoured
  // once, then rotated out. This models "present a token → get a new one → the
  // old one is dead".
  function issueAccessToken(): string {
    return makeRealisticJwt();
  }
  function issueRefreshToken(): string {
    return randomBytes(32).toString("hex");
  }

  // Token endpoint contract:
  // This handler serves BOTH grant_type=refresh_token AND
  // grant_type=authorization_code (login flow). The response
  // shape is identical — pi-ai's loginOpenAICodex and refreshOpenAICodexToken
  // both expect {access_token, refresh_token, expires_in}. Per-grant-type
  // queueing via setNextResponse already works (the response is consulted
  // once per request regardless of grant_type). Integration tests
  // assert flow distinction via getRequestCount('authorization_code') vs
  // getRequestCount('refresh_token').
  function handler(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    req.on("end", () => {
      // LLM endpoint capture for evidence.
      // Match BEFORE the urlencoded body parse so /codex/responses traffic
      // never touches the token-endpoint counters.
      if (req.url?.startsWith("/codex/responses")) {
        const authHeader = req.headers.authorization;
        const accountHeader = req.headers["chatgpt-account-id"];
        llmRequests.push({
          authorization: typeof authHeader === "string" ? authHeader : "",
          accountId: typeof accountHeader === "string" ? accountHeader : "",
          body,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        // Minimal SSE payload so pi-ai's processStream consumer terminates
        // cleanly. The double-newline is the standard SSE message terminator.
        res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
        return;
      }

      // Device-code usercode request endpoint.
      // Match BEFORE the urlencoded body parse so device-code POSTs never
      // touch the /oauth/token grant_type counters.
      if (req.url?.startsWith("/api/accounts/deviceauth/usercode")) {
        requestCounts.set(
          "deviceauth/usercode",
          (requestCounts.get("deviceauth/usercode") ?? 0) + 1,
        );
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            device_auth_id: "mock-device-auth-id",
            user_code: "TEST-1234",
            interval: 1,
          }),
        );
        return;
      }

      // Device-code poll endpoint.
      // Returns 403 (authorization_pending) deviceCodePollsUntilSuccess times,
      // then 200 with the authorization_code + code_verifier on the following
      // poll. Counters track total deviceauth/token requests for assertions.
      if (req.url?.startsWith("/api/accounts/deviceauth/token")) {
        requestCounts.set(
          "deviceauth/token",
          (requestCounts.get("deviceauth/token") ?? 0) + 1,
        );
        deviceCodePollCount++;
        if (deviceCodePollCount <= deviceCodePollsUntilSuccess) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "authorization_pending" }));
        } else {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              authorization_code: "mock-auth-code",
              code_verifier: "mock-code-verifier",
            }),
          );
        }
        return;
      }

      // -----------------------------------------------------------------------
      // Phase 66 OAuth 2.1 surface. Matched BEFORE the legacy /oauth/token
      // fallthrough so the new /token route (and discovery/DCR/authorize) never
      // touches the legacy grant counters. `selfBaseUrl` reconstructs this
      // server's own origin from the bound port so discovery points at self.
      // -----------------------------------------------------------------------
      const selfBaseUrl =
        server !== undefined ? `http://127.0.0.1:${(server.address() as AddressInfo).port}` : "";

      // RFC 9728 — protected-resource metadata.
      if (req.url?.startsWith("/.well-known/oauth-protected-resource")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ resource: selfBaseUrl, authorization_servers: [selfBaseUrl] }));
        return;
      }

      // RFC 8414 — authorization-server metadata. (OIDC's
      // /.well-known/openid-configuration is served identically for SDK
      // fallback compatibility.)
      if (
        req.url?.startsWith("/.well-known/oauth-authorization-server") ||
        req.url?.startsWith("/.well-known/openid-configuration")
      ) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            issuer: selfBaseUrl,
            authorization_endpoint: `${selfBaseUrl}/authorize`,
            token_endpoint: `${selfBaseUrl}/token`,
            registration_endpoint: `${selfBaseUrl}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          }),
        );
        return;
      }

      // RFC 7591 — Dynamic Client Registration. The MCP SDK validates the
      // response via OAuthClientInformationFullSchema, which extends
      // OAuthClientMetadataSchema and so REQUIRES `redirect_uris` (an array of
      // URLs) on the response. A real DCR provider echoes the request body's
      // metadata back into the response; we mirror that here so the full-cycle
      // integration test (test/integration/mcp-oauth-roundtrip.test.ts) passes
      // the SDK's response-schema validation. Without this echo the SDK throws
      // `redirect_uris: expected array, received undefined` during DCR.
      if (req.url?.startsWith("/register")) {
        requestCounts.set("register", (requestCounts.get("register") ?? 0) + 1);
        let requested: Record<string, unknown> = {};
        try {
          requested = JSON.parse(body) as Record<string, unknown>;
        } catch {
          // Tolerate a malformed body — the SDK always sends JSON.
        }
        const echoedRedirectUris = Array.isArray(requested["redirect_uris"])
          ? (requested["redirect_uris"] as string[])
          : ["http://127.0.0.1:0/callback"];
        const echoedClientName =
          typeof requested["client_name"] === "string"
            ? (requested["client_name"] as string)
            : undefined;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            client_id: `mock-client-${randomBytes(8).toString("hex")}`,
            client_secret: randomBytes(16).toString("hex"),
            client_id_issued_at: Math.floor(Date.now() / 1000),
            client_secret_expires_at: 0,
            redirect_uris: echoedRedirectUris,
            ...(echoedClientName !== undefined ? { client_name: echoedClientName } : {}),
          }),
        );
        return;
      }

      // Authorization endpoint — 302 back to redirect_uri with code + echoed
      // state (the test drives the "browser" by issuing this GET directly).
      if (req.url?.startsWith("/authorize")) {
        requestCounts.set("authorize", (requestCounts.get("authorize") ?? 0) + 1);
        const authUrl = new URL(req.url, "http://127.0.0.1");
        const redirectUri = authUrl.searchParams.get("redirect_uri");
        const state = authUrl.searchParams.get("state") ?? "";
        if (redirectUri === null) {
          res.statusCode = 400;
          res.end("missing redirect_uri");
          return;
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", "mock-auth-code");
        if (state) target.searchParams.set("state", state);
        res.statusCode = 302;
        res.setHeader("location", target.toString());
        res.end();
        return;
      }

      // OAuth 2.1 token endpoint — auth_code + refresh, with rotation toggle +
      // Stripe-Account capture. Path-distinct from the legacy /oauth/token.
      if (req.url === "/token" || req.url?.startsWith("/token?")) {
        const tokenParams = new URLSearchParams(body);
        const grant = tokenParams.get("grant_type") ?? "unknown";
        const stripeAccountHeader = req.headers["stripe-account"];
        tokenRequests.push({
          grantType: grant,
          stripeAccount: typeof stripeAccountHeader === "string" ? stripeAccountHeader : "",
        });

        // A queued setNextResponse still applies (error-injection for failure
        // tests), consumed once.
        if (nextResponse !== undefined) {
          const queued = nextResponse;
          nextResponse = undefined;
          if (grant === "refresh_token") refreshCount++;
          res.statusCode = queued.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(queued.body));
          return;
        }

        if (grant === "refresh_token") {
          refreshCount++;
          const presented = tokenParams.get("refresh_token") ?? "";
          if (rotateRefreshToken) {
            // Re-presenting an already-rotated token is the Notion lockout (400).
            if (rotatedOutRefreshTokens.has(presented)) {
              res.statusCode = 400;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh_token_reused" }));
              return;
            }
            rotatedOutRefreshTokens.add(presented);
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                access_token: issueAccessToken(),
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: issueRefreshToken(),
              }),
            );
            return;
          }
          // No rotation: stable-shape new access token, echo a refresh_token.
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              access_token: issueAccessToken(),
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: issueRefreshToken(),
            }),
          );
          return;
        }

        // authorization_code (and any other) grant → fresh token bundle.
        // Count auth_code under its own key (getRequestCount("authorization_code"))
        // — distinct from the legacy refresh_token key, so the two routes' refresh
        // counters never collide (refresh lives on the separate refreshCount).
        requestCounts.set(grant, (requestCounts.get(grant) ?? 0) + 1);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token: issueAccessToken(),
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: issueRefreshToken(),
          }),
        );
        return;
      }

      // Existing /oauth/token handler unchanged below.
      const params = new URLSearchParams(body);
      const grantType = params.get("grant_type") ?? "unknown";
      requestCounts.set(grantType, (requestCounts.get(grantType) ?? 0) + 1);

      const response = nextResponse ?? {
        status: 200,
        body: {
          access_token: makeRealisticJwt(),
          refresh_token: randomBytes(32).toString("hex"),
          expires_in: 3600,
        },
      };
      nextResponse = undefined;

      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response.body));
    });
  }

  const api: MockOAuthServer = {
    async start() {
      server = createServer(handler);
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const port = (server.address() as AddressInfo).port;
      return { port, baseUrl: `http://127.0.0.1:${port}` };
    },
    async stop() {
      if (!server) return;
      const local = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        local.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    getRequestCount(grantType) {
      if (grantType !== undefined) {
        return requestCounts.get(grantType) ?? 0;
      }
      let total = 0;
      for (const count of requestCounts.values()) total += count;
      return total;
    },
    getLlmRequests() {
      return llmRequests;
    },
    setNextResponse(opts) {
      nextResponse = { status: opts.status ?? 200, body: opts.body };
    },
    setDeviceCodePollsUntilSuccess(count) {
      deviceCodePollsUntilSuccess = count;
    },
    setRotateRefreshToken(rotate) {
      rotateRefreshToken = rotate;
    },
    getRefreshCount() {
      return refreshCount;
    },
    getTokenRequests() {
      return tokenRequests;
    },
    reset() {
      requestCounts.clear();
      nextResponse = undefined;
      // Clear captured LLM requests so cross-test state does not leak.
      llmRequests.length = 0;
      // Reset device-code polling state so cross-test polling counts
      // do not leak. The default of 2 mirrors the documented "polls 1+2 are 403,
      // poll 3 is 200" behavior.
      deviceCodePollCount = 0;
      deviceCodePollsUntilSuccess = 2;
      // Phase 66: reset the OAuth 2.1 /token state — refresh count, rotation
      // toggle (back to the non-rotating default), the rotated-out token set,
      // and the per-request capture log.
      refreshCount = 0;
      rotateRefreshToken = false;
      rotatedOutRefreshTokens.clear();
      tokenRequests.length = 0;
    },
  };

  return Object.freeze(api);
}
