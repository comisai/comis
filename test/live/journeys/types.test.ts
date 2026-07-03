// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 / E2E-04 Stage-A — zod UserStory schema validation.
 *
 * The schema IS the executable acceptance spec: a malformed story REJECTS
 * at parse; a well-formed story parses. These are pure-function zod assertions —
 * no daemon, no provider, zero cost. TDD: fails until types.ts exists.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  UserStorySchema,
  CategoryTagSchema,
  JourneyStepSchema,
  DeterminismSchema,
  type UserStory,
} from "./types.js";
import type { Capability } from "../credentials.js";

// ---------------------------------------------------------------------------
// A minimal valid story used as the positive baseline.
// ---------------------------------------------------------------------------

const validMinimal: UserStory = {
  id: "US-TEST-MIN",
  story: "As a tester, I want a minimal story, so that the schema accepts it.",
  tags: ["A"],
  dimensions: [],
  requires: {},
  costTier: "$0",
  determinism: { runs: 3, passRateThreshold: 0.9 },
  steps: [{ verb: "send_text", text: "hi" }],
  acceptance: { outcomes: [], rubric: "the reply is non-empty" },
  status: "active",
};

describe("UserStorySchema — positive", () => {
  it("accepts a minimal well-formed story", () => {
    const r = UserStorySchema.safeParse(validMinimal);
    expect(r.success).toBe(true);
  });

  it("accepts a fully-populated story (all optional fields + every verb)", () => {
    const full: UserStory = {
      id: "US-TEST-FULL",
      story: "As a power user, I want everything, so that all fields validate.",
      tags: ["A", "B", "N", "E", "T", "V"],
      dimensions: ["search=tavily", "contextEngine.version=dag"],
      requires: {
        providers: ["anthropic"],
        capabilities: ["tools", "vision"],
        platform: "linux",
        channelAccounts: ["broadcast-group"],
        components: ["MEM-StageC"],
        seed: { note: "pre-store a memory" },
      },
      profile: "lean-cloud",
      costTier: "$$",
      determinism: { runs: 10, passRateThreshold: 0.95, models: ["claude", "gpt"] },
      steps: [
        { verb: "send_text", text: "research X" },
        { verb: "send_voice", audioBase64: "AAA", mimeType: "audio/ogg" },
        { verb: "send_image", imageBase64: "AAA", mimeType: "image/jpeg" },
        { verb: "upload_doc", docBase64: "AAA", mimeType: "application/pdf", filename: "a.pdf" },
        { verb: "new_session" },
        { verb: "wait_reply", containsAny: ["X"] },
        { verb: "expect_event", name: "graph:completed", payload: { graphId: "g1" } },
        { verb: "expect_delivered", containsAny: ["done"] },
        { verb: "expect_memory_recalled", query: "what about X", mustRecall: ["X"] },
        { verb: "expect_file", path: "report.md" },
        { verb: "expect_image" },
        { verb: "judge", rubric: "the goal was achieved", question: "did it work?" },
      ],
      acceptance: {
        outcomes: ["goal achieved", "memory recalled"],
        rubric: "the journey achieves the user goal",
        expectStitchedTraceId: true,
        minBillingTokens: 10,
      },
      status: "quarantined",
    };
    const r = UserStorySchema.safeParse(full);
    expect(r.success).toBe(true);
  });
});

describe("UserStorySchema — negative (the executable acceptance spec rejects malformed)", () => {
  it("rejects an out-of-enum costTier and names the field path", () => {
    const bad = { ...validMinimal, costTier: "free" };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("costTier"))).toBe(true);
    }
  });

  it("rejects an unknown step verb (discriminated union)", () => {
    const bad = { ...validMinimal, steps: [{ verb: "teleport", to: "moon" }] };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects a missing acceptance block", () => {
    const { acceptance: _drop, ...rest } = validMinimal;
    const r = UserStorySchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it("rejects an out-of-enum status", () => {
    const bad = { ...validMinimal, status: "retired" };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects a CategoryTag outside A..V", () => {
    const bad = { ...validMinimal, tags: ["Z"] };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects an empty tags array (a journey must touch >=1 subsystem)", () => {
    const bad = { ...validMinimal, tags: [] };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects an empty steps array", () => {
    const bad = { ...validMinimal, steps: [] };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects a passRateThreshold outside [0,1]", () => {
    const bad = { ...validMinimal, determinism: { runs: 3, passRateThreshold: 1.5 } };
    const r = UserStorySchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe("schema building blocks", () => {
  it("CategoryTagSchema accepts A and V, rejects Z", () => {
    expect(CategoryTagSchema.safeParse("A").success).toBe(true);
    expect(CategoryTagSchema.safeParse("V").success).toBe(true);
    expect(CategoryTagSchema.safeParse("Z").success).toBe(false);
  });

  it("JourneyStepSchema accepts a known verb and rejects an unknown one", () => {
    expect(JourneyStepSchema.safeParse({ verb: "new_session" }).success).toBe(true);
    expect(JourneyStepSchema.safeParse({ verb: "nope" }).success).toBe(false);
  });

  it("DeterminismSchema requires a positive integer runs", () => {
    expect(DeterminismSchema.safeParse({ runs: 5, passRateThreshold: 0.8 }).success).toBe(true);
    expect(DeterminismSchema.safeParse({ runs: 0, passRateThreshold: 0.8 }).success).toBe(false);
    expect(DeterminismSchema.safeParse({ runs: 2.5, passRateThreshold: 0.8 }).success).toBe(false);
  });

  it("the Capability schema enum matches the rig Capability union members (no drift)", () => {
    // Compile-time + runtime coherence: a value typed as the rig Capability must
    // parse through CapabilitySchema (imported indirectly via the requires schema).
    const caps: Capability[] = ["vision", "tools", "structured-output", "thinking"];
    for (const c of caps) {
      const r = UserStorySchema.safeParse({ ...validMinimal, requires: { capabilities: [c] } });
      expect(r.success).toBe(true);
    }
    // a non-capability string is rejected
    const r = UserStorySchema.safeParse({ ...validMinimal, requires: { capabilities: ["telepathy"] } });
    expect(r.success).toBe(false);
  });
});
