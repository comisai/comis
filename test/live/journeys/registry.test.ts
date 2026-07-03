// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 Stage-A — self-registering STORY_LIBRARY (mirrors platform-tools/registry.ts).
 *
 * Registration is the single validation choke point: registerStory zod-parses,
 * de-dupes by id (throws on a duplicate — the parity contract), and pushes.
 * getStories returns a COPY so callers cannot corrupt the library.
 *
 * NOTE (id collision): the 8 seed stories self-register at module load via
 * registry.ts's seed imports. The synthetic cases here use __test__-prefixed
 * ids so they never collide with the seeds.
 *
 * TDD: fails until registry.ts exists.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  registerStory,
  getStories,
  getStory,
  storyCoverageContributions,
} from "./registry.js";
import { runJourney } from "./journey-runner.js";
import { buildCredentialRegistry } from "../credentials.js";
import type { UserStory } from "./types.js";

const SEED_IDS = [
  "US-01-RESEARCH-RECALL",
  "US-02-VOICE-CONCIERGE",
  "US-03-MULTIMODAL",
  "US-04-MULTI-AGENT-DAG",
  "US-05-LONG-AUTONOMOUS",
  "US-06-SCHEDULED-PROACTIVE",
  "US-07-TERMINAL-DRIVEN",
  "US-08-CROSS-CHANNEL-BROADCAST",
];

function synthetic(id: string): UserStory {
  return {
    id,
    story: `As a tester, I want ${id}, so that registration is proven.`,
    tags: ["A"],
    dimensions: [],
    requires: {},
    costTier: "$0",
    determinism: { runs: 1, passRateThreshold: 1 },
    steps: [{ verb: "send_text", text: "hi" }],
    acceptance: { outcomes: [], rubric: "non-empty" },
    status: "active",
  };
}

describe("STORY_LIBRARY self-registration", () => {
  it("registerStory adds a story that getStories/getStory then return", () => {
    const id = "__test__reg-basic";
    const before = getStories().length;
    registerStory(synthetic(id));
    expect(getStories().length).toBe(before + 1);
    expect(getStory(id)?.id).toBe(id);
  });

  it("registerStory throws on a duplicate id (the parity de-dupe contract)", () => {
    const id = "__test__reg-dupe";
    registerStory(synthetic(id));
    expect(() => registerStory(synthetic(id))).toThrow(/duplicate story id/i);
  });

  it("registerStory throws (zod) on a malformed story — registration is the validation choke point", () => {
    const malformed = { id: "__test__reg-bad", tags: ["Z"] } as unknown as UserStory;
    expect(() => registerStory(malformed)).toThrow();
  });

  it("getStories returns a copy — mutating it does not corrupt the library", () => {
    const arr = getStories() as UserStory[];
    const len = arr.length;
    arr.push(synthetic("__test__reg-leak"));
    // The next getStories() call must NOT reflect the external push.
    expect(getStories().length).toBe(len);
    expect(getStory("__test__reg-leak")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Seed stories US-01..08 self-register (E2E-04)
// ---------------------------------------------------------------------------

describe("seed stories US-01..08 self-register + zod-validate", () => {
  it("at least 8 stories are registered (the seed library)", () => {
    expect(getStories().length).toBeGreaterThanOrEqual(8);
  });

  it("every seed id is present", () => {
    for (const id of SEED_IDS) {
      expect(getStory(id), `seed ${id} should be registered`).toBeDefined();
    }
  });

  it("every seed has well-formed tags (Cat A–V), dimensions, requires, steps, acceptance", () => {
    for (const id of SEED_IDS) {
      const s = getStory(id)!;
      expect(s.tags.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(s.dimensions)).toBe(true);
      expect(s.steps.length).toBeGreaterThanOrEqual(1);
      expect(s.acceptance.outcomes).toBeDefined();
      expect(typeof s.acceptance.rubric).toBe("string");
      // every seed composes >=3 real subsystems (the ">=3 subsystems" rule)
      expect(s.tags.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("US-07 (terminal-driven) carries requires.platform 'linux' (the J7 OS gate)", () => {
    expect(getStory("US-07-TERMINAL-DRIVEN")!.requires.platform).toBe("linux");
  });
});

// ---------------------------------------------------------------------------
// THE open/closed zero-harness-change extensibility test (E2E-01 — HARD requirement)
// ---------------------------------------------------------------------------

describe("open/closed: adding a story = registerStory ALONE — zero harness change", () => {
  it("a synthetic story auto-joins the library + the coverage view + the run grid with NO runner/steps/types edit", async () => {
    // Snapshot before.
    const before = getStories().length;
    const cov0 = storyCoverageContributions().length;

    // A SYNTHETIC story defined INLINE (not a new spec file, not a runner branch) —
    // proving a story is pure DATA flowed through registerStory alone.
    const synthId = "__openclosed__synthetic";
    const syntheticStory: UserStory = {
      id: synthId,
      story: "As a maintainer, I want to add a story with zero harness change, so that open/closed holds.",
      tags: ["A", "P"],
      dimensions: ["synthetic.dim=x"],
      requires: {},
      costTier: "$0",
      determinism: { runs: 1, passRateThreshold: 1 },
      steps: [{ verb: "send_text", text: "x" }],
      acceptance: { outcomes: [], rubric: "x" },
      status: "active",
    };

    registerStory(syntheticStory);

    // 1. it joined the LIBRARY.
    expect(getStories().length).toBe(before + 1);
    expect(getStory(synthId)).toBeDefined();

    // 2. it AUTO-JOINED the coverage view (auto-wiring — no code change).
    const cov = storyCoverageContributions();
    expect(cov.length).toBe(cov0 + 1);
    const synthCov = cov.find((c) => c.storyId === synthId)!;
    expect(synthCov.tags).toEqual(["A", "P"]);
    expect(synthCov.dimensions).toEqual(["synthetic.dim=x"]);

    // 3. it JOINED the RUN GRID — the GENERIC runner interpreted it by data alone
    //    (no per-story branch). With requires:{} + no driver it resolves a skip
    //    ("no driver bound"); the POINT is the runner HANDLED it generically.
    const r = await runJourney(syntheticStory, { creds: buildCredentialRegistry(), isLive: false });
    expect(r.storyId).toBe(synthId);
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/no driver|shape-only/i);

    // 4. ZERO-HARNESS-CHANGE CONTRACT: this story was added via registerStory ALONE.
    //    No edit was made to journey-runner.ts, steps.ts, or types.ts to support it.
    //    The synthetic uses a "__" prefix so it never enters the real run grid
    //    (activeStoriesForRun filters "__"-prefixed ids — see lifecycle wiring).
  });
});
