// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { createProcessTool } from "./process-tool.js";
import {
  createProcessRegistry,
  generateSessionId,
  type ProcessSession,
  type ProcessRegistry,
} from "./process-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let registry: ProcessRegistry;

function makeSession(overrides: Partial<ProcessSession> = {}): ProcessSession {
  return {
    id: overrides.id ?? generateSessionId(),
    command: overrides.command ?? "echo hello",
    pid: overrides.pid ?? 12345,
    startedAt: overrides.startedAt ?? Date.now(),
    status: overrides.status ?? "running",
    exitCode: overrides.exitCode ?? undefined,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    child: overrides.child ?? undefined,
    maxOutputChars: overrides.maxOutputChars ?? 1024 * 1024,
  };
}

beforeEach(() => {
  registry = createProcessRegistry();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProcessTool", () => {
  it("has correct name, label, description", () => {
    const tool = createProcessTool(registry);
    expect(tool.name).toBe("process");
    expect(tool.label).toBe("Process");
    expect(tool.description).toContain("Manage background processes");
  });

  it("has correct parameter schema shape", () => {
    const tool = createProcessTool(registry);
    const props = (tool.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(props).toHaveProperty("action");
    expect(props).toHaveProperty("sessionId");
    expect(props).toHaveProperty("offset");
    expect(props).toHaveProperty("limit");
  });

  describe("list action", () => {
    it("returns empty array when no processes", async () => {
      const tool = createProcessTool(registry);
      const result = await tool.execute("tc1", { action: "list" });
      expect(result.details).toEqual([]);
    });

    it("returns sessions when processes exist", async () => {
      registry.add(
        makeSession({ id: "s1", command: "sleep 10", status: "running" }),
      );
      registry.add(
        makeSession({ id: "s2", command: "echo hi", status: "completed" }),
      );

      const tool = createProcessTool(registry);
      const result = await tool.execute("tc1", { action: "list" });
      const details = result.details as Array<{ sessionId: string }>;
      expect(details).toHaveLength(2);
      expect(details[0].sessionId).toBe("s1");
      expect(details[1].sessionId).toBe("s2");
    });
  });

  describe("kill action", () => {
    it("requires sessionId (throws if missing)", async () => {
      const tool = createProcessTool(registry);
      await expect(tool.execute("tc1", { action: "kill" })).rejects.toThrow(/sessionId/);
    });

    it("throws for unknown sessionId", async () => {
      const tool = createProcessTool(registry);
      await expect(tool.execute("tc1", { action: "kill", sessionId: "nonexistent" })).rejects.toThrow(/not found/);
    });
  });

  describe("status action", () => {
    it("returns session details for known sessionId", async () => {
      registry.add(
        makeSession({
          id: "s1",
          command: "ls -la",
          stdout: "file1\n",
          stderr: "warn\n",
        }),
      );

      const tool = createProcessTool(registry);
      const result = await tool.execute("tc1", {
        action: "status",
        sessionId: "s1",
      });
      const details = result.details as {
        sessionId: string;
        status: string;
        command: string;
      };
      expect(details.sessionId).toBe("s1");
      expect(details.status).toBe("running");
      expect(details.command).toBe("ls -la");
    });

    it("throws for unknown sessionId", async () => {
      const tool = createProcessTool(registry);
      await expect(tool.execute("tc1", { action: "status", sessionId: "nonexistent" })).rejects.toThrow(/not found/);
    });
  });

  describe("log action", () => {
    it("returns paginated log lines", async () => {
      const stdout = "line1\nline2\nline3\nline4\nline5";
      registry.add(makeSession({ id: "s1", stdout }));

      const tool = createProcessTool(registry);
      const result = await tool.execute("tc1", {
        action: "log",
        sessionId: "s1",
      });
      const details = result.details as { lines: string[]; total: number };
      expect(details.lines).toHaveLength(5);
      expect(details.total).toBe(5);
    });

    it("throws for unknown sessionId", async () => {
      const tool = createProcessTool(registry);
      await expect(tool.execute("tc1", { action: "log", sessionId: "nonexistent" })).rejects.toThrow(/not found/);
    });

    it("respects offset and limit parameters", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
      registry.add(makeSession({ id: "s1", stdout: lines.join("\n") }));

      const tool = createProcessTool(registry);
      const result = await tool.execute("tc1", {
        action: "log",
        sessionId: "s1",
        offset: 10,
        limit: 5,
      });
      const details = result.details as { lines: string[]; total: number };
      expect(details.lines).toHaveLength(5);
      expect(details.lines[0]).toBe("line-10");
      expect(details.lines[4]).toBe("line-14");
      expect(details.total).toBe(50);
    });
  });

  describe("unknown action", () => {
    it("throws structured error for invalid action", async () => {
      const tool = createProcessTool(registry);
      await expect(tool.execute("tc1", { action: "restart" })).rejects.toThrow(/invalid_value.*restart/);
    });
  });
});
