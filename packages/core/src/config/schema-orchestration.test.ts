// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { OrchestrationConfigSchema } from "./schema-orchestration.js";

/**
 * The orchestration.authoring gate.
 *
 * Full-capability-by-default: every authoring flag ships `.default(true)`, so an
 * empty config yields all-on authoring (small-model-authorable DAGs available
 * out of the box). An operator flips a flag to `false` to opt a specific aid out.
 */
describe("OrchestrationConfigSchema authoring gate (ships enabled by default)", () => {
  it("defaults every authoring flag to true on an empty config", () => {
    const parsed = OrchestrationConfigSchema.parse({});
    expect(parsed).toStrictEqual({
      authoring: {
        intentAction: true,
        repairProducer: true,
        gbnfConstrain: true,
      },
    });
  });

  it("defaults the nested authoring flags to true when authoring is an empty object", () => {
    const parsed = OrchestrationConfigSchema.parse({ authoring: {} });
    expect(parsed.authoring).toStrictEqual({
      intentAction: true,
      repairProducer: true,
      gbnfConstrain: true,
    });
  });

  it("honors an explicit false while the other two stay at their true default", () => {
    const parsed = OrchestrationConfigSchema.parse({
      authoring: { repairProducer: false },
    });
    expect(parsed.authoring).toStrictEqual({
      intentAction: true,
      repairProducer: false,
      gbnfConstrain: true,
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
