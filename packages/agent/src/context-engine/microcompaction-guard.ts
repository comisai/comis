/**
 * Microcompaction guard: offloads oversized tool results to disk at write
 * time, replacing them with lightweight inline references.
 *
 * Tool results stored raw in the JSONL session file are replayed into every
 * subsequent LLM call. A 50K-char bash output persisted to disk becomes a
 * permanent context burden. The microcompaction guard saves oversized results
 * to disk as JSON files and writes a compact reference into the session,
 * reducing per-turn context cost while preserving recoverability via the read tool.
 *
 * Per-tool inline thresholds:
 * - Default tools: 8K chars (MAX_INLINE_TOOL_RESULT_CHARS)
 * - MCP tools (mcp__*): 15K chars (MAX_INLINE_MCP_TOOL_RESULT_CHARS)
 * - read (file read): 15K chars (MAX_INLINE_FILE_READ_RESULT_CHARS)
 *
 * Hard cap: 100K chars (TOOL_RESULT_HARD_CAP_CHARS) -- truncated before offload.
 *
 * - Tool results exceeding inline threshold saved to disk
 * - Per-tool thresholds applied (8K/5K/15K)
 * - Hard cap (100K) truncation applied before disk offload
 * - Inline reference contains disk path for read tool recovery
 *
 * @module
 */

import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { Message, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { safePath } from "@comis/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimateMessageChars } from "../safety/token-estimator.js";
import { createToolResultSizeGuard, type ContentBlock } from "../safety/tool-result-size-guard.js";
import {
  MAX_INLINE_TOOL_RESULT_CHARS,
  MAX_INLINE_MCP_TOOL_RESULT_CHARS,
  MAX_INLINE_FILE_READ_RESULT_CHARS,
  TOOL_RESULT_HARD_CAP_CHARS,
  PREVIEW_HEAD_CHARS,
  PREVIEW_TAIL_CHARS,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Threshold resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the per-tool inline character threshold.
 *
 * - `read` (file read) -> 15K (code context is high-value)
 * - `mcp__*` -> 15K (MCP tools return structured data needed for analysis)
 * - Default -> 8K
 */
export function getInlineThreshold(toolName: string): number {
  if (toolName === "read") return MAX_INLINE_FILE_READ_RESULT_CHARS;
  if (toolName.startsWith("mcp__")) return MAX_INLINE_MCP_TOOL_RESULT_CHARS;
  return MAX_INLINE_TOOL_RESULT_CHARS;
}

// ---------------------------------------------------------------------------
// Disk offload helper
// ---------------------------------------------------------------------------

/**
 * Save tool result content to disk as raw concatenated text.
 *
 * Agents read offloaded files expecting raw content matching the head/tail
 * previews shown in the inline reference. Writing a JSON envelope caused
 * parse failures when agents assumed raw text on disk.
 *
 * Uses synchronous file I/O because `appendMessage()` is synchronous.
 * Path construction uses `safePath()` to prevent traversal attacks.
 * File extension remains `.json` for stable offloaded-file references.
 *
 * @returns The absolute disk path where the file was written
 */
function saveToDisk(
  sessionDir: string,
  toolCallId: string,
  _toolName: string,
  _originalChars: number,
  content: ToolResultMessage["content"],
): string {
  const diskPath = safePath(sessionDir, "tool-results", `${toolCallId}.json`);
  mkdirSync(dirname(diskPath), { recursive: true });

  // Concatenate all text blocks into a single raw string (same logic as extractPreview)
  let rawText = "";
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      rawText += block.text;
    }
  }

  writeFileSync(diskPath, rawText);
  return diskPath;
}

// ---------------------------------------------------------------------------
// Content preview extraction
// ---------------------------------------------------------------------------

/**
 * Extract head + tail text preview from tool result content blocks.
 * Concatenates all text blocks, then slices head and tail.
 * Tail is empty if content fits entirely within head chars.
 */
function extractPreview(
  content: ToolResultMessage["content"],
  headChars: number,
  tailChars: number,
): { head: string; tail: string } {
  let fullText = "";
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      fullText += block.text;
    }
  }
  const head = fullText.slice(0, headChars);
  const tail = fullText.length > headChars + tailChars
    ? fullText.slice(-tailChars)
    : "";
  return { head, tail };
}

// ---------------------------------------------------------------------------
// Inline reference builder
// ---------------------------------------------------------------------------

/**
 * Create a lightweight inline reference message replacing the original
 * tool result content with a head+tail preview.
 *
 * Preserves `toolCallId`, `toolName`, `isError`, and `timestamp` so SDK
 * tool_use/tool_result pairing remains valid. The `[Tool result offloaded
 * to disk:` prefix is preserved for `isAlreadyOffloaded()` compatibility.
 */
function createInlineReference(
  original: ToolResultMessage,
  totalChars: number,
  diskPath: string,
): ToolResultMessage {
  const { head, tail } = extractPreview(original.content, PREVIEW_HEAD_CHARS, PREVIEW_TAIL_CHARS);

  // Recovery instruction is placed BEFORE head/tail preview so the LLM sees
  // how to recover the data before seeing the (potentially misleading) preview.
  let referenceText =
    `[Tool result offloaded to disk: ${original.toolName} returned ${totalChars} chars. hasMore=true\n`;

  // For large results (>= 15K chars), suggest exec with python/jq
  // instead of the read tool, because read itself produces a toolResult that will
  // re-trigger offload (creating an unresolvable re-offload loop). The exec tool
  // returns only stdout (typically small extracted data), breaking the loop.
  if (totalChars >= MAX_INLINE_FILE_READ_RESULT_CHARS) {
    referenceText +=
      `Full content saved at: ${diskPath}\n` +
      `To recover specific data: use exec with python/jq to parse the file (the read tool will re-offload results this large).\n` +
      `Example: exec python3 -c "import json; data=json.load(open('${diskPath}')); print(data['key'])"\n`;
  } else {
    referenceText += `Full content saved — use the read tool to re-access: ${diskPath}\n`;
  }

  referenceText += `--- head (${head.length} chars) ---\n${head}\n`;

  if (tail) {
    referenceText += `--- tail (${tail.length} chars) ---\n${tail}\n`;
  }

  referenceText += `]`;

  return {
    role: "toolResult" as const,
    toolCallId: original.toolCallId,
    toolName: original.toolName,
    isError: original.isError,
    timestamp: original.timestamp,
    content: [{ type: "text" as const, text: referenceText }],
  };
}

// ---------------------------------------------------------------------------
// Guard installer
// ---------------------------------------------------------------------------

/**
 * Install a microcompaction guard on a SessionManager instance that offloads
 * oversized tool result messages to disk at write time.
 *
 * Wraps `sm.appendMessage` on the instance (not the prototype), using the
 * same instance-patching pattern as `session.agent.streamFn`.
 *
 * Only `toolResult` messages are guarded. All other message types (user,
 * assistant, custom, bashExecution) pass through unmodified.
 *
 * @param sm - The SessionManager instance to guard
 * @param sessionDir - The session directory for disk offload storage
 * @param logger - Logger for WARN/DEBUG-level offload events
 */
export function installMicrocompactionGuard(
  sm: SessionManager,
  sessionDir: string,
  logger: ComisLogger,
  onOffloaded?: (toolName: string) => void,
): void {
  const originalAppend = sm.appendMessage.bind(sm);
  const guard = createToolResultSizeGuard();

  sm.appendMessage = (message: Parameters<SessionManager["appendMessage"]>[0]): string => {
    // Only guard toolResult messages
    if (!("role" in message) || (message as Message).role !== "toolResult") {
      return originalAppend(message);
    }

    const toolResultMsg = message as ToolResultMessage;
    const totalChars = estimateMessageChars(toolResultMsg);
    const threshold = getInlineThreshold(toolResultMsg.toolName);

    // Diagnostic: log toolResult content shape at persistence entry point.
    // Helps trace content loss between MCP bridge execute() and JSONL write.
    const firstBlock = toolResultMsg.content?.[0];
    logger.debug(
      {
        toolName: toolResultMsg.toolName,
        toolCallId: toolResultMsg.toolCallId,
        totalChars,
        contentBlockCount: toolResultMsg.content?.length ?? 0,
        hasContent: !!toolResultMsg.content,
        hasDetails: !!(toolResultMsg as unknown as Record<string, unknown>).details,
        firstBlockType: firstBlock
          && typeof firstBlock === "object"
          && "type" in firstBlock
          ? (firstBlock as { type: string }).type
          : undefined,
        firstBlockTextLen: firstBlock
          && typeof firstBlock === "object"
          && "type" in firstBlock
          && (firstBlock as { type: string }).type === "text"
          && "text" in firstBlock
          ? (firstBlock as { text: string }).text.length
          : undefined,
        isError: toolResultMsg.isError,
      },
      "Microcompaction guard: toolResult content shape at persistence entry",
    );

    // Skip offloading for recovery reads of previously-offloaded
    // tool results. When the model reads a file from the tool-results/ directory,
    // it is explicitly recovering offloaded data -- re-offloading creates an
    // unresolvable loop. The 100K hard cap still applies for safety.
    const details = toolResultMsg.details as Record<string, unknown> | undefined;
    const readFilePath = typeof details?.filePath === "string" ? details.filePath : "";
    const isRecoveryRead = toolResultMsg.toolName === "read"
        && readFilePath.includes("/tool-results/");

    if (isRecoveryRead && totalChars <= TOOL_RESULT_HARD_CAP_CHARS) {
      logger.debug(
        { toolName: toolResultMsg.toolName, totalChars, filePath: readFilePath },
        "Recovery read of offloaded file -- skipping re-offload",
      );
      return originalAppend(message);
    }

    // Case 1: Hard cap exceeded -- truncate THEN offload
    if (totalChars > TOOL_RESULT_HARD_CAP_CHARS) {
      const result = guard.truncateIfNeeded(
        toolResultMsg.content as ContentBlock[],
        TOOL_RESULT_HARD_CAP_CHARS,
      );

      const truncatedContent = result.truncated
        ? (result.content as typeof toolResultMsg.content)
        : toolResultMsg.content;

      const diskPath = saveToDisk(
        sessionDir,
        toolResultMsg.toolCallId,
        toolResultMsg.toolName,
        totalChars,
        truncatedContent,
      );

      logger.warn(
        {
          toolName: toolResultMsg.toolName,
          originalChars: totalChars,
          hardCapChars: TOOL_RESULT_HARD_CAP_CHARS,
          diskPath,
          hint: `Tool result from '${toolResultMsg.toolName}' exceeded hard cap (${TOOL_RESULT_HARD_CAP_CHARS} chars) -- truncated and offloaded to disk`,
          errorKind: "resource" as ErrorKind,
        },
        "Tool result exceeded hard cap -- truncated and offloaded",
      );

      const truncatedMsg = { ...toolResultMsg, content: truncatedContent };
      const reference = createInlineReference(truncatedMsg, totalChars, diskPath);
      onOffloaded?.(toolResultMsg.toolName);

      // PIPELINE-FIX: Propagate compact reference to in-memory message object.
      // Without this, currentContext.messages in the agent loop still holds the
      // raw oversized content, causing the bouncer to re-truncate on the next
      // LLM call. By mutating the original content array, both
      // currentContext.messages and agent.state.messages see the compact reference.
      toolResultMsg.content.length = 0;
      toolResultMsg.content.push(...reference.content);

      return originalAppend(reference);
    }

    // Case 2: Exceeds per-tool threshold -- offload full content
    if (totalChars > threshold) {
      const diskPath = saveToDisk(
        sessionDir,
        toolResultMsg.toolCallId,
        toolResultMsg.toolName,
        totalChars,
        toolResultMsg.content,
      );

      const reference = createInlineReference(toolResultMsg, totalChars, diskPath);

      // Compute reference size and compression ratio for observability
      const refContent = reference.content[0];
      const referenceChars = refContent && "text" in refContent ? refContent.text.length : 0;

      logger.debug(
        {
          toolName: toolResultMsg.toolName,
          originalChars: totalChars,
          threshold,
          diskPath,
          referenceChars,
          compressionRatio: Number((1 - referenceChars / totalChars).toFixed(2)),
        },
        "Tool result offloaded to disk",
      );

      onOffloaded?.(toolResultMsg.toolName);

      // PIPELINE-FIX: Propagate compact reference to in-memory message object.
      // Without this, currentContext.messages in the agent loop still holds the
      // raw oversized content, causing the bouncer to re-truncate on the next
      // LLM call. By mutating the original content array, both
      // currentContext.messages and agent.state.messages see the compact reference.
      toolResultMsg.content.length = 0;
      toolResultMsg.content.push(...reference.content);

      return originalAppend(reference);
    }

    // Case 3: Under threshold -- pass through unmodified
    return originalAppend(message);
  };
}
