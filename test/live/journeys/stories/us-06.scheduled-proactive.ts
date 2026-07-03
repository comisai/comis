// SPDX-License-Identifier: Apache-2.0
/**
 * US-06 / J6 — Scheduled / proactive.
 *
 * Flow: cron/heartbeat fires → agent does real work → proactive delivery.
 * Subsystems composed: A core-loop, B LLM, R scheduler, F tools, S proactive delivery.
 *
 * Gated behind PLAT Stage-C cert (the real-LLM-turn-from-cron). The scheduled
 * fire is daemon-orchestrated, so the SHAPE describes the proactive delivery
 * (expect_delivered) rather than a synthetic scheduler step verb (no such verb is
 * invented). In sandbox: shape validated + requires-skip; the real cron fire is Stage-D.
 *
 * @module
 */
import { registerStory } from "../registry-core.js";

registerStory({
  id: "US-06-SCHEDULED-PROACTIVE",
  story:
    "As a user, I want a scheduled job to fire, do real work, and proactively deliver a " +
    "result without my prompting, so that the agent acts on a timer on my behalf.",
  tags: ["A", "B", "R", "F", "S"],
  dimensions: [],
  requires: {
    providers: ["anthropic"],
    components: ["PLAT-StageC"],
  },
  costTier: "¢",
  determinism: { runs: 5, passRateThreshold: 0.8 },
  steps: [
    // The scheduled fire is daemon-orchestrated at Stage-D; the journey asserts the
    // proactive delivery that results (no scheduler step verb is invented).
    { verb: "expect_delivered" },
    {
      verb: "judge",
      rubric: "A scheduled turn fired and proactively delivered a real, correct result.",
      question: "Did the scheduled/proactive turn fire and deliver?",
    },
  ],
  acceptance: {
    outcomes: ["scheduled turn fires and delivers a real result"],
    rubric: "the scheduled/proactive delivery goal is achieved",
    expectStitchedTraceId: true,
  },
  status: "active",
});
