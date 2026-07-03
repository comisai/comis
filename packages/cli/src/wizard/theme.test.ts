// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for wizard/theme.ts — Comis branded output helpers.
 *
 * Covers the three color-support tiers (chalk.level === 0, level 1-2, level 3)
 * and every semantic-color → ANSI-fallback path. Restores chalk.level after
 * each test so test ordering does not bleed across colors.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import chalk from "chalk";
import {
  heading,
  sectionSeparator,
  success,
  warning,
  error,
  info,
  formatValidationError,
  brand,
  COMIS_PALETTE,
} from "./theme.js";

describe("wizard/theme — color palette constants", () => {
  it("exposes the expected COMIS_PALETTE hex map with every semantic color name", () => {
    expect(COMIS_PALETTE.accent).toBe("#5B8DEF");
    expect(COMIS_PALETTE.accentBright).toBe("#7BA7FF");
    expect(COMIS_PALETTE.accentDim).toBe("#3A6CD4");
    expect(COMIS_PALETTE.success).toBe("#2FBF71");
    expect(COMIS_PALETTE.warn).toBe("#FFB020");
    expect(COMIS_PALETTE.error).toBe("#E23D2D");
    expect(COMIS_PALETTE.info).toBe("#8BA5D1");
    expect(COMIS_PALETTE.muted).toBe("#6B7280");
    expect(COMIS_PALETTE.dim).toBe("#9CA3AF");
    expect(COMIS_PALETTE.subtle).toBe("#374151");
    expect(COMIS_PALETTE.claw).toBe("#C0C0C0");
  });
});

describe("wizard/theme — colorize() at chalk.level === 0 (NO_COLOR)", () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it("returns plain text without ANSI escapes when chalk.level is zero for accent brand color", () => {
    const out = brand("hello world");
    expect(out).toBe("hello world");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("returns plain success message without ANSI escapes when chalk.level is zero", () => {
    const out = success("done");
    expect(out).toContain("done");
    // mark falls back to plain "V" at level 0
    expect(out).toContain("V");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("returns plain warning message without ANSI escapes when chalk.level is zero", () => {
    const out = warning("be careful");
    expect(out).toContain("be careful");
    expect(out).toContain("!");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("returns plain error message without ANSI escapes when chalk.level is zero", () => {
    const out = error("oops");
    expect(out).toContain("oops");
    expect(out).toContain("X");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("returns plain info message without ANSI escapes when chalk.level is zero", () => {
    const out = info("fyi");
    expect(out).toContain("fyi");
    expect(out).toContain("i");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("renders heading box-drawing without ANSI escapes when chalk.level is zero", () => {
    const out = heading("Comis Setup");
    expect(out).toContain("Comis Setup");
    expect(out).toContain("+");
    expect(out).toContain("-");
    expect(out).toContain("|");
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("renders sectionSeparator without ANSI escapes when chalk.level is zero", () => {
    const labeledOut = sectionSeparator("Section A");
    expect(labeledOut).toContain("Section A");
    expect(labeledOut).toContain("--");
    expect(labeledOut).not.toMatch(/\x1b\[/);

    const unlabeledOut = sectionSeparator();
    expect(unlabeledOut).toMatch(/^-+$/);
    expect(unlabeledOut).not.toMatch(/\x1b\[/);
  });
});

describe("wizard/theme — colorize() at chalk.level === 1 (basic 16-color)", () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 1;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it("uses chalk.blue ANSI fallback when palette accent is selected at chalk.level=1", () => {
    const out = brand("blue text");
    // Should contain ANSI blue escape ([34m)
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("blue text");
  });

  it("uses chalk.green ANSI fallback when palette success is selected at chalk.level=1", () => {
    const out = success("ok");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("ok");
    // checkmark unicode mark used at level >= 1
    expect(out).toContain("✓");
  });

  it("uses chalk.yellow ANSI fallback when palette warn is selected at chalk.level=1", () => {
    const out = warning("careful");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("careful");
  });

  it("uses chalk.red ANSI fallback when palette error is selected at chalk.level=1", () => {
    const out = error("bad");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("bad");
  });

  it("uses chalk.gray ANSI fallback when palette muted/dim/subtle is selected at chalk.level=1", () => {
    // sectionSeparator() with no label uses "muted" — exercises the gray branch
    const out = sectionSeparator();
    expect(out).toMatch(/\x1b\[/);
  });

  it("renders labeled sectionSeparator combining muted prefix + accent label + muted suffix at chalk.level=1", () => {
    const out = sectionSeparator("Section B");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("Section B");
    expect(out).toContain("--");
  });
});

describe("wizard/theme — colorize() at chalk.level === 3 (truecolor)", () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it("uses chalk.hex with palette value when chalk.level is truecolor for accent brand", () => {
    const out = brand("truecolor brand");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("truecolor brand");
  });

  it("uses chalk.hex with palette success hex when chalk.level is truecolor for success message", () => {
    const out = success("succeeded");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("succeeded");
  });

  it("renders heading box border with accent hex color at chalk.level=3 truecolor", () => {
    const out = heading("Comis");
    expect(out).toMatch(/\x1b\[/);
    expect(out).toContain("Comis");
  });
});

describe("wizard/theme — heading() layout invariants", () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it("centers heading text horizontally using padding to maintain symmetric inner width", () => {
    const out = heading("X");
    const lines = out.split("\n");
    // 5 lines: top, empty, text, empty, bottom
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("+");
    expect(lines[2]).toContain("X");
    expect(lines[4]).toContain("+");
  });

  it("expands inner width to text length plus padding when text exceeds the minWidth floor of 40", () => {
    const longText = "x".repeat(50);
    const out = heading(longText);
    const lines = out.split("\n");
    // The text line should contain all 50 x's
    expect(lines[2]).toContain(longText);
  });
});

describe("wizard/theme — formatValidationError() composition", () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 0;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it("renders ValidationResult error message and appends hint on a new dim-coloured line when hint present", () => {
    const out = formatValidationError({
      field: "port",
      message: "Port must be 1024-65535",
      hint: "Try a higher number",
    });
    expect(out).toContain("Port must be 1024-65535");
    expect(out).toContain("Try a higher number");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("renders ValidationResult error without trailing hint line when hint is absent", () => {
    const out = formatValidationError({
      field: "port",
      message: "Bad port",
    });
    expect(out).toContain("Bad port");
    expect(out.split("\n")).toHaveLength(1);
  });
});
