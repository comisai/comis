// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for the `tool:executed` audit-log subscription (extracted from
 * setup-tools.ts). Asserts a DEBUG audit line is emitted per tool execution, the
 * tool parameters never enter either the message or structured payload, and the origin
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
      "Tool execution audited",
    );
  });

  it("keeps message bodies and other tool parameter values out of every log field", () => {
    const bus = makeBus();
    const logger = createMockLogger();
    setupToolAuditLogging(bus as never, logger);

    const privateBody = "PRIVATE-MESSAGE-BODY-DO-NOT-LOG";
    bus.fire("tool:executed", {
      toolName: "message",
      durationMs: 1,
      success: false,
      description: privateBody,
      params: { action: "send", text: privateBody, nested: { payload_text: privateBody } },
    });

    const call = (logger.debug as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.stringify(call)).not.toContain(privateBody);
    expect(call[0]).toMatchObject({
      toolName: "message",
      durationMs: 1,
      success: false,
      parameterCount: 3,
    });
    expect(call[0]).not.toHaveProperty("params");
    expect(call[0]).not.toHaveProperty("description");
    expect(call[1]).toBe("Tool execution audited");
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
