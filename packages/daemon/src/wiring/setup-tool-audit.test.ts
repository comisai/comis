// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the `tool:executed` audit-log subscription (extracted from
 * setup-tools.ts). Asserts a DEBUG audit line is emitted per tool execution, the
 * params preview is log-sanitized + length-capped (never a verbatim dump), and the origin
 * fields ride the structured payload.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

import { setupToolAuditLogging } from "./setup-tool-audit.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

/** A minimal capturing TypedEventBus-shaped fake (only `.on` is exercised). */
function makeBus() {
  const handlers = new Map<string, (data: unknown) => void>();
  return {
    on(event: string, handler: (data: unknown) => void) {
      handlers.set(event, handler);
      return this;
    },
    fire(event: string, data: unknown) {
      handlers.get(event)?.(data);
    },
  };
}

describe("setupToolAuditLogging — the tool:executed DEBUG audit line", () => {
  it("subscribes tool:executed and logs a DEBUG line with toolName + durationMs + success + origin", () => {
    const bus = makeBus();
    const logger = createMockLogger();
    setupToolAuditLogging(bus as never, logger);

    bus.fire("tool:executed", {
      toolName: "exec",
      durationMs: 12.7,
      success: true,
      userId: "u-1",
      agentId: "agent-a",
      sessionKey: "sess-1",
      params: { cmd: "ls" },
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "exec", durationMs: 13, success: true, agentId: "agent-a", sessionKey: "sess-1" }),
      expect.stringContaining("Tool audit: exec"),
    );
  });

  it("truncates a large params preview (never a verbatim dump)", () => {
    const bus = makeBus();
    const logger = createMockLogger();
    setupToolAuditLogging(bus as never, logger);

    const huge = "x".repeat(5000);
    bus.fire("tool:executed", { toolName: "exec", durationMs: 1, success: false, params: { blob: huge } });

    const call = (logger.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call[0] as { params?: string; paramsTruncated?: boolean };
    expect(payload.paramsTruncated).toBe(true);
    expect(payload.params!.length).toBeLessThan(huge.length);
  });

  it("omits the params field when the event carries no params", () => {
    const bus = makeBus();
    const logger = createMockLogger();
    setupToolAuditLogging(bus as never, logger);

    bus.fire("tool:executed", { toolName: "process", durationMs: 2, success: true });

    const call = (logger.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = call[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("params");
  });
});
