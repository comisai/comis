// SPDX-License-Identifier: Apache-2.0
/**
 * Requirement-verification tests for tool pipeline interoperability.
 *
 * Tests cover:
 * - assembleToolPipeline returns builtin and platform tools (two-tier pipeline)
 */

import type { SkillsConfig } from "@comis/core";
import { describe, expect, it } from "vitest";
import { assembleToolPipeline } from "./tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(toggles: Partial<SkillsConfig["builtinTools"]> = {}): SkillsConfig {
  return {
    discoveryPaths: [],
    builtinTools: {
      read: toggles.read ?? false,
      write: toggles.write ?? false,
      edit: toggles.edit ?? false,
      grep: toggles.grep ?? false,
      find: toggles.find ?? false,
      ls: toggles.ls ?? false,
      exec: toggles.exec ?? false,
      process: toggles.process ?? false,
      webSearch: toggles.webSearch ?? false,
      webFetch: toggles.webFetch ?? false,
      browser: toggles.browser ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tools interoperate correctly (two-tier pipeline)
// ---------------------------------------------------------------------------

describe("Tools interoperate correctly", () => {
  it("assembleToolPipeline returns builtin and platform tools", async () => {
    const tools = await assembleToolPipeline({
      config: makeConfig({ read: true, write: true }),
      workspacePath: "/tmp/workspace",
    });

    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    // No skill tools should appear (no registry, no code skills)
    expect(names).not.toContain("calc");
    expect(names).not.toContain("mock-skill");
  });
});
