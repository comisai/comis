// SPDX-License-Identifier: Apache-2.0
/**
 * Video description platform tool: generate text descriptions of video attachments.
 *
 * Accepts an attachment URL from the message hint and an optional analysis
 * prompt. Delegates to the daemon-side media.describe_video rpcCall handler
 * which resolves the attachment and calls the vision analysis pipeline.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const DescribeVideoToolParams = Type.Object({
  attachment_url: Type.String({
    description: "The attachment URL from the message hint (e.g. tg-file://..., discord://...)",
  }),
  prompt: Type.Optional(
    Type.String({
      description: "Custom analysis prompt to guide the video description",
    }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a video description tool that delegates to media.describe_video rpcCall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing describe_video
 */
export function createDescribeVideoTool(rpcCall: RpcCall): AgentTool<typeof DescribeVideoToolParams> {
  return {
    name: "describe_video",
    label: "Video Description",
    description:
      "Generate a text description of a video attachment. Pass the attachment_url from the message hint. Optionally provide a custom analysis prompt.",
    parameters: DescribeVideoToolParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const attachmentUrl = readStringParam(p, "attachment_url");
        const prompt = readStringParam(p, "prompt", false);

        const result = await rpcCall("media.describe_video", {
          attachment_url: attachmentUrl,
          prompt,
        });

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
