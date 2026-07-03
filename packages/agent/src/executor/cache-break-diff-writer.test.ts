// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, statSync, rmSync, readdirSync as realReaddirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheBreakEvent } from "./cache-detection/index.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// Mock the @comis/observability fs-safe substrate so the structural
// tests (ensureContainedDir-call recorded, file-write recorded, rotation
// pruning, fault-tolerance contract on EPERM, etc.) keep a
// call-recording shape over the substrate seam. The mocked
// `ensureContainedDir` and `writeRegularFile` return Result.ok by
// default; the fault-tolerance test flips them to Result.err to drive
// the existing logger.warn assertion.
//
// `node:fs.readdirSync` + `unlinkSync` (used by `pruneOldestFiles`) are
// still mocked at the `node:fs` boundary because they are not part of
// the substrate.
const mockEnsureContainedDir = vi.fn();
const mockWriteRegularFile = vi.fn();
vi.mock("@comis/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/observability")>();
  return {
    ...actual,
    ensureContainedDir: (...args: Parameters<typeof actual.ensureContainedDir>) =>
      mockEnsureContainedDir(...args),
    writeRegularFile: (...args: Parameters<typeof actual.writeRegularFile>) =>
      mockWriteRegularFile(...args),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    unlinkSync: vi.fn(),
  };
});

import { readdirSync, unlinkSync } from "node:fs";
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

/**
 * Resolve a substrate-mock call argument list to the `content` field
 * passed to `writeRegularFile({path, content, confinedBaseDir})`. The
 * substrate accepts content as `string | Buffer`; the writer always
 * passes strings (`JSON.stringify(...) + "\n"` or
 * `diffSections.join("\n\n") + "\n"`), so the as-string narrowing is
 * safe across every call site under test.
 */
function contentOf(call: unknown[]): string {
  return (call[0] as { content: string }).content;
}

/**
 * Resolve the `path` field passed to a substrate write call.
 */
function pathOf(call: unknown[]): string {
  return (call[0] as { path: string }).path;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cache-break-diff-writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default substrate responses: success on both helpers so the
    // structural tests (write recorded, content shape correct, etc.)
    // proceed normally.
    mockEnsureContainedDir.mockReturnValue({ ok: true, value: { created: true } });
    mockWriteRegularFile.mockReturnValue({ ok: true, value: { totalBytes: 0 } });
    mockReaddirSync.mockReturnValue([]);
    mockUnlinkSync.mockImplementation(() => {});
  });

  it("writes structured JSON diff file on cache break event", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
      logger,
    });

    handler(makeCacheBreakEvent());

    // Directory ensured via the fs-safe substrate at mode 0o700
    expect(mockEnsureContainedDir).toHaveBeenCalledWith({
      dir: "/tmp/test-cache-breaks",
      mode: 0o700,
      confinedBaseDir: "/tmp",
    });

    // File written exactly once
    expect(mockWriteRegularFile).toHaveBeenCalledTimes(1);

    // Filename matches expected pattern
    const filePath = pathOf(mockWriteRegularFile.mock.calls[0]!);
    expect(filePath).toMatch(/\/tmp\/test-cache-breaks\/.*_agent-1_tools_changed\.json$/);

    // Content is valid JSON
    const content = contentOf(mockWriteRegularFile.mock.calls[0]!);
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("diff file contains token impact, attribution, and tool diffs", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
      logger,
    });

    handler(makeCacheBreakEvent());

    const content = contentOf(mockWriteRegularFile.mock.calls[0]!);
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
      dataDir: "/tmp",
      logger,
    });

    handler(makeCacheBreakEvent());

    // Oldest file should be pruned to make room
    expect(mockUnlinkSync).toHaveBeenCalled();
    const deletedPath = mockUnlinkSync.mock.calls[0]![0] as string;
    expect(deletedPath).toContain("2026-01-01T00-00-00-000Z_agent_reason.json");

    // New file still written
    expect(mockWriteRegularFile).toHaveBeenCalledTimes(1);
  });

  it("write failures do not affect detection flow", () => {
    // Substrate returns Result.err for the JSON write — the writer must
    // log via the fs-safe-specific branch and NOT re-throw.
    mockWriteRegularFile.mockReturnValue({
      ok: false,
      error: new Error("ENOSPC"),
    });

    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
      logger,
    });

    // Should NOT throw
    expect(() => handler(makeCacheBreakEvent())).not.toThrow();

    // Logger.warn called with hint and errorKind (the substrate-Result
    // branch fires before the top-level catch).
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    const warnArgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(warnArgs[0]).toHaveProperty("hint");
    expect(warnArgs[0]).toHaveProperty("errorKind", "resource");
  });

  it("directory is created only once (lazy init)", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
      logger,
    });

    handler(makeCacheBreakEvent());
    handler(makeCacheBreakEvent());

    // ensureContainedDir called exactly once despite two handler invocations
    expect(mockEnsureContainedDir).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Unified diff file generation tests
  // ---------------------------------------------------------------------------

  it("writes a .diff file alongside .json when event has system content", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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
    expect(mockWriteRegularFile).toHaveBeenCalledTimes(2);

    const calls = mockWriteRegularFile.mock.calls;
    const jsonCall = calls.find((c) => pathOf(c).endsWith(".json"));
    const diffCall = calls.find((c) => pathOf(c).endsWith(".diff"));

    expect(jsonCall).toBeDefined();
    expect(diffCall).toBeDefined();
  });

  it(".diff file contains unified diff format with --- and +++ headers", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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

    const calls = mockWriteRegularFile.mock.calls;
    const diffCall = calls.find((c) => pathOf(c).endsWith(".diff"));
    const content = contentOf(diffCall!);

    expect(content).toContain("---");
    expect(content).toContain("+++");
  });

  it("system diff shows delta when systemChanged is true", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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

    const calls = mockWriteRegularFile.mock.calls;
    const diffCall = calls.find((c) => pathOf(c).endsWith(".diff"));
    const content = contentOf(diffCall!);

    // Should contain removed and added lines
    expect(content).toContain("-Line 2");
    expect(content).toContain("+Line CHANGED");
  });

  it("tools diff shows delta when toolsChanged is true", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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

    const calls = mockWriteRegularFile.mock.calls;
    const diffCall = calls.find((c) => pathOf(c).endsWith(".diff"));
    const content = contentOf(diffCall!);

    expect(content).toContain("new_tool");
    expect(content).toContain("tools");
  });

  it("no .diff file written when neither systemChanged nor toolsChanged", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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
    expect(mockWriteRegularFile).toHaveBeenCalledTimes(1);
    const filePath = pathOf(mockWriteRegularFile.mock.calls[0]!);
    expect(filePath).toMatch(/\.json$/);
  });

  it("snapshot content is capped at 50,000 chars per category before diffing", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({
      outputDir: "/tmp/test-cache-breaks",
      dataDir: "/tmp",
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
    const calls = mockWriteRegularFile.mock.calls;
    expect(calls.length).toBe(1); // only .json
    const filePath = pathOf(calls[0]!);
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
      dataDir: "/tmp",
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
        dataDir: "/tmp",
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

      const calls = mockWriteRegularFile.mock.calls;
      const diffCall = calls.find((c) => pathOf(c).endsWith(".diff"));
      expect(diffCall).toBeDefined();
      const content = contentOf(diffCall!);

      // Combined patch should appear FIRST (before per-category patches)
      // The first --- line in the diff output should reference "combined"
      const firstDashLine = content.split("\n").find((l) => l.startsWith("--- "));
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
        dataDir: "/tmp",
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
      expect(mockWriteRegularFile).toHaveBeenCalled();
      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
    });

    it("generates diff for retention_changed break with content", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
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
      expect(mockWriteRegularFile).toHaveBeenCalledTimes(2);
      const diffCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".diff"));
      expect(diffCall).toBeDefined();
    });

    it("breakpointBudget included in diff file when present", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
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

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));

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
        dataDir: "/tmp",
        logger,
      });

      // Default event has no breakpointBudget
      handler(makeCacheBreakEvent());

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));

      expect(content.breakpointBudget).toBeUndefined();
    });

    it("no diff file when no serialized content available", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
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
      expect(mockWriteRegularFile).toHaveBeenCalledTimes(1);
      const filePath = pathOf(mockWriteRegularFile.mock.calls[0]!);
      expect(filePath).toMatch(/\.json$/);
    });

    it("JSON output includes effortValue and cacheControlChanged attribution", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
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

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));

      // Effort attribution fields present in JSON output
      expect(content.effortValue).toBe('{"type":"enabled","budget_tokens":4096}');
      expect(content.attribution.effortChanged).toBe(true);
      expect(content.attribution.cacheControlChanged).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // breakpointPressureRatio: fraction of the SDK's 4-breakpoint
  // ceiling consumed at break time. Clamped to [0, 1].
  // ---------------------------------------------------------------------------
  describe("breakpointPressureRatio in serialized diff records", () => {
    it("emits breakpointPressureRatio equal to breakpointBudget.total divided by 4", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
        logger,
      });

      handler(makeCacheBreakEvent({
        breakpointBudget: { total: 2, system: 1, tool: 0, message: 1, sdkAuto: 0 },
      }));

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));
      expect(content.breakpointPressureRatio).toBe(0.5);
    });

    it("clamps breakpointPressureRatio to 1 when total exceeds the 4-breakpoint ceiling", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
        logger,
      });

      handler(makeCacheBreakEvent({
        breakpointBudget: { total: 6, system: 1, tool: 2, message: 3, sdkAuto: 0 },
      }));

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));
      expect(content.breakpointPressureRatio).toBe(1);
    });

    it("clamps breakpointPressureRatio to 0 when total is negative for defense-in-depth", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
        logger,
      });

      handler(makeCacheBreakEvent({
        breakpointBudget: { total: -1, system: 0, tool: 0, message: 0, sdkAuto: 0 },
      }));

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));
      expect(content.breakpointPressureRatio).toBe(0);
    });

    it("omits breakpointPressureRatio when breakpointBudget is absent so the field stays meaningful", () => {
      const logger = createMockLogger();
      const handler = createCacheBreakDiffWriter({
        outputDir: "/tmp/test-cache-breaks",
        dataDir: "/tmp",
        logger,
      });

      handler(makeCacheBreakEvent()); // default fixture has no breakpointBudget

      const jsonCall = mockWriteRegularFile.mock.calls.find((c) => pathOf(c).endsWith(".json"));
      expect(jsonCall).toBeDefined();
      const content = JSON.parse(contentOf(jsonCall!));
      expect(content).not.toHaveProperty("breakpointPressureRatio");
    });
  });
});

// ---------------------------------------------------------------------------
// Mode-invariant tests (tmpdir-scoped, real fs).
//
// Every writer routed through the fs-safe substrate ships a co-located
// test that drives the real substrate end-to-end and asserts the
// owner-only dir-mode `0o700` +
// file-mode `0o600` invariants on every newly-written artifact. These
// tests route through the SAME mocks as the structural tests above,
// but the mocks delegate to the REAL substrate implementations
// (preserving the call-recording surface while exercising real fs).
// Tests run against a tmpdir scoped per-test.
// ---------------------------------------------------------------------------

describe("cache-break-diff-writer honors owner-only file mode invariants", () => {
  let baseDir: string;
  let outputDir: string;

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), "comis-cbdw-mode-"));
    outputDir = join(baseDir, "cache-breaks");
    // Wire the substrate mocks to delegate to the REAL implementations
    // (imported once via the original `@comis/observability` module).
    // This lets these tests bypass the success-stub defaults from the
    // outer describe's beforeEach and exercise the real fs-safe
    // primitives end-to-end against the tmpdir scoped above.
    const real = await vi.importActual<typeof import("@comis/observability")>(
      "@comis/observability",
    );
    mockEnsureContainedDir.mockImplementation(real.ensureContainedDir);
    mockWriteRegularFile.mockImplementation(real.writeRegularFile);
    // Allow real readdirSync for pruneOldestFiles (it operates on
    // outputDir which is real-fs in this test).
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    mockReaddirSync.mockImplementation(realFs.readdirSync as typeof realReaddirSync);
    mockUnlinkSync.mockImplementation(realFs.unlinkSync);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("creates_cache_breaks_dir_with_mode_0o700", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({ outputDir, dataDir: baseDir, logger });
    handler(makeCacheBreakEvent());
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
  });

  it("writes_json_diff_with_mode_0o600", () => {
    const logger = createMockLogger();
    const handler = createCacheBreakDiffWriter({ outputDir, dataDir: baseDir, logger });
    handler(makeCacheBreakEvent());
    const jsonFiles = realReaddirSync(outputDir).filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThanOrEqual(1);
    const firstFile = join(outputDir, jsonFiles[0]!);
    expect(statSync(firstFile).mode & 0o777).toBe(0o600);
  });
});
