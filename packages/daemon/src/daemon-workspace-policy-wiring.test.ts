// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("daemon workspace policy composition", () => {
  const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf-8");

  it("constructs the filesystem adapter through the core bootstrap factory", () => {
    expect(source).toContain("workspacePolicyPortFactory:");
    expect(source).toContain("createFilesystemWorkspacePolicyAdapter({");
  });

  it("resolves workspace dirs against the LIVE config, not the pre-clone snapshot", () => {
    // The adapter must read container.config (post secret-ref structuredClone,
    // mutated by agents.create hot-adds), never the config handed to the
    // factory. Regressing to a captured `config.agents[agentId]` deref reports
    // hot-added agents as agent_not_found and false-ERRORs their first turn.
    expect(source).toContain("createWorkspacePolicyResolveDir(");
    expect(source).toContain("workspacePolicyLiveConfig.current = container.config");
    expect(source).not.toContain("const agentConfig = config.agents[agentId];");
  });
});
