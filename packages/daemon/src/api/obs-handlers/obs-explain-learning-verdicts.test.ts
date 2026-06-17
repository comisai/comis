// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02 (Phase 203 Plan 05): the BENIGN `user_model_revised` verdict predicate.
 *
 * Co-located unit coverage for the learning-verdict predicates in
 * `obs-explain-learning-verdicts.ts`. The Phase-203 addition is a BENIGN verdict
 * that fires when `IncidentSignals.learning.userModelRevised > 0` — the user
 * model was revised this session — and ranks BELOW `outcome_unresolved` and
 * every acute cause (mirrors `synthesisAbstainedVerdict`'s benign ordering;
 * `Defer ≠ Retry`). It returns `null` on an absent learning block / zero count so
 * the frozen obs-explain fixtures (which carry none) cannot regress.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import {
  learnedSkillFailingVerdict,
  synthesisAbstainedVerdict,
  userModelRevisedVerdict,
} from "./obs-explain-learning-verdicts.js";

/** A minimal learning signal with the P2/P3 fields zeroed unless overridden. */
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

describe("userModelRevisedVerdict (OBS-02, Phase 203 — BENIGN)", () => {
  it("returns null when the learning block is absent (no fixture regression)", () => {
    expect(userModelRevisedVerdict({} as IncidentSignals)).toBeNull();
  });

  it("returns null when userModelRevised is undefined or zero (Defer != Retry)", () => {
    expect(userModelRevisedVerdict(learning())).toBeNull();
    expect(userModelRevisedVerdict(learning({ userModelRevised: 0 }))).toBeNull();
  });

  it("fires with code 'user_model_revised' when userModelRevised > 0", () => {
    const v = userModelRevisedVerdict(learning({ userModelRevised: 3 }));
    expect(v).not.toBeNull();
    expect(v!.code).toBe("user_model_revised");
    expect(v!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("carries no profile body — only the COUNT (SEC-01)", () => {
    const v = userModelRevisedVerdict(learning({ userModelRevised: 2, memoriesGeneralized: 1 }));
    const json = JSON.stringify(v);
    // The detail names the count, never a profile entry's content/entryType.
    expect(json).not.toMatch(/preference|identity|relationship|instruction/i);
  });

  it("the existing skill/synthesis verdicts still return null on a revision-only signal (no ordering steal)", () => {
    const sig = learning({ userModelRevised: 2 });
    expect(learnedSkillFailingVerdict(sig)).toBeNull();
    expect(synthesisAbstainedVerdict(sig)).toBeNull();
  });
});
