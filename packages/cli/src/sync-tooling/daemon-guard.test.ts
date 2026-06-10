// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for isDaemonRunning — RPC probe via `system.ping` wrapped in
 * Promise.race with a 1-second deadline.
 *
 * Covers:
 *   - returns true when withClient resolves successfully
 *   - returns false on ECONNREFUSED
 *   - returns false on "method not found" (regression — fail-closed)
 *   - returns false when the RPC hangs longer than the timeout (default 1000ms)
 *   - default timeout is 1000ms (asserted by the timeout case with no explicit arg)
 *   - the literal RPC method name is "system.ping" — via SystemPingContract
 *
 * The probe uses `callTyped(client, SystemPingContract, {})`. The mock
 * surface needs both `withClient` AND `callTyped` because `daemon-guard.ts`
 * imports the typed-RPC wrapper from `../client/rpc-client.js`. The
 * `callMock` argument check is `(method, params)` — `callTyped` always
 * forwards an empty params object for parameterless RPCs.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both `withClient` and `callTyped` are re-exported from rpc-client.js.
// Mock both; callTyped delegates to the inner `client.call`, so we keep the
// fake-`client.call` mock pattern but the test asserts via callMock.
vi.mock("../client/rpc-client.js", async () => {
  // Import the real callTyped so it propagates the call through to our
  // injected client.call mock — that's what daemon-guard.ts depends on.
  const actual =
    await vi.importActual<typeof import("../client/rpc-client.js")>(
      "../client/rpc-client.js",
    );
  return {
    withClient: vi.fn(),
    callTyped: actual.callTyped,
    // W13: forward the real predicate — daemon-guard keys liveness on it.
    isGatewayAuthRejection: actual.isGatewayAuthRejection,
  };
});

const { withClient } = await import("../client/rpc-client.js");
const { isDaemonRunning } = await import("./daemon-guard.js");

describe("isDaemonRunning", () => {
  beforeEach(() => {
    vi.mocked(withClient).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // returns true on RPC success
  it("returns true when withClient invokes the callback and call() resolves", async () => {
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string, p?: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        // Return the SystemPingContract-shaped response so callTyped's
        // optional response.parse (when VALIDATE is on) accepts it.
        const callMock = vi.fn().mockResolvedValue({ pong: true, ts: Date.now() });
        return fn({ call: callMock });
      },
    );

    const running = await isDaemonRunning();

    expect(running).toBe(true);
  });

  // returns false on ECONNREFUSED
  it("returns false when withClient throws ECONNREFUSED", async () => {
    const e = new Error("ECONNREFUSED") as Error & { code?: string };
    e.code = "ECONNREFUSED";
    vi.mocked(withClient).mockRejectedValue(e);

    const running = await isDaemonRunning();

    expect(running).toBe(false);
  });

  // W13: an auth-rejected upgrade PROVES the daemon answered — "not running"
  // was a lie that sent the live investigation chasing a healthy process.
  it("returns true when the gateway rejects the token — the daemon demonstrably answered (W13)", async () => {
    vi.mocked(withClient).mockRejectedValue(
      new Error(
        "Gateway rejected the token (WS close 4001 Unauthorized) — the daemon IS running and listening. " +
          "Set COMIS_GATEWAY_TOKEN (env var or ~/.comis/.env) to a token matching a gateway.tokens entry.",
      ),
    );

    const running = await isDaemonRunning();

    expect(running).toBe(true);
  });

  // returns false on "method not found" (regression / fail-closed)
  it("returns false when the underlying call() rejects with method-not-found", async () => {
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string, p?: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        const callMock = vi
          .fn()
          .mockRejectedValue(new Error("method not found: system.ping"));
        return fn({ call: callMock });
      },
    );

    const running = await isDaemonRunning();

    expect(running).toBe(false);
  });

  // returns false on 1s timeout when RPC hangs (also covers default-timeout assertion)
  it("returns false when the RPC hangs longer than the default 1000ms", async () => {
    vi.useFakeTimers();
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string, p?: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        // call() returns a never-resolving Promise; the only thing that can
        // resolve isDaemonRunning is the Promise.race timeout branch.
        const callMock = vi.fn(() => new Promise<unknown>(() => {}));
        return fn({ call: callMock });
      },
    );

    const promise = isDaemonRunning();
    // Default timeout is 1000ms; advancing 1001ms triggers the timeout branch.
    await vi.advanceTimersByTimeAsync(1001);

    await expect(promise).resolves.toBe(false);
  });

  // the literal RPC method is "system.ping" (via SystemPingContract.method)
  it("calls client.call('system.ping', {}) exactly — not 'health.ping'", async () => {
    const callMock = vi.fn().mockResolvedValue({ pong: true, ts: Date.now() });
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string, p?: unknown) => Promise<unknown> }) => Promise<unknown>) => {
        return fn({ call: callMock });
      },
    );

    await isDaemonRunning();

    // callTyped passes `(method, validatedReq)` — for the empty-request
    // SystemPingContract that's `("system.ping", {})`. The method name
    // assertion is the gate against accidental rename / typo.
    expect(callMock).toHaveBeenCalledWith("system.ping", {});
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});
