// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the activity theme tier.
 *
 * Two contracts under test:
 *   - label-spec.ts: `ActivityTheme` carries an OPTIONAL `markers` tier
 *     ({@link ActivityStatusMarkers}). A theme that omits markers still
 *     type-checks and markers never perturb `resolveLabelSpec` output — markers
 *     are a parallel advisory tier, NOT part of the label-merge.
 *   - themes/index.ts + the four bundles: exactly four named themes
 *     (`default`, `terminal-minimal`, `playful`, `ascii`) resolve via
 *     `themeForName(name)`; their marker sets are pairwise distinct; the ascii
 *     bundle is provably emoji-free; the playful bundle provably carries emoji.
 *
 * Co-located unit-test convention (mirrors `redact-value.test.ts`): import the
 * subjects DIRECTLY from their source modules, NOT via the package barrel.
 */

import { describe, it, expect } from "vitest";

import {
  resolveLabelSpec,
  _clearActivityLabelSpecsForTest,
  type ActivityTheme,
  type ActivityStatusMarkers,
} from "../label-spec.js";
import { themeForName, type ThemeName } from "../themes/index.js";

const ALL_THEME_NAMES: readonly ThemeName[] = [
  "default",
  "terminal-minimal",
  "playful",
  "ascii",
];

describe("ActivityTheme.markers — optional advisory tier", () => {
  it("exposes the exact marker strings a theme supplies", () => {
    const markers: ActivityStatusMarkers = {
      success: "X",
      failure: "Y",
      subagent: "Z",
      running: "W",
    };
    const theme: ActivityTheme = { markers };
    expect(theme.markers).toEqual({
      success: "X",
      failure: "Y",
      subagent: "Z",
      running: "W",
    });
  });

  it("leaves markers undefined for a markerless tools-only theme", () => {
    const theme: ActivityTheme = {
      tools: { web_search: { label: "searching {q}" } },
    };
    expect(theme.markers).toBeUndefined();
  });

  it("does not let marker presence perturb resolveLabelSpec output", () => {
    _clearActivityLabelSpecsForTest();
    const markerOnlyTheme: ActivityTheme = {
      markers: { success: "✓", failure: "❌", subagent: "🤖", running: "🔧" },
    };
    const withMarkers = resolveLabelSpec("web_search", { theme: markerOnlyTheme });
    const withoutTheme = resolveLabelSpec("web_search");
    expect(withMarkers).toEqual(withoutTheme);
  });
});

describe("themeForName — the four bundled themes", () => {
  it("resolves every theme name to a bundle carrying markers", () => {
    for (const name of ALL_THEME_NAMES) {
      const theme = themeForName(name);
      expect(theme).toBeDefined();
      expect(theme.markers).toBeDefined();
    }
  });

  it("never returns undefined for any of the four ThemeName literals", () => {
    for (const name of ALL_THEME_NAMES) {
      expect(themeForName(name)).not.toBeUndefined();
    }
  });

  it("yields four pairwise-distinct status-marker tuples", () => {
    const tuples = ALL_THEME_NAMES.map((name) => {
      const m = themeForName(name).markers;
      expect(m).toBeDefined();
      return JSON.stringify(m);
    });
    const unique = new Set(tuples);
    expect(unique.size).toBe(ALL_THEME_NAMES.length);
  });

  it("renders each theme pair differently in at least one marker slot", () => {
    for (let i = 0; i < ALL_THEME_NAMES.length; i += 1) {
      for (let j = i + 1; j < ALL_THEME_NAMES.length; j += 1) {
        const a = themeForName(ALL_THEME_NAMES[i]!).markers!;
        const b = themeForName(ALL_THEME_NAMES[j]!).markers!;
        const differs =
          a.success !== b.success ||
          a.failure !== b.failure ||
          a.subagent !== b.subagent ||
          a.running !== b.running;
        expect(differs).toBe(true);
      }
    }
  });

  it("ascii theme markers contain zero emoji codepoints", () => {
    const ascii = themeForName("ascii").markers!;
    // No Extended_Pictographic (the emoji class) anywhere in the marker set.
    expect(JSON.stringify(ascii)).not.toMatch(/\p{Extended_Pictographic}/u);
    // And no literal default-theme glyphs leaked into the ascii bundle.
    for (const glyph of ["✓", "❌", "🤖", "🔧", "✅", "💥"]) {
      expect(JSON.stringify(ascii)).not.toContain(glyph);
    }
  });

  it("playful theme success marker contains an emoji codepoint", () => {
    const playful = themeForName("playful").markers!;
    expect(playful.success).toMatch(/\p{Extended_Pictographic}/u);
  });
});
