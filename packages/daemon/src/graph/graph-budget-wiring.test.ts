// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const daemonSource = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");

describe("graph durable budget composition wiring", () => {
  it("threads the live tree-wide budget exporter into graph checkpoints", () => {
    expect(daemonSource).toContain("durableBudgetState?:");
    expect(daemonSource).toContain("durableBudgetState: (rootRunId: string) =>");
    expect(daemonSource).toContain("boundedAutonomy.exportBudgetState(rootRunId)");
    expect(daemonSource).toContain("durableBudgetState: deps.durableBudgetState");
  });
});
