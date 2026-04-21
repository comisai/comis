// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for ResultCondenser -- 3-level condensation pipeline.
 *
 * Tests verify:
 * - Level 1 passthrough for short results / strategy "never"
 * - Level 2 LLM condensation with mocked generateSummary
 * - Level 3 truncation fallback on LLM failure or no model
 * - Disk offload persistence at every level
 * - Session key sanitization (colons -> underscores)
 * - Post-condensation validation merging missing file paths
 * - Hard cap on disk write (500K chars)
 * - Strategy "always" forces condensation even for short results
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ResultCondenserDeps, CondenseParams } from "./result-condenser.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock @mariozechner/pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", () => ({
  generateSummary: vi.fn(),
  truncateHead: vi.fn((text: string, opts: { maxBytes: number }) => ({
    content: text.slice(0, opts.maxBytes),
    wasTruncated: text.length > opts.maxBytes,
  })),
  truncateTail: vi.fn((text: string, opts: { maxBytes: number }) => ({
    content: text.slice(-opts.maxBytes),
    wasTruncated: text.length > opts.maxBytes,
  })),
}));

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock @comis/core safePath -- return a predictable path without filesystem checks
vi.mock("@comis/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@comis/core")>();
  return {
    ...orig,
    safePath: vi.fn((...args: string[]) => args.join("/")),
  };
});

// Import after mocks
import { createResultCondenser } from "./result-condenser.js";
import { generateSummary } from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDeps(overrides?: Partial<ResultCondenserDeps>): ResultCondenserDeps {
  return {
    maxResultTokens: 1000,
    condensationStrategy: "auto",
    dataDir: "/tmp/test-comis",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function createTestParams(overrides?: Partial<CondenseParams>): CondenseParams {
  return {
    fullResult: "Short result text",
    task: "test task",
    runId: "r1",
    sessionKey: "s1",
    agentId: "a1",
    ...overrides,
  };
}

// 4 chars per token, so 1000 tokens = 4000 chars
const CHARS_PER_TOKEN = 4;

function makeString(charCount: number): string {
  return "x".repeat(charCount);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultCondenser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: Level 1 passthrough for short results
  // -------------------------------------------------------------------------
  it("Level 1: passthrough for short results below maxResultTokens", async () => {
    const deps = createTestDeps({ maxResultTokens: 1000 });
    const condenser = createResultCondenser(deps);

    const result = await condenser.condense(createTestParams({
      fullResult: "Short result",
    }));

    expect(result.level).toBe(1);
    expect(result.result.taskComplete).toBe(true);
    expect(result.result.summary).toContain("Short result");
    expect(result.diskPath).toBeDefined();
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();

    // Verify disk write contains condensationLevel: 1
    const writeCall = (writeFile as Mock).mock.calls[0];
    const diskJson = JSON.parse(writeCall![1] as string);
    expect(diskJson.condensationLevel).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: Strategy "never" always produces Level 1
  // -------------------------------------------------------------------------
  it("Level 1: strategy 'never' always produces passthrough even for huge results", async () => {
    const deps = createTestDeps({
      maxResultTokens: 100,
      condensationStrategy: "never",
    });
    const condenser = createResultCondenser(deps);

    // 50K chars = way over 100 token limit (400 chars)
    const hugeResult = makeString(50_000);
    const result = await condenser.condense(createTestParams({
      fullResult: hugeResult,
      model: { id: "test-model" },
      apiKey: "test-key",
    }));

    expect(result.level).toBe(1);
    expect(generateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 3: Level 2 LLM condensation with valid JSON output
  // -------------------------------------------------------------------------
  it("Level 2: LLM condensation with valid JSON output", async () => {
    const deps = createTestDeps({ maxResultTokens: 100 });
    const condenser = createResultCondenser(deps);

    const validJson = JSON.stringify({
      taskComplete: true,
      summary: "Condensed summary",
      conclusions: ["Found issue in module X"],
      filePaths: ["/src/foo.ts"],
    });
    (generateSummary as Mock).mockResolvedValue(validJson);

    const result = await condenser.condense(createTestParams({
      fullResult: makeString(2000),
      model: { id: "test-model" },
      apiKey: "test-key",
    }));

    expect(result.level).toBe(2);
    expect(result.result.taskComplete).toBe(true);
    expect(result.result.summary).toBe("Condensed summary");
    expect(result.result.filePaths).toContain("/src/foo.ts");
  });

  // -------------------------------------------------------------------------
  // Test 4: Level 2 LLM output with markdown fencing
  // -------------------------------------------------------------------------
  it("Level 2: handles markdown-fenced JSON output from LLM", async () => {
    const deps = createTestDeps({ maxResultTokens: 100 });
    const condenser = createResultCondenser(deps);

    const fencedJson = "```json\n" + JSON.stringify({
      taskComplete: true,
      summary: "Fenced condensed result",
      conclusions: ["Test conclusion"],
    }) + "\n```";
    (generateSummary as Mock).mockResolvedValue(fencedJson);

    const result = await condenser.condense(createTestParams({
      fullResult: makeString(2000),
      model: { id: "test-model" },
      apiKey: "test-key",
    }));

    expect(result.level).toBe(2);
    expect(result.result.summary).toBe("Fenced condensed result");
  });

  // -------------------------------------------------------------------------
  // Test 5: Strategy "always" forces condensation even for short results
  // -------------------------------------------------------------------------
  it("Level 2: strategy 'always' forces condensation even for short results", async () => {
    const deps = createTestDeps({
      maxResultTokens: 10000,
      condensationStrategy: "always",
    });
    const condenser = createResultCondenser(deps);

    const validJson = JSON.stringify({
      taskComplete: true,
      summary: "Forced condensation",
      conclusions: ["Always condensed"],
    });
    (generateSummary as Mock).mockResolvedValue(validJson);

    const result = await condenser.condense(createTestParams({
      fullResult: "Short text",
      model: { id: "test-model" },
      apiKey: "test-key",
    }));

    expect(result.level).toBe(2);
    expect(generateSummary).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 6: Level 3 fallback when generateSummary throws
  // -------------------------------------------------------------------------
  it("Level 3: fallback when generateSummary throws", async () => {
    const deps = createTestDeps({ maxResultTokens: 100 });
    const condenser = createResultCondenser(deps);

    (generateSummary as Mock).mockRejectedValue(new Error("API error"));

    const result = await condenser.condense(createTestParams({
      fullResult: makeString(2000),
      model: { id: "test-model" },
      apiKey: "test-key",
    }));

    expect(result.level).toBe(3);
    expect(result.result.taskComplete).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: Level 3 when no model available
  // -------------------------------------------------------------------------
  it("Level 3: no model available skips LLM and uses truncation", async () => {
    const deps = createTestDeps({ maxResultTokens: 100 });
    const condenser = createResultCondenser(deps);

    const result = await condenser.condense(createTestParams({
      fullResult: makeString(2000),
      // No model or apiKey
    }));

    expect(result.level).toBe(3);
    expect(generateSummary).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: Disk offload -- full result always persisted
  // -------------------------------------------------------------------------
  describe("Disk offload", () => {
    it("persists for Level 1", async () => {
      const deps = createTestDeps({ maxResultTokens: 1000 });
      const condenser = createResultCondenser(deps);

      await condenser.condense(createTestParams({ fullResult: "L1 result", runId: "run-l1", sessionKey: "sk-l1" }));

      expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
      expect(writeFile).toHaveBeenCalled();
      const writeCall = (writeFile as Mock).mock.calls[0];
      const diskJson = JSON.parse(writeCall![1] as string);
      expect(diskJson.fullResult).toBe("L1 result");
      expect(diskJson.runId).toBe("run-l1");
      expect(diskJson.sessionKey).toBe("sk-l1");
      expect(diskJson.condensationLevel).toBe(1);
    });

    it("persists for Level 2", async () => {
      const deps = createTestDeps({ maxResultTokens: 100 });
      const condenser = createResultCondenser(deps);
      (generateSummary as Mock).mockResolvedValue(JSON.stringify({
        taskComplete: true, summary: "L2 condensed", conclusions: ["c1"],
      }));

      await condenser.condense(createTestParams({
        fullResult: makeString(2000), runId: "run-l2", sessionKey: "sk-l2",
        model: { id: "m" }, apiKey: "k",
      }));

      expect(writeFile).toHaveBeenCalled();
      const writeCall = (writeFile as Mock).mock.calls[0];
      const diskJson = JSON.parse(writeCall![1] as string);
      expect(diskJson.condensationLevel).toBe(2);
      expect(diskJson.runId).toBe("run-l2");
    });

    it("persists for Level 3", async () => {
      const deps = createTestDeps({ maxResultTokens: 100 });
      const condenser = createResultCondenser(deps);

      await condenser.condense(createTestParams({
        fullResult: makeString(2000), runId: "run-l3", sessionKey: "sk-l3",
        // No model -> L3
      }));

      expect(writeFile).toHaveBeenCalled();
      const writeCall = (writeFile as Mock).mock.calls[0];
      const diskJson = JSON.parse(writeCall![1] as string);
      expect(diskJson.condensationLevel).toBe(3);
      expect(diskJson.runId).toBe("run-l3");
    });
  });

  // -------------------------------------------------------------------------
  // Test 9: Session key sanitization
  // -------------------------------------------------------------------------
  it("uses simplified tenantId-based directory naming in disk path", async () => {
    const deps = createTestDeps({ maxResultTokens: 1000 });
    const condenser = createResultCondenser(deps);

    const result = await condenser.condense(createTestParams({
      sessionKey: "default:user:channel",
    }));

    // Simplified naming: {tenantId}/{runId}.json -- no colons, tenantId only
    expect(result.diskPath).toContain("/default/");
    expect(result.diskPath).not.toContain("default:user:channel");
    expect(result.diskPath).not.toContain("default_user_channel");
  });

  // -------------------------------------------------------------------------
  // Test 10: Post-condensation validation merges missing paths
  // -------------------------------------------------------------------------
  it("merges missing file paths from original into condensed result", async () => {
    const deps = createTestDeps({ maxResultTokens: 100 });
    const condenser = createResultCondenser(deps);

    // Original result mentions two paths (must exceed maxResultTokens: 100 = 400 chars)
    const originalWithPaths = makeString(500) + " Modified /src/foo.ts and /src/bar.ts for the feature";

    // LLM only returns one path in condensed output
    const condensedJson = JSON.stringify({
      taskComplete: true,
      summary: "Condensed: modified /src/foo.ts",
      conclusions: ["Changed foo"],
      filePaths: ["/src/foo.ts"],
    });
    (generateSummary as Mock).mockResolvedValue(condensedJson);

    const result = await condenser.condense(createTestParams({
      fullResult: originalWithPaths,
      model: { id: "m" },
      apiKey: "k",
    }));

    expect(result.level).toBe(2);
    expect(result.result.filePaths).toContain("/src/foo.ts");
    expect(result.result.filePaths).toContain("/src/bar.ts");
  });

  // -------------------------------------------------------------------------
  // Test 11: Hard cap on disk write for huge results
  // -------------------------------------------------------------------------
  it("caps disk write to 500K chars for huge results", async () => {
    const deps = createTestDeps({ maxResultTokens: 1000 });
    const condenser = createResultCondenser(deps);

    const hugeResult = makeString(600_000);
    await condenser.condense(createTestParams({ fullResult: hugeResult }));

    expect(writeFile).toHaveBeenCalled();
    const writeCall = (writeFile as Mock).mock.calls[0];
    const diskJson = JSON.parse(writeCall![1] as string);
    // The fullResult in disk should be capped at 500K
    expect(diskJson.fullResult.length).toBeLessThanOrEqual(500_000);
  });

  // -------------------------------------------------------------------------
  // Test 12: wrapAsSubagentResult strips <think> tags from summary
  // -------------------------------------------------------------------------
  it("Level 1: strips <think> tags from summary in passthrough", async () => {
    const deps = createTestDeps({ maxResultTokens: 1000 });
    const condenser = createResultCondenser(deps);

    const result = await condenser.condense(createTestParams({
      fullResult: "<think>internal reasoning</think>visible text",
    }));

    expect(result.level).toBe(1);
    expect(result.result.summary).not.toContain("<think>");
    expect(result.result.summary).not.toContain("internal reasoning");
    expect(result.result.summary).toContain("visible text");
  });

  // -------------------------------------------------------------------------
  // Test 13: wrapAsSubagentResult unwraps <final> tags in summary
  // -------------------------------------------------------------------------
  it("Level 1: unwraps <final> tags keeping inner text in passthrough", async () => {
    const deps = createTestDeps({ maxResultTokens: 1000 });
    const condenser = createResultCondenser(deps);

    const result = await condenser.condense(createTestParams({
      fullResult: "<final>answer</final>",
    }));

    expect(result.level).toBe(1);
    expect(result.result.summary).not.toContain("<final>");
    expect(result.result.summary).not.toContain("</final>");
    expect(result.result.summary).toContain("answer");
  });
});
