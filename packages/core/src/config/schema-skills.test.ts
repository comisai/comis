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

  // 124-09 (WR-01 closure): the interactive terminal driver config is now MOUNTED on
  // SkillsConfigSchema (it was an orphaned, unmounted schema). Optional + fail-closed:
  // absent ⇒ undefined (the daemon wires an empty allow-set + no reaper). When present
  // it round-trips so the daemon threads the allow-set + worker caps into the registry.
  it("terminal is OPTIONAL and absent by default (fail-closed: no terminal config ⇒ undefined)", () => {
    const result = SkillsConfigSchema.parse({});
    expect(result.terminal).toBeUndefined();
  });

  it("terminal round-trips through SkillsConfigSchema when present (the WR-01 config-plumbing seam)", () => {
    const result = SkillsConfigSchema.parse({
      terminal: {
        enabled: true,
        worker: { maxSessions: 4, idleTtlMs: 60_000, ringBytes: 65_536, stuckMs: 30_000, maxConcurrentAttentionTurns: 2 },
        defaults: { cols: 80, rows: 24, scrollback: 1000 },
        allow: [],
        redactSecrets: true,
        audit: { enabled: true },
      },
    });
    expect(result.terminal?.worker.maxSessions).toBe(4);
    expect(result.terminal?.worker.idleTtlMs).toBe(60_000);
    expect(result.terminal?.allow).toEqual([]);
  });

  it("terminal stays a closed strictObject inside skills (a typo'd terminal key rejects, OPS-02)", () => {
    const result = SkillsConfigSchema.safeParse({
      terminal: {
        enabled: true,
        worker: { maxSessions: 4, idleTtlMs: 60_000, ringBytes: 65_536, stuckMs: 30_000, maxConcurrentAttentionTurns: 2 },
        defaults: { cols: 80, rows: 24, scrollback: 1000 },
        allow: [],
        redactSecrets: true,
        audit: { enabled: true },
        bogusTerminalKey: 1,
      },
    });
    expect(result.success).toBe(false);
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
          credentialPaths: ["~/.claude"],
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
    expect(parsed.allow[0]!.scope.credentialPaths).toEqual(["~/.claude"]);
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

  it("applies the documented defaults (allow=[], credentialPaths=[], autoAnswer=safe-only)", () => {
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

    // Omit scope.credentialPaths / autoAnswer on an entry → documented defaults.
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
    expect(withEntryDefaults.allow[0]!.scope.credentialPaths).toEqual([]);
    expect(withEntryDefaults.allow[0]!.autoAnswer).toBe("safe-only");
    expect(withEntryDefaults.allow[0]!.scope.filesystem).toBe("workspace");
    expect(withEntryDefaults.allow[0]!.scope.network).toBe("none");
    expect(withEntryDefaults.allow[0]!.hardening).toBe("none");
  });
});

/**
 * OPS-05: the operator-dialable cgroup/`TasksMax` ceiling on the CLOSED `worker`
 * strictObject. The tmux backend (124-08) makes a worker's named sessions outlive
 * the worker; N concurrent memory-hungry sessions share one cgroup, so an operator
 * must be able to bound the concurrent-session subprocess footprint vs the systemd
 * `TasksMax` (T-124-22). The field is OPTIONAL — absent ⇒ bounded by `maxSessions`
 * alone — and the addition MUST NOT loosen the strictObject (an unknown worker key
 * still rejects). The whole `worker` block is the only P5 schema change: every other
 * attention field (autoAnswer/hintPatterns/backend/stuckMs/maxConcurrentAttentionTurns/
 * maxInteractions) is already declared.
 */
describe("TerminalDriverConfigSchema -- worker.tasksMax cgroup ceiling (OPS-05)", () => {
  // The minimal-but-valid base config the three tasksMax tests vary.
  const baseCfg = {
    enabled: true,
    worker: {
      maxSessions: 8,
      idleTtlMs: 900_000,
      ringBytes: 262_144,
      stuckMs: 30_000,
      maxConcurrentAttentionTurns: 2,
    },
    defaults: { cols: 120, rows: 40, scrollback: 1000 },
    redactSecrets: true,
    audit: { enabled: true },
  };

  it("accepts an operator-set worker.tasksMax ceiling (parses + round-trips the value)", () => {
    const parsed = TerminalDriverConfigSchema.parse({
      ...baseCfg,
      worker: { ...baseCfg.worker, tasksMax: 200 },
    });
    expect(parsed.worker.tasksMax).toBe(200);
  });

  it("parses with worker.tasksMax ABSENT (optional — no extra ceiling beyond maxSessions)", () => {
    const parsed = TerminalDriverConfigSchema.parse(baseCfg);
    expect(parsed.worker.tasksMax).toBeUndefined();
  });

  it("still REJECTS an unknown worker key (the tasksMax addition does not loosen the strictObject)", () => {
    const result = TerminalDriverConfigSchema.safeParse({
      ...baseCfg,
      worker: { ...baseCfg.worker, bogusWorkerKnob: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The unrecognized key is reported under the worker path (strictObject closed).
      expect(result.error.issues.some((i) => i.path.includes("worker"))).toBe(true);
    }
  });
});

/**
 * v2.24 (164-05, DRIVE-02/READ-01): the additive strict `drive{}` block on the
 * CLOSED `TerminalDriverConfig` schema. This phase introduces `drive.mode`
 * (`auto` default — auto-promote a genuinely-long drive; `attached` = today's
 * inline behavior; `detached` = promote at the first wait) and `drive.readMode`
 * (`digest` default — a bounded digest of the current screen; `diff` — only
 * changed rows; `full` — the whole screen, bounded). The block is OPTIONAL +
 * `z.strictObject`, so:
 *   - I1: a config with NO `drive` block parses byte-identical to today
 *     (`parsed.drive` is `undefined` — no behavior change for an unconfigured operator).
 *   - The per-field defaults preserve today's effective behavior (`mode:"auto"`
 *     only promotes a genuinely-long drive; `readMode:"digest"` is already the
 *     tool's effective default).
 *   - OPS-02: an unknown/typo'd `drive.*` key REJECTS at config load (a
 *     restriction the operator believes is in effect must actually be parsed).
 * Phases 165/166 extend this SAME block (durable/notify/heartbeat/maxCostUsd);
 * the optional-block + per-field-default discipline lets each phase's additions
 * be independent. Changing/adding a default regenerates the section-registry-parity
 * snapshot (a validate-only gate).
 */
describe("TerminalDriverConfigSchema -- additive strict drive{} block (DRIVE-02/READ-01)", () => {
  // The minimal-but-valid base config the drive tests vary.
  const baseCfg = {
    enabled: true,
    worker: {
      maxSessions: 8,
      idleTtlMs: 900_000,
      ringBytes: 262_144,
      stuckMs: 30_000,
      maxConcurrentAttentionTurns: 2,
    },
    defaults: { cols: 120, rows: 40, scrollback: 1000 },
    redactSecrets: true,
    audit: { enabled: true },
  };

  it("round-trips an explicit drive block (mode + readMode parse to the supplied values)", () => {
    const parsed = TerminalDriverConfigSchema.parse({
      ...baseCfg,
      drive: { mode: "detached", readMode: "diff" },
    });
    expect(parsed.drive?.mode).toBe("detached");
    expect(parsed.drive?.readMode).toBe("diff");
  });

  it("fills the per-field defaults on an EMPTY drive block (mode:auto, readMode:digest)", () => {
    const parsed = TerminalDriverConfigSchema.parse({ ...baseCfg, drive: {} });
    expect(parsed.drive?.mode).toBe("auto");
    expect(parsed.drive?.readMode).toBe("digest");
  });

  it("parses with the drive block ABSENT (I1 — byte-identical to today; parsed.drive is undefined)", () => {
    const parsed = TerminalDriverConfigSchema.parse(baseCfg);
    expect(parsed.drive).toBeUndefined();
  });

  it("REJECTS an unknown drive.* key (the block is a closed strictObject, OPS-02)", () => {
    const result = TerminalDriverConfigSchema.safeParse({
      ...baseCfg,
      drive: { mode: "auto", bogusDriveKnob: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The unrecognized key is reported under the drive path (strictObject closed).
      expect(result.error.issues.some((i) => i.path.includes("drive"))).toBe(true);
    }
  });

  it("REJECTS an out-of-enum drive.mode (only auto/attached/detached are valid)", () => {
    const result = TerminalDriverConfigSchema.safeParse({
      ...baseCfg,
      drive: { mode: "sideways" },
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS an out-of-enum drive.readMode (only digest/diff/full are valid)", () => {
    const result = TerminalDriverConfigSchema.safeParse({
      ...baseCfg,
      drive: { readMode: "verbose" },
    });
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Phase 165 (165-05, DUR-01/LIVE-01/ENDURE-01): the SAME additive strict
  // drive{} block gains three endurance/durability fields —
  //   durable     (bool,        default false)  — DUR-01: detached tmux + re-attach
  //   heartbeatMs (int>0,       default 90_000) — LIVE-01: internal liveness backstop interval
  //   maxCostUsd  (number|null, default null)   — ENDURE-01: per-drive spend ceiling
  // All three default to INERT (I1): a config with no drive block, or an empty
  // drive block, is byte-identical to today (durable:false, heartbeatMs:90000,
  // maxCostUsd:null). The block stays a closed strictObject (a typo'd key still
  // rejects). §7.1.5 LOCKED: drive.durable:true is ACCEPTED at config-validation —
  // tmux availability is a RUNTIME property (degrade + WARN at runtime), NOT a
  // config-time hard-require; a RED test pins durable:true parses with NO tmux check.
  it("round-trips durable/heartbeatMs/maxCostUsd (the three Phase-165 fields parse to the supplied values)", () => {
    const parsed = TerminalDriverConfigSchema.parse({
      ...baseCfg,
      drive: { durable: true, heartbeatMs: 90_000, maxCostUsd: 5 },
    });
    expect(parsed.drive?.durable).toBe(true);
    expect(parsed.drive?.heartbeatMs).toBe(90_000);
    expect(parsed.drive?.maxCostUsd).toBe(5);
  });

  it("fills the Phase-165 defaults on an EMPTY drive block (durable:false, heartbeatMs:90000, maxCostUsd:null — I1 inert)", () => {
    const parsed = TerminalDriverConfigSchema.parse({ ...baseCfg, drive: {} });
    expect(parsed.drive?.durable).toBe(false);
    expect(parsed.drive?.heartbeatMs).toBe(90_000);
    expect(parsed.drive?.maxCostUsd).toBeNull();
  });

  it("ACCEPTS drive.durable:true with NO config-time tmux check (§7.1.5 LOCKED — tmux is a runtime property; the OTHER fields still default)", () => {
    // The locked decision: config-validation ACCEPTS durable:true even on a
    // tmux-less host; the drive degrades to non-durable + a WARN at RUNTIME.
    // Do NOT hard-require tmux here (that would fail a whole config on a
    // tmux-less host — T-165-15). Assert it parses and the others default.
    const parsed = TerminalDriverConfigSchema.parse({ ...baseCfg, drive: { durable: true } });
    expect(parsed.drive?.durable).toBe(true);
    expect(parsed.drive?.heartbeatMs).toBe(90_000);
    expect(parsed.drive?.maxCostUsd).toBeNull();
  });

  it("REJECTS heartbeatMs <= 0 (int>0 — .positive(); zero, negative, and a float all reject)", () => {
    expect(TerminalDriverConfigSchema.safeParse({ ...baseCfg, drive: { heartbeatMs: 0 } }).success).toBe(false);
    expect(TerminalDriverConfigSchema.safeParse({ ...baseCfg, drive: { heartbeatMs: -1 } }).success).toBe(false);
    expect(TerminalDriverConfigSchema.safeParse({ ...baseCfg, drive: { heartbeatMs: 1.5 } }).success).toBe(false);
  });

  it("maxCostUsd accepts a number OR null but REJECTS a string (number|null)", () => {
    expect(TerminalDriverConfigSchema.parse({ ...baseCfg, drive: { maxCostUsd: 12.5 } }).drive?.maxCostUsd).toBe(12.5);
    expect(TerminalDriverConfigSchema.parse({ ...baseCfg, drive: { maxCostUsd: null } }).drive?.maxCostUsd).toBeNull();
    expect(TerminalDriverConfigSchema.safeParse({ ...baseCfg, drive: { maxCostUsd: "5" } }).success).toBe(false);
  });

  it("REJECTS a typo'd Phase-165 drive key (the block stays a closed strictObject after the additions, T-165-14)", () => {
    const result = TerminalDriverConfigSchema.safeParse({
      ...baseCfg,
      drive: { durable: true, hartbeatMs: 90_000 }, // typo: hartbeatMs
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("drive"))).toBe(true);
    }
  });
});
