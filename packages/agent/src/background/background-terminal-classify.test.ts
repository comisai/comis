// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { projectBackgroundTaskFailure } from "./background-terminal-classify.js";

describe("background terminal failure classification", () => {
  it("retains bounded MCP queue contention diagnostics through causes", () => {
    const cause = Object.assign(new Error("external details"), {
      code: "mcp_queue_contention",
      configKey: "integrations.mcp.servers[].maxConcurrency",
      serverName: "records",
      configuredConcurrency: 2,
      configuredMs: 120_000,
      queueWaitedMs: 119_800,
      requestBudgetMs: 200,
      minViableMs: 250,
    });
    const error = Object.assign(new Error("wrapped"), { cause });

    expect(projectBackgroundTaskFailure("mcp__records--summary", error)).toEqual({
      failureCode: "mcp_queue_contention",
      failureDiagnostic: {
        kind: "mcp_queue_contention",
        configKey: "integrations.mcp.servers[].maxConcurrency",
        serverName: "records",
        configuredConcurrency: 2,
        configuredMs: 120_000,
        queueWaitedMs: 119_800,
        requestBudgetMs: 200,
        minViableMs: 250,
      },
    });
  });
});
