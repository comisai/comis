// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CacheBreakEvent } from "./cache-break-detection.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Mock node:fs -- writeFileSync, mkdirSync, readdirSync, unlinkSync
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  };
});

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

import { createCacheBreakDiffWriter, buildDiffableContent } from "./cache-break-diff-writer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCacheBreakEvent(overrides: Partial<CacheBreakEvent> = {}): CacheBreakEvent {
  return {
    provider: "anthropic",
    reason: "tools_changed",
    tokenDrop: 5000,
    tokenDropRelative: 0.45,
    previousCacheRead: 11000,
    currentCacheRead: 6000,
    callCount: 3,
    changes: {
      systemChanged: false,
      toolsChanged: true,
      metadataChanged: false,
      modelChanged: false,
      retentionChanged: false,
      addedTools: [],
      removedTools: [],
      changedSchemaTools: ["web_search"],
      headersChanged: false,
      extraBodyChanged: false,
      effortChanged: false,
      cacheControlChanged: false,
    },
    toolsChanged: ["web_search"],
    ttlCategory: "long",
    agentId: "agent-1",
    sessionKey: "telegram:123:456",
    timestamp: Date.now(),
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cache-break-diff-writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset any custom implementations (e.g., from ENOSPC test)
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as unknown as string);
    mockReaddirSync.mockReturnValue([]);
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("writes structured JSON diff file on cache break event", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent());

    // Directory created with recursive flag
    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/test-cache-breaks", { recursive: true });

    // File written exactly once
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    // Filename matches expected pattern
    const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
    expect(filePath).toMatch(/\/tmp\/test-cache-breaks\/.*_agent-1_tools_changed\.json$/);

    // Content is valid JSON
    const content = mockWriteFileSync.mock.calls[0]![1] as string;
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("diff file contains token impact, attribution, and tool diffs", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent());

    const content = mockWriteFileSync.mock.calls[0]![1] as string;
    const diff = JSON.parse(content);

    // Core identifiers
    expect(typeof diff.timestamp).toBe("string"); // ISO format
    expect(diff.agentId).toBe("agent-1");
    expect(diff.sessionKey).toBe("telegram:123:456");
    expect(diff.provider).toBe("anthropic");
    expect(diff.reason).toBe("tools_changed");

    // Token impact
    expect(diff.tokenImpact.drop).toBe(5000);
    expect(diff.tokenImpact.dropRelative).toBe(0.45);
    expect(diff.tokenImpact.previousCacheRead).toBe(11000);
    expect(diff.tokenImpact.currentCacheRead).toBe(6000);

    // Attribution
    expect(diff.attribution.systemChanged).toBe(false);
    expect(diff.attribution.toolsChanged).toBe(true);
    expect(diff.attribution.modelChanged).toBe(false);
    expect(diff.attribution.retentionChanged).toBe(false);
    expect(diff.attribution.metadataChanged).toBe(false);

    // Tool diffs
    expect(diff.toolDiffs.added).toEqual([]);
    expect(diff.toolDiffs.removed).toEqual([]);
    expect(diff.toolDiffs.schemaChanged).toEqual(["web_search"]);

    // Other fields
    expect(diff.callCount).toBe(3);
    expect(diff.ttlCategory).toBe("long");
  });

  it("rotation keeps at most 50 diff files", () => {
    // Return 50 existing files (sorted lexicographically)
    const existingFiles = Array.from({ length: 50 }, (_, i) => {
      const day = String(i + 1).padStart(2, "0");
      return `2026-01-${day}T00-00-00-000Z_agent_reason.json`;
    });
    mockReaddirSync.mockReturnValue(existingFiles as unknown as ReturnType<typeof readdirSync>);

    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent());

    // Oldest file should be pruned to make room
    expect(mockUnlinkSync).toHaveBeenCalled();
    const deletedPath = mockUnlinkSync.mock.calls[0]![0] as string;
    expect(deletedPath).toContain("2026-01-01T00-00-00-000Z_agent_reason.json");

    // New file still written
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("write failures do not affect detection flow", () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    // Should NOT throw
    expect(() => handler(makeCacheBreakEvent())).not.toThrow();

    // Logger.warn called with hint and errorKind
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(warnArgs[0]).toHaveProperty("hint");
    expect(warnArgs[0]).toHaveProperty("errorKind");
  });

  it("directory is created only once (lazy init)", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent());
    handler(makeCacheBreakEvent());

    // mkdirSync called exactly once despite two handler invocations
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // DIFF-CONTENT: Unified diff file generation tests
  // ---------------------------------------------------------------------------

  it("writes a .diff file alongside .json when event has system content (DIFF-CONTENT)", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousSystem: "You are a helpful assistant.",
      currentSystem: "You are a concise assistant.",
    } as Partial<CacheBreakEvent>));

    // Should write both .json and .diff files (2 calls)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);

    const calls = mockWriteFileSync.mock.calls;
    const jsonCall = calls.find(c => (c[0] as string).endsWith(".json"));
    const diffCall = calls.find(c => (c[0] as string).endsWith(".diff"));

    expect(jsonCall).toBeDefined();
    expect(diffCall).toBeDefined();
  });

  it(".diff file contains unified diff format with --- and +++ headers", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousSystem: "You are a helpful assistant.",
      currentSystem: "You are a concise assistant.",
    } as Partial<CacheBreakEvent>));

    const calls = mockWriteFileSync.mock.calls;
    const diffCall = calls.find(c => (c[0] as string).endsWith(".diff"));
    const content = diffCall![1] as string;

    expect(content).toContain("---");
    expect(content).toContain("+++");
  });

  it("system diff shows delta when systemChanged is true", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousSystem: "Line 1\nLine 2\nLine 3",
      currentSystem: "Line 1\nLine CHANGED\nLine 3",
    } as Partial<CacheBreakEvent>));

    const calls = mockWriteFileSync.mock.calls;
    const diffCall = calls.find(c => (c[0] as string).endsWith(".diff"));
    const content = diffCall![1] as string;

    // Should contain removed and added lines
    expect(content).toContain("-Line 2");
    expect(content).toContain("+Line CHANGED");
  });

  it("tools diff shows delta when toolsChanged is true", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: false,
        toolsChanged: true,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: ["new_tool"],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousTools: '[\n  {\n    "name": "bash"\n  }\n]',
      currentTools: '[\n  {\n    "name": "bash"\n  },\n  {\n    "name": "new_tool"\n  }\n]',
    } as Partial<CacheBreakEvent>));

    const calls = mockWriteFileSync.mock.calls;
    const diffCall = calls.find(c => (c[0] as string).endsWith(".diff"));
    const content = diffCall![1] as string;

    expect(content).toContain("new_tool");
    expect(content).toContain("tools");
  });

  it("no .diff file written when neither systemChanged nor toolsChanged", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: false,
        toolsChanged: false,
        metadataChanged: true,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
    }));

    // Only .json file written (1 call)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
    expect(filePath).toMatch(/\.json$/);
  });

  it("snapshot content is capped at 50,000 chars per category before diffing", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    // Content >50K chars; the text beyond 50K is unique to prove truncation happened.
    // Both prev and curr share the same first 50K chars but differ after that.
    // After truncation, they are identical -> no diff sections -> no .diff file.
    // This proves the truncation cap is working (60K content truncated to 50K).
    const shared = "X".repeat(50_000);
    const longPrev = shared + "PREV_ONLY";
    const longCurr = shared + "CURR_ONLY";
    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousSystem: longPrev,
      currentSystem: longCurr,
    } as Partial<CacheBreakEvent>));

    // After truncation to 50K, content is identical, so no .diff file should be written.
    // Only the .json file should be present, proving truncation is effective.
    const calls = mockWriteFileSync.mock.calls;
    expect(calls.length).toBe(1); // only .json
    const filePath = calls[0]![0] as string;
    expect(filePath).toMatch(/\.json$/);
  });

  it(".diff file rotation respects MAX_DIFF_FILES=50 cap", () => {
    // Return 50 existing files with both .json and .diff
    const existingFiles: string[] = [];
    for (let i = 1; i <= 50; i++) {
      const day = String(i).padStart(2, "0");
      existingFiles.push(`2026-01-${day}T00-00-00-000Z_agent_reason.json`);
      existingFiles.push(`2026-01-${day}T00-00-00-000Z_agent_reason.diff`);
    }
    mockReaddirSync.mockReturnValue(existingFiles as unknown as ReturnType<typeof readdirSync>);

    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      logger,
    });

    handler(makeCacheBreakEvent({
      changes: {
        systemChanged: true,
        toolsChanged: false,
        metadataChanged: false,
        modelChanged: false,
        retentionChanged: false,
        addedTools: [],
        removedTools: [],
        changedSchemaTools: [],
        headersChanged: false,
        extraBodyChanged: false,
        effortChanged: false,
        cacheControlChanged: false,
      },
      previousSystem: "old",
      currentSystem: "new",
    } as Partial<CacheBreakEvent>));

    // Pruning should have been called and oldest files deleted
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Combined diffable content snapshot
  // ---------------------------------------------------------------------------

  describe("combined diffable content snapshot", () => {
    it("buildDiffableContent with all fields returns model header + system + tools sections", () => {
      const result = buildDiffableContent("system text", "tools text", "claude-sonnet");
      expect(result).toBe(
        "Model: claude-sonnet\n\n=== System Prompt ===\n\nsystem text\n\n=== Tools ===\n\ntools text\n",
      );
    });

    it("buildDiffableContent with undefined system returns (empty) placeholder, no model header", () => {
      const result = buildDiffableContent(undefined, "tools text");
      expect(result).toBe(
        "=== System Prompt ===\n\n(empty)\n\n=== Tools ===\n\ntools text\n",
      );
    });

    it("buildDiffableContent with undefined tools returns (empty) for tools section", () => {
      const result = buildDiffableContent("system text", undefined, "claude-opus");
      expect(result).toContain("=== Tools ===\n\n(empty)\n");
    });

    it("diff file includes combined snapshot diff before per-category diffs", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        changes: {
          systemChanged: true,
          toolsChanged: true,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: ["web_search"],
          headersChanged: false,
          extraBodyChanged: false,
          effortChanged: false,
          cacheControlChanged: false,
        },
        previousSystem: "You are a helpful assistant.",
        currentSystem: "You are a concise assistant.",
        previousTools: '[\n  {\n    "name": "bash"\n  }\n]',
        currentTools: '[\n  {\n    "name": "bash",\n    "updated": true\n  }\n]',
      } as Partial<CacheBreakEvent>));

      const calls = mockWriteFileSync.mock.calls;
      const diffCall = calls.find(c => (c[0] as string).endsWith(".diff"));
      expect(diffCall).toBeDefined();
      const content = diffCall![1] as string;

      // Combined patch should appear FIRST (before per-category patches)
      // The first --- line in the diff output should reference "combined"
      const firstDashLine = content.split("\n").find(l => l.startsWith("--- "));
      expect(firstDashLine).toContain("combined");
    });
  });

  // ---------------------------------------------------------------------------
  // Unified diff generation for all break event types
  // ---------------------------------------------------------------------------

  describe("unified diff for all break events", () => {
    it("generates diff for effort_changed break with content", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        reason: "effort_changed",
        changes: {
          systemChanged: false,
          toolsChanged: false,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: [],
          headersChanged: false,
          extraBodyChanged: false,
          effortChanged: true,
          cacheControlChanged: false,
        },
        previousSystem: "You are a helpful assistant.",
        currentSystem: "You are a helpful assistant.",
        previousTools: '[\n  {\n    "name": "bash"\n  }\n]',
        currentTools: '[\n  {\n    "name": "bash"\n  }\n]',
        effortValue: '{"type":"enabled","budget_tokens":1024}',
      } as Partial<CacheBreakEvent>));

      // Should write .json file (content is identical so no diff delta -- but the writer still runs)
      expect(mockWriteFileSync).toHaveBeenCalled();
      const jsonCall = mockWriteFileSync.mock.calls.find(c => (c[0] as string).endsWith(".json"));
      expect(jsonCall).toBeDefined();
    });

    it("generates diff for retention_changed break with content", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        reason: "retention_changed",
        changes: {
          systemChanged: false,
          toolsChanged: false,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: true,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: [],
          headersChanged: false,
          extraBodyChanged: false,
          effortChanged: false,
          cacheControlChanged: false,
        },
        previousSystem: "You are a helpful assistant.",
        currentSystem: "You are a concise assistant.",
      } as Partial<CacheBreakEvent>));

      // Should write both .json and .diff (content changed between turns)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const diffCall = mockWriteFileSync.mock.calls.find(c => (c[0] as string).endsWith(".diff"));
      expect(diffCall).toBeDefined();
    });

    it("breakpointBudget included in diff file when present", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        breakpointBudget: {
          total: 4,
          system: 1,
          tool: 0,
          message: 2,
          sdkAuto: 1,
        },
      } as any));

      const jsonCall = mockWriteFileSync.mock.calls.find(c => (c[0] as string).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(jsonCall![1] as string);

      expect(content.breakpointBudget).toBeDefined();
      expect(content.breakpointBudget.total).toBe(4);
      expect(content.breakpointBudget.system).toBe(1);
      expect(content.breakpointBudget.tool).toBe(0);
      expect(content.breakpointBudget.message).toBe(2);
      expect(content.breakpointBudget.sdkAuto).toBe(1);
    });

    it("breakpointBudget omitted from diff file when absent", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      // Default event has no breakpointBudget
      handler(makeCacheBreakEvent());

      const jsonCall = mockWriteFileSync.mock.calls.find(c => (c[0] as string).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(jsonCall![1] as string);

      expect(content.breakpointBudget).toBeUndefined();
    });

    it("no diff file when no serialized content available", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        reason: "headers_changed",
        changes: {
          systemChanged: false,
          toolsChanged: false,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: [],
          headersChanged: true,
          extraBodyChanged: false,
          effortChanged: false,
          cacheControlChanged: false,
        },
        // All content fields undefined (no lazy getter output)
        previousSystem: undefined,
        currentSystem: undefined,
        previousTools: undefined,
        currentTools: undefined,
      } as Partial<CacheBreakEvent>));

      // Only .json file written (1 call)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const filePath = mockWriteFileSync.mock.calls[0]![0] as string;
      expect(filePath).toMatch(/\.json$/);
    });

    it("JSON output includes effortValue and cacheControlChanged attribution", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        logger,
      });

      handler(makeCacheBreakEvent({
        reason: "effort_changed",
        changes: {
          systemChanged: false,
          toolsChanged: false,
          metadataChanged: false,
          modelChanged: false,
          retentionChanged: false,
          addedTools: [],
          removedTools: [],
          changedSchemaTools: [],
          headersChanged: false,
          extraBodyChanged: false,
          effortChanged: true,
          cacheControlChanged: false,
        },
        effortValue: '{"type":"enabled","budget_tokens":4096}',
      }));

      const jsonCall = mockWriteFileSync.mock.calls.find(c => (c[0] as string).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(jsonCall![1] as string);

      // New fields present in JSON output
      expect(content.effortValue).toBe('{"type":"enabled","budget_tokens":4096}');
      expect(content.attribution.effortChanged).toBe(true);
      expect(content.attribution.cacheControlChanged).toBe(false);
    });
  });
});
