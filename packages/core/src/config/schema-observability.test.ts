// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ObservabilityConfigSchema } from "./schema-observability.js";

describe("ObservabilityConfigSchema", () => {
  it("produces valid defaults from empty object", () => {
    const result = ObservabilityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.enabled).toBe(true);
      expect(result.data.persistence.retentionDays).toBe(30);
      expect(result.data.persistence.snapshotIntervalMs).toBe(300000);
    }
  });

  it("accepts enabled: false", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.enabled).toBe(false);
    }
  });

  it("accepts custom retentionDays within range", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 90 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.retentionDays).toBe(90);
    }
  });

  it("rejects retentionDays of 0 (min is 1)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects retentionDays of 366 (max is 365)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 366 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects snapshotIntervalMs below 60000", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { snapshotIntervalMs: 30000 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts snapshotIntervalMs at minimum (60000)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { snapshotIntervalMs: 60000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persistence.snapshotIntervalMs).toBe(60000);
    }
  });

  it("rejects extra keys via strictObject", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { enabled: true, unknownField: "fail" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys at root level via strictObject", () => {
    const result = ObservabilityConfigSchema.safeParse({
      unknownRoot: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer retentionDays", () => {
    const result = ObservabilityConfigSchema.safeParse({
      persistence: { retentionDays: 30.5 },
    });
    expect(result.success).toBe(false);
  });

  // trajectory key — strictObject rejects unknown keys.

  it("accepts trajectory.dirOverride string", () => {
    const result = ObservabilityConfigSchema.safeParse({
      trajectory: { dirOverride: "/var/comis/trj" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trajectory?.dirOverride).toBe("/var/comis/trj");
    }
  });

  it("strictly rejects trajectory.unknownKey (strictObject enforcement)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      trajectory: { unknownKey: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("back-compat: omitting trajectory produces trajectory:{}", () => {
    const result = ObservabilityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // trajectory must exist (with default {}) and dirOverride must be
      // undefined (not set) — proves existing YAML without observability.trajectory
      // still parses and the schema is back-compat.
      expect(result.data).toHaveProperty("trajectory");
      expect(result.data.trajectory?.dirOverride).toBeUndefined();
    }
  });

  // logRotation key.

  it("returns logRotation defaults with maxSizeBytes=52428800", () => {
    const result = ObservabilityConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logRotation).toBeDefined();
      expect(result.data.logRotation.maxSizeBytes).toBe(52428800);
      expect(result.data.logRotation.maxFiles).toBe(5);
      expect(result.data.logRotation.maxAgeDays).toBe(30);
      expect(result.data.logRotation.compressAged).toBe(true);
    }
  });

  it("accepts logRotation.maxSizeBytes override", () => {
    const result = ObservabilityConfigSchema.safeParse({
      logRotation: { maxSizeBytes: 100 * 1024 * 1024 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logRotation.maxSizeBytes).toBe(100 * 1024 * 1024);
    }
  });

  it("rejects logRotation.maxFiles=0 (positive int required)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      logRotation: { maxFiles: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects logRotation.maxSizeBytes=-1 (positive int required)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      logRotation: { maxSizeBytes: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects logRotation.extraField (strictObject enforcement)", () => {
    const result = ObservabilityConfigSchema.safeParse({
      logRotation: { extraField: "x" },
    });
    expect(result.success).toBe(false);
  });

  // alertBudget key.

  describe("alertBudget", () => {
    it("alertBudget defaults: enabled === true", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alertBudget.enabled).toBe(true);
      }
    });

    it("alertBudget.thresholds.network defaults to { count: 100, windowMs: 60000 }", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alertBudget.thresholds.network).toEqual({ count: 100, windowMs: 60000 });
      }
    });

    it("alertBudget.thresholds.internal defaults to { count: 5, windowMs: 60000 }", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alertBudget.thresholds.internal).toEqual({ count: 5, windowMs: 60000 });
      }
    });

    it("all 10 errorKind names present as keys under thresholds", () => {
      const errorKinds = [
        "network", "config", "auth", "validation", "precondition",
        "timeout", "resource", "dependency", "internal", "platform",
      ];
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        for (const kind of errorKinds) {
          expect(result.data.alertBudget.thresholds[kind], `missing errorKind: ${kind}`).toBeDefined();
        }
      }
    });

    it("override accepted: network threshold count can be set to 200 / windowMs to 30000", () => {
      const result = ObservabilityConfigSchema.safeParse({
        alertBudget: { thresholds: { network: { count: 200, windowMs: 30000 } } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.alertBudget.thresholds.network?.count).toBe(200);
        expect(result.data.alertBudget.thresholds.network?.windowMs).toBe(30000);
      }
    });

    it("rejects zero count (z.number().int().positive() required)", () => {
      const result = ObservabilityConfigSchema.safeParse({
        alertBudget: { thresholds: { network: { count: 0, windowMs: 60000 } } },
      });
      expect(result.success).toBe(false);
    });
  });

  // audit key + persistence.cacheBreaks (PERSIST-01 / AUDIT-01).
  describe("audit + persistence.cacheBreaks", () => {
    it("parses audit:{persist,sink} + persistence:{cacheBreaks} on the strictObject", () => {
      const result = ObservabilityConfigSchema.safeParse({
        audit: { persist: true, sink: "both" },
        persistence: { cacheBreaks: true },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.audit.persist).toBe(true);
        expect(result.data.audit.sink).toBe("both");
        expect(result.data.persistence.cacheBreaks).toBe(true);
      }
    });

    it("resolves safe defaults: audit deep-equals {persist:true,sink:'both'}; persistence.cacheBreaks===true", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.audit).toEqual({ persist: true, sink: "both" });
        expect(result.data.persistence.cacheBreaks).toBe(true);
      }
    });

    it("rejects a typo'd TOP-LEVEL persist key (strictObject — proves no colliding persist was added)", () => {
      const result = ObservabilityConfigSchema.safeParse({ persist: true });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid audit.sink enum value", () => {
      const result = ObservabilityConfigSchema.safeParse({ audit: { sink: "nope" } });
      expect(result.success).toBe(false);
    });
  });

  // spend key (SPEND-01) — the kill-switch opt-in surface. Ships OFF: all
  // three ceilings default null, action 'warn'. Mirrors the audit block's
  // default + strict-reject + enum-validation shape.
  describe("spend (SPEND-01)", () => {
    it("resolves safe defaults: all three ceilings null (off), action 'warn', warnAtFraction 0.8, perTurnMax 0.5, pricingFallback 'snapshot', onUnknownPricing 'warn'", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.spend).toEqual({
          perAgentUsd: null,
          perTenantUsd: null,
          daemonGlobalUsd: null,
          perTurnMax: 0.5,
          action: "warn",
          warnAtFraction: 0.8,
          pricingFallback: "snapshot",
          onUnknownPricing: "warn",
        });
      }
    });

    it("null ceilings = off: the three ceilings each default null (the opt-in invariant)", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.spend.perAgentUsd).toBeNull();
        expect(result.data.spend.perTenantUsd).toBeNull();
        expect(result.data.spend.daemonGlobalUsd).toBeNull();
      }
    });

    it("rejects a typo'd key under spend (strictObject)", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { perAgentUsdd: 5 } });
      expect(result.success).toBe(false);
    });

    it("parses valid ceilings + actions and round-trips them", () => {
      const result = ObservabilityConfigSchema.safeParse({
        spend: { perAgentUsd: 10, action: "abort", onUnknownPricing: "abort" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.spend.perAgentUsd).toBe(10);
        expect(result.data.spend.action).toBe("abort");
        expect(result.data.spend.onUnknownPricing).toBe("abort");
        // unset ceilings stay null (off).
        expect(result.data.spend.perTenantUsd).toBeNull();
        expect(result.data.spend.daemonGlobalUsd).toBeNull();
      }
    });

    it("rejects a zero ceiling (positive required)", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { perAgentUsd: 0 } });
      expect(result.success).toBe(false);
    });

    it("rejects a negative ceiling (positive required)", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { daemonGlobalUsd: -1 } });
      expect(result.success).toBe(false);
    });

    it("rejects a zero perTurnMax (positive required)", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { perTurnMax: 0 } });
      expect(result.success).toBe(false);
    });

    it("rejects warnAtFraction above 1 (bounded [0,1])", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { warnAtFraction: 1.5 } });
      expect(result.success).toBe(false);
    });

    it("rejects warnAtFraction below 0 (bounded [0,1])", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { warnAtFraction: -0.1 } });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid action enum value", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { action: "kill" } });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid pricingFallback enum value (single current member 'snapshot')", () => {
      const result = ObservabilityConfigSchema.safeParse({ spend: { pricingFallback: "live" } });
      expect(result.success).toBe(false);
    });
  });
});
