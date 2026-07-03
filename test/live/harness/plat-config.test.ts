// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the PLAT shared harness `plat-config.ts`.
 *
 * Proves each fixture/builder has its INTENDED effect against the REAL product primitives
 * (validateConfig, setupSecrets, TerminalDriverConfigSchema) + shapes (CronStore, HeartbeatSourcePort)
 * — so the PLAT scenarios can rely on "this INVALID_CONFIGS entry WILL fail validateConfig",
 * "TEST_MASTER_KEY_HEX IS accepted as crypto material", "makeValidTerminalConfig DOES parse",
 * "makeInMemoryCronStore round-trips", "OK_HEARTBEAT_TEXT contains the real ok token" without
 * re-deriving it.
 *
 * Pure: no daemon, no real key, no network.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { validateConfig, SkillsConfigSchema } from "@comis/core";
import { setupSecrets } from "@comis/memory";
import { HEARTBEAT_OK_TOKEN } from "@comis/shared";
import * as fs from "node:fs";
import {
  INVALID_CONFIGS,
  MALFORMED_YAML,
  ARRAY_TOP_LEVEL,
  ENV_VAR_FIXTURE,
  makeGetSecret,
  LAYER_BASE,
  LAYER_OVERRIDE,
  writeTmpConfigFile,
  makeTmpDataDir,
  TEST_MASTER_KEY_HEX,
  SECRET_CANARY,
  makeCronJob,
  makeInMemoryCronStore,
  makeStubHeartbeatSource,
  makeNoopSchedulerLogger,
  QUIET_HOURS_OFF,
  OK_HEARTBEAT_TEXT,
  ALERT_HEARTBEAT_TEXT,
  TERMINAL_SCREENS,
  SAFE_HINT_PATTERNS,
  AUTH_HINT_OVERLAP,
  makeValidTerminalConfig,
  hasBwrap,
} from "./plat-config.js";

// ---------------------------------------------------------------------------
// PLAT-02 config fixtures
// ---------------------------------------------------------------------------

describe("plat-config — config fail-fast fixtures (PLAT-02)", () => {
  it("every INVALID_CONFIGS entry FAILS validateConfig", () => {
    expect(INVALID_CONFIGS.length).toBeGreaterThanOrEqual(3);
    for (const { name, raw } of INVALID_CONFIGS) {
      const r = validateConfig(raw);
      expect(r.ok, `${name} should fail validateConfig`).toBe(false);
    }
  });

  it("MALFORMED_YAML and ARRAY_TOP_LEVEL are non-empty strings (for loadConfigFile PARSE_ERROR)", () => {
    expect(typeof MALFORMED_YAML).toBe("string");
    expect(MALFORMED_YAML.length).toBeGreaterThan(0);
    expect(typeof ARRAY_TOP_LEVEL).toBe("string");
    expect(ARRAY_TOP_LEVEL.trim().startsWith("[")).toBe(true);
  });

  it("ENV_VAR_FIXTURE references ${TEST_VAR} and makeGetSecret resolves it", () => {
    expect(JSON.stringify(ENV_VAR_FIXTURE)).toContain("${TEST_VAR}");
    const getSecret = makeGetSecret();
    expect(getSecret("TEST_VAR")).toBe("resolved-value");
    expect(getSecret("UNKNOWN_VAR")).toBeUndefined();
  });

  it("LAYER_BASE and LAYER_OVERRIDE overlap (for deepMerge precedence)", () => {
    const baseKeys = Object.keys(LAYER_BASE);
    const overrideKeys = Object.keys(LAYER_OVERRIDE);
    expect(overrideKeys.some((k) => baseKeys.includes(k))).toBe(true);
  });

  it("writeTmpConfigFile writes content and returns a readable path", () => {
    const dir = makeTmpDataDir();
    try {
      const p = writeTmpConfigFile(dir, "x.yaml", "tenantId: abc");
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, "utf-8")).toContain("tenantId: abc");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PLAT-03 secrets fixtures
// ---------------------------------------------------------------------------

describe("plat-config — secrets fixtures (PLAT-03)", () => {
  it("TEST_MASTER_KEY_HEX is accepted by setupSecrets (valid crypto material)", () => {
    const dir = makeTmpDataDir();
    try {
      const r = setupSecrets({ env: { SECRETS_MASTER_KEY: TEST_MASTER_KEY_HEX }, dataDir: dir });
      expect(r.ok).toBe(true);
      // ok(null) would mean "absent" — the key must be present + valid here.
      expect(r.ok && r.value !== null).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SECRET_CANARY is a sk-shaped fake (re-exported from sec-config)", () => {
    expect(SECRET_CANARY.startsWith("sk-")).toBe(true);
  });

  it("makeTmpDataDir returns a unique existing directory", () => {
    const a = makeTmpDataDir();
    const b = makeTmpDataDir();
    try {
      expect(a).not.toBe(b);
      expect(fs.statSync(a).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PLAT-04 scheduler fixtures
// ---------------------------------------------------------------------------

describe("plat-config — scheduler fixtures (PLAT-04)", () => {
  it("makeCronJob returns a valid CronJob with an overridable nextRunAtMs", () => {
    const job = makeCronJob({ nextRunAtMs: 1234 });
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.agentId.length).toBeGreaterThan(0);
    expect(job.enabled).toBe(true);
    expect(job.nextRunAtMs).toBe(1234);
    expect(job.schedule.kind).toBeDefined();
  });

  it("makeInMemoryCronStore round-trips load/save/addJob/removeJob", async () => {
    const job1 = makeCronJob({ nextRunAtMs: 1 });
    const store = makeInMemoryCronStore([job1]);
    expect((await store.load()).map((j) => j.id)).toContain(job1.id);
    const job2 = makeCronJob({ nextRunAtMs: 2 });
    await store.addJob(job2);
    expect((await store.load()).length).toBe(2);
    expect(await store.removeJob(job1.id)).toBe(true);
    expect((await store.load()).map((j) => j.id)).not.toContain(job1.id);
  });

  it("makeStubHeartbeatSource resolves a HeartbeatCheckResult with the given text", async () => {
    const src = makeStubHeartbeatSource("s1", "S1", OK_HEARTBEAT_TEXT);
    expect(src.id).toBe("s1");
    const res = await src.check();
    expect(res.sourceId).toBe("s1");
    expect(res.text).toBe(OK_HEARTBEAT_TEXT);
  });

  it("OK_HEARTBEAT_TEXT contains the real HEARTBEAT_OK_TOKEN; ALERT does not", () => {
    expect(OK_HEARTBEAT_TEXT).toContain(HEARTBEAT_OK_TOKEN);
    expect(ALERT_HEARTBEAT_TEXT).not.toContain(HEARTBEAT_OK_TOKEN);
  });

  it("makeNoopSchedulerLogger is callable and chains via child()", () => {
    const log = makeNoopSchedulerLogger();
    expect(() => log.info("x")).not.toThrow();
    expect(() => log.error({ a: 1 }, "y")).not.toThrow();
    expect(() => log.child({ k: "v" }).debug("z")).not.toThrow();
  });

  it("QUIET_HOURS_OFF is the real QuietHoursConfig shape (no criticalBypass field)", () => {
    expect(QUIET_HOURS_OFF.enabled).toBe(false);
    expect(typeof QUIET_HOURS_OFF.start).toBe("string");
    expect(typeof QUIET_HOURS_OFF.end).toBe("string");
    expect(typeof QUIET_HOURS_OFF.timezone).toBe("string");
    expect("criticalBypass" in QUIET_HOURS_OFF).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PLAT-01 terminal fixtures
// ---------------------------------------------------------------------------

describe("plat-config — terminal fixtures (PLAT-01)", () => {
  it("makeValidTerminalConfig parses cleanly via SkillsConfigSchema.terminal", () => {
    // TerminalDriverConfigSchema is not on the public barrel; SkillsConfigSchema embeds it as
    // `terminal: TerminalDriverConfigSchema.optional()`. Validate the embedded shape.
    const parsed = SkillsConfigSchema.safeParse({ terminal: makeValidTerminalConfig() });
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.success && parsed.data.terminal?.allow[0]?.autoAnswer).toBe("safe-only");
  });

  it("AUTH_HINT_OVERLAP contains BOTH a safe hint AND an auth marker", () => {
    const lower = AUTH_HINT_OVERLAP.toLowerCase();
    expect(SAFE_HINT_PATTERNS.some((p) => lower.includes(p.toLowerCase()))).toBe(true);
    // An auth marker (one of decideAutoAnswer's AUTH_LOGIN_MARKERS).
    expect(/log in|login|sign in|password|api key|credential|authenticate/.test(lower)).toBe(true);
  });

  it("TERMINAL_SCREENS has safe/auth/destructive/approval variants", () => {
    expect(TERMINAL_SCREENS.safe.length).toBeGreaterThan(0);
    expect(TERMINAL_SCREENS.auth.length).toBeGreaterThan(0);
    expect(TERMINAL_SCREENS.destructive.length).toBeGreaterThan(0);
    expect(TERMINAL_SCREENS.approval.length).toBeGreaterThan(0);
  });

  it("hasBwrap returns a boolean (false on macOS, true on Linux+bwrap)", () => {
    expect(typeof hasBwrap()).toBe("boolean");
  });
});
