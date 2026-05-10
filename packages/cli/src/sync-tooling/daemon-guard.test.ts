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
 *   - the literal RPC method name is "system.ping"
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/rpc-client.js", () => ({
  withClient: vi.fn(),
}));

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
      async (fn: (client: { call: (m: string) => Promise<unknown> }) => Promise<unknown>) => {
        const callMock = vi.fn().mockResolvedValue({ pong: true });
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

  // returns false on "method not found" (regression / fail-closed)
  it("returns false when the underlying call() rejects with method-not-found", async () => {
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string) => Promise<unknown> }) => Promise<unknown>) => {
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
      async (fn: (client: { call: (m: string) => Promise<unknown> }) => Promise<unknown>) => {
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

  // the literal RPC method is "system.ping"
  it("calls client.call('system.ping') exactly — not 'health.ping'", async () => {
    const callMock = vi.fn().mockResolvedValue({ pong: true });
    vi.mocked(withClient).mockImplementation(
      async (fn: (client: { call: (m: string) => Promise<unknown> }) => Promise<unknown>) => {
        return fn({ call: callMock });
      },
    );

    await isDaemonRunning();

    expect(callMock).toHaveBeenCalledWith("system.ping");
    // Strict equality — must not be called with anything else.
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});
