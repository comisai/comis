// SPDX-License-Identifier: Apache-2.0
/**
 * US-01 / J1 — Research assistant (cross-session research + recall).
 *
 * Flow: channel text → web search (Brave/Tavily) → read links → synthesize →
 * STORE memory → reply; *later session*: "what did you find about X?" → recall.
 * Subsystems composed: A core-loop, B LLM, N search/web, E memory(store+recall),
 * J session/cross-session, S delivery.
 *
 * Gated behind WEB + MEM Stage-C certs. In sandbox: shape validated +
 * requires-skip; the real-model cross-session recall runs at Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-01-RESEARCH-RECALL",
  story:
    "As a researcher, I want the agent to research a topic, remember the finding, " +
    "and recall it in a later session, so that my knowledge persists across conversations.",
  tags: ["A", "B", "N", "E", "J", "S"],
  dimensions: ["search=tavily", "contextEngine.version=dag"],
  requires: {
    providers: ["anthropic"],
    capabilities: ["tools"],
    components: ["WEB-StageC", "MEM-StageC"],
  },
  costTier: "¢",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    { verb: "send_text", text: "Research the capital of Australia and remember the answer." },
    { verb: "wait_reply" },
    { verb: "new_session" },
    { verb: "send_text", text: "What did you find about the capital of Australia?" },
    { verb: "wait_reply", containsAny: ["Canberra"] },
    {
      verb: "judge",
      rubric:
        "The later session recalls the stored fact (the capital of Australia is Canberra), " +
        "grounded in the earlier real search results.",
      question: "Did the later session correctly recall the researched fact?",
    },
  ],
  acceptance: {
    outcomes: [
      "reply grounded in real search results",
      "the later session recalls the stored fact",
    ],
    rubric: "the cross-session research-and-recall goal is achieved",
    expectStitchedTraceId: true,
    minBillingTokens: 1,
  },
  status: "active",
});
