// SPDX-License-Identifier: Apache-2.0
/**
 * US-08 / J8 — Cross-channel / broadcast.
 *
 * Flow: message in one channel → agent acts → delivers to a broadcast group.
 * Subsystems composed: A core-loop, B LLM, K channels, S broadcast/delivery,
 * I multi-agent.
 *
 * Gated behind CHAN Stage-C cert + a real broadcast group
 * (`channelAccounts:["broadcast-group"]`). In sandbox: shape validated +
 * requires-skip (no broadcast group); the real fan-out runs at Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-08-CROSS-CHANNEL-BROADCAST",
  story:
    "As a community manager, I want a single message to fan out to a broadcast group " +
    "across channels after the agent acts, so that one instruction reaches every target.",
  tags: ["A", "B", "K", "S", "I"],
  dimensions: [],
  requires: {
    providers: ["anthropic"],
    channelAccounts: ["broadcast-group"],
    components: ["CHAN-StageC"],
  },
  costTier: "¢",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    { verb: "send_text", text: "Notify the broadcast group that the deploy is complete." },
    { verb: "wait_reply" },
    { verb: "expect_delivered" },
    {
      verb: "judge",
      rubric: "The message fanned out and was delivered to all broadcast targets.",
      question: "Did the broadcast fan-out reach all targets?",
    },
  ],
  acceptance: {
    outcomes: ["fan-out delivered to all targets"],
    rubric: "the cross-channel/broadcast goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
