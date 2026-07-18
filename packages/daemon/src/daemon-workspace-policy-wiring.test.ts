// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("daemon workspace policy composition", () => {
  it("constructs the filesystem adapter through the core bootstrap factory", () => {
    const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf-8");
    expect(source).toContain("workspacePolicyPortFactory:");
    expect(source).toContain("createFilesystemWorkspacePolicyAdapter({");
    expect(source).toContain("resolveWorkspaceDir(agentConfig, agentId, config.dataDir || undefined)");
  });
});
