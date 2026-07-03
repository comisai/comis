// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { OrchestrationConfigSchema } from "./schema-orchestration.js";

/**
 * The orchestration.authoring gate.
 *
 * The load-bearing invariant: every authoring flag ships
 * `.default(false)`, so an empty config yields the inert all-false section and
 * behavior stays byte-identical to a build without the feature. The operator
 * flips a flag only on real telemetry — the schema never defaults one on.
 */
describe("OrchestrationConfigSchema authoring gate (ships gated-off)", () => {
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
