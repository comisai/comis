// SPDX-License-Identifier: Apache-2.0
import { computeWorkspacePolicyCombinedHash, type WorkspacePolicySnapshot } from "@comis/core";
import { err, ok } from "@comis/shared";
import { describe, expect, it, vi } from "vitest";
import { resolveCapturedWorkspacePolicy } from "./workspace-policy-snapshot-resolution.js";

const SNAPSHOT: WorkspacePolicySnapshot = {
  agentId: "agent_a",
  sections: [],
  combinedHash: computeWorkspacePolicyCombinedHash([]),
};

describe("resolveCapturedWorkspacePolicy", () => {
  it("selects the captured snapshot without attempting a cold reload", async () => {
    const load = vi.fn(async () => err({
      kind: "io" as const,
      agentId: "agent_a",
      fileName: "AGENTS.md",
    }));

    await expect(resolveCapturedWorkspacePolicy({
      get: vi.fn(() => ok(SNAPSHOT)),
      load,
    }, SNAPSHOT.agentId, SNAPSHOT.combinedHash)).resolves.toEqual(ok(SNAPSHOT));
    expect(load).not.toHaveBeenCalled();
  });
});
