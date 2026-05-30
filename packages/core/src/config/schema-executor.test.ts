// SPDX-License-Identifier: Apache-2.0
/**
 * T-02-1..T-02-5 — INTEG-02 executor.broker config schema tests.
 *
 * RED phase: schema-executor.ts does not exist yet.
 * - T-02-1, T-02-3, T-02-4 FAIL because AppConfigSchema rejects the `executor` key.
 * - T-02-2 may pass (omitting unknown keys is fine for strict mode).
 * - T-02-5 FAILS because the exports do not exist yet.
 *
 * GREEN phase: after schema-executor.ts is created and wired into AppConfigSchema
 * and index.ts, all five pass.
 */
import { describe, it, expect } from "vitest";
import { AppConfigSchema } from "./schema.js";
import type {
  BrokerBindingConfigSchema as _BrokerBindingConfigSchemaType,
  ExecutorConfigSchema as _ExecutorConfigSchemaType,
  ExecutorBrokerConfigSchema as _ExecutorBrokerConfigSchemaType,
  ExecutorConfig,
  ExecutorBrokerConfig,
} from "./index.js";

// T-02-5: verify the schemas are exported at type level from the config barrel.
// These `satisfies` declarations force the TypeScript compiler to check the
// named exports resolve — a pure type-import test with zero runtime cost.
// They will fail with a TS error if the exports are absent.
import {
  BrokerBindingConfigSchema,
  ExecutorConfigSchema,
  ExecutorBrokerConfigSchema,
} from "./index.js";

// Static type checks (compile-time only).
const _checkBrokerBinding: typeof BrokerBindingConfigSchema = BrokerBindingConfigSchema;
const _checkExecutorConfig: typeof ExecutorConfigSchema = ExecutorConfigSchema;
const _checkExecutorBroker: typeof ExecutorBrokerConfigSchema = ExecutorBrokerConfigSchema;
// Prevent TS "declared but never read" warnings.
void _checkBrokerBinding;
void _checkExecutorConfig;
void _checkExecutorBroker;

// Minimal valid hostRule fixture used in T-02-1 and T-02-3.
const validHostRule = {
  pattern: { kind: "exact" as const, host: "api.anthropic.com" },
  inject: [{ kind: "setHeader" as const, name: "x-api-key", format: "raw" as const }],
};

describe("INTEG-02 executor.broker schema", () => {
  // ── T-02-1 ────────────────────────────────────────────────────────────────
  it("T-02-1: AppConfigSchema accepts executor.broker.bindings with a valid anthropic binding", () => {
    const result = AppConfigSchema.safeParse({
      executor: {
        broker: {
          bindings: {
            anthropic: {
              hostRules: [validHostRule],
              secretRef: "k",
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.executor?.broker?.bindings?.anthropic?.secretRef).toBe("k");
  });

  // ── T-02-2 ────────────────────────────────────────────────────────────────
  it("T-02-2: AppConfigSchema parses cleanly when executor key is omitted — zero regression", () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.executor).toBeUndefined();
  });

  // ── T-02-3 ────────────────────────────────────────────────────────────────
  it("T-02-3: AppConfigSchema rejects unknown key inside executor.broker.bindings entry (z.strictObject)", () => {
    const result = AppConfigSchema.safeParse({
      executor: {
        broker: {
          bindings: {
            bad: {
              UNKNOWN_KEY: 1,
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  // ── T-02-4 ────────────────────────────────────────────────────────────────
  it("T-02-4: AppConfigSchema rejects unknown key directly inside executor (z.strictObject on ExecutorConfigSchema)", () => {
    const result = AppConfigSchema.safeParse({
      executor: {
        UNKNOWN_KEY: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  // ── T-02-5 ────────────────────────────────────────────────────────────────
  // This test is purely structural: if the imports above compiled and the
  // schema values were assigned, the exports exist. We assert they are
  // Zod schemas by checking the `.parse` method is callable.
  it("T-02-5: BrokerBindingConfigSchema, ExecutorConfigSchema, ExecutorBrokerConfigSchema are exported from config barrel and are callable Zod schemas", () => {
    expect(typeof BrokerBindingConfigSchema.safeParse).toBe("function");
    expect(typeof ExecutorConfigSchema.safeParse).toBe("function");
    expect(typeof ExecutorBrokerConfigSchema.safeParse).toBe("function");

    // Type-level confirmation: ExecutorConfig and ExecutorBrokerConfig are inferred.
    const sample: ExecutorConfig = { broker: undefined };
    const sampleBroker: ExecutorBrokerConfig = { port: 0, bindings: {} };
    void sample;
    void sampleBroker;
  });
});
