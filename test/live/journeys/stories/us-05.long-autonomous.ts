// SPDX-License-Identifier: Apache-2.0
/**
 * US-05 / J5 — Long autonomous task (compaction + expansion + memory).
 *
 * Flow: a goal spanning a long multi-turn → background tasks + DAG/LCD
 * compaction + in-session expansion + memory. Subsystems composed: A core-loop,
 * B LLM, D context-engine (compact+expand), E memory, F tools.
 *
 * Gated behind CTX + MEM Stage-C certs. The `context:dag_compacted` /
 * `compaction:started` events ARE in the harness subscribed set (assertable at
 * Stage-D). In sandbox: shape validated + requires-skip; the real long run is Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-05-LONG-AUTONOMOUS",
  story:
    "As a user with a big task, I want the agent to stay coherent across a long " +
    "conversation by compacting old context and expanding detail when needed, so that " +
    "the goal is achieved without losing the thread.",
  tags: ["A", "B", "D", "E", "F"],
  dimensions: ["contextEngine.contextThreshold=high", "memory.costFeatures.enabled=true"],
  requires: {
    providers: ["anthropic"],
    capabilities: ["tools"],
    components: ["CTX-StageC", "MEM-StageC"],
  },
  costTier: "$",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    { verb: "send_text", text: "Start a multi-part plan: step 1, outline the approach." },
    { verb: "wait_reply" },
    { verb: "send_text", text: "Step 2, expand each section with detail." },
    { verb: "wait_reply" },
    { verb: "send_text", text: "Step 3, keep going — add more sections until the context compacts." },
    { verb: "wait_reply" },
    // compaction:started is in the harness subscribed set — asserted at Stage-D.
    { verb: "expect_event", name: "compaction:started" },
    { verb: "send_text", text: "Now recall the exact detail from the first section." },
    { verb: "wait_reply" },
    {
      verb: "judge",
      rubric:
        "The goal was achieved, context stayed coherent under compaction, and expansion " +
        "recovered the early detail accurately.",
      question: "Did the long autonomous task stay coherent under compaction + expansion?",
    },
  ],
  acceptance: {
    outcomes: [
      "goal achieved",
      "context stayed coherent under compaction",
      "expansion recovered detail",
    ],
    rubric: "the long-autonomous compaction+expansion+memory goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
