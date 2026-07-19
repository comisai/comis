// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_STATE_FILES,
  DEFAULT_TEMPLATES,
  isUntouchedWorkspaceTemplate,
  ONBOARDING_COMPLETE_TOOL_RESULT,
  OPERATOR_OWNED_FILES,
  TEMPLATE_MARKER,
  WORKSPACE_FILE_NAMES,
} from "./templates.js";

describe("default workspace template ownership", () => {
  it("partitions every workspace file between operator policy and agent state", () => {
    const all = [...WORKSPACE_FILE_NAMES].sort();
    const owned = [...OPERATOR_OWNED_FILES, ...AGENT_STATE_FILES].sort();
    expect(owned).toEqual(all);
    expect(new Set(owned).size).toBe(owned.length);
    expect(AGENT_STATE_FILES).toEqual(["BOOTSTRAP.md"]);
  });

  it("keeps starter policy files neutral and recognizable without a default persona", () => {
    for (const fileName of OPERATOR_OWNED_FILES) {
      expect(DEFAULT_TEMPLATES[fileName]).toContain(TEMPLATE_MARKER);
    }
    const combined = OPERATOR_OWNED_FILES.map((name) => DEFAULT_TEMPLATES[name]).join("\n");
    expect(combined).not.toMatch(/personal assistant|warm, witty|your human|industry|English|Hebrew|Arabic|Russian/iu);
    expect(combined).not.toContain("e.g.");
  });

  it("starts BOOTSTRAP.md with neutral first-run setup state", () => {
    const bootstrap = DEFAULT_TEMPLATES["BOOTSTRAP.md"];

    expect(bootstrap.trim().length).toBeGreaterThan(0);
    expect(bootstrap).toMatch(/new workspace/iu);
    expect(bootstrap).toMatch(/first response/iu);
    expect(bootstrap).toMatch(/ask only.*name/isu);
    expect(bootstrap).toMatch(/role.*scope.*response/isu);
    expect(bootstrap).toMatch(/boundaries.*initiative.*memory/isu);
    expect(bootstrap).toMatch(/one stage.*reply/isu);
    expect(bootstrap).toMatch(/already answered/iu);
    expect(bootstrap).toMatch(/one.*file.*edit call/isu);
    expect(bootstrap).toMatch(/verify.*successful/isu);
    expect(bootstrap).toMatch(/clear BOOTSTRAP\.md/iu);
    expect(bootstrap).toMatch(/write tool.*BOOTSTRAP\.md.*empty/isu);
    expect(bootstrap).toMatch(/after.*clear.*do not ask.*setup question/isu);
    expect(bootstrap).not.toMatch(/personal assistant|industry|creature|vibe|emoji|English|Hebrew|Arabic|Russian/iu);
  });

  it("defines an unambiguous terminal signal for completed onboarding", () => {
    expect(ONBOARDING_COMPLETE_TOOL_RESULT).toMatch(/onboarding_complete/iu);
    expect(ONBOARDING_COMPLETE_TOOL_RESULT).toMatch(/do not call.*tool/iu);
    expect(ONBOARDING_COMPLETE_TOOL_RESULT).toMatch(/do not ask.*setup question/iu);
    expect(ONBOARDING_COMPLETE_TOOL_RESULT).toMatch(/summarize.*confirmed/iu);
  });

  it("classifies only operator placeholders as untouched", () => {
    for (const fileName of OPERATOR_OWNED_FILES) {
      expect(isUntouchedWorkspaceTemplate(fileName, DEFAULT_TEMPLATES[fileName])).toBe(true);
    }
    expect(
      isUntouchedWorkspaceTemplate("BOOTSTRAP.md", DEFAULT_TEMPLATES["BOOTSTRAP.md"]),
    ).toBe(false);
  });

  it("has no second agent-package copy of the canonical templates", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..", "..");
    expect(
      existsSync(resolve(repoRoot, "packages", "agent", "src", "workspace", "templates.ts")),
    ).toBe(false);
  });
});
