// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { rootCause } from "./obs-explain-heuristics.js";

function makeSignals(overrides: Partial<IncidentSignals>): IncidentSignals {
  return {
    sessionKey: "test-session",
    toolStats: {},
    failures: [],
    breakerEvents: [],
    offloads: [],
    hasDoNotRetrySignal: false,
    repeatedFailureCount: {},
    hasMisclassificationSignal: false,
    ...overrides,
  };
}

describe("spawn ceiling incident verdict", () => {
  it("an acute spawn ceiling refusal outranks unrelated breaker state", () => {
    const verdict = rootCause(
      makeSignals({
        endReason: "completed_with_tool_errors",
        degraded: true,
        breakerOpenedTool: "mcp__fixture--read_source",
        hasDoNotRetrySignal: true,
        repeatedFailureCount: {},
        failures: [
          {
            seq: 42,
            toolName: "sessions_spawn",
            classifiedFailureBy: "runtime_guard",
            transportOk: false,
            errorKind: "resource",
            matchedRule: "spawn_ceiling",
            resultDigest: "spawn-limit",
            resultBytes: 222,
            errorPreview:
              '{"content":[{"type":"text","text":"[spawn_ceiling] Sub-agent spawn rejected: autonomy.spawn.maxConcurrentSelfAgents=4; current=4; reason=concurrency. Wait for a running sub-agent to finish before retrying."}]}',
          },
        ],
      }),
    );

    expect(verdict?.code).toBe("spawn_ceiling");
    expect(verdict?.detail).toContain(
      "autonomy.spawn.maxConcurrentSelfAgents=4; current=4",
    );
    expect(verdict?.detail).toContain("concurrency");
    expect(verdict?.detail).not.toContain("mcp__fixture--read_source");
    expect(verdict?.suggestedNextSteps.join(" ")).toContain(
      "autonomy.spawn.maxConcurrentSelfAgents",
    );
  });
});
