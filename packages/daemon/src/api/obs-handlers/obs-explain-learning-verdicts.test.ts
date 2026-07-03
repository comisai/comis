// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit coverage for the learning-verdict predicates in
 * `obs-explain-learning-verdicts.ts` (`learnedSkillFailingVerdict` +
 * `synthesisAbstainedVerdict`). Both are BENIGN, rank below every acute cause, and
 * return `null` on an absent learning block so the frozen obs-explain fixtures
 * cannot regress.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import {
  learnedSkillFailingVerdict,
  synthesisAbstainedVerdict,
} from "./obs-explain-learning-verdicts.js";

/** A minimal learning signal with the skill fields zeroed unless overridden. */
function learning(overrides: Partial<NonNullable<IncidentSignals["learning"]>> = {}): IncidentSignals {
  return {
    learning: {
      outcomeResolved: true,
      sources: [],
      skillsUsed: [],
      skillFailures: [],
      synthesisAbstained: false,
      ...overrides,
    },
  } as IncidentSignals;
}

describe("synthesisAbstainedVerdict (BENIGN reflection-abstain verdict)", () => {
  it("returns null when the learning block is absent / not abstained (no fixture regression)", () => {
    expect(synthesisAbstainedVerdict({} as IncidentSignals)).toBeNull();
    expect(synthesisAbstainedVerdict(learning())).toBeNull();
  });

  it("fires with code 'synthesis_abstained_low_capability' when synthesisAbstained is true", () => {
    const v = synthesisAbstainedVerdict(learning({ synthesisAbstained: true }));
    expect(v).not.toBeNull();
    expect(v!.code).toBe("synthesis_abstained_low_capability");
    expect(v!.detail).toMatch(/reflection abstained/i); // the detail names the reflection engine
    expect(v!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("learnedSkillFailingVerdict returns null on a non-failing learning signal", () => {
    expect(learnedSkillFailingVerdict(learning())).toBeNull();
    expect(learnedSkillFailingVerdict(learning({ skillFailures: ["flaky"] }))).not.toBeNull();
  });
});
