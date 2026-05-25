// SPDX-License-Identifier: Apache-2.0
/**
 * Self-tests for the mock OAuth server fixture.
 *
 * Verifies port allocation, request counting by grant_type, scripted-response
 * consume-once semantics, reset, and lifecycle (start/stop and restart).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockOAuthServer, type MockOAuthServer } from "./mock-oauth-server.js";

// Build a urlencoded refresh-request body exactly as pi-ai sends it
// (openai-codex.js:107-110).
function refreshTokenBody(): string {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: "rt_test",
    client_id: "test-client",
  }).toString();
}

async function postRefresh(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: refreshTokenBody(),
  });
}

describe("createMockOAuthServer", () => {
  let mock: MockOAuthServer;
  let baseUrl: string;
  let port: number;

  beforeEach(async () => {
    mock = createMockOAuthServer();
    const started = await mock.start();
    baseUrl = started.baseUrl;
    port = started.port;
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("start() returns a valid kernel-allocated port and matching baseUrl", () => {
    expect(port).toBeGreaterThan(0);
    expect(baseUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it("POST /oauth/token returns 200 with access_token, refresh_token, expires_in", async () => {
    const res = await postRefresh(baseUrl);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("access_token");
    expect(json).toHaveProperty("refresh_token");
    expect(json).toHaveProperty("expires_in");
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    expect(json.expires_in).toBe(3600);
  });

  it("default access_token is a 3-segment JWT", async () => {
    const res = await postRefresh(baseUrl);
    const json = (await res.json()) as { access_token: string };
    const segments = json.access_token.split(".");
    expect(segments).toHaveLength(3);
  });

  it("getRequestCount('refresh_token') tracks per-grant-type counts", async () => {
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("refresh_token")).toBe(1);
    await postRefresh(baseUrl);
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("refresh_token")).toBe(3);
    expect(mock.getRequestCount()).toBe(3);
  });

  it("getRequestCount('authorization_code') is 0 when only refresh requests sent", async () => {
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("authorization_code")).toBe(0);
    expect(mock.getRequestCount("refresh_token")).toBe(1);
  });

  it("setNextResponse is consumed once, then default resumes", async () => {
    mock.setNextResponse({
      status: 400,
      body: { error: "invalid_grant", error_description: "refresh_token_reused" },
    });
    const failing = await postRefresh(baseUrl);
    expect(failing.status).toBe(400);
    const failingBody = (await failing.json()) as Record<string, unknown>;
    expect(failingBody.error).toBe("invalid_grant");
    expect(failingBody.error_description).toBe("refresh_token_reused");

    // Subsequent POST returns the default 200
    const next = await postRefresh(baseUrl);
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as Record<string, unknown>;
    expect(nextBody).toHaveProperty("access_token");
  });

  it("reset() clears counters and any queued response", async () => {
    await postRefresh(baseUrl);
    await postRefresh(baseUrl);
    mock.setNextResponse({ status: 500, body: { error: "server_error" } });
    expect(mock.getRequestCount("refresh_token")).toBe(2);

    mock.reset();
    expect(mock.getRequestCount("refresh_token")).toBe(0);
    expect(mock.getRequestCount()).toBe(0);

    // The queued 500 must NOT fire after reset — default 200 should
    const after = await postRefresh(baseUrl);
    expect(after.status).toBe(200);
  });

  it("stop() releases the port; subsequent start() succeeds", async () => {
    // beforeEach already started; stop, then start a second time on the SAME instance
    await mock.stop();
    const restarted = await mock.start();
    expect(restarted.port).toBeGreaterThan(0);
    expect(restarted.baseUrl).toBe(`http://127.0.0.1:${restarted.port}`);
    // Confirm it actually responds
    const res = await postRefresh(restarted.baseUrl);
    expect(res.status).toBe(200);
    // afterEach will stop the restarted server
  });

  // ---------------------------------------------------------------------------
  // POST /codex/responses route + getLlmRequests() capture log
  // ---------------------------------------------------------------------------
  // The fixture must record per-call Authorization + chatgpt-account-id headers
  // so integration tests can assert per-agent token routing at
  // the network boundary.
  // ---------------------------------------------------------------------------

  async function postCodexResponses(
    baseUrl: string,
    headers: Record<string, string>,
    body = "",
  ): Promise<Response> {
    return fetch(`${baseUrl}/codex/responses`, {
      method: "POST",
      headers,
      body,
    });
  }

  it("codex/responses: captures Authorization + chatgpt-account-id headers per request", async () => {
    await postCodexResponses(baseUrl, {
      authorization: "Bearer ABC123",
      "chatgpt-account-id": "ACC1",
      "content-type": "application/json",
    }, '{"model":"gpt-5"}');

    const captured = mock.getLlmRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe("Bearer ABC123");
    expect(captured[0]?.accountId).toBe("ACC1");
    expect(captured[0]?.body).toBe('{"model":"gpt-5"}');
  });

  it("codex/responses: getLlmRequests() returns array in inbound order across multiple sequential calls", async () => {
    await postCodexResponses(baseUrl, {
      authorization: "Bearer TOKEN_A",
      "chatgpt-account-id": "ACC_A",
    });
    await postCodexResponses(baseUrl, {
      authorization: "Bearer TOKEN_B",
      "chatgpt-account-id": "ACC_B",
    });
    await postCodexResponses(baseUrl, {
      authorization: "Bearer TOKEN_C",
      "chatgpt-account-id": "ACC_C",
    });

    const captured = mock.getLlmRequests();
    expect(captured).toHaveLength(3);
    expect(captured[0]?.authorization).toBe("Bearer TOKEN_A");
    expect(captured[1]?.authorization).toBe("Bearer TOKEN_B");
    expect(captured[2]?.authorization).toBe("Bearer TOKEN_C");
    expect(captured.map((c) => c.accountId)).toEqual(["ACC_A", "ACC_B", "ACC_C"]);
  });

  it("codex/responses: returns 200 with text/event-stream and minimal SSE response.completed payload", async () => {
    const res = await postCodexResponses(baseUrl, {
      authorization: "Bearer T",
      "chatgpt-account-id": "A",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain("response.completed");
    expect(text).toContain('"status":"completed"');
    // Standard SSE message terminator is two newlines.
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("codex/responses: existing /oauth/token route behavior unchanged — token-issue path still emits {access_token, refresh_token, expires_in}", async () => {
    const res = await postRefresh(baseUrl);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty("access_token");
    expect(json).toHaveProperty("refresh_token");
    expect(json).toHaveProperty("expires_in");
    expect(mock.getRequestCount("refresh_token")).toBe(1);
    // /codex/responses requests should NOT be counted as oauth grant_type requests.
    await postCodexResponses(baseUrl, { authorization: "Bearer X", "chatgpt-account-id": "Y" });
    expect(mock.getRequestCount("refresh_token")).toBe(1);
    expect(mock.getRequestCount()).toBe(1);
  });

  it("codex/responses: reset() clears getLlmRequests() AND existing getRequestCount()", async () => {
    await postCodexResponses(baseUrl, { authorization: "Bearer X", "chatgpt-account-id": "Y" });
    await postRefresh(baseUrl);
    expect(mock.getLlmRequests()).toHaveLength(1);
    expect(mock.getRequestCount()).toBe(1);

    mock.reset();
    expect(mock.getLlmRequests()).toEqual([]);
    expect(mock.getRequestCount()).toBe(0);
    expect(mock.getRequestCount("refresh_token")).toBe(0);
  });

  it("codex/responses: missing Authorization header records empty string; missing chatgpt-account-id records empty string (no thrown error)", async () => {
    const res = await postCodexResponses(baseUrl, {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);

    const captured = mock.getLlmRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe("");
    expect(captured[0]?.accountId).toBe("");
  });

  // ---------------------------------------------------------------------------
  // OAuth 2.1 surface — RFC 9728/8414 discovery, RFC 7591 DCR,
  // /authorize (302 + code+state), /token (auth_code + refresh), refresh-token
  // rotation toggle, and Stripe-Account header capture.
  // ---------------------------------------------------------------------------

  function tokenBody(grantType: string, extra: Record<string, string> = {}): string {
    return new URLSearchParams({ grant_type: grantType, client_id: "test-client", ...extra }).toString();
  }

  async function postToken(
    url: string,
    grantType: string,
    extra: Record<string, string> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: tokenBody(grantType, extra),
    });
  }

  it("GET /.well-known/oauth-protected-resource returns RFC 9728 metadata pointing at self", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(json.resource).toBe(baseUrl);
    expect(json.authorization_servers).toEqual([baseUrl]);
  });

  it("GET /.well-known/oauth-authorization-server returns RFC 8414 metadata pointing at self", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, string>;
    expect(json.issuer).toBe(baseUrl);
    expect(json.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(json.token_endpoint).toBe(`${baseUrl}/token`);
    expect(json.registration_endpoint).toBe(`${baseUrl}/register`);
  });

  it("POST /register returns RFC 7591 DCR client_id + client_secret", async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:5000/callback"], client_name: "Comis" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { client_id: string; client_secret?: string };
    expect(typeof json.client_id).toBe("string");
    expect(json.client_id.length).toBeGreaterThan(0);
    expect(typeof json.client_secret).toBe("string");
  });

  it("GET /authorize redirects 302 to the supplied redirect_uri with code + echoed state", async () => {
    const redirectUri = "http://127.0.0.1:5555/callback";
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state: "csrf-state-xyz",
      code_challenge: "challenge123",
      code_challenge_method: "S256",
      response_type: "code",
    });
    const res = await fetch(`${baseUrl}/authorize?${params.toString()}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const loc = new URL(location as string);
    expect(`${loc.protocol}//${loc.host}${loc.pathname}`).toBe(redirectUri);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("csrf-state-xyz");
  });

  it("POST /token grant_type=authorization_code returns Bearer tokens", async () => {
    const res = await postToken(baseUrl, "authorization_code", { code: "test-code" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.access_token).toBeTruthy();
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.refresh_token).toBeTruthy();
    expect(mock.getRequestCount("authorization_code")).toBe(1);
  });

  it("POST /token grant_type=refresh_token returns NEW tokens and increments getRefreshCount()", async () => {
    const res = await postToken(baseUrl, "refresh_token", { refresh_token: "rt_initial" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(mock.getRefreshCount()).toBe(1);
    await postToken(baseUrl, "refresh_token", { refresh_token: "rt_initial" });
    expect(mock.getRefreshCount()).toBe(2);
  });

  it("setRotateRefreshToken(true): each refresh returns a different refresh_token", async () => {
    mock.setRotateRefreshToken(true);
    const first = (await (await postToken(baseUrl, "refresh_token", { refresh_token: "rt0" })).json()) as {
      refresh_token: string;
    };
    const second = (await (
      await postToken(baseUrl, "refresh_token", { refresh_token: first.refresh_token })
    ).json()) as { refresh_token: string };
    expect(first.refresh_token).not.toBe(second.refresh_token);
  });

  it("setRotateRefreshToken(true): presenting a previously-rotated refresh_token is rejected 400", async () => {
    mock.setRotateRefreshToken(true);
    // First refresh issues a new token and invalidates rt_old.
    const first = (await (await postToken(baseUrl, "refresh_token", { refresh_token: "rt_old" })).json()) as {
      refresh_token: string;
    };
    // Re-presenting the now-rotated rt_old must be rejected.
    const reused = await postToken(baseUrl, "refresh_token", { refresh_token: "rt_old" });
    expect(reused.status).toBe(400);
    // The freshly-issued token still works.
    const ok = await postToken(baseUrl, "refresh_token", { refresh_token: first.refresh_token });
    expect(ok.status).toBe(200);
  });

  it("captures the Stripe-Account header on /token requests", async () => {
    await postToken(baseUrl, "authorization_code", { code: "c1" }, { "stripe-account": "acct_123" });
    await postToken(baseUrl, "refresh_token", { refresh_token: "rt1" }, { "stripe-account": "acct_456" });
    const reqs = mock.getTokenRequests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.grantType).toBe("authorization_code");
    expect(reqs[0]?.stripeAccount).toBe("acct_123");
    expect(reqs[1]?.grantType).toBe("refresh_token");
    expect(reqs[1]?.stripeAccount).toBe("acct_456");
  });

  it("getTokenRequests() records an empty stripeAccount when the header is absent", async () => {
    await postToken(baseUrl, "authorization_code", { code: "c1" });
    const reqs = mock.getTokenRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.stripeAccount).toBe("");
  });

  it("reset() clears getRefreshCount(), getTokenRequests(), and the rotation toggle", async () => {
    mock.setRotateRefreshToken(true);
    await postToken(baseUrl, "refresh_token", { refresh_token: "rt_a" });
    await postToken(baseUrl, "authorization_code", { code: "c" }, { "stripe-account": "acct_x" });
    expect(mock.getRefreshCount()).toBe(1);
    expect(mock.getTokenRequests().length).toBe(2);

    mock.reset();
    expect(mock.getRefreshCount()).toBe(0);
    expect(mock.getTokenRequests()).toEqual([]);
    // Rotation toggle reset to false ⇒ a previously-"rotated" token is accepted again.
    const res = await postToken(baseUrl, "refresh_token", { refresh_token: "rt_a" });
    expect(res.status).toBe(200);
  });

  it("/token route does not pollute the legacy /oauth/token grant counters and vice-versa", async () => {
    await postRefresh(baseUrl); // legacy /oauth/token
    await postToken(baseUrl, "refresh_token", { refresh_token: "rt" }); // new /token
    // Legacy counter sees only the /oauth/token hit; getRefreshCount sees only /token.
    expect(mock.getRequestCount("refresh_token")).toBe(1);
    expect(mock.getRefreshCount()).toBe(1);
  });
});
