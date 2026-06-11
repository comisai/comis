// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the lean-description resolution leaf (extracted from
 * setup-agents-runtime.ts to keep that file under the per-subdirectory size
 * cap). Drives the REAL `LEAN_TOOL_DESCRIPTIONS` / `resolveDescription`
 * exports — no mocks — so the leaf's behavior matches what setupSingleAgent
 * shipped before the extraction.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { LEAN_TOOL_DESCRIPTIONS } from "@comis/agent";
import { PerAgentConfigSchema, type PerAgentConfig } from "@comis/core";
import { resolveLeanDescriptionsForAgent } from "./setup-agents-descriptions.js";

function makeLogger(): { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn() };
}

function makeConfig(extra: Record<string, unknown> = {}): PerAgentConfig {
  return PerAgentConfigSchema.parse({ name: "t", model: "m", provider: "p", ...extra });
}

describe("resolveLeanDescriptionsForAgent", () => {
  it("resolves a non-empty description for every LEAN_TOOL_DESCRIPTIONS key", () => {
    const logger = makeLogger();
    const resolved = resolveLeanDescriptionsForAgent(makeConfig(), logger as never);

    const keys = Object.keys(LEAN_TOOL_DESCRIPTIONS);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(typeof resolved[key]).toBe("string");
      expect((resolved[key] ?? "").length).toBeGreaterThan(0);
    }
    expect(Object.keys(resolved)).toEqual(keys);
  });

  it("emits ONE 'Tool descriptions resolved' INFO with the telemetry fields and the large default tier", () => {
    const logger = makeLogger();
    resolveLeanDescriptionsForAgent(makeConfig(), logger as never);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("Tool descriptions resolved");
    expect(fields).toMatchObject({ modelTier: "large" });
    expect(typeof fields["descriptionCount"]).toBe("number");
    expect(typeof fields["tokenCount"]).toBe("number");
    expect(typeof fields["dynamicCount"]).toBe("number");
    expect(typeof fields["overLimitCount"]).toBe("number");
  });

  it("selects the small lean tier when bootstrap.promptMode is minimal", () => {
    const logger = makeLogger();
    resolveLeanDescriptionsForAgent(makeConfig({ bootstrap: { promptMode: "minimal" } }), logger as never);

    const [fields] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields["modelTier"]).toBe("small");
  });
});
