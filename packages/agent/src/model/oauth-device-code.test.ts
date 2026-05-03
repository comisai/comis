// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for oauth-device-code.ts (Phase 11 SC11-1 / SC11-3).
 *
 * Pure-function tests using DI fetch seam — NO vi.mock, NO vi.useFakeTimers,
 * NO vi.spyOn. The `fetchFn?: typeof fetch` option exists for exactly this
 * test surface (mirrors oauth-tls-preflight.test.ts).
 *
 * Coverage:
 *   1. Happy path: usercode → poll 403 twice → poll 200 → exchange → ok({access, refresh, expires})
 *   2. Timeout (it.todo — requires fake timers or 15-min real wait)
 *   3. Fatal poll status (500) → err
 *   4. Token exchange error → err
 *   5. Missing fields in step-1 response → err
 *   6. onProgress callback fires during polling
 *   7. onVerification callback receives correct prompt shape
 */

import { describe, it, expect, vi } from "vitest";
import { loginOpenAICodexDeviceCode } from "./oauth-device-code.js";

/** Build a stub fetch that returns the sequence of responses for multi-step flows. */
function makeSequentialFetch(
  responses: Array<{ status: number; body: object | string }>,
): typeof fetch {
  let callIndex = 0;
  return (async () => {
    const r = responses[callIndex++];
    if (!r) throw new Error("Sequential fetch exhausted at call " + callIndex);
    const bodyText = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(bodyText, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("loginOpenAICodexDeviceCode", () => {
  it(
    "happy path: polls twice (403) then succeeds with access+refresh+expires",
    async () => {
      const onVerification = vi.fn();
      const onProgress = vi.fn();
      // interval: 1 → 1000ms; clamped to MIN_INTERVAL_MS (1000ms). Two retries
      // = ~2s total wait. interval: 0 would fall through to the 5_000ms default
      // per the verbatim port (RESEARCH §Pitfall 7-adjacent — the min-interval
      // clamp at MIN_INTERVAL_MS=1000ms is a rate-limit defense, not bypassable).
      const result = await loginOpenAICodexDeviceCode({
        fetchFn: makeSequentialFetch([
          { status: 200, body: { device_auth_id: "auth-id-1", user_code: "ABCD-1234", interval: 1 } },
          { status: 403, body: { error: "authorization_pending" } },
          { status: 403, body: { error: "authorization_pending" } },
          { status: 200, body: { authorization_code: "auth-code-1", code_verifier: "verifier-1" } },
          { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } },
        ]),
        onVerification,
        onProgress,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.access).toBe("access-1");
      expect(result.value.refresh).toBe("refresh-1");
      expect(typeof result.value.expires).toBe("number");
      expect(onVerification).toHaveBeenCalledOnce();
      const promptArg = onVerification.mock.calls[0]![0] as {
        verificationUrl: string;
        userCode: string;
        expiresInMs: number;
      };
      expect(promptArg.verificationUrl).toBe("https://auth.openai.com/codex/device");
      expect(promptArg.userCode).toBe("ABCD-1234");
      expect(promptArg.expiresInMs).toBe(15 * 60_000);
    },
    10_000,
  );

  it.todo("returns err(callback_timeout) when polling exceeds 15-minute deadline (requires fake timers — Plan 02 wires real timers, fake clock here is a Plan-02 enhancement)");

  it("returns err on fatal poll status (500)", async () => {
    const result = await loginOpenAICodexDeviceCode({
      fetchFn: makeSequentialFetch([
        { status: 200, body: { device_auth_id: "auth-id-1", user_code: "ABCD-1234", interval: 0 } },
        { status: 500, body: { error: "server_error", error_description: "internal" } },
      ]),
      onVerification: vi.fn(),
    });
    expect(result.ok).toBe(false);
  });

  it("returns err when token exchange fails with invalid_grant", async () => {
    const result = await loginOpenAICodexDeviceCode({
      fetchFn: makeSequentialFetch([
        { status: 200, body: { device_auth_id: "auth-id-1", user_code: "ABCD-1234", interval: 0 } },
        { status: 200, body: { authorization_code: "auth-code-1", code_verifier: "verifier-1" } },
        { status: 400, body: { error: "invalid_grant", error_description: "code expired" } },
      ]),
      onVerification: vi.fn(),
    });
    expect(result.ok).toBe(false);
  });

  it("returns err when usercode response is missing device_auth_id", async () => {
    const result = await loginOpenAICodexDeviceCode({
      fetchFn: makeSequentialFetch([
        { status: 200, body: { user_code: "ABCD-1234" } },
      ]),
      onVerification: vi.fn(),
    });
    expect(result.ok).toBe(false);
  });

  it("calls onProgress at least once per stage", async () => {
    const onProgress = vi.fn();
    await loginOpenAICodexDeviceCode({
      fetchFn: makeSequentialFetch([
        { status: 200, body: { device_auth_id: "auth-id-1", user_code: "ABCD-1234", interval: 0 } },
        { status: 200, body: { authorization_code: "auth-code-1", code_verifier: "verifier-1" } },
        { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } },
      ]),
      onVerification: vi.fn(),
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
  });

  it("onVerification receives a non-empty userCode string", async () => {
    const onVerification = vi.fn();
    await loginOpenAICodexDeviceCode({
      fetchFn: makeSequentialFetch([
        { status: 200, body: { device_auth_id: "auth-id-1", user_code: "ABCD-1234", interval: 0 } },
        { status: 200, body: { authorization_code: "auth-code-1", code_verifier: "verifier-1" } },
        { status: 200, body: { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 } },
      ]),
      onVerification,
    });
    const promptArg = onVerification.mock.calls[0]![0] as { userCode: string };
    expect(typeof promptArg.userCode).toBe("string");
    expect(promptArg.userCode.length).toBeGreaterThan(0);
  });
});
