// SPDX-License-Identifier: Apache-2.0
/**
 * MCP image-result policy for the daemon composition root.
 *
 * Image blocks in MCP tool results pass the same sharp-backed sanitizer as
 * browser screenshots before they become model-visible, and every block the
 * bridge drops is a content-free WARN carrying the identifiers, sizes, and a
 * hint — never the image bytes.
 *
 * @module
 */

import type { McpImageDroppedEvent, McpImageResultPolicy } from "@comis/skills";
import { sanitizeImageForApi } from "@comis/skills/tools";

/** Minimal logger surface the policy needs. */
export interface McpImagePolicyLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Build the image-result policy handed to `mcpToolsToAgentTools`. */
export function createMcpImageResultPolicy(logger: McpImagePolicyLogger): McpImageResultPolicy {
  return {
    sanitizeImage: sanitizeImageForApi,
    onImageDropped: (event: McpImageDroppedEvent): void => {
      logger.warn(
        {
          ...event,
          hint: "The MCP server returned an image block the bridge did not attach; check the image-sanitizer diagnostics or the per-call image limit",
          errorKind: "validation" as const,
        },
        "MCP image result block dropped",
      );
    },
  };
}
