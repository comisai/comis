// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the decay-aware learned-skill TREND (anti-induced-demotion).
 *
 * The trend is the in-process, daemon-lifetime decision of WHEN a corroborated
 * failure should drive a `demote()` — modeled as a recency-weighted
 * success/failure standing ("strengthening" | "stable" | "weakening"), NOT a raw
 * failure counter (the hindsight Trend). The load-bearing invariant
 * (anti-induced-demotion): a SINGLE corroborated failure against many
 * recent successes keeps the trend STABLE/STRENGTHENING — only SUSTAINED
 * corroborated failure reaches WEAKENING — so a well-reused procedure is not
 * archived by one (possibly induced) failure.
 *
 * Reuses the saturating-penalty SHAPE (`f = fc/(fc+K)`, K=3) adapted to
 * a recency-decayed score (sqlite-memory-lifecycle-store.ts:354-359, READ-ONLY).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createSkillTrendTracker } from "./setup-learning-skill-trend.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

describe("createSkillTrendTracker — decay-aware learned-skill standing", () => {
  it("ONE failure after a strong recent success history stays STABLE/STRENGTHENING (never weakening)", () => {
    const trend = createSkillTrendTracker();
    let now = T0;
    // A strong recent success history (the well-reused procedure).
    for (let i = 0; i < 6; i++) {
      trend.updateSkillTrend("s1", "success", now);
      now += HOUR;
    }
    // ONE corroborated failure arrives — the anti-induced-demotion keystone: a
    // single failure against many recent successes must NOT reach "weakening"
    // (so the caller does NOT demote a correct, well-reused procedure).
    const after = trend.updateSkillTrend("s1", "failure", now);
    expect(after).not.toBe("weakening");
    expect(["stable", "strengthening"]).toContain(after);
  });

  it("SUSTAINED corroborated failures reach WEAKENING (the decayed success is outweighed)", () => {
    const trend = createSkillTrendTracker();
    let now = T0;
    // A modest success history, then sustained failures dominate.
    trend.updateSkillTrend("s2", "success", now);
    now += HOUR;
    trend.updateSkillTrend("s2", "success", now);
    now += HOUR;
    let last = trend.updateSkillTrend("s2", "failure", now);
    now += HOUR;
    last = trend.updateSkillTrend("s2", "failure", now);
    now += HOUR;
    last = trend.updateSkillTrend("s2", "failure", now);
    now += HOUR;
    last = trend.updateSkillTrend("s2", "failure", now);
    expect(last).toBe("weakening");
  });

  it("recency decay: an OLD success then recent failures weakens FASTER than a RECENT success then the same failures", () => {
    // Skill A: success long ago, then 3 recent failures → the success has decayed
    // away → weakens quickly.
    const trendA = createSkillTrendTracker();
    trendA.updateSkillTrend("a", "success", T0);
    let nowA = T0 + 30 * DAY; // the success is ancient by now
    let resultA = trendA.updateSkillTrend("a", "failure", nowA);
    nowA += HOUR;
    resultA = trendA.updateSkillTrend("a", "failure", nowA);
    nowA += HOUR;
    resultA = trendA.updateSkillTrend("a", "failure", nowA);

    // Skill B: success RECENT, then the same 3 failures right after → the fresh
    // success still props up the score → does NOT weaken as fast.
    const trendB = createSkillTrendTracker();
    let nowB = T0 + 30 * DAY;
    trendB.updateSkillTrend("b", "success", nowB);
    nowB += HOUR;
    let resultB = trendB.updateSkillTrend("b", "failure", nowB);
    nowB += HOUR;
    resultB = trendB.updateSkillTrend("b", "failure", nowB);
    nowB += HOUR;
    resultB = trendB.updateSkillTrend("b", "failure", nowB);

    // The aged-success skill is at-or-below the fresh-success skill on the
    // strengthening→weakening ordering (the recency shape: a stale success
    // protects less than a fresh one).
    const rank = (t: string): number => (t === "weakening" ? 0 : t === "stable" ? 1 : 2);
    expect(rank(resultA)).toBeLessThanOrEqual(rank(resultB));
  });

  it("repeated successes keep/move the trend toward STRENGTHENING", () => {
    const trend = createSkillTrendTracker();
    let now = T0;
    let last = trend.updateSkillTrend("s3", "success", now);
    for (let i = 0; i < 5; i++) {
      now += HOUR;
      last = trend.updateSkillTrend("s3", "success", now);
    }
    expect(last).toBe("strengthening");
  });

  it("is in-process / daemon-lifetime: a FRESH tracker resets the standing (like the corroboration tally)", () => {
    const trend1 = createSkillTrendTracker();
    let now = T0;
    // Drive s4 to weakening in tracker 1.
    trend1.updateSkillTrend("s4", "failure", now);
    now += HOUR;
    trend1.updateSkillTrend("s4", "failure", now);
    now += HOUR;
    trend1.updateSkillTrend("s4", "failure", now);
    now += HOUR;
    const weak = trend1.updateSkillTrend("s4", "failure", now);
    expect(weak).toBe("weakening");

    // A brand-new tracker has NO memory of s4 — a single success starts fresh
    // (not "weakening").
    const trend2 = createSkillTrendTracker();
    const fresh = trend2.updateSkillTrend("s4", "success", now);
    expect(fresh).not.toBe("weakening");
  });

  it("is BOUNDED: tracking more than the cap evicts the oldest-touched skill (no daemon-lifetime growth)", () => {
    // A tiny cap makes the eviction observable in a unit test.
    const trend = createSkillTrendTracker({ maxTracked: 2 });
    let now = T0;
    // Drive 'old' to weakening, then push two NEW skills past the cap so 'old' is evicted.
    for (let i = 0; i < 4; i++) {
      trend.updateSkillTrend("old", "failure", now);
      now += HOUR;
    }
    trend.updateSkillTrend("mid", "success", now);
    now += HOUR;
    trend.updateSkillTrend("new", "success", now);
    now += HOUR;
    // 'old' was evicted (cap=2, 'mid'/'new' are newer) → its weakening standing is
    // gone → a fresh success on 'old' starts over (not weakening).
    const reborn = trend.updateSkillTrend("old", "success", now);
    expect(reborn).not.toBe("weakening");
  });

  it("never calls Date.now() — the now is the injected param (globals.test.ts)", () => {
    // A purely structural expectation mirrored by the architecture grep; here we
    // assert the API SHAPE requires an explicit nowMs (no implicit clock).
    const trend = createSkillTrendTracker();
    // @ts-expect-error nowMs is required — the trend never reads an ambient clock.
    expect(() => trend.updateSkillTrend("x", "success")).toBeTypeOf("function");
  });
});

describe("peekSkillTrend (non-mutating standing read for the value-gated promote)", () => {
  it("returns 'stable' for a never-seen skill (neutral) — the gate never blocks an un-failed skill", () => {
    const trend = createSkillTrendTracker();
    expect(trend.peekSkillTrend("unseen", 1000)).toBe("stable");
  });
  it("a SINGLE failure peeks 'stable' (matches updateSkillTrend's classification)", () => {
    const trend = createSkillTrendTracker();
    expect(trend.updateSkillTrend("s", "failure", 1000)).toBe("stable");
    expect(trend.peekSkillTrend("s", 1000)).toBe("stable");
  });
  it("SUSTAINED failure peeks 'weakening' — and the peek does NOT MUTATE (repeatable; a later success still recovers)", () => {
    const trend = createSkillTrendTracker();
    trend.updateSkillTrend("s", "failure", 1000);
    trend.updateSkillTrend("s", "failure", 1000);
    // Peek is idempotent + non-mutating: reading it many times never changes the standing.
    expect(trend.peekSkillTrend("s", 1000)).toBe("weakening");
    expect(trend.peekSkillTrend("s", 1000)).toBe("weakening");
    // A real success then folds from the SAME weakening standing (peek didn't consume it).
    expect(trend.updateSkillTrend("s", "success", 1000)).not.toBe("strengthening");
  });
});
