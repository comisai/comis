/**
 * Image analysis platform tool: analyze images using vision AI.
 *
 * Accepts file paths, URLs, or base64-encoded image data. Delegates
 * to the daemon-side image.analyze rpcCall handler which resolves the
 * source to a Buffer and calls the ImageAnalysisPort adapter.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const ImageToolParams = Type.Object({
  action: Type.Literal("analyze", {
    description: "The image action to perform",
  }),
  source_type: Type.Optional(
    Type.Union(
      [
        Type.Literal("file"),
        Type.Literal("url"),
        Type.Literal("base64"),
      ],
      { description: "How the image source is provided (required unless attachment_url is used)" },
    ),
  ),
  source: Type.Optional(
    Type.String({
      description: "File path, URL, or base64-encoded image data (required unless attachment_url is used)",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Analysis prompt (default: describe the image)",
    }),
  ),
  mime_type: Type.Optional(
    Type.String({
      description: "MIME type for base64 input (auto-detected if omitted)",
    }),
  ),
  attachment_url: Type.Optional(
    Type.String({
      description: "Platform attachment URL from a message hint (tg-file://, discord://, etc.). When provided, overrides source_type/source for attachment-based images.",
    }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create an image analysis tool that delegates to image.analyze rpcCall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing image_analyze
 */
export function createImageTool(rpcCall: RpcCall): AgentTool<typeof ImageToolParams> {
  return {
    name: "image_analyze",
    label: "Image Analysis",
    description:
      "Analyze images using vision AI. Accepts file paths, URLs, base64-encoded data, or an attachment_url from a message hint. Returns a text description of the image content.",
    parameters: ImageToolParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const sourceType = readStringParam(p, "source_type", false);
        const source = readStringParam(p, "source", false);
        const prompt = readStringParam(p, "prompt", false);
        const mimeType = readStringParam(p, "mime_type", false);
        const attachmentUrl = readStringParam(p, "attachment_url", false);

        const result = await rpcCall("image.analyze", {
          source_type: sourceType,
          source,
          prompt: prompt ?? "Describe this image in detail",
          mime_type: mimeType,
          ...(attachmentUrl && { attachment_url: attachmentUrl }),
        });

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
