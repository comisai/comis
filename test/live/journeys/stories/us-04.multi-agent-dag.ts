// SPDX-License-Identifier: Apache-2.0
/**
 * US-04 / J4 — Multi-agent / DAG pipeline.
 *
 * Flow: Slack request → route → subagent DAG (fetch→analyze→report) →
 * aggregate → reply. Subsystems composed: A core-loop, B LLM, H subagents/DAG,
 * I multi-agent/routing, F tools, S delivery.
 *
 * Gated behind ORCH Stage-C cert. The `graph:completed` expect_event IS in
 * the conversation-harness subscribed set (so a Stage-D run can assert it). In
 * sandbox: shape validated + requires-skip; the real DAG runs at Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-04-MULTI-AGENT-DAG",
  story:
    "As an analyst, I want a request to fan out to a subagent DAG (fetch → analyze → " +
    "report) and aggregate, so that complex work is decomposed and recombined correctly.",
  tags: ["A", "B", "H", "I", "F", "S"],
  dimensions: ["routing.bindingSpecificity=channel", "agentToAgent.graphMaxConcurrency=2"],
  requires: {
    providers: ["anthropic"],
    capabilities: ["tools"],
    components: ["ORCH-StageC"],
  },
  costTier: "¢",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    {
      verb: "send_text",
      text: "Fetch the latest figures, analyze the trend, and write a short report.",
    },
    { verb: "wait_reply" },
    // graph:completed is in the harness subscribed set — asserted at Stage-D.
    { verb: "expect_event", name: "graph:completed" },
    {
      verb: "judge",
      rubric:
        "The DAG nodes ran in dependency order (fetch before analyze before report) " +
        "and the aggregated answer is correct.",
      question: "Did the multi-agent DAG execute in order and aggregate correctly?",
    },
  ],
  acceptance: {
    outcomes: ["nodes run in dependency order", "aggregated answer correct"],
    rubric: "the multi-agent/DAG-pipeline goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
