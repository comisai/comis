// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/skills.ts`.
 *
 * Asserts shape + identity parity with the `@comis/skills` barrel: the
 * mirror exports the same key set, the sentinel `createSkillRegistry` is
 * a function, and the mirror re-export is identity-equal (`===`) to the
 * direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorSkills from "./skills.js";
import * as directSkills from "@comis/skills";

describe("comisai/skills mirror file — shape parity with @comis/skills barrel", () => {
  it("exports an identical key set as the @comis/skills direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorSkills).sort();
    const directKeys = Object.keys(directSkills).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createSkillRegistry as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorSkills as Record<string, unknown>).createSkillRegistry).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createSkillRegistry === @comis/skills.createSkillRegistry", () => {
    expect((mirrorSkills as Record<string, unknown>).createSkillRegistry).toBe(
      (directSkills as Record<string, unknown>).createSkillRegistry,
    );
  });
});
