// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { formatViolations } from "./architecture-helpers.js";

describe("formatViolations -- verbose failure rendering", () => {
  it("returns single-line message for empty violations", () => {
    const out = formatViolations({
      description: "Test desc.",
      violations: [],
      suggestedFix: "fix",
      designRef: "design §X",
    });
    expect(out).toContain("No violations found");
    expect(out).toContain("Test desc.");
  });

  it("renders multi-line format with file:line list, suggestedFix, designRef", () => {
    const out = formatViolations({
      description: "@comis/cli must not import @comis/agent.",
      violations: [
        {
          file: "/abs/cli/src/foo.ts",
          line: 10,
          column: 5,
          snippet: '  10: import { X } from "@comis/agent";',
        },
      ],
      suggestedFix: "Move helper to @comis/core/security.",
      designRef: "design §5.2 / L17",
      allowlistRef: "L17",
    });
    expect(out).toContain("Found 1 violation");
    expect(out).toContain("/abs/cli/src/foo.ts:10:5");
    expect(out).toContain("Move helper to @comis/core/security");
    expect(out).toContain("Allowlist reference: L17");
    expect(out).toContain("See: design §5.2 / L17");
  });

  it("omits column when undefined", () => {
    const out = formatViolations({
      description: "x",
      violations: [{ file: "f.ts", line: 1 }],
      suggestedFix: "y",
      designRef: "z",
    });
    expect(out).toContain("f.ts:1\n");
    expect(out).not.toContain("f.ts:1:");
  });

  it("omits allowlistRef block when allowlistRef undefined", () => {
    const out = formatViolations({
      description: "x",
      violations: [{ file: "f.ts", line: 1 }],
      suggestedFix: "y",
      designRef: "z",
    });
    expect(out).not.toContain("Allowlist reference");
  });
});
