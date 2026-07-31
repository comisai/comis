// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { boundedUnavailableSkills } from "./translate-skill-availability.js";

describe("boundedUnavailableSkills", () => {
  it("keeps only bounded name and reason facts", () => {
    expect(boundedUnavailableSkills([
      { name: "voice", reason: "missing credential", description: "private detail" },
      { name: 42, reason: "invalid" },
    ])).toEqual([{ name: "voice", reason: "missing credential" }]);
  });

  it("limits persisted unavailable skill entries", () => {
    const input = Array.from({ length: 30 }, (_, index) => ({
      name: `skill-${index}`,
      reason: "missing requirement",
    }));
    expect(boundedUnavailableSkills(input)).toHaveLength(25);
  });
});
