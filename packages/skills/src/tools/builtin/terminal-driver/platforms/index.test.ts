// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the TerminalPlatformProfile registry (PROFILE-01) +
 * the load-time ReDoS pattern guard (PROFILE-03) — design §4, §11 D1/D3, v2.26 Phase 167.
 *
 * RED-first: `./index.ts` + the two `<id>/profile.ts` files do not exist when this file
 * is first committed — the import fails, every case is RED. The production registry turns
 * them GREEN. (Mirrors terminal-notify-policy.test.ts's "module does not exist on first commit".)
 *
 * The registry answers ONE selection question: given an operator-declared `allowId`, which
 * platform profile applies? Selection is by `allowId` ONLY (exact-string match, unique,
 * operator-controlled — the driven program cannot pick its own profile, §5/INV-3). An unknown
 * allowId ⇒ `undefined` ⇒ the agnostic default (§3).
 */

import { describe, it, expect } from "vitest";

import {
  getPlatformProfile,
  ALL_PROFILES,
  assertUniqueAllowIds,
  assertSafeProfilePatterns,
  type TerminalPlatformProfile,
} from "./index.js";

describe("getPlatformProfile — operator-allowId profile selection (PROFILE-01)", () => {
  it("returns the claude-code profile for the documented allowId 'claude'", () => {
    const p = getPlatformProfile("claude");
    expect(p?.id).toBe("claude-code");
  });

  it("returns the claude-code profile for the 'claude-code' allowId alias", () => {
    expect(getPlatformProfile("claude-code")?.id).toBe("claude-code");
  });

  it("returns the codex profile for the 'codex' allowId", () => {
    expect(getPlatformProfile("codex")?.id).toBe("codex");
  });

  it("returns undefined for an unknown allowId (the agnostic default path)", () => {
    expect(getPlatformProfile("vim")).toBeUndefined();
    expect(getPlatformProfile("")).toBeUndefined();
  });

  it("never content-sniffs: selection is the operator allowId, not the program name", () => {
    // A driven program cannot spoof a profile — only the operator-declared allowId maps.
    expect(getPlatformProfile("not-a-declared-id")).toBeUndefined();
  });
});

describe("ALL_PROFILES — each shipped profile carries a non-empty platformVersion (PROFILE-02)", () => {
  it("declares claude-code and codex, each with a version string", () => {
    const ids = ALL_PROFILES.map((p) => p.id).sort();
    expect(ids).toEqual(["claude-code", "codex"]);
    for (const p of ALL_PROFILES) {
      expect(typeof p.platformVersion).toBe("string");
      expect(p.platformVersion.length).toBeGreaterThan(0);
      expect(p.allowIds.length).toBeGreaterThan(0);
    }
  });
});

describe("assertUniqueAllowIds — load-time uniqueness check (PROFILE-01 / D3)", () => {
  const mk = (id: string, allowIds: string[]): TerminalPlatformProfile => ({
    id,
    allowIds,
    platformVersion: "0.0.0",
  });

  it("accepts a set of profiles whose allowIds are disjoint", () => {
    expect(() => assertUniqueAllowIds([mk("a", ["x"]), mk("b", ["y", "z"])])).not.toThrow();
  });

  it("throws when two profiles both claim the same allowId", () => {
    expect(() => assertUniqueAllowIds([mk("a", ["claude"]), mk("b", ["claude"])])).toThrow(/claude/);
  });

  it("passes for the real shipped ALL_PROFILES (no allowId collisions)", () => {
    expect(() => assertUniqueAllowIds(ALL_PROFILES)).not.toThrow();
  });
});

describe("assertSafeProfilePatterns — hot-path ReDoS guard on profile regexes (PROFILE-03 / D1)", () => {
  const withPerception = (patterns: RegExp[]): TerminalPlatformProfile => ({
    id: "synthetic",
    allowIds: ["synthetic"],
    platformVersion: "0.0.0",
    perception: { workingLine: patterns },
  });

  it("rejects a nested-quantifier pattern prone to catastrophic backtracking", () => {
    expect(() => assertSafeProfilePatterns(withPerception([/(\w+)+$/]))).toThrow();
  });

  it("rejects a nested star-quantifier group like (a*)* in a dialog detector", () => {
    const profile: TerminalPlatformProfile = {
      id: "synthetic",
      allowIds: ["synthetic"],
      platformVersion: "0.0.0",
      dialogs: [{ name: "evil", detect: /(a*)*/ }],
    };
    expect(() => assertSafeProfilePatterns(profile)).toThrow();
  });

  it("accepts a bounded literal pattern such as the Codex working line", () => {
    expect(() => assertSafeProfilePatterns(withPerception([/Working \(\d+s\)/]))).not.toThrow();
  });

  it("accepts every pattern in the real shipped profiles", () => {
    for (const p of ALL_PROFILES) expect(() => assertSafeProfilePatterns(p)).not.toThrow();
  });
});
