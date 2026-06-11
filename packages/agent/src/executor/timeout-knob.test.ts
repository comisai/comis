// SPDX-License-Identifier: Apache-2.0
/**
 * Exact-string pins for describeTimeoutKnob (LAT-01) — the source→knob
 * templating every timeout hint/payload renders from (the KNOB-02
 * CAP_KNOB_BY_SOURCE table discipline, context-engine/errors.ts:39-47).
 *
 * Two load-bearing pins:
 * - The operation knob's REAL config key is `timeout`, NOT the doc-lie
 *   `timeoutMs`: OperationModelEntrySchema is strictObject, so a hint naming
 *   the documented `timeoutMs` would send the operator to a key the config
 *   parser REJECTS (177-RESEARCH Critical Finding 2).
 * - `graph_constant` gets honest prose, never a rendered fake `agents.*` key
 *   (D-11 — the dead-knob lie class this phase kills).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { describeTimeoutKnob, describeRetryTimeoutKnob } from "./timeout-knob.js";

describe("describeTimeoutKnob (LAT-01 knob table)", () => {
  it("LAT-01-6: agent_config and builtin_default both name agents.<id>.promptTimeout.promptTimeoutMs — the knob to RAISE is identical", () => {
    expect(describeTimeoutKnob("agent_config", "my-agent", undefined)).toBe(
      "agents.my-agent.promptTimeout.promptTimeoutMs",
    );
    // The built-in 180s default only applies when the agent key is unset —
    // raising the SAME agent key is the remedy for both sources.
    expect(describeTimeoutKnob("builtin_default", "my-agent", undefined)).toBe(
      "agents.my-agent.promptTimeout.promptTimeoutMs",
    );
  });

  it("LAT-01-7: operation_explicit and operation_default name agents.<id>.operationModels.<op>.timeout — the key is timeout, never the doc-lie timeoutMs", () => {
    const explicit = describeTimeoutKnob("operation_explicit", "my-agent", "cron");
    const opDefault = describeTimeoutKnob("operation_default", "my-agent", "cron");
    expect(explicit).toBe("agents.my-agent.operationModels.cron.timeout");
    expect(opDefault).toBe("agents.my-agent.operationModels.cron.timeout");
    // Critical Finding 2: the strictObject parser rejects `timeoutMs` with
    // unrecognized_keys — the rendered knob must end with `.timeout` and must
    // never contain the doc-lie key.
    expect(explicit.endsWith(".timeout")).toBe(true);
    expect(opDefault.endsWith(".timeout")).toBe(true);
    expect(explicit).not.toContain("timeoutMs");
    expect(opDefault).not.toContain("timeoutMs");
  });

  it("LAT-01-8: graph_constant renders honest prose (600000ms, not operator-tunable) and never a fake agents.* knob (D-11)", () => {
    const prose = describeTimeoutKnob("graph_constant", "my-agent", "subagent");
    expect(prose).toContain("600000");
    expect(prose).toContain("not operator-tunable");
    expect(prose).not.toContain("agents.");
  });

  it("LAT-01-9: undefined agentId renders the literal agents.<id> placeholder (docs convention) with the correct key tail", () => {
    expect(describeTimeoutKnob("agent_config", undefined, undefined)).toBe(
      "agents.<id>.promptTimeout.promptTimeoutMs",
    );
    expect(describeTimeoutKnob("operation_default", undefined, "cron")).toBe(
      "agents.<id>.operationModels.cron.timeout",
    );
    // Operation sources with no operationType still render the placeholder
    // form ending in the real key.
    expect(describeTimeoutKnob("operation_explicit", undefined, undefined)).toBe(
      "agents.<id>.operationModels.<op>.timeout",
    );
  });

  it("177-REVIEW WR-01: describeRetryTimeoutKnob names the whole-turn retry key (retryPromptTimeoutMs) with the same placeholder discipline", () => {
    // The retry/fallback/LKW whole-turn race (limit ABSENT on the error) is
    // governed by retryPromptTimeoutMs, never the source-table stall knob —
    // every retry-site emit and the classify hint render from this helper.
    expect(describeRetryTimeoutKnob("my-agent")).toBe(
      "agents.my-agent.promptTimeout.retryPromptTimeoutMs",
    );
    expect(describeRetryTimeoutKnob(undefined)).toBe(
      "agents.<id>.promptTimeout.retryPromptTimeoutMs",
    );
  });
});
