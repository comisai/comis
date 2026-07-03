// SPDX-License-Identifier: Apache-2.0
/**
 * US-03 / J3 — Multimodal (image-in → vision analysis → image-gen → out).
 *
 * Flow: Discord image upload → vision analysis → image-gen response → deliver.
 * Subsystems composed: A core-loop, B LLM, M vision+image-gen, S delivery.
 *
 * Gated behind MEDIA Stage-C cert. In sandbox: shape validated + requires-skip
 * (no vision/image-gen keys); the real vision→image-gen round-trip runs at Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-03-MULTIMODAL",
  story:
    "As a creative user, I want to upload an image, have the agent analyze it, and get " +
    "a newly generated related image back, so that I can iterate visually in chat.",
  tags: ["A", "B", "M", "S"],
  dimensions: ["vision.providers=openai", "image-gen=openai"],
  requires: {
    providers: ["openai"],
    capabilities: ["vision"],
    components: ["MEDIA-StageC"],
  },
  costTier: "$",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    // A tiny base64 image placeholder — the real vision analysis runs at Stage-D.
    { verb: "send_image", imageBase64: "QUFBQQ==", mimeType: "image/jpeg" },
    { verb: "wait_reply" },
    { verb: "send_text", text: "Now draw a related image in the same style." },
    { verb: "wait_reply" },
    { verb: "expect_image" },
    {
      verb: "judge",
      rubric: "The image analysis was correct and a generated image was delivered.",
      question: "Did the multimodal in→out flow analyze and generate correctly?",
    },
  ],
  acceptance: {
    outcomes: ["analysis correct", "generated image delivered"],
    rubric: "the image-in → vision → image-gen → out goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
