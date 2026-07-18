// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  assembleRichSystemPrompt,
  assembleRichSystemPromptBlocks,
  buildBootstrapContextFiles,
  type BootstrapFile,
} from "./index.js";

function workspaceFiles(): BootstrapFile[] {
  return [{
    name: "ROLE.md",
    path: "/workspace/ROLE.md",
    content: "Follow the configured operator boundary.",
    missing: false,
  }, {
    name: "BOOTSTRAP.md",
    path: "/workspace/BOOTSTRAP.md",
    content: "Temporary setup state.",
    missing: false,
  }];
}

describe("workspace policy prompt integration", () => {
  it("preserves loaded workspace content while attributing its policy tier", () => {
    const bootstrapFiles = buildBootstrapContextFiles(workspaceFiles(), {
      maxCharsPerFile: 2_000,
      totalMaxChars: 4_000,
    });
    const blocks = assembleRichSystemPromptBlocks({ bootstrapFiles });

    expect(blocks.attribution).toContain("Follow the configured operator boundary");
    expect(blocks.attribution).not.toContain("Temporary setup state");
    expect(blocks.semiStableBody).toContain("Temporary setup state");
  });

  it("does not inject synthetic missing-file markers into policy", () => {
    const bootstrapFiles = buildBootstrapContextFiles([{
      name: "ROLE.md",
      path: "/workspace/ROLE.md",
      missing: true,
    }], { maxCharsPerFile: 2_000, totalMaxChars: 4_000 });

    expect(assembleRichSystemPrompt({ bootstrapFiles })).not.toContain("[MISSING]");
  });

  it("keeps engine invariants present in every supported prompt mode", () => {
    for (const promptMode of ["full", "operational", "minimal", "none", "compact-secure"] as const) {
      const prompt = assembleRichSystemPrompt({ promptMode });
      expect(prompt).toContain("Respect approval, capability, sandbox, and security outcomes");
      expect(prompt).toContain("Do not expose secrets");
    }
  });

});
