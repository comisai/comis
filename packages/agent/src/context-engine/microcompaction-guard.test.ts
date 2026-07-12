// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the microcompaction guard.
 *
 * Verifies that oversized tool results are offloaded to disk with inline
 * references, per-tool thresholds are applied correctly, and non-toolResult
 * messages pass through unmodified.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installMicrocompactionGuard, getInlineThreshold } from "./microcompaction-guard.js";
import {
  MAX_INLINE_TOOL_RESULT_CHARS,
  MAX_INLINE_MCP_TOOL_RESULT_CHARS,
  MAX_INLINE_FILE_READ_RESULT_CHARS,
  TOOL_RESULT_HARD_CAP_CHARS,
  PREVIEW_HEAD_CHARS,
  PREVIEW_TAIL_CHARS,
} from "./constants.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { wrapExternalContent } from "@comis/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal SessionManager mock with appendMessage and getSessionDir. */
function createMockSessionManager(sessionDir: string) {
  const appended: unknown[] = [];
  return {
    appended,
    getSessionDir: () => sessionDir,
    appendMessage: vi.fn((message: unknown): string => {
      appended.push(message);
      return "entry-id";
    }),
  };
}
/** Create a toolResult message with the given text content size. */
function createToolResult(
  toolName: string,
  textLength: number,
  toolCallId = "call-001",
): {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: "text"; text: string }[];
  isError: boolean;
  timestamp: number;
} {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "x".repeat(textLength) }],
    isError: false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("installMicrocompactionGuard", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-test-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes through small tool results unmodified (under 8K threshold)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const smallResult = createToolResult("bash", 4000);
    sm.appendMessage(smallResult);

    // The original appendMessage mock should receive the unmodified message
    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]).toBe(smallResult);

    // No disk file should be created
    const toolResultsDir = join(tempDir, "tool-results");
    expect(existsSync(toolResultsDir)).toBe(false);
  });

  it("offloads tool results exceeding the default 8K threshold to disk", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const largeResult = createToolResult("bash", 10_000, "call-large");
    sm.appendMessage(largeResult);

    // Should have appended an inline reference, not the original
    expect(sm.appended).toHaveLength(1);
    const appended = sm.appended[0] as any;
    expect(appended.role).toBe("toolResult");
    expect(appended.toolCallId).toBe("call-large");
    expect(appended.toolName).toBe("bash");
    expect(appended.isError).toBe(false);
    expect(appended.content).toHaveLength(1);
    expect(appended.content[0].type).toBe("text");
    expect(appended.content[0].text).toContain("offloaded to disk");
    expect(appended.content[0].text).toContain("10000 chars");

    // Disk file should exist
    const diskPath = join(tempDir, "tool-results", "call-large.json");
    expect(existsSync(diskPath)).toBe(true);

    // DEBUG log should have been emitted
    expect(logger.debug).toHaveBeenCalled();
  });

  it("offloads MCP tool results exceeding the 15K threshold", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 16K exceeds MCP threshold of 15K
    const mcpResult = createToolResult("mcp__github_list_issues", 16_000, "call-mcp");
    sm.appendMessage(mcpResult);

    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toContain("offloaded to disk");

    const diskPath = join(tempDir, "tool-results", "call-mcp.json");
    expect(existsSync(diskPath)).toBe(true);
  });

  it("does NOT offload read tool results under the 15K threshold", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 12K is under read tool threshold of 15K
    const readResult = createToolResult("read", 12_000, "call-read");
    sm.appendMessage(readResult);

    // Should pass through unmodified
    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]).toBe(readResult);

    // No disk file
    const toolResultsDir = join(tempDir, "tool-results");
    expect(existsSync(toolResultsDir)).toBe(false);
  });

  it("truncates tool results exceeding 100K hard cap before offloading", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const hugeResult = createToolResult("bash", 150_000, "call-huge");
    sm.appendMessage(hugeResult);

    // Should have inline reference
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toContain("offloaded to disk");
    expect(appended.content[0].text).toContain("150000 chars");

    // Disk file should exist with TRUNCATED raw text content (< original 150K)
    const diskPath = join(tempDir, "tool-results", "call-huge.json");
    expect(existsSync(diskPath)).toBe(true);
    const diskText = readFileSync(diskPath, "utf-8");
    expect(diskText.length).toBeLessThan(150_000);

    // WARN log should have been emitted (not just DEBUG)
    expect(logger.warn).toHaveBeenCalled();
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(warnCall[0]).toHaveProperty("errorKind", "resource");
    expect(warnCall[0]).toHaveProperty("hardCapChars", TOOL_RESULT_HARD_CAP_CHARS);
  });

  it("writes raw text content to disk (not JSON envelope)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-structure");
    sm.appendMessage(result);

    const diskPath = join(tempDir, "tool-results", "call-structure.json");
    const diskText = readFileSync(diskPath, "utf-8");

    // File contains raw text, not a JSON envelope
    // Attempting to parse as JSON with a toolCallId key should fail
    let parsedAsEnvelope = false;
    try {
      const parsed = JSON.parse(diskText);
      if (parsed && typeof parsed === "object" && "toolCallId" in parsed) {
        parsedAsEnvelope = true;
      }
    } catch {
      // Expected: raw text is not valid JSON
    }
    expect(parsedAsEnvelope).toBe(false);

    // File content should be exactly 10,000 'x' characters
    expect(diskText).toBe("x".repeat(10_000));
    expect(diskText.length).toBe(10_000);
  });

  it("passes non-toolResult messages through unmodified", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const userMessage = {
      role: "user" as const,
      content: "Hello world " + "x".repeat(50_000),
      timestamp: Date.now(),
    };
    sm.appendMessage(userMessage as any);

    expect(sm.appended).toHaveLength(1);
    expect(sm.appended[0]).toBe(userMessage);
  });

  it("fires onOffloaded callback when tool result is offloaded to disk", () => {
    const sm = createMockSessionManager(tempDir);
    const onOffloaded = vi.fn();
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger, onOffloaded);

    const largeResult = createToolResult("bash", 10_000, "call-offloaded");
    sm.appendMessage(largeResult);

    // The callback carries (toolName, originalChars, toolCallId, diskPathRel).
    // diskPathRel is WORKSPACE-RELATIVE (sessionDir-relative) — `tool-results/<id>.json`,
    // never the absolute host path (which would leak the host filesystem layout).
    // sessionDir == tempDir here,
    // so relative(tempDir, <tempDir>/tool-results/call-offloaded.json) == that suffix.
    expect(onOffloaded).toHaveBeenCalledTimes(1);
    expect(onOffloaded).toHaveBeenCalledWith("bash", 10_000, "call-offloaded", "tool-results/call-offloaded.json");
  });

  it("fires onOffloaded callback when tool result exceeds hard cap", () => {
    const sm = createMockSessionManager(tempDir);
    const onOffloaded = vi.fn();
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger, onOffloaded);

    const hugeResult = createToolResult("bash", 150_000, "call-hardcap");
    sm.appendMessage(hugeResult);

    // originalChars is the pre-offload char count (150_000), even on the hard-cap
    // branch where content is truncated before offload; the pointer is still relative.
    expect(onOffloaded).toHaveBeenCalledTimes(1);
    expect(onOffloaded).toHaveBeenCalledWith("bash", 150_000, "call-hardcap", "tool-results/call-hardcap.json");
  });

  it("mutates original message content in-place for pipeline visibility (threshold path)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const largeResult = createToolResult("bash", 10_000, "call-pipeline");
    const originalContent = largeResult.content; // hold reference to original array
    sm.appendMessage(largeResult);

    // The original content array should now contain the compact reference
    expect(originalContent).toHaveLength(1);
    expect(originalContent[0].text).toContain("offloaded to disk");
    expect(originalContent[0].text.length).toBeLessThan(5000);
  });

  it("mutates original message content in-place for pipeline visibility (hard cap path)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const hugeResult = createToolResult("bash", 150_000, "call-pipeline-hardcap");
    const originalContent = hugeResult.content; // hold reference to original array
    sm.appendMessage(hugeResult);

    // The original content array should now contain the compact reference
    expect(originalContent).toHaveLength(1);
    expect(originalContent[0].text).toContain("offloaded to disk");
    expect(originalContent[0].text.length).toBeLessThan(5000);
  });

  it("does NOT fire onOffloaded when the disk write fails (no phantom pointer in the trajectory)", () => {
    // saveToDisk is best-effort — writeRegularFile returns err (and
    // writes nothing) when the target escapes the confinement base. Forcing a
    // confinement rejection (dataDir that does NOT contain sessionDir) means the
    // file is never created; firing onOffloaded anyway would record a workspace-
    // relative pointer at a non-existent file, and the trajectory's
    // IncidentReport.offloads[] drill-down would then fail to open it. The
    // offload event must only be emitted on a SUCCESSFUL write.
    const sm = createMockSessionManager(tempDir);
    const onOffloaded = vi.fn();
    // confinedBaseDir = a sibling dir that does NOT contain the session dir →
    // writeRegularFile's assertConfinedPath rejects, returning err.
    const unrelatedBase = mkdtempSync(join(tmpdir(), "microcompaction-otherbase-"));
    try {
      installMicrocompactionGuard(sm as any, tempDir, unrelatedBase, logger, onOffloaded);

      const largeResult = createToolResult("bash", 10_000, "call-writefail");
      sm.appendMessage(largeResult);

      // The disk write was rejected — the offload file must not exist...
      expect(existsSync(join(tempDir, "tool-results", "call-writefail.json"))).toBe(false);
      // ...and the trajectory offload event must NOT have been emitted.
      expect(onOffloaded).not.toHaveBeenCalled();
    } finally {
      rmSync(unrelatedBase, { recursive: true, force: true });
    }
  });

  it("does NOT fire onOffloaded when the disk write fails on the hard-cap path", () => {
    // Same invariant on the hard-cap (>100K) branch, which has its
    // own saveToDisk + onOffloaded call site.
    const sm = createMockSessionManager(tempDir);
    const onOffloaded = vi.fn();
    const unrelatedBase = mkdtempSync(join(tmpdir(), "microcompaction-otherbase-"));
    try {
      installMicrocompactionGuard(sm as any, tempDir, unrelatedBase, logger, onOffloaded);

      const hugeResult = createToolResult("bash", 150_000, "call-hardcap-writefail");
      sm.appendMessage(hugeResult);

      expect(existsSync(join(tempDir, "tool-results", "call-hardcap-writefail.json"))).toBe(false);
      expect(onOffloaded).not.toHaveBeenCalled();
    } finally {
      rmSync(unrelatedBase, { recursive: true, force: true });
    }
  });

  it("does not fire onOffloaded for under-threshold tool results", () => {
    const sm = createMockSessionManager(tempDir);
    const onOffloaded = vi.fn();
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger, onOffloaded);

    const smallResult = createToolResult("bash", 4000);
    sm.appendMessage(smallResult);

    expect(onOffloaded).not.toHaveBeenCalled();
  });

  it("includes disk path in the inline reference for file_read recovery", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-pathcheck");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // Should contain the disk path and correct tool name for recovery
    const expectedDiskPath = join(tempDir, "tool-results", "call-pathcheck.json");
    expect(referenceText).toContain(expectedDiskPath);
    expect(referenceText).toContain("use the read tool to re-access");
    expect(referenceText).not.toContain("file_read");
    expect(referenceText).toContain("bash");
  });

  it("shows exec-based recovery hint for large offloaded results (>= 15K chars)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 20K chars for an MCP tool (threshold 15K, so it gets offloaded)
    const result = createToolResult("mcp__yfinance_get_data", 20_000, "call-exec-hint");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // Should contain exec-based hint, NOT the read tool suggestion
    expect(referenceText).toContain("exec");
    expect(referenceText).toContain("python");
    expect(referenceText).not.toContain("use the read tool to re-access");
    expect(referenceText).toContain("re-offload");
    // Disk path should be present
    const expectedDiskPath = join(tempDir, "tool-results", "call-exec-hint.json");
    expect(referenceText).toContain(expectedDiskPath);
    // Offloaded prefix preserved for isAlreadyOffloaded compatibility
    expect(referenceText.startsWith("[Tool result offloaded to disk:")).toBe(true);
  });

  it("shows read-tool recovery hint for smaller offloaded results (< 15K chars)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 10K chars for bash tool (threshold 8K, so it gets offloaded, but 10K < 15K)
    const result = createToolResult("bash", 10_000, "call-read-hint");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // Should contain read-tool hint, NOT exec hint
    expect(referenceText).toContain("use the read tool to re-access");
    expect(referenceText).not.toContain("exec");
    expect(referenceText).not.toContain("python");
  });

  it("exec hint includes actual disk path in the python example", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("mcp__github_list_issues", 20_000, "call-path-in-exec");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // The python example should contain the actual disk path
    const expectedDiskPath = join(tempDir, "tool-results", "call-path-in-exec.json");
    expect(referenceText).toContain(`open('${expectedDiskPath}')`);
  });
});

// ---------------------------------------------------------------------------
// Content preview tests
// ---------------------------------------------------------------------------

describe("content preview in offloaded tool results", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-preview-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes head preview section with first PREVIEW_HEAD_CHARS of content", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Content must exceed 8K threshold to trigger offload
    const content = "A".repeat(PREVIEW_HEAD_CHARS) + "B".repeat(8000);
    const result = createToolResult("bash", content.length, "call-head");
    result.content = [{ type: "text", text: content }];
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText).toContain(`--- head (${PREVIEW_HEAD_CHARS} chars) ---`);
    expect(referenceText).toContain("A".repeat(PREVIEW_HEAD_CHARS));
  });

  it("includes tail preview section with last PREVIEW_TAIL_CHARS of content", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Content must exceed 8K threshold to trigger offload
    const content = "A".repeat(PREVIEW_HEAD_CHARS) + "B".repeat(7000) + "C".repeat(PREVIEW_TAIL_CHARS);
    const result = createToolResult("bash", content.length, "call-tail");
    result.content = [{ type: "text", text: content }];
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText).toContain(`--- tail (${PREVIEW_TAIL_CHARS} chars) ---`);
    expect(referenceText).toContain("C".repeat(PREVIEW_TAIL_CHARS));
  });

  it("includes hasMore=true indicator in offloaded reference", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-hasmore");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText).toContain("hasMore=true");
  });

  it("omits tail section when content fits within head+tail chars (no overlap)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // The tail section is omitted only when content length <= PREVIEW_HEAD_CHARS +
    // PREVIEW_TAIL_CHARS (2000 chars), but every offload threshold (8K/15K) is well
    // above 2000 — so any offloaded reference always carries a tail, and the empty-tail
    // branch of extractPreview is only reachable for content that never offloads.
    // Verify the boundary from that side: 1800-char content stays under the 8K bash
    // threshold and must pass through unmodified (no offload, no preview at all).
    const content = "x".repeat(1800);
    const result = createToolResult("bash", content.length, "call-short");
    result.content = [{ type: "text", text: content }];
    sm.appendMessage(result);

    // 1800 is under 8K threshold, so it should pass through unmodified (not offloaded)
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toBe(content);
  });

  it("concatenates multi-block content before head/tail extraction", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Create multi-block content totaling 10000 chars (exceeds 8K threshold)
    const result: ReturnType<typeof createToolResult> = {
      role: "toolResult",
      toolCallId: "call-multi",
      toolName: "bash",
      content: [
        { type: "text", text: "A".repeat(1000) },
        { type: "text", text: "B".repeat(1000) },
        { type: "text", text: "C".repeat(8000) },
      ],
      isError: false,
      timestamp: Date.now(),
    };
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // Head should contain A's followed by B's (first 1500 chars of concatenated content)
    expect(referenceText).toContain("A".repeat(1000) + "B".repeat(500));
    expect(referenceText).toContain("hasMore=true");
  });

  it("places recovery instruction before head preview for LLM visibility", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-order");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    const readToolIdx = referenceText.indexOf("use the read tool to re-access");
    const headIdx = referenceText.indexOf("--- head (");
    expect(readToolIdx).toBeGreaterThan(-1);
    expect(headIdx).toBeGreaterThan(-1);
    expect(readToolIdx).toBeLessThan(headIdx);
  });

  it("the inline reference carries no 'The agent's analysis' narration line", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-old-fmt");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText).not.toContain("The agent's analysis is in the assistant response below");
  });

  it("preserves [Tool result offloaded to disk: prefix for isAlreadyOffloaded compatibility", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const result = createToolResult("bash", 10_000, "call-prefix");
    sm.appendMessage(result);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText.startsWith("[Tool result offloaded to disk:")).toBe(true);
  });

  it("hard-cap path also uses the head/tail preview format with hasMore=true", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const hugeResult = createToolResult("bash", 150_000, "call-hardcap-preview");
    sm.appendMessage(hugeResult);

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    expect(referenceText).toContain("hasMore=true");
    expect(referenceText).toContain("--- head (");
    expect(referenceText.startsWith("[Tool result offloaded to disk:")).toBe(true);
    expect(referenceText).not.toContain("The agent's analysis is in the assistant response below");
  });
});

// ---------------------------------------------------------------------------
// Recovery read exemption tests
// ---------------------------------------------------------------------------

describe("recovery read exemption", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-recovery-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Create a read toolResult with details.filePath set. */
  function createReadToolResult(
    textLength: number,
    filePath: string,
    toolCallId = "call-recovery",
  ) {
    return {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read",
      content: [{ type: "text" as const, text: "x".repeat(textLength) }],
      details: {
        totalLines: 100,
        startLine: 1,
        endLine: 100,
        sizeBytes: textLength,
        encoding: "utf-8",
        paginated: false,
        filePath,
      },
      isError: false,
      timestamp: Date.now(),
    };
  }

  it("skips offloading for recovery reads from tool-results/ directory", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 20K chars -- above the 15K read threshold, should normally be offloaded
    const recoveryPath = join(tempDir, "tool-results", "call-original.json");
    const result = createReadToolResult(20_000, recoveryPath);
    sm.appendMessage(result);

    // Should pass through unmodified (no offload)
    expect(sm.appended).toHaveLength(1);
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toBe("x".repeat(20_000));

    // No disk file created (no re-offload)
    const toolResultsDir = join(tempDir, "tool-results");
    expect(existsSync(join(toolResultsDir, "call-recovery.json"))).toBe(false);

    // DEBUG log for recovery skip
    expect(logger.debug).toHaveBeenCalled();
  });

  it("still offloads recovery reads exceeding the hard cap (100K)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const recoveryPath = join(tempDir, "tool-results", "call-big.json");
    const result = createReadToolResult(150_000, recoveryPath);
    sm.appendMessage(result);

    // Should be offloaded despite being a recovery read (hard cap override)
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toContain("offloaded to disk");

    // WARN log from hard cap path
    expect(logger.warn).toHaveBeenCalled();
  });

  it("still offloads normal read results from non-tool-results paths", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // 20K chars from a normal path -- should still be offloaded
    const normalPath = "/home/user/project/src/big-file.ts";
    const result = createReadToolResult(20_000, normalPath, "call-normal");
    sm.appendMessage(result);

    // Should be offloaded
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toContain("offloaded to disk");
  });

  it("still offloads read results without details (no crash on undefined)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Use the standard createToolResult helper which has no details
    const result = createToolResult("read", 20_000, "call-no-details");
    sm.appendMessage(result);

    // Should be offloaded normally
    const appended = sm.appended[0] as any;
    expect(appended.content[0].text).toContain("offloaded to disk");
  });

  // -------------------------------------------------------------------------
  // Empty-content normalization (regression: silent LLM failure cascade)
  // -------------------------------------------------------------------------
  //
  // A non-error toolResult with empty content poisons the next LLM turn and
  // triggers Comis's silent-failure retry, ultimately surfacing a generic
  // "An error occurred while processing your request" Telegram reply.
  // The producer (auto-background-middleware) is the original culprit, but
  // this guard is the single choke point for toolResult persistence and
  // must synthesize a placeholder so the tool_use/tool_result pairing
  // stays valid regardless of future wrapper regressions.

  it("normalizes toolResult with empty content array and isError:false", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const emptyResult = {
      role: "toolResult" as const,
      toolCallId: "call-empty",
      toolName: "skills_manage",
      content: [] as { type: "text"; text: string }[],
      isError: false,
      timestamp: Date.now(),
    };
    sm.appendMessage(emptyResult);

    // Guard must mutate in place so the in-memory message stays consistent.
    expect(emptyResult.content).toHaveLength(1);
    expect(emptyResult.content[0]!.type).toBe("text");
    expect(emptyResult.content[0]!.text).toContain("skills_manage");
    expect(emptyResult.content[0]!.text).toContain("returned no output");

    // Persisted message has the synthesized placeholder too.
    const appended = sm.appended[0] as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    expect(appended.content).toHaveLength(1);
    expect(appended.content[0]!.text).toContain("returned no output");
    expect(appended.isError).toBe(false);

    // Warn log fired with errorKind:"validation".
    const warnCalls = logger.warn.mock.calls as Array<[Record<string, unknown>, string]>;
    const normalizationWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("normalized empty toolResult"),
    );
    expect(normalizationWarn).toBeDefined();
    expect(normalizationWarn![0].errorKind).toBe("validation");
    expect(normalizationWarn![0].toolName).toBe("skills_manage");
    expect(normalizationWarn![0].toolCallId).toBe("call-empty");
  });

  it("normalizes toolResult with missing content field (undefined)", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Shape produced by the original auto-background bug: SDK built a
    // toolResult message with content:undefined because the wrapper
    // returned a JSON string instead of AgentToolResult.
    const malformed = {
      role: "toolResult" as const,
      toolCallId: "call-nocontent",
      toolName: "skills_manage",
      isError: false,
      timestamp: Date.now(),
    } as unknown as Parameters<typeof sm.appendMessage>[0];

    sm.appendMessage(malformed);

    const appended = sm.appended[0] as {
      content: { type: string; text: string }[];
    };
    expect(Array.isArray(appended.content)).toBe(true);
    expect(appended.content).toHaveLength(1);
    expect(appended.content[0]!.text).toContain("returned no output");
  });

  it("does NOT normalize toolResult with empty content when isError:true", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Error paths may legitimately arrive with an empty content array if the
    // SDK short-circuited before producing an error message. Preserve the
    // existing behavior — only normalize non-error silent-failure shapes.
    const errResult = {
      role: "toolResult" as const,
      toolCallId: "call-err",
      toolName: "bash",
      content: [] as { type: "text"; text: string }[],
      isError: true,
      timestamp: Date.now(),
    };
    sm.appendMessage(errResult);

    expect(errResult.content).toHaveLength(0);
    const warnCalls = logger.warn.mock.calls as Array<[Record<string, unknown>, string]>;
    const normalizationWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("normalized empty toolResult"),
    );
    expect(normalizationWarn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getInlineThreshold unit tests
// ---------------------------------------------------------------------------

describe("getInlineThreshold", () => {
  it("returns 15K for read tool (file read)", () => {
    expect(getInlineThreshold("read")).toBe(MAX_INLINE_FILE_READ_RESULT_CHARS);
  });

  it("returns 15K for MCP tools", () => {
    expect(getInlineThreshold("mcp__github_list_issues")).toBe(MAX_INLINE_MCP_TOOL_RESULT_CHARS);
    expect(getInlineThreshold("mcp__slack_send")).toBe(MAX_INLINE_MCP_TOOL_RESULT_CHARS);
  });

  it("returns 8K for standard tools", () => {
    expect(getInlineThreshold("bash")).toBe(MAX_INLINE_TOOL_RESULT_CHARS);
    expect(getInlineThreshold("memory_search")).toBe(MAX_INLINE_TOOL_RESULT_CHARS);
  });

});

describe("microcompaction-guard file/dir mode invariants", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-mode-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the tool-results parent directory with mode 0o700 on offload", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const largeResult = createToolResult("bash", 10_000, "mode-dir");
    sm.appendMessage(largeResult);

    const dirPath = join(tempDir, "tool-results");
    expect(existsSync(dirPath)).toBe(true);
    expect(statSync(dirPath).mode & 0o777).toBe(0o700);
  });

  it("writes offloaded tool-result files with mode 0o600", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const largeResult = createToolResult("bash", 10_000, "mode-file");
    sm.appendMessage(largeResult);

    const diskPath = join(tempDir, "tool-results", "mode-file.json");
    expect(existsSync(diskPath)).toBe(true);
    expect(statSync(diskPath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// Clean-payload offload: external-wrapped results are UNWRAPPED at rest.
//
// Live incident 2026-07-12 (comis-harel, "when was I last in the Golan"): the
// offload marker's own `json.load` example failed on every offloaded MCP
// result because the wrapExternalContent security envelope was baked into the
// .json file. The file is a STORAGE artifact — the taint boundary belongs to
// the presentation layer: payload bytes on disk, origin recorded in a sidecar,
// re-wrap at the boundaries (marker preview + read-tool recovery).
// ---------------------------------------------------------------------------

/** A JSON payload whose serialized form is at least `minChars` long. */
function bigJsonPayload(minChars: number): { rows: Array<{ id: number; address: string; lat: number; lon: number }> } {
  const rows: Array<{ id: number; address: string; lat: number; lon: number }> = [];
  let size = 20;
  let i = 0;
  while (size < minChars) {
    const row = { id: i, address: `Ahuza Street ${i}, Raanana`, lat: 32.184 + i * 0.0001, lon: 34.871 };
    rows.push(row);
    size += JSON.stringify(row).length + 1;
    i++;
  }
  return { rows };
}

/** A wrapped-MCP toolResult message (single wrapper over the joined text, as mcp-tool-bridge produces). */
function createWrappedMcpResult(
  payloadText: string,
  toolCallId: string,
): {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: "text"; text: string }[];
  isError: boolean;
  timestamp: number;
  details?: Record<string, unknown>;
} {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "mcp__testsrv--big_query",
    content: [{ type: "text", text: wrapExternalContent(payloadText, { source: "mcp_tool" }) }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("clean-payload offload (external wrapper stripped at rest)", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-clean-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes the UNWRAPPED payload to disk — the .json file parses as the original JSON", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const payload = bigJsonPayload(20_000);
    sm.appendMessage(createWrappedMcpResult(JSON.stringify(payload), "call-clean"));

    const diskPath = join(tempDir, "tool-results", "call-clean.json");
    expect(existsSync(diskPath)).toBe(true);
    const fileText = readFileSync(diskPath, "utf8");
    expect(fileText.startsWith("SECURITY NOTICE")).toBe(false);
    expect(fileText).not.toContain("<<<UNTRUSTED_");
    expect(JSON.parse(fileText)).toEqual(payload);
  });

  it("writes an origin sidecar recording the external source", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    sm.appendMessage(createWrappedMcpResult(JSON.stringify(bigJsonPayload(20_000)), "call-sidecar"));

    const sidecarPath = join(tempDir, "tool-results", "call-sidecar.origin.json");
    expect(existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    expect(sidecar.source).toBe("mcp_tool");
  });

  it("does NOT write a sidecar for internal (never-wrapped) offloads", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    sm.appendMessage(createToolResult("bash", 10_000, "call-internal"));

    expect(existsSync(join(tempDir, "tool-results", "call-internal.json"))).toBe(true);
    expect(existsSync(join(tempDir, "tool-results", "call-internal.origin.json"))).toBe(false);
  });

  it("cuts the marker preview from the CLEAN payload and re-wraps the preview section as untrusted", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const payload = bigJsonPayload(20_000);
    sm.appendMessage(createWrappedMcpResult(JSON.stringify(payload), "call-preview"));

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;

    // Head preview starts with the clean payload, not the security envelope.
    expect(referenceText).toMatch(/--- head \(\d+ chars\) ---\n\{"rows"/);
    // The preview section itself is taint-wrapped so external content never
    // sits in context without its boundary.
    expect(referenceText).toContain("SECURITY NOTICE");
    expect(referenceText).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    expect(referenceText).toMatch(/<<<END_UNTRUSTED_[a-f0-9]+>>>/);
    // isAlreadyOffloaded contract unchanged.
    expect(referenceText.startsWith("[Tool result offloaded to disk:")).toBe(true);
  });

  it("does NOT taint-wrap the preview of internal offloads", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    sm.appendMessage(createToolResult("bash", 10_000, "call-internal-preview"));

    const appended = sm.appended[0] as any;
    const referenceText: string = appended.content[0].text;
    expect(referenceText).not.toContain("SECURITY NOTICE");
    expect(referenceText).not.toContain("<<<UNTRUSTED_");
  });

  it("emits the json.load example only when the disk payload actually parses as JSON", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // JSON payload → json.load example with the real path.
    sm.appendMessage(createWrappedMcpResult(JSON.stringify(bigJsonPayload(20_000)), "call-json-ex"));
    const jsonRef: string = (sm.appended[0] as any).content[0].text;
    const jsonDiskPath = join(tempDir, "tool-results", "call-json-ex.json");
    expect(jsonRef).toContain(`json.load(open('${jsonDiskPath}'))`);

    // Plain-text payload (wrapped web-fetch-style markdown) → NO json.load claim.
    const proseLine = "Golan Heights travel guide — plain prose, definitely not JSON. ";
    sm.appendMessage(createWrappedMcpResult(proseLine.repeat(300), "call-text-ex"));
    const textRef: string = (sm.appended[1] as any).content[0].text;
    expect(textRef).not.toContain("json.load");
    expect(textRef).toContain("plain text");
  });

  it("no longer claims the read tool will re-offload files under the hard cap", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    sm.appendMessage(createWrappedMcpResult(JSON.stringify(bigJsonPayload(20_000)), "call-read-claim"));
    const referenceText: string = (sm.appended[0] as any).content[0].text;

    // Offloaded files are capped at TOOL_RESULT_HARD_CAP_CHARS on disk, and
    // recovery reads under the cap are exempt from re-offload — the old
    // "will re-offload" warning was stale.
    expect(referenceText).not.toContain("re-offload");
    expect(referenceText).toContain("read tool also works");
  });

  it("hard-cap case: truncates the CLEAN payload on disk and says so instead of promising json.load", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    // Clean payload > 100K → wrapped input exceeds the hard cap.
    const payload = bigJsonPayload(120_000);
    sm.appendMessage(createWrappedMcpResult(JSON.stringify(payload), "call-hardcap"));

    const diskPath = join(tempDir, "tool-results", "call-hardcap.json");
    const fileText = readFileSync(diskPath, "utf8");
    // Clean payload prefix, no envelope, capped length.
    expect(fileText.startsWith('{"rows"')).toBe(true);
    expect(fileText).not.toContain("SECURITY NOTICE");
    expect(fileText.length).toBeLessThanOrEqual(TOOL_RESULT_HARD_CAP_CHARS);

    const referenceText: string = (sm.appended[0] as any).content[0].text;
    expect(referenceText.toLowerCase()).toContain("truncated");
    // A truncated JSON slice does not parse — never promise json.load on it.
    expect(referenceText).not.toContain("json.load");

    const sidecar = JSON.parse(readFileSync(join(tempDir, "tool-results", "call-hardcap.origin.json"), "utf8"));
    expect(sidecar.source).toBe("mcp_tool");
    expect(sidecar.truncated).toBe(true);
  });
});

describe("wrap-on-read: recovery reads restore the taint boundary", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "microcompaction-wrapread-"));
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A read-tool toolResult for a recovery read of `filePath`. */
  function createRecoveryRead(filePath: string, toolCallId: string) {
    return {
      role: "toolResult" as const,
      toolCallId,
      toolName: "read",
      content: [{ type: "text" as const, text: readFileSync(filePath, "utf8") }],
      isError: false,
      timestamp: Date.now(),
      details: { filePath },
    };
  }

  it("re-wraps recovery reads of external-origin offload files", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    const payload = bigJsonPayload(20_000);
    sm.appendMessage(createWrappedMcpResult(JSON.stringify(payload), "call-wrapread"));
    const diskPath = join(tempDir, "tool-results", "call-wrapread.json");

    sm.appendMessage(createRecoveryRead(diskPath, "call-wrapread-read"));

    const readAppended = sm.appended[1] as any;
    const text: string = readAppended.content[0].text;
    // The taint boundary is restored at the presentation layer...
    expect(text).toContain("SECURITY NOTICE");
    expect(text).toMatch(/<<<UNTRUSTED_[a-f0-9]+>>>/);
    // ...around the clean payload the file holds.
    expect(text).toContain('{"rows"');
    // Still exempt from re-offload (no second disk file for the read).
    expect(existsSync(join(tempDir, "tool-results", "call-wrapread-read.json"))).toBe(false);
  });

  it("passes through recovery reads of internal-origin offload files unwrapped", () => {
    const sm = createMockSessionManager(tempDir);
    installMicrocompactionGuard(sm as any, tempDir, tempDir, logger);

    sm.appendMessage(createToolResult("bash", 10_000, "call-internal-read"));
    const diskPath = join(tempDir, "tool-results", "call-internal-read.json");
    const originalFileText = readFileSync(diskPath, "utf8");

    sm.appendMessage(createRecoveryRead(diskPath, "call-internal-read-read"));

    const readAppended = sm.appended[1] as any;
    expect(readAppended.content[0].text).toBe(originalFileText);
    expect(readAppended.content[0].text).not.toContain("SECURITY NOTICE");
  });
});
