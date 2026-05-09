// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 24 skill-variant fixture invariants.
 *
 * Validates the contract surface of the three SKILL.md fixtures + co-located
 * operator YAML created in Plan 24-01. Downstream Wave-2 plans (24-02 / 24-03)
 * and the Wave-3 behavioral-metrics suite (24-05) consume these files and rely
 * on the invariants asserted here. The smoke test is the executable
 * verification surface for INTEG-03 at the fixture level.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Lightweight frontmatter splitter — extracts the YAML block between the
 * opening and closing `---` markers and returns it parsed as a record. Mirrors
 * the shape of `packages/skills/src/manifest/parser.ts:parseFrontmatter` but
 * inlined here so the fixture test stays self-contained (no cross-package
 * imports from a `__tests__` fixture).
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    throw new Error("Frontmatter must start with '---'");
  }
  const afterOpening = normalized.indexOf("\n");
  if (afterOpening === -1) {
    throw new Error("Frontmatter missing newline after opening '---'");
  }
  const closingIndex = normalized.indexOf("\n---", afterOpening);
  if (closingIndex === -1) {
    throw new Error("Frontmatter missing closing '---' marker");
  }
  const yamlBlock = normalized.slice(afterOpening + 1, closingIndex);
  const parsed = parseYaml(yamlBlock);
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    throw new Error("Frontmatter must be a YAML object");
  }
  const content = normalized.slice(closingIndex + 4).trim();
  return { data: parsed as Record<string, unknown>, content };
}

interface ComisCapabilityShape {
  cluster?: unknown;
  summary?: unknown;
  replacesPackages?: unknown;
}

interface ComisNamespaceShape {
  capability?: ComisCapabilityShape;
}

interface SkillFrontmatterShape {
  name?: unknown;
  type?: unknown;
  userInvocable?: unknown;
  disableModelInvocation?: unknown;
  comis?: ComisNamespaceShape;
}

interface ToolingConfigShape {
  tooling: {
    capabilityClusters: { clusters: Record<string, { label: string; priority: number; preferOverInstalls: boolean }> };
    mcp: { capabilityHints: Record<string, { cluster: string; description: string; replacesPackages: string[] }> };
    skills: { capabilityHints: Record<string, { cluster: string; description: string; replacesPackages: string[] }> };
  };
}

describe("Phase 24 skill-variant fixture invariants", () => {
  it("operator-config-skill.md parses with NO comis.capability block", () => {
    const raw = readFileSync(resolve(here, "operator-config-skill.md"), "utf8");
    const { data } = parseFrontmatter(raw);
    const fm = data as SkillFrontmatterShape;
    expect(fm.name).toBe("operator-config-skill");
    expect(fm.type).toBe("prompt");
    expect(fm.userInvocable).toBe(true);
    expect(fm.comis).toBeUndefined();
    expect(fm.disableModelInvocation === undefined || fm.disableModelInvocation === false).toBe(true);
  });

  it("comis-capability-skill.md parses with well-formed comis.capability block", () => {
    const raw = readFileSync(resolve(here, "comis-capability-skill.md"), "utf8");
    const { data } = parseFrontmatter(raw);
    const fm = data as SkillFrontmatterShape;
    expect(fm.name).toBe("comis-capability-skill");
    expect(fm.type).toBe("prompt");
    expect(fm.userInvocable).toBe(true);
    expect(fm.comis?.capability?.cluster).toBe("data-fetching-financial");
    expect(typeof fm.comis?.capability?.summary).toBe("string");
    expect((fm.comis?.capability?.summary as string).length).toBeGreaterThan(0);
    expect(Array.isArray(fm.comis?.capability?.replacesPackages)).toBe(true);
    expect((fm.comis?.capability?.replacesPackages as unknown[]).length).toBeGreaterThan(0);
    expect(fm.disableModelInvocation === undefined || fm.disableModelInvocation === false).toBe(true);
  });

  it("sdk-fallback-skill.md parses with NO comis namespace at all", () => {
    const raw = readFileSync(resolve(here, "sdk-fallback-skill.md"), "utf8");
    const { data, content } = parseFrontmatter(raw);
    const fm = data as SkillFrontmatterShape;
    expect(fm.name).toBe("sdk-fallback-skill");
    expect(fm.type).toBe("prompt");
    expect(fm.userInvocable).toBe(true);
    expect(fm.comis).toBeUndefined();
    expect(content.trim().length).toBeGreaterThan(0);
    expect(fm.disableModelInvocation === undefined || fm.disableModelInvocation === false).toBe(true);
  });

  it("tooling-config.yaml declares operator-config-skill hint pointing at the matching cluster", () => {
    const raw = readFileSync(resolve(here, "tooling-config.yaml"), "utf8");
    const config = parseYaml(raw) as ToolingConfigShape;
    expect(config.tooling.capabilityClusters.clusters["data-fetching-financial"]).toBeDefined();
    expect(config.tooling.mcp.capabilityHints["finance-data"]).toBeDefined();
    expect(config.tooling.mcp.capabilityHints["finance-data"].replacesPackages).toContain("market-data-lib");
    expect(config.tooling.skills.capabilityHints["operator-config-skill"].cluster).toBe("data-fetching-financial");
    expect(config.tooling.skills.capabilityHints["comis-capability-skill"]).toBeUndefined();
    expect(config.tooling.skills.capabilityHints["sdk-fallback-skill"]).toBeUndefined();
  });

  it("contains no forbidden tokens in fixture content files", () => {
    const files = [
      "README.md",
      "operator-config-skill.md",
      "comis-capability-skill.md",
      "sdk-fallback-skill.md",
      "tooling-config.yaml",
    ];
    for (const file of files) {
      const raw = readFileSync(resolve(here, file), "utf8");
      expect(raw, file).not.toMatch(/discover_tools|tool_search_tool_regex|yfinance/i);
    }
  });
});
