// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  resolveVerbosityProfile,
  buildVerbosityHintSection,
} from "./verbosity-sections.js";
import type { VerbosityConfig } from "@comis/core";

const defaultConfig: VerbosityConfig = {
  enabled: true,
  defaultLevel: "auto",
  overrides: {},
};

describe("resolveVerbosityProfile", () => {
  it("returns undefined when config is undefined", () => {
    expect(resolveVerbosityProfile(undefined, "telegram", "dm")).toBeUndefined();
  });

  it("returns undefined when config.enabled is false", () => {
    expect(
      resolveVerbosityProfile({ ...defaultConfig, enabled: false }, "telegram", "dm"),
    ).toBeUndefined();
  });

  it('returns {level: "auto"} with default config and chatType "dm"', () => {
    const profile = resolveVerbosityProfile(defaultConfig, "telegram", "dm");
    expect(profile?.level).toBe("auto");
  });

  it('returns {level: "terse"} when defaultLevel is "terse"', () => {
    const profile = resolveVerbosityProfile(
      { ...defaultConfig, defaultLevel: "terse" },
      "telegram",
      "dm",
    );
    expect(profile?.level).toBe("terse");
  });

  it("applies threadLevel when chatType is thread", () => {
    const profile = resolveVerbosityProfile(
      { ...defaultConfig, threadLevel: "concise" },
      "telegram",
      "thread",
    );
    expect(profile?.level).toBe("concise");
  });

  it("does NOT apply threadLevel when chatType is dm", () => {
    const profile = resolveVerbosityProfile(
      { ...defaultConfig, threadLevel: "concise" },
      "telegram",
      "dm",
    );
    expect(profile?.level).toBe("auto");
  });

  it("applies per-channel override level over threadLevel", () => {
    const profile = resolveVerbosityProfile(
      {
        ...defaultConfig,
        threadLevel: "concise",
        overrides: { telegram: { level: "terse" } },
      },
      "telegram",
      "thread",
    );
    expect(profile?.level).toBe("terse");
  });

  it("applies per-channel sub-hints", () => {
    const profile = resolveVerbosityProfile(
      {
        ...defaultConfig,
        overrides: {
          discord: { maxResponseChars: 1500, useMarkdown: false, allowCodeBlocks: false },
        },
      },
      "discord",
      "dm",
    );
    expect(profile?.maxResponseChars).toBe(1500);
    expect(profile?.useMarkdown).toBe(false);
    expect(profile?.allowCodeBlocks).toBe(false);
  });

  it("passes through maxMessageChars from argument", () => {
    const profile = resolveVerbosityProfile(defaultConfig, "telegram", "dm", 4096);
    expect(profile?.maxMessageChars).toBe(4096);
  });
});

describe("buildVerbosityHintSection", () => {
  it("returns [] when profile is undefined", () => {
    expect(buildVerbosityHintSection(undefined, false)).toEqual([]);
  });

  it("returns [] when isMinimal is true", () => {
    expect(
      buildVerbosityHintSection({ level: "detailed" }, true),
    ).toEqual([]);
  });

  it("auto mode with maxMessageChars=2000 returns single line about character limit", () => {
    const lines = buildVerbosityHintSection({ level: "auto", maxMessageChars: 2000 }, false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("2000");
    expect(lines[0]).toContain("character");
  });

  it("auto mode without maxMessageChars returns []", () => {
    expect(buildVerbosityHintSection({ level: "auto" }, false)).toEqual([]);
  });

  it("auto mode line does NOT contain style opinions", () => {
    const lines = buildVerbosityHintSection({ level: "auto", maxMessageChars: 2000 }, false);
    const joined = lines.join(" ");
    expect(joined).not.toMatch(/concise|brief|short/i);
  });

  it("terse level returns Response Style header + terse instructions", () => {
    const lines = buildVerbosityHintSection({ level: "terse" }, false);
    expect(lines[0]).toBe("## Response Style");
    expect(lines.some((l) => /2-3 sentences/i.test(l))).toBe(true);
  });

  it("concise level returns concise instructions", () => {
    const lines = buildVerbosityHintSection({ level: "concise" }, false);
    expect(lines[0]).toBe("## Response Style");
    expect(lines.some((l) => /brief/i.test(l))).toBe(true);
  });

  it("standard level returns standard instructions", () => {
    const lines = buildVerbosityHintSection({ level: "standard" }, false);
    expect(lines[0]).toBe("## Response Style");
    expect(lines.some((l) => /well-structured/i.test(l))).toBe(true);
  });

  it("detailed level returns detailed instructions", () => {
    const lines = buildVerbosityHintSection({ level: "detailed" }, false);
    expect(lines[0]).toBe("## Response Style");
    expect(lines.some((l) => /thorough/i.test(l))).toBe(true);
  });

  it("explicit level with maxResponseChars=1500 appends target length line", () => {
    const lines = buildVerbosityHintSection(
      { level: "concise", maxResponseChars: 1500 },
      false,
    );
    expect(lines.some((l) => l.includes("1500"))).toBe(true);
  });

  it('explicit level with useMarkdown=false appends "Do not use markdown formatting."', () => {
    const lines = buildVerbosityHintSection(
      { level: "standard", useMarkdown: false },
      false,
    );
    expect(lines).toContain("Do not use markdown formatting.");
  });

  it('explicit level with allowCodeBlocks=false appends "Do not use code blocks."', () => {
    const lines = buildVerbosityHintSection(
      { level: "standard", allowCodeBlocks: false },
      false,
    );
    expect(lines).toContain("Do not use code blocks.");
  });
});
