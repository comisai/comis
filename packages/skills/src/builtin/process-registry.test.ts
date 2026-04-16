import { describe, it, expect, vi } from "vitest";
import {
  createProcessRegistry,
  generateSessionId,
  appendOutput,
  type ProcessSession,
} from "./process-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    sandboxed: overrides.sandboxed ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProcessRegistry", () => {
  it("returns registry with all methods", () => {
    const registry = createProcessRegistry();
    expect(typeof registry.add).toBe("function");
    expect(typeof registry.get).toBe("function");
    expect(typeof registry.list).toBe("function");
    expect(typeof registry.kill).toBe("function");
    expect(typeof registry.status).toBe("function");
    expect(typeof registry.getLog).toBe("function");
    expect(typeof registry.cleanup).toBe("function");
    expect(typeof registry.size).toBe("function");
  });

  it("add + get stores and retrieves session", () => {
    const registry = createProcessRegistry();
    const session = makeSession({ id: "sess-1" });
    registry.add(session);
    expect(registry.get("sess-1")).toBe(session);
  });

  it("get returns undefined for unknown ID", () => {
    const registry = createProcessRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("list returns all sessions with correct shape", () => {
    const registry = createProcessRegistry();
    registry.add(makeSession({ id: "s1", command: "sleep 10", stdout: "line1\nline2\n" }));
    registry.add(makeSession({ id: "s2", command: "echo hi", stdout: "hello\n" }));

    const result = registry.list();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
      expect.objectContaining({
        sessionId: "s1",
        command: "sleep 10",
        status: "running",
        pid: 12345,
      }),
    );
    expect(typeof result[0].runtimeMs).toBe("number");
    expect(typeof result[0].tail).toBe("string");
  });

  it("list calculates runtimeMs correctly", () => {
    const registry = createProcessRegistry();
    const startedAt = Date.now() - 5000; // 5 seconds ago
    registry.add(makeSession({ id: "s1", startedAt }));

    const result = registry.list();
    // runtimeMs should be approximately 5000ms (give or take 100ms for test execution)
    expect(result[0].runtimeMs).toBeGreaterThanOrEqual(4900);
    expect(result[0].runtimeMs).toBeLessThan(6000);
  });

  it("list returns last 5 lines of stdout as tail", () => {
    const registry = createProcessRegistry();
    const stdout = "line1\nline2\nline3\nline4\nline5\nline6\nline7\n";
    registry.add(makeSession({ id: "s1", stdout }));

    const result = registry.list();
    const tailLines = result[0].tail.split("\n");
    expect(tailLines).toHaveLength(5);
    expect(tailLines[0]).toBe("line3");
    expect(tailLines[4]).toBe("line7");
  });

  it("size returns correct count", () => {
    const registry = createProcessRegistry();
    expect(registry.size()).toBe(0);
    registry.add(makeSession({ id: "s1" }));
    expect(registry.size()).toBe(1);
    registry.add(makeSession({ id: "s2" }));
    expect(registry.size()).toBe(2);
  });

  it("status returns session details for known ID", () => {
    const registry = createProcessRegistry();
    const session = makeSession({
      id: "s1",
      command: "ls -la",
      stdout: "file1\nfile2\n",
      stderr: "warn\n",
    });
    registry.add(session);

    const result = registry.status("s1");
    expect(result).toBeDefined();
    expect(result!.sessionId).toBe("s1");
    expect(result!.status).toBe("running");
    expect(result!.command).toBe("ls -la");
    expect(result!.stdoutLength).toBe(session.stdout.length);
    expect(result!.stderrLength).toBe(session.stderr.length);
    expect(typeof result!.runtimeMs).toBe("number");
  });

  it("status returns undefined for unknown ID", () => {
    const registry = createProcessRegistry();
    expect(registry.status("nonexistent")).toBeUndefined();
  });

  it("getLog returns paginated lines", () => {
    const registry = createProcessRegistry();
    const stdout = "line1\nline2\nline3\nline4\nline5";
    registry.add(makeSession({ id: "s1", stdout }));

    const result = registry.getLog("s1");
    expect(result).toBeDefined();
    expect(result!.lines).toHaveLength(5);
    expect(result!.total).toBe(5);
  });

  it("getLog returns last N lines when no offset", () => {
    const registry = createProcessRegistry();
    // Create many lines
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}`);
    registry.add(makeSession({ id: "s1", stdout: lines.join("\n") }));

    // Default limit is 200
    const result = registry.getLog("s1");
    expect(result).toBeDefined();
    expect(result!.lines).toHaveLength(200);
    // Should be the LAST 200 lines
    expect(result!.lines[0]).toBe("line-100");
    expect(result!.lines[199]).toBe("line-299");
    expect(result!.total).toBe(300);
  });

  it("getLog with offset+limit returns correct slice", () => {
    const registry = createProcessRegistry();
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);
    registry.add(makeSession({ id: "s1", stdout: lines.join("\n") }));

    const result = registry.getLog("s1", 10, 5);
    expect(result).toBeDefined();
    expect(result!.lines).toHaveLength(5);
    expect(result!.lines[0]).toBe("line-10");
    expect(result!.lines[4]).toBe("line-14");
    expect(result!.total).toBe(50);
  });

  it("getLog returns undefined for unknown ID", () => {
    const registry = createProcessRegistry();
    expect(registry.getLog("nonexistent")).toBeUndefined();
  });

  it("kill throws for unknown session ID", async () => {
    const registry = createProcessRegistry();
    await expect(registry.kill("nonexistent")).rejects.toThrow(
      "Process session not found: nonexistent",
    );
  });

  it("kill throws for non-running session", async () => {
    const registry = createProcessRegistry();
    registry.add(makeSession({ id: "s1", status: "completed" }));
    await expect(registry.kill("s1")).rejects.toThrow("not running");
  });

  it("kill sends SIGTERM and updates status for session with mock child", async () => {
    const registry = createProcessRegistry();

    let exitCallback: ((code: number | null) => void) | undefined;
    const mockChild = {
      exitCode: null,
      pid: 99999,
      once(event: string, cb: (code: number | null) => void) {
        if (event === "exit") exitCallback = cb;
      },
      removeListener: vi.fn(),
    };

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      // Simulate async exit after SIGTERM
      setTimeout(() => exitCallback?.(0), 10);
    }) as typeof process.kill);

    try {
      const session = makeSession({
        id: "s1",
        pid: 99999,
        child: mockChild as unknown as import("node:child_process").ChildProcess,
      });
      registry.add(session);

      const result = await registry.kill("s1");
      expect(result.killed).toBe(true);
      expect(session.status).toBe("killed");
      expect(killSpy).toHaveBeenCalledWith(-99999, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("cleanup returns count of killed processes and clears map", async () => {
    const registry = createProcessRegistry();
    // Add sessions with no real child processes (child: undefined)
    registry.add(makeSession({ id: "s1", status: "running" }));
    registry.add(makeSession({ id: "s2", status: "running" }));
    registry.add(makeSession({ id: "s3", status: "completed" }));

    const killed = await registry.cleanup();
    expect(killed).toBe(2); // Only running sessions
    expect(registry.size()).toBe(0); // Map cleared
  });
});

describe("generateSessionId", () => {
  it("returns valid UUID format", () => {
    const id = generateSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSessionId()));
    expect(ids.size).toBe(10);
  });
});

describe("appendOutput", () => {
  it("appends chunk to specified field", () => {
    const session = makeSession({ stdout: "hello " });
    appendOutput(session, "stdout", "world");
    expect(session.stdout).toBe("hello world");
  });

  it("truncates from beginning when exceeding maxOutputChars", () => {
    const session = makeSession({ stdout: "AB", maxOutputChars: 5 });
    appendOutput(session, "stdout", "CDEF");
    // Total would be "ABCDEF" (6 chars), max is 5, so keep last 5
    expect(session.stdout).toBe("BCDEF");
  });

  it("works with stderr field", () => {
    const session = makeSession({ stderr: "" });
    appendOutput(session, "stderr", "error msg");
    expect(session.stderr).toBe("error msg");
  });
});

// ---------------------------------------------------------------------------
// Sandbox-aware killProcessGroup tests
// ---------------------------------------------------------------------------

describe("sandbox-aware killProcessGroup", () => {
  it("killProcessGroup uses negative PID for unsandboxed session", async () => {
    const registry = createProcessRegistry();

    let exitCallback: ((code: number | null) => void) | undefined;
    const mockChild = {
      exitCode: null,
      pid: 88888,
      once(event: string, cb: (code: number | null) => void) {
        if (event === "exit") exitCallback = cb;
      },
      removeListener: vi.fn(),
    };

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      // Simulate async exit after SIGTERM
      setTimeout(() => exitCallback?.(0), 10);
    }) as typeof process.kill);

    try {
      const session = makeSession({
        id: "unsandboxed-1",
        pid: 88888,
        sandboxed: false,
        child: mockChild as unknown as import("node:child_process").ChildProcess,
      });
      registry.add(session);

      const result = await registry.kill("unsandboxed-1");
      expect(result.killed).toBe(true);
      expect(session.status).toBe("killed");
      // Should use negative PID (process group kill) for unsandboxed
      expect(killSpy).toHaveBeenCalledWith(-88888, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("killProcessGroup uses positive PID for sandboxed session", async () => {
    const registry = createProcessRegistry();

    let exitCallback: ((code: number | null) => void) | undefined;
    const mockChild = {
      exitCode: null,
      pid: 77777,
      once(event: string, cb: (code: number | null) => void) {
        if (event === "exit") exitCallback = cb;
      },
      removeListener: vi.fn(),
    };

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      // Simulate async exit after SIGTERM
      setTimeout(() => exitCallback?.(0), 10);
    }) as typeof process.kill);

    try {
      const session = makeSession({
        id: "sandboxed-1",
        pid: 77777,
        sandboxed: true,
        child: mockChild as unknown as import("node:child_process").ChildProcess,
      });
      registry.add(session);

      const result = await registry.kill("sandboxed-1");
      expect(result.killed).toBe(true);
      expect(session.status).toBe("killed");
      // Should use positive PID (direct kill) for sandboxed
      expect(killSpy).toHaveBeenCalledWith(77777, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("cleanup kills sandboxed sessions with positive PID", async () => {
    const registry = createProcessRegistry();

    let exitCallback: ((code: number | null) => void) | undefined;
    const mockChild = {
      exitCode: null,
      pid: 66666,
      once(event: string, cb: (code: number | null) => void) {
        if (event === "exit") exitCallback = cb;
      },
      removeListener: vi.fn(),
    };

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      setTimeout(() => exitCallback?.(0), 10);
    }) as typeof process.kill);

    try {
      const session = makeSession({
        id: "cleanup-sandboxed-1",
        pid: 66666,
        sandboxed: true,
        child: mockChild as unknown as import("node:child_process").ChildProcess,
      });
      registry.add(session);

      const killed = await registry.cleanup();
      expect(killed).toBe(1);
      // Should use positive PID for sandboxed session during cleanup
      expect(killSpy).toHaveBeenCalledWith(66666, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});
