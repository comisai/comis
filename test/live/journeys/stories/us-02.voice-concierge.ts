// SPDX-License-Identifier: Apache-2.0
/**
 * US-02 / J2 — Voice concierge (STT → tool/MCP action → TTS voice reply).
 *
 * Flow: WhatsApp voice note → STT → tool/MCP action → TTS voice reply.
 * Subsystems composed: A core-loop, B LLM, L voice (STT+TTS), F tools, G MCP,
 * S delivery.
 *
 * Gated behind MEDIA Stage-C cert. In sandbox: shape validated + requires-skip
 * (no STT/TTS keys); the real voice round-trip runs at Stage-D. Runs on echo (no
 * WhatsApp account) or a real channel when credentialed — authored once.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-02-VOICE-CONCIERGE",
  story:
    "As a hands-busy user, I want to send a voice note and get a spoken reply after " +
    "the agent takes an action, so that I can operate the assistant entirely by voice.",
  tags: ["A", "B", "L", "F", "G", "S"],
  dimensions: ["transcription.provider=openai", "tts.provider=openai"],
  requires: {
    providers: ["openai"],
    capabilities: ["tools"],
    components: ["MEDIA-StageC"],
  },
  costTier: "¢",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    // A tiny base64 audio placeholder — the real STT runs at Stage-D.
    { verb: "send_voice", audioBase64: "QUFBQQ==", mimeType: "audio/ogg" },
    { verb: "wait_reply" },
    {
      verb: "judge",
      rubric:
        "The voice note was transcribed correctly, the right tool/MCP action was taken, " +
        "and a playable voice reply was returned.",
      question: "Did the voice concierge complete the spoken request end-to-end?",
    },
  ],
  acceptance: {
    outcomes: ["correct transcript", "correct tool/MCP action", "playable voice reply"],
    rubric: "the voice-in → action → voice-out concierge goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
