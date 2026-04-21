// SPDX-License-Identifier: Apache-2.0
/**
 * Dead content evictor context engine layer.
 *
 * Removes provably-dead tool results from the context window by detecting
 * superseded file reads, exec results, web results, old images, and stale
 * error-only results. Superseded content is replaced with lightweight
 * placeholders that include a session_search hint for retrieval.
 *
 * The evictor uses a forward index for O(n) supersession detection:
 *   Phase A: Build toolCallId -> arguments map from assistant toolCall blocks.
 *   Phase B: Build supersession keys and track most-recent index per key.
 *   Phase C: Identify eviction targets based on supersession + age rules.
 *   Phase D: Build new message array with placeholders (immutable).
 *   Phase E: Report stats via onEvicted callback.
 *
 * - Superseded file reads evicted with placeholder
 * - Superseded exec results evicted with placeholder
 * - Superseded web results evicted with placeholder
 * - Old image blocks evicted with placeholder
 * - Stale error-only results evicted with placeholder
 * - Layer positioned between history-window and observation-masker
 * - Input array immutability guaranteed
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget, EvictionStats } from "./types.js";
import { getToolResultText, isAlreadyOffloaded, isAlreadyMasked } from "./cleanup-helpers.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the dead content evictor layer. */
export interface DeadContentEvictorConfig {
  /** Minimum tool result positions from newest before eligible for eviction. */
  evictionMinAge: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Tool name sets for supersession key generation. */
const FILE_READ_TOOLS = new Set(["file_read", "file_write", "read_file"]);
const EXEC_TOOLS = new Set(["bash", "execute", "exec", "run_command"]);
const WEB_SEARCH_TOOLS = new Set(["brave_search", "web_search"]);
const WEB_FETCH_TOOLS = new Set(["web_fetch", "link_reader", "fetch_url"]);

/** Category labels for each tool group. */
const TOOL_CATEGORY: Record<string, string> = {};
for (const t of FILE_READ_TOOLS) TOOL_CATEGORY[t] = "file_read"; // eslint-disable-line security/detect-object-injection
for (const t of EXEC_TOOLS) TOOL_CATEGORY[t] = "exec"; // eslint-disable-line security/detect-object-injection
for (const t of WEB_SEARCH_TOOLS) TOOL_CATEGORY[t] = "web"; // eslint-disable-line security/detect-object-injection
for (const t of WEB_FETCH_TOOLS) TOOL_CATEGORY[t] = "web"; // eslint-disable-line security/detect-object-injection

/**
 * Error patterns for detecting error-only tool results.
 * Results matching these patterns (and <= 500 chars) are considered stale errors.
 */
const ERROR_PATTERNS = [
  /^\[Error:/i, /^Error:/i, /^ENOENT:/i, /^EACCES:/i,
  /^Command failed/i, /^exit code [1-9]/i,
  /^Permission denied/i, /^No such file/i,
];

/** Check if a tool result has already been evicted by a previous evictor run. */
function isAlreadyEvicted(msg: AgentMessage): boolean {
  const text = getToolResultText(msg);
  return text.startsWith("[Superseded:") || text.startsWith("[Image evicted:");
}

/**
 * Check if an assistant message is a dead error turn.
 * Dead error turns have empty content arrays and stopReason: "error".
 * These are produced when the LLM provider returns an error that the SDK
 * retries internally but never recovers from.
 */
function isDeadErrorTurn(msg: AgentMessage): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const m = msg as any;
  if (m.role !== "assistant") return false;
  if (!("stopReason" in m) || m.stopReason !== "error") return false;
  const content = m.content;
  return Array.isArray(content) && content.length === 0;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Check if a tool result is an error-only result. */
function isErrorOnlyResult(msg: AgentMessage): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if ((msg as any).isError === true) return true;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const text = getToolResultText(msg);
  if (!text || text.length > 500) return false; // long results are not error-only
  return ERROR_PATTERNS.some(p => p.test(text));
}

/** Check if a content block is an image block. */
function isImageBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  return (block as Record<string, unknown>).type === "image";
}

/** Get the media type from an image block source. */
function getImageMediaType(block: unknown): string {
  if (!block || typeof block !== "object") return "image";
  const b = block as Record<string, unknown>;
  const source = b.source as Record<string, unknown> | undefined;
  return (source?.media_type as string) ?? "image";
}

/** Check if a content array contains image blocks. */
function hasImageBlocks(msg: AgentMessage): boolean {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (msg as any).content;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (!Array.isArray(content)) return false;
  return content.some(isImageBlock);
}

/**
 * Generate a supersession key for a tool result based on its tool name
 * and arguments from the forward index.
 *
 * Returns null if the tool does not support supersession (not in any tool group).
 */
function generateSupersessionKey(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (FILE_READ_TOOLS.has(toolName)) {
    const path = (args.path ?? args.file_path ?? "") as string;
    return path ? `file:${path}` : null;
  }
  if (EXEC_TOOLS.has(toolName)) {
    const command = (args.command ?? args.cmd ?? "") as string;
    return command ? `exec:${command}` : null;
  }
  if (WEB_SEARCH_TOOLS.has(toolName)) {
    const query = (args.query ?? args.q ?? "") as string;
    return query ? `search:${query.toLowerCase().trim()}` : null;
  }
  if (WEB_FETCH_TOOLS.has(toolName)) {
    const url = (args.url ?? args.uri ?? "") as string;
    return url ? `fetch:${url.replace(/\/+$/, "")}` : null;
  }
  return null;
}

/**
 * Compute the character count of a message's content for eviction tracking.
 */
function getContentChars(msg: AgentMessage): number {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (msg as any).content;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block && typeof block === "object") {
      if (typeof (block as Record<string, unknown>).text === "string") {
        chars += ((block as Record<string, unknown>).text as string).length;
      } else if (isImageBlock(block)) {
        // Count image data as ~1000 chars (conservative estimate for tracking)
        chars += 1000;
      }
    }
  }
  return chars;
}

/**
 * Create a new tool result message with eviction placeholder (immutable).
 * Does not mutate the original message.
 */
function createEvictedMessage(original: AgentMessage, placeholder: string): AgentMessage {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const o = original as any;
  const evicted: Record<string, unknown> = {
    role: o.role,
    toolCallId: o.toolCallId,
    toolName: o.toolName,
    content: [{ type: "text", text: placeholder }],
    isError: o.isError,
  };
  if (o.timestamp !== undefined) {
    evicted.timestamp = o.timestamp;
  }
  return evicted as unknown as AgentMessage;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Create a new assistant message with image blocks replaced by placeholders (immutable).
 * Preserves non-image blocks in the content array.
 */
function createImageEvictedAssistantMessage(original: AgentMessage, turnIndex: number): AgentMessage {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const o = original as any;
  const content = Array.isArray(o.content) ? o.content : [];
  const newContent = content.map((block: unknown) => {
    if (isImageBlock(block)) {
      const mediaType = getImageMediaType(block);
      return { type: "text", text: `[Image evicted: ${mediaType} from turn ${turnIndex}]` };
    }
    return block;
  });
  return { ...o, content: newContent } as unknown as AgentMessage;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a dead content evictor context layer.
 *
 * @param config - Evictor configuration (evictionMinAge threshold)
 * @param onEvicted - Optional callback for reporting eviction stats
 * @returns ContextLayer that removes provably-dead tool results
 */
export function createDeadContentEvictorLayer(
  config: DeadContentEvictorConfig,
  onEvicted?: (stats: EvictionStats) => void,
): ContextLayer {
  return {
    name: "dead-content-evictor",

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      if (messages.length === 0) {
        onEvicted?.({ evictedCount: 0, evictedChars: 0, categories: {} });
        return messages;
      }

      // -----------------------------------------------------------------------
      // Phase A: Build forward index of tool call arguments
      // -----------------------------------------------------------------------
      // Map: toolCallId -> { toolName, arguments }
      const toolCallArgs = new Map<string, Record<string, unknown>>();

      for (const msg of messages) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        if ((msg as any).role !== "assistant") continue;
        const content = (msg as any).content;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "toolCall" || b.type === "tool_use") {
            const id = (b.toolCallId ?? b.id ?? "") as string;
            const args = (b.arguments ?? b.input ?? {}) as Record<string, unknown>;
            if (id) {
              toolCallArgs.set(id, args);
            }
          }
        }
      }

      // -----------------------------------------------------------------------
      // Phase B: Identify tool results and compute supersession keys
      // -----------------------------------------------------------------------
      // Collect all tool result indices and their supersession keys
      interface ToolResultEntry {
        index: number;
        toolName: string;
        toolCallId: string;
        supersessionKey: string | null;
        toolResultIndex: number; // position from newest (0 = newest)
      }

      const toolResults: ToolResultEntry[] = [];
      // Walk newest-to-oldest to assign toolResultIndex
      let toolResultCounter = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!; // eslint-disable-line security/detect-object-injection
        if (msg.role !== "toolResult") continue;

        /* eslint-disable @typescript-eslint/no-explicit-any */
        const toolName = (msg as any).toolName ?? "";
        const toolCallId = (msg as any).toolCallId ?? "";
        /* eslint-enable @typescript-eslint/no-explicit-any */

        // Skip already-processed content
        if (isAlreadyOffloaded(msg) || isAlreadyMasked(msg) || isAlreadyEvicted(msg)) {
          toolResultCounter++;
          continue;
        }

        const args = toolCallArgs.get(toolCallId) ?? {};
        const supersessionKey = generateSupersessionKey(toolName, args);

        toolResults.push({
          index: i,
          toolName,
          toolCallId,
          supersessionKey,
          toolResultIndex: toolResultCounter,
        });

        toolResultCounter++;
      }

      // Build most-recent-index map: supersessionKey -> message index of newest occurrence
      const mostRecentByKey = new Map<string, number>();
      // toolResults is ordered newest-first, so first occurrence = most recent
      for (const entry of toolResults) {
        if (entry.supersessionKey && !mostRecentByKey.has(entry.supersessionKey)) {
          mostRecentByKey.set(entry.supersessionKey, entry.index);
        }
      }

      // -----------------------------------------------------------------------
      // Phase C: Identify eviction targets
      // -----------------------------------------------------------------------
      interface EvictionTarget {
        index: number;
        category: string;
        placeholder: string;
      }

      const targets: EvictionTarget[] = [];

      for (const entry of toolResults) {
        // Messages at or before the cache fence must not be evicted
        if (entry.index <= budget.cacheFenceIndex) continue;

        // Age check: skip if too recent
        if (entry.toolResultIndex < config.evictionMinAge) continue;

        const msg = messages[entry.index]!;  

        // Check supersession
        if (entry.supersessionKey) {
          const mostRecentIdx = mostRecentByKey.get(entry.supersessionKey);
          if (mostRecentIdx !== undefined && mostRecentIdx !== entry.index) {
            // This result is superseded by a newer one
            const args = toolCallArgs.get(entry.toolCallId) ?? {};
            const category = TOOL_CATEGORY[entry.toolName] ?? "other";  
            let placeholder: string;

            if (FILE_READ_TOOLS.has(entry.toolName)) {
              const path = (args.path ?? args.file_path ?? "unknown") as string;
              placeholder = `[Superseded: file_read ${path} -- re-read at turn ${entry.toolResultIndex} -- use session_search to retrieve]`;
            } else if (EXEC_TOOLS.has(entry.toolName)) {
              const command = (args.command ?? args.cmd ?? "unknown") as string;
              placeholder = `[Superseded: ${entry.toolName} ${command} -- re-run at turn ${entry.toolResultIndex} -- use session_search to retrieve]`;
            } else if (WEB_SEARCH_TOOLS.has(entry.toolName)) {
              placeholder = `[Superseded: ${entry.toolName} -- re-fetched at turn ${entry.toolResultIndex} -- use session_search to retrieve]`;
            } else {
              placeholder = `[Superseded: ${entry.toolName} -- re-fetched at turn ${entry.toolResultIndex} -- use session_search to retrieve]`;
            }

            targets.push({ index: entry.index, category, placeholder });
            continue;
          }
        }

        // Check image eviction
        if (hasImageBlocks(msg)) {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const content = (msg as any).content;
          /* eslint-enable @typescript-eslint/no-explicit-any */
          const imageBlock = Array.isArray(content)
            ? content.find(isImageBlock)
            : undefined;
          const mediaType = imageBlock ? getImageMediaType(imageBlock) : "image";
          targets.push({
            index: entry.index,
            category: "image",
            placeholder: `[Image evicted: ${mediaType} from turn ${entry.toolResultIndex}]`,
          });
          continue;
        }

        // Check error-only eviction
        if (isErrorOnlyResult(msg)) {
          targets.push({
            index: entry.index,
            category: "error",
            placeholder: `[Superseded: ${entry.toolName} error result -- use session_search to retrieve]`,
          });
          continue;
        }
      }

      // Also check assistant messages for image blocks beyond age threshold
      // Build an index of all messages ordered by position for age comparison
      const assistantImageTargets: Array<{ index: number; turnIndex: number }> = [];
      let msgCounter = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!; // eslint-disable-line security/detect-object-injection
        /* eslint-disable @typescript-eslint/no-explicit-any */
        // Messages at or before the cache fence must not be evicted
        if (i <= budget.cacheFenceIndex) {
          msgCounter++;
          continue;
        }
        if ((msg as any).role === "assistant" && hasImageBlocks(msg)) {
          if (msgCounter >= config.evictionMinAge) {
            // Check it's not already evicted
            if (!isAlreadyEvicted(msg)) {
              assistantImageTargets.push({ index: i, turnIndex: msgCounter });
            }
          }
        }
        msgCounter++;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }

      // Dead error turn eviction: assistant messages with content: [] and
      // stopReason: "error" carry zero conversational value. The error details
      // are already captured in daemon logs via the event bridge WARN.
      // NOT subject to evictionMinAge -- dead error turns are always useless.
      const deadErrorTurnTargets: Array<{ index: number }> = [];
      for (let i = 0; i < messages.length; i++) {
        // Messages at or before the cache fence must not be evicted
        if (i <= budget.cacheFenceIndex) continue;
        const msg = messages[i]!; // eslint-disable-line security/detect-object-injection
        if (isDeadErrorTurn(msg)) {
          deadErrorTurnTargets.push({ index: i });
        }
      }

      // -----------------------------------------------------------------------
      // Phase D: Build evicted message array (immutable)
      // -----------------------------------------------------------------------
      if (targets.length === 0 && assistantImageTargets.length === 0 && deadErrorTurnTargets.length === 0) {
        onEvicted?.({ evictedCount: 0, evictedChars: 0, categories: {} });
        return messages;
      }

      const targetSet = new Map<number, EvictionTarget>();
      for (const target of targets) {
        targetSet.set(target.index, target);
      }
      const assistantImageSet = new Map<number, number>(); // index -> turnIndex
      for (const ait of assistantImageTargets) {
        assistantImageSet.set(ait.index, ait.turnIndex);
      }
      const deadErrorTurnSet = new Set<number>();
      for (const det of deadErrorTurnTargets) {
        deadErrorTurnSet.add(det.index);
      }

      const result: AgentMessage[] = new Array(messages.length);
      let evictedCount = 0;
      let evictedChars = 0;
      const categories: Record<string, number> = {};

      /* eslint-disable security/detect-object-injection -- array index access */
      for (let i = 0; i < messages.length; i++) {
        const target = targetSet.get(i);
        if (target) {
          const chars = getContentChars(messages[i]!);
          result[i] = createEvictedMessage(messages[i]!, target.placeholder);
          evictedCount++;
          evictedChars += chars;
          categories[target.category] = (categories[target.category] ?? 0) + 1;
        } else if (assistantImageSet.has(i)) {
          const turnIndex = assistantImageSet.get(i)!;
          const chars = getContentChars(messages[i]!);
          result[i] = createImageEvictedAssistantMessage(messages[i]!, turnIndex);
          evictedCount++;
          evictedChars += chars;
          categories["image"] = (categories["image"] ?? 0) + 1;
        } else if (deadErrorTurnSet.has(i)) {
          const chars = getContentChars(messages[i]!);
          // Replace with a minimal placeholder so the turn structure is preserved
          // (prevents orphaned toolResult messages in the conversation)
          result[i] = {
            ...(messages[i] as any), // eslint-disable-line @typescript-eslint/no-explicit-any
            content: [{ type: "text", text: "[Dead error turn evicted: LLM returned empty error response]" }],
          } as unknown as AgentMessage;
          evictedCount++;
          evictedChars += chars;
          categories["dead_error_turn"] = (categories["dead_error_turn"] ?? 0) + 1;
        } else {
          result[i] = messages[i]!;
        }
      }
      /* eslint-enable security/detect-object-injection */

      // -----------------------------------------------------------------------
      // Phase E: Report stats via callback
      // -----------------------------------------------------------------------
      onEvicted?.({ evictedCount, evictedChars, categories });

      return result;
    },
  };
}

// Re-export EvictionStats from types for consumer convenience
export type { EvictionStats } from "./types.js";
