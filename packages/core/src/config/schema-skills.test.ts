// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SkillsConfigSchema, TerminalDriverConfigSchema } from "./schema-skills.js";

/**
 * Regression tests for tightening `minBm25Score` to z.number().min(0).max(1).
 *
 * discover_tools normalizes BM25 scores to [0, 1] before the floor applies.
 * A stale raw-score override like `2.5` would produce zero matches under the
 * new normalized semantics — hard-fail at config load is safer than silently
 * broken discovery (fail-fast at config load is the correct behaviour).
 */
describe("SkillsConfigSchema -- toolDiscovery.minBm25Score [.max(1) tightening]", () => {
  it("minBm25Score > 1.0 fails validation", () => {
    const result = SkillsConfigSchema.safeParse({ toolDiscovery: { minBm25Score: 2.5 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["toolDiscovery", "minBm25Score"]);
    }
  });

  it("minBm25Score == 1.0 is accepted (top-only mode)", () => {
    const result = SkillsConfigSchema.parse({ toolDiscovery: { minBm25Score: 1.0 } });
    expect(result.toolDiscovery.minBm25Score).toBe(1.0);
  });

  it("minBm25Score == 0 is accepted (floor disabled)", () => {
    const result = SkillsConfigSchema.parse({ toolDiscovery: { minBm25Score: 0 } });
    expect(result.toolDiscovery.minBm25Score).toBe(0);
  });

  it("minBm25Score default is 0.8", () => {
    const result = SkillsConfigSchema.parse({});
    expect(result.toolDiscovery.minBm25Score).toBe(0.8);
  });
});

/**
 * The closed `TerminalDriverConfig` schema. A `z.strictObject` at every
 * level rejects unknown/legacy keys by construction (a typo'd or injected key
 * throws at config load rather than being silently dropped — a restriction the
 * operator believes is in effect must actually be parsed). The whole spec §6
 * shape is implemented now so the operator allow-set round-trips.
 */
describe("TerminalDriverConfigSchema -- closed allow-set", () => {
  // A config whose allow[] has one FULL entry exercising every allow-entry field.
  const validCfg = {
    enabled: true,
    worker: {
      maxSessions: 8,
      idleTtlMs: 900_000,
      ringBytes: 262_144,
      stuckMs: 30_000,
      maxConcurrentAttentionTurns: 2,
    },
    defaults: { cols: 120, rows: 40, scrollback: 1000 },
    allow: [
      {
        id: "claude-code",
        match: {
          path: "/usr/local/bin/bash",
          argsPrefix: ["-lc"],
          hash: "sha256:abc123",
        },
        scope: {
          filesystem: "listed-paths",
          paths: ["/srv/work"],
          network: "listed-hosts",
          hosts: ["api.anthropic.com"],
          credentialHome: "include",
          uid: "dedicated",
        },
        autoAnswer: "all",
        hintPatterns: ["^Continue\\?"],
        consent: { acknowledgedRisk: true as const, acknowledgedAt: "2026-06-03T00:00:00Z" },
        limits: {
          maxSessions: 2,
          maxRequestsPerSession: 100,
          wallClockMs: 3_600_000,
          maxInteractions: 50,
        },
        approveOnCreate: true,
        backend: "tmux",
        hardening: "broker-decoy",
        brokerDecoy: {
          bindingHostPaths: ["/run/comis/broker.sock"],
          tokenSource: "comis-oauth",
          decoyPath: "/run/comis/decoy",
        },
      },
    ],
    redactSecrets: true,
    audit: { enabled: true },
  };

  it("round-trips the full allow-set (the entry survives parse byte-for-byte where it matters)", () => {
    const parsed = TerminalDriverConfigSchema.parse(validCfg);
    expect(parsed.allow).toHaveLength(1);
    expect(parsed.allow[0]!.id).toBe("claude-code");
    expect(parsed.allow[0]!.match.path).toBe("/usr/local/bin/bash");
    expect(parsed.allow[0]!.match.argsPrefix).toEqual(["-lc"]);
    expect(parsed.allow[0]!.scope.filesystem).toBe("listed-paths");
    expect(parsed.allow[0]!.scope.credentialHome).toBe("include");
    expect(parsed.allow[0]!.consent.acknowledgedRisk).toBe(true);
    expect(parsed.allow[0]!.brokerDecoy?.tokenSource).toBe("comis-oauth");
  });

  it("rejects an unknown top-level key (closed schema)", () => {
    const result = TerminalDriverConfigSchema.safeParse({ ...validCfg, bogusKey: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown NESTED key (scope strictObject is closed too)", () => {
    const withNestedUnknown = structuredClone(validCfg) as Record<string, unknown>;
    // allow[0].scope.extra is not a member of the closed scope schema.
    (withNestedUnknown.allow as Array<{ scope: Record<string, unknown> }>)[0]!.scope.extra = "x";
    const result = TerminalDriverConfigSchema.safeParse(withNestedUnknown);
    expect(result.success).toBe(false);
  });

  it("applies the documented defaults (allow=[], credentialHome=exclude, autoAnswer=safe-only)", () => {
    // Omit `allow` entirely → defaults to [].
    const minimal = {
      enabled: false,
      worker: {
        maxSessions: 1,
        idleTtlMs: 1,
        ringBytes: 1,
        stuckMs: 1,
        maxConcurrentAttentionTurns: 1,
      },
      defaults: { cols: 80, rows: 24, scrollback: 0 },
      redactSecrets: false,
      audit: { enabled: false },
    };
    const parsed = TerminalDriverConfigSchema.parse(minimal);
    expect(parsed.allow).toEqual([]);

    // Omit scope.credentialHome / autoAnswer on an entry → documented defaults.
    const withEntryDefaults = TerminalDriverConfigSchema.parse({
      ...minimal,
      allow: [
        {
          id: "bash",
          match: { path: "/bin/bash" },
          scope: { filesystem: "workspace", network: "none", uid: "dedicated" },
          consent: { acknowledgedRisk: true as const, acknowledgedAt: "2026-06-03T00:00:00Z" },
        },
      ],
    });
    expect(withEntryDefaults.allow[0]!.scope.credentialHome).toBe("exclude");
    expect(withEntryDefaults.allow[0]!.autoAnswer).toBe("safe-only");
    expect(withEntryDefaults.allow[0]!.scope.filesystem).toBe("workspace");
    expect(withEntryDefaults.allow[0]!.scope.network).toBe("none");
    expect(withEntryDefaults.allow[0]!.hardening).toBe("none");
  });
});
