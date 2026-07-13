// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import { TypedEventBus, runWithContext } from "@comis/core";
import type { EventMap } from "@comis/core";
import { wrapWithAudit } from "./tool-audit.js";

function createMockTool(executeFn?: (...args: any[]) => Promise<any>) {
  return {
    name: "test_tool",
    label: "test_tool",
    description: "A test tool",
    parameters: Type.Object({}),
    execute: executeFn ?? vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
      details: { result: "ok" },
    }),
  };
}

describe("wrapWithAudit", () => {
  it("emits tool:executed event on successful execution", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("test_tool");
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]!.timestamp).toBeGreaterThan(0);
  });

  it("emits tool:executed event on failed execution", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockRejectedValue(new Error("boom")));
    const wrapped = wrapWithAudit(tool, eventBus);

    await expect(wrapped.execute("call-1", {})).rejects.toThrow("boom");

    expect(events).toHaveLength(1);
    expect(events[0]!.toolName).toBe("test_tool");
    expect(events[0]!.success).toBe(false);
  });

  it("measures duration inside execute, not at wrap time", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const delayMs = 50;
    const tool = createMockTool(async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    });

    const wrapped = wrapWithAudit(tool, eventBus);

    // Wait a bit before calling execute to verify duration is NOT inflated
    await new Promise((resolve) => setTimeout(resolve, 20));
    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    // Duration should be approximately the delay, not wrap-to-execute time
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(delayMs * 0.8);
    // Should not be much more than delay + margin
    expect(events[0]!.durationMs).toBeLessThan(delayMs * 5);
  });

  it("includes userId and traceId from context when available", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    const ctx = {
      tenantId: "test-tenant",
      userId: "user-42",
      sessionKey: "sess-1",
      traceId: "00000000-0000-0000-0000-000000000001",
      startedAt: Date.now(),
    };

    await runWithContext(ctx, () => wrapped.execute("call-1", {}));

    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBe("user-42");
    expect(events[0]!.traceId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("works without context (userId/traceId undefined)", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    expect(events[0]!.userId).toBeUndefined();
    expect(events[0]!.traceId).toBeUndefined();
  });

  it("includes errorMessage and errorKind on failed execution", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockRejectedValue(new Error("disk full")));
    const wrapped = wrapWithAudit(tool, eventBus);

    await expect(wrapped.execute("call-1", {})).rejects.toThrow("disk full");

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.errorMessage).toBe("disk full");
    expect(events[0]!.errorKind).toBe("internal");
  });

  it("classifies aborted signal as errorKind timeout", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const ac = new AbortController();
    ac.abort();

    const tool = createMockTool(vi.fn().mockRejectedValue(new Error("aborted")));
    const wrapped = wrapWithAudit(tool, eventBus);

    await expect(wrapped.execute("call-1", {}, ac.signal)).rejects.toThrow("aborted");

    expect(events).toHaveLength(1);
    expect(events[0]!.errorKind).toBe("timeout");
  });

  it("reports success=false and a closed-union errorKind (dependency) when tool returns non-zero exitCode", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "failed" }],
      details: { exitCode: 1, stdout: "", stderr: "error" },
    }));
    const wrapped = wrapWithAudit(tool, eventBus);

    const result = await wrapped.execute("call-1", {});

    // Result is returned (not thrown)
    expect(result.details.exitCode).toBe(1);

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    // "nonzero-exit" is NOT a closed ErrorKind.
    // The emit must map it to "dependency" (matches pi-event-bridge.ts).
    expect(events[0]!.errorKind).toBe("dependency");
  });

  it("reports success=false when the tool returns an RPC failure ENVELOPE ({ success:false } in details) — live-incident regression", async () => {
    // The media/messaging RPC-dispatch tools NEVER throw: a failed call returns
    // jsonResult({ success:false, error }) — the envelope rides result.details.
    // Live incident: a 120s image-generation timeout was audited as
    // "Tool audit: image_generate succeeded (120023ms)" — a false success on the
    // obs lens for every envelope-failing tool.
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: '{"success":false,"error":"Image generation timed out"}' }],
      details: { success: false, error: "Image generation timed out" },
    }));
    const wrapped = wrapWithAudit(tool, eventBus);

    const result = await wrapped.execute("call-1", {});

    // The envelope is returned to the model unchanged (not thrown).
    expect((result.details as { success: boolean }).success).toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.errorMessage).toBe("Image generation timed out");
  });

  it("reports success=true when the tool returns an RPC SUCCESS envelope ({ success:true })", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: '{"success":true}' }],
      details: { success: true, imagePath: "~/x.png" },
    }));
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.errorKind).toBeUndefined();
  });

  it("reports success=true when tool returns exitCode 0", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "hello" }],
      details: { exitCode: 0, stdout: "hello", stderr: "" },
    }));
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.errorKind).toBeUndefined();
  });

  it("reports success=true when tool result has no exitCode in details", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
      details: { result: "ok" },
    }));
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-1", {});

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.errorKind).toBeUndefined();
  });

  it("preserves all original tool properties", () => {
    const eventBus = new TypedEventBus();
    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    expect(wrapped.name).toBe(tool.name);
    expect(wrapped.label).toBe(tool.label);
    expect(wrapped.description).toBe(tool.description);
    expect(wrapped.parameters).toBe(tool.parameters);
  });

  // -------------------------------------------------------------------
  // The tool-audit.ts:77 leak close
  // -------------------------------------------------------------------
  it("redacts params before the tool:executed emit (apiKey -> <redacted>, no raw leak)", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-redact", { apiKey: "sk-ant-supersecret0123456789", q: "weather" });

    expect(events).toHaveLength(1);
    const params = events[0]!.params as Record<string, unknown> | undefined;
    expect(params).toBeDefined();
    // The secret key value must be masked, NOT forwarded raw.
    expect(params!.apiKey).toBe("<redacted>");
    expect(JSON.stringify(params)).not.toContain("sk-ant-supersecret0123456789");
    // Non-secret param survives.
    expect(params!.q).toBe("weather");
  });

  it("compacts $HOME paths to ~ in the emitted params when homeDir is threaded", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const HOME = "/home/operator";
    const wrapped = wrapWithAudit(tool, eventBus, "agent-x", HOME);

    await wrapped.execute("call-home", { path: `${HOME}/.comis/config.yaml` });

    expect(events).toHaveLength(1);
    const params = events[0]!.params as Record<string, unknown> | undefined;
    expect(params).toBeDefined();
    // $HOME compacts to ~; the home username never crosses the bus.
    expect(params!.path).toContain("~/.comis/config.yaml");
    expect(JSON.stringify(params)).not.toContain(HOME);
  });

  it("includes toolCallId on the tool:executed emit (was omitted at the leak site)", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool();
    const wrapped = wrapWithAudit(tool, eventBus);

    await wrapped.execute("call-xyz", { q: "ok" });

    expect(events).toHaveLength(1);
    expect(events[0]!.toolCallId).toBe("call-xyz");
  });
});
