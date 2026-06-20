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

  // otel key (OTEL-01/02/03) — the OTLP push surface opt-in. Ships OFF
  // (enabled:false); content-free by default (captureContent:false,
  // genaiSemconv:false). LOCKED shape: design §9/§14 + 178-RESEARCH §14.
  describe("otel (OTEL-01/02/03)", () => {
    it("resolves safe defaults: enabled false, endpoint '', protocol 'http/protobuf', traces/metrics/logs true, genaiSemconv/captureContent false", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.otel).toEqual({
          enabled: false,
          endpoint: "",
          protocol: "http/protobuf",
          traces: true,
          metrics: true,
          logs: true,
          genaiSemconv: false,
          captureContent: false,
        });
      }
    });

    it("content-free invariant: captureContent + genaiSemconv each default false (the opt-in content gates)", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.otel.captureContent).toBe(false);
        expect(result.data.otel.genaiSemconv).toBe(false);
      }
    });

    it("parses otel.enabled:true + an endpoint + the semconv/content gates and round-trips them", () => {
      const result = ObservabilityConfigSchema.safeParse({
        otel: { enabled: true, endpoint: "http://collector:4318", genaiSemconv: true, captureContent: true },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.otel.enabled).toBe(true);
        expect(result.data.otel.endpoint).toBe("http://collector:4318");
        expect(result.data.otel.genaiSemconv).toBe(true);
        expect(result.data.otel.captureContent).toBe(true);
      }
    });

    it("accepts protocol 'grpc' (validates; falls back to -proto with a WARN at runtime — a documented later addition)", () => {
      const result = ObservabilityConfigSchema.safeParse({ otel: { protocol: "grpc" } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.otel.protocol).toBe("grpc");
      }
    });

    it("rejects an invalid protocol enum value", () => {
      const result = ObservabilityConfigSchema.safeParse({ otel: { protocol: "carrier-pigeon" } });
      expect(result.success).toBe(false);
    });

    it("rejects a typo'd key under otel (strictObject)", () => {
      const result = ObservabilityConfigSchema.safeParse({ otel: { bogus: true } });
      expect(result.success).toBe(false);
    });
  });

  // prometheus key (PROM-01) — the standalone /metrics pull surface. INDEPENDENT
  // of otel.enabled. Ships OFF (enabled:false); loopback-bound (127.0.0.1:9464);
  // trusted-operator posture. LOCKED shape: design §9/§14 + 178-RESEARCH §14.
  describe("prometheus (PROM-01)", () => {
    it("resolves safe defaults: enabled false, host 127.0.0.1, port 9464, path /metrics, auth trusted-operator, exemplars true, cardinalityCap 10000", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prometheus).toEqual({
          enabled: false,
          host: "127.0.0.1",
          port: 9464,
          path: "/metrics",
          auth: "trusted-operator",
          exemplars: true,
          cardinalityCap: 10000,
        });
      }
    });

    it("loopback-default invariant: host defaults to 127.0.0.1 (never 0.0.0.0 implicitly)", () => {
      const result = ObservabilityConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prometheus.host).toBe("127.0.0.1");
      }
    });

    it("parses prometheus.enabled:true + host/port and round-trips them (the standalone-/metrics surface)", () => {
      const result = ObservabilityConfigSchema.safeParse({
        prometheus: { enabled: true, host: "127.0.0.1", port: 19464, cardinalityCap: 5000 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.prometheus.enabled).toBe(true);
        expect(result.data.prometheus.host).toBe("127.0.0.1");
        expect(result.data.prometheus.port).toBe(19464);
        expect(result.data.prometheus.cardinalityCap).toBe(5000);
      }
    });

    it("rejects an invalid auth literal (only 'trusted-operator' — the OTel exporter has no built-in auth)", () => {
      const result = ObservabilityConfigSchema.safeParse({ prometheus: { auth: "bearer-token" } });
      expect(result.success).toBe(false);
    });

    it("rejects a non-integer port", () => {
      const result = ObservabilityConfigSchema.safeParse({ prometheus: { port: 9464.5 } });
      expect(result.success).toBe(false);
    });

    it("rejects a zero/negative cardinalityCap (positive int required)", () => {
      const zero = ObservabilityConfigSchema.safeParse({ prometheus: { cardinalityCap: 0 } });
      expect(zero.success).toBe(false);
      const neg = ObservabilityConfigSchema.safeParse({ prometheus: { cardinalityCap: -1 } });
      expect(neg.success).toBe(false);
    });

    it("rejects a typo'd key under prometheus (strictObject)", () => {
      const result = ObservabilityConfigSchema.safeParse({ prometheus: { bogus: true } });
      expect(result.success).toBe(false);
    });
  });
});
