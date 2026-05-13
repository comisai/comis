// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for sync-tooling/diff.ts — inspect-mode renderers.
 *
 * Covers: human output contains literal `tooling:` substring; json output
 * exposes `wouldWrite` field; renderUnifiedDiff emits + / - prefixes.
 */

import { describe, it, expect, beforeAll } from "vitest";
import chalk from "chalk";
import {
  renderInspectHuman,
  renderInspectJson,
  renderUnifiedDiff,
  type InspectPayload,
} from "./diff.js";

// Vitest pipes stdout, so chalk auto-detects no-TTY and disables colors.
// Force level=1 so the human renderer actually emits SGR codes — the color
// test asserts that ANSI-stripped output is strictly shorter than colored.
beforeAll(() => {
  chalk.level = 1;
});

/** Strip ANSI escape codes for substring assertions that ignore color. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequence
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makePayload(overrides: Partial<InspectPayload> = {}): InspectPayload {
  return {
    discovered: { mcps: [], skills: [] },
    existing: { tooling: "absent", mcpHintNames: [], skillHintNames: [] },
    diff: {
      add: { mcps: [], skills: [] },
      remove: { mcps: [], skills: [] },
    },
    wouldWrite: "tooling:\n  capabilityIndex:\n    enabled: true\n",
    ...overrides,
  };
}

describe("renderInspectHuman", () => {
  it("empty discovered + absent tooling block emits canonical zero-state strings", () => {
    const out = stripAnsi(renderInspectHuman(makePayload()));
    expect(out).toContain("Discovered MCPs (0)");
    expect(out).toContain("Discovered Skills (0)");
    expect(out).toContain("Existing tooling block: absent");
    expect(out).toContain("Would add (0)");
    expect(out).toContain("Would remove (0)");
  });

  it("with two MCPs + one skill, emits the right counts and lists each name on a separate line", () => {
    const out = stripAnsi(
      renderInspectHuman(
        makePayload({
          discovered: {
            mcps: [
              { name: "yfinance", description: undefined },
              { name: "slack-mcp", description: undefined },
            ],
            skills: [
              { name: "alpha", description: "Alpha skill", cluster: undefined, sourceDir: "/x" },
            ],
          },
        }),
      ),
    );
    expect(out).toContain("Discovered MCPs (2)");
    expect(out).toContain("yfinance");
    expect(out).toContain("slack-mcp");
    expect(out).toContain("Discovered Skills (1)");
    expect(out).toContain("alpha");
  });

  it("emits the literal `tooling:` substring inside the YAML preview block", () => {
    const out = stripAnsi(renderInspectHuman(makePayload()));
    expect(out).toContain("tooling:");
  });

  it("applies chalk colors (verifiable by ANSI-stripping = original text minus codes)", () => {
    const raw = renderInspectHuman(makePayload());
    const stripped = stripAnsi(raw);
    // ANSI-stripped output must be strictly shorter than the colored output
    // — proves chalk wrapped at least one substring with an SGR code.
    expect(raw.length).toBeGreaterThan(stripped.length);
    // Stripped output must still contain the section headers.
    expect(stripped).toContain("Discovered MCPs");
  });
});

describe("renderInspectJson", () => {
  it("emits a parseable JSON object with the four canonical top-level keys", () => {
    const out = renderInspectJson(makePayload());
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(["discovered", "existing", "diff", "wouldWrite"]),
    );
  });

  it("wouldWrite field is a string containing `tooling:` (or empty if no mutations)", () => {
    const out = renderInspectJson(makePayload());
    const parsed = JSON.parse(out) as InspectPayload;
    expect(typeof parsed.wouldWrite).toBe("string");
    expect(parsed.wouldWrite).toContain("tooling:");
  });
});

describe("renderUnifiedDiff", () => {
  it("produces lines prefixed with `+ ` for additions and `- ` for removals", () => {
    const before = "alpha\nbeta\ngamma\n";
    const after = "alpha\nbeta-modified\ngamma\ndelta\n";
    const out = renderUnifiedDiff(before, after);
    // beta -> beta-modified is one removal + one addition.
    expect(out).toContain("- beta");
    expect(out).toContain("+ beta-modified");
    // delta is a fresh addition.
    expect(out).toContain("+ delta");
  });
});
