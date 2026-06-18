// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { OrchestrationConfigSchema } from "./schema-orchestration.js";

/**
 * Phase 174 / v2.27 P2 — orchestration.authoring gate.
 *
 * The load-bearing invariant (D-GATED-OFF / N4): every authoring flag ships
 * `.default(false)`, so an empty config yields the inert all-false section and
 * behavior stays byte-identical to today. The 173 pipeline-authoring gate
 * returned DEFER (173-GATE-DECISION.md) — the operator flips a flag only on
 * real telemetry, never the schema.
 */
describe("OrchestrationConfigSchema authoring gate (D-GATED-OFF)", () => {
  it("defaults every authoring flag to false on an empty config", () => {
    const parsed = OrchestrationConfigSchema.parse({});
    expect(parsed).toStrictEqual({
      authoring: {
        intentAction: false,
        repairProducer: false,
        gbnfConstrain: false,
      },
    });
  });

  it("defaults the nested authoring flags when authoring is an empty object", () => {
    const parsed = OrchestrationConfigSchema.parse({ authoring: {} });
    expect(parsed.authoring).toStrictEqual({
      intentAction: false,
      repairProducer: false,
      gbnfConstrain: false,
    });
  });

  it("keeps the other two flags false when only repairProducer is enabled", () => {
    const parsed = OrchestrationConfigSchema.parse({
      authoring: { repairProducer: true },
    });
    expect(parsed.authoring).toStrictEqual({
      intentAction: false,
      repairProducer: true,
      gbnfConstrain: false,
    });
  });

  it("rejects a non-boolean flag value without silent coercion", () => {
    const result = OrchestrationConfigSchema.safeParse({
      authoring: { repairProducer: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside authoring via strictObject", () => {
    const result = OrchestrationConfigSchema.safeParse({
      authoring: { unknownFlag: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key via strictObject", () => {
    const result = OrchestrationConfigSchema.safeParse({ unexpected: true });
    expect(result.success).toBe(false);
  });
});
