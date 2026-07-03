// SPDX-License-Identifier: Apache-2.0
/**
 * Anti-drift regression: each memory-job config default must match its
 * DOCUMENTED intent, so a schema default and the prose describing it can never
 * silently diverge again.
 *
 * Why this exists (the live incident it prevents): the cost-job schemas
 * declare `enabled: z.boolean().default(true)` (opt-OUT — registered when the
 * master switch is on), yet their module headers once said "OFF by default",
 * and `score.ts`'s FadeMem JSDoc said `rag.forget` was "default-OFF" while
 * `rag.forget.enabled` actually defaults `true`. That stale-comment drift made
 * live features look dormant.
 *
 * This test pins the GROUND TRUTH (the schema), so:
 *  - if a future edit FLIPS a default (e.g. someone "fixes" a cost job to OFF),
 *    it fails loudly here, and
 *  - the reconciled comments (default ON, gated only by the master cost switch
 *    `memory.costFeatures.enabled`) can never re-drift from the schema unnoticed.
 *
 * The REAL gate is NOT the per-feature `enabled`; it is the master kill switch
 * `memory.enabled` (default `true` = opt-out), applied at each cron's
 * registration site in setup-schedulers.ts. The per-feature `enabled: true` means
 * "registered WHEN the master switch is on" — turning the master switch off
 * force-disables all six regardless of the per-feature flag.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { MemoryReviewConfigSchema } from "./schema-memory-review.js";
import { LearningOutcomeConfigSchema } from "./schema-learning-outcome.js";
import { MemoryConfigSchema } from "./schema-memory.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("memory-job config defaults match documented intent (anti-drift)", () => {
  // The cost-job schemas default ON (opt-out) — the master switch is the gate,
  // NOT the per-feature flag. A header claiming "OFF by default" is the lie this pins.
  // (memory-review is the sole cost cron.)
  const costJobSchemas = [
    ["MemoryReviewConfigSchema", MemoryReviewConfigSchema],
  ] as const;

  for (const [name, schema] of costJobSchemas) {
    it(`defaults ${name}.enabled to true (opt-out — gated by the master cost switch, NOT off-by-default)`, () => {
      const parsed = schema.parse({});
      expect(parsed.enabled, `${name} must default ON (opt-out posture); the master switch is the real gate`).toBe(true);
    });
  }

  it("names memory.enabled as the REAL gate (default true = opt-out), not the per-feature flag", () => {
    // The master kill switch is memory.enabled — its default-true (opt-out) posture is what
    // makes the cost jobs "registered by default"; flipping it OFF force-disables them all
    // at the cron registration site. The
    // per-feature `enabled: true` only governs "registered WHEN the master switch is on", so this
    // is the default that the reconciled comments cite.
    const memory = MemoryConfigSchema.parse({});
    expect(memory.enabled, "the master cost-feature switch defaults ON (opt-out)").toBe(true);
  });

  it("defaults the Verified-Learning features ON (opt-out) — no lone OFF feature; the master kill switch is the gate", () => {
    // The Verified-Learning loop is opt-out (default ON), so it works out of
    // the box. learningOutcome defaults ON like every cost job. The REAL gate is
    // the master kill switch `memory.enabled` (default true);
    // flipping it OFF force-disables the whole loop at the cron registration site.
    expect(LearningOutcomeConfigSchema.parse({}).enabled, "learningOutcome defaults ON (opt-out), gated by the master switch").toBe(true);
  });

  it("pins rag.forget.enabled to true — the schema default any FadeMem prose must match", () => {
    // The schema defaults FadeMem ON. The
    // byte-identity FadeMem rests on is event-age Δt=0 (factor 1.0), NOT an off-by-default
    // gate. A bare config gets `rag.forget.enabled === true`.
    const agent = PerAgentConfigSchema.parse({});
    expect(agent.rag.forget.enabled, "rag.forget defaults ON; FadeMem byte-identity is at Δt=0, not off-by-default").toBe(true);
  });
});
