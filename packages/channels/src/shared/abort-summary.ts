/**
 * Build a human-readable summary of what an aborted execution accomplished.
 *
 * Inspects toolExecResults from the bridge to identify successful operations
 * and provide actionable context instead of a generic "I ran out of budget" message.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal result shape needed for summary extraction. */
export interface AbortSummaryInput {
  toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string }>;
  stepsExecuted?: number;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/** Maximum number of unique tool names shown in the summary. */
const MAX_TOOLS_SHOWN = 5;

/**
 * Build a brief accomplishment summary from execution results.
 * Returns undefined if nothing useful was accomplished.
 *
 * @param result - Execution result with tool call history
 * @returns Formatted summary string, or undefined if nothing was accomplished
 */
export function buildAbortSummary(result: AbortSummaryInput): string | undefined {
  const execResults = result.toolExecResults;
  if (!execResults || execResults.length === 0) return undefined;

  const successCount = execResults.filter(r => r.success).length;
  const failedCount = execResults.length - successCount;

  // Nothing useful accomplished
  if (successCount === 0) return undefined;

  // Collect unique tool names from successful calls
  const successfulTools = [...new Set(execResults.filter(r => r.success).map(r => r.toolName))];
  const toolsDisplay = successfulTools.length > MAX_TOOLS_SHOWN
    ? [...successfulTools.slice(0, MAX_TOOLS_SHOWN), "..."].join(", ")
    : successfulTools.join(", ");

  // Find last failed call's error text
  const lastFailed = [...execResults].reverse().find(r => !r.success);
  const lastErrorShort = lastFailed?.errorText?.slice(0, 100);

  const lines = [
    `- Completed ${execResults.length} tool operations (${successCount} succeeded, ${failedCount} failed)`,
    `- Tools used: ${toolsDisplay}`,
  ];

  if (lastErrorShort) {
    lines.push(`- Last error: ${lastErrorShort}`);
  }

  return lines.join("\n");
}
