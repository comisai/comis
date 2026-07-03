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

// Mock @earendil-works/pi-coding-agent
vi.mock("@earendil-works/pi-coding-agent", () => ({
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
import { generateSummary } from "@earendil-works/pi-coding-agent";
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

  it("Level 3: dense-script (Hebrew) truncation respects maxResultTokens under the module's own factored measure", async () => {
    const maxResultTokens = 500;
    const deps = createTestDeps({ maxResultTokens });
    const condenser = createResultCondenser(deps);

    // Pure Hebrew letters + neutral spaces -> scriptTokenFactor 0.5. If
    // headTailTruncate's char budget stayed flat maxTokens*4 while its own
    // estimateTokens is script-factored, the truncated output would measure
    // ~2x maxResultTokens by the SAME measure that routed it to Level 3.
    // tokens->chars is the OUTPUT direction here: a flat budget over-emits,
    // the inverse of the conservative reservation sites.
    const he = "שלום עולם זה מבחן ארוך מאוד בעברית "; // 35 UTF-16 units
    const fullResult = he.repeat(120); // 4200 chars >> any budget

    const result = await condenser.condense(createTestParams({ fullResult })); // no model -> Level 3

    expect(result.level).toBe(3);
    // Only the omission-marker overhead (~30 ASCII chars) may ride above
    // the cap: 10% slack.
    expect(result.condensedTokens).toBeLessThanOrEqual(Math.ceil(maxResultTokens * 1.1));
  });

  it("Level 3: pure-ASCII truncation budget stays byte-identical to flat maxTokens*4", async () => {
    const maxResultTokens = 100;
    const deps = createTestDeps({ maxResultTokens });
    const condenser = createResultCondenser(deps);

    const fullResult = makeString(2000);
    const result = await condenser.condense(createTestParams({ fullResult }));

    expect(result.level).toBe(3);
    // Recompute the EXACT flat-budget head/tail join the (mocked, byte=char)
    // truncators produce: ASCII factor 1.0 must not change a single char.
    const budget = maxResultTokens * CHARS_PER_TOKEN; // 400 — flat == factored for ASCII
    const head = fullResult.slice(0, Math.floor(budget * 0.6));
    const tail = fullResult.slice(-Math.floor(budget * 0.4));
    const omitted = fullResult.length - head.length - tail.length;
    const combined = `${head}\n\n[... ${omitted} chars omitted ...]\n\n${tail}`;
    expect(result.condensedTokens).toBe(Math.ceil(combined.length / CHARS_PER_TOKEN));
  });

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

  // -------------------------------------------------------------------------
  // relay scrub tests
  // -------------------------------------------------------------------------

  describe("relay scrub", () => {
    it("scrubs token from fullResult before persistFullResult receives it", async () => {
      const deps = createTestDeps({ maxResultTokens: 1000 });
      const condenser = createResultCondenser(deps);

      const rawToken = "hf_" + "a".repeat(44);
      await condenser.condense(createTestParams({
        fullResult: `Result text containing Bearer ${rawToken} as part of the output`,
      }));

      expect(writeFile).toHaveBeenCalled();
      const writeCall = (writeFile as Mock).mock.calls[0];
      const diskJson = JSON.parse(writeCall![1] as string);
      // persistFullResult must NOT receive the raw token in fullResult
      expect(diskJson.fullResult).not.toContain(rawToken);
    });

    it("scrubs token from fullResult before relay (condensed output does not contain raw token)", async () => {
      const deps = createTestDeps({ maxResultTokens: 1000 });
      const condenser = createResultCondenser(deps);

      const rawToken = "hf_" + "b".repeat(44);
      const result = await condenser.condense(createTestParams({
        fullResult: `Agent completed task. Token: Bearer ${rawToken}`,
      }));

      // The condensed relay result (summary/conclusions) must not contain the raw token
      const resultText = JSON.stringify(result.result);
      expect(resultText).not.toContain(rawToken);
    });
  });

  // -------------------------------------------------------------------------
  // secure handoff advisory tests
  // -------------------------------------------------------------------------

  describe("secure handoff advisory", () => {
    it("appends secure-store advisory when fullResult contained a token (after redaction)", async () => {
      const deps = createTestDeps({ maxResultTokens: 1000 });
      const condenser = createResultCondenser(deps);

      // A Bearer token that scrubSecretsFromText will detect and redact
      const rawToken = "hf_" + "c".repeat(44);
      const result = await condenser.condense(createTestParams({
        fullResult: `The video was generated. Authorization: Bearer ${rawToken} was used.`,
      }));

      // The raw token must be absent from the condensed relay result
      const resultText = JSON.stringify(result.result);
      expect(resultText).not.toContain(rawToken);

      // A generic secure-store advisory must be present in the summary.
      // Server name is NOT available at condenseInternal — generic advisory only;
      // threading serverName requires invasive cross-package CondenseParams API change.
      expect(result.result.summary).toContain("stored in the secure credential store");
    });

    it("does NOT append advisory when fullResult contains no credential (clean result)", async () => {
      const deps = createTestDeps({ maxResultTokens: 1000 });
      const condenser = createResultCondenser(deps);

      const result = await condenser.condense(createTestParams({
        fullResult: "The task completed successfully. No credentials were used.",
      }));

      // No advisory should appear for clean results
      expect(result.result.summary).not.toContain("stored in the secure credential store");
    });
  });
});
