// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-01 Stage-A — self-registering STORY_LIBRARY (mirrors platform-tools/registry.ts).
 *
 * Registration is the single validation choke point: registerStory zod-parses,
 * de-dupes by id (throws on a duplicate — the parity contract), and pushes.
 * getStories returns a COPY so callers cannot corrupt the library.
 *
 * NOTE (wave ordering): the 8 seed stories self-register at module load via
 * registry.ts's seed imports (Wave 2). This Wave-1 file uses __test__-prefixed
 * synthetic ids so it never collides with the seeds; seed-count assertions and
 * the open/closed test land in Wave 2.
 *
 * TDD: fails until registry.ts exists.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { registerStory, getStories, getStory } from "./registry.js";
import type { UserStory } from "./types.js";

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
