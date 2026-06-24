// SPDX-License-Identifier: Apache-2.0
/**
 * NarrativeCaster: Transforms condensed subagent results into clearly-tagged,
 * metadata-rich announcement text for parent agent context injection.
 *
 * The `[Subagent Result: {label}]` prefix tag prevents role confusion in the
 * parent's context window and provides execution metadata (runtime, tokens,
 * cost, condensation level, disk path) without parsing raw text.
 *
 * Pure synchronous string formatting -- no async, no LLM calls, no disk I/O.
 *
 * @module
 */

import type { CondensedResult, ResultRef } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the NarrativeCaster factory. */
export interface NarrativeCasterConfig {
  /** Whether narrative casting is enabled (config.narrativeCasting). */
  enabled: boolean;
  /** Tag prefix (config.resultTagPrefix, default "Subagent Result"). */
  tagPrefix: string;
}

/** Parameters for a single cast() call. */
export interface CastParams {
  /** Condensed result from ResultCondenser. */
  condensedResult: CondensedResult;
  /** Original task description (used as default label). */
  task: string;
  /** Label override (e.g., task summary). */
  label?: string;
  /** Execution metadata. */
  runtimeMs: number;
  stepsExecuted: number;
  tokensUsed: number;
  cost: number;
  /** Sub-agent session key for reference. */
  sessionKey: string;
  /**
   * Phase 218 (SUMREF-02): the child's full output materialized to its jailed
   * workspace as a structured handle. When present, the "Full result" line
   * becomes the drill-in handle (ref + bytes + kind) the lead queries on demand
   * (read/grep/jq), instead of the bare condenser diskPath — so the lead's
   * window grows by a summary + a handle, never the megabyte body. Absent ⇒ the
   * line falls back to `condensedResult.diskPath` (today's behavior).
   */
  resultRef?: ResultRef;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters for the label in the tag header. */
const MAX_LABEL_LENGTH = 100;

/**
 * Trailing instruction appended to every announcement.
 * MUST start with "Inform the user about this completed background task."
 * for AnnouncementBatcher.stripSystemPrefix() compatibility.
 *
 * Exported so packages/agent/src/background/completion-formatter.ts can
 * reuse the byte-identical string. Do NOT change the string
 * without updating both consumers AND announcement-batcher.ts:81.
 */
export const TRAILING_INSTRUCTION =
  "Inform the user about this completed background task. Summarize the result in your own voice. If no user notification is needed, respond with NO_REPLY.";

/** Human-readable names for condensation levels. */
const LEVEL_NAMES: Record<number, string> = {
  1: "Passthrough",
  2: "LLM summary",
  3: "Truncation",
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a NarrativeCaster with the given configuration.
 *
 * The returned `cast()` method is pure synchronous string formatting.
 * When `config.enabled` is false, output falls back to the untagged
 * `[System Message]` format matching legacy `buildAnnouncementMessage`.
 */
export function createNarrativeCaster(config: NarrativeCasterConfig) {
  return {
    cast(params: CastParams): string {
      if (!config.enabled) {
        return formatUntaggedResult(params);
      }
      return formatTaggedResult(params, config.tagPrefix);
    },
  };
}

// ---------------------------------------------------------------------------
// Label truncation helper
// ---------------------------------------------------------------------------

/**
 * Truncate label text for the tag header.
 * Empty/whitespace-only input returns "unnamed task".
 * Labels over MAX_LABEL_LENGTH are truncated with "..." suffix.
 */
function truncateLabel(text: string): string {
  if (!text || text.trim().length === 0) return "unnamed task";
  const clean = text.trim();
  if (clean.length <= MAX_LABEL_LENGTH) return clean;
  return clean.slice(0, MAX_LABEL_LENGTH - 3) + "...";
}

// ---------------------------------------------------------------------------
// Full-result drill-in line (SUMREF-02)
// ---------------------------------------------------------------------------

/**
 * The "Full result" announcement line. When a materialized {@link ResultRef}
 * handle is present, the lead drills into it on demand (read/grep/jq) so only a
 * summary + a handle enter its window (the longevity invariant); otherwise the
 * bare condenser `diskPath` is used (today's behavior — no store/handle, so the
 * on-disk condensed result IS the pointer). Kept byte-aligned with the runner's
 * buildAnnouncementMessage body so both announcement paths agree.
 */
function formatFullResultLine(diskPath: string, resultRef?: ResultRef): string {
  if (resultRef) {
    return `Full result (drill in with read/grep/jq): ${resultRef.ref} (${resultRef.bytes}B, ${resultRef.kind})`;
  }
  return `Full result: ${diskPath}`;
}

// ---------------------------------------------------------------------------
// Tagged result format (enabled mode)
// ---------------------------------------------------------------------------

function formatTaggedResult(params: CastParams, tagPrefix: string): string {
  const { condensedResult, task, runtimeMs, stepsExecuted, tokensUsed, cost, sessionKey, resultRef } = params;
  const label = truncateLabel(params.label ?? task);
  const result = condensedResult.result;

  const sections: string[] = [];

  // 1. Header tag
  sections.push(`[${tagPrefix}: ${label}]`);

  // 2. Status line
  sections.push(`Status: ${result.taskComplete ? "Completed" : "Incomplete"}`);

  // 3. Condensation line
  sections.push(`Condensation: Level ${condensedResult.level} (${LEVEL_NAMES[condensedResult.level] ?? "unknown"})`);
  sections.push("");

  // 4. Summary section (only if non-empty)
  if (result.summary) {
    sections.push(`Summary: ${result.summary}`);
    sections.push("");
  }

  // 5. Conclusions section (only if non-empty)
  if (result.conclusions?.length) {
    sections.push("Conclusions:");
    for (const c of result.conclusions) {
      sections.push(`- ${c}`);
    }
    sections.push("");
  }

  // 6. File Paths section (only if non-empty)
  if (result.filePaths?.length) {
    sections.push("File Paths:");
    for (const p of result.filePaths) {
      sections.push(`- ${p}`);
    }
    sections.push("");
  }

  // 7. Actionable Items section (only if non-empty)
  if (result.actionableItems?.length) {
    sections.push("Actionable Items:");
    for (const item of result.actionableItems) {
      sections.push(`- ${item}`);
    }
    sections.push("");
  }

  // 8. Errors section (only if non-empty)
  if (result.errors?.length) {
    sections.push("Errors:");
    for (const e of result.errors) {
      sections.push(`- ${e}`);
    }
    sections.push("");
  }

  // 9. Metadata separator
  sections.push("---");

  // 10. Runtime stats line
  sections.push(
    `Runtime: ${(runtimeMs / 1000).toFixed(1)}s | ` +
    `Steps: ${stepsExecuted} | ` +
    `Tokens: ${tokensUsed} | ` +
    `Cost: $${cost.toFixed(4)}`,
  );

  // 11. Condensation stats line
  sections.push(
    `Condensation: Level ${condensedResult.level} | ` +
    `Original: ${condensedResult.originalTokens} tokens | ` +
    `Ratio: ${condensedResult.compressionRatio.toFixed(2)}`,
  );

  // 12. Full result drill-in (the structured ResultRef handle when present —
  // SUMREF-02 — else the condenser diskPath).
  sections.push(formatFullResultLine(condensedResult.diskPath, resultRef));

  // 13. Session line
  sections.push(`Session: ${sessionKey}`);

  // 14. Trailing instruction
  sections.push("");
  sections.push(TRAILING_INSTRUCTION);

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Untagged result format (disabled mode fallback)
// ---------------------------------------------------------------------------

function formatUntaggedResult(params: CastParams): string {
  const { condensedResult, task, runtimeMs, stepsExecuted, tokensUsed, cost, sessionKey, resultRef } = params;
  const result = condensedResult.result;

  return [
    `[System Message]`,
    `A background task has completed.`,
    ``,
    `Task: ${task}`,
    `Status: ${result.taskComplete ? "Success" : "Incomplete"}`,
    `Result: ${result.summary}`,
    ``,
    `---`,
    `Runtime: ${(runtimeMs / 1000).toFixed(1)}s | Steps: ${stepsExecuted} | Tokens: ${tokensUsed} | Cost: $${cost.toFixed(4)} | Session: ${sessionKey}`,
    formatFullResultLine(condensedResult.diskPath, resultRef),
    ``,
    TRAILING_INSTRUCTION,
  ].join("\n");
}
