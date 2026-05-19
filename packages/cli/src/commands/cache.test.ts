// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-03): `comis cache stats` CLI tests.
 *
 * Mirrors `sessions-behavior.test.ts` mocking pattern — `vi.mock`
 * `withClient` while letting `callTyped` resolve to the real wrapper,
 * so the RPC params + response shape pass through Zod parsing
 * end-to-end.
 *
 * @module
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockRpcClient } from "../mock-rpc-client.js";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock withClient at module level for ESM hoisting; preserve real
// callTyped via importOriginal.
vi.mock("../client/rpc-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../client/rpc-client.js")>();
  return {
    ...actual,
    withClient: vi.fn(),
  };
});

// Pass-through spinner so tests don't see ora output.
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

const { registerCacheCommand } = await import("./cache.js");
const { withClient } = await import("../client/rpc-client.js");

// Plausible response payload for the `obs.cacheStats.window` RPC. The
// CLI receives this shape from `callTyped(client, contract, params)`.
const WINDOW_PAYLOAD = {
  window: {
    sinceMs: 1_700_000_000_000,
    untilMs: 1_700_000_086_400,
    cacheReadTokens: 800,
    cacheCreationTokens: 100,
    nonCachedInputTokens: 100,
    outputTokens: 50,
    turns: 5,
    cacheHitRate: 0.8,
    cacheWriteRate: 0.1,
    byProvider: [
      {
        provider: "anthropic",
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        nonCachedInputTokens: 100,
        outputTokens: 50,
        turns: 5,
        cacheHitRate: 0.8,
        cacheWriteRate: 0.1,
      },
    ],
    byModel: [
      {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        nonCachedInputTokens: 100,
        outputTokens: 50,
        turns: 5,
        cacheHitRate: 0.8,
        cacheWriteRate: 0.1,
      },
    ],
    byAgent: [
      {
        agentId: "agent-1",
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        nonCachedInputTokens: 100,
        outputTokens: 50,
        turns: 5,
        cacheHitRate: 0.8,
        cacheWriteRate: 0.1,
      },
    ],
  },
};

describe("renders_table_format_by_default", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.cacheStats.window", WINDOW_PAYLOAD)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("table format prints cacheHitRate as a percentage plus by-provider rows", async () => {
    const program = createTestProgram();
    registerCacheCommand(program);
    await program.parseAsync(["node", "test", "cache", "stats"]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("80.00%"); // cacheHitRate
    expect(out).toContain("10.00%"); // cacheWriteRate
    expect(out).toContain("anthropic"); // by-provider row
    expect(out).toContain("claude-sonnet-4-5"); // by-model row
    expect(out).toContain("agent-1"); // by-agent row
  });
});

describe("renders_json_format_when_format_json", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.cacheStats.window", WINDOW_PAYLOAD)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("--format json emits parseable JSON of the window", async () => {
    const program = createTestProgram();
    registerCacheCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cache",
      "stats",
      "--format",
      "json",
    ]);

    const out = getSpyOutput(consoleSpy.log);
    // The CLI emits one JSON.stringify(..., null, 2). Parse and verify shape.
    const parsed = JSON.parse(out) as typeof WINDOW_PAYLOAD.window;
    expect(parsed.cacheReadTokens).toBe(800);
    expect(parsed.byProvider[0]?.provider).toBe("anthropic");
  });
});

describe("renders_markdown_format_when_format_markdown", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = createMockRpcClient()
        .onCall("obs.cacheStats.window", WINDOW_PAYLOAD)
        .build();
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("--format markdown emits CommonMark pipe-tables with By Provider heading", async () => {
    const program = createTestProgram();
    registerCacheCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cache",
      "stats",
      "--format",
      "markdown",
    ]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("# Cache Stats");
    expect(out).toContain("## By Provider");
    expect(out).toContain("| Provider |");
    expect(out).toContain("| anthropic |");
  });
});

describe("propagates_filter_options_to_rpc_call", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;
  let captured: Array<{ method: string; params: Record<string, unknown> }>;

  beforeEach(() => {
    vi.mocked(withClient).mockReset();
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    captured = [];
    vi.mocked(withClient).mockImplementation(async (fn) => {
      const mockClient = {
        async call(method: string, params: Record<string, unknown>) {
          captured.push({ method, params });
          return WINDOW_PAYLOAD;
        },
        on() {},
        onStatusChange() {
          return () => {};
        },
      } as never;
      return fn(mockClient);
    });
  });

  afterEach(() => {
    consoleSpy.restore();
    exitSpy.restore();
  });

  it("threads --since/--agent/--provider into the RPC payload", async () => {
    const program = createTestProgram();
    registerCacheCommand(program);
    await program.parseAsync([
      "node",
      "test",
      "cache",
      "stats",
      "--since",
      "24h",
      "--agent",
      "agent-1",
      "--provider",
      "anthropic",
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("obs.cacheStats.window");
    const sentParams = captured[0]?.params as {
      sinceMs: number;
      agent?: string;
      provider?: string;
    };
    expect(sentParams.sinceMs).toBeGreaterThan(0);
    expect(sentParams.agent).toBe("agent-1");
    expect(sentParams.provider).toBe("anthropic");
  });
});
