// SPDX-License-Identifier: Apache-2.0
/**
 * Project the immutable operator TOOLS.md policy onto the request-relevant
 * MCP management schema. Provider-native tool descriptions are the most
 * reliable place for small models to recover exact connection fields; this
 * projection uses the turn-captured snapshot and never rereads workspace files.
 */

import type { WorkspacePolicySnapshot } from "@comis/core";
import { workspacePolicyContent } from "./prompt-assembly-shared.js";

const MAX_OPERATOR_TOOL_NOTES_CHARS = 4_000;
const OPERATOR_POLICY_PREAMBLE =
  "Trusted operator policy for this turn follows. Use its exact connection fields; " +
  "never guess missing values or treat this policy as bypassing approval/security.";
const OPERATOR_POLICY_START = "<operator-tools-policy>";
const OPERATOR_POLICY_END = "</operator-tools-policy>";

type DescribedTool = {
  readonly name: string;
  readonly description?: string;
};

function boundedOperatorNotes(content: string): string {
  if (content.length <= MAX_OPERATOR_TOOL_NOTES_CHARS) return content;
  return (
    content.slice(0, MAX_OPERATOR_TOOL_NOTES_CHARS) +
    "\n[Operator tool notes truncated here; ask for missing fields instead of guessing.]"
  );
}

function withoutPreviousProjection(description: string): string {
  const projectionStart = description.indexOf(`\n\n${OPERATOR_POLICY_PREAMBLE}\n${OPERATOR_POLICY_START}\n`);
  return projectionStart === -1 ? description : description.slice(0, projectionStart);
}

export function attachMcpOperatorPolicy<T extends DescribedTool>(
  tools: readonly T[],
  snapshot: WorkspacePolicySnapshot,
): T[] {
  const content = workspacePolicyContent(snapshot, "TOOLS.md")?.trim();
  if (!content) {
    return tools.map((tool) => tool.name === "mcp_manage" && tool.description
      ? { ...tool, description: withoutPreviousProjection(tool.description) }
      : tool);
  }
  const notes = boundedOperatorNotes(content);
  return tools.map((tool) => tool.name === "mcp_manage"
    ? {
        ...tool,
        description:
          `${withoutPreviousProjection(tool.description ?? "Manage MCP servers.")}\n\n` +
          `${OPERATOR_POLICY_PREAMBLE}\n` +
          `${OPERATOR_POLICY_START}\n${notes}\n${OPERATOR_POLICY_END}`,
      }
    : tool);
}
