// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway health check unit tests.
 *
 * Tests gateway-health check for no URL (skip), invalid URL,
 * successful TCP connection, and failed connection scenarios.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { DoctorContext } from "../types.js";

// Mock node:net createConnection
vi.mock("node:net", () => ({
  createConnection: vi.fn(),
}));

const net = await import("node:net");
const { gatewayHealthCheck } = await import("./gateway-health.js");

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

/** Create a mock socket that auto-connects on next tick. */
function createConnectingSocket(): EventEmitter & { destroy: ReturnType<typeof vi.fn> } {
  const socket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  socket.destroy = vi.fn();
  return socket;
}

describe("gatewayHealthCheck", () => {
  beforeEach(() => {
    vi.mocked(net.createConnection).mockReset();
  });

  it("produces skip when no gateway URL configured", async () => {
    const findings = await gatewayHealthCheck.run({
      ...baseContext,
      gatewayUrl: undefined,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("skip");
    expect(findings[0].message).toContain("No gateway URL");
  });

  it("produces fail for invalid gateway URL", async () => {
    const findings = await gatewayHealthCheck.run({
      ...baseContext,
      gatewayUrl: "not-a-valid-url",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("Invalid gateway URL");
  });

  it("produces pass when TCP connection succeeds", async () => {
    const socket = createConnectingSocket();

    // Mock createConnection: call the connect callback immediately
    vi.mocked(net.createConnection).mockImplementation((_opts: unknown, callback: () => void) => {
      // Call connect callback on next tick
      queueMicrotask(() => callback());
      return socket as never;
    });

    const findings = await gatewayHealthCheck.run({
      ...baseContext,
      gatewayUrl: "http://localhost:3000",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("pass");
    expect(findings[0].message).toContain("reachable");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("produces fail when TCP connection fails", async () => {
    const socket = createConnectingSocket();

    vi.mocked(net.createConnection).mockImplementation((_opts: unknown, _callback: () => void) => {
      // Emit error on next tick
      queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
      return socket as never;
    });

    const findings = await gatewayHealthCheck.run({
      ...baseContext,
      gatewayUrl: "http://localhost:3000",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("fail");
    expect(findings[0].message).toContain("not responding");
  });
});
