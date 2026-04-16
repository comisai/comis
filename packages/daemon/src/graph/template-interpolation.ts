/**
 * Template interpolation for graph node result forwarding.
 * Downstream nodes in an execution graph need upstream node outputs injected
 * into their task text before spawning. This is the data-flow mechanism that
 * makes graphs useful -- without it, nodes execute in isolation with no
 * context from earlier work.
 * Both functions are pure (no side effects, no async) and independently
 * testable.
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULT_LENGTH = 12000;
const UNAVAILABLE_PREFIX = "[unavailable: node";
const NO_OUTPUT_PLACEHOLDER = "[no output available]";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape regex special characters in a string so it can be used as a literal
 * pattern inside a RegExp constructor.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// interpolateTaskText
// ---------------------------------------------------------------------------

/**
 * Replace `{{nodeId.result}}` patterns in task text with upstream
 * node outputs.
 * Downstream nodes declare dependencies via `dependsOn` and reference
 * upstream outputs directly using `{{nodeId.result}}` templates in their
 * task text. This function resolves those references by looking up each
 * dependency node's output and substituting the corresponding pattern.
 * @param taskText - The node's task text containing template patterns
 * @param dependsOn - Array of upstream node IDs from GraphNode.dependsOn.
 *   Empty array means no interpolation needed.
 * @param nodeOutputs - Maps nodeId to its output text. `undefined` values
 *   indicate the node did not complete (failed/skipped).
 * @param maxResultLength - Truncation limit for injected outputs (default 12000).
 *   Outputs exceeding this length are truncated with a suffix.
 * @param sharedDir - Optional shared directory path. When provided, truncation
 *   messages include a file reference to `{sharedDir}/{nodeId}-output.md` so
 *   downstream agents can access the full output.
 * @param contextMode - Optional context verbosity mode. When "refs", templates
 *   are replaced with file path references instead of inline content, cutting
 *   token usage for large pipelines.
 * @returns The task text with all dependency template patterns replaced.
 *   Patterns referencing non-dependency nodes are left unchanged.
 */
export function interpolateTaskText(
  taskText: string,
  dependsOn: readonly string[],
  nodeOutputs: ReadonlyMap<string, string | undefined>,
  maxResultLength: number = DEFAULT_MAX_RESULT_LENGTH,
  sharedDir?: string,
  contextMode?: "full" | "summary" | "none" | "refs",
): string {
  if (dependsOn.length === 0) {
    return taskText;
  }

  // Sort for deterministic replacement order.
  const sortedDeps = [...dependsOn].sort();

  // Collect all match positions from the original text, then replace
  // right-to-left so substituted content is never re-scanned.
  // This prevents templates inside node outputs from being expanded.
  const matches: Array<{ start: number; end: number; replacement: string }> = [];

  for (const nodeId of sortedDeps) {
    const pattern = new RegExp(
      `\\{\\{${escapeRegExp(nodeId)}\\.result\\}\\}`,
      "g",
    );

    const rawOutput = nodeOutputs.get(nodeId);

    let replacement: string;
    if (rawOutput === undefined) {
      replacement = `${UNAVAILABLE_PREFIX} "${nodeId}" did not complete]`;
    } else if (contextMode === "refs") {
      // Refs mode: emit file path reference instead of inline content
      replacement = sharedDir
        ? `[See: ${sharedDir}/${nodeId}-output.md]`
        : `[See upstream output for "${nodeId}" in shared pipeline folder]`;
    } else if (rawOutput.length > maxResultLength) {
      const suffix = sharedDir
        ? `... [truncated -- full output: ${sharedDir}/${nodeId}-output.md]`
        : "... [truncated]";
      replacement = rawOutput.slice(0, maxResultLength) + suffix;
    } else {
      replacement = rawOutput;
    }

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(taskText)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        replacement,
      });
    }
  }

  // Sort by position descending so we replace right-to-left
  matches.sort((a, b) => b.start - a.start);

  let result = taskText;
  for (const m of matches) {
    result = result.slice(0, m.start) + m.replacement + result.slice(m.end);
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildContextEnvelope
// ---------------------------------------------------------------------------

/**
 * Build a concise markdown envelope that wraps an already-interpolated task
 * with graph context, DAG position, and upstream node outputs.
 * This provides sub-agents with automatic situational awareness about the
 * graph they belong to. Dependencies referenced inline via `{{dep.result}}`
 * templates are deduplicated to avoid redundant output sections. The envelope is appended around the task text so the
 * agent understands its role in the broader execution.
 * This function does NOT call `interpolateTaskText()`. The `task` parameter
 * is expected to be already interpolated. This keeps the two functions
 * independent and composable.
 * @param params.graphLabel - Human-readable graph label (undefined => "Unnamed Graph")
 * @param params.nodeId - The current node's ID
 * @param params.task - Already-interpolated task text
 * @param params.originalTask - Pre-interpolation task text. Dependencies whose
 *   `{{depId.result}}` pattern appears in originalTask are skipped in the
 *   "Output from" section since they were already inlined by interpolation.
 * @param params.dependsOn - IDs of upstream dependency nodes
 * @param params.nodeOutputs - Map of nodeId to output text (undefined = not yet available)
 * @param params.totalNodeCount - Total number of nodes in the graph
 * @param params.maxResultLength - Truncation limit for upstream outputs (default 12000)
 */
export function buildContextEnvelope(params: {
  graphLabel: string | undefined;
  nodeId: string;
  task: string;
  originalTask: string;
  dependsOn: string[];
  nodeOutputs: ReadonlyMap<string, string | undefined>;
  totalNodeCount: number;
  maxResultLength?: number;
  /** Shared directory path for inter-node file sharing. */
  sharedDir?: string;
  /** Context verbosity mode controlling upstream output injection (default: "full"). */
  contextMode?: "full" | "summary" | "none" | "refs";
  /** Upstream node IDs that failed (computed by caller from state machine). */
  failedUpstream?: string[];
  /** Upstream node IDs that were skipped (computed by caller from state machine). */
  skippedUpstream?: string[];
}): string {
  const {
    graphLabel,
    nodeId,
    task,
    originalTask,
    dependsOn,
    nodeOutputs,
    totalNodeCount,
    maxResultLength = DEFAULT_MAX_RESULT_LENGTH,
    sharedDir,
    contextMode = "full",
    failedUpstream = [],
    skippedUpstream = [],
  } = params;

  // Sort dependsOn alphabetically for deterministic envelope prefix.
  // Sibling nodes with identical upstream sets produce byte-identical context sections.
  const sortedDeps = [...dependsOn].sort();

  const lines: string[] = [];

  // Header
  const label = graphLabel ?? "Unnamed Graph";
  lines.push(`## Graph Context`);
  lines.push(`**Graph:** ${label}`);
  lines.push(`You are node "${nodeId}" in a ${totalNodeCount}-node execution graph.`);

  // DAG position
  if (sortedDeps.length === 0) {
    lines.push(`You are a root node (no upstream dependencies).`);
  } else {
    lines.push(`Upstream dependencies: ${sortedDeps.join(", ")}`);
  }

  // Upstream outputs (only if there are dependencies and contextMode is not "none")
  if (sortedDeps.length > 0 && contextMode !== "none") {
    const effectiveMaxLen = contextMode === "summary" ? 500 : maxResultLength;
    lines.push("");
    for (const depId of sortedDeps) {
      // Skip deps already inlined via {{depId.result}} template interpolation
      if (originalTask.includes(`{{${depId}.result}}`)) continue;

      const output = nodeOutputs.get(depId);
      lines.push(`### Output from "${depId}"`);
      if (output === undefined) {
        lines.push(NO_OUTPUT_PLACEHOLDER);
      } else if (contextMode === "refs") {
        // Refs mode: emit file path reference instead of inline content
        lines.push(
          sharedDir
            ? `See: ${sharedDir}/${depId}-output.md`
            : `[See upstream output in shared pipeline folder]`,
        );
      } else if (output.length > effectiveMaxLen) {
        const suffix = sharedDir
          ? `... [truncated -- full output: ${sharedDir}/${depId}-output.md]`
          : "... [truncated]";
        lines.push(output.slice(0, effectiveMaxLen) + suffix);
      } else {
        lines.push(output);
      }
    }
  }

  // Degradation notice: identify missing upstream inputs
  if (failedUpstream.length > 0 || skippedUpstream.length > 0) {
    lines.push("");
    lines.push("## Degraded Input");
    lines.push("Some upstream nodes did not complete successfully:");
    for (const f of failedUpstream) lines.push(`- **${f}**: FAILED`);
    for (const s of skippedUpstream) lines.push(`- **${s}**: SKIPPED`);
    lines.push("");
    lines.push("Proceed with the data available from successful upstream nodes. Note any limitations in your output due to missing inputs.");
  }

  // Shared pipeline folder (read-only guidance — output is auto-persisted by coordinator)
  if (sharedDir) {
    lines.push("");
    lines.push(`## Shared Pipeline Folder`);
    lines.push(`Path: ${sharedDir}`);
    lines.push(`Your output is captured automatically — do not write additional files unless explicitly asked.`);
    lines.push(`All nodes in this pipeline share this folder.`);
    lines.push(`NOTE: Upstream nodes may have written detailed reports here that contain more information than the condensed outputs above. Check this folder for additional context.`);
  }

  // Task section
  lines.push("");
  lines.push(`## Your Task`);
  lines.push(task);

  // Output instruction: ensure sub-agents always end with visible text content
  // so downstream nodes receive non-empty input via getLastAssistantText().
  lines.push("");
  lines.push("IMPORTANT: Your final response MUST contain visible text content summarizing your output or result. Do not end with only thinking/reasoning — always include a text reply.");

  return lines.join("\n");
}
