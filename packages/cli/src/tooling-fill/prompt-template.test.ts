// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tooling-fill/prompt-template.ts.
 *
 * Covers:
 * - Prompt requires the strict 2-line response contract.
 * - Prompt forbids any other text/fields/commentary; the forbidden-tokens
 *   list explicitly names CLUSTER: and INSTALL_DETOURS:.
 * - Skill prompts ask the agent to REFINE the manifest description (not
 *   invent), and "REFINE" appears in uppercase.
 * - Determinism: byte-identical output for byte-identical input.
 */

import { describe, it, expect } from "vitest";
import { buildFillPrompt } from "./prompt-template.js";

describe("buildFillPrompt — MCP variant", () => {
  it("includes the MCP name and install command", () => {
    const out = buildFillPrompt({
      kind: "mcp",
      name: "yfinance",
      mcpCommand: "uvx yfinance-mcp@latest",
    });
    expect(out).toContain("yfinance");
    expect(out).toContain("uvx yfinance-mcp@latest");
  });

  it("explains the install-detour purpose of replacesPackages", () => {
    const out = buildFillPrompt({
      kind: "mcp",
      name: "yfinance",
      mcpCommand: "uvx yfinance-mcp@latest",
    });
    expect(out).toContain("install-detour");
  });

  it("includes the currentDescription when provided (operator forced refill)", () => {
    const out = buildFillPrompt({
      kind: "mcp",
      name: "yfinance",
      mcpCommand: "uvx yfinance-mcp@latest",
      currentDescription: "prior text",
    });
    expect(out).toContain("prior text");
  });
});

describe("buildFillPrompt — Skills variant", () => {
  it("asks the agent to REFINE the existing manifest description (not invent)", () => {
    const out = buildFillPrompt({
      kind: "skills",
      name: "stub-skill",
      skillDescription: "Markdown formatting",
    });
    // Refinement, not invention.
    expect(out).toContain("REFINE");
    expect(out).toContain("Markdown formatting");
  });

  it("produces a coherent prompt even when no manifest description is provided", () => {
    const out = buildFillPrompt({ kind: "skills", name: "x" });
    expect(out).toContain("skill named");
  });
});

describe("buildFillPrompt — strict scope", () => {
  it("contains the literal forbid clause across all variants", () => {
    const literal = "Do NOT include any other text, fields, or commentary.";
    expect(
      buildFillPrompt({
        kind: "mcp",
        name: "n",
        mcpCommand: "uvx p",
      }),
    ).toContain(literal);
    expect(
      buildFillPrompt({ kind: "skills", name: "n" }),
    ).toContain(literal);
  });

  it("explicitly forbids CLUSTER: and INSTALL_DETOURS: by name", () => {
    const out = buildFillPrompt({
      kind: "mcp",
      name: "n",
      mcpCommand: "uvx p",
    });
    // Both literal tokens must appear in the forbid clause.
    expect(out).toContain("CLUSTER:");
    expect(out).toContain("INSTALL_DETOURS:");
  });

  it("contains the grammar shape for both DESCRIPTION and REPLACES_PACKAGES", () => {
    const out = buildFillPrompt({
      kind: "mcp",
      name: "n",
      mcpCommand: "uvx p",
    });
    expect(out).toContain("DESCRIPTION: <one-line description");
    expect(out).toContain("REPLACES_PACKAGES: <JSON array of npm/pip");
  });

  it("the response-format block is byte-identical across MCP and skill kinds", () => {
    const mcp = buildFillPrompt({
      kind: "mcp",
      name: "n",
      mcpCommand: "uvx p",
    });
    const skill = buildFillPrompt({ kind: "skills", name: "n" });
    // Extract the trailing block by splitting at the literal sentinel.
    const SENTINEL = "Respond with EXACTLY two lines";
    const mcpTail = mcp.slice(mcp.indexOf(SENTINEL));
    const skillTail = skill.slice(skill.indexOf(SENTINEL));
    expect(mcpTail).toBe(skillTail);
    expect(mcpTail.length).toBeGreaterThan(0);
  });
});

describe("buildFillPrompt — determinism", () => {
  it("returns byte-identical output for byte-identical input", () => {
    const args = {
      kind: "mcp" as const,
      name: "yfinance",
      mcpCommand: "uvx yfinance-mcp@latest",
    };
    expect(buildFillPrompt(args)).toBe(buildFillPrompt(args));
  });
});
