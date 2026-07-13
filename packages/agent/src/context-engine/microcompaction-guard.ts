// SPDX-License-Identifier: Apache-2.0
/**
 * Microcompaction guard: offloads oversized tool results to disk at write
 * time, replacing them with lightweight inline references.
 *
 * Tool results stored raw in the JSONL session file are replayed into every
 * subsequent LLM call. A 50K-char bash output persisted to disk becomes a
 * permanent context burden. The microcompaction guard saves oversized results
 * to disk and writes a compact reference into the session, reducing per-turn
 * context cost while preserving recoverability via the read tool.
 *
 * Offload files hold CLEAN payload bytes: external-wrapped results (MCP,
 * web fetch — anything `wrapExternalContent`-wrapped upstream) are unwrapped
 * before the disk write, with the origin recorded in a `.origin.json`
 * sidecar. The taint boundary is presentation-layer and is re-applied at the
 * two places external bytes re-enter context: the inline reference's preview
 * and the read-tool recovery path (wrap-on-read, keyed by the sidecar).
 *
 * Per-tool inline thresholds:
 * - Default tools: 8K chars (MAX_INLINE_TOOL_RESULT_CHARS)
 * - MCP tools (mcp__*): 15K chars (MAX_INLINE_MCP_TOOL_RESULT_CHARS)
 * - read (file read): 15K chars (MAX_INLINE_FILE_READ_RESULT_CHARS)
 *
 * Hard cap: 100K chars (TOOL_RESULT_HARD_CAP_CHARS) -- the clean payload is
 * truncated to the cap before the disk write.
 *
 * - Tool results exceeding inline threshold saved to disk (clean payload)
 * - Per-tool thresholds applied (8K/15K/15K)
 * - Hard cap (100K) truncation applied before disk offload
 * - Inline reference carries the disk path + a recovery example verified
 *   against the written bytes (json.load only when the file parses)
 *
 * @module
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ComisLogger, ErrorKind, ExternalContentSource } from "@comis/core";
import { safePath, wrapExternalContent, unwrapExternalContent } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import { estimateMessageChars } from "../safety/token-estimator.js";
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
 * The clean (unwrapped) text of a tool result plus its external origin.
 *
 * External-wrapped blocks (MCP results, web fetches — anything that went
 * through `wrapExternalContent` upstream) are unwrapped PER BLOCK back to
 * their payload; never-wrapped blocks pass through unchanged. `external` is
 * the first unwrapped block's source, `null` when nothing was wrapped.
 */
interface CleanToolResultText {
  cleanText: string;
  external: { source: ExternalContentSource } | null;
}

/** Unwrap each text block of a tool result to its clean payload. */
function unwrapToolResultText(content: ToolResultMessage["content"]): CleanToolResultText {
  let cleanText = "";
  let external: { source: ExternalContentSource } | null = null;
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      const unwrapped = unwrapExternalContent(block.text);
      if (unwrapped) {
        cleanText += unwrapped.content;
        external ??= { source: unwrapped.source };
      } else {
        cleanText += block.text;
      }
    }
  }
  return { cleanText, external };
}

/**
 * Save a tool result's CLEAN payload to disk.
 *
 * The offload file is a storage artifact: it holds payload bytes only — the
 * `wrapExternalContent` security envelope is presentation-layer and is
 * re-applied at the boundaries instead (the inline reference's preview and
 * the read-tool recovery path). Before this, the envelope was baked into the
 * `.json` file at rest and the marker's own `json.load` recovery example
 * failed on every offloaded MCP result (live incident 2026-07-12).
 *
 * External-origin offloads additionally get a `<toolCallId>.origin.json`
 * sidecar recording the source, so the recovery-read path can restore the
 * taint boundary. The main pointer format (`tool-results/<toolCallId>.json`)
 * is unchanged.
 *
 * Uses synchronous file I/O because `appendMessage()` is synchronous.
 * Path construction uses `safePath()` to prevent traversal attacks.
 * File extension remains `.json` for stable offloaded-file references.
 *
 * @returns `{ diskPath, written }` — `diskPath` is the absolute target path;
 *   `written` is `false` when the parent-dir or file write was rejected
 *   (e.g. confinement-base escape), so the caller can suppress the
 *   `tool:result_offloaded` trajectory emit instead of recording a phantom
 *   pointer at a file that does not exist.
 */
function saveToDisk(
  sessionDir: string,
  dataDir: string,
  toolCallId: string,
  diskText: string,
  origin: { source: ExternalContentSource; truncated: boolean; originalChars: number } | null,
  logger: ComisLogger,
): { diskPath: string; written: boolean } {
  const diskPath = safePath(sessionDir, "tool-results", `${toolCallId}.json`);
  // Parent dir at 0o700 via the fs-safe substrate (file-mode invariant).
  // confinedBaseDir threads dataDir (typically ~/.comis/) so the ancestor-
  // symlink escape is rejected. When the dir creation is rejected the file
  // write below also fails; either way `written` ends up false and the caller
  // suppresses the offload event.
  const dirResult = ensureContainedDir({ dir: dirname(diskPath), mode: 0o700, confinedBaseDir: dataDir });

  const writeResult = writeRegularFile({ path: diskPath, content: diskText, confinedBaseDir: dataDir });

  if (origin) {
    const sidecarPath = diskPath.slice(0, -".json".length) + ".origin.json";
    const sidecarBody = JSON.stringify({
      source: origin.source,
      ...(origin.truncated ? { truncated: true, originalChars: origin.originalChars } : {}),
    });
    const sidecarResult = writeRegularFile({ path: sidecarPath, content: `${sidecarBody}\n`, confinedBaseDir: dataDir });
    if (!sidecarResult.ok) {
      // Best-effort: without the sidecar a later recovery read is delivered
      // without its taint boundary — visible, not fatal (the inline preview
      // stays wrapped either way).
      logger.warn(
        {
          toolCallId,
          sidecarPath,
          hint: "Origin sidecar write failed; a read-tool recovery of this offload will not restore the external-content taint boundary. Check data-dir confinement and filesystem permissions.",
          errorKind: "resource" as ErrorKind,
        },
        "Offload origin sidecar write failed",
      );
    }
  }

  return { diskPath, written: dirResult.ok && writeResult.ok };
}

/**
 * External source recorded for an offloaded file, from its origin sidecar.
 * `null` for internal-origin offloads (no sidecar) and on any read/parse
 * failure — fail-open to the internal (unwrapped) treatment, which matches
 * the pre-sidecar behavior for those files.
 */
function readOffloadOrigin(filePath: string): ExternalContentSource | null {
  if (!filePath.endsWith(".json")) return null;
  const sidecarPath = filePath.slice(0, -".json".length) + ".origin.json";
  try {
    const st = statSync(sidecarPath);
    if (!st.isFile() || st.size > 4096) return null;
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as { source?: unknown };
    return typeof parsed.source === "string" && parsed.source.length > 0 && parsed.source.length < 64
      ? (parsed.source as ExternalContentSource)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content preview extraction
// ---------------------------------------------------------------------------

/**
 * Head + tail preview slices of the CLEAN payload text.
 * Tail is empty if content fits entirely within head chars.
 */
function slicePreview(cleanText: string, headChars: number, tailChars: number): { head: string; tail: string } {
  const head = cleanText.slice(0, headChars);
  const tail = cleanText.length > headChars + tailChars ? cleanText.slice(-tailChars) : "";
  return { head, tail };
}

// ---------------------------------------------------------------------------
// Inline reference builder
// ---------------------------------------------------------------------------

/**
 * Recovery guidance that is TRUE for the bytes just written: the `json.load`
 * example is emitted only when the disk payload actually parses as JSON
 * (verified right here, at write time), a truncated disk copy says so instead
 * of promising a parse that must fail, and plain text gets text tooling. The
 * old unconditional `json.load` example failed on every non-JSON offload —
 * and, before clean-at-rest offloads, on every security-wrapped MCP result.
 */
function recoveryGuidance(diskText: string, diskPath: string, diskTruncated: boolean): string {
  // The read tool is exempt from re-offload for tool-results recovery reads
  // (and disk copies are capped at the hard cap), so reading the whole file
  // back always works — exec just keeps only the extracted data in context.
  let guidance =
    `To recover specific data: use exec with python/jq to parse the file (the read tool also works for this file; exec keeps only the extracted data in context).\n`;
  if (diskTruncated) {
    guidance +=
      `NOTE: the disk copy was truncated at ${TOOL_RESULT_HARD_CAP_CHARS} chars — structured parsing may fail; inspect with text tools (grep/head).\n`;
    return guidance;
  }
  let parsesAsJson = false;
  try {
    JSON.parse(diskText);
    parsesAsJson = true;
  } catch {
    // not JSON — fall through to the text guidance
  }
  if (parsesAsJson) {
    guidance += `The file is valid JSON. Example: exec python3 -c "import json; data=json.load(open('${diskPath}')); print(type(data).__name__, list(data)[:20] if isinstance(data, dict) else len(data))"\n`;
  } else {
    guidance += `The file is plain text (not JSON) — use text tools, e.g.: exec grep -n '<term>' '${diskPath}' | head\n`;
  }
  return guidance;
}

/**
 * Create a lightweight inline reference message replacing the original
 * tool result content with a head+tail preview of the CLEAN payload.
 *
 * For external-origin content the preview section is re-wrapped with
 * `wrapExternalContent` so external bytes never sit in context without their
 * taint boundary (the disk file holds clean payload; the boundary is a
 * presentation concern and this is the presentation).
 *
 * Preserves `toolCallId`, `toolName`, `isError`, and `timestamp` so SDK
 * tool_use/tool_result pairing remains valid. The `[Tool result offloaded
 * to disk:` prefix is preserved for `isAlreadyOffloaded()` compatibility.
 */
function createInlineReference(
  original: ToolResultMessage,
  totalChars: number,
  diskPath: string,
  diskText: string,
  external: { source: ExternalContentSource } | null,
  diskTruncated: boolean,
): ToolResultMessage {
  const { head, tail } = slicePreview(diskText, PREVIEW_HEAD_CHARS, PREVIEW_TAIL_CHARS);

  // Recovery instruction is placed BEFORE head/tail preview so the LLM sees
  // how to recover the data before seeing the (potentially misleading) preview.
  let referenceText =
    `[Tool result offloaded to disk: ${original.toolName} returned ${totalChars} chars. hasMore=true\n`;

  // For large results (>= 15K chars), lead with exec/python extraction — it
  // keeps only the extracted data in context, where a read tool recovery
  // re-enters the whole file.
  if (totalChars >= MAX_INLINE_FILE_READ_RESULT_CHARS) {
    referenceText += `Full content saved at: ${diskPath}\n` + recoveryGuidance(diskText, diskPath, diskTruncated);
  } else {
    referenceText += `Full content saved — use the read tool to re-access: ${diskPath}\n`;
  }

  let previewSection = `--- head (${head.length} chars) ---\n${head}\n`;
  if (tail) {
    previewSection += `--- tail (${tail.length} chars) ---\n${tail}\n`;
  }
  // External payload previews carry the taint boundary; internal previews
  // stay bare (wrapping internal output would mislabel trusted data).
  referenceText += external ? `${wrapExternalContent(previewSection, { source: external.source })}\n` : previewSection;

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
 * @param dataDir - Confinement base for fs-safe substrate writes
 *   (typically `~/.comis/`). Threaded as `confinedBaseDir` on every
 *   `ensureContainedDir` + `writeRegularFile` call so the ancestor-
 *   symlink escape is rejected — closes the confused-deputy gap
 *   that O_NOFOLLOW + parent-`lstat` together do NOT cover.
 * @param logger - Logger for WARN/DEBUG-level offload events
 */
export function installMicrocompactionGuard(
  sm: SessionManager,
  sessionDir: string,
  dataDir: string,
  logger: ComisLogger,
  onOffloaded?: (toolName: string, originalChars: number, toolCallId: string, diskPathRel: string) => void,
): void {
  const originalAppend = sm.appendMessage.bind(sm);

  sm.appendMessage = (message: Parameters<SessionManager["appendMessage"]>[0]): string => {
    // Only guard toolResult messages
    if (!("role" in message) || (message as Message).role !== "toolResult") {
      return originalAppend(message);
    }

    const toolResultMsg = message as ToolResultMessage;

    // Invariant: a non-error toolResult MUST carry non-empty content. The
    // provider API requires every tool_use to pair with a non-empty
    // tool_result; an empty content array poisons the next LLM call with a
    // signalless turn that produces finishReason:"stop" with no text,
    // cascading into Comis's silent-failure retry and ultimately a generic
    // "An error occurred…" reply to the user.
    //
    // Root cause for the original occurrence was auto-background-middleware
    // returning a JSON string instead of AgentToolResult. That is fixed at
    // the producer, but this normalization is defense-in-depth: any future
    // tool/wrapper regression produces a visible, debuggable placeholder
    // instead of a hard silent failure.
    const contentIsArray = Array.isArray(toolResultMsg.content);
    const contentBlockCount = contentIsArray ? toolResultMsg.content.length : 0;
    if (contentBlockCount === 0 && !toolResultMsg.isError) {
      const placeholder = `[Tool "${toolResultMsg.toolName}" returned no output.]`;
      toolResultMsg.content = [{ type: "text" as const, text: placeholder }];
      logger.warn(
        {
          toolName: toolResultMsg.toolName,
          toolCallId: toolResultMsg.toolCallId,
          hint:
            "Tool returned a malformed AgentToolResult (missing/empty content). "
            + "Synthesized placeholder so tool_use/tool_result pairing stays valid "
            + "and the LLM receives a signal to continue. Investigate the tool "
            + "or any wrapper that produced this result.",
          errorKind: "validation" as ErrorKind,
        },
        "Microcompaction guard: normalized empty toolResult",
      );
    }

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
      // Offload files hold CLEAN payload bytes; the taint boundary is a
      // presentation concern. A recovery read of an EXTERNAL-origin offload
      // (origin sidecar present) re-enters context re-wrapped so the
      // security notice still rides along; internal-origin files pass
      // through bare exactly as before.
      const originSource = readOffloadOrigin(readFilePath);
      if (originSource) {
        for (const block of toolResultMsg.content) {
          if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
            block.text = wrapExternalContent(block.text, { source: originSource });
          }
        }
      }
      logger.debug(
        { toolName: toolResultMsg.toolName, totalChars, filePath: readFilePath, rewrappedAs: originSource ?? undefined },
        "Recovery read of offloaded file -- skipping re-offload",
      );
      return originalAppend(message);
    }

    // Unwrap once for the offload paths: the disk artifact, the previews, and
    // the recovery example are all derived from the CLEAN payload (the
    // security envelope is re-applied at the presentation boundaries instead
    // of stored at rest). Under-threshold results never pay this.
    const { cleanText, external } = totalChars > threshold
      ? unwrapToolResultText(toolResultMsg.content)
      : { cleanText: "", external: null };

    // Case 1: Hard cap exceeded -- truncate the CLEAN payload THEN offload
    if (totalChars > TOOL_RESULT_HARD_CAP_CHARS) {
      const diskTruncated = cleanText.length > TOOL_RESULT_HARD_CAP_CHARS;
      const diskText = diskTruncated ? cleanText.slice(0, TOOL_RESULT_HARD_CAP_CHARS) : cleanText;

      const { diskPath, written } = saveToDisk(
        sessionDir,
        dataDir,
        toolResultMsg.toolCallId,
        diskText,
        external ? { source: external.source, truncated: diskTruncated, originalChars: totalChars } : null,
        logger,
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

      const reference = createInlineReference(toolResultMsg, totalChars, diskPath, diskText, external, diskTruncated);
      // Pass only a WORKSPACE-RELATIVE pointer (sessionDir-relative) — the
      // absolute diskPath leaks the host filesystem layout and is
      // not a stable drill-down target. This guard holds no event bus and no
      // clock: it computes the payload and hands it to onOffloaded;
      // the executor callback (which has both) performs the trajectory emit.
      //
      // Only emit when the disk write actually persisted: a
      // best-effort write failure (confinement-base escape, fs error) returns
      // `written: false` and the file does not exist, so emitting
      // tool:result_offloaded would record a phantom pointer the
      // IncidentReport.offloads[] drill-down cannot open. Log+suppress instead.
      if (written) {
        const diskPathRel = relative(sessionDir, diskPath); // "tool-results/<toolCallId>.json"
        onOffloaded?.(toolResultMsg.toolName, totalChars, toolResultMsg.toolCallId, diskPathRel);
      } else {
        logger.warn(
          {
            toolName: toolResultMsg.toolName,
            toolCallId: toolResultMsg.toolCallId,
            diskPath,
            hint: "Disk offload write was rejected (confinement-base escape or fs error); suppressed tool:result_offloaded so the trajectory does not record a pointer at a non-existent file. Check the data-dir confinement and filesystem permissions.",
            errorKind: "resource" as ErrorKind,
          },
          "Tool result offload write failed -- suppressing offload event",
        );
      }

      // Propagate the compact reference to the in-memory message object.
      // Without this, currentContext.messages in the agent loop still holds the
      // raw oversized content, causing the bouncer to re-truncate on the next
      // LLM call. By mutating the original content array, both
      // currentContext.messages and agent.state.messages see the compact reference.
      toolResultMsg.content.length = 0;
      toolResultMsg.content.push(...reference.content);

      return originalAppend(reference);
    }

    // Case 2: Exceeds per-tool threshold -- offload the full clean payload
    if (totalChars > threshold) {
      const { diskPath, written } = saveToDisk(
        sessionDir,
        dataDir,
        toolResultMsg.toolCallId,
        cleanText,
        external ? { source: external.source, truncated: false, originalChars: totalChars } : null,
        logger,
      );

      const reference = createInlineReference(toolResultMsg, totalChars, diskPath, cleanText, external, false);

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

      // Same residency-safe pointer at the threshold branch — its own diskPath
      // is in scope (returned by the saveToDisk above). Workspace-relative only.
      // Suppress the offload event on a failed write so the
      // trajectory never records a pointer at a file that was not persisted.
      if (written) {
        const diskPathRel = relative(sessionDir, diskPath); // "tool-results/<toolCallId>.json"
        onOffloaded?.(toolResultMsg.toolName, totalChars, toolResultMsg.toolCallId, diskPathRel);
      } else {
        logger.warn(
          {
            toolName: toolResultMsg.toolName,
            toolCallId: toolResultMsg.toolCallId,
            diskPath,
            hint: "Disk offload write was rejected (confinement-base escape or fs error); suppressed tool:result_offloaded so the trajectory does not record a pointer at a non-existent file. Check the data-dir confinement and filesystem permissions.",
            errorKind: "resource" as ErrorKind,
          },
          "Tool result offload write failed -- suppressing offload event",
        );
      }

      // Propagate the compact reference to the in-memory message object.
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
