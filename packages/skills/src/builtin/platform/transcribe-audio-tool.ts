/**
 * Audio transcription platform tool: transcribe audio/voice attachments to text.
 *
 * Accepts an attachment URL from the message hint and an optional BCP-47
 * language hint. Delegates to the daemon-side media.transcribe rpcCall
 * handler which resolves the attachment and calls the TranscriptionPort adapter.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const TranscribeAudioToolParams = Type.Object({
  attachment_url: Type.String({
    description: "The attachment URL from the message hint (e.g. tg-file://..., discord://...)",
  }),
  language: Type.Optional(
    Type.String({
      description: "BCP-47 language hint to improve transcription accuracy (e.g. 'en', 'he', 'es')",
    }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create an audio transcription tool that delegates to media.transcribe rpcCall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing transcribe_audio
 */
export function createTranscribeAudioTool(rpcCall: RpcCall): AgentTool<typeof TranscribeAudioToolParams> {
  return {
    name: "transcribe_audio",
    label: "Audio Transcription",
    description:
      "Transcribe an audio or voice attachment to text. Pass the attachment_url from the message hint. Optionally specify a BCP-47 language hint (e.g. 'en', 'he') to improve accuracy.",
    parameters: TranscribeAudioToolParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const attachmentUrl = readStringParam(p, "attachment_url");
        const language = readStringParam(p, "language", false);

        const result = await rpcCall("media.transcribe", {
          attachment_url: attachmentUrl,
          language,
        });

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
