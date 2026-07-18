// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_STATE_FILES,
  DEFAULT_TEMPLATES,
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

  it("starts BOOTSTRAP.md empty so onboarding state is not injected by default", () => {
    expect(DEFAULT_TEMPLATES["BOOTSTRAP.md"]).toBe("");
  });

  it("has no second agent-package copy of the canonical templates", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..", "..");
    expect(
      existsSync(resolve(repoRoot, "packages", "agent", "src", "workspace", "templates.ts")),
    ).toBe(false);
  });
});
