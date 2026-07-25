// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion formatter: transforms a BackgroundTask into a
 * tagged announcement string ready for injection into the originating
 * agent's session as a synthetic NormalizedMessage.
 *
 * Mirrors the shape of packages/agent/src/spawn/narrative-caster.ts (the
 * sub-agent announcement formatter). Simplified: no condensation levels,
 * no metadata stats, no labels -- just a single tool result with
 * toolName + result/error.
 *
 * The trailing instruction is byte-identical to TRAILING_INSTRUCTION in
 * narrative-caster.ts so AnnouncementBatcher.stripSystemPrefix()
 * (announcement-batcher.ts:81-85) keeps working unchanged.
 *
 * Pure synchronous string formatting -- no async, no LLM calls, no I/O.
 *
 * @module
 */

import type { BackgroundTask } from "./background-task-types.js";
import { TRAILING_INSTRUCTION } from "../spawn/narrative-caster.js";

/** Re-export so consumers (tests, completion runner) can assert byte-identity. */
export { TRAILING_INSTRUCTION } from "../spawn/narrative-caster.js";

/** NormalizedMessageSchema.text caps at 32768 chars. Reserve headroom for header + trailing instruction. */
const MAX_ANNOUNCEMENT_CHARS = 32768;
const TRUNCATION_MARKER = "\n…[truncated]";
const COMPLETION_FOLLOWUP_INSTRUCTION =
  "Before answering, inspect the result for continuation metadata such as next-page cursors or incomplete markers. " +
  "When present, use the available tools to retrieve every remaining result page. Preserve large complete results " +
  "with the available file tools before summarizing.";

/** Recovery announcement body for tasks failed via recoverOnStartup. */
const RESTART_RECOVERY_BODY =
  "This background task was interrupted by a daemon restart. The result is unavailable; let the user know if relevant.";
const RESTART_RECOVERY_ERROR = "Daemon restarted while task was running";

/**
 * Format a BackgroundTask completion or failure into a tagged announcement.
 *
 * Header forms:
 *   - success: `[Background Task: ${toolName}]`
 *   - failure: `[Background Task Failed: ${toolName}]`
 *
 * Body:
 *   - success: `task.result` (already capped at 100 KB by manager.truncateResult).
 *   - generic failure: `task.error`.
 *   - restart-recovery failure (`task.error === "Daemon restarted while task was running"`):
 *     uses the explicit recovery copy.
 *
 * Total-length cap: NormalizedMessageSchema.text limits at 32768 chars.
 * If the assembled string would exceed the cap, only the body section is
 * truncated; the header and trailing instruction are NEVER touched.
 */
export function formatCompletionAnnouncement(task: BackgroundTask): string {
  const isFailure = task.status === "failed" || task.status === "cancelled";
  const headerPrefix = isFailure ? "Background Task Failed" : "Background Task";
  const header = `[${headerPrefix}: ${task.toolName}]`;

  let body: string;
  if (isFailure) {
    const rawError = task.error ?? "(no error message)";
    body = rawError === RESTART_RECOVERY_ERROR ? RESTART_RECOVERY_BODY : rawError;
  } else {
    body = task.result ?? "(no result)";
  }

  // Build assembled string: header, blank line, body, blank line, trailing instruction.
  const sections: string[] = [];
  sections.push(header);
  sections.push("");
  sections.push(body);
  sections.push("");
  if (!isFailure) {
    sections.push(COMPLETION_FOLLOWUP_INSTRUCTION);
    sections.push("");
  }
  sections.push(TRAILING_INSTRUCTION);
  let assembled = sections.join("\n");

  // Enforce NormalizedMessageSchema.text.max(32768). Truncate the body section
  // ONLY if needed; header and trailing instruction are byte-identical guarantees.
  if (assembled.length > MAX_ANNOUNCEMENT_CHARS) {
    const headerSection = `${header}\n\n`;
    const followupSection = isFailure ? "" : `${COMPLETION_FOLLOWUP_INSTRUCTION}\n\n`;
    const tailSection = `\n\n${followupSection}${TRAILING_INSTRUCTION}`;
    const reservedChars = headerSection.length + tailSection.length + TRUNCATION_MARKER.length;
    const allowedBodyChars = MAX_ANNOUNCEMENT_CHARS - reservedChars;
    const truncatedBody = body.slice(0, Math.max(0, allowedBodyChars)) + TRUNCATION_MARKER;
    assembled = headerSection + truncatedBody + tailSection;
  }

  return assembled;
}
