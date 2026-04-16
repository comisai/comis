/**
 * Text-to-speech platform tool: generate speech audio from text.
 *
 * Delegates to the daemon-side tts.synthesize rpcCall handler which
 * calls the TTSPort adapter and writes the audio to a file in the
 * workspace media/tts/ directory.
 *
 * @module
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "./tool-helpers.js";
import type { RpcCall } from "./cron-tool.js";

// ── Parameter Schema ────────────────────────────────────────────────

const TTSToolParams = Type.Object({
  action: Type.Literal("synthesize", {
    description: "The TTS action to perform",
  }),
  text: Type.String({
    description: "Text to convert to speech",
  }),
  voice: Type.Optional(
    Type.String({
      description: "Voice identifier (provider-specific)",
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Audio format: mp3, opus, wav (default: from config)",
    }),
  ),
});

// ── Factory ─────────────────────────────────────────────────────────

/**
 * Create a TTS tool that delegates to tts.synthesize rpcCall.
 *
 * @param rpcCall - RPC function for daemon communication
 * @returns AgentTool implementing tts_synthesize
 */
export function createTTSTool(rpcCall: RpcCall): AgentTool<typeof TTSToolParams> {
  return {
    name: "tts_synthesize",
    label: "Text-to-Speech",
    description:
      "Generate speech audio from text. Returns a file path to the audio file that can be sent as an attachment via the message tool.",
    parameters: TTSToolParams,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const p = params as unknown as Record<string, unknown>;
        const text = readStringParam(p, "text");
        const voice = readStringParam(p, "voice", false);
        const format = readStringParam(p, "format", false);

        const result = await rpcCall("tts.synthesize", {
          text,
          voice,
          format,
        });

        return jsonResult(result);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[")) throw err;
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
  };
}
