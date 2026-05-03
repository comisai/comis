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
// (RESEARCH §Q8 / openai-codex.js:107-110).
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

  it("Test 1: start() returns a valid kernel-allocated port and matching baseUrl", () => {
    expect(port).toBeGreaterThan(0);
    expect(baseUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it("Test 2: POST /oauth/token returns 200 with access_token, refresh_token, expires_in", async () => {
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

  it("Test 3: default access_token is a 3-segment JWT", async () => {
    const res = await postRefresh(baseUrl);
    const json = (await res.json()) as { access_token: string };
    const segments = json.access_token.split(".");
    expect(segments).toHaveLength(3);
  });

  it("Test 4: getRequestCount('refresh_token') tracks per-grant-type counts", async () => {
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("refresh_token")).toBe(1);
    await postRefresh(baseUrl);
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("refresh_token")).toBe(3);
    expect(mock.getRequestCount()).toBe(3);
  });

  it("Test 5: getRequestCount('authorization_code') is 0 when only refresh requests sent", async () => {
    await postRefresh(baseUrl);
    expect(mock.getRequestCount("authorization_code")).toBe(0);
    expect(mock.getRequestCount("refresh_token")).toBe(1);
  });

  it("Test 6: setNextResponse is consumed once, then default resumes", async () => {
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

  it("Test 7: reset() clears counters and any queued response", async () => {
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

  it("Test 8: stop() releases the port; subsequent start() succeeds", async () => {
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
  // Phase 9 D-13: POST /codex/responses route + getLlmRequests() capture log
  // ---------------------------------------------------------------------------
  // The fixture must record per-call Authorization + chatgpt-account-id headers
  // so the integration test in plan 07 can assert per-agent token routing at
  // the network boundary (SC#2 falsifiable evidence).
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

  it("Test 9 (codex/responses): captures Authorization + chatgpt-account-id headers per request", async () => {
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

  it("Test 10 (codex/responses): getLlmRequests() returns array in inbound order across multiple sequential calls", async () => {
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

  it("Test 11 (codex/responses): returns 200 with text/event-stream and minimal SSE response.completed payload", async () => {
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

  it("Test 12 (codex/responses): existing /oauth/token route behavior unchanged — token-issue path still emits {access_token, refresh_token, expires_in}", async () => {
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

  it("Test 13 (codex/responses): reset() clears getLlmRequests() AND existing getRequestCount()", async () => {
    await postCodexResponses(baseUrl, { authorization: "Bearer X", "chatgpt-account-id": "Y" });
    await postRefresh(baseUrl);
    expect(mock.getLlmRequests()).toHaveLength(1);
    expect(mock.getRequestCount()).toBe(1);

    mock.reset();
    expect(mock.getLlmRequests()).toEqual([]);
    expect(mock.getRequestCount()).toBe(0);
    expect(mock.getRequestCount("refresh_token")).toBe(0);
  });

  it("Test 14 (codex/responses): missing Authorization header records empty string; missing chatgpt-account-id records empty string (no thrown error)", async () => {
    const res = await postCodexResponses(baseUrl, {
      "content-type": "application/json",
    });
    expect(res.status).toBe(200);

    const captured = mock.getLlmRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.authorization).toBe("");
    expect(captured[0]?.accountId).toBe("");
  });
});
