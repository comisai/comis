/**
 * Document extraction platform tool: extract text content from document attachments.
 *
 * Accepts an attachment URL from the message hint and an optional max_chars
 * limit. Delegates to the daemon-side media.extract_document rpcCall handler
 * which resolves the attachment and calls the document extraction pipeline.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, readNumberParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const ExtractDocumentToolParams = Type.Object({
  attachment_url: Type.String({
    description: "The attachment URL from the message hint (e.g. tg-file://..., discord://...)",
  }),
  max_chars: Type.Optional(
    Type.Number({
      description: "Maximum number of characters to extract from the document",
    }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a document extraction tool that delegates to media.extract_document rpcCall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing extract_document
 */
export function createExtractDocumentTool(rpcCall: RpcCall): AgentTool<typeof ExtractDocumentToolParams> {
  return {
    name: "extract_document",
    label: "Document Extraction",
    description:
      "Extract text content from a document attachment (PDF, CSV, TXT, etc.). Pass the attachment_url from the message hint. Optionally limit extracted characters with max_chars.",
    parameters: ExtractDocumentToolParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const attachmentUrl = readStringParam(p, "attachment_url");
        const maxChars = readNumberParam(p, "max_chars", false);

        const result = await rpcCall("media.extract_document", {
          attachment_url: attachmentUrl,
          max_chars: maxChars,
        });

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
