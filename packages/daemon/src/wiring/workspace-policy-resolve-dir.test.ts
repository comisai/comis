// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { AppConfig } from "@comis/core";
import { createWorkspacePolicyResolveDir } from "./workspace-policy-resolve-dir.js";

function configWith(agentIds: string[], dataDir: string): AppConfig {
  const agents: Record<string, unknown> = {};
  for (const id of agentIds) agents[id] = {};
  return { agents, dataDir } as unknown as AppConfig;
}

describe("createWorkspacePolicyResolveDir", () => {
  it("reads the LIVE config on every call, not a snapshot captured at construction", () => {
    // Mirror the daemon boot flow: the adapter is constructed against the
    // bootstrap config (only `default`), then boot structuredClone-s the config
    // for secret-ref resolution and `agents.create` hot-adds `loop-rs-a` into
    // that new, live map. A captured-snapshot closure would still see only the
    // bootstrap map and report the running agent as not-found.
    let live: AppConfig = configWith(["default"], "/data/base");
    const resolve = createWorkspacePolicyResolveDir(() => live);

    // Before the hot-add: default resolves, the not-yet-created agent does not.
    expect(resolve("default")).toBe("/data/base/workspace");
    expect(resolve("loop-rs-a")).toBeUndefined();

    // Post-clone + hot-add: a brand-new live config object carrying the added
    // agent. The closure must observe it without being rebuilt.
    live = configWith(["default", "loop-rs-a"], "/data/base");
    expect(resolve("loop-rs-a")).toBe("/data/base/workspace-loop-rs-a");
  });

  it("resolves named-agent workspaces from the live dataDir", () => {
    const live = configWith(["default", "cache-g-a1"], "/live/dir");
    const resolve = createWorkspacePolicyResolveDir(() => live);
    expect(resolve("cache-g-a1")).toBe("/live/dir/workspace-cache-g-a1");
  });

  it("returns undefined only when the agent is genuinely absent from live config", () => {
    const live = configWith(["default"], "/data/base");
    const resolve = createWorkspacePolicyResolveDir(() => live);
    expect(resolve("never-created")).toBeUndefined();
  });
});
