// SPDX-License-Identifier: Apache-2.0
/**
 * Mock OAuth server fixture for Phase 7 integration tests.
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
 * Codex token-endpoint contract (RESEARCH §Q4):
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
  /** Captured inbound LLM requests (Phase 9 D-13). Returns array in arrival order. */
  getLlmRequests(): ReadonlyArray<{ authorization: string; accountId: string; body: string }>;
  /** Configure the next single response (status defaults to 200). Consumed once. */
  setNextResponse(opts: { status?: number; body: object }): void;
  /** Configure how many 403 responses the device-code poll emits before success. Default: 2. */
  setDeviceCodePollsUntilSuccess(count: number): void;
  /** Reset counters and any queued response. Call between tests. */
  reset(): void;
}

/**
 * Build a realistic-shape JWT for the default token response. The signature is
 * a literal placeholder — tests do NOT verify signatures. Payload defaults match
 * a plausible OpenAI Codex access token (1h expiry, profile email, account id).
 */
function makeRealisticJwt(payloadOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const defaultPayload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/profile": { email: "user_a@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
    ...payloadOverrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(defaultPayload)).toString("base64url");
  return `${header}.${payloadB64}.fake-signature`;
}

export function createMockOAuthServer(): MockOAuthServer {
  let server: Server | undefined;
  const requestCounts = new Map<string, number>();
  // Phase 9 D-13: per-request capture log for the /codex/responses LLM route.
  // Each entry records the inbound Authorization + chatgpt-account-id headers
  // plus the raw request body, in arrival order. Cleared by reset().
  const llmRequests: Array<{ authorization: string; accountId: string; body: string }> = [];
  let nextResponse: { status: number; body: object } | undefined;
  // Phase 11: device-code polling state. deviceCodePollCount counts how many
  // POSTs to /api/accounts/deviceauth/token have arrived since the last reset();
  // deviceCodePollsUntilSuccess controls how many 403 responses the handler
  // emits before flipping to 200 with the authorization_code + code_verifier.
  // Default of 2 means polls 1 and 2 are 403; poll 3 is 200.
  let deviceCodePollCount = 0;
  let deviceCodePollsUntilSuccess = 2;

  // Phase 8 D-09 contract:
  // This handler serves BOTH grant_type=refresh_token (Phase 7 use) AND
  // grant_type=authorization_code (Phase 8 use — login flow). The response
  // shape is identical — pi-ai's loginOpenAICodex and refreshOpenAICodexToken
  // both expect {access_token, refresh_token, expires_in}. Per-grant-type
  // queueing via setNextResponse already works (the response is consulted
  // once per request regardless of grant_type). Phase 8 integration tests
  // assert flow distinction via getRequestCount('authorization_code') vs
  // getRequestCount('refresh_token').
  function handler(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    req.on("end", () => {
      // Phase 9 D-13: LLM endpoint capture for SC#2 evidence.
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

      // Phase 11: device-code usercode request endpoint.
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

      // Phase 11: device-code poll endpoint.
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
    reset() {
      requestCounts.clear();
      nextResponse = undefined;
      // Phase 9 D-13: clear captured LLM requests so cross-test state does not leak.
      llmRequests.length = 0;
      // Phase 11: reset device-code polling state so cross-test polling counts
      // do not leak. The default of 2 mirrors the documented "polls 1+2 are 403,
      // poll 3 is 200" behavior.
      deviceCodePollCount = 0;
      deviceCodePollsUntilSuccess = 2;
    },
  };

  return Object.freeze(api);
}
