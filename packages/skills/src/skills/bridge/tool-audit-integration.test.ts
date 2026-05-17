// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import { TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";
import { wrapWithAudit } from "./tool-audit.js";

function createMockTool(name: string, executeFn?: (...args: any[]) => Promise<any>) {
  return {
    name,
    label: name,
    description: `Mock ${name} tool`,
    parameters: Type.Object({}),
    execute: executeFn ?? vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
      details: { result: "ok" },
    }),
  };
}

describe("tool-audit-integration", () => {
  describe("single invocation audit", () => {
    it("single tool invocation emits tool:executed event with correct metadata", async () => {
      const eventBus = new TypedEventBus();
      const events: EventMap["tool:executed"][] = [];
      eventBus.on("tool:executed", (payload) => events.push(payload));

      const tool = createMockTool("fetch-data");
      const wrapped = wrapWithAudit(tool, eventBus);

      await wrapped.execute("call-001", {});

      expect(events.length).toBe(1);
      expect(events[0]!.toolName).toBe("fetch-data");
      expect(events[0]!.success).toBe(true);
      expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0]!.timestamp).toBeGreaterThan(0);
    });

    it("failed tool invocation emits event with success=false and preserves error", async () => {
      const eventBus = new TypedEventBus();
      const events: EventMap["tool:executed"][] = [];
      eventBus.on("tool:executed", (payload) => events.push(payload));

      const tool = createMockTool("fail-tool", vi.fn().mockRejectedValue(new Error("connection refused")));
      const wrapped = wrapWithAudit(tool, eventBus);

      await expect(wrapped.execute("call-002", {})).rejects.toThrow("connection refused");

      expect(events.length).toBe(1);
      expect(events[0]!.toolName).toBe("fail-tool");
      expect(events[0]!.success).toBe(false);
      expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("multiple invocation audit events", () => {
    it("N sequential tool executions emit exactly N events with correct toolNames", async () => {
      const eventBus = new TypedEventBus();
      const events: EventMap["tool:executed"][] = [];
      eventBus.on("tool:executed", (payload) => events.push(payload));

      const toolAlpha = createMockTool("tool-alpha");
      const toolBeta = createMockTool("tool-beta");
      const toolGamma = createMockTool("tool-gamma");

      const wrappedAlpha = wrapWithAudit(toolAlpha, eventBus);
      const wrappedBeta = wrapWithAudit(toolBeta, eventBus);
      const wrappedGamma = wrapWithAudit(toolGamma, eventBus);

      await wrappedAlpha.execute("call-a", {});
      await wrappedBeta.execute("call-b", {});
      await wrappedGamma.execute("call-c", {});

      expect(events.length).toBe(3);
      expect(events[0]!.toolName).toBe("tool-alpha");
      expect(events[1]!.toolName).toBe("tool-beta");
      expect(events[2]!.toolName).toBe("tool-gamma");
      expect(events[0]!.success).toBe(true);
      expect(events[1]!.success).toBe(true);
      expect(events[2]!.success).toBe(true);
    });

    it("concurrent tool executions emit one event per invocation with no event loss", async () => {
      const eventBus = new TypedEventBus();
      const events: EventMap["tool:executed"][] = [];
      eventBus.on("tool:executed", (payload) => events.push(payload));

      const tools = Array.from({ length: 5 }, (_, i) => {
        const delayMs = 5 + Math.floor(Math.random() * 16); // 5-20ms
        return createMockTool(`concurrent-${i}`, async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return {
            content: [{ type: "text" as const, text: "ok" }],
            details: { result: "ok" },
          };
        });
      });

      const wrappedTools = tools.map((tool) => wrapWithAudit(tool, eventBus));

      await Promise.all(wrappedTools.map((w, i) => w.execute(`call-${i}`, {})));

      expect(events.length).toBe(5);
      expect(events.every((e) => e.success === true)).toBe(true);

      const emittedNames = new Set(events.map((e) => e.toolName));
      for (let i = 0; i < 5; i++) {
        expect(emittedNames.has(`concurrent-${i}`)).toBe(true);
      }
    });

    it("mixed success and failure invocations emit correct success flags", async () => {
      const eventBus = new TypedEventBus();
      const events: EventMap["tool:executed"][] = [];
      eventBus.on("tool:executed", (payload) => events.push(payload));

      const success1 = createMockTool("success-1");
      const failure1 = createMockTool("failure-1", vi.fn().mockRejectedValue(new Error("boom")));
      const success2 = createMockTool("success-2");

      const wrappedSuccess1 = wrapWithAudit(success1, eventBus);
      const wrappedFailure1 = wrapWithAudit(failure1, eventBus);
      const wrappedSuccess2 = wrapWithAudit(success2, eventBus);

      await wrappedSuccess1.execute("call-s1", {});
      try {
        await wrappedFailure1.execute("call-f1", {});
      } catch {
        // Expected rejection
      }
      await wrappedSuccess2.execute("call-s2", {});

      expect(events.length).toBe(3);
      expect(events[0]!.success).toBe(true);
      expect(events[1]!.success).toBe(false);
      expect(events[2]!.success).toBe(true);
      expect(events[0]!.toolName).toBe("success-1");
      expect(events[1]!.toolName).toBe("failure-1");
      expect(events[2]!.toolName).toBe("success-2");
      expect(events.every((e) => e.durationMs >= 0)).toBe(true);
    });
  });
});
