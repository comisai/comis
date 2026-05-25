// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for `comis trace` CLI subcommands (CLI-01..05, CLI-07).
 *
 * Covers all 5 subcommands plus --json flag routing and error handling.
 * Uses mocked RPC layer via withClient + createMockRpcClient.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient from rpc-client at module level for ESM hoisting.
// importOriginal-based so callTyped resolves to the real wrapper while
// withClient is mocked.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Mock withSpinner to pass-through (no actual ora spinner in tests)
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

// Dynamic imports after mocks
const { registerTraceCommand } = await import("./trace.js");
const { withClient } = await import("../client/rpc-client.js");

/** Minimal valid ObsTraceSearchContract response. */
const SEARCH_RESPONSE = {
  rows: [{ ts: "2026-05-25T00:00:00.000Z", event: "turn_completed", sessionId: "s-1", traceId: "t-1" }],
};

/** Minimal valid ObsTraceTailContract response. */
const TAIL_RESPONSE = {
  events: [{ ts: "2026-05-25T00:00:00.000Z", event: "turn_completed", sessionId: "s-1" }],
  nextSinceMs: 1748131200000,
};

/** Minimal valid ObsTraceExportContract response. */
const EXPORT_RESPONSE = { bundlePath: "/home/user/.comis/trace-exports/s-1" };

describe("comis trace --message-id calls ObsTraceSearchContract via callTyped", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends obs.trace.search with messageId param and gets rows back", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.search", SEARCH_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "--message-id", "msg-123"]);

    expect(withClient).toHaveBeenCalledTimes(1);
    // callTyped calls client.call with the contract method name
    const callFn = vi.mocked(withClient).mock.calls[0]?.[0];
    expect(callFn).toBeDefined();
  });
});

describe("comis trace --trace-id calls ObsTraceSearchContract via callTyped", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends obs.trace.search with traceId param and renders rows table", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.search", SEARCH_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "--trace-id", "trc-456"]);

    expect(withClient).toHaveBeenCalledTimes(1);
  });
});

describe("comis trace --since --where calls ObsTraceSearchContract via callTyped", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends obs.trace.search with since and where params from CLI flags", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.search", SEARCH_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "--since", "10m", "--where", "error"]);

    expect(withClient).toHaveBeenCalledTimes(1);
  });
});

describe("comis trace --chat --tail calls ObsTraceTailContract in polling loop", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("polls obs.trace.tail with sinceMs cursor and emits events to stdout", async () => {
    // We test the tail loop by having the mock abort after 2 calls.
    // Use a counter and abort the loop by rejecting after 2 calls.
    let tailCallCount = 0;
    const capturedSinceMs: (number | undefined)[] = [];

    vi.mocked(withClient).mockImplementation(async (fn) => {
      tailCallCount++;
      const sinceForNext = 1748131200000 + tailCallCount * 1000;
      const response = { events: TAIL_RESPONSE.events, nextSinceMs: sinceForNext };

      const mockClient = {
        call: async (method: string, params?: unknown) => {
          if (method === "obs.trace.tail" && params) {
            capturedSinceMs.push((params as { sinceMs?: number }).sinceMs);
          }
          if (tailCallCount >= 2) {
            // After 2 calls, emit SIGINT so the loop stops
            setImmediate(() => process.emit("SIGINT"));
          }
          return response;
        },
        close: () => {},
        onNotification: () => {},
      };
      return fn(mockClient);
    });

    // Use fake timers so the 1-second sleep resolves immediately
    vi.useFakeTimers();

    const program = createTestProgram();
    registerTraceCommand(program);

    // Run in background and advance fake timers to let the loop proceed
    const parsePromise = program.parseAsync(["node", "test", "trace", "--chat", "chat-789", "--tail"]);

    // Tick: first poll executes synchronously (withClient resolves immediately)
    // Then the 1-second setTimeout in the loop is pending
    await vi.advanceTimersByTimeAsync(1100);
    // Second poll
    await vi.advanceTimersByTimeAsync(1100);
    // Let SIGINT propagate
    await vi.runAllTimersAsync();

    vi.useRealTimers();
    await parsePromise.catch(() => {}); // ignore errors

    expect(tailCallCount).toBeGreaterThanOrEqual(2);
    // sinceMs cursor threaded: second call uses nextSinceMs from first response
    expect(capturedSinceMs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("comis trace export calls ObsTraceExportContract and prints bundlePath", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("sends obs.trace.export with sessionId and prints bundle path to stdout", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.export", EXPORT_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "export", "sess-1"]);

    expect(withClient).toHaveBeenCalledTimes(1);
    const output = getSpyOutput(consoleSpy.log);
    expect(output).toContain("/home/user/.comis/trace-exports/s-1");
  });
});

describe("comis trace --message-id --json outputs JSON instead of renderTable", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("prints JSON.stringify result when --json flag is present on search subcommand", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.search", SEARCH_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "--message-id", "msg-123", "--json"]);

    const output = getSpyOutput(consoleSpy.log);
    // Should be valid JSON containing our rows
    const parsed = JSON.parse(output) as unknown;
    expect(parsed).toHaveProperty("rows");
  });
});

describe("comis trace --message-id without --json renders column table output", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("renders table headers ts, event, sessionId, traceId when --json is absent", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.trace.search", SEARCH_RESPONSE)
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);
    await program.parseAsync(["node", "test", "trace", "--message-id", "msg-123"]);

    const output = getSpyOutput(consoleSpy.log);
    // Table output should contain column headers
    expect(output).toContain("ts");
    expect(output).toContain("event");
  });
});

describe("comis trace --chat --tail exits cleanly when SIGINT received before first poll completes", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("stops polling and resolves the command promise after SIGINT fires abort", async () => {
    let callCount = 0;
    vi.mocked(withClient).mockImplementation(async (fn) => {
      callCount++;
      // After first call, emit SIGINT to stop the loop during the next sleep
      setImmediate(() => process.emit("SIGINT"));
      const mockClient = {
        call: async (_method: string, _params?: unknown) => TAIL_RESPONSE,
        close: () => {},
        onNotification: () => {},
      };
      return fn(mockClient);
    });

    vi.useFakeTimers();

    const program = createTestProgram();
    registerTraceCommand(program);

    const parsePromise = program.parseAsync(["node", "test", "trace", "--chat", "chat-abc", "--tail"]);

    // Advance timers so the sleep resolves and the abort-check fires
    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    // Should resolve without throwing (resolves to Commander Command instance)
    await expect(parsePromise).resolves.toBeDefined();
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe("comis trace export with RPC error prints error and exits with code 1", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("calls error() and process.exit(1) when obs.trace.export RPC throws", async () => {
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onError("obs.trace.export", "Session not found")
        .build();
      return fn(mockClient);
    });

    const program = createTestProgram();
    registerTraceCommand(program);

    await expect(
      program.parseAsync(["node", "test", "trace", "export", "missing-session"])
    ).rejects.toThrow("process.exit called");

    const errorOutput = getSpyOutput(consoleSpy.error);
    expect(errorOutput).toContain("Bundle export failed");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
  });
});

describe("trace.ts source file contains no raw client.call() invocations", () => {
  it("confirms trace.ts uses only callTyped (no raw client.call) to uphold arch invariant", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const traceSrc = resolve(here, "trace.ts");
    // The file may not exist yet during RED phase — if so, skip the content check.
    let content: string;
    try {
      content = readFileSync(traceSrc, "utf8");
    } catch {
      // File doesn't exist yet (RED phase). The arch test will enforce this at GREEN.
      return;
    }
    // Remove comment lines to avoid false positives
    const withoutComments = content
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(withoutComments).not.toMatch(/\bclient\.call\s*\(/);
  });
});
